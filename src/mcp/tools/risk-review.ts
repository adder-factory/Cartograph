import type { ToolResult } from '../tool-types.js';
import type Cartograph from '../../index.js';
import { findGraphCandidates } from '../../llm/dead-code.js';
import { isFixturePath, textResult, truncateOutput } from './shared.js';
import { getCoverageRanked } from '../../db/queries-coverage.js';
import { getTopBetweennessNodes } from '../../db/queries-centrality.js';
import { getFindingsRanked } from '../../db/queries-findings.js';
import { getHotspots } from '../../db/queries-history.js';
import { clampInt, numArg } from '../../utils.js';
import type { ToolCtx } from './types.js';

/** Default per-lens row cap when caller doesn't pass `topN`. */
const DEFAULT_TOP_N = 5;
/** Hard cap on `topN` so a request can't ask for the whole index per lens. */
const MAX_TOP_N = 30;
/** Default `minCentrality` floor when caller doesn't pass one — no filter. */
const DEFAULT_MIN_CENTRALITY = 0;
/** Coverage lens: filter to symbols at or below this fraction (50%). */
const COVERAGE_GAP_MAX_PCT = 0.5;
/** Centrality / risk numbers rendered to this many decimal places. */
const SCORE_DECIMALS = 4;
/** Coverage percentages rendered to this many decimal places. */
const COVERAGE_PCT_DECIMALS = 1;
/** Multiplier (100) to convert a 0–1 coverage fraction into a percentage. */
const PCT_MULTIPLIER = 100;

export async function handleRiskReview(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  // `limit` is the user-natural alias many callers reach for; `topN` is
  // the canonical name. Either honored.
  const topN = clampInt(numArg(args['topN'] ?? args['limit'], DEFAULT_TOP_N), 1, MAX_TOP_N);
  const minCentrality = numArg(args['minCentrality'], DEFAULT_MIN_CENTRALITY);
  const coverageSource = args['coverageSource'] as string | undefined;

  const lines: string[] = [`# Risk review (top ${topN} per lens)`];
  if (minCentrality > DEFAULT_MIN_CENTRALITY) lines.push(`_minCentrality filter: ≥ ${minCentrality}_`);
  lines.push('');

  appendBiomarkerLens({ out: lines, cg, topN, minCentrality });
  appendHotspotLens({ out: lines, cg, topN, minCentrality });
  appendCoverageGapLens({ out: lines, cg, topN, minCentrality, coverageSource });
  appendStructuralBridgeLens(lines, cg, topN);
  appendDeadCodeLens(lines, cg, topN);

  lines.push(
    `---`,
    `> Suggested next moves: drill into the top biomarker symbol with \`cartograph_node\` + \`cartograph_graph({direction: 'callers'})\`; for hotspot files run \`cartograph_biomarkers mode=symbol symbol=<file's central class>\`; for coverage gaps weigh against \`cartograph_graph({direction: 'callers'})\` to see who would benefit from a test.`,
  );

  return textResult(truncateOutput(lines.join('\n')));
}

function severityEmoji(sev: string): string {
  if (sev === 'error') return '🔴';
  if (sev === 'warning') return '🟡';
  return '⚪';
}

interface AppendBiomarkerLensArgs {
  out: string[];
  cg: Cartograph;
  topN: number;
  minCentrality: number;
}

function appendBiomarkerLens(args: AppendBiomarkerLensArgs): void {
  const { out, cg, topN, minCentrality } = args;
  out.push(
    `## Biomarker findings (warning+ severity)`,
    `_Why ranked here: severity first, then detector metric, then centrality where available._`,
  );
  const findingsOpts: {
    minSeverity?: 'info' | 'warning' | 'error';
    minCentrality?: number;
    limit?: number;
  } = { minSeverity: 'warning', limit: topN };
  if (minCentrality > DEFAULT_MIN_CENTRALITY) findingsOpts.minCentrality = minCentrality;
  const findings = getFindingsRanked(cg.queries, findingsOpts);
  if (findings.length === 0) {
    out.push(`_No biomarker findings above the threshold._`);
  } else {
    for (const f of findings) {
      const cent = f.centrality === null ? '' : `, centrality ${f.centrality.toFixed(SCORE_DECIMALS)}`;
      out.push(`- ${severityEmoji(f.severity)} \`${f.name}\` (${f.kind}) — ${f.biomarker} in ${f.filePath}${cent}`);
    }
  }
  out.push('');
}

interface AppendHotspotLensArgs {
  out: string[];
  cg: Cartograph;
  topN: number;
  minCentrality: number;
}

