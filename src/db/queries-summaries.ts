/**
 * Per-symbol summary queries.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain summary helpers as direct members. The functions
 * read / write the `symbol_summaries` table (and cascade-touch
 * `symbol_embeddings` + the vec0 mirror in `pruneOrphanSummaries`)
 * via the `@internal`-tagged `db` and `vecLoaded` fields on the
 * parent `QueryBuilder`.
 */

import { z } from 'zod';
import type { Node } from '../types.js';
import { type QueryBuilder, type NodeRow, rowToNode } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { nodeExistsQuery } from './queries-embeddings.js';
import { compactVecTables } from './vec-helpers.js';

/**
 * Get every symbol whose body is meaningful enough to summarise and
 * whose existing docstring (if any) is shorter than `docThreshold`
 * chars. Sorted by file_path so callers iterating in order can warm
 * the file-content cache.
 */
/** Filter thresholds for {@link getSummarizableNodes}. The body-line
 *  floor is kind-specific (routes need a lower floor — see
 *  `MIN_BODY_LINES_BY_KIND` in `src/llm/summarizer.ts`); kinds not in
 *  the map use {@link defaultMinBodyLines}. */
interface SummarizableFilter {
  minBodyLinesByKind: ReadonlyMap<string, number>;
  defaultMinBodyLines: number;
  docCharThreshold: number;
}

export function getSummarizableNodes(qb: QueryBuilder, kinds: ReadonlySet<string>, filter: SummarizableFilter): Node[] {
  const { minBodyLinesByKind, defaultMinBodyLines, docCharThreshold } = filter;
  if (kinds.size === 0) return [];
  // Per-kind floors are applied server-side via a correlated lookup
  // into `json_each(@minBodyByKind)` — replaces a hand-built
  // `CASE kind WHEN ? THEN ? ...` of variable arm count. Order:
  // most-recently-updated FIRST so the agent's `similar` / `ask`
  // queries on new code start working sooner.
  qb.queries.summarizableNodes ??= summarizableNodesQuery(qb.db);
  const rows = qb.queries.summarizableNodes.all({
    kinds: JSON.stringify([...kinds]),
    minBodyByKind: JSON.stringify(Object.fromEntries(minBodyLinesByKind)),
    defaultMinBodyLines,
    docCharThreshold,
  });
  return rows.map(rowToNode);
}

/**
 * Count nodes the next `summarize` pass would actually generate for —
 * candidate set per {@link getSummarizableNodes} MINUS those already
 * linked to a row in `summary_refs`. The status lens uses this to
 * report a pending count that drops to 0 once every eligible node has
 * a summary, instead of staying inflated by Tier-1 cache-hit no-ops
 * that summarize iterates over but doesn't regenerate.
 */
export function countPendingSummarizable(
  qb: QueryBuilder,
  kinds: ReadonlySet<string>,
  filter: SummarizableFilter,
): number {
  const { minBodyLinesByKind, defaultMinBodyLines, docCharThreshold } = filter;
  if (kinds.size === 0) return 0;
  qb.queries.countPendingSummarizable ??= countPendingSummarizableQuery(qb.db);
  const row = qb.queries.countPendingSummarizable.get({
    kinds: JSON.stringify([...kinds]),
    minBodyByKind: JSON.stringify(Object.fromEntries(minBodyLinesByKind)),
    defaultMinBodyLines,
    docCharThreshold,
  });
  return row?.c ?? 0;
}

/**
 * Get the row count from any table via a COUNT(*) query.
 *
 * Pattern D: per-table-name cache of {@link tableCountQueryFor} factories
 * (one prepared statement per table name). Only two table names ever flow
 * through here (`embedding_refs`, `summary_refs`) so the cache stays small.
 * @internal
 */
function getTableCount(qb: QueryBuilder, tableName: string): number {
  const q = getTableCountQuery(qb, tableName);
  return q.get({})?.c ?? 0;
}

const tableCountQueriesByName = new WeakMap<QueryBuilder, Map<string, TypedQuery<Record<string, never>, SingleCRow>>>();
function getTableCountQuery(qb: QueryBuilder, tableName: string): TypedQuery<Record<string, never>, SingleCRow> {
  let perQb = tableCountQueriesByName.get(qb);
  if (!perQb) {
    perQb = new Map();
    tableCountQueriesByName.set(qb, perQb);
  }
  let q = perQb.get(tableName);
  if (!q) {
    q = tableCountQueryFor(tableName)(qb.db);
    perQb.set(tableName, q);
  }
  return q;
}
function tableCountQueryFor(tableName: string) {
  return defineQuery({
    sql: `SELECT COUNT(*) AS c FROM ${tableName}`,
    params: NoParamsSchema,
    row: SingleCRowSchema,
  });
}

/** Per-phase breakdown of summary coverage. Populated by the
 *  summary pipeline phases (structural / neighbor-propagate / LLM)
 *  plus an off-bucket count of nodes the summarizer SKIPS by design
 *  (body too short per `MIN_BODY_LINES_BY_KIND`). The denominator in
 *  `getSummaryCoverage` includes those skipped nodes — without this
 *  breakdown an agent can't tell whether the gap is "pending work"
 *  or "by-design floor". */
export interface SummaryBreakdown {
  /** Rows tagged `model='structural:v*'` — deterministic synthesis. */
  structural: number;
  /** Rows tagged `model='neighbor:v*'` — vec0 top-1 neighbour copy. */
  neighborProp: number;
  /** All other rows — i.e. true LLM-generated summaries. */
  llm: number;
  /** Nodes that would have been summarizer candidates if not for the
   *  body-line floor — short body AND no adequate docstring. Nodes
   *  excluded solely by the docstring threshold are NOT counted here;
   *  they're already covered by their own docstrings. */
  skippedByFloor: number;
}

/**
 * Per-phase breakdown of `symbol_summaries` rows by `model` family
 * plus the count of summary-eligible nodes intentionally skipped by
 * the body-line floor. Used by `cartograph_status({summaryBreakdown:
 * true})` to disambiguate "pending work" from "by-design floor"
 * gaps in the coverage ratio.
 *
 * Family rules:
 *   - `model LIKE 'structural:%'`  → structural phase
 *   - `model LIKE 'neighbor:%'`    → embed-propagation phase
 *   - everything else              → LLM phase
 *
 * `skippedByFloor` counts nodes that would have been summarizer
 * candidates *if not for the body-line floor* — short body AND no
 * adequate docstring. It uses the body-floor negation of
 * {@link getSummarizableNodes}'s predicate plus the same docstring
 * threshold, so nodes already covered by their own docstrings are
 * NOT double-attributed to "skipped-by-floor".
 *
 * The breakdown does NOT sum to `getSummaryCoverage().total`: there's
 * a fourth bucket (body-eligible nodes whose docstring is already
 * adequate) that the summarizer also skips, but it's not a coverage
 * gap so we don't surface it. Math:
 *   `total = covered + pending + skippedByFloor + (alreadyDocumented)`
 */
export function getSummaryBreakdown(
  qb: QueryBuilder,
  kinds: ReadonlySet<string>,
  filter: SummarizableFilter,
): SummaryBreakdown {
  const breakdown: SummaryBreakdown = { structural: 0, neighborProp: 0, llm: 0, skippedByFloor: 0 };

  // Per-model-family counts — group everything in one pass and
  // bucket on the read side so we don't issue three near-identical
  // SELECTs against the same view.
  qb.queries.summaryModelCounts ??= summaryModelCountsQuery(qb.db);
  const modelRows = qb.queries.summaryModelCounts.all({});
  for (const r of modelRows) {
    const model = r.model ?? '';
    if (model.startsWith('structural:')) breakdown.structural += r.c;
    else if (model.startsWith('neighbor:')) breakdown.neighborProp += r.c;
    else breakdown.llm += r.c;
  }

  // Skipped-by-floor: eligible-kind nodes whose body is shorter than
  // the per-kind floor AND whose docstring isn't already adequate
  // (default applies to kinds not in the map). Both predicates match
  // `getSummarizableNodes` exactly — the body-floor inequality is
  // simply negated (>= becomes <) and the docstring predicate is
  // reused verbatim — so a node here is one the summarizer would have
  // generated for if not for the floor.
  const { minBodyLinesByKind, defaultMinBodyLines, docCharThreshold } = filter;
  if (kinds.size > 0) {
    qb.queries.countSkippedByFloor ??= countSkippedByFloorQuery(qb.db);
    const row = qb.queries.countSkippedByFloor.get({
      kinds: JSON.stringify([...kinds]),
      minBodyByKind: JSON.stringify(Object.fromEntries(minBodyLinesByKind)),
      defaultMinBodyLines,
      docCharThreshold,
    });
    breakdown.skippedByFloor = row?.c ?? 0;
  }
  return breakdown;
}

