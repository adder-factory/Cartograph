/**
 * Per-symbol code-coverage queries.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain coverage helpers as direct members. The functions
 * read / write the `node_coverage` table via the @internal-tagged
 * `db` and `queries` fields on the parent `QueryBuilder`.
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20). Static prepared statements
 * are declared at module scope via {@link defineQuery} — Zod schemas
 * drive both compile-time and runtime validation of params + rows.
 * Lazy-cached on `qb.queries.X`. `getCoverageStats` uses Pattern C
 * (two static variants for the optional `source` filter).
 * {@link getCoverageRanked} — with four independent optional filters
 * (`source`/`maxPct`/`minCentrality`/`kinds`) — uses
 * {@link defineDynamicQuery}: the SQL is built per call from the
 * present filters, and prepared statements are cached per filter-shape
 * within the instance. Avoids Pattern C variant explosion (16 variants)
 * and Pattern B planner-defeat on indexed `nodes.kind`/`nodes.centrality`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, defineDynamicQuery, type TypedQuery, type DynamicTypedQuery } from './typed-query.js';
import { prefixLikePattern } from './sql-like.js';

const COVERAGE_DEFAULT_RANK_LIMIT = 50;

// ─── Zod schemas ──────────────────────────────────────────────────────────

const UpsertNodeCoverageParamsSchema = z.object({
  nodeId: z.string(),
  source: z.string(),
  coveredLines: z.number(),
  totalLines: z.number(),
  coveredBranches: z.number().nullable(),
  totalBranches: z.number().nullable(),
  ingestedAt: z.number(),
});
type UpsertNodeCoverageParams = z.infer<typeof UpsertNodeCoverageParamsSchema>;

const ClearCoverageSourceParamsSchema = z.object({ source: z.string() });
type ClearCoverageSourceParams = z.infer<typeof ClearCoverageSourceParamsSchema>;

const CoverageSourceRowSchema = z.object({
  source: z.string(),
  row_count: z.number(),
  newest_ingested_at: z.number(),
});
type CoverageSourceRow = z.infer<typeof CoverageSourceRowSchema>;

const NodeCoverageRowDbSchema = z.object({
  source: z.string(),
  covered_lines: z.number(),
  total_lines: z.number(),
  covered_branches: z.number().nullable(),
  total_branches: z.number().nullable(),
  ingested_at: z.number(),
});
type NodeCoverageRowDb = z.infer<typeof NodeCoverageRowDbSchema>;

const NoParams = z.object({});

// ─── Typed query definitions ──────────────────────────────────────────────

const upsertNodeCoverageQuery = defineQuery({
  sql: `INSERT INTO node_coverage
       (node_id, source, covered_lines, total_lines,
        covered_branches, total_branches, ingested_at)
     VALUES (@nodeId, @source, @coveredLines, @totalLines,
             @coveredBranches, @totalBranches, @ingestedAt)
     ON CONFLICT(node_id, source) DO UPDATE SET
       covered_lines    = excluded.covered_lines,
       total_lines      = excluded.total_lines,
       covered_branches = excluded.covered_branches,
       total_branches   = excluded.total_branches,
       ingested_at      = excluded.ingested_at`,
  params: UpsertNodeCoverageParamsSchema,
  row: z.never(),
});

const clearCoverageSourceQuery = defineQuery({
  sql: 'DELETE FROM node_coverage WHERE source = @source',
  params: ClearCoverageSourceParamsSchema,
  row: z.never(),
});

const listCoverageSourcesQuery = defineQuery({
  sql: `SELECT source,
            COUNT(*) AS row_count,
            MAX(ingested_at) AS newest_ingested_at
     FROM node_coverage
     GROUP BY source
     ORDER BY row_count DESC, source ASC`,
  params: NoParams,
  row: CoverageSourceRowSchema,
});

const getNodeCoverageQuery = defineQuery({
  sql: `SELECT source, covered_lines, total_lines, covered_branches,
            total_branches, ingested_at
     FROM node_coverage
     WHERE node_id = @nodeId
     ORDER BY (CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)) DESC
     LIMIT 1`,
  params: z.object({ nodeId: z.string() }),
  row: NodeCoverageRowDbSchema,
});

const SourceOnlyRow = z.object({ source: z.string() });

const listCoverageSourceNamesAllQuery = defineQuery({
  sql: 'SELECT DISTINCT source FROM node_coverage',
  params: NoParams,
  row: SourceOnlyRow,
});

const listCoverageSourceNamesBySourceQuery = defineQuery({
  sql: 'SELECT DISTINCT source FROM node_coverage WHERE source = @source',
  params: z.object({ source: z.string() }),
  row: SourceOnlyRow,
});

const CoverageStatsAggRowSchema = z.object({
  n: z.number(),
  cov: z.number().nullable(),
  tot: z.number().nullable(),
});
type CoverageStatsAggRow = z.infer<typeof CoverageStatsAggRowSchema>;

const coverageStatsAggAllQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n,
            SUM(covered_lines) AS cov,
            SUM(total_lines) AS tot
     FROM (
       SELECT covered_lines, total_lines,
              MAX(CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)) AS pct
       FROM node_coverage
       GROUP BY node_id
     )`,
  params: NoParams,
  row: CoverageStatsAggRowSchema,
});

const coverageStatsAggBySourceQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n,
            SUM(covered_lines) AS cov,
            SUM(total_lines) AS tot
     FROM (
       SELECT covered_lines, total_lines,
              MAX(CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)) AS pct
       FROM node_coverage
       WHERE source = @source
       GROUP BY node_id
     )`,
  params: z.object({ source: z.string() }),
  row: CoverageStatsAggRowSchema,
});

// ─── Coverage-ranked dynamic query ────────────────────────────────────────

/**
 * Pattern: dynamic-WHERE query — 4 independent optional filters
 * (source / maxPct / minCentrality / kinds). Pattern C variant
 * dispatch would explode to 16 typed queries; Pattern B sentinel-OR
 * would defeat the planner against indexes on nodes.kind /
 * nodes.centrality. `defineDynamicQuery` caches per-shape prepared
 * statements within the instance.
 */
