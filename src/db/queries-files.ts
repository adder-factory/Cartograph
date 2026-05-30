/**
 * File CRUD + tracked-file read queries (the `files` table).
 *
 * MIGRATED TO TYPED QUERIES (pilot, 2026-05-20). The 11 prepared
 * statements in this file are declared at module scope via
 * {@link defineQuery} — Zod schemas drive both compile-time and
 * runtime validation of params + rows. Lazy-cached on `qb.queries.X`
 * to mirror the existing `qb.stmts.X` pattern (and so cold-paths
 * never pay for unused statements).
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain file helpers as direct members. The functions read
 * / write the `files` table via the `@internal`-tagged `db` and
 * `queries` fields on the parent `QueryBuilder`. `deleteFile` deletes
 * the file's `nodes` EXPLICITLY then the `files` row (see its own
 * JSDoc for why it no longer relies solely on the FK cascade), and
 * calls `qb.invalidateNodeCacheForFile()` to mirror the node removal
 * in the in-process node cache.
 */

import { z } from 'zod';
import type { FileRecord } from '../types.js';
import { bindingsFromObject } from './row-mapper.js';
import {
  type QueryBuilder,
  type FileRow,
  rowToFileRecord,
  qbTransaction,
  FILE_RECORD_SCHEMA,
  FILE_INSERT_PARTS,
  FILE_CHURN_MANAGED_COLS,
} from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { reconstructCrossFileRefsToFile } from './queries-unresolved-refs.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

/**
 * Shape `bindingsFromObject(file, FILE_RECORD_SCHEMA)` produces for the
 * upsertFile INSERT — every key the SQL's `@bind` list references.
 * Churn-managed fields (commit_count, loc, first_seen_ts, last_touched_ts)
 * are deliberately absent: `FILE_INSERT_PARTS` already excludes them
 * from the bind list, and Zod's default `.strip` silently drops the
 * four extras that `bindingsFromObject` still emits — preserving the
 * "extra keys are tolerated" semantic of the existing adapter without
 * paying for a `.passthrough()`.
 */
const UpsertFileParamsSchema = z.object({
  path: z.string(),
  contentHash: z.string(),
  language: z.string(),
  size: z.number(),
  modifiedAt: z.number(),
  indexedAt: z.number(),
  nodeCount: z.number(),
  errors: z.string().nullable(),
  isTest: z.union([z.literal(0), z.literal(1)]),
  needsReextract: z.union([z.literal(0), z.literal(1)]),
});

type UpsertFileParams = z.infer<typeof UpsertFileParamsSchema>;

/** SQLite-side `files` row shape. Mirrors the {@link FileRow} interface. */
const FileRowSchema = z.object({
  path: z.string(),
  content_hash: z.string(),
  language: z.string(),
  size: z.number(),
  modified_at: z.number(),
  indexed_at: z.number(),
  node_count: z.number(),
  errors: z.string().nullable(),
  commit_count: z.number().nullable(),
  loc: z.number().nullable(),
  first_seen_ts: z.number().nullable(),
  last_touched_ts: z.number().nullable(),
  is_test: z.number(),
  needs_reextract: z.number(),
}) satisfies z.ZodType<FileRow>;

/** Path-projection row shape — for queries that only `SELECT path`. */
const PathOnlyRowSchema = z.object({ path: z.string() });

const NoParams = z.object({});

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const _upsertFileUpdateSets = Object.keys(FILE_RECORD_SCHEMA)
  .map((k) => {
    const spec = (FILE_RECORD_SCHEMA as Record<string, unknown>)[k];
    const col = typeof spec === 'string' ? spec : (spec as { col: string }).col;
    if (col === 'path') return null;
    if (FILE_CHURN_MANAGED_COLS.includes(col)) return null;
    return `${col} = @${k}`;
  })
  .filter((s): s is string => s !== null)
  .join(', ');

const upsertFileQuery = defineQuery({
  sql:
    `INSERT INTO files (${FILE_INSERT_PARTS.columns}) ` +
    `VALUES (${FILE_INSERT_PARTS.bindings}) ` +
    `ON CONFLICT(path) DO UPDATE SET ${_upsertFileUpdateSets}`,
  params: UpsertFileParamsSchema,
  row: z.never(),
});

const deleteFileNodesQuery = defineQuery({
  sql: 'DELETE FROM nodes WHERE file_path = @filePath',
  params: z.object({ filePath: z.string() }),
  row: z.never(),
});

const zeroFileNodeCountQuery = defineQuery({
  sql: 'UPDATE files SET node_count = 0 WHERE path = @path',
  params: z.object({ path: z.string() }),
  row: z.never(),
});