/**
 * Snapshot orphan embedding rowids (if vec is loaded), delete orphan
 * embeddings from the database, and mirror the deletions to all active
 * vec_symbol_embeddings_* tables. Returns the count delta so the caller
 * can report how many embeddings were reaped.
 *
 * Called within {@link pruneOrphanSummaries} transaction.
 * @internal
 */
function snapshotAndPruneOrphanEmbeddings(qb: QueryBuilder): number {
  const embeddingsBefore = getTableCount(qb, 'embedding_refs');

  // Design C (migration 050): embeddings live in embedding_refs +
  // embedding_store. Orphan refs (node deleted) get explicitly pruned;
  // the store row stays for revert/rename reuse unless its last ref
  // pointed there (currently we keep all store rows — see migration
  // 049 docstring on GC).
  //
  // Snapshot the embedding_store rowids that NO refs point to AFTER
  // the orphan-refs sweep, so we can mirror the sweep into vec0 (which
  // has no FK). Tracks rowids of store rows that become unreachable.
  let orphanRowids: Array<number | bigint> = [];
  if (qb.vecLoaded) {
    qb.queries.orphanEmbeddingStoreRowids ??= orphanEmbeddingStoreRowidsQuery(qb.db);
    orphanRowids = qb.queries.orphanEmbeddingStoreRowids.all({}).map((row) => row.r);
  }

  // Prune orphan refs (node deleted).
  qb.db.exec('DELETE FROM embedding_refs WHERE node_id NOT IN (SELECT id FROM nodes)');

  // vec0 has no FK — sweep the orphans we snapshotted above.
  if (qb.vecLoaded && orphanRowids.length > 0) {
    mirrorOrphanDeletionsToVec(qb, orphanRowids);
  }

  const embeddingsAfter = getTableCount(qb, 'embedding_refs');
  return embeddingsBefore - embeddingsAfter;
}

/**
 * Garbage-collect summary rows whose `node_id` no longer exists in
 * `nodes`. These accumulate across `--force` re-indexes when a symbol
 * gets a new node_id (line shift, file move, or extraction-version
 * bump). The `summarizeAll` content-hash fallback reclaims them onto
 * the new node_id when the body matches, but rows that nobody claimed
 * stick around forever otherwise — which inflates the row count,
 * confuses `Summary coverage` reporting, and slows the
 * `(content_hash, model)` index over time.
 *
 * Since migration 033, `symbol_embeddings` FK targets `nodes(id)`
 * directly (not `symbol_summaries`), so deleting a summary no longer
 * cascades to its embedding. Migration 050 (Design C) further moved
 * the storage to `embedding_refs` + `embedding_store`. This function
 * deletes orphan `embedding_refs` rows whose `node_id` is gone; the
 * `embedding_store` rows they pointed at are KEPT on disk for
 * revert/rename reuse (see migration 049 docstring on GC).
 * `directory_summaries` is keyed by dir_path (not node_id) and is
 * untouched here.
 *
 * Safe to call AFTER `summarizeAll` completes — by then any genuinely
 * relocated summaries have been re-attached to their new node_ids
 * via the content-hash fallback. Calling DURING summarizeAll would
 * race the reclaim and lose cache hits.
 *
 * NOT called in no-summarize configurations: orphans there might still be
 * legitimately reclaimable by a FUTURE summarize-enabled session (the
 * by-content-hash fallback inside summarizeAll is only triggered when
 * there's a summarize backend to call when reclaim misses). Pruning during
 * a no-summarize-only run would force the next summarize session to regenerate
 * those summaries from scratch. Acceptable cost (storage growth in
 * configs that never gain a summarize backend) for correctness in the more
 * common case.
 */
export function pruneOrphanSummaries(qb: QueryBuilder): { summariesDeleted: number; embeddingsDeleted: number } {
  // All counts and DELETEs share one transaction so the before/after
  // snapshot is atomic. Without this, a concurrent process writing or
  // deleting embeddings between the SELECT and the DELETE would produce
  // a wrong `embeddingsDeleted` count.
  return qb.db.transaction(() => {
    const summariesBefore = getTableCount(qb, 'summary_refs');

    // Design C: prune orphan refs whose node was deleted. The
    // summary_store rows they pointed at remain (kept for revert/rename
    // reuse — see migration 049 docstring on GC).
    qb.db.exec('DELETE FROM summary_refs WHERE node_id NOT IN (SELECT id FROM nodes)');

    const embeddingsDeleted = snapshotAndPruneOrphanEmbeddings(qb);

    // F-U defense-in-depth: migration 062 added a FK ON DELETE CASCADE
    // to role_assignments, so future dead-node sweeps will keep this
    // table clean automatically. The explicit DELETE here catches any
    // regression where the FK is lost (table rebuild that forgets to
    // restore it) or runs on a partial-schema fixture without the FK.
    // Cheap when there are no orphans (NOT IN over an indexed PK).
    qb.db.exec('DELETE FROM role_assignments WHERE node_id NOT IN (SELECT id FROM nodes)');

    const summariesAfter = getTableCount(qb, 'summary_refs');

    return {
      summariesDeleted: summariesBefore - summariesAfter,
      embeddingsDeleted,
    };
  })();
}

/** Milliseconds in a day. Shared by the admin handler + CLI so the
 *  prune-store age threshold is converted from days the same way
 *  everywhere. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default freshness window for `admin prune-store` when the caller
 *  omits `--max-age-days`. 30 days balances "long enough that
 *  revert/rename reuse stays useful" with "short enough that store
 *  bloat is bounded". */
export const PRUNE_STORE_DEFAULT_DAYS = 30;

/**
 * Evict cold orphan rows from the content-addressed *_store tables.
 *
 * "Orphan" = no surviving `*_refs` row points at the store entry.
 * "Cold"   = the store row's `last_ref_at` (added in migration 053
 *            and bumped by triggers on every ref insert / update)
 *            is older than `maxAgeMs` ago.
 *
 * Active store rows (any row that still has at least one ref pointing
 * at it) are NEVER evicted regardless of age. Recent orphans (within
 * the freshness window) are kept too — they're the revert/rename
 * reuse pool. Only the cold-AND-orphan intersection drops.
 *
 * Vec0 mirror: each evicted embedding_store row's rowid is removed
 * from every `vec_symbol_embeddings_<dim>` table to keep HNSW /
 * vec0 search consistent. Same machinery as
 * {@link snapshotAndPruneOrphanEmbeddings} but driven by the cold
 * predicate rather than dead-node FK cascade.
 *
 * Wrapped in one transaction so the snapshot used to mirror vec0
 * matches the rows actually deleted from `embedding_store`.
 */
/**
 * Minimum plausible `last_ref_at` for an age-gated eviction.
 *
 * Store rows written before migration 053 (which added the
 * `last_ref_at` column + trigger) carry the column's DEFAULT of 0 —
 * epoch-0, January 1970. Any `cutoff = Date.now() - maxAgeMs`
 * satisfies `0 <= cutoff`, so a large `maxAgeDays` (e.g. 9999) would
 * silently sweep all pre-migration orphan rows even though the intent
 * is "keep everything recent."
 *
 * Rows with `last_ref_at < LAST_REF_AT_PLAUSIBLE_FLOOR` are treated as
 * "no real timestamp" and are excluded from age-based eviction UNLESS
 * `maxAgeMs === 0` (the documented "evict every orphan immediately"
 * escape hatch).
 *
 * Value: 1 January 2000 00:00:00 UTC in milliseconds. Any real
 * `last_ref_at` written by cartograph at runtime is at least as recent
 * as when the user first ran the tool (post-2000), so this floor safely
 * excludes only the epoch-0 default and any other implausibly old value.
 *
 * Backfill note: rows with `last_ref_at = 0` represent orphans that were
 * never touched after the migration that added the column. A future
 * migration could back-fill them to `detected_at` or another proxy;
 * until then the plausibility floor is the correct defence.
 */
/** 1 January 2000 UTC, as epoch-milliseconds — see doc above. Written as
 *  a `Date.UTC` expression rather than a bare 12-digit literal so the
 *  value is self-evidently the date the doc names. */
const LAST_REF_AT_PLAUSIBLE_FLOOR = Date.UTC(2000, 0, 1);

