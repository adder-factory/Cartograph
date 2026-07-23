import type Cartograph from '../../index.js';
import { areBiomarkersPending } from '../../biomarkers/pending.js';
import { getCoverageStats, listCoverageSources } from '../../db/queries-coverage.js';
import { getEmbeddedNodeIds, getEmbeddingsCount } from '../../db/queries-embeddings.js';
import { getSymbolDescriptions, type SymbolDescription } from '../../db/queries-summaries.js';
import { errMsg } from '../../errors.js';
import { contentDriftCount, hasFreshnessRisk } from '../../freshness.js';
import { collectDependencyCoverage, MAX_DEPENDENCY_COVERAGE_LIMIT } from '../dependency-coverage/index.js';
import { runLlmSmoke, type LlmSmokeResult } from '../llm-smoke/index.js';
import { findGraphCandidates } from '../../llm/dead-code.js';
import { getAskModel, getChatModel, getEmbeddingModel } from '../../llm/provider.js';
import { llmFindImplementations } from '../../cartograph-llm-service.js';
import type { Node } from '../../types.js';
import {
  SemanticGoldenProbeSchema,
  TrustReportSchema,
  type SemanticGoldenProbe,
  type TrustCheck,
  type TrustCheckState,
  type TrustReport,
} from './contract.js';

export interface BuildTrustReportOptions {
  deep?: boolean;
  timeoutMs?: number;
  isFixturePath: (filePath: string) => boolean;
}

export interface TrustRuntimeDeps {
  runSmoke: (options: { projectPath: string; timeoutMs?: number }) => Promise<LlmSmokeResult>;
  runSemanticProbe: (cg: Cartograph, embeddingModel: string, timeoutMs: number) => Promise<SemanticGoldenProbe>;
}

const DEAD_CODE_SAMPLE_LIMIT = 5;
const DEFAULT_DEEP_TIMEOUT_MS = 60_000;
const SEMANTIC_SAMPLE_LIMIT = 50;
const SEMANTIC_RESULT_LIMIT = 5;
const MIN_GOLDEN_DESCRIPTION_CHARS = 20;
const MIN_HEALTHY_RESOLUTION_RATIO = 0.7;
const MIN_HEALTHY_EMBEDDING_RATIO = 0.8;
const NON_EMBEDDABLE_KINDS = ['file', 'import', 'export'] as const;
const NON_REFERENCE_EDGE_KINDS = new Set(['contains', 'tests', 'similar_to']);

const DEFAULT_DEPS: TrustRuntimeDeps = {
  runSmoke: runLlmSmoke,
  runSemanticProbe: runSemanticGoldenProbe,
};

export async function buildTrustReport(
  cg: Cartograph,
  options: BuildTrustReportOptions,
  deps: TrustRuntimeDeps = DEFAULT_DEPS,
): Promise<TrustReport> {
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const embeddingModel = getEmbeddingModel(llmConfig);
  const checks: TrustCheck[] = [
    freshnessCheck(cg),
    coverageCheck(cg),
    biomarkerCheck(cg),
    deadCodeCheck(cg, options.isFixturePath),
    dependencyGraphCheck(cg),
    embeddingCoverageCheck(cg, embeddingModel),
    ...llmConfigurationChecks({
      askModel: getAskModel(llmConfig),
      chatModel: getChatModel(llmConfig),
      embeddingModel,
    }),
  ];

  const deep = options.deep === true;
  if (deep) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DEEP_TIMEOUT_MS;
    const smoke = await safeRunSmoke(cg.projectRoot, timeoutMs, deps);
    checks.push(smokeCheck(smoke));
    checks.push(await semanticGoldenCheck(cg, embeddingModel, smoke, timeoutMs, deps));
  }

  return TrustReportSchema.parse({ deep, overall: overallState(checks), checks });
}

