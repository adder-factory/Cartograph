import type { ToolResult } from '../tool-types.js';
import type Cartograph from '../../index.js';
import { contentDriftCount, hasFreshnessRisk } from '../../freshness.js';
import { getCoverageStats, listCoverageSources } from '../../db/queries-coverage.js';
import { findGraphCandidates } from '../../llm/dead-code.js';
import { getAskModel, getChatModel, getEmbeddingModel } from '../../llm/provider.js';
import { isFixturePath, textResult, truncateOutput } from './shared.js';
import type { ToolCtx } from './types.js';
import { areBiomarkersPending } from '../../biomarkers/pending.js';

type CheckState = 'ok' | 'warn' | 'blocked';

interface TrustCheck {
  state: CheckState;
  label: string;
  detail: string;
  action: string;
}

const DEAD_CODE_SAMPLE_LIMIT = 5;

export async function handleTrustReview(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const checks = await buildTrustChecks(cg);
  const overall = overallState(checks);
  const lines = [
    `# Trust self-check — ${overall.toUpperCase()}`,
    '',
    'Use this before acting on broad analysis. `blocked` means refresh first; `warn` means results are usable with caveats.',
    '',
    ...checks.map(formatCheck),
  ];
  return textResult(truncateOutput(lines.join('\n')));
}

async function buildTrustChecks(cg: Cartograph): Promise<TrustCheck[]> {
  const checks: TrustCheck[] = [
    freshnessCheck(cg),
    coverageCheck(cg),
    biomarkerCheck(cg),
    deadCodeCheck(cg),
    ...(await llmChecks(cg)),
  ];
  return checks;
}

function overallState(checks: ReadonlyArray<TrustCheck>): CheckState {
  if (checks.some((c) => c.state === 'blocked')) return 'blocked';
  if (checks.some((c) => c.state === 'warn')) return 'warn';
  return 'ok';
}

function formatCheck(check: TrustCheck): string {
  let icon: string;
  if (check.state === 'ok') {
    icon = 'OK';
  } else if (check.state === 'warn') {
    icon = 'WARN';
  } else {
    icon = 'BLOCKED';
  }
  return `- **${icon} ${check.label}:** ${check.detail} Action: ${check.action}`;
}

function freshnessCheck(cg: Cartograph): TrustCheck {
  const freshness = cg.stats.getFreshness();
  if (!freshness) {
    return {
      state: 'warn',
      label: 'Freshness',
      detail: 'No freshness metadata is available for this index.',
      action: 'Run `cartograph_admin({action: "sync"})` or `cartograph_admin({action: "index"})`.',
    };
  }
  const drifted = contentDriftCount(freshness);
  if (freshness.severity === 'very_stale') {
    return {
      state: 'blocked',
      label: 'Freshness',
      detail: `Index is very stale (${freshness.commitsAhead ?? 0} commits ahead, ${freshness.filesChanged ?? 0} files changed, ${drifted} content-drifted files).`,
      action: 'Run `cartograph_admin({action: "sync"})` before high-risk tools.',
    };
  }
  if (hasFreshnessRisk(freshness)) {
    return {
      state: 'warn',
      label: 'Freshness',
      detail: `Index severity is ${freshness.severity}; stale=${freshness.isStale}, content-drifted files=${drifted}.`,
      action: 'Run `cartograph_admin({action: "sync"})` for exact graph answers.',
    };
  }
  return {
    state: 'ok',
    label: 'Freshness',
    detail: `Index severity is ${freshness.severity}; graph is current enough for read tools.`,
    action: 'None.',
  };
}

function coverageCheck(cg: Cartograph): TrustCheck {
  const stats = getCoverageStats(cg.queries);
  if (stats.symbolsWithCoverage === 0) {
    return {
      state: 'warn',
      label: 'Coverage',
      detail: 'No LCOV coverage has been ingested, so coverage gaps and low_coverage findings are unavailable.',
      action: 'Run tests with LCOV output, then call `cartograph_coverage({mode: "refresh"})`.',
    };
  }
  const sources = listCoverageSources(cg.queries)
    .map((s) => s.source)
    .join(', ');
  return {
    state: 'ok',
    label: 'Coverage',
    detail: `${stats.symbolsWithCoverage} symbols covered from source(s): ${sources || stats.sources.join(', ') || '(none)'}.`,
    action: 'None.',
  };
}

function biomarkerCheck(cg: Cartograph): TrustCheck {
  if (areBiomarkersPending(cg)) {
    return {
      state: 'warn',
      label: 'Cross-file biomarkers',
      detail: 'Cross-file findings are stale for this index generation.',
      action:
        'Run `cartograph_admin({action: "index"})`, or a no-change `sync`, before trusting unused_export/god_class/duplicate_code/low_coverage.',
    };
  }
  return {
    state: 'ok',
    label: 'Cross-file biomarkers',
    detail: 'Cross-file biomarker pass is current for this index.',
    action: 'None.',
  };
}

function deadCodeCheck(cg: Cartograph): TrustCheck {
  const candidates = findGraphCandidates({ queries: cg.queries, max: DEAD_CODE_SAMPLE_LIMIT, isExempt: isFixturePath });
  if (candidates.length === 0) {
    return {
      state: 'ok',
      label: 'Dead-code signal',
      detail: 'No static graph-orphan candidates in the first pass.',
      action: 'None.',
    };
  }
  return {
    state: 'warn',
    label: 'Dead-code signal',
    detail: `${candidates.length} static candidate(s) found in a ${DEAD_CODE_SAMPLE_LIMIT}-row sample; static mode is a candidate list, not a delete list.`,
    action:
      'Use `cartograph_dead_code({via: "llm"})` when an ask model is configured, then verify callers/tests before deleting.',
  };
}

async function llmChecks(cg: Cartograph): Promise<TrustCheck[]> {
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const chatModel = getChatModel(llmConfig);
  const askModel = getAskModel(llmConfig);
  const embeddingModel = getEmbeddingModel(llmConfig);
  return [
    {
      state: askModel ? 'ok' : 'warn',
      label: 'Ask/dead-code LLM',
      detail: askModel
        ? `Ask model configured: ${askModel}.`
        : 'No ask model configured; dead-code LLM judge and ask are unavailable.',
      action: askModel ? 'None.' : 'Configure `askLlm` or use `cartograph_dead_code({via: "rule"})`.',
    },
    {
      state: chatModel ? 'ok' : 'warn',
      label: 'Summary LLM',
      detail: chatModel
        ? `Summary model configured: ${chatModel}.`
        : 'No summary model configured; LLM summaries will not improve search/ask context.',
      action: chatModel ? 'None.' : 'Run `cartograph_admin({action: "llm-plan"})` for setup options.',
    },
    {
      state: embeddingModel ? 'ok' : 'warn',
      label: 'Embedding LLM',
      detail: embeddingModel
        ? `Embedding model configured: ${embeddingModel}.`
        : 'No embedding model configured; semantic search is unavailable.',
      action: embeddingModel ? 'None.' : 'Configure `embeddingLlm` and run `cartograph_admin({action: "embed"})`.',
    },
  ];
}