export function pruneOrphanStoreRows(
  qb: QueryBuilder,
  options: { maxAgeMs: number },
): { summariesPruned: number; embeddingsPruned: number; cutoffMs: number } {
  const cutoff = Date.now() - Math.max(0, options.maxAgeMs);
  // When maxAgeMs > 0, add a plausibility guard: only evict rows with a
  // real `last_ref_at` (>= LAST_REF_AT_PLAUSIBLE_FLOOR). Rows that carry
  // the epoch-0 default (written before migration 053 added the trigger)
  // are NOT treated as "older than the window" — they have no real
  // timestamp and should not be swept by a large-window prune call.
  // When maxAgeMs === 0 ("evict every orphan now"), skip the floor check
  // so the operator can explicitly clear all orphans including epoch-0 rows.
  //
  // Pattern C (variant dispatch) — two static typed queries per site
  // (with-floor / no-floor) selected at runtime by `maxAgeMs === 0`.
  const useFloor = options.maxAgeMs !== 0;

  const result = qb.db.transaction(() => {
    // Snapshot the embedding_store rowids about to disappear so we
    // can mirror the deletions into vec0 after the SQL DELETE runs.
    const orphanRowids = qb.vecLoaded ? selectOrphanEmbeddingStoreRowids(qb, useFloor, cutoff) : [];

    const deletedSummaryRows = (() => {
      if (useFloor) {
        let query = qb.queries.deleteOrphanSummaryStoreWithFloor;
        if (!query) {
          query = deleteOrphanSummaryStoreWithFloorQuery(qb.db);
          qb.queries.deleteOrphanSummaryStoreWithFloor = query;
        }
        return query.all({
          cutoff,
          floor: LAST_REF_AT_PLAUSIBLE_FLOOR,
        });
      }
      let query = qb.queries.deleteOrphanSummaryStoreAllAge;
      if (!query) {
        query = deleteOrphanSummaryStoreAllAgeQuery(qb.db);
        qb.queries.deleteOrphanSummaryStoreAllAge = query;
      }
      return query.all({ cutoff });
    })();

    const deletedEmbeddingRows = (() => {
      if (useFloor) {
        let query = qb.queries.deleteOrphanEmbeddingStoreWithFloor;
        if (!query) {
          query = deleteOrphanEmbeddingStoreWithFloorQuery(qb.db);
          qb.queries.deleteOrphanEmbeddingStoreWithFloor = query;
        }
        return query.all({
          cutoff,
          floor: LAST_REF_AT_PLAUSIBLE_FLOOR,
        });
      }
      let query = qb.queries.deleteOrphanEmbeddingStoreAllAge;
      if (!query) {
        query = deleteOrphanEmbeddingStoreAllAgeQuery(qb.db);
        qb.queries.deleteOrphanEmbeddingStoreAllAge = query;
      }
      return query.all({ cutoff });
    })();

    if (qb.vecLoaded && orphanRowids.length > 0) {
      mirrorOrphanDeletionsToVec(qb, orphanRowids);
    }

    return {
      summariesPruned: deletedSummaryRows.length,
      embeddingsPruned: deletedEmbeddingRows.length,
      cutoffMs: cutoff,
    };
  })();

  // vec0 row deletion only marks chunk slots free — it never releases
  // the `<table>_vector_chunks00` shadow-table pages. After a bulk
  // eviction the vec0 shadow tables keep their full pre-prune disk
  // footprint (the dominant cost on a real prune — far larger than
  // embedding_store itself). Drop+rebuild each vec0 table from the
  // now-pruned source so the freed space becomes a real freelist the
  // caller's reclaim step can return to the OS. Runs OUTSIDE the
  // prune transaction: vec0 DROP/CREATE is DDL on a virtual table and
  // is cleaner committed on its own. Cheap when nothing was evicted.
  if (qb.vecLoaded && result.embeddingsPruned > 0) {
    compactVecTables(qb.db, qb.vecLoaded);
  }

  return result;
}

/**
 * Sweep orphan rowids out of every live `vec_symbol_embeddings_<dim>`
 * table. Called from {@link pruneOrphanSummaries} after the FK
 * cascade has cleared the matching rows from `symbol_embeddings`.
 *
 * Errors per-row are swallowed (the row may already be gone via a
 * concurrent prune) — pulled out of the prune transaction so the
 * inner double-for-loop doesn't sit 4-deep under the if-vecLoaded
 * guard plus the transaction closure.
 */
function mirrorOrphanDeletionsToVec(qb: QueryBuilder, orphanRowids: ReadonlyArray<number | bigint>): void {
  qb.queries.vecEmbeddingTables ??= vecEmbeddingTablesQuery(qb.db);
  const tables = qb.queries.vecEmbeddingTables.all({}).filter((t) => /^vec_symbol_embeddings_\d+$/.test(t.name));
  for (const { name } of tables) {
    deleteOrphanRowsFromVecTable(qb, name, orphanRowids);
  }
}

/** Delete each `orphanRowids` entry from one `vec_symbol_embeddings_<dim>`
 *  table; per-row errors are swallowed (the row may already be gone
 *  via a concurrent prune). Pulled out so {@link mirrorOrphanDeletionsToVec}
 *  doesn't nest the per-row try/catch inside the per-table loop.
 *
 *  Pattern D: per-table-name cache of {@link deleteVecRowByRowidQueryFor}
 *  factories — one prepared statement per `vec_symbol_embeddings_<dim>`
 *  table (typically just 1-2 dims per project). */
function deleteOrphanRowsFromVecTable(
  qb: QueryBuilder,
  tableName: string,
  orphanRowids: ReadonlyArray<number | bigint>,
): void {
  const q = getDeleteVecRowByRowidQuery(qb, tableName);
  for (const r of orphanRowids) {
    try {
      q.run({ rowid: typeof r === 'bigint' ? r : BigInt(r) });
    } catch {
      /* row already gone */
    }
  }
}

const deleteVecRowByRowidQueriesByName = new WeakMap<QueryBuilder, Map<string, TypedQuery<{ rowid: bigint }, never>>>();
function getDeleteVecRowByRowidQuery(qb: QueryBuilder, tableName: string): TypedQuery<{ rowid: bigint }, never> {
  let perQb = deleteVecRowByRowidQueriesByName.get(qb);
  if (!perQb) {
    perQb = new Map();
    deleteVecRowByRowidQueriesByName.set(qb, perQb);
  }
  let q = perQb.get(tableName);
  if (!q) {
    q = deleteVecRowByRowidQueryFor(tableName)(qb.db);
    perQb.set(tableName, q);
  }
  return q;
}
function deleteVecRowByRowidQueryFor(tableName: string) {
  return defineQuery({
    sql: `DELETE FROM ${tableName} WHERE rowid = @rowid`,
    params: DeleteVecRowParamsSchema,
    row: z.never(),
  });
}

/**
 * Read a single symbol's cached summary, or null if none exists.
 */
export function getSymbolSummary(
  qb: QueryBuilder,
  nodeId: string,
): { summary: string; contentHash: string; model: string } | null {
  qb.queries.getSymbolSummary ??= getSymbolSummaryQuery(qb.db);
  const row = qb.queries.getSymbolSummary.get({ nodeId });
  if (!row) return null;
  return { summary: row.summary, contentHash: row.content_hash, model: row.model };
}

/**
 * Find a cached summary by content_hash + model, regardless of which
 * node_id originally produced it. Used when a symbol moves files,
 * shifts lines, or otherwise gets a fresh node_id but the body
 * itself is unchanged — the summary text is still valid and we'd
 * rather copy it onto the new node_id than burn another LLM call.
 *
 * On hash collision (two distinct symbols with identical
 * body+signature) we prefer the most recently generated summary
 * via ORDER BY generated_at DESC. The collision is semantically
 * harmless — identical bodies yield identical summaries — but a
 * stable choice keeps test output deterministic across SQLite
 * page-layout shifts.
 *
 * Returns the originating nodeId so callers can correlate / diagnose.
 */
export function getSummaryByContentHash(
  qb: QueryBuilder,
  contentHash: string,
  model: string,
): { summary: string; nodeId: string } | null {
  qb.queries.getSummaryByContentHash ??= getSummaryByContentHashQuery(qb.db);
  const row = qb.queries.getSummaryByContentHash.get({ contentHash, model });
  if (!row) return null;
  return { summary: row.summary, nodeId: row.node_id };
}

export interface SymbolDescription {
  /** The actual description text (LLM summary, extractor docstring, or test-name aggregate). */
  text: string;
  /** Which corpus the text came from. Surfaces the cascade fallback to consumers. */
  source: 'summary' | 'docstring' | 'tests';
}