function appendHotspotLens(args: AppendHotspotLensArgs): void {
  const { out, cg, topN, minCentrality } = args;
  out.push(
    `## Hotspots (centrality × churn)`,
    `_Why ranked here: risk score = file centrality × git churn; higher scores mean a more likely bug/refactor hotspot._`,
  );
  const hotspots = getHotspots(cg.queries, { limit: topN, minCentrality, sortBy: 'risk' });
  if (hotspots.length === 0) {
    out.push(
      `_No hotspot data — needs git history + centrality (run \`cartograph_admin({action: 'index'})\` if you haven't)._`,
    );
  } else {
    for (const h of hotspots) {
      out.push(
        `- \`${h.filePath}\` — risk ${h.riskScore.toFixed(SCORE_DECIMALS)} (PR ${h.fileCentrality.toFixed(SCORE_DECIMALS)}, ${h.commitCount} commits, ${h.loc} LOC)`,
      );
    }
  }
  out.push('');
}

interface AppendCoverageGapLensArgs {
  out: string[];
  cg: Cartograph;
  topN: number;
  minCentrality: number;
  coverageSource: string | undefined;
}

function appendCoverageGapLens(args: AppendCoverageGapLensArgs): void {
  const { out, cg, topN, minCentrality, coverageSource } = args;
  out.push(
    `## Coverage gaps (lowest-coverage first)`,
    `_Why ranked here: symbols at or below 50% coverage, ordered lowest coverage first and optionally filtered by centrality._`,
  );
  const coverageOpts: {
    limit?: number;
    maxPct?: number;
    minCentrality?: number;
    source?: string;
  } = { limit: topN, maxPct: COVERAGE_GAP_MAX_PCT };
  if (minCentrality > DEFAULT_MIN_CENTRALITY) coverageOpts.minCentrality = minCentrality;
  if (coverageSource) coverageOpts.source = coverageSource;
  const lowCov = getCoverageRanked(cg.queries, coverageOpts);
  if (lowCov.length === 0) {
    out.push(`_No coverage data — run \`cartograph coverage --mode load --report-path <lcov>\` first._`);
  } else {
    for (const c of lowCov) {
      const pct = (c.pct * PCT_MULTIPLIER).toFixed(COVERAGE_PCT_DECIMALS);
      const cent = c.centrality === null ? '' : `, centrality ${c.centrality.toFixed(SCORE_DECIMALS)}`;
      out.push(
        `- \`${c.name}\` (${c.kind}) — ${pct}% (${c.coveredLines}/${c.totalLines} lines) in ${c.filePath}${cent}`,
      );
    }
  }
  out.push('');
}

/**
 * G23 structural-bridge lens — surfaces top-N nodes by sampled
 * Brandes betweenness. Each row is a candidate "the only path
 * between two subsystems" — refactor it carefully. Gracefully
 * degrades when the betweenness column is empty (hook not enabled,
 * or hasn't run yet); the empty-lens message points at the right
 * opt-in.
 */
function appendStructuralBridgeLens(out: string[], cg: Cartograph, topN: number): void {
  out.push(
    `## Structural bridges (sampled Brandes betweenness)`,
    `_Why ranked here: sampled betweenness estimates symbols that sit on many shortest paths between subsystems._`,
  );
  const bridges = getTopBetweennessNodes(cg.queries, topN);
  if (bridges.length === 0) {
    out.push(
      `_No betweenness data — enable via \`enableBetweenness: true\` in \`.cartograph/config.json\`, then run \`cartograph_admin({action: 'index'})\`. Surfaces nodes on the only structural path between subsystems (PageRank misses these)._`,
    );
  } else {
    for (const b of bridges) {
      out.push(
        `- \`${b.name}\` (${b.kind}) — bridge ${b.betweenness.toFixed(SCORE_DECIMALS)} in ${b.filePath}:${b.startLine}`,
      );
    }
  }
  out.push('');
}

function appendDeadCodeLens(out: string[], cg: Cartograph, topN: number): void {
  out.push(
    `## Dead-code candidates (graph-only, no LLM judge)`,
    `_Why ranked here: static candidates have no incoming usage edges, are not exported, and are outside fixture/test/script paths._`,
  );
  // Pass `isFixturePath` so fixture orphans (docs/test-beds/, ...) are
  // dropped INSIDE findGraphCandidates — they sort ahead of src/, so an
  // over-fetch-then-filter approach with this lens's small topN budget
  // filled entirely with fixtures and reported a false "none".
  const dead = findGraphCandidates({ queries: cg.queries, max: topN, isExempt: isFixturePath });
  if (dead.length === 0) {
    out.push(
      `_No orphaned symbols matching the static heuristic (no callers, not exported, not in test/script paths)._`,
    );
  } else {
    for (const d of dead) {
      out.push(`- \`${d.name}\` (${d.kind}) — ${d.filePath}:${d.startLine}`);
    }
    out.push(
      '',
      `_For LLM-judged verdicts (separates dead from framework hooks / dynamic dispatch / public API), call \`cartograph_dead_code\`._`,
    );
  }
  out.push('');
}
