/**
 * History queries — file-level co-change (mined from git), per-file
 * churn deltas, the combined-risk hotspots view, and symbol-issue
 * attributions (which power both the per-symbol issue history and
 * the symbol-level co-change rollup).
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain history helpers as direct members. The functions
 * read / write `co_changes`, `files.commit_count`, and
 * `symbol_issues` via the `@internal`-tagged `db` field on the
 * parent `QueryBuilder`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ── getHotspots tunables ───────────────────────────────────────────────────
// (Lifted above the typed-query block so the module-level `defineQuery`
// statements that consume HOTSPOTS_ORDER_BY initialize without TDZ.)
/** Default cap on returned hotspot rows. */
const HOTSPOTS_DEFAULT_LIMIT = 15;
/** SQL `ORDER BY` clause per sort mode. */
const HOTSPOTS_ORDER_BY: Readonly<Record<'risk' | 'centrality' | 'churn', string>> = {
  risk: 'riskScore DESC',
  centrality: 'fileCentrality DESC',
  churn: 'commitCount DESC',
};
/** Convert `Date.now()` ms → seconds for `last_touched_ts` comparison. */
const MS_PER_SECOND = 1000;
/** `recencyDays * SECONDS_PER_DAY` → cutoff seconds for the recency filter. */
const SECONDS_PER_DAY = 86400;
/** High percentile threshold (75th) for categorizing hotspots. */
const HIGH_PERCENTILE_THRESHOLD = 0.75;
/** Low percentile threshold (25th) for categorizing hotspots. */
const LOW_PERCENTILE_THRESHOLD = 0.25;

/** Default row cap for `getCoChangedFiles` when caller doesn't pass `limit`. */
const CO_CHANGE_DEFAULT_LIMIT = 10;
/** Default `minCount` floor for `getCoChangedFiles` — pairs sharing one commit are noise. */
const CO_CHANGE_DEFAULT_MIN_COUNT = 2;

// ─── Zod schemas + typed queries (module-level; bound per-DB lazily) ──────
//
// Phase 2 (2026-05-20): the four queries that previously stayed inline raw —
// `getHotspots`, `getCategorizedHotspots`, `getCoChangedFiles`, `getNodesByCommits`
// — are migrated. Hotspot variants split on recency into two static
// queries (Pattern C: variant dispatch); the co-changed-files variants
// split on the anchor-ratio clause. `getNodesByCommits` rebuilds its
// variable IN-list as `json_each(@shasJson)` (Pattern A).

const upsertCoChangeQuery = defineQuery({
  sql:
    `INSERT INTO co_changes (file_a, file_b, count) VALUES (@fileA, @fileB, @count) ` +
    `ON CONFLICT(file_a, file_b) DO UPDATE SET count = count + excluded.count`,
  params: z.object({ fileA: z.string(), fileB: z.string(), count: z.number() }),
  row: z.never(),
});

const applyChurnDeltaQuery = defineQuery({
  sql: `UPDATE files
       SET commit_count    = commit_count + @commitCountDelta,
           last_touched_ts = MAX(COALESCE(last_touched_ts, 0), @lastTouchedTs),
           first_seen_ts   = COALESCE(first_seen_ts, @firstSeenTs)
     WHERE path = @path`,
  params: z.object({
    commitCountDelta: z.number(),
    lastTouchedTs: z.number(),
    firstSeenTs: z.number(),
    path: z.string(),
  }),
  row: z.never(),
});

const insertSymbolIssueQuery = defineQuery({
  sql:
    `INSERT OR IGNORE INTO symbol_issues (node_id, issue_number, commit_sha, kind) ` +
    `VALUES (@nodeId, @issueNumber, @commitSha, @kind)`,
  params: z.object({
    nodeId: z.string(),
    issueNumber: z.number(),
    commitSha: z.string(),
    kind: z.enum(['modified', 'added', 'removed']),
  }),
  row: z.never(),
});

const getSymbolIssuesCountQuery = defineQuery({
  sql: 'SELECT COUNT(*) as count FROM symbol_issues',
  params: z.object({}),
  row: z.object({ count: z.number() }),
});

const getIssuesForNodeQuery = defineQuery({
  sql: `SELECT issue_number AS issueNumber, kind, commit_sha AS commitSha
     FROM symbol_issues
     WHERE node_id = @nodeId
     ORDER BY issue_number ASC, kind ASC`,
  params: z.object({ nodeId: z.string() }),
  row: z.object({
    issueNumber: z.number(),
    kind: z.enum(['modified', 'added', 'removed']),
    commitSha: z.string(),
  }),
});