/**
 * Fetch summaries and docstrings in one chunk; populate the output map
 * with nodes that have either (summary preferred). Returns the set of
 * covered node IDs so the caller can identify missing ones.
 * @internal
 */
function fetchSummariesAndDocstrings(
  qb: QueryBuilder,
  chunk: readonly string[],
  out: Map<string, SymbolDescription>,
): Set<string> {
  qb.queries.fetchSummariesAndDocstrings ??= fetchSummariesAndDocstringsQuery(qb.db);
  const rows = qb.queries.fetchSummariesAndDocstrings.all({ nodeIds: JSON.stringify(chunk) });

  const covered = new Set<string>();
  for (const r of rows) {
    if (r.summary) {
      out.set(r.node_id, { text: r.summary, source: 'summary' });
      covered.add(r.node_id);
    } else if (r.docstring) {
      out.set(r.node_id, { text: r.docstring, source: 'docstring' });
      covered.add(r.node_id);
    }
  }
  return covered;
}

/**
 * Bulk fetch human-readable descriptions for a set of node IDs.
 * Cascade:
 *   1. `symbol_summaries.summary` (non-empty) wins.
 *   2. Node's `docstring` (non-empty) is next.
 *   3. Test-name aggregate via {@link getTestDerivedDescriptions} for
 *      the remainder.
 * Nodes with none of the three remain absent from the map.
 *
 * Returns the source so consumers can surface "via summary" / "via
 * docstring" / "via tests" provenance when useful (e.g. semantic-search
 * formatting, agent-facing reports). Empty strings count as absent on
 * either side.
 */
export function getSymbolDescriptions(qb: QueryBuilder, nodeIds: readonly string[]): Map<string, SymbolDescription> {
  const out = new Map<string, SymbolDescription>();
  if (nodeIds.length === 0) return out;

  const CHUNK = 500;
  const allCovered = new Set<string>();

  // Tier 1-2: summaries and docstrings (chunked).
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    const covered = fetchSummariesAndDocstrings(qb, chunk, out);
    for (const id of covered) allCovered.add(id);
  }

  // Tier 3: test-derived for nodes with neither summary nor docstring.
  const missing = nodeIds.filter((id) => !allCovered.has(id));
  if (missing.length > 0) {
    const testDerived = getTestDerivedDescriptions(qb, missing);
    for (const [nodeId, text] of testDerived) {
      out.set(nodeId, { text, source: 'tests' });
    }
  }

  return out;
}

/** Maximum number of test descriptions to concatenate per symbol. */
const TEST_DESC_TOP_K = 3;
/** Maximum character length of a concatenated test-derived description. */
const TEST_DESC_MAX_CHARS = 200;

/**
 * For each nodeId, find tests covering its containing file (via the
 * `tests` edge, test_file → subject_file orientation), pull the top-K
 * test descriptions ranked by FTS relevance to the symbol name, and
 * concatenate up to 3 into a ≤200-char string. Map omits nodes with
 * zero matching test descriptions.
 *
 * The query is bulk: one round of file-resolution and one round of
 * test_names lookup per chunk of 500 nodes. Per-symbol FTS ranking is
 * done in JS against the pre-fetched candidate descriptions.
 */
export function getTestDerivedDescriptions(qb: QueryBuilder, nodeIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (nodeIds.length === 0) return out;

  const CHUNK = 500;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    processTestDerivedChunk(qb, chunk, out);
  }
  return out;
}

/**
 * Group nodes by file_path for efficient test-file lookup.
 * @internal
 */
function groupNodesByFile(
  nodeRows: Array<{ node_id: string; file_path: string; name: string }>,
): Map<string, Array<{ node_id: string; name: string }>> {
  const byFile = new Map<string, Array<{ node_id: string; name: string }>>();
  for (const r of nodeRows) {
    let bucket = byFile.get(r.file_path);
    if (!bucket) {
      bucket = [];
      byFile.set(r.file_path, bucket);
    }
    bucket.push({ node_id: r.node_id, name: r.name });
  }
  return byFile;
}

/**
 * Build a map from subject file paths to their covering test file paths.
 * @internal
 */
function buildTestPathsMap(qb: QueryBuilder, subjectPaths: readonly string[]): Map<string, Set<string>> {
  qb.queries.buildTestPathsMap ??= buildTestPathsMapQuery(qb.db);
  const testFileRows = qb.queries.buildTestPathsMap.all({ subjectPaths: JSON.stringify(subjectPaths) });

  const testPathsForSubject = new Map<string, Set<string>>();
  for (const r of testFileRows) {
    let s = testPathsForSubject.get(r.subj_path);
    if (!s) {
      s = new Set();
      testPathsForSubject.set(r.subj_path, s);
    }
    s.add(r.test_path);
  }
  return testPathsForSubject;
}

/** Arguments for {@link rankTestDescriptions}. */
interface RankTestDescriptionsArgs {
  qb: QueryBuilder;
  symbolName: string;
  testPaths: readonly string[];
  allTestNames: ReadonlyArray<{ id: number; description: string }>;
}

/**
 * Rank test descriptions by FTS relevance to a symbol name, with fallback to
 * unranked subset. Returns up to TEST_DESC_TOP_K descriptions.
 * @internal
 */
function rankTestDescriptions(args: RankTestDescriptionsArgs): Array<{ description: string }> {
  const { qb, symbolName, testPaths, allTestNames } = args;
  const ftsQuery = escapeFts5Phrase(symbolName);
  try {
    qb.queries.rankTestDescriptionsByFts ??= rankTestDescriptionsByFtsQuery(qb.db);
    const ftsHits = qb.queries.rankTestDescriptionsByFts.all({
      ftsQuery,
      testPaths: JSON.stringify(testPaths),
      limit: TEST_DESC_TOP_K,
    });
    // Zero FTS hits: fall back to unranked subset.
    return ftsHits.length > 0 ? ftsHits : allTestNames.slice(0, TEST_DESC_TOP_K);
  } catch {
    // FTS5 MATCH threw — fall back to unranked.
    return allTestNames.slice(0, TEST_DESC_TOP_K);
  }
}

/**
 * Truncate text to a maximum character length, appending an ellipsis if needed.
 * @internal
 */
function truncateToMaxChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…';
}

/**
 * Concatenate ranked test descriptions into a single string, truncating
 * to TEST_DESC_MAX_CHARS if needed.
 * @internal
 */
function formatTestDescription(ranked: ReadonlyArray<{ description: string }>): string | null {
  if (ranked.length === 0) return null;

  const joined = ranked.map((r) => r.description).join('; ');
  return truncateToMaxChars(joined, TEST_DESC_MAX_CHARS);
}

interface ProcessSubjectWithTestsArgs {
  qb: QueryBuilder;
  symbols: Array<{ node_id: string; name: string }>;
  testPaths: Set<string>;
  out: Map<string, string>;
}

/**
 * Fetch test names for a subject file and rank descriptions for each symbol.
 * @internal
 */
function processSubjectWithTests({ qb, symbols, testPaths, out }: ProcessSubjectWithTestsArgs): void {
  const tpArr = [...testPaths];
  qb.queries.testNamesForPaths ??= testNamesForPathsQuery(qb.db);
  const testNameRows = qb.queries.testNamesForPaths.all({ testPaths: JSON.stringify(tpArr) });

  if (testNameRows.length === 0) return;

  for (const { node_id, name } of symbols) {
    const ranked = rankTestDescriptions({ qb, symbolName: name, testPaths: tpArr, allTestNames: testNameRows });
    const description = formatTestDescription(ranked);
    if (description) {
      out.set(node_id, description);
    }
  }
}

/**
 * Process one chunk of nodeIds for {@link getTestDerivedDescriptions}.
 * Pulled out to keep the loop body legible without deep nesting.
 */
function processTestDerivedChunk(qb: QueryBuilder, chunk: readonly string[], out: Map<string, string>): void {
  // Step 1: resolve node → file_path + name for the whole chunk in one query.
  qb.queries.nodesByIdForChunk ??= nodesByIdForChunkQuery(qb.db);
  const nodeRows = qb.queries.nodesByIdForChunk.all({ nodeIds: JSON.stringify(chunk) });

  if (nodeRows.length === 0) return;

  const byFile = groupNodesByFile(nodeRows);
  const subjectPaths = [...byFile.keys()];
  if (subjectPaths.length === 0) return;

  // Step 2: Build map of subject_path → Set<test_path>.
  const testPathsForSubject = buildTestPathsMap(qb, subjectPaths);
  if (testPathsForSubject.size === 0) return;

  // Step 3-4: For each subject file that has covering tests, process symbols.
  for (const [subjectPath, symbols] of byFile) {
    const testPaths = testPathsForSubject.get(subjectPath);
    if (!testPaths || testPaths.size === 0) continue;
    processSubjectWithTests({ qb, symbols, testPaths, out });
  }
}