const CoverageRankedParamsSchema = z.object({
  minCentrality: z.number().optional(),
  maxPct: z.number().optional(),
  kinds: z.array(z.string()).optional(),
  pathFilter: z.string().optional(),
  limit: z.number(),
  source: z.string().optional(),
});
type CoverageRankedParams = z.infer<typeof CoverageRankedParamsSchema>;

const CoverageRankedRowSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  covered_lines: z.number(),
  total_lines: z.number(),
  pct: z.number().nullable(),
  centrality: z.number().nullable(),
});
type CoverageRankedRow = z.infer<typeof CoverageRankedRowSchema>;

const getCoverageRankedQuery = defineDynamicQuery({
  params: CoverageRankedParamsSchema,
  row: CoverageRankedRowSchema,
  build: (p) => {
    const where: string[] = [];
    const bindings: Record<string, unknown> = { limit: p.limit };
    if (p.source !== undefined) {
      where.push('c.source = @source');
      bindings['source'] = p.source;
    }
    if (p.maxPct !== undefined) {
      where.push('(CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) <= @maxPct');
      bindings['maxPct'] = p.maxPct;
    }
    if (p.minCentrality !== undefined) {
      where.push('n.centrality >= @minCentrality');
      bindings['minCentrality'] = p.minCentrality;
    }
    if (p.kinds && p.kinds.length > 0) {
      where.push('n.kind IN (SELECT value FROM json_each(@kinds))');
      bindings['kinds'] = JSON.stringify(p.kinds);
    }
    if (p.pathFilter !== undefined && p.pathFilter.length > 0) {
      where.push(String.raw`n.file_path LIKE @pathLike ESCAPE '\'`);
      bindings['pathLike'] = prefixLikePattern(p.pathFilter);
    }
    const sql =
      `SELECT n.id AS node_id, n.name, n.kind, n.file_path,
              c.covered_lines, c.total_lines, n.centrality,
              MAX(CAST(c.covered_lines AS REAL) / NULLIF(c.total_lines, 0)) AS pct
         FROM nodes n
         JOIN node_coverage c ON c.node_id = n.id` +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ` GROUP BY n.id
        ORDER BY pct ASC, n.centrality DESC NULLS LAST
        LIMIT @limit`;
    return { sql, bindings };
  },
});

// ─── Module augmentation ──────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    upsertNodeCoverage?: TypedQuery<UpsertNodeCoverageParams, never>;
    clearCoverageSource?: TypedQuery<ClearCoverageSourceParams, never>;
    listCoverageSources?: TypedQuery<Record<string, never>, CoverageSourceRow>;
    getNodeCoverage?: TypedQuery<{ nodeId: string }, NodeCoverageRowDb>;
    listCoverageSourceNamesAll?: TypedQuery<Record<string, never>, { source: string }>;
    listCoverageSourceNamesBySource?: TypedQuery<{ source: string }, { source: string }>;
    coverageStatsAggAll?: TypedQuery<Record<string, never>, CoverageStatsAggRow>;
    coverageStatsAggBySource?: TypedQuery<{ source: string }, CoverageStatsAggRow>;
    getCoverageRanked?: DynamicTypedQuery<CoverageRankedParams, CoverageRankedRow>;
  }
}