const getSymbolCoChangesQuery = defineQuery({
  sql: `WITH commit_node_counts AS (
       SELECT commit_sha, COUNT(DISTINCT node_id) AS n
       FROM symbol_issues
       WHERE kind = 'modified'
       GROUP BY commit_sha
     )
     SELECT b.node_id AS nodeId, COUNT(*) AS coOccurrences,
            GROUP_CONCAT(b.commit_sha) AS commitShas
     FROM symbol_issues a
     JOIN symbol_issues b
       ON b.commit_sha = a.commit_sha
      AND b.node_id != a.node_id
     JOIN commit_node_counts cnc
       ON cnc.commit_sha = a.commit_sha
     WHERE a.node_id = @nodeId
       AND a.kind = 'modified'
       AND b.kind = 'modified'
       AND cnc.n <= @maxNodesPerCommit
     GROUP BY b.node_id
     HAVING coOccurrences >= @minCount
     ORDER BY coOccurrences DESC, b.node_id ASC
     LIMIT @limit`,
  params: z.object({
    nodeId: z.string(),
    maxNodesPerCommit: z.number(),
    minCount: z.number(),
    limit: z.number(),
  }),
  row: z.object({
    nodeId: z.string(),
    coOccurrences: z.number(),
    commitShas: z.string(),
  }),
});

// ── Hotspot + co-change typed-query Zod schemas ────────────────────────────

/** Row shape for the `getHotspots` query — wide hotspot tuple. */
const HotspotRowSchema = z.object({
  filePath: z.string(),
  fileCentrality: z.number(),
  commitCount: z.number(),
  loc: z.number().nullable(),
  lastTouchedTs: z.number().nullable(),
  riskScore: z.number(),
});
type HotspotRowOut = z.infer<typeof HotspotRowSchema>;

/** Row shape for `getCategorizedHotspots` — adds `externalDependents`. */
const CategorizedHotspotRowSchema = HotspotRowSchema.extend({
  externalDependents: z.number(),
});
type CategorizedHotspotRowOut = z.infer<typeof CategorizedHotspotRowSchema>;

/** Row shape for `getCoChangedFiles` — DB-native snake_case for anchor_ratio. */
const CoChangedFilesRowSchema = z.object({
  path: z.string(),
  count: z.number(),
  jaccard: z.number().nullable(),
  anchor_ratio: z.number().nullable(),
});
type CoChangedFilesRow = z.infer<typeof CoChangedFilesRowSchema>;

/** Row shape for `getNodesByCommits` — joined node + sha tuple. */
const NodesByCommitsRowSchema = z.object({
  sha: z.string(),
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  filePath: z.string(),
});
type NodesByCommitsRow = z.infer<typeof NodesByCommitsRowSchema>;

// ── Hotspot SQL fragments (Pattern C: variant dispatch) ────────────────────

/**
 * Shared `SELECT … FROM files f LEFT JOIN …` body for the plain hotspot
 * query. Two variants — with and without recency filter — embed this
 * with a different WHERE / LIMIT footer so the inner SQL never drifts.
 */
function buildHotspotsSelectBody(orderBy: string, recencyClause: string): string {
  return `
    SELECT
      f.path                                     AS filePath,
      COALESCE(n_agg.fc, 0.0)                    AS fileCentrality,
      f.commit_count                             AS commitCount,
      f.loc                                      AS loc,
      f.last_touched_ts                          AS lastTouchedTs,
      COALESCE(n_agg.fc, 0.0) * f.commit_count   AS riskScore
    FROM files f
    LEFT JOIN (
      SELECT file_path, SUM(centrality) AS fc
      FROM nodes WHERE centrality IS NOT NULL
      GROUP BY file_path
    ) n_agg ON n_agg.file_path = f.path
    WHERE f.commit_count >= @minCommits AND COALESCE(n_agg.fc, 0.0) >= @minCentrality ${recencyClause}
    ORDER BY ${orderBy}
    LIMIT @limit
  `;
}

/**
 * Shared SELECT body for the categorized variant — adds the
 * `externalDependents` correlated sub-select and drops the LIMIT
 * (categorization needs the full qualifying dataset to compute
 * percentile thresholds).
 */
function buildCategorizedHotspotsSelectBody(recencyClause: string): string {
  return `
    SELECT
      f.path                                     AS filePath,
      COALESCE(n_agg.fc, 0.0)                    AS fileCentrality,
      f.commit_count                             AS commitCount,
      f.loc                                      AS loc,
      f.last_touched_ts                          AS lastTouchedTs,
      COALESCE(n_agg.fc, 0.0) * f.commit_count   AS riskScore,
      COALESCE(dep.dep_files, 0)                 AS externalDependents
    FROM files f
    LEFT JOIN (
      SELECT file_path, SUM(centrality) AS fc
      FROM nodes WHERE centrality IS NOT NULL
      GROUP BY file_path
    ) n_agg ON n_agg.file_path = f.path
    LEFT JOIN (
      -- Per-file external in-degree: how many OTHER files genuinely
      -- depend on a symbol in this file. The same-file predicate drops
      -- contains / intra-file edges so a self-contained script's
      -- internal structure does not read as depended-upon. The
      -- edge-kind allowlist drops field_access — resolved by bare
      -- field name, so a common field (processed / name / id) draws
      -- spurious cross-file edges into whatever file happens to define
      -- a same-named field — and similar_to / tests, which are not
      -- code-here-uses-a-definition-there dependencies.
      SELECT tgt.file_path AS fp, COUNT(DISTINCT src.file_path) AS dep_files
      FROM edges e
      JOIN nodes src ON e.source = src.id
      JOIN nodes tgt ON e.target = tgt.id
      WHERE src.file_path <> tgt.file_path
        AND e.kind IN (
          'calls', 'references', 'instantiates', 'extends',
          'implements', 'overrides', 'type_of', 'returns', 'decorates'
        )
      GROUP BY tgt.file_path
    ) dep ON dep.fp = f.path
    WHERE f.commit_count >= @minCommits AND COALESCE(n_agg.fc, 0.0) >= @minCentrality ${recencyClause}
  `;
}