/**
 * Escape a raw symbol name for use as an FTS5 phrase query.
 * Wraps the name in double-quotes (FTS5 phrase syntax) after
 * escaping any embedded double-quotes by doubling them, so
 * special FTS5 operators (AND, OR, NOT, NEAR, ^, *, -) inside
 * a symbol name don't break the query.
 */
function escapeFts5Phrase(raw: string): string {
  // Double any existing double-quotes, then wrap in double-quotes
  // to form an FTS5 phrase token.
  return '"' + raw.replaceAll('"', '""') + '"';
}

/**
 * @deprecated Use {@link getSymbolDescriptions} which falls back to
 * docstring when no summary exists. Kept as a summary-only view for
 * the few callers that genuinely need to know whether a SUMMARY
 * specifically (not docstring) is present (e.g. summary-coverage
 * accounting). Not for description rendering — use the cascade.
 */
export function getSymbolSummaries(qb: QueryBuilder, nodeIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (nodeIds.length === 0) return out;
  qb.queries.getSymbolSummariesByIds ??= getSymbolSummariesByIdsQuery(qb.db);
  const rows = qb.queries.getSymbolSummariesByIds.all({
    nodeIds: JSON.stringify([...nodeIds]),
  });
  for (const r of rows) out.set(r.node_id, r.value);
  return out;
}

/** Count nodes in the input set that have true LLM summaries. */
export function countSymbolSummaries(qb: QueryBuilder, nodeIds: readonly string[]): number {
  if (nodeIds.length === 0) return 0;
  qb.queries.getSymbolSummariesByIds ??= getSymbolSummariesByIdsQuery(qb.db);
  return qb.queries.getSymbolSummariesByIds.all({
    nodeIds: JSON.stringify([...nodeIds]),
  }).length;
}

/**
 * Insert or replace a summary. The unique key is `node_id`; the
 * content_hash is the consistency anchor that lets the next pass
 * detect a stale entry and regenerate.
 *
 * Atomic against concurrent node deletion: an explicit `nodeExists`
 * pre-check inside the transaction returns `false` (no-op) when a
 * sync deleted the node between the caller's id capture and this
 * write — instead of an FK constraint error from summary_refs.
 *
 * Why a pre-check instead of `info.changes > 0` on a `WHERE EXISTS`-
 * gated INSERT: under bun:sqlite with the Homebrew libsqlite3 the
 * adapter calls `setCustomSQLite` to (macOS), `sqlite3_changes()`
 * inflates with FTS5 / cascading-trigger writes from adjacent
 * statements, so the INSERT's `changes` no longer cleanly maps to
 * "the outer row was written." Mirrors {@link upsertSymbolEmbedding}.
 */
interface UpsertSymbolSummaryArgs {
  qb: QueryBuilder;
  nodeId: string;
  contentHash: string;
  summary: string;
  model: string;
}

export function upsertSymbolSummary(args: UpsertSymbolSummaryArgs): boolean {
  const { qb, nodeId, contentHash, summary, model } = args;
  // Design C: write to summary_store (deduped by body_hash+model) AND
  // summary_refs (per-node pointer). The legacy `symbol_summaries` VIEW
  // (migration 049) joins these for backward-compat reads.
  const now = Date.now();
  return qb.db.transaction((): boolean => {
    qb.queries.nodeExists ??= nodeExistsQuery(qb.db);
    if (!qb.queries.nodeExists.get({ nodeId })) return false;

    // Store row first — if the (body_hash, model) row already exists
    // (e.g. another node shares the same body), refresh the summary +
    // timestamp. The shared row's text reflects the most recent write.
    qb.queries.upsertSummaryStore ??= upsertSummaryStoreQuery(qb.db);
    qb.queries.upsertSummaryStore.run({ contentHash, model, summary, now });

    qb.queries.upsertSummaryRef ??= upsertSummaryRefQuery(qb.db);
    qb.queries.upsertSummaryRef.run({ nodeId, contentHash, model });
    return true;
  })();
}

/**
 * Stats for `cartograph status`: how much of the index has summaries.
 * `total` counts only nodes that are *eligible* for summarisation —
 * counting parameters/imports/files in the denominator would
 * understate coverage and confuse the user.
 */
export function getSummaryCoverage(
  qb: QueryBuilder,
  kinds?: ReadonlySet<string>,
): { total: number; summarised: number } {
  let total: number;
  if (kinds && kinds.size > 0) {
    // Pattern A: variable IN-list bound via a single JSON-encoded `@kinds`
    // parameter consumed by `json_each` — keeps SQL static for `defineQuery`.
    qb.queries.countNodesByKinds ??= countNodesByKindsQuery(qb.db);
    total = qb.queries.countNodesByKinds.get({ kinds: JSON.stringify([...kinds]) })?.n ?? 0;
  } else {
    qb.queries.countAllNodes ??= countAllNodesQuery(qb.db);
    total = qb.queries.countAllNodes.get({})?.n ?? 0;
  }
  qb.queries.countAllSummaries ??= countAllSummariesQuery(qb.db);
  const summarised = qb.queries.countAllSummaries.get({})?.n ?? 0;
  return { total, summarised };
}

/**
 * Centrality-weighted summary coverage: Σ(centrality × covered) / Σ(centrality)
 * over the eligible kind set. The agent rarely cares whether a leaf
 * helper has a summary; high-centrality "spine" symbols matter much
 * more. Reports the weighted ratio plus the per-bucket counts so the
 * user can see whether the LLM budget is targeting the right slice.
 *
 * Nodes whose `centrality` is NULL (not yet computed, or post-prune
 * gaps) contribute weight 0 and don't bias the ratio. When every
 * eligible node has NULL centrality, total weight is 0 and the
 * function returns `weightedRatio: null` (not 0/0) so callers can
 * distinguish "no centrality data" from "no covered weight".
 *
 * Cascade-aware: a node counts as "covered" if it has a summary OR a
 * docstring of length ≥ docCharThreshold. Defaults match the local-
 * pass eligibility cutoff (20 chars). Pass `coveredDocOnly: false` to
 * count docstrings as not-covered (summary-strict view).
 */
export interface WeightedCoverageOptions {
  /** Char threshold for "decent docstring" counts as covered. */
  docCharThreshold?: number;
  /** When false, only summaries count; docstrings don't. Default true. */
  coveredDocOnly?: boolean;
}

export interface WeightedCoverage {
  /** Σ(covered ? centrality : 0). */
  coveredWeight: number;
  /** Σ(centrality) over eligible nodes. */
  totalWeight: number;
  /** Weighted ratio in [0, 1], or null if totalWeight is 0. */
  weightedRatio: number | null;
  /** Eligible nodes (denominator of the unweighted view). */
  totalNodes: number;
  /** Eligible nodes that have a summary OR (when allowed) a decent docstring. */
  coveredNodes: number;
}

export function getWeightedSummaryCoverage(
  qb: QueryBuilder,
  kinds: ReadonlySet<string>,
  options: WeightedCoverageOptions = {},
): WeightedCoverage {
  const docCharThreshold = options.docCharThreshold ?? 20;
  const coveredDocOnly = options.coveredDocOnly ?? true;
  if (kinds.size === 0) {
    return { coveredWeight: 0, totalWeight: 0, weightedRatio: null, totalNodes: 0, coveredNodes: 0 };
  }
  // Pattern C: variant dispatch — two static queries (coveredDocOnly true/false)
  // with a Pattern-A `json_each(@kinds)` IN-list shared by both.
  const kindsJson = JSON.stringify([...kinds]);
  let row: WeightedCoverageRow | undefined;
  if (coveredDocOnly) {
    qb.queries.weightedSummaryCoverageWithDoc ??= weightedSummaryCoverageWithDocQuery(qb.db);
    row = qb.queries.weightedSummaryCoverageWithDoc.get({ kinds: kindsJson, docCharThreshold });
  } else {
    qb.queries.weightedSummaryCoverageSummaryOnly ??= weightedSummaryCoverageSummaryOnlyQuery(qb.db);
    row = qb.queries.weightedSummaryCoverageSummaryOnly.get({ kinds: kindsJson });
  }
  const totalNodes = row?.total_nodes ?? 0;
  const coveredNodes = row?.covered_nodes ?? 0;
  const totalWeight = row?.total_weight ?? 0;
  const coveredWeight = row?.covered_weight ?? 0;
  return {
    coveredWeight,
    totalWeight,
    weightedRatio: totalWeight > 0 ? coveredWeight / totalWeight : null,
    totalNodes,
    coveredNodes,
  };
}