const deleteFileQuery = defineQuery({
  sql: 'DELETE FROM files WHERE path = @path',
  params: z.object({ path: z.string() }),
  row: z.never(),
});

const getFileByPathQuery = defineQuery({
  sql: 'SELECT * FROM files WHERE path = @path',
  params: z.object({ path: z.string() }),
  row: FileRowSchema,
});

const getAllFilesQuery = defineQuery({
  sql: 'SELECT * FROM files ORDER BY path',
  params: NoParams,
  row: FileRowSchema,
});

const getAllFilePathsQuery = defineQuery({
  sql: 'SELECT path FROM files ORDER BY path',
  params: NoParams,
  row: PathOnlyRowSchema,
});

const getFilesNeedingReextractQuery = defineQuery({
  sql: 'SELECT path FROM files WHERE needs_reextract = 1',
  params: NoParams,
  row: PathOnlyRowSchema,
});

const updateFileLocQuery = defineQuery({
  sql: 'UPDATE files SET loc = @loc WHERE path = @path',
  params: z.object({ path: z.string(), loc: z.number() }),
  row: z.never(),
});

// Correlated WHERE clause shared between reconcile queries — kept as a
// single string so a future drift-predicate refinement lands in both.
const _RECONCILE_DRIFT_PREDICATE = `node_count != (
        SELECT COUNT(*) FROM nodes WHERE nodes.file_path = files.path
      )`;

const findDriftedFilesQuery = defineQuery({
  sql: `SELECT path FROM files WHERE ${_RECONCILE_DRIFT_PREDICATE}`,
  params: NoParams,
  row: PathOnlyRowSchema,
});