const HOTSPOT_RECENCY_CLAUSE = 'AND f.last_touched_ts IS NOT NULL AND f.last_touched_ts >= @recencyCutoff';

/**
 * Per-`sortBy` hotspot query (no recency filter). The three sort modes
 * differ ONLY in ORDER BY, so each is a distinct prepared statement
 * with the same params shape.
 */
const HotspotsAllParamsSchema = z.object({
  minCommits: z.number(),
  minCentrality: z.number(),
  limit: z.number(),
});

const HotspotsWithRecencyParamsSchema = HotspotsAllParamsSchema.extend({
  recencyCutoff: z.number(),
});

function makeHotspotsAllQuery(orderBy: string) {
  return defineQuery({
    sql: buildHotspotsSelectBody(orderBy, ''),
    params: HotspotsAllParamsSchema,
    row: HotspotRowSchema,
  });
}

function makeHotspotsWithRecencyQuery(orderBy: string) {
  return defineQuery({
    sql: buildHotspotsSelectBody(orderBy, HOTSPOT_RECENCY_CLAUSE),
    params: HotspotsWithRecencyParamsSchema,
    row: HotspotRowSchema,
  });
}

const hotspotsAllQueries = {
  risk: makeHotspotsAllQuery(HOTSPOTS_ORDER_BY.risk),
  centrality: makeHotspotsAllQuery(HOTSPOTS_ORDER_BY.centrality),
  churn: makeHotspotsAllQuery(HOTSPOTS_ORDER_BY.churn),
} as const;

const hotspotsWithRecencyQueries = {
  risk: makeHotspotsWithRecencyQuery(HOTSPOTS_ORDER_BY.risk),
  centrality: makeHotspotsWithRecencyQuery(HOTSPOTS_ORDER_BY.centrality),
  churn: makeHotspotsWithRecencyQuery(HOTSPOTS_ORDER_BY.churn),
} as const;

// Categorized hotspots — no per-sort variants (the caller buckets in JS),
// just split on recency.
const CategorizedHotspotsAllParamsSchema = z.object({
  minCommits: z.number(),
  minCentrality: z.number(),
});

const CategorizedHotspotsWithRecencyParamsSchema = CategorizedHotspotsAllParamsSchema.extend({
  recencyCutoff: z.number(),
});

const categorizedHotspotsAllQuery = defineQuery({
  sql: buildCategorizedHotspotsSelectBody(''),
  params: CategorizedHotspotsAllParamsSchema,
  row: CategorizedHotspotRowSchema,
});

const categorizedHotspotsWithRecencyQuery = defineQuery({
  sql: buildCategorizedHotspotsSelectBody(HOTSPOT_RECENCY_CLAUSE),
  params: CategorizedHotspotsWithRecencyParamsSchema,
  row: CategorizedHotspotRowSchema,
});

// ── getNodesByCommits — Pattern A: variable IN-list via json_each ──────────

const getNodesByCommitsQuery = defineQuery({
  sql: `
    SELECT s.commit_sha AS sha, n.id AS id, n.name AS name, n.kind AS kind, n.file_path AS filePath
      FROM symbol_issues s
      JOIN nodes n ON n.id = s.node_id
     WHERE s.commit_sha IN (SELECT value FROM json_each(@shasJson))
       AND s.kind = 'modified'
       AND s.node_id != @excludeNodeId
  `,
  params: z.object({ shasJson: z.string(), excludeNodeId: z.string() }),
  row: NodesByCommitsRowSchema,
});

// ── getCoChangedFiles — Pattern C: split on anchor-ratio clause ────────────

const CO_CHANGED_FILES_ANCHOR_CLAUSE = 'OR COALESCE(anchor_ratio, 0) >= @minAnchorRatio';

function buildCoChangedFilesSqlNamed(anchorClause: string): string {
  return `
    WITH partners AS (
      SELECT file_b AS path, count FROM co_changes WHERE file_a = @filePath
      UNION ALL
      SELECT file_a AS path, count FROM co_changes WHERE file_b = @filePath
    ),
    anchor AS (SELECT commit_count AS c FROM files WHERE path = @filePath),
    scored AS (
      SELECT
        p.path AS path,
        p.count AS count,
        CAST(p.count AS REAL) / NULLIF(
          MAX((SELECT c FROM anchor), p.count)
          + MAX(f.commit_count, p.count)
          - p.count,
          0
        ) AS jaccard,
        CAST(p.count AS REAL) / NULLIF(
          MAX((SELECT c FROM anchor), p.count),
          0
        ) AS anchor_ratio
      FROM partners p
      JOIN files f ON f.path = p.path
      WHERE p.count >= @minCount
    )
    SELECT path, count, jaccard, anchor_ratio FROM scored
    WHERE COALESCE(jaccard, 0) >= @minJaccard
       ${anchorClause}
    ORDER BY jaccard DESC, anchor_ratio DESC, count DESC
    LIMIT @limit
  `;
}