// ─── Zod schemas + typed query definitions ────────────────────────────────
//
// Phase 2 (2026-05-20) migrated the variable-IN-list call sites to
// {@link defineQuery} via `json_each(@param)` (Pattern A), the two
// `getWeightedSummaryCoverage` doc/summary-only branches via static
// variant dispatch (Pattern C), and the dynamic-table-name sites
// (`getTableCount`, `deleteOrphanRowsFromVecTable`) via per-key
// prepared-statement caches (Pattern D). The per-kind body-floor
// queries (`getSummarizableNodes` / `countPendingSummarizable` /
// `getSummaryBreakdown`'s skipped-by-floor count) use a JSON-object
// join via `json_each(@minBodyByKind)` instead of a computed
// CASE-WHEN clause. `pruneOrphanStoreRows`'s `${ageClause}` variants
// are split into two static typed queries each (with-floor / all-age)
// dispatched on `maxAgeMs === 0` (Pattern C).

const NoParamsSchema = z.object({});

const SummaryModelCountsRowSchema = z.object({
  model: z.string().nullable(),
  c: z.number(),
});
type SummaryModelCountsRow = z.infer<typeof SummaryModelCountsRowSchema>;

const summaryModelCountsQuery = defineQuery({
  sql: 'SELECT model, COUNT(*) AS c FROM symbol_summaries GROUP BY model',
  params: NoParamsSchema,
  row: SummaryModelCountsRowSchema,
});

const OrphanStoreRowidRowSchema = z.object({
  r: z.union([z.number(), z.bigint()]),
});
type OrphanStoreRowidRow = z.infer<typeof OrphanStoreRowidRowSchema>;

const orphanEmbeddingStoreRowidsQuery = defineQuery({
  sql: `SELECT s.rowid AS r FROM embedding_store s
      WHERE NOT EXISTS (
        SELECT 1 FROM embedding_refs r
         WHERE r.body_hash = s.body_hash
           AND r.model = s.model
           AND r.grain = s.grain
      )`,
  params: NoParamsSchema,
  row: OrphanStoreRowidRowSchema,
});

const VecEmbeddingTableRowSchema = z.object({ name: z.string() });
type VecEmbeddingTableRow = z.infer<typeof VecEmbeddingTableRowSchema>;

const vecEmbeddingTablesQuery = defineQuery({
  sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_symbol_embeddings_%'",
  params: NoParamsSchema,
  row: VecEmbeddingTableRowSchema,
});

const GetSymbolSummaryRowSchema = z.object({
  summary: z.string(),
  content_hash: z.string(),
  model: z.string(),
});
type GetSymbolSummaryRow = z.infer<typeof GetSymbolSummaryRowSchema>;

const GetSymbolSummaryParamsSchema = z.object({ nodeId: z.string() });
type GetSymbolSummaryParams = z.infer<typeof GetSymbolSummaryParamsSchema>;

const getSymbolSummaryQuery = defineQuery({
  sql: 'SELECT summary, content_hash, model FROM symbol_summaries WHERE node_id = @nodeId',
  params: GetSymbolSummaryParamsSchema,
  row: GetSymbolSummaryRowSchema,
});

const GetSummaryByContentHashRowSchema = z.object({
  node_id: z.string(),
  summary: z.string(),
});
type GetSummaryByContentHashRow = z.infer<typeof GetSummaryByContentHashRowSchema>;

const GetSummaryByContentHashParamsSchema = z.object({
  contentHash: z.string(),
  model: z.string(),
});
type GetSummaryByContentHashParams = z.infer<typeof GetSummaryByContentHashParamsSchema>;

const getSummaryByContentHashQuery = defineQuery({
  sql: `SELECT node_id, summary FROM symbol_summaries
       WHERE content_hash = @contentHash AND model = @model
       ORDER BY generated_at DESC LIMIT 1`,
  params: GetSummaryByContentHashParamsSchema,
  row: GetSummaryByContentHashRowSchema,
});

const UpsertSummaryStoreParamsSchema = z.object({
  contentHash: z.string(),
  model: z.string(),
  summary: z.string(),
  now: z.number(),
});
type UpsertSummaryStoreParams = z.infer<typeof UpsertSummaryStoreParamsSchema>;

const upsertSummaryStoreQuery = defineQuery({
  sql: `INSERT INTO summary_store (body_hash, model, summary, generated_at)
     VALUES (@contentHash, @model, @summary, @now)
     ON CONFLICT(body_hash, model) DO UPDATE SET
       summary = excluded.summary,
       generated_at = excluded.generated_at`,
  params: UpsertSummaryStoreParamsSchema,
  row: z.never(),
});

const UpsertSummaryRefParamsSchema = z.object({
  nodeId: z.string(),
  contentHash: z.string(),
  model: z.string(),
});
type UpsertSummaryRefParams = z.infer<typeof UpsertSummaryRefParamsSchema>;

const upsertSummaryRefQuery = defineQuery({
  sql: `INSERT INTO summary_refs (node_id, body_hash, model)
     SELECT @nodeId, @contentHash, @model
     WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @nodeId)
     ON CONFLICT(node_id) DO UPDATE SET
       body_hash = excluded.body_hash,
       model = excluded.model`,
  params: UpsertSummaryRefParamsSchema,
  row: z.never(),
});

const SingleNRowSchema = z.object({ n: z.number() });
type SingleNRow = z.infer<typeof SingleNRowSchema>;

const SingleCRowSchema = z.object({ c: z.number() });
type SingleCRow = z.infer<typeof SingleCRowSchema>;

const countAllNodesQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS n FROM nodes',
  params: NoParamsSchema,
  row: SingleNRowSchema,
});

const countAllSummariesQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS n FROM symbol_summaries',
  params: NoParamsSchema,
  row: SingleNRowSchema,
});

// Pattern A: variable IN-list of node kinds via `json_each(@kinds)`.
const CountNodesByKindsParamsSchema = z.object({ kinds: z.string() });
type CountNodesByKindsParams = z.infer<typeof CountNodesByKindsParamsSchema>;

const countNodesByKindsQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n FROM nodes
      WHERE kind IN (SELECT value FROM json_each(@kinds))`,
  params: CountNodesByKindsParamsSchema,
  row: SingleNRowSchema,
});

// Pattern A: summary + docstring fetch for a chunked node-id list.
const FetchSummariesAndDocstringsParamsSchema = z.object({ nodeIds: z.string() });
type FetchSummariesAndDocstringsParams = z.infer<typeof FetchSummariesAndDocstringsParamsSchema>;
const FetchSummariesAndDocstringsRowSchema = z.object({
  node_id: z.string(),
  summary: z.string().nullable(),
  docstring: z.string().nullable(),
});
type FetchSummariesAndDocstringsRow = z.infer<typeof FetchSummariesAndDocstringsRowSchema>;

const fetchSummariesAndDocstringsQuery = defineQuery({
  sql: `SELECT n.id AS node_id,
            NULLIF(ss.summary, '') AS summary,
            NULLIF(n.docstring, '') AS docstring
       FROM nodes n
       LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
      WHERE n.id IN (SELECT value FROM json_each(@nodeIds))`,
  params: FetchSummariesAndDocstringsParamsSchema,
  row: FetchSummariesAndDocstringsRowSchema,
});

// Pattern A: build subject_path → test_path map from the `tests` edge.
const BuildTestPathsMapParamsSchema = z.object({ subjectPaths: z.string() });
type BuildTestPathsMapParams = z.infer<typeof BuildTestPathsMapParamsSchema>;
const BuildTestPathsMapRowSchema = z.object({
  subj_path: z.string(),
  test_path: z.string(),
});
type BuildTestPathsMapRow = z.infer<typeof BuildTestPathsMapRowSchema>;

const buildTestPathsMapQuery = defineQuery({
  sql: `SELECT DISTINCT n_subj.file_path AS subj_path, n_test.file_path AS test_path
       FROM nodes n_subj
       JOIN edges e ON e.target = n_subj.id AND e.kind = 'tests'
       JOIN nodes n_test ON n_test.id = e.source
      WHERE n_subj.file_path IN (SELECT value FROM json_each(@subjectPaths))
        AND n_subj.kind = 'file'`,
  params: BuildTestPathsMapParamsSchema,
  row: BuildTestPathsMapRowSchema,
});

// Pattern A: BM25-ranked test descriptions over a static FTS query +
// variable test_path IN-list.
const RankTestDescriptionsByFtsParamsSchema = z.object({
  ftsQuery: z.string(),
  testPaths: z.string(),
  limit: z.number(),
});
type RankTestDescriptionsByFtsParams = z.infer<typeof RankTestDescriptionsByFtsParamsSchema>;
const TestDescriptionRowSchema = z.object({ description: z.string() });
type TestDescriptionRow = z.infer<typeof TestDescriptionRowSchema>;

const rankTestDescriptionsByFtsQuery = defineQuery({
  sql: `SELECT tn.description
       FROM test_names tn
       JOIN test_names_fts ON test_names_fts.rowid = tn.id
      WHERE test_names_fts MATCH @ftsQuery
        AND tn.file_path IN (SELECT value FROM json_each(@testPaths))
      ORDER BY bm25(test_names_fts)
      LIMIT @limit`,
  params: RankTestDescriptionsByFtsParamsSchema,
  row: TestDescriptionRowSchema,
});

// Pattern A: unranked test names for a set of test_paths.
const TestNamesForPathsParamsSchema = z.object({ testPaths: z.string() });
type TestNamesForPathsParams = z.infer<typeof TestNamesForPathsParamsSchema>;
const TestNameRowSchema = z.object({
  id: z.number(),
  description: z.string(),
});
type TestNameRow = z.infer<typeof TestNameRowSchema>;

const testNamesForPathsQuery = defineQuery({
  sql: `SELECT tn.id, tn.description
       FROM test_names tn
      WHERE tn.file_path IN (SELECT value FROM json_each(@testPaths))`,
  params: TestNamesForPathsParamsSchema,
  row: TestNameRowSchema,
});

// Pattern A: file_path + name resolution for a chunked node-id list.
const NodesByIdForChunkParamsSchema = z.object({ nodeIds: z.string() });
type NodesByIdForChunkParams = z.infer<typeof NodesByIdForChunkParamsSchema>;
const NodeIdPathNameRowSchema = z.object({
  node_id: z.string(),
  file_path: z.string(),
  name: z.string(),
});
type NodeIdPathNameRow = z.infer<typeof NodeIdPathNameRowSchema>;

const nodesByIdForChunkQuery = defineQuery({
  sql: `SELECT id AS node_id, file_path, name
       FROM nodes
      WHERE id IN (SELECT value FROM json_each(@nodeIds))`,
  params: NodesByIdForChunkParamsSchema,
  row: NodeIdPathNameRowSchema,
});

// Pattern C variant: weighted-coverage row for both `coveredDocOnly` arms.
const WeightedCoverageRowSchema = z.object({
  total_nodes: z.number(),
  covered_nodes: z.number(),
  total_weight: z.number().nullable(),
  covered_weight: z.number().nullable(),
});
type WeightedCoverageRow = z.infer<typeof WeightedCoverageRowSchema>;

const WeightedCoverageWithDocParamsSchema = z.object({
  kinds: z.string(),
  docCharThreshold: z.number(),
});
type WeightedCoverageWithDocParams = z.infer<typeof WeightedCoverageWithDocParamsSchema>;

const weightedSummaryCoverageWithDocQuery = defineQuery({
  // `@docCharThreshold` is bound TWICE because SQLite named-parameter
  // semantics expand the same name to the same value on each occurrence.
  // The `coveredDocOnly = true` arm checks docstring length in both the
  // covered_nodes and covered_weight CASE expressions.
  sql: `SELECT
      COUNT(*) AS total_nodes,
      SUM(CASE WHEN ss.node_id IS NOT NULL OR (n.docstring IS NOT NULL AND length(n.docstring) >= @docCharThreshold) THEN 1 ELSE 0 END) AS covered_nodes,
      SUM(coalesce(n.centrality, 0)) AS total_weight,
      SUM(CASE WHEN ss.node_id IS NOT NULL OR (n.docstring IS NOT NULL AND length(n.docstring) >= @docCharThreshold) THEN coalesce(n.centrality, 0) ELSE 0 END) AS covered_weight
    FROM nodes n
    LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
    WHERE n.kind IN (SELECT value FROM json_each(@kinds))`,
  params: WeightedCoverageWithDocParamsSchema,
  row: WeightedCoverageRowSchema,
});

const WeightedCoverageSummaryOnlyParamsSchema = z.object({ kinds: z.string() });
type WeightedCoverageSummaryOnlyParams = z.infer<typeof WeightedCoverageSummaryOnlyParamsSchema>;

const weightedSummaryCoverageSummaryOnlyQuery = defineQuery({
  // `coveredDocOnly = false` arm: only the summary presence counts.
  sql: `SELECT
      COUNT(*) AS total_nodes,
      SUM(CASE WHEN ss.node_id IS NOT NULL THEN 1 ELSE 0 END) AS covered_nodes,
      SUM(coalesce(n.centrality, 0)) AS total_weight,
      SUM(CASE WHEN ss.node_id IS NOT NULL THEN coalesce(n.centrality, 0) ELSE 0 END) AS covered_weight
    FROM nodes n
    LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
    WHERE n.kind IN (SELECT value FROM json_each(@kinds))`,
  params: WeightedCoverageSummaryOnlyParamsSchema,
  row: WeightedCoverageRowSchema,
});

// Pattern D: per-table DELETE-by-rowid for vec0 mirror sweeps.
const DeleteVecRowParamsSchema = z.object({ rowid: z.bigint() });

// ─── Batch summary lookup by node IDs (json_each replaces chunkedIdLookup) ───

const getSymbolSummariesByIdsQuery = defineQuery({
  sql: `SELECT node_id, summary AS value FROM symbol_summaries
      WHERE node_id IN (SELECT value FROM json_each(@nodeIds))`,
  params: z.object({ nodeIds: z.string() }),
  row: z.object({ node_id: z.string(), value: z.string() }),
});

// ─── Summarizer-floor queries: per-kind body-line floor via json_each lookup ─

/**
 * Shape: `kinds` is `JSON.stringify(string[])`; `minBodyByKind` is
 * `JSON.stringify(Record<string,number>)`. The correlated subquery
 * `(SELECT CAST(value AS INTEGER) FROM json_each(@minBodyByKind) WHERE key = nodes.kind)`
 * yields each row's per-kind floor; `COALESCE(..., @defaultMinBodyLines)`
 * applies the default for kinds absent from the map. Replaces a
 * variable-arm `CASE kind WHEN ? THEN ?` clause built at call time.
 */
const SummarizableParamsSchema = z.object({
  kinds: z.string(),
  minBodyByKind: z.string(),
  defaultMinBodyLines: z.number(),
  docCharThreshold: z.number(),
});
type SummarizableParams = z.infer<typeof SummarizableParamsSchema>;

const NodeRowSchemaForSummarizable = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  file_path: z.string(),
  language: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  start_column: z.number(),
  end_column: z.number(),
  docstring: z.string().nullable(),
  signature: z.string().nullable(),
  visibility: z.string().nullable(),
  is_exported: z.number(),
  is_async: z.number(),
  is_static: z.number(),
  decorators: z.string().nullable(),
  decorator_args: z.string().nullable(),
  updated_at: z.number(),
  centrality: z.number().nullable(),
  betweenness: z.number().nullable(),
  body_hash: z.string(),
}) satisfies z.ZodType<NodeRow>;

const summarizableNodesQuery = defineQuery({
  sql: `SELECT * FROM nodes
      WHERE kind IN (SELECT value FROM json_each(@kinds))
        AND (end_line - start_line) >= COALESCE(
              (SELECT CAST(value AS INTEGER) FROM json_each(@minBodyByKind) WHERE key = nodes.kind),
              @defaultMinBodyLines
            )
        AND (docstring IS NULL OR length(docstring) < @docCharThreshold)
      ORDER BY updated_at DESC, file_path, start_line`,
  params: SummarizableParamsSchema,
  row: NodeRowSchemaForSummarizable,
});

const countPendingSummarizableQuery = defineQuery({
  sql: `SELECT COUNT(*) AS c FROM nodes
      WHERE kind IN (SELECT value FROM json_each(@kinds))
        AND (end_line - start_line) >= COALESCE(
              (SELECT CAST(value AS INTEGER) FROM json_each(@minBodyByKind) WHERE key = nodes.kind),
              @defaultMinBodyLines
            )
        AND (docstring IS NULL OR length(docstring) < @docCharThreshold)
        AND id NOT IN (SELECT node_id FROM summary_refs)`,
  params: SummarizableParamsSchema,
  row: z.object({ c: z.number() }),
});

const countSkippedByFloorQuery = defineQuery({
  sql: `SELECT COUNT(*) AS c FROM nodes
      WHERE kind IN (SELECT value FROM json_each(@kinds))
        AND (end_line - start_line) < COALESCE(
              (SELECT CAST(value AS INTEGER) FROM json_each(@minBodyByKind) WHERE key = nodes.kind),
              @defaultMinBodyLines
            )
        AND (docstring IS NULL OR length(docstring) < @docCharThreshold)`,
  params: SummarizableParamsSchema,
  row: z.object({ c: z.number() }),
});

// ─── pruneOrphanStoreRows — Pattern C variant dispatch (with-floor / all-age) ─

const OrphanStoreCutoffParams = z.object({ cutoff: z.number() });
const OrphanStoreCutoffFloorParams = z.object({ cutoff: z.number(), floor: z.number() });
const OrphanRowidRowSchema = z.object({ r: z.union([z.number(), z.bigint()]) });
type OrphanRowidRow = z.infer<typeof OrphanRowidRowSchema>;

const orphanEmbeddingRowidsAllAgeQuery = defineQuery({
  sql: `SELECT s.rowid AS r FROM embedding_store s
      WHERE s.last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM embedding_refs r
           WHERE r.body_hash = s.body_hash
             AND r.model = s.model
             AND r.grain = s.grain
        )`,
  params: OrphanStoreCutoffParams,
  row: OrphanRowidRowSchema,
});

const orphanEmbeddingRowidsWithFloorQuery = defineQuery({
  sql: `SELECT s.rowid AS r FROM embedding_store s
      WHERE s.last_ref_at >= @floor AND s.last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM embedding_refs r
           WHERE r.body_hash = s.body_hash
             AND r.model = s.model
             AND r.grain = s.grain
        )`,
  params: OrphanStoreCutoffFloorParams,
  row: OrphanRowidRowSchema,
});

// `RETURNING rowid AS r` + `.all().length` gives the precise outer-row
// count regardless of FTS5 / cascading-trigger inflation of
// `sqlite3_changes()` (Homebrew libsqlite3 + bun:sqlite reports an
// inflated `info.changes` when a DELETE on summary_store fires the
// `summary_fts_ad` trigger). Switching from `.run()` to `.all()` makes
// the count robust against the change-counter divergence.
const deleteOrphanSummaryStoreAllAgeQuery = defineQuery({
  sql: `DELETE FROM summary_store
      WHERE last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM summary_refs r
           WHERE r.body_hash = summary_store.body_hash
             AND r.model = summary_store.model
        )
      RETURNING rowid AS r`,
  params: OrphanStoreCutoffParams,
  row: OrphanRowidRowSchema,
});

const deleteOrphanSummaryStoreWithFloorQuery = defineQuery({
  sql: `DELETE FROM summary_store
      WHERE last_ref_at >= @floor AND last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM summary_refs r
           WHERE r.body_hash = summary_store.body_hash
             AND r.model = summary_store.model
        )
      RETURNING rowid AS r`,
  params: OrphanStoreCutoffFloorParams,
  row: OrphanRowidRowSchema,
});

const deleteOrphanEmbeddingStoreAllAgeQuery = defineQuery({
  sql: `DELETE FROM embedding_store
      WHERE last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM embedding_refs r
           WHERE r.body_hash = embedding_store.body_hash
             AND r.model = embedding_store.model
             AND r.grain = embedding_store.grain
        )
      RETURNING rowid AS r`,
  params: OrphanStoreCutoffParams,
  row: OrphanRowidRowSchema,
});

const deleteOrphanEmbeddingStoreWithFloorQuery = defineQuery({
  sql: `DELETE FROM embedding_store
      WHERE last_ref_at >= @floor AND last_ref_at <= @cutoff
        AND NOT EXISTS (
          SELECT 1 FROM embedding_refs r
           WHERE r.body_hash = embedding_store.body_hash
             AND r.model = embedding_store.model
             AND r.grain = embedding_store.grain
        )
      RETURNING rowid AS r`,
  params: OrphanStoreCutoffFloorParams,
  row: OrphanRowidRowSchema,
});

/**
 * Pattern C dispatcher for the orphan-embedding-rowid snapshot.
 * Returns the rowids about to disappear so the caller can mirror the
 * deletions into vec0 after the SQL DELETE runs.
 */
function selectOrphanEmbeddingStoreRowids(qb: QueryBuilder, useFloor: boolean, cutoff: number): Array<number | bigint> {
  if (useFloor) {
    qb.queries.orphanEmbeddingRowidsWithFloor ??= orphanEmbeddingRowidsWithFloorQuery(qb.db);
    return qb.queries.orphanEmbeddingRowidsWithFloor
      .all({ cutoff, floor: LAST_REF_AT_PLAUSIBLE_FLOOR })
      .map((row) => row.r);
  }
  qb.queries.orphanEmbeddingRowidsAllAge ??= orphanEmbeddingRowidsAllAgeQuery(qb.db);
  return qb.queries.orphanEmbeddingRowidsAllAge.all({ cutoff }).map((row) => row.r);
}

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    summaryModelCounts?: TypedQuery<Record<string, never>, SummaryModelCountsRow>;
    orphanEmbeddingStoreRowids?: TypedQuery<Record<string, never>, OrphanStoreRowidRow>;
    vecEmbeddingTables?: TypedQuery<Record<string, never>, VecEmbeddingTableRow>;
    getSymbolSummary?: TypedQuery<GetSymbolSummaryParams, GetSymbolSummaryRow>;
    getSummaryByContentHash?: TypedQuery<GetSummaryByContentHashParams, GetSummaryByContentHashRow>;
    upsertSummaryStore?: TypedQuery<UpsertSummaryStoreParams, never>;
    upsertSummaryRef?: TypedQuery<UpsertSummaryRefParams, never>;
    countAllNodes?: TypedQuery<Record<string, never>, SingleNRow>;
    countAllSummaries?: TypedQuery<Record<string, never>, SingleNRow>;
    countNodesByKinds?: TypedQuery<CountNodesByKindsParams, SingleNRow>;
    fetchSummariesAndDocstrings?: TypedQuery<FetchSummariesAndDocstringsParams, FetchSummariesAndDocstringsRow>;
    buildTestPathsMap?: TypedQuery<BuildTestPathsMapParams, BuildTestPathsMapRow>;
    rankTestDescriptionsByFts?: TypedQuery<RankTestDescriptionsByFtsParams, TestDescriptionRow>;
    testNamesForPaths?: TypedQuery<TestNamesForPathsParams, TestNameRow>;
    nodesByIdForChunk?: TypedQuery<NodesByIdForChunkParams, NodeIdPathNameRow>;
    weightedSummaryCoverageWithDoc?: TypedQuery<WeightedCoverageWithDocParams, WeightedCoverageRow>;
    weightedSummaryCoverageSummaryOnly?: TypedQuery<WeightedCoverageSummaryOnlyParams, WeightedCoverageRow>;
    getSymbolSummariesByIds?: TypedQuery<{ nodeIds: string }, { node_id: string; value: string }>;
    summarizableNodes?: TypedQuery<SummarizableParams, NodeRow>;
    countPendingSummarizable?: TypedQuery<SummarizableParams, { c: number }>;
    countSkippedByFloor?: TypedQuery<SummarizableParams, { c: number }>;
    orphanEmbeddingRowidsAllAge?: TypedQuery<z.infer<typeof OrphanStoreCutoffParams>, OrphanRowidRow>;
    orphanEmbeddingRowidsWithFloor?: TypedQuery<z.infer<typeof OrphanStoreCutoffFloorParams>, OrphanRowidRow>;
    deleteOrphanSummaryStoreAllAge?: TypedQuery<z.infer<typeof OrphanStoreCutoffParams>, OrphanRowidRow>;
    deleteOrphanSummaryStoreWithFloor?: TypedQuery<z.infer<typeof OrphanStoreCutoffFloorParams>, OrphanRowidRow>;
    deleteOrphanEmbeddingStoreAllAge?: TypedQuery<z.infer<typeof OrphanStoreCutoffParams>, OrphanRowidRow>;
    deleteOrphanEmbeddingStoreWithFloor?: TypedQuery<z.infer<typeof OrphanStoreCutoffFloorParams>, OrphanRowidRow>;
  }
}