/**
 * Argument bundle for `upsertNodeCoverage`. Mirrors a row of the
 * `node_coverage` table, with `null` reserved for line-only sources
 * (no branch info reported by the lcov producer).
 */
interface NodeCoverageRow {
  nodeId: string;
  source: string;
  coveredLines: number;
  totalLines: number;
  /** `null` when the source doesn't report branch coverage. */
  coveredBranches: number | null;
  /** `null` when the source doesn't report branch coverage. */
  totalBranches: number | null;
  /** Unix-milliseconds timestamp of when this row was ingested (caller passes `Date.now()`). */
  ingestedAt: number;
}

/**
 * Insert / update a `node_coverage` row.
 *
 * **Stale-row caveat**: re-running ingestion under the same source
 * key only touches symbols present in the new report. If a file is
 * excluded from a later run (renamed, scope narrowed), the previous
 * row stays in the table until the symbol is deleted. To force a
 * full refresh, either DELETE FROM node_coverage WHERE source = ?
 * before ingestion, or pass a fresh source key per run.
 */
export function upsertNodeCoverage(qb: QueryBuilder, row: NodeCoverageRow): void {
  qb.queries.upsertNodeCoverage ??= upsertNodeCoverageQuery(qb.db);
  qb.queries.upsertNodeCoverage.run({
    nodeId: row.nodeId,
    source: row.source,
    coveredLines: row.coveredLines,
    totalLines: row.totalLines,
    coveredBranches: row.coveredBranches,
    totalBranches: row.totalBranches,
    ingestedAt: row.ingestedAt,
  });
}

/**
 * Drop every `node_coverage` row for a given source. Used when a
 * caller wants to force a full refresh under the same source key
 * (e.g., the report scope changed and stale rows would mislead), or
 * to evict a stray / typo source label entirely (the `mode='drop'`
 * path of `cartograph_coverage`).
 */
export function clearCoverageSource(qb: QueryBuilder, source: string): number {
  qb.queries.clearCoverageSource ??= clearCoverageSourceQuery(qb.db);
  const result = qb.queries.clearCoverageSource.run({ source });
  return result.changes;
}

/** One ingested coverage source — the unit `cartograph_coverage`'s
 *  `mode='sources'` list renders and `mode='drop'` removes. */
export interface CoverageSourceInfo {
  /** The source label (e.g. `lcov`, `unit`, `e2e`). */
  source: string;
  /** Number of `node_coverage` rows carrying this label. */
  rowCount: number;
  /** Newest `ingested_at` for this source, epoch ms. */
  newestIngestedAt: number;
}

/**
 * List every distinct coverage source in the index with its row count
 * and freshest ingestion timestamp, busiest first. Backs
 * `cartograph_coverage({mode: 'sources'})` — the discovery half of the
 * source-cleanup path (a stray / typo `source` label loaded once would
 * otherwise be invisible and unremovable).
 */
export function listCoverageSources(qb: QueryBuilder): CoverageSourceInfo[] {
  qb.queries.listCoverageSources ??= listCoverageSourcesQuery(qb.db);
  const rows = qb.queries.listCoverageSources.all({});
  return rows.map((r) => ({
    source: r.source,
    rowCount: r.row_count,
    newestIngestedAt: r.newest_ingested_at,
  }));
}

/**
 * Coverage rollup for a single symbol. Returns the highest-coverage
 * row across all sources (so a function covered 100% by unit tests
 * and 50% by e2e returns the 100% row). Useful when an agent just
 * wants "is this tested at all?" without caring which suite.
 */
export function getNodeCoverage(
  qb: QueryBuilder,
  nodeId: string,
): {
  source: string;
  coveredLines: number;
  totalLines: number;
  coveredBranches: number | null;
  totalBranches: number | null;
  ingestedAt: number;
} | null {
  qb.queries.getNodeCoverage ??= getNodeCoverageQuery(qb.db);
  const row = qb.queries.getNodeCoverage.get({ nodeId });
  if (!row) return null;
  return {
    source: row.source,
    coveredLines: row.covered_lines,
    totalLines: row.total_lines,
    coveredBranches: row.covered_branches,
    totalBranches: row.total_branches,
    ingestedAt: row.ingested_at,
  };
}

/** Map raw coverage row to public result shape. */
function mapCoverageRow(r: {
  node_id: string;
  name: string;
  kind: string;
  file_path: string;
  covered_lines: number;
  total_lines: number;
  pct: number | null;
  centrality: number | null;
}): {
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  pct: number;
  coveredLines: number;
  totalLines: number;
  centrality: number | null;
} {
  return {
    nodeId: r.node_id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    pct: r.pct ?? 0,
    coveredLines: r.covered_lines,
    totalLines: r.total_lines,
    centrality: r.centrality,
  };
}