const CoChangedFilesBaseParamsSchema = z.object({
  filePath: z.string(),
  minCount: z.number(),
  minJaccard: z.number(),
  limit: z.number(),
});

const CoChangedFilesWithAnchorParamsSchema = CoChangedFilesBaseParamsSchema.extend({
  minAnchorRatio: z.number(),
});

const coChangedFilesNoAnchorQuery = defineQuery({
  sql: buildCoChangedFilesSqlNamed(''),
  params: CoChangedFilesBaseParamsSchema,
  row: CoChangedFilesRowSchema,
});

const coChangedFilesWithAnchorQuery = defineQuery({
  sql: buildCoChangedFilesSqlNamed(CO_CHANGED_FILES_ANCHOR_CLAUSE),
  params: CoChangedFilesWithAnchorParamsSchema,
  row: CoChangedFilesRowSchema,
});

declare module './queries.js' {
  interface QueryRegistry {
    upsertCoChange?: TypedQuery<{ fileA: string; fileB: string; count: number }, never>;
    applyChurnDelta?: TypedQuery<
      { commitCountDelta: number; lastTouchedTs: number; firstSeenTs: number; path: string },
      never
    >;
    insertSymbolIssue?: TypedQuery<
      {
        nodeId: string;
        issueNumber: number;
        commitSha: string;
        kind: 'modified' | 'added' | 'removed';
      },
      never
    >;
    getSymbolIssuesCount?: TypedQuery<Record<string, never>, { count: number }>;
    getIssuesForNode?: TypedQuery<
      { nodeId: string },
      { issueNumber: number; kind: 'modified' | 'added' | 'removed'; commitSha: string }
    >;
    getSymbolCoChanges?: TypedQuery<
      { nodeId: string; maxNodesPerCommit: number; minCount: number; limit: number },
      { nodeId: string; coOccurrences: number; commitShas: string }
    >;
    // Hotspot variants — Pattern C (variant dispatch). The per-sortBy ×
    // per-recency matrix is six prepared statements (3 sort modes × 2
    // recency variants), lazily cached as a flat key.
    hotspotsAllRisk?: TypedQuery<z.infer<typeof HotspotsAllParamsSchema>, HotspotRowOut>;
    hotspotsAllCentrality?: TypedQuery<z.infer<typeof HotspotsAllParamsSchema>, HotspotRowOut>;
    hotspotsAllChurn?: TypedQuery<z.infer<typeof HotspotsAllParamsSchema>, HotspotRowOut>;
    hotspotsWithRecencyRisk?: TypedQuery<z.infer<typeof HotspotsWithRecencyParamsSchema>, HotspotRowOut>;
    hotspotsWithRecencyCentrality?: TypedQuery<z.infer<typeof HotspotsWithRecencyParamsSchema>, HotspotRowOut>;
    hotspotsWithRecencyChurn?: TypedQuery<z.infer<typeof HotspotsWithRecencyParamsSchema>, HotspotRowOut>;
    categorizedHotspotsAll?: TypedQuery<z.infer<typeof CategorizedHotspotsAllParamsSchema>, CategorizedHotspotRowOut>;
    categorizedHotspotsWithRecency?: TypedQuery<
      z.infer<typeof CategorizedHotspotsWithRecencyParamsSchema>,
      CategorizedHotspotRowOut
    >;
    getNodesByCommits?: TypedQuery<{ shasJson: string; excludeNodeId: string }, NodesByCommitsRow>;
    coChangedFilesNoAnchor?: TypedQuery<z.infer<typeof CoChangedFilesBaseParamsSchema>, CoChangedFilesRow>;
    coChangedFilesWithAnchor?: TypedQuery<z.infer<typeof CoChangedFilesWithAnchorParamsSchema>, CoChangedFilesRow>;
  }
}

// ===========================================================================
// Co-Change (file-level coupling derived from git history)
// ===========================================================================

/**
 * Persist co-change pair deltas. `files.commit_count` is owned by the
 * churn miner (see `src/db/row-mapper.ts:192` and `src/churn/index.ts`)
 * — the cochange miner ALSO computes a per-file commit count for
 * diagnostic / test purposes, but writing it here would double-count
 * against the churn miner's writes and produces the jaccard > 1
 * symptom that this function used to be implicated in (queries-history
 * `buildCoChangedFilesSql` clamp). Single-writer discipline now: only
 * the churn miner writes commit_count.
 */