async function safeRunSmoke(
  projectPath: string,
  timeoutMs: number,
  deps: TrustRuntimeDeps,
): Promise<LlmSmokeResult | Error> {
  try {
    return await deps.runSmoke({ projectPath, timeoutMs });
  } catch (error) {
    return error instanceof Error ? error : new Error(errMsg(error));
  }
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
    .map((source) => source.source)
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

function deadCodeCheck(cg: Cartograph, isFixturePath: (filePath: string) => boolean): TrustCheck {
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

function dependencyGraphCheck(cg: Cartograph): TrustCheck {
  const report = collectDependencyCoverage(cg.queries, MAX_DEPENDENCY_COVERAGE_LIMIT);
  const relevantRows = report.rows.filter((row) => !NON_REFERENCE_EDGE_KINDS.has(row.edgeKind));
  const resolved = relevantRows.reduce((total, row) => total + row.resolved, 0);
  const unresolved = relevantRows.reduce((total, row) => total + row.unresolved, 0);
  const references = resolved + unresolved;
  if (references === 0) {
    return {
      state: 'warn',
      label: 'Dependency graph',
      detail:
        'No resolved or unresolved dependency references were recorded; impact and affected-test answers have no call/import evidence.',
      action: 'Run a full index and inspect `cartograph_status({detail: "dependencies"})`.',
    };
  }
  const ratio = resolved / references;
  return {
    state: ratio >= MIN_HEALTHY_RESOLUTION_RATIO ? 'ok' : 'warn',
    label: 'Dependency graph',
    detail: `${resolved}/${references} dependency references resolved (${formatPercent(ratio)}); ${unresolved} remain unresolved.`,
    action:
      ratio >= MIN_HEALTHY_RESOLUTION_RATIO
        ? 'None.'
        : 'Inspect `cartograph_status({detail: "dependencies"})` and address the largest unresolved-reference groups.',
  };
}

function embeddingCoverageCheck(cg: Cartograph, embeddingModel: string | undefined): TrustCheck {
  if (!embeddingModel) {
    return {
      state: 'warn',
      label: 'Active-model embeddings',
      detail: 'No active embedding model is configured; semantic retrieval is unavailable.',
      action: 'Configure `embeddingLlm`, then run `cartograph_admin({action: "embed"})`.',
    };
  }
  const stats = cg.stats.getStats();
  const nonEmbeddable = NON_EMBEDDABLE_KINDS.reduce((total, kind) => total + (stats.nodesByKind[kind] ?? 0), 0);
  const eligible = Math.max(0, stats.nodeCount - nonEmbeddable);
  const rows = getEmbeddingsCount(cg.queries, embeddingModel);
  const ratio = eligible === 0 ? 0 : Math.min(1, rows / eligible);
  if (rows === 0) {
    return {
      state: 'warn',
      label: 'Active-model embeddings',
      detail: `Model ${embeddingModel} is active but has no stored symbol embeddings (${eligible} eligible symbols).`,
      action: 'Run `cartograph_admin({action: "embed"})` before using semantic search.',
    };
  }
  return {
    state: ratio >= MIN_HEALTHY_EMBEDDING_RATIO ? 'ok' : 'warn',
    label: 'Active-model embeddings',
    detail: `${rows}/${eligible} eligible symbols have rows for active model ${embeddingModel} (${formatPercent(ratio)}).`,
    action:
      ratio >= MIN_HEALTHY_EMBEDDING_RATIO
        ? 'None.'
        : 'Run `cartograph_admin({action: "embed"})` to fill active-model gaps.',
  };
}

function llmConfigurationChecks(models: {
  askModel: string | undefined;
  chatModel: string | undefined;
  embeddingModel: string | undefined;
}): TrustCheck[] {
  return [
    configuredModelCheck({
      label: 'Ask/dead-code LLM',
      model: models.askModel,
      missing: 'No ask model configured; dead-code LLM judge and ask are unavailable.',
      configureAction: 'Configure `askLlm` or use `cartograph_dead_code({via: "rule"})`.',
    }),
    configuredModelCheck({
      label: 'Summary LLM',
      model: models.chatModel,
      missing: 'No summary model configured; LLM summaries will not improve search/ask context.',
      configureAction: 'Run `cartograph_admin({action: "llm-plan"})` for setup options.',
    }),
    configuredModelCheck({
      label: 'Embedding LLM',
      model: models.embeddingModel,
      missing: 'No embedding model configured; semantic search is unavailable.',
      configureAction: 'Configure `embeddingLlm` and run `cartograph_admin({action: "embed"})`.',
    }),
  ];
}

function configuredModelCheck(args: {
  label: string;
  model: string | undefined;
  missing: string;
  configureAction: string;
}): TrustCheck {
  return {
    state: args.model ? 'ok' : 'warn',
    label: args.label,
    detail: args.model
      ? `Model configured: ${args.model}. This is configuration only; no live request was executed.`
      : `${args.missing} This is configuration only; no live request was executed.`,
    action: args.model
      ? 'Use `cartograph_review({mode: "trust", deep: true})` to verify execution.'
      : args.configureAction,
  };
}

function smokeCheck(smoke: LlmSmokeResult | Error): TrustCheck {
  if (smoke instanceof Error) {
    return {
      state: 'warn',
      label: 'Live LLM requests',
      detail: `Deep smoke could not complete: ${smoke.message}`,
      action: 'Run `cartograph llm smoke` for per-tier diagnostics.',
    };
  }
  const passed = smoke.rows.filter((row) => row.status === 'ok').map((row) => row.tier);
  const failed = smoke.rows.filter((row) => row.status === 'fail').map((row) => row.tier);
  const skipped = smoke.rows.filter((row) => row.status === 'skip').map((row) => row.tier);
  const detail = [
    `${passed.length} tier(s) passed${passed.length > 0 ? ` (${passed.join(', ')})` : ''}`,
    `${failed.length} failed${failed.length > 0 ? ` (${failed.join(', ')})` : ''}`,
    `${skipped.length} unavailable/skipped${skipped.length > 0 ? ` (${skipped.join(', ')})` : ''}`,
  ].join('; ');
  return {
    state: smoke.overallStatus === 'ok' ? 'ok' : 'warn',
    label: 'Live LLM requests',
    detail: `${detail}. Requests executed in ${smoke.durationMs}ms.`,
    action: failed.length === 0 ? 'None.' : 'Run `cartograph llm smoke` and repair the failed tier(s).',
  };
}

async function semanticGoldenCheck(
  cg: Cartograph,
  embeddingModel: string | undefined,
  smoke: LlmSmokeResult | Error,
  timeoutMs: number,
  deps: TrustRuntimeDeps,
): Promise<TrustCheck> {
  if (!embeddingModel) return semanticProbeCheck({ status: 'skip', reason: 'embedding model is not configured' });
  if (smoke instanceof Error) {
    return semanticProbeCheck({ status: 'skip', reason: 'live LLM smoke did not complete' });
  }
  const embeddingSmoke = smoke.rows.find((row) => row.tier === 'embedding');
  if (embeddingSmoke?.status !== 'ok') {
    return semanticProbeCheck({ status: 'skip', reason: 'embedding request did not pass the live smoke test' });
  }
  try {
    return semanticProbeCheck(await deps.runSemanticProbe(cg, embeddingModel, timeoutMs));
  } catch (error) {
    return semanticProbeCheck({ status: 'fail', reason: errMsg(error) });
  }
}

function semanticProbeCheck(probe: SemanticGoldenProbe): TrustCheck {
  if (probe.status === 'ok') {
    return {
      state: 'ok',
      label: 'Semantic golden probe',
      detail: `A stored symbol retrieved itself at rank ${probe.rank}/${probe.candidatesReturned}: ${probe.sourceName} (${probe.sourcePath}).`,
      action: 'None.',
    };
  }
  if (probe.status === 'skip') {
    return {
      state: 'warn',
      label: 'Semantic golden probe',
      detail: `Semantic usefulness is unavailable: ${probe.reason}.`,
      action: 'Configure a live embedding tier and populate active-model embeddings.',
    };
  }
  return {
    state: 'warn',
    label: 'Semantic golden probe',
    detail: `Semantic self-retrieval failed: ${probe.reason}.`,
    action: 'Re-embed with the active model, then inspect semantic search quality before relying on it.',
  };
}

export async function runSemanticGoldenProbe(
  cg: Cartograph,
  embeddingModel: string,
  timeoutMs: number,
): Promise<SemanticGoldenProbe> {
  const nodeIds = getEmbeddedNodeIds(cg.queries, embeddingModel, SEMANTIC_SAMPLE_LIMIT);
  if (nodeIds.length === 0) {
    return SemanticGoldenProbeSchema.parse({ status: 'skip', reason: 'active model has no stored symbol rows' });
  }
  const descriptions = getSymbolDescriptions(cg.queries, nodeIds);
  let source: { node: Node; description: SymbolDescription } | undefined;
  for (const nodeId of nodeIds) {
    const node = cg.queries.getNodeById(nodeId);
    const description = descriptions.get(nodeId);
    if (node && description && description.text.trim().length >= MIN_GOLDEN_DESCRIPTION_CHARS) {
      source = { node, description };
      break;
    }
  }
  if (!source) {
    return SemanticGoldenProbeSchema.parse({
      status: 'skip',
      reason: `none of ${nodeIds.length} sampled embedded symbols has a meaningful description`,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await llmFindImplementations(cg.llm, source.description.text, {
      limit: SEMANTIC_RESULT_LIMIT,
      signal: controller.signal,
      skipReachabilityProbe: true,
    });
    const rank = results.findIndex((result) => result.node.id === source.node.id) + 1;
    if (rank === 0) {
      return SemanticGoldenProbeSchema.parse({
        status: 'fail',
        sourceNodeId: source.node.id,
        sourceName: source.node.name,
        sourcePath: source.node.filePath,
        candidatesReturned: results.length,
        reason: `source symbol was absent from the top ${SEMANTIC_RESULT_LIMIT}`,
      });
    }
    return SemanticGoldenProbeSchema.parse({
      status: 'ok',
      sourceNodeId: source.node.id,
      sourceName: source.node.name,
      sourcePath: source.node.filePath,
      rank,
      candidatesReturned: results.length,
    });
  } finally {
    clearTimeout(timer);
  }
}

function overallState(checks: readonly TrustCheck[]): TrustCheckState {
  if (checks.some((check) => check.state === 'blocked')) return 'blocked';
  if (checks.some((check) => check.state === 'warn')) return 'warn';
  return 'ok';
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