/**
 * Symbols covered for at least one source ordered by *worst*
 * coverage first. The killer agent query: pair this with a
 * centrality filter to surface "high-impact untested code."
 *
 * **Per-node dedup**: `node_coverage` is keyed `(node_id, source)`, so
 * a symbol covered by three suites (`unit` / `e2e` / `integration`)
 * holds three rows. Without a `source` filter the raw JOIN would emit
 * the same symbol three times in the ranked list. We collapse to ONE
 * row per `node_id` — the highest-coverage source (mirrors
 * {@link getNodeCoverage}'s "is this tested at all?" rollup) — via a
 * `GROUP BY n.id` over `MAX(pct)`. When `source` IS supplied the
 * filter already guarantees one row per node, so the GROUP BY is a
 * harmless no-op.
 *
 * **`maxPct` is a per-source pre-filter**, applied in the WHERE clause
 * before the `GROUP BY`. A symbol covered 30% by one suite and 80% by
 * another, queried with `maxPct: 0.5`, keeps only the 30% row and so
 * surfaces at 30% — it is NOT excluded for having a better source.
 * That is intentional: "show me anything under-covered by *some*
 * suite" is the under-test-triage question. For "best coverage is
 * still below the cap" semantics a `HAVING MAX(pct) <= @maxPct` would
 * be needed instead.
 */
export function getCoverageRanked(
  qb: QueryBuilder,
  options: {
    minCentrality?: number;
    maxPct?: number;
    kinds?: ReadonlyArray<string> | undefined;
    pathFilter?: string;
    limit?: number;
    source?: string;
  } = {},
): Array<{
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  pct: number;
  coveredLines: number;
  totalLines: number;
  centrality: number | null;
}> {
  qb.queries.getCoverageRanked ??= getCoverageRankedQuery(qb.db);
  const rows = qb.queries.getCoverageRanked.all({
    minCentrality: options.minCentrality,
    maxPct: options.maxPct,
    kinds: options.kinds ? Array.from(options.kinds) : undefined,
    pathFilter: options.pathFilter,
    limit: options.limit ?? COVERAGE_DEFAULT_RANK_LIMIT,
    source: options.source,
  });
  return rows.map(mapCoverageRow);
}

/**
 * Aggregate coverage across the whole project (or a single source).
 * Used by `cartograph_status` when surfacing project-wide health.
 *
 * **Per-node dedup**: `node_coverage` holds one row per
 * `(node_id, source)`, so a symbol covered by three suites carries
 * three rows. A naive `COUNT(*)` / `SUM(...)` over the raw table
 * would triple-count both `symbolsWithCoverage` and the line totals
 * when no `source` filter narrows it to one suite. We first collapse
 * to ONE row per `node_id` — the highest line-ratio source (mirrors
 * {@link getNodeCoverage} and {@link getCoverageRanked}) — then
 * aggregate. With an explicit `source` the per-`(node,source)` key
 * already yields one row per node, so the collapse is a no-op.
 */
export function getCoverageStats(
  qb: QueryBuilder,
  source?: string,
): {
  sources: string[];
  symbolsWithCoverage: number;
  weightedPct: number;
  coveredLines: number;
  totalLines: number;
} {
  // Pattern C — two static `defineQuery` variants for the optional
  // `source` filter dispatched at runtime. Inner aggregate: best-
  // coverage row per node_id. `MAX(line ratio)` in the SELECT list
  // makes the bare covered_lines / total_lines resolve to the row
  // that produced that maximum (SQLite bare-column-with-aggregate
  // rule), so the summed totals come from a single consistent source
  // per symbol.
  let sources: Array<{ source: string }>;
  let agg: CoverageStatsAggRow | undefined;
  if (source) {
    qb.queries.listCoverageSourceNamesBySource ??= listCoverageSourceNamesBySourceQuery(qb.db);
    sources = qb.queries.listCoverageSourceNamesBySource.all({ source });
    qb.queries.coverageStatsAggBySource ??= coverageStatsAggBySourceQuery(qb.db);
    agg = qb.queries.coverageStatsAggBySource.get({ source });
  } else {
    qb.queries.listCoverageSourceNamesAll ??= listCoverageSourceNamesAllQuery(qb.db);
    sources = qb.queries.listCoverageSourceNamesAll.all({});
    qb.queries.coverageStatsAggAll ??= coverageStatsAggAllQuery(qb.db);
    agg = qb.queries.coverageStatsAggAll.get({});
  }
  const n = agg?.n ?? 0;
  const cov = agg?.cov ?? 0;
  const tot = agg?.tot ?? 0;
  return {
    sources: sources.map((r) => r.source),
    symbolsWithCoverage: n,
    weightedPct: tot > 0 ? cov / tot : 0,
    coveredLines: cov,
    totalLines: tot,
  };
}