export function applyCoChangeDeltas(qb: QueryBuilder, pairDeltas: Iterable<[string, string, number]>): void {
  qb.queries.upsertCoChange ??= upsertCoChangeQuery(qb.db);
  const upsertPair = qb.queries.upsertCoChange;
  qb.db.transaction(() => {
    for (const [a, b, delta] of pairDeltas) {
      const { lo, hi } = orderPair(a, b);
      if (lo === hi) continue;
      upsertPair.run({ fileA: lo, fileB: hi, count: delta });
    }
  })();
}

/**
 * Canonicalise a co-change pair so the (lo, hi) tuple is order-
 * independent — `(A, B)` and `(B, A)` collapse to the same key. Used
 * by {@link applyCoChangeDeltas} so the unique-key on
 * `(file_a, file_b)` matches per-direction without a second index.
 */
function orderPair(a: string, b: string): { lo: string; hi: string } {
  if (a < b) return { lo: a, hi: b };
  return { lo: b, hi: a };
}

// ===========================================================================
// Per-file churn (mined from git log)
// ===========================================================================

export function applyChurnDeltas(
  qb: QueryBuilder,
  deltas: Iterable<{
    path: string;
    commitCountDelta: number;
    lastTouchedTs: number;
    firstSeenTs: number;
  }>,
): void {
  qb.queries.applyChurnDelta ??= applyChurnDeltaQuery(qb.db);
  const stmt = qb.queries.applyChurnDelta;
  qb.db.transaction(() => {
    for (const d of deltas) {
      stmt.run({
        commitCountDelta: d.commitCountDelta,
        lastTouchedTs: d.lastTouchedTs,
        firstSeenTs: d.firstSeenTs,
        path: d.path,
      });
    }
  })();
}

/** Reset all churn columns; used before a full re-mine. Does not touch `loc`. */
export function clearChurn(qb: QueryBuilder): void {
  qb.db.exec(`UPDATE files SET commit_count = 0, last_touched_ts = NULL, first_seen_ts = NULL`);
}

/** Translate the `recencyDays` window into a unix-second cutoff, or null
 *  when no recency filter is in effect. Pulled out of {@link getHotspots}
 *  so its conditional stays simple. */
function computeRecencyCutoff(hasRecency: boolean, recencyDays: number | undefined): number | null {
  if (!hasRecency || recencyDays === undefined) return null;
  return Math.floor(Date.now() / MS_PER_SECOND) - recencyDays * SECONDS_PER_DAY;
}

// `buildHotspotsSql` (the dynamic-SQL builder) is replaced by the
// per-sortBy × per-recency typed-query matrix declared at module scope
// (Pattern C — variant dispatch). The two recency variants stay as
// distinct prepared statements so the optional clause is encoded in the
// SQL string, not as a sentinel param that would risk forcing a table
// scan on the indexed `last_touched_ts` column.

/**
 * Hotspots: files ranked by `risk = (Σ centrality of nodes in file) × commit_count`.
 *
 * Both inputs are optional in their own right; with neither computed,
 * this returns []. Sorting modes:
 *   - 'risk'        : the combined score (default; what "hotspot" means)
 *   - 'centrality'  : pure structural importance
 *   - 'churn'       : pure change frequency
 */
export function getHotspots(
  qb: QueryBuilder,
  opts: {
    limit?: number;
    minCommits?: number;
    minCentrality?: number;
    sortBy?: 'risk' | 'centrality' | 'churn';
    recencyDays?: number;
  } = {},
): Array<{
  filePath: string;
  fileCentrality: number;
  commitCount: number;
  // `loc` is nullable in `files.loc` (rows pre-LOC-mining have NULL);
  // typed-query row validation surfaced what the prior raw cast was
  // hiding. Callers already rendered `${row.loc}` directly, which prints
  // "null" for missing rows — the public type now matches reality.
  loc: number | null;
  lastTouchedTs: number | null;
  riskScore: number;
}> {
  const sortBy = opts.sortBy ?? 'risk';
  const limit = opts.limit ?? HOTSPOTS_DEFAULT_LIMIT;
  const minCommits = opts.minCommits ?? 0;
  const minCentrality = opts.minCentrality ?? 0;
  const hasRecency = opts.recencyDays !== undefined && opts.recencyDays > 0;
  const recencyCutoff = computeRecencyCutoff(hasRecency, opts.recencyDays);

  if (recencyCutoff !== null) {
    // Six prepared statements total (3 sortBy × 2 recency variants);
    // lazy-cache each as a distinct registry key so we never re-prepare.
    const regKey = `hotspotsWithRecency${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}` as
      | 'hotspotsWithRecencyRisk'
      | 'hotspotsWithRecencyCentrality'
      | 'hotspotsWithRecencyChurn';
    qb.queries[regKey] ??= hotspotsWithRecencyQueries[sortBy](qb.db);
    return qb.queries[regKey].all({ minCommits, minCentrality, recencyCutoff, limit });
  }
  const regKey = `hotspotsAll${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}` as
    | 'hotspotsAllRisk'
    | 'hotspotsAllCentrality'
    | 'hotspotsAllChurn';
  qb.queries[regKey] ??= hotspotsAllQueries[sortBy](qb.db);
  return qb.queries[regKey].all({ minCommits, minCentrality, limit });
}

