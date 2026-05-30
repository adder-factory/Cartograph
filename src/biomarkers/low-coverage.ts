/**
 * Cross-file biomarker rule: `low_coverage`.
 *
 * Fires when a symbol has BOTH:
 *   - centrality at or above the warning floor (i.e. enough callers
 *     that breaking it propagates), AND
 *   - coverage_pct at or below the warning ceiling.
 *
 * The rule is silent when `node_coverage` is empty — projects that
 * haven't loaded an lcov report get zero findings, never noise. That
 * also creates a natural feedback loop: after the agent runs
 * `cartograph_coverage({mode: 'refresh'})`, this biomarker starts
 * surfacing the genuinely-undertested-and-load-bearing symbols in
 * `cartograph_biomarkers` / `cartograph_digest` / `cartograph_review({mode: 'risk'})`.
 *
 * Thresholds are conservative on purpose: a wall of low_coverage
 * findings on day one would train the agent to ignore the rule.
 */

import type { QueryBuilder } from '../db/queries.js';
import type { Finding } from './types.js';

/** Minimum PageRank centrality below which we don't bother emitting.
 *  ~1% of symbols typically clear this bar — keeps the rule signal-rich. */
export const LOW_COVERAGE_MIN_CENTRALITY = 0.001;

/** Coverage ceiling below which we emit (50%). Plenty of well-tested
 *  code sits above this; landing here is a real gap. */
export const LOW_COVERAGE_MAX_PCT = 0.5;

/** Coverage ceiling below which severity escalates to `error`. */
export const LOW_COVERAGE_ERROR_PCT = 0.1;

/** Centrality floor that, paired with `LOW_COVERAGE_ERROR_PCT`,
 *  escalates to `error`. Symbols this central with <10% coverage are
 *  genuine red flags. */
export const LOW_COVERAGE_ERROR_CENTRALITY = 0.05;

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
 * Pull all symbols whose centrality clears the floor and whose maximum
 * coverage (across ingested sources) is at or below the ceiling. One
 * row per node; `MAX(...)` picks the most-favourable source so a
 * symbol covered well by e2e but poorly by unit doesn't get flagged.
 */
function selectCandidates(queries: QueryBuilder): LowCoverageRow[] {
  const sql = `
    SELECT n.id           AS nodeId,
           n.centrality   AS centrality,
           MAX(CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) AS coveragePct
    FROM nodes n
    JOIN node_coverage c ON c.node_id = n.id
    WHERE n.centrality >= ?
      AND (n.kind = 'function' OR n.kind = 'method')
    GROUP BY n.id, n.centrality
    HAVING coveragePct IS NOT NULL AND coveragePct <= ?
  `;
  const rows = queries.db.prepare(sql).all(LOW_COVERAGE_MIN_CENTRALITY, LOW_COVERAGE_MAX_PCT) as Array<{
    nodeId: string;
    centrality: number;
    coveragePct: number;
  }>;
  return rows;
}

/**
 * Severity ladder: error when BOTH centrality is high AND coverage is
 * very low; warning otherwise (the predicate already excludes the
 * "not bad enough" rows via SQL). Info tier is unused — the floor
 * itself does the noise control.
 */
function severityFor(row: LowCoverageRow): 'warning' | 'error' {
  if (row.coveragePct <= LOW_COVERAGE_ERROR_PCT && row.centrality >= LOW_COVERAGE_ERROR_CENTRALITY) {
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
  const rows = selectCandidates(queries);
  return rows.map((r) => ({
    nodeId: r.nodeId,
    biomarker: 'low_coverage' as const,
    severity: severityFor(r),
    metric: Math.round(r.coveragePct * PCT_SCALE),
    detail: {
      coveragePct: Math.round(r.coveragePct * COVERAGE_PCT_ROUND) / COVERAGE_PCT_ROUND,
      centrality: Math.round(r.centrality * CENTRALITY_ROUND) / CENTRALITY_ROUND,
    },
  }));
}
