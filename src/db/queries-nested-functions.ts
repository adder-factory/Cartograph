import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import type { NestedFunctionManifestRow } from '../extraction/types.js';

/**
 * Typed queries over the F#12 slice 2 nested-function manifest tables
 * (`nested_function_names` + `nested_function_names_fts`). The manifest
 * records nested-function declarations inside mega-files (files whose
 * largest function body crosses `largeFunctionThreshold`) without
 * persisting them as graph nodes — see
 * `docs/F12-NESTED-FUNCTION-PROMOTION-PLAN.md`.
 *
 * Persistence policy: delete-by-file then insert-all on every
 * re-extract (matches the parse_cache invalidation grain). The
 * `parent_node_id` FK cascades on parent-node delete; the
 * `(file_path, name, start_line)` UNIQUE constraint guards re-insert
 * idempotency if the persist transaction retries.
 */

// Persist input shape is intentionally `NestedFunctionManifestRow`
// imported from `../types.js` (identical column list). Re-exporting an
// alias would only duplicate the type surface without a callsite that
// distinguishes "row from DB" from "row to persist".

/**
 * One row read from `nested_function_names` joined back to its parent
 * `nodes` row's name — the renderer's "inside `createTypeChecker`"
 * footer needs the parent's display name, not the id.
 */