/** A single row returned by the hotspot family of queries. */
export interface HotspotRow {
  filePath: string;
  fileCentrality: number;
  commitCount: number;
  /** Nullable: `files.loc` is NULL until LOC mining has populated it. */
  loc: number | null;
  lastTouchedTs: number | null;
  riskScore: number;
  /**
   * Count of OTHER files with at least one edge into a symbol in this
   * file — i.e. the file's external in-degree. `fileCentrality` (Σ of
   * node PageRank) conflates "internally rich" with "depended upon": a
   * self-contained spike script whose helpers all call each other
   * scores high centrality with zero external consumers. The `brittle`
   * lens ("changes here have outsized impact") requires this > 0 so it
   * can't mislabel such a file as critical. Populated only by the
   * categorized query; absent on the plain `getHotspots` path.
   */
  externalDependents?: number;
}

/**
 * Returns the value at a given percentile (0–1) in a sorted array.
 * `arr` must be sorted ascending. Returns 0 when the array is empty.
 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx]!;
}

/** Percentile threshold values computed from the full hotspot dataset. */
interface HotspotThresholds {
  highCentrality: number;
  lowCentrality: number;
  highChurn: number;
  lowChurn: number;
}

// `buildCategorizedHotspotsSql` (the dynamic-SQL builder) is replaced
// by the two typed queries declared at module scope (Pattern C —
// variant dispatch on recency). Categorization still needs the full
// qualifying dataset (no LIMIT) to compute percentile thresholds in JS;
// that contract is unchanged.

/**
 * Compute the four percentile thresholds (high/low × centrality/churn)
 * from a non-empty slice of hotspot rows. The 75th percentile is "high";
 * the 25th is "low". Both use {@link quantile} on pre-sorted arrays.
 */
function computePercentileThresholds(rows: HotspotRow[]): HotspotThresholds {
  const centralities = rows.map((r) => r.fileCentrality).sort((a, b) => a - b);
  const churns = rows.map((r) => r.commitCount).sort((a, b) => a - b);
  return {
    highCentrality: quantile(centralities, HIGH_PERCENTILE_THRESHOLD),
    lowCentrality: quantile(centralities, LOW_PERCENTILE_THRESHOLD),
    highChurn: quantile(churns, HIGH_PERCENTILE_THRESHOLD),
    lowChurn: quantile(churns, LOW_PERCENTILE_THRESHOLD),
  };
}

/**
 * Partition `rows` into the three maintenance-lens buckets using
 * pre-computed thresholds. Each bucket is independently sorted and
 * capped to `limitPerCat` rows.
 *
 * Bucket criteria (mutually exclusive across centrality dimension):
 *   - **risk**        = high centrality AND high churn (combined score)
 *   - **maintenance** = high churn AND low centrality (refactor / tooling-debt)
 *   - **brittle**     = high centrality AND low churn AND ≥1 external
 *     dependent (stable code whose change genuinely has blast radius)
 */
function bucketHotspots(
  rows: HotspotRow[],
  t: HotspotThresholds,
  limitPerCat: number,
): { risk: HotspotRow[]; maintenance: HotspotRow[]; brittle: HotspotRow[] } {
  const risk = rows
    .filter((r) => r.fileCentrality >= t.highCentrality && r.commitCount >= t.highChurn)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, limitPerCat);

  const maintenance = rows
    .filter((r) => r.commitCount >= t.highChurn && r.fileCentrality <= t.lowCentrality)
    .sort((a, b) => b.commitCount - a.commitCount)
    .slice(0, limitPerCat);

  // `brittle` claims "changes here have outsized impact" — gate it on
  // a real external in-degree so a self-contained spike script (high
  // internal centrality, zero consumers) can't be mislabeled critical.
  const brittle = rows
    .filter(
      (r) => r.fileCentrality >= t.highCentrality && r.commitCount <= t.lowChurn && (r.externalDependents ?? 0) > 0,
    )
    .sort((a, b) => b.fileCentrality - a.fileCentrality)
    .slice(0, limitPerCat);

  return { risk, maintenance, brittle };
}

/**
 * Categorized hotspots — splits files into three maintenance-lens buckets:
 *
 *   - **risk**: high centrality × high churn (existing "hotspot" definition)
 *   - **maintenance**: high churn, low centrality (refactor-target / tooling-debt)
 *   - **brittle**: high centrality, low churn (stable critical code; changes have outsized impact)
 *
 * Thresholds are computed from the data: the 75th percentile of each dimension
 * is "high"; the 25th percentile is "low". This avoids hardcoded magic numbers
 * that age badly as the repo grows. Uses the same base SQL as `getHotspots`.
 */
