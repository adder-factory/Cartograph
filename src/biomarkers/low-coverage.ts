/**
 * Cross-file biomarker rule: `low_coverage`.
 *
 * Fires when a symbol has BOTH:
 *   - centrality in the upper tail of the tested codebase (i.e. enough
 *     callers that breaking it propagates), AND
 *   - coverage_pct at or below the warning ceiling.
 *
 * The rule is silent when `node_coverage` is empty — projects that
 * haven't loaded an lcov report get zero findings, never noise. That
 * also creates a natural feedback loop: after the agent runs
 * `cartograph_coverage({mode: 'refresh'})`, this biomarker starts
 * surfacing the genuinely-undertested-and-load-bearing symbols in
 * `cartograph_biomarkers` / `cartograph_digest` / `cartograph_review({mode: 'risk'})`.
 *
 * The centrality bar is RELATIVE (a percentile of the tested
 * population), not an absolute constant. PageRank centrality is
 * normalised across the graph (mean ≈ 1/N), so a fixed floor scales
 * inversely with repo size: the previous `0.001` floor sat *above the
 * entire under-covered population* on medium/large graphs and the rule
 * could never fire — "didn't fire" read as "all clear" when it wasn't
 * (issue #5). A percentile is graph-size-invariant.
 *
 * The eligible kinds match `coverage --mode ranked` for the
 * logic-bearing units: `function`, `method`, AND `component`. The old
 * `function`/`method`-only filter made the dominant TS/TSX/Vue/Svelte
 * logic unit (the component) permanently invisible, and disagreed with
 * the ranked view that reads the same `node_coverage` table.
 */

import type { QueryBuilder } from '../db/queries.js';
import type { Finding } from './types.js';

/**
 * Top-decile centrality percentile (the `0.9` percentile of the
 * tested-and-eligible population) a symbol must reach before it is
 * "load-bearing" enough to warn on. Relative, so it is graph-size-
 * invariant where a fixed absolute floor was not.
 */
export const LOW_COVERAGE_WARN_CENTRALITY_PERCENTILE = 0.9;

/**
 * Centrality percentile for `error` escalation (the `0.98` percentile),
 * paired with `LOW_COVERAGE_ERROR_PCT`: a symbol this central with
 * near-zero coverage is a genuine red flag.
 */
export const LOW_COVERAGE_ERROR_CENTRALITY_PERCENTILE = 0.98;

/** Coverage ceiling below which we emit (50%). Plenty of well-tested
 *  code sits above this; landing here is a real gap. */
export const LOW_COVERAGE_MAX_PCT = 0.5;

/** Coverage ceiling below which severity escalates to `error`. */
export const LOW_COVERAGE_ERROR_PCT = 0.1;

/**
 * Symbol kinds the rule considers — the logic-bearing units. Mirrors
 * the population `coverage --mode ranked` operates on (no
 * function/method-only restriction), so the two surfaces of the same
 * `node_coverage` table agree. `component` is the key addition: it is
 * the dominant logic unit in React/Vue/Svelte/Astro codebases.
 */
const ELIGIBLE_KINDS = ['function', 'method', 'component'] as const;

/** Scale factor 100 — maps a fraction into an integer percent so
 *  worst-first ranking matches the agent's intuition (lower = worse). */
const PCT_SCALE = 100;
/** Rounding factor 1000 — 3 decimal places for coveragePct in the detail payload. */
const COVERAGE_PCT_ROUND = 1000;
/** Rounding factor 10000 — 4 decimal places for centrality in the detail payload. */
const CENTRALITY_ROUND = 10000;

interface LowCoverageRow {
  nodeId: string;
  coveragePct: number;
  centrality: number;
}

/**
 * Pull every eligible-kind symbol that has coverage data, with its
 * centrality and its maximum coverage (across ingested sources — so a
 * symbol covered well by e2e but poorly by unit isn't flagged). One row
 * per node. This is BOTH the candidate set and the population the
 * relative centrality floor is computed from.
 */
function selectEligibleCovered(queries: QueryBuilder): LowCoverageRow[] {
  const placeholders = ELIGIBLE_KINDS.map(() => '?').join(', ');
  const sql = `
    WITH ranked_coverage AS (
      SELECT c.node_id,
             CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0) AS coveragePct,
             ROW_NUMBER() OVER (
               PARTITION BY c.node_id
               ORDER BY (CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) DESC, c.total_lines DESC
             ) AS rn
      FROM node_coverage c
    )
    SELECT n.id           AS nodeId,
           n.centrality   AS centrality,
           rc.coveragePct AS coveragePct
    FROM nodes n
    JOIN ranked_coverage rc ON rc.node_id = n.id AND rc.rn = 1
    WHERE n.centrality IS NOT NULL
      AND n.kind IN (${placeholders})
      AND rc.coveragePct IS NOT NULL
  `;
  return queries.db.prepare(sql).all(...ELIGIBLE_KINDS) as LowCoverageRow[];
}

/**
 * Nearest-rank percentile of an ascending-sorted array. Returns
 * +Infinity for an empty array so no symbol can clear the bar (there is
 * no candidate to flag anyway).
 */
function percentileAsc(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.POSITIVE_INFINITY;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx]!;
}

/**
 * Severity ladder: error when centrality is in the top ~2% AND coverage
 * is very low; warning otherwise. Both centrality thresholds are
 * relative to the tested population (see {@link percentileAsc}).
 */
function severityFor(row: LowCoverageRow, errorCentralityFloor: number): 'warning' | 'error' {
  if (row.coveragePct <= LOW_COVERAGE_ERROR_PCT && row.centrality >= errorCentralityFloor) {
    return 'error';
  }
  return 'warning';
}

/** Whether any coverage rows exist at all. The rule produces no
 *  findings when this is false (no lcov ingested yet). Cheaper than
 *  running the full join in that common case. */
function hasCoverageData(queries: QueryBuilder): boolean {
  const row = queries.db.prepare(`SELECT 1 AS x FROM node_coverage LIMIT 1`).get() as { x: number } | undefined;
  return row != null;
}

/** Public entry point used by the cross-file biomarker registry. */
export function findLowCoverage(queries: QueryBuilder): Finding[] {
  if (!hasCoverageData(queries)) return [];
  const rows = selectEligibleCovered(queries);
  if (rows.length === 0) return [];

  // Relative centrality floors, computed once from the tested-eligible
  // population so the rule fires consistently across repo sizes.
  const centralitiesAsc = rows.map((r) => r.centrality).sort((a, b) => a - b);
  const warnCentralityFloor = percentileAsc(centralitiesAsc, LOW_COVERAGE_WARN_CENTRALITY_PERCENTILE);
  const errorCentralityFloor = percentileAsc(centralitiesAsc, LOW_COVERAGE_ERROR_CENTRALITY_PERCENTILE);

  const findings: Finding[] = [];
  for (const r of rows) {
    if (r.coveragePct > LOW_COVERAGE_MAX_PCT) continue;
    if (r.centrality < warnCentralityFloor) continue;
    findings.push({
      nodeId: r.nodeId,
      biomarker: 'low_coverage' as const,
      severity: severityFor(r, errorCentralityFloor),
      metric: Math.round(r.coveragePct * PCT_SCALE),
      detail: {
        coveragePct: Math.round(r.coveragePct * COVERAGE_PCT_ROUND) / COVERAGE_PCT_ROUND,
        centrality: Math.round(r.centrality * CENTRALITY_ROUND) / CENTRALITY_ROUND,
      },
    });
  }
  return findings;
}