export interface NestedFnLookupRow {
  id: number;
  parentNodeId: string;
  parentName: string | null;
  filePath: string;
  name: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  signature: string | null;
  bodyHash: string;
  hitCount: number;
  promotedNodeId: string | null;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────

const NestedFnPersistSchema = z.object({
  parentNodeId: z.string(),
  filePath: z.string(),
  name: z.string(),
  startLine: z.number(),
  startCol: z.number(),
  endLine: z.number(),
  endCol: z.number(),
  signature: z.string().nullable(),
  bodyHash: z.string(),
});

const NestedFnRowSchema = z.object({
  id: z.number(),
  parentNodeId: z.string(),
  parentName: z.string().nullable(),
  filePath: z.string(),
  name: z.string(),
  startLine: z.number(),
  startCol: z.number(),
  endLine: z.number(),
  endCol: z.number(),
  signature: z.string().nullable(),
  bodyHash: z.string(),
  hitCount: z.number(),
  promotedNodeId: z.string().nullable(),
}) satisfies z.ZodType<NestedFnLookupRow>;

// SELECT shape — keep the column list as a const so every read path
// agrees on the join + column aliases.
const NESTED_FN_SELECT = `
  SELECT
    nfn.id AS id,
    nfn.parent_node_id AS parentNodeId,
    parent.name AS parentName,
    nfn.file_path AS filePath,
    nfn.name AS name,
    nfn.start_line AS startLine,
    nfn.start_col AS startCol,
    nfn.end_line AS endLine,
    nfn.end_col AS endCol,
    nfn.signature AS signature,
    nfn.body_hash AS bodyHash,
    nfn.hit_count AS hitCount,
    nfn.promoted_node_id AS promotedNodeId
  FROM nested_function_names nfn
  LEFT JOIN nodes parent ON parent.id = nfn.parent_node_id
`;

// ─── Typed query definitions ─────────────────────────────────────────────

const deleteNestedFnsForPathQuery = defineQuery({
  sql: 'DELETE FROM nested_function_names WHERE file_path = @filePath',
  params: z.object({ filePath: z.string() }),
  row: z.never(),
});

const insertNestedFnQuery = defineQuery({
  sql:
    `INSERT INTO nested_function_names ` +
    `(parent_node_id, file_path, name, start_line, start_col, end_line, end_col, signature, body_hash) ` +
    `VALUES (@parentNodeId, @filePath, @name, @startLine, @startCol, @endLine, @endCol, @signature, @bodyHash)`,
  params: NestedFnPersistSchema,
  row: z.never(),
});

const lookupNestedFnByNameQuery = defineQuery({
  sql: `${NESTED_FN_SELECT}WHERE nfn.name = @name ORDER BY nfn.file_path, nfn.start_line LIMIT @limit`,
  params: z.object({ name: z.string(), limit: z.number() }),
  row: NestedFnRowSchema,
});

const lookupNestedFnAtPositionQuery = defineQuery({
  // Position-anchored lookup for cartograph_node({deep:true}): a
  // manifest row is uniquely identified by (file_path, name, start_line)
  // per the schema's UNIQUE constraint, so this returns at most one row.
  sql: `${NESTED_FN_SELECT}WHERE nfn.file_path = @filePath AND nfn.name = @name AND nfn.start_line = @startLine`,
  params: z.object({ filePath: z.string(), name: z.string(), startLine: z.number() }),
  row: NestedFnRowSchema,
});

const lookupNestedFnByFilePathAndNameQuery = defineQuery({
  // File-disambiguated lookup for cartograph_node({deep:true}) when the
  // caller knows the file but not the line. Multiple rows possible if
  // overloaded names (e.g. two nested fns with the same name in
  // different parent functions); caller picks the first or asks for line.
  sql: `${NESTED_FN_SELECT}WHERE nfn.file_path = @filePath AND nfn.name = @name ORDER BY nfn.start_line LIMIT @limit`,
  params: z.object({ filePath: z.string(), name: z.string(), limit: z.number() }),
  row: NestedFnRowSchema,
});

const fts5SearchNestedFnsQuery = defineQuery({
  // FTS5 MATCH over the name column. `@query` is the user's already-
  // sanitized FTS5 query string; the caller is responsible for escaping
  // (matches the existing test_names_fts caller convention).
  sql: `
    ${NESTED_FN_SELECT}
    JOIN nested_function_names_fts fts ON fts.rowid = nfn.id
    WHERE nested_function_names_fts MATCH @query
    ORDER BY rank LIMIT @limit
  `,
  params: z.object({ query: z.string(), limit: z.number() }),
  row: NestedFnRowSchema,
});

// F#12 slice 3 — hit-counting + popularity carryover queries.

const incrementHitCountQuery = defineQuery({
  // Atomic bump of (hit_count, last_hit_at) for the row matching the
  // canonical UNIQUE key. Concurrent calls race to the WAL — SQLite
  // serialises writes at the engine level so the worst case is a lost
  // update (one increment instead of two), which is the
  // documented-acceptable tradeoff in the plan §risks #3.
  sql: `UPDATE nested_function_names
        SET hit_count = hit_count + 1,
            last_hit_at = @now
        WHERE file_path = @filePath AND name = @name AND start_line = @startLine`,
  params: z.object({ filePath: z.string(), name: z.string(), startLine: z.number(), now: z.number() }),
  row: z.never(),
});

const upsertPopularityRowQuery = defineQuery({
  // Mirrors the manifest hit_count to the (file_path, name)-keyed
  // popularity table — survives the manifest's delete-on-re-extract
  // churn so the learned signal isn't reset by every file edit.
  // INSERT OR REPLACE because (a) STRICT WITHOUT ROWID disallows
  // INSERT ON CONFLICT, (b) hit_count + last_hit_at are the only
  // mutable columns so a replace is semantically a full upsert.
  sql: `INSERT INTO nested_function_popularity (file_path, name, hit_count, last_hit_at)
        VALUES (@filePath, @name, @hitCount, @lastHitAt)
        ON CONFLICT(file_path, name) DO UPDATE SET
          hit_count = excluded.hit_count,
          last_hit_at = excluded.last_hit_at`,
  params: z.object({
    filePath: z.string(),
    name: z.string(),
    hitCount: z.number(),
    lastHitAt: z.number(),
  }),
  row: z.never(),
});

const loadPopularityForFileQuery = defineQuery({
  // Pull every popularity row for one file. Used during re-extract to
  // seed `hit_count` on the freshly-inserted manifest rows so popularity
  // accumulates across file edits / position drift.
  sql: `SELECT file_path AS filePath, name, hit_count AS hitCount, last_hit_at AS lastHitAt
        FROM nested_function_popularity WHERE file_path = @filePath`,
  params: z.object({ filePath: z.string() }),
  row: z.object({
    filePath: z.string(),
    name: z.string(),
    hitCount: z.number(),
    lastHitAt: z.number().nullable(),
  }),
});

const readHitCountQuery = defineQuery({
  // Point-read the post-bump hit_count so the bumper can mirror it to
  // the popularity table inside the same transaction. The UNIQUE key
  // guarantees at most one row.
  sql: `SELECT hit_count AS hitCount
        FROM nested_function_names
        WHERE file_path = @filePath AND name = @name AND start_line = @startLine`,
  params: z.object({ filePath: z.string(), name: z.string(), startLine: z.number() }),
  row: z.object({ hitCount: z.number() }),
});

const setHitCountFromPopularityQuery = defineQuery({
  // Carryover seed — set the freshly-inserted manifest row's hit_count
  // from the popularity table's stored value. Keyed exactly to the
  // UNIQUE (file_path, name, start_line) so two same-named declarations
  // in the same file don't both inherit the same popularity row.
  sql: `UPDATE nested_function_names
        SET hit_count = @hitCount
        WHERE file_path = @filePath AND name = @name AND start_line = @startLine`,
  params: z.object({ filePath: z.string(), name: z.string(), startLine: z.number(), hitCount: z.number() }),
  row: z.never(),
});

const migrateEdgesIntoPromotedQuery = defineQuery({
  // F#12 slice 4 — when a nested fn is promoted, the edges emitted by
  // the body walker for code INSIDE that nested fn were attributed to
  // the closest real-node ancestor at extraction time (the parent fn,
  // because the nested fn wasn't a real Node yet). After promotion,
  // re-anchor those edges to the promoted node so callees / refs /
  // field-accesses out of the promoted fn surface from the right
  // source. Scope:
  //   - intra-file (source must be a Node in the promoted fn's file
  //     — same-line matches in other files are coincidental)
  //   - source must NOT already be the promoted id (re-run safe;
  //     skips already-migrated rows)
  //   - line in the promoted fn's 1-indexed [start_line, end_line] range
  // `OR IGNORE` swallows the rare collision where an edge with the
  // same (target, kind, line, col) already exists for the promoted
  // node (e.g. from a partial re-run). On collision, `UPDATE OR
  // IGNORE` skips the UPDATE so the source row stays attributed to
  // the parent permanently — the collision is stable across future
  // syncs (same target+kind+line+col will keep colliding) unless the
  // pre-existing edge is later deleted by some unrelated path.
  sql: `UPDATE OR IGNORE edges
        SET source = @promotedId
        WHERE source IN (SELECT id FROM nodes WHERE file_path = @filePath)
          AND source != @promotedId
          AND line BETWEEN @startLine AND @endLine`,
  params: z.object({
    promotedId: z.string(),
    filePath: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  row: z.never(),
});

const migrateUnresolvedRefsIntoPromotedQuery = defineQuery({
  // F#12 slice 4 — same shape as `migrateEdgesIntoPromoted` but for
  // unresolved_refs. Refs emitted from inside the promoted fn's body
  // were attributed to the parent at extraction time; re-anchor to
  // the promoted node so the subsequent partial re-resolve (and
  // future resolver passes) walk imports/aliases from the right
  // source-file scope.
  sql: `UPDATE unresolved_refs
        SET from_node_id = @promotedId
        WHERE from_node_id IN (SELECT id FROM nodes WHERE file_path = @filePath)
          AND from_node_id != @promotedId
          AND line BETWEEN @startLine AND @endLine`,
  params: z.object({
    promotedId: z.string(),
    filePath: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  row: z.never(),
});

const countNodesByFileKindNameQuery = defineQuery({
  // F#12 slice 3 — promote-nested-fn ordinal source. The promotion
  // hook needs to know how many same-(kind, name) nodes already live
  // in the file so the next ordinal is `count + per-batch offset` and
  // the synthesized id doesn't collide with an existing row. Per-batch
  // offset is the hook's responsibility — this query is the read.
  sql: `SELECT COUNT(*) AS n FROM nodes WHERE file_path = @filePath AND kind = @kind AND name = @name`,
  params: z.object({ filePath: z.string(), kind: z.string(), name: z.string() }),
  row: z.object({ n: z.number() }),
});

const listUnresolvedRefsByNamesQuery = defineQuery({
  // Pattern A — `IN (json_each(@namesJson))` keeps the SQL static
  // across variable name-counts. Used by the promotion hook's same-
  // sync partial re-resolve to scope the resolver to refs whose
  // reference_name just gained a target.
  sql: `SELECT id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, site_count, extra_lines
        FROM unresolved_refs
        WHERE reference_name IN (SELECT value FROM json_each(@namesJson))`,
  params: z.object({ namesJson: z.string() }),
  row: z.object({
    id: z.number(),
    from_node_id: z.string(),
    reference_name: z.string(),
    reference_kind: z.string(),
    line: z.number(),
    col: z.number(),
    candidates: z.string().nullable(),
    file_path: z.string(),
    language: z.string(),
    site_count: z.number(),
    extra_lines: z.string().nullable(),
  }),
});

const listPromotablesQuery = defineQuery({
  // Promotion-queue scan: rows past the threshold that haven't been
  // promoted yet. ORDER BY hit_count DESC so the most-needed promotions
  // fire first if the per-pass cap (handled in the hook) ever clips.
  sql: `${NESTED_FN_SELECT}WHERE nfn.promoted_node_id IS NULL AND nfn.hit_count >= @threshold
        ORDER BY nfn.hit_count DESC, nfn.id ASC
        LIMIT @limit`,
  params: z.object({ threshold: z.number(), limit: z.number() }),
  row: NestedFnRowSchema,
});

const markPromotedQuery = defineQuery({
  // Idempotent promotion mark — UPDATE guarded by `promoted_node_id IS
  // NULL` so two concurrent promotion hooks racing the same row don't
  // overwrite each other's results (plan §risks #5).
  sql: `UPDATE nested_function_names
        SET promoted_node_id = @promotedNodeId, promoted_at = @promotedAt
        WHERE id = @id AND promoted_node_id IS NULL`,
  params: z.object({ id: z.number(), promotedNodeId: z.string(), promotedAt: z.number() }),
  row: z.never(),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    deleteNestedFnsForPath?: TypedQuery<{ filePath: string }, never>;
    insertNestedFn?: TypedQuery<NestedFunctionManifestRow, never>;
    lookupNestedFnByName?: TypedQuery<{ name: string; limit: number }, NestedFnLookupRow>;
    lookupNestedFnAtPosition?: TypedQuery<{ filePath: string; name: string; startLine: number }, NestedFnLookupRow>;
    lookupNestedFnByFilePathAndName?: TypedQuery<{ filePath: string; name: string; limit: number }, NestedFnLookupRow>;
    fts5SearchNestedFns?: TypedQuery<{ query: string; limit: number }, NestedFnLookupRow>;
    incrementNestedFnHit?: TypedQuery<{ filePath: string; name: string; startLine: number; now: number }, never>;
    upsertNestedFnPopularity?: TypedQuery<
      { filePath: string; name: string; hitCount: number; lastHitAt: number },
      never
    >;
    loadNestedFnPopularityForFile?: TypedQuery<
      { filePath: string },
      { filePath: string; name: string; hitCount: number; lastHitAt: number | null }
    >;
    listNestedFnPromotables?: TypedQuery<{ threshold: number; limit: number }, NestedFnLookupRow>;
    markNestedFnPromoted?: TypedQuery<{ id: number; promotedNodeId: string; promotedAt: number }, never>;
    migrateEdgesIntoPromoted?: TypedQuery<
      { promotedId: string; filePath: string; startLine: number; endLine: number },
      never
    >;
    migrateUnresolvedRefsIntoPromoted?: TypedQuery<
      { promotedId: string; filePath: string; startLine: number; endLine: number },
      never
    >;
    readNestedFnHitCount?: TypedQuery<{ filePath: string; name: string; startLine: number }, { hitCount: number }>;
    setNestedFnHitCountFromPopularity?: TypedQuery<
      { filePath: string; name: string; startLine: number; hitCount: number },
      never
    >;
    countNodesByFileKindName?: TypedQuery<{ filePath: string; kind: string; name: string }, { n: number }>;
    listUnresolvedRefsByNames?: TypedQuery<
      { namesJson: string },
      {
        id: number;
        from_node_id: string;
        reference_name: string;
        reference_kind: string;
        line: number;
        col: number;
        candidates: string | null;
        file_path: string;
        language: string;
        site_count: number;
        extra_lines: string | null;
      }
    >;
  }
}

// ─── Public surface ──────────────────────────────────────────────────────

/**
 * Replace the manifest rows for one file with `rows`. Per the F#12
 * persistence policy (see `docs/F12-NESTED-FUNCTION-PROMOTION-PLAN.md`
 * §sync-invariants) re-extracts are delete-then-insert atomically — the
 * old rows can't reflect the new positions, so updating in place would
 * desync the deep-view AST walker from the source.
 *
 * Caller must be inside a `qbTransaction`/`db.transaction` that also
 * persists the parent function `nodes` rows — the row's `parentNodeId`
 * FK requires the parent to exist by the time the INSERT runs.
 */
export function upsertNestedFunctionsForFile(
  qb: QueryBuilder,
  filePath: string,
  rows: ReadonlyArray<NestedFunctionManifestRow>,
): number {
  qb.queries.deleteNestedFnsForPath ??= deleteNestedFnsForPathQuery(qb.db);
  qb.queries.deleteNestedFnsForPath.run({ filePath });
  if (rows.length === 0) return 0;
  qb.queries.insertNestedFn ??= insertNestedFnQuery(qb.db);
  const stmt = qb.queries.insertNestedFn;
  let written = 0;
  for (const r of rows) {
    try {
      stmt.run(r);
      written++;
    } catch {
      // FK / UNIQUE violation under race: the parent node was evicted
      // mid-transaction, or a sibling worker raced this exact row. Skip
      // — the next re-extract will rebuild it.
    }
  }
  // F#12 slice 3 — seed hit_count on the freshly inserted manifest
  // rows from the popularity table. Plan §sync-invariants: popularity
  // is keyed by (file_path, name), so position drift across edits
  // doesn't reset the learned-popularity signal. Body-hash drift is
  // handled separately by the caller (drops promoted_node_id) — here
  // we just carry the count forward.
  carryoverPopularityForFile(qb, filePath, rows);
  return written;
}

/** F#12 slice 3 — apply popularity carryover to a fresh batch of
 *  manifest rows for one file. Reads the popularity table once, indexes
 *  by `name`, UPDATEs `hit_count` on any matching freshly-inserted row.
 *  No-op when the popularity table has no rows for the file (first
 *  encounter of the file in manifest mode). */
function carryoverPopularityForFile(
  qb: QueryBuilder,
  filePath: string,
  freshRows: ReadonlyArray<NestedFunctionManifestRow>,
): void {
  qb.queries.loadNestedFnPopularityForFile ??= loadPopularityForFileQuery(qb.db);
  const popRows = qb.queries.loadNestedFnPopularityForFile.all({ filePath });
  if (popRows.length === 0) return;
  // Map name → popularity hit_count for O(1) lookup per fresh row.
  const popByName = new Map(popRows.map((p) => [p.name, p.hitCount]));
  qb.queries.setNestedFnHitCountFromPopularity ??= setHitCountFromPopularityQuery(qb.db);
  const restoreStmt = qb.queries.setNestedFnHitCountFromPopularity;
  for (const r of freshRows) {
    const carried = popByName.get(r.name);
    if (carried === undefined || carried === 0) continue;
    restoreStmt.run({ filePath: r.filePath, name: r.name, startLine: r.startLine, hitCount: carried });
  }
}

/** Look up manifest rows by exact name across all files. Returns at
 *  most `limit` rows ordered by file then start_line. Used by
 *  cartograph_find when the name doesn't match any indexed graph node. */
export function lookupNestedFnsByName(qb: QueryBuilder, name: string, limit = 25): NestedFnLookupRow[] {
  qb.queries.lookupNestedFnByName ??= lookupNestedFnByNameQuery(qb.db);
  return qb.queries.lookupNestedFnByName.all({ name, limit });
}

/**
 * FTS5 MATCH over the manifest's name column — same shape as
 * `test_names_fts`. Caller is responsible for FTS5 query sanitization.
 *
 * Slice 2 has no production caller (the
 * `probeNestedFunctionManifestCulprit` empty-result probe gates on a
 * single bare identifier and uses the exact `lookupNestedFnsByName`).
 * The FTS5 corpus exists for the future intent-mode 4th-corpus
 * integration in `_search-intent.ts` per the F#12 plan. Kept exported
 * + smoke-tested so the FTS5 triggers (INSERT/UPDATE/DELETE) stay
 * verified — a regression in those triggers would silently de-sync
 * the corpus from `nested_function_names` and only surface once slice
 * 3 / intent mode goes live.
 */
export function searchNestedFnsFts(qb: QueryBuilder, query: string, limit = 25): NestedFnLookupRow[] {
  qb.queries.fts5SearchNestedFns ??= fts5SearchNestedFnsQuery(qb.db);
  return qb.queries.fts5SearchNestedFns.all({ query, limit });
}

/**
 * F#12 slice 3 — atomically bump `hit_count` + `last_hit_at` on the
 * manifest row identified by `(filePath, name, startLine)` AND mirror
 * the bumped value into the popularity table so the signal survives
 * the next file edit. Two writes under the same `db.transaction()`
 * keep manifest + popularity in lockstep — popularity always reflects
 * the latest count for that `(file_path, name)`.
 *
 * The bump is best-effort: SQLite WAL serialises writes, so concurrent
 * `deep:true` calls race for the row. Lost-update worst case (one
 * increment instead of two) is documented-acceptable per the plan
 * §risks #3 — the symbol just promotes one query later than expected.
 *
 * Returns the new (post-bump) hit_count for the row, or 0 if the row
 * vanished mid-call (file was re-extracted between manifest lookup
 * and the bump — rare race).
 */
export function bumpNestedFnHitCount(
  qb: QueryBuilder,
  args: { filePath: string; name: string; startLine: number },
): number {
  qb.queries.incrementNestedFnHit ??= incrementHitCountQuery(qb.db);
  qb.queries.upsertNestedFnPopularity ??= upsertPopularityRowQuery(qb.db);
  qb.queries.readNestedFnHitCount ??= readHitCountQuery(qb.db);
  const now = Date.now();
  const incrementStmt = qb.queries.incrementNestedFnHit;
  const popStmt = qb.queries.upsertNestedFnPopularity;
  const readStmt = qb.queries.readNestedFnHitCount;
  // Fetch + bump + mirror in one transaction so manifest and popularity
  // can't diverge under concurrent reads.
  let newCount = 0;
  qb.db.transaction(() => {
    incrementStmt.run({ filePath: args.filePath, name: args.name, startLine: args.startLine, now });
    // Read back the post-increment count for the popularity mirror.
    const row = readStmt.get({ filePath: args.filePath, name: args.name, startLine: args.startLine });
    if (!row) return; // Race with re-extract; popularity mirror is skipped this round.
    newCount = row.hitCount;
    popStmt.run({ filePath: args.filePath, name: args.name, hitCount: newCount, lastHitAt: now });
  })();
  return newCount;
}

/**
 * F#12 slice 4 — re-anchor edges + unresolved_refs whose source/from
 * is a same-file node and whose `line` falls inside the promoted fn's
 * range. Pre-slice-4, the body walker attributed all
 * calls/field-accesses/refs inside a not-yet-promoted nested fn to the
 * closest real-node ancestor (the parent fn), since the nested fn
 * wasn't a real Node yet. Post-promotion, those edges semantically
 * belong to the promoted node, not the parent. Without this migration
 * `cartograph_graph direction:callees start=<promoted>` returns nothing
 * because the parent still owns the call edges.
 *
 * Limitation: extraction-time `dedupeReferences` collapses sibling
 * refs by `(fromNodeId, name, kind)` — if `createTypeChecker` had two
 * children calling `setSymbolValueDeclaration` (one inside
 * `getTypeOfSymbol`, one inside `checkSourceFile`), the parent's dedup
 * keeps ONE ref + extraLines. Migrating by line range moves that ref
 * to whichever promoted sibling's range contains the PRIMARY line;
 * the other sibling's `extraLines` entry is silently transferred. A
 * full per-fn re-extract would fix this; slice 4 MVP accepts the
 * approximation.
 *
 * Idempotent: `source != promotedId` guard makes re-runs no-ops on
 * already-migrated rows. `UPDATE OR IGNORE` on the edges side handles
 * the rare collision against the edges UNIQUE index
 * (source, target, kind, line, col) — re-runs after partial failure
 * skip the rows that already exist for the promoted node.
 *
 * Overlapping-range edge case: when two manifest rows from the same
 * parent get promoted in the SAME batch AND one row's range is
 * contained within the other (e.g. a nested-nested fn whose lines
 * fall inside its sibling's range), the second `migratePromotedFnEdges`
 * call will re-anchor edges that the first call already correctly
 * migrated — the guard is only `source != @promotedId` for the
 * current row, NOT for earlier rows' ids. In practice the manifest
 * miner produces non-overlapping siblings (nested-nested manifest
 * rows are attributed to the closest REAL-node ancestor, which is
 * the original parent — they never share a parent with their
 * containing sibling), so this case can't arise from a fresh
 * extraction. Documented for the day someone hand-builds overlapping
 * manifest rows.
 */
export function migratePromotedFnEdges(
  qb: QueryBuilder,
  args: { promotedId: string; filePath: string; startLine: number; endLine: number },
): void {
  qb.queries.migrateEdgesIntoPromoted ??= migrateEdgesIntoPromotedQuery(qb.db);
  qb.queries.migrateUnresolvedRefsIntoPromoted ??= migrateUnresolvedRefsIntoPromotedQuery(qb.db);
  qb.queries.migrateEdgesIntoPromoted.run(args);
  qb.queries.migrateUnresolvedRefsIntoPromoted.run(args);
}

/**
 * F#12 slice 3 — count existing `nodes` rows matching (filePath, kind,
 * name). Used by the promotion hook to pick a starting ordinal so the
 * synthesised promoted-node id doesn't collide with an existing real
 * node (e.g. when a nested-fn shares its name with the file's top-level
 * declaration of the same kind).
 */
export function countNodesByFileKindName(
  qb: QueryBuilder,
  args: { filePath: string; kind: string; name: string },
): number {
  qb.queries.countNodesByFileKindName ??= countNodesByFileKindNameQuery(qb.db);
  return qb.queries.countNodesByFileKindName.get(args)?.n ?? 0;
}

/**
 * F#12 slice 3 — pull every unresolved_ref whose `reference_name` is in
 * `names`. Static SQL via Pattern A (`json_each(@namesJson)`), so the
 * prepared statement is reusable regardless of how many names are in
 * the set. Used by the promotion hook's same-sync partial re-resolve.
 */
export function listUnresolvedRefsByNames(
  qb: QueryBuilder,
  names: ReadonlyArray<string>,
): ReadonlyArray<{
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
  site_count: number;
  extra_lines: string | null;
}> {
  if (names.length === 0) return [];
  qb.queries.listUnresolvedRefsByNames ??= listUnresolvedRefsByNamesQuery(qb.db);
  return qb.queries.listUnresolvedRefsByNames.all({ namesJson: JSON.stringify(names) });
}

/** F#12 slice 3 — list manifest rows whose hit_count crosses the
 *  promotion threshold AND have not yet been promoted. Used by the
 *  `promote-nested-fn` post-sync hook. */
export function listNestedFnPromotables(qb: QueryBuilder, threshold: number, limit = 100): NestedFnLookupRow[] {
  qb.queries.listNestedFnPromotables ??= listPromotablesQuery(qb.db);
  return qb.queries.listNestedFnPromotables.all({ threshold, limit });
}

/** F#12 slice 3 — mark a manifest row as promoted. Idempotent under
 *  concurrent hook runs (the SQL guards on `promoted_node_id IS NULL`). */
export function markNestedFnPromoted(qb: QueryBuilder, args: { id: number; promotedNodeId: string }): void {
  qb.queries.markNestedFnPromoted ??= markPromotedQuery(qb.db);
  qb.queries.markNestedFnPromoted.run({ id: args.id, promotedNodeId: args.promotedNodeId, promotedAt: Date.now() });
}

/**
 * Resolve a manifest row for `cartograph_node({deep:true})`. The lookup
 * is layered so the caller doesn't need to know whether they have a
 * line hint:
 *
 *   1. If `startLine` is set, do the exact (file_path, name, start_line)
 *      lookup that the UNIQUE constraint guarantees is single-row.
 *   2. Else if `filePath` is set, return all rows matching
 *      `(file_path, name)` ordered by start_line — caller picks first
 *      or disambiguates.
 *   3. Else fall back to a global name lookup.
 *
 * Slice 2/3's `tryRenderManifestDeepView` in `src/mcp/tools/node.ts`
 * calls `lookupNestedFnsByName` directly (no file/line hints available
 * on the cartograph_node arg surface). This layered resolver is the
 * intended entry point once the deep-view caller gains file+line
 * disambiguation — kept exported + tested so the SQL shapes don't
 * regress before that arrives.
 */
export function resolveNestedFnManifest(
  qb: QueryBuilder,
  args: { name: string; filePath?: string; startLine?: number; limit?: number },
): NestedFnLookupRow[] {
  const limit = args.limit ?? 5;
  if (args.filePath && args.startLine !== undefined) {
    qb.queries.lookupNestedFnAtPosition ??= lookupNestedFnAtPositionQuery(qb.db);
    const row = qb.queries.lookupNestedFnAtPosition.get({
      filePath: args.filePath,
      name: args.name,
      startLine: args.startLine,
    });
    return row ? [row] : [];
  }
  if (args.filePath) {
    qb.queries.lookupNestedFnByFilePathAndName ??= lookupNestedFnByFilePathAndNameQuery(qb.db);
    return qb.queries.lookupNestedFnByFilePathAndName.all({
      filePath: args.filePath,
      name: args.name,
      limit,
    });
  }
  return lookupNestedFnsByName(qb, args.name, limit);
}