export function getCategorizedHotspots(
  qb: QueryBuilder,
  opts: {
    minCommits?: number;
    minCentrality?: number;
    recencyDays?: number;
    limitPerCategory?: number;
  } = {},
): {
  risk: HotspotRow[];
  maintenance: HotspotRow[];
  brittle: HotspotRow[];
} {
  const minCommits = opts.minCommits ?? 0;
  const minCentrality = opts.minCentrality ?? 0;
  const hasRecency = opts.recencyDays !== undefined && opts.recencyDays > 0;
  const recencyCutoff = computeRecencyCutoff(hasRecency, opts.recencyDays);

  // Fetch all qualifying rows — no LIMIT because categorization requires
  // the full dataset to compute data-driven percentile thresholds.
  let all: HotspotRow[];
  if (recencyCutoff === null) {
    qb.queries.categorizedHotspotsAll ??= categorizedHotspotsAllQuery(qb.db);
    all = qb.queries.categorizedHotspotsAll.all({ minCommits, minCentrality });
  } else {
    qb.queries.categorizedHotspotsWithRecency ??= categorizedHotspotsWithRecencyQuery(qb.db);
    all = qb.queries.categorizedHotspotsWithRecency.all({
      minCommits,
      minCentrality,
      recencyCutoff,
    });
  }
  if (all.length === 0) return { risk: [], maintenance: [], brittle: [] };

  const thresholds = computePercentileThresholds(all);
  return bucketHotspots(all, thresholds, opts.limitPerCategory ?? HOTSPOTS_DEFAULT_LIMIT);
}

// ===========================================================================
// Symbol-issue attributions (mined from git history)
// ===========================================================================

export function applyIssueAttributions(
  qb: QueryBuilder,
  rows: Iterable<{
    nodeId: string;
    issueNumber: number;
    commitSha: string;
    kind: 'modified' | 'added' | 'removed';
  }>,
): void {
  qb.queries.insertSymbolIssue ??= insertSymbolIssueQuery(qb.db);
  const stmt = qb.queries.insertSymbolIssue;
  qb.db.transaction(() => {
    for (const r of rows) {
      stmt.run({
        nodeId: r.nodeId,
        issueNumber: r.issueNumber,
        commitSha: r.commitSha,
        kind: r.kind,
      });
    }
  })();
}

export function clearIssueAttributions(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM symbol_issues');
}

/**
 * Cheap COUNT(*) for the symbol_issues table. Used by the
 * issue-history hook to detect the orphan-metadata case where
 * `clearStructural` wiped the table but the
 * `last_mined_issues_head` key survived — without this check the
 * incremental path would silently skip a needed full rescan.
 */
export function getSymbolIssuesCount(qb: QueryBuilder): number {
  qb.queries.getSymbolIssuesCount ??= getSymbolIssuesCountQuery(qb.db);
  const row = qb.queries.getSymbolIssuesCount.get({});
  return row?.count ?? 0;
}

/**
 * Bulk fetch: for a set of commit SHAs, return the (modified) symbols
 * touched in each — minus the symbol the caller already knows about
 * (typically the blame target, to avoid echoing it back). Returns a
 * map keyed by sha so the caller can render per-commit lists without
 * an N+1 query loop. SHAs not present in `symbol_issues` simply have
 * no entry in the returned map.
 */
export function getNodesByCommits(
  qb: QueryBuilder,
  shas: ReadonlyArray<string>,
  excludeNodeId: string,
): Map<string, Array<{ id: string; name: string; kind: string; filePath: string }>> {
  const out = new Map<string, Array<{ id: string; name: string; kind: string; filePath: string }>>();
  if (shas.length === 0) return out;
  qb.queries.getNodesByCommits ??= getNodesByCommitsQuery(qb.db);
  const rows = qb.queries.getNodesByCommits.all({
    shasJson: JSON.stringify(shas),
    excludeNodeId,
  });
  for (const r of rows) {
    const arr = out.get(r.sha);
    const entry = { id: r.id, name: r.name, kind: r.kind, filePath: r.filePath };
    if (arr) arr.push(entry);
    else out.set(r.sha, [entry]);
  }
  return out;
}

export function getIssuesForNode(
  qb: QueryBuilder,
  nodeId: string,
): Array<{
  issueNumber: number;
  kind: 'modified' | 'added' | 'removed';
  commitSha: string;
}> {
  qb.queries.getIssuesForNode ??= getIssuesForNodeQuery(qb.db);
  return qb.queries.getIssuesForNode.all({ nodeId });
}

/** Default cap on co-change rows returned to the caller. */
const SYMBOL_COCHANGES_DEFAULT_LIMIT = 20;

/**
 * Sweep-commit guard: max distinct nodes touched by a commit before
 * it's excluded from co-change tallies. Mirrors `MAX_FILES_PER_COMMIT`
 * in cochange/index.ts — 50 is empirically a clean knee separating
 * real feature commits from mass-refactor / generated-code sweeps.
 */
const SYMBOL_COCHANGES_MAX_NODES_PER_COMMIT = 50;

/**
 * Cap on individual commit shas echoed back per co-change pair. Five
 * is enough evidence for the agent to spot-check coupling without
 * inflating response size on long-coupled pairs.
 */
const SHARED_COMMITS_ECHO_CAP = 5;