const markDriftedFilesNeedReextractQuery = defineQuery({
  sql: `UPDATE files SET needs_reextract = 1 WHERE ${_RECONCILE_DRIFT_PREDICATE}`,
  params: NoParams,
  row: z.never(),
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    upsertFile?: TypedQuery<UpsertFileParams, never>;
    deleteFileNodes?: TypedQuery<{ filePath: string }, never>;
    zeroFileNodeCount?: TypedQuery<{ path: string }, never>;
    deleteFile?: TypedQuery<{ path: string }, never>;
    getFileByPath?: TypedQuery<{ path: string }, FileRow>;
    getAllFiles?: TypedQuery<Record<string, never>, FileRow>;
    getAllFilePaths?: TypedQuery<Record<string, never>, { path: string }>;
    getFilesNeedingReextract?: TypedQuery<Record<string, never>, { path: string }>;
    updateFileLoc?: TypedQuery<{ path: string; loc: number }, never>;
    findDriftedFiles?: TypedQuery<Record<string, never>, { path: string }>;
    markDriftedFilesNeedReextract?: TypedQuery<Record<string, never>, never>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Insert or update a file record.
 *
 * Churn columns (commit_count, loc, first_seen_ts, last_touched_ts)
 * are deliberately omitted from the ON CONFLICT update list — they
 * are managed exclusively by `applyChurnDeltas` / `applyLocUpdates`.
 * Adding them here would clobber mined git history on every re-index.
 */
export function upsertFile(qb: QueryBuilder, file: FileRecord): void {
  qb.queries.upsertFile ??= upsertFileQuery(qb.db);
  qb.queries.upsertFile.run(bindingsFromObject(file, FILE_RECORD_SCHEMA) as UpsertFileParams);
}

/**
 * Delete a file's `nodes` (and their cascaded `edges` / `unresolved_refs`)
 * WITHOUT touching the `files` row.
 *
 * The file's `nodes` are deleted EXPLICITLY — not left to the
 * `nodes.file_path → files(path)` ON DELETE CASCADE. Migration 056 was
 * meant to add that FK but silently rebuilt `nodes` without it (its
 * FK-injection regex didn't match an ALTER-mangled CREATE), so on every
 * upgraded DB the cascade was a no-op and re-extraction accumulated
 * thousands of duplicate nodes. Migration 064 restores the FK; this
 * explicit DELETE makes node cleanup correct regardless — node removal
 * must not depend on a constraint a future rebuild migration can
 * silently drop again. Deleting the `nodes` rows still cascades their
 * own `edges` / `unresolved_refs` via the FKs on `nodes.id`. The
 * in-process node cache (which no cascade reaches) is mirrored too.
 *
 * The `files` row is left in place — used by the re-extract evict path
 * ({@link removeFileFromIndexInTx}), which re-`upsertFile`s the same
 * path immediately afterwards. Keeping the row lets `upsertFile` take
 * its ON CONFLICT UPDATE branch, which deliberately preserves the
 * churn-managed columns (`commit_count` / `first_seen_ts` /
 * `last_touched_ts` / `loc`). A full delete+reinsert would instead take
 * the INSERT branch, where those columns fall back to their schema
 * defaults — silently wiping mined git history on every sync that
 * touches the file.
 *
 * `files.node_count` is zeroed alongside the node wipe. The re-extract
 * path immediately `upsertFile`s the same path with a fresh
 * `node_count = result.nodes.length`, so the zero is transient there.
 * But if the follow-up upsert never lands — a re-extract that aborts
 * after the evict, or a node wipe with no re-extract behind it — the
 * surviving row would otherwise keep a stale positive `node_count`
 * while owning zero `nodes`. That orphan ("row claims N symbols, owns
 * 0") corrupts every `files.node_count`-derived figure
 * (`getAllFilesWithSymbolCount`, the digest headline) and is invisible
 * to a content-hash sync (the file's disk content never moved, so the
 * re-extract is never re-queued). Zeroing here keeps `node_count`
 * consistent with the `nodes` table at all times.
 */
export function deleteFileNodes(qb: QueryBuilder, filePath: string): void {
  qb.db.transaction(() => {
    qb.invalidateNodeCacheForFile(filePath);
    qb.queries.deleteFileNodes ??= deleteFileNodesQuery(qb.db);
    qb.queries.deleteFileNodes.run({ filePath });
    qb.queries.zeroFileNodeCount ??= zeroFileNodeCountQuery(qb.db);
    qb.queries.zeroFileNodeCount.run({ path: filePath });
  })();
}

/**
 * Delete a file record and its nodes.
 *
 * Builds on {@link deleteFileNodes} (see its JSDoc for why node
 * removal is explicit) and additionally drops the `files` row. Use
 * this for a genuine file removal — a path deleted from disk. The
 * re-extract path must NOT use this: it would discard the mined churn
 * columns (see {@link deleteFileNodes}); it calls `deleteFileNodes`
 * instead and lets the follow-up `upsertFile` reuse the surviving row.
 */
export function deleteFile(qb: QueryBuilder, filePath: string): void {
  qb.db.transaction(() => {
    deleteFileNodes(qb, filePath);
    qb.queries.deleteFile ??= deleteFileQuery(qb.db);
    qb.queries.deleteFile.run({ path: filePath });
  })();
}

/**
 * Evict a file's prior extraction for a re-extract — the
 * no-transaction core.
 *
 * Two steps, one domain rule ("re-extract a file"):
 *   1. Reconstruct the cross-file `unresolved_refs` that targeted this
 *      file's nodes, so edges from *unmodified* files survive a later
 *      re-resolve (the cascade-delete in step 2 would otherwise strand
 *      them — the refs that produced them were already pruned).
 *   2. Cascade-delete the file's nodes — but NOT the `files` row.
 *
 * The `files` row is deliberately retained: the re-extract path calls
 * this then immediately `upsertFile`s the same path. Keeping the row
 * routes that upsert through ON CONFLICT UPDATE, which preserves the
 * churn-managed columns. A full row delete here (the pre-fix behaviour)
 * forced the follow-up upsert down the INSERT path, resetting
 * `commit_count` / `first_seen_ts` / `last_touched_ts` to their schema
 * defaults — so every sync that touched a file silently wiped its
 * mined git history, leaving `hotspots` permanently empty.
 *
 * The caller MUST already hold a transaction. For a standalone
 * removal (a path actually deleted from disk) call
 * {@link removeFileFromIndex}, which fully drops the row.
 *
 * Keeping the two steps in one helper means a future third step (evict
 * `embedding_store` rows, drop summary refs) lands in every eviction
 * site at once instead of being added to some and missed in others.
 */
export function removeFileFromIndexInTx(qb: QueryBuilder, filePath: string): void {
  reconstructCrossFileRefsToFile(qb, filePath);
  deleteFileNodes(qb, filePath);
}

/**
 * Fully remove a file from the index — for standalone removals (sync
 * reaping a path deleted or vanished from disk). Wraps the cross-file
 * ref reconstruction, the node cascade-delete, AND the `files` row
 * drop in one transaction.
 *
 * Unlike {@link removeFileFromIndexInTx} (the re-extract evict, which
 * keeps the `files` row for an immediate re-upsert), this drops the
 * row outright — the file is gone, so its mined churn has no path to
 * carry forward to.
 */
export function removeFileFromIndex(qb: QueryBuilder, filePath: string): void {
  qbTransaction(qb, () => {
    reconstructCrossFileRefsToFile(qb, filePath);
    deleteFile(qb, filePath);
  });
}

/**
 * Get a file record by path
 */
export function getFileByPath(qb: QueryBuilder, filePath: string): FileRecord | null {
  qb.queries.getFileByPath ??= getFileByPathQuery(qb.db);
  const row = qb.queries.getFileByPath.get({ path: filePath });
  return row ? rowToFileRecord(row) : null;
}

/**
 * Get all tracked files
 */
export function getAllFiles(qb: QueryBuilder): FileRecord[] {
  qb.queries.getAllFiles ??= getAllFilesQuery(qb.db);
  const rows = qb.queries.getAllFiles.all({});
  return rows.map(rowToFileRecord);
}

/**
 * All tracked files with `nodeCount` reduced to true symbol count.
 *
 * `files.node_count` counts every node the extractor emitted for the
 * file — which includes the file's own `kind='file'` node, exactly one
 * per file. Surfaces that label this figure "symbols" (`cartograph_files`,
 * the `cartograph files` CLI) must subtract that node so the count is a
 * true symbol count, reconcilable with a `kind != 'file'` SQL count.
 * Doing the correction here keeps it in one place rather than open-coded
 * at each call site. Structural consumers that want the raw extractor
 * node count keep calling {@link getAllFiles}.
 */
export function getAllFilesWithSymbolCount(qb: QueryBuilder): FileRecord[] {
  return getAllFiles(qb).map((f) => ({
    ...f,
    nodeCount: Math.max(0, f.nodeCount - 1),
  }));
}

/**
 * Get all tracked file paths (lightweight — no full FileRecord objects)
 */
export function getAllFilePaths(qb: QueryBuilder): string[] {
  qb.queries.getAllFilePaths ??= getAllFilePathsQuery(qb.db);
  return qb.queries.getAllFilePaths.all({}).map((r) => r.path);
}

/**
 * Tracked files marked by the EXTRACTION_LOGIC_VERSION self-heal as
 * "re-extract regardless of content_hash." Used by the sync orchestrator's
 * git fast-path to union heal-marked files into the change set — git diff
 * never reports them (their disk content is unchanged), so the heal would
 * otherwise be a no-op in any git-tracked project.
 */
export function getFilesNeedingReextract(qb: QueryBuilder): string[] {
  qb.queries.getFilesNeedingReextract ??= getFilesNeedingReextractQuery(qb.db);
  return qb.queries.getFilesNeedingReextract.all({}).map((r) => r.path);
}

/** Bulk LOC update — used during indexAll to refresh LOC for every indexed file. */
export function applyLocUpdates(qb: QueryBuilder, entries: Iterable<{ path: string; loc: number }>): void {
  qb.queries.updateFileLoc ??= updateFileLocQuery(qb.db);
  const stmt = qb.queries.updateFileLoc;
  qb.db.transaction(() => {
    for (const e of entries) stmt.run({ path: e.path, loc: e.loc });
  })();
}

/**
 * Per-file `node_count` integrity sweep — detect `files` rows whose
 * stored `node_count` disagrees with the actual count of `nodes` rows
 * owning that path, and flag each for re-extraction (`needs_reextract = 1`).
 *
 * The drift this catches: a node wipe that left no surviving extraction
 * behind it (a re-extract that aborted after the evict, an interrupted
 * sync) leaves a `files` row claiming N symbols while owning 0 — or, in
 * the reverse direction, a stale higher/lower count. Such a row is
 * INVISIBLE to a content-hash sync: the file's disk content never
 * moved, so the diff never re-queues it and the orphan persists across
 * every incremental sync forever. {@link deleteFileNodes} now zeroes
 * `node_count` on every wipe so new orphans can't form, but a DB that
 * already accumulated drift before that fix needs this one-shot heal.
 *
 * Setting `needs_reextract = 1` routes each drifted file through the
 * sync git-fast-path's heal-flag union (see `getFilesNeedingReextract`),
 * which re-extracts it and `upsertFile`s a correct `node_count`.
 *
 * Returns the list of paths flagged, so the caller can log the heal.
 * Cheap — one correlated-count UPDATE over the `files` table.
 */
export function reconcileFileNodeCounts(qb: QueryBuilder): string[] {
  qb.queries.findDriftedFiles ??= findDriftedFilesQuery(qb.db);
  const drifted = qb.queries.findDriftedFiles.all({});
  if (drifted.length === 0) return [];
  qb.queries.markDriftedFilesNeedReextract ??= markDriftedFilesNeedReextractQuery(qb.db);
  qb.queries.markDriftedFilesNeedReextract.run({});
  return drifted.map((r) => r.path);
}
