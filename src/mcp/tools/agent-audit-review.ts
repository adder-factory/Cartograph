/**
 * `cartograph_review mode='agent-audit'` — filters findings to JUST
 * the agent-prone biomarker subset (the 4 anti-pattern detectors
 * B17/B19/B20/B21 + the 12 G26 Phases 1+2 detectors). Per-detector
 * grouped, severity-ordered. Tells the agent "of all the
 * biomarkers, here are the ones MOST LIKELY produced by an LLM
 * shipping incomplete or unhardened code."
 *
 * Distinct from `mode='risk'` (top-N per category across the
 * structural + complexity + coverage tiers). Risk surfaces "where
 * SHOULD you look first overall"; agent-audit surfaces "what did
 * the LLM ship that needs human review."
 *
 * Output shape: one section per detector that has findings, each
 * section lists every finding (severity emoji + file:line +
 * symbol + metric). Empty-state message lists the detectors that
 * fired clean to confirm the audit actually ran (not a "no data"
 * trap).
 */
import type { ToolResult } from '../tool-types.js';
import type Cartograph from '../../index.js';
import { isFixturePath } from './shared.js';
import { getFindingsRanked } from '../../db/queries-findings.js';
import { textResult, truncateOutput } from './shared.js';
import type { ToolCtx } from './types.js';
import type { BiomarkerName } from '../../biomarkers/types.js';

/**
 * The agent-prone subset. Order matches CLAUDE.md's "Biomarker
 * conventions" listing: B17-B21 first (the 2026-05-23 anti-pattern
 * tier), then G26 Phase 1 + Phase 2.
 *
 * @remarks Single source of truth — consumed by BOTH
 * {@link handleAgentAuditReview} (the per-detector audit lens) AND
 * `appendCompareFindingsTotals` in `compare.ts` (the `agentRisk`
 * rollup that flags introduced findings). When adding a new
 * agent-prone biomarker (G27+, or extending a B-tier definition),
 * UPDATE THIS LIST or the new detector silently drops out of both
 * agent-facing surfaces.
 */
export const AGENT_PRONE_BIOMARKERS: readonly BiomarkerName[] = [
  // B17/B19/B20/B21 (2026-05-23)
  'accidental_quadratic',
  'empty_catch',
  'sync_io_in_async',
  'forof_await',
  // G26 Phase 1 (2026-05-24c)
  'ts_any_cast',
  'ts_ignore_suppression',
  'agent_debug_log',
  'incomplete_marker',
  'dynamic_eval',
  'insecure_hash',
  'random_for_security',
  // G26 Phase 2 (2026-05-25)
  'http_no_timeout',
  'sql_string_concat',
  'unsafe_json_parse',
  'env_no_validation',
  'empty_function_body',
];

/** Severity rank for sort-desc within a detector — error first. */
const SEVERITY_RANK: Record<string, number> = { error: 2, warning: 1, info: 0 };

/** Default per-detector cap on rendered findings + the clamp bounds
 *  for the user-supplied override. */
const DEFAULT_PER_DETECTOR_LIMIT = 10;
const PER_DETECTOR_LIMIT_MIN = 1;
const PER_DETECTOR_LIMIT_MAX = 50;

function severityEmoji(sev: string): string {
  if (sev === 'error') return '🔴';
  if (sev === 'warning') return '🟡';
  return '⚪';
}

interface AgentAuditArgs {
  /** Max findings to surface per detector. Default 10. */
  perDetectorLimit?: number;
  /** Minimum severity to include. Default `info`. */
  minSeverity?: 'info' | 'warning' | 'error';
}

export async function handleAgentAuditReview(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const typed = args as AgentAuditArgs;
  const perDetectorLimit = clampInt(
    typed.perDetectorLimit ?? DEFAULT_PER_DETECTOR_LIMIT,
    PER_DETECTOR_LIMIT_MIN,
    PER_DETECTOR_LIMIT_MAX,
  );
  const minSeverity = typed.minSeverity ?? 'info';

  const lines: string[] = [
    '# Agent-audit review',
    '',
    `Surfaces the ${AGENT_PRONE_BIOMARKERS.length} biomarkers AI agents disproportionately produce (`,
    'arXiv code-agent studies + CodeRabbit/Greptile/SonarQube field data).',
    `Per-detector grouped, severity-ordered. min-severity: \`${minSeverity}\`, per-detector limit: ${perDetectorLimit}.`,
    '',
  ];

  const detectorsWithFindings: string[] = [];
  const detectorsClean: string[] = [];

  for (const biomarker of AGENT_PRONE_BIOMARKERS) {
    const findings = collectFindingsForBiomarker({ cg, biomarker, minSeverity, limit: perDetectorLimit });
    if (findings.length === 0) {
      detectorsClean.push(biomarker);
      continue;
    }
    detectorsWithFindings.push(biomarker);
    lines.push(`## \`${biomarker}\` (${findings.length})`);
    for (const f of findings) {
      lines.push(`- ${severityEmoji(f.severity)} \`${f.name}\` (${f.kind}) — ${f.filePath} (metric: ${f.metric})`);
    }
    lines.push('');
  }

  if (detectorsWithFindings.length === 0) {
    lines.push(`✓ No agent-prone findings at min-severity \`${minSeverity}\`.`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `_Audited ${AGENT_PRONE_BIOMARKERS.length} detectors. ${detectorsWithFindings.length} fired, ${detectorsClean.length} clean._`,
  );
  if (detectorsClean.length > 0 && detectorsClean.length <= 8) {
    lines.push(`_Clean: ${detectorsClean.map((d) => `\`${d}\``).join(', ')}._`);
  }

  return textResult(truncateOutput(lines.join('\n')));
}

interface AgentAuditRow {
  name: string;
  kind: string;
  filePath: string;
  severity: 'info' | 'warning' | 'error';
  metric: number;
}

interface CollectFindingsArgs {
  cg: Cartograph;
  biomarker: string;
  minSeverity: 'info' | 'warning' | 'error';
  limit: number;
}

/** Fetch findings for one detector via the shared ranked-findings
 *  helper, then trim to the per-detector cap. We over-fetch (×3) so
 *  the cap stays meaningful when fixtures get filtered out. */
function collectFindingsForBiomarker(args: CollectFindingsArgs): AgentAuditRow[] {
  const { cg, biomarker, minSeverity, limit } = args;
  const overFetch = limit * 3;
  const rows = getFindingsRanked(cg.queries, {
    biomarker: biomarker as BiomarkerName,
    minSeverity,
    limit: overFetch,
  });
  const filtered: AgentAuditRow[] = [];
  for (const r of rows) {
    if (isFixturePath(r.filePath)) continue;
    filtered.push({
      name: r.name,
      kind: r.kind,
      filePath: r.filePath,
      severity: r.severity,
      metric: r.metric,
    });
    if (filtered.length >= limit) break;
  }
  filtered.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || b.metric - a.metric);
  return filtered;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isInteger(n)) n = Math.floor(n);
  return Math.max(lo, Math.min(hi, n));
}