/**
 * Symbols that have been modified in the same commits as the given
 * node, ranked by co-occurrence count. Mines the existing
 * `symbol_issues` table — no extra git work. Self-rows excluded.
 *
 * Use case: "the last 5 times function X changed, what other
 * symbols also changed?" — pre-edit forcing function for the
 * agent. A high count for symbol Y means: when X is edited, Y is
 * usually edited too. Worth checking before shipping.
 *
 * Both the source and the co-changing rows are restricted to
 * kind='modified' so add/remove churn doesn't dominate the count.
 */
export function getSymbolCoChanges(
  qb: QueryBuilder,
  nodeId: string,
  opts: { limit?: number; minCount?: number; maxNodesPerCommit?: number } = {},
): Array<{ nodeId: string; coOccurrences: number; sharedCommits: string[] }> {
  const limit = opts.limit ?? SYMBOL_COCHANGES_DEFAULT_LIMIT;
  const minCount = opts.minCount ?? 2;
  // Sweep-commit guard: mass-reformat / linter / generated-code
  // commits can touch hundreds of unrelated symbols. Without a cap,
  // any two symbols that appeared in two such sweeps would surface
  // as historically coupled. The threshold mirrors the file-level
  // co-change miner — 50 is empirically a clean knee.
  const maxNodesPerCommit = opts.maxNodesPerCommit ?? SYMBOL_COCHANGES_MAX_NODES_PER_COMMIT;
  qb.queries.getSymbolCoChanges ??= getSymbolCoChangesQuery(qb.db);
  const rows = qb.queries.getSymbolCoChanges.all({
    nodeId,
    maxNodesPerCommit,
    minCount,
    limit,
  });
  return rows.map((r) => ({
    nodeId: r.nodeId,
    coOccurrences: r.coOccurrences,
    sharedCommits: r.commitShas.split(',').slice(0, SHARED_COMMITS_ECHO_CAP), // cap echo for token-cost control
  }));
}

// ===========================================================================
// Co-Change reads
// ===========================================================================

export function clearCoChanges(qb: QueryBuilder): void {
  // Only clears co-change history — NOT symbol_summaries /
  // symbol_embeddings / directory_summaries. Those LLM-derived
  // caches are keyed by content_hash of the symbol body, not by
  // commit history, so a co-change rescan has no logical bearing
  // on whether they're fresh. Pre-bd26945 this method also wiped
  // those tables, but that was redundant with `clear()` (which
  // --force used to call) and harmful with `clearStructural()`
  // (which --force now calls): the post-indexAll cochange hook
  // would re-wipe the LLM caches that clearStructural intentionally
  // preserved, defeating the content-hash short-circuit.
  //
  // `files.commit_count` is intentionally LEFT ALONE — the churn
  // miner owns that column (single-writer discipline). Pre-fix this
  // function zeroed it alongside `co_changes`, which produced the
  // shared > anchor.commit_count drift that surfaced as jaccard > 1
  // in `buildCoChangedFilesSql`. The churn miner re-mines and
  // re-derives commit_count on its own cadence.
  qb.db.exec('DELETE FROM co_changes');
}

// The anchor-ratio clause + co-changed-files SQL template (formerly
// `buildAnchorClause` + `buildCoChangedFilesSql`) are now encoded as
// two distinct typed queries declared at module scope (Pattern C —
// variant dispatch). The denominator's `MAX(commit_count, p.count)`
// clamps the ratios to (0, 1] — see the doc on `buildCoChangedFilesSqlNamed`.

export function getCoChangedFiles(
  qb: QueryBuilder,
  filePath: string,
  options: {
    limit?: number;
    minCount?: number;
    minJaccard?: number;
    minAnchorRatio?: number;
  } = {},
): Array<{ path: string; count: number; jaccard: number; anchorRatio: number }> {
  // anchorRatio = count / anchor.commit_count: "fraction of anchor's
  // commits that also touched the partner". Asymmetric — pairs where
  // the partner is a high-churn hub (e.g. routes.go with 50+ commits)
  // get diluted by symmetric Jaccard but score high on anchorRatio.
  // OR-gate with jaccard so callers get both signals.
  const limit = options.limit ?? CO_CHANGE_DEFAULT_LIMIT;
  const minCount = options.minCount ?? CO_CHANGE_DEFAULT_MIN_COUNT;
  const minJaccard = options.minJaccard ?? 0;
  const minAnchorRatio = options.minAnchorRatio ?? 0;

  let rows: z.infer<typeof CoChangedFilesRowSchema>[];
  if (minAnchorRatio > 0) {
    qb.queries.coChangedFilesWithAnchor ??= coChangedFilesWithAnchorQuery(qb.db);
    rows = qb.queries.coChangedFilesWithAnchor.all({
      filePath,
      minCount,
      minJaccard,
      minAnchorRatio,
      limit,
    });
  } else {
    qb.queries.coChangedFilesNoAnchor ??= coChangedFilesNoAnchorQuery(qb.db);
    rows = qb.queries.coChangedFilesNoAnchor.all({
      filePath,
      minCount,
      minJaccard,
      limit,
    });
  }
  return rows.map((r) => ({
    path: r.path,
    count: r.count,
    jaccard: r.jaccard ?? 0,
    anchorRatio: r.anchor_ratio ?? 0,
  }));
}
