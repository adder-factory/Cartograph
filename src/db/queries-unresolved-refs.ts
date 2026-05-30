/**
 * Unresolved-reference queries — the `unresolved_refs` table that
 * records cross-symbol references the extractor couldn't bind to a
 * concrete `nodes.id` at parse time. The resolver iterates this
 * table to materialise `calls` / `references` / etc. edges.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain unresolved-ref helpers as direct members. The
 * functions read / write the `unresolved_refs` table via the
 * `@internal`-tagged `db` and `queries` fields on the parent
 * `QueryBuilder`. Prepared statements are declared at module scope
 * via {@link defineQuery} — Zod schemas drive both compile-time and
 * runtime validation of params + rows. Lazy-cached on `qb.queries.X`
 * to mirror the existing `qb.stmts.X` pattern.
 *
 * Variable IN-list sites use Pattern A — `IN (SELECT value FROM
 * json_each(@arr))` with the array JSON-stringified into a single
 * named param. Keeps the SQL static so `defineQuery` can wrap it
 * without paying the placeholder-count combinatorial cost.
 */

import { z } from 'zod';
import type { UnresolvedReference, Language, EdgeKind } from '../types.js';
import { bindingsFromObject } from './row-mapper.js';
import {
  type QueryBuilder,
  type UnresolvedRefRow,
  rowToUnresolvedRef,
  UNRESOLVED_REF_SCHEMA,
  UNRESOLVED_INSERT_PARTS,
} from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

/**
 * Shape of the bindings dict passed to `qb.queries.insertUnresolved.run(...)`
 * — every key the SQL's `@bind` list references. Built from
 * `bindingsFromObject(ref, UNRESOLVED_REF_SCHEMA)` with four explicit
 * overrides on top (`filePath`, `language`, `siteCount`, `extraLines`).
 */
const InsertUnresolvedParamsSchema = z.object({
  fromNodeId: z.string(),
  referenceName: z.string(),
  referenceKind: z.string(),
  line: z.number(),
  column: z.number(),
  candidates: z.string().nullable(),
  filePath: z.string(),
  language: z.string(),
  siteCount: z.number(),
  extraLines: z.string().nullable(),
});

type InsertUnresolvedParams = z.infer<typeof InsertUnresolvedParamsSchema>;

/** SQLite-side `unresolved_refs` row shape. Mirrors the {@link UnresolvedRefRow} interface. */
const UnresolvedRefRowSchema = z.object({
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
}) satisfies z.ZodType<UnresolvedRefRow>;

/** Shape of the aliased SELECT used by `reconstructCrossFileRefsToFile`. */
const ReconstructRowSchema = z.object({
  fromNodeId: z.string(),
  referenceName: z.string(),
  referenceKind: z.string(),
  line: z.number(),
  column: z.number(),
  filePath: z.string(),
  language: z.string(),
});

type ReconstructRow = z.infer<typeof ReconstructRowSchema>;

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const insertUnresolvedQuery = defineQuery({
  sql:
    `INSERT INTO unresolved_refs (${UNRESOLVED_INSERT_PARTS.columns}) ` +
    `VALUES (${UNRESOLVED_INSERT_PARTS.bindings})`,
  params: InsertUnresolvedParamsSchema,
  row: z.never(),
});

const getAllUnresolvedQuery = defineQuery({
  sql: 'SELECT * FROM unresolved_refs',
  params: z.object({}),
  row: UnresolvedRefRowSchema,
});

const getUnresolvedCountQuery = defineQuery({
  sql: 'SELECT COUNT(*) as count FROM unresolved_refs',
  params: z.object({}),
  row: z.object({ count: z.number() }),
});

const getUnresolvedBatchQuery = defineQuery({
  sql: 'SELECT * FROM unresolved_refs LIMIT @limit OFFSET @offset',
  params: z.object({ limit: z.number(), offset: z.number() }),
  row: UnresolvedRefRowSchema,
});

/**
 * Edge kinds that originate from `unresolved_refs` resolution. Edges
 * outside this set (e.g. `imports`, `contains`, `tests`, `similar_to`,
 * `def_use`, `exports`) are produced by other paths and don't need
 * unresolved-ref reconstruction.
 */
const RESOLVABLE_EDGE_KINDS = [
  'calls',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'extends',
  'implements',
  'overrides',
  'field_access',
  'decorates',
] as const;

// Built once at module load — RESOLVABLE_EDGE_KINDS is `as const`, so
// the interpolation is a static string literal at every call site.
const _RECONSTRUCT_KIND_LIST = RESOLVABLE_EDGE_KINDS.map((k) => `'${k}'`).join(',');

const reconstructCrossFileRefsQuery = defineQuery({
  sql: `SELECT
       e.source AS fromNodeId,
       n_target.name AS referenceName,
       e.kind AS referenceKind,
       COALESCE(e.line, 0) AS line,
       COALESCE(e.col, 0) AS column,
       n_source.file_path AS filePath,
       n_source.language AS language
     FROM edges e
     JOIN nodes n_target ON n_target.id = e.target
     JOIN nodes n_source ON n_source.id = e.source
     WHERE n_target.file_path = @filePath
       AND n_source.file_path != @filePath
       AND e.kind IN (${_RECONSTRUCT_KIND_LIST})`,
  params: z.object({ filePath: z.string() }),
  row: ReconstructRowSchema,
});

const deleteSpecificResolvedQuery = defineQuery({
  sql:
    'DELETE FROM unresolved_refs WHERE from_node_id = @fromNodeId ' +
    'AND reference_name = @referenceName AND reference_kind = @referenceKind',
  params: z.object({
    fromNodeId: z.string(),
    referenceName: z.string(),
    referenceKind: z.string(),
  }),
  row: z.never(),
});

const getUnresolvedByFilesQuery = defineQuery({
  sql: 'SELECT * FROM unresolved_refs ' + 'WHERE file_path IN (SELECT value FROM json_each(@filePathsJson))',
  params: z.object({ filePathsJson: z.string() }),
  row: UnresolvedRefRowSchema,
});

const getUnresolvedByDefiningFilesQuery = defineQuery({
  sql: `SELECT u.* FROM unresolved_refs u
     WHERE u.reference_name IN (
             SELECT DISTINCT n.name FROM nodes n
              WHERE n.file_path IN (SELECT value FROM json_each(@filePathsJson))
                AND n.kind NOT IN ('file', 'import', 'export')
           )
       AND u.file_path NOT IN (SELECT value FROM json_each(@filePathsJson))`,
  params: z.object({ filePathsJson: z.string() }),
  row: UnresolvedRefRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    insertUnresolved?: TypedQuery<InsertUnresolvedParams, never>;
    getAllUnresolved?: TypedQuery<Record<string, never>, UnresolvedRefRow>;
    getUnresolvedCount?: TypedQuery<Record<string, never>, { count: number }>;
    getUnresolvedBatch?: TypedQuery<{ limit: number; offset: number }, UnresolvedRefRow>;
    reconstructCrossFileRefs?: TypedQuery<{ filePath: string }, ReconstructRow>;
    deleteSpecificResolved?: TypedQuery<{ fromNodeId: string; referenceName: string; referenceKind: string }, never>;
    getUnresolvedByFiles?: TypedQuery<{ filePathsJson: string }, UnresolvedRefRow>;
    getUnresolvedByDefiningFiles?: TypedQuery<{ filePathsJson: string }, UnresolvedRefRow>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Insert an unresolved reference
 */
function insertUnresolvedRef(qb: QueryBuilder, ref: UnresolvedReference): void {
  qb.queries.insertUnresolved ??= insertUnresolvedQuery(qb.db);

  qb.queries.insertUnresolved.run({
    ...bindingsFromObject(ref, UNRESOLVED_REF_SCHEMA),
    // Defaults the schema can't supply: empty path / unknown
    // language / single-site for legacy callers; empty
    // extraLines arrays serialise to NULL (not '[]') to keep the
    // column nullable-vs-empty distinction.
    filePath: ref.filePath ?? '',
    language: ref.language ?? 'unknown',
    siteCount: ref.siteCount ?? 1,
    extraLines: ref.extraLines && ref.extraLines.length > 0 ? JSON.stringify(ref.extraLines) : null,
  } as InsertUnresolvedParams);
}

/**
 * Insert multiple unresolved references in a transaction
 */
export function insertUnresolvedRefsBatch(qb: QueryBuilder, refs: UnresolvedReference[]): void {
  if (refs.length === 0) return;
  const insert = qb.db.transaction(() => {
    for (const ref of refs) {
      insertUnresolvedRef(qb, ref);
    }
  });
  insert();
}

// (deleteUnresolvedByNode removed — never called; FK cascade on
// nodes(id) → unresolved_refs.from_node_id handles cleanup automatically.)

/**
 * Get all unresolved references
 */
export function getUnresolvedReferences(qb: QueryBuilder): UnresolvedReference[] {
  qb.queries.getAllUnresolved ??= getAllUnresolvedQuery(qb.db);
  const rows = qb.queries.getAllUnresolved.all({});
  return rows.map(rowToUnresolvedRef);
}

/**
 * Get the count of unresolved references without loading them into memory
 */
export function getUnresolvedReferencesCount(qb: QueryBuilder): number {
  qb.queries.getUnresolvedCount ??= getUnresolvedCountQuery(qb.db);
  const row = qb.queries.getUnresolvedCount.get({});
  return row?.count ?? 0;
}

/**
 * Get a batch of unresolved references using LIMIT/OFFSET pagination.
 * Used to process references in bounded memory chunks.
 */
export function getUnresolvedReferencesBatch(qb: QueryBuilder, offset: number, limit: number): UnresolvedReference[] {
  qb.queries.getUnresolvedBatch ??= getUnresolvedBatchQuery(qb.db);
  const rows = qb.queries.getUnresolvedBatch.all({ limit, offset });
  return rows.map(rowToUnresolvedRef);
}

/**
 * Get unresolved references scoped to specific file paths.
 * Uses the idx_unresolved_file_path index for efficient lookup.
 *
 * Pattern A — `file_path IN (SELECT value FROM json_each(@filePathsJson))`
 * keeps the SQL static so `defineQuery` can wrap it.
 */
export function getUnresolvedReferencesByFiles(qb: QueryBuilder, filePaths: string[]): UnresolvedReference[] {
  if (filePaths.length === 0) return [];

  qb.queries.getUnresolvedByFiles ??= getUnresolvedByFilesQuery(qb.db);
  const rows = qb.queries.getUnresolvedByFiles.all({
    filePathsJson: JSON.stringify(filePaths),
  });
  return rows.map(rowToUnresolvedRef);
}

/**
 * Unresolved refs whose `reference_name` matches any symbol defined
 * in `changedFilePaths` AND whose own `file_path` is OUTSIDE that
 * set. Used by `cgSyncResolveReferences` to catch the rename / new-
 * export case: a function gets renamed in file A, callers in B/C/D
 * have unresolved refs that were never rechecked because B/C/D
 * weren't themselves modified in this sync. Those refs land here.
 *
 * The dedup-by-rowid SELECT preserves the ref's original file_path
 * scoping; intersection with file/name is computed in SQL so we
 * never load the full unresolved table when only a handful of
 * symbols moved.
 *
 * Pattern A — the same `@filePathsJson` named param feeds both
 * `json_each(...)` lookups, so the SQL is static.
 */
export function getUnresolvedReferencesByDefiningFiles(
  qb: QueryBuilder,
  changedFilePaths: string[],
): UnresolvedReference[] {
  if (changedFilePaths.length === 0) return [];
  qb.queries.getUnresolvedByDefiningFiles ??= getUnresolvedByDefiningFilesQuery(qb.db);
  const rows = qb.queries.getUnresolvedByDefiningFiles.all({
    filePathsJson: JSON.stringify(changedFilePaths),
  });
  return rows.map(rowToUnresolvedRef);
}

/**
 * Reconstruct unresolved_refs for cross-file edges that target nodes
 * in `filePath`. Call BEFORE deleting `filePath`'s nodes during
 * incremental re-extraction.
 *
 * The lifecycle gap: `resolveAndPersist` deletes the
 * unresolved_ref row after a successful first-pass resolution. When
 * `filePath` is later re-extracted, its nodes are deleted and the
 * incoming cross-file edges cascade away — but no unresolved_ref
 * record remains for Pass B to re-resolve. The fix is to
 * reverse-engineer the unresolved_refs from the existing edges
 * before they cascade-delete, so the resolver can rebind them
 * against the freshly-extracted nodes.
 *
 * Only `RESOLVABLE_EDGE_KINDS` are reconstructed — `imports` /
 * `contains` / `tests` / etc. are produced by other paths and don't
 * need this round-trip.
 *
 * `imports` edges where source = a file's import_node land in the
 * importing file's deletion set anyway (the import_node is inside
 * the imported FROM file's content, not the imported TO file), so
 * they're naturally re-extracted. Skip.
 *
 * **Limitations of reconstruction**: the original UnresolvedReference
 * may have carried `siteCount > 1` (multiple call sites coalesced via
 * `dedupeReferences`) and an `extraLines` array. Edges only carry the
 * primary `(line, col)` pair, so reconstructed refs always have
 * `siteCount = 1` and no `extraLines`. Resolution itself still
 * succeeds (only `(fromNodeId, name, kind)` is needed to rebind), but
 * any site-count-dependent biomarker fidelity is silently reduced
 * after a re-extraction round-trip.
 */
export function reconstructCrossFileRefsToFile(qb: QueryBuilder, filePath: string): void {
  qb.queries.reconstructCrossFileRefs ??= reconstructCrossFileRefsQuery(qb.db);
  // INNER JOIN on n_source: an orphaned edge whose source node was
  // deleted (FK violation in practice — `foreign_keys = ON` prevents
  // it, but be explicit) can't be reconstructed because the
  // unresolved_refs FK on `from_node_id` would reject the row.
  const rows = qb.queries.reconstructCrossFileRefs.all({ filePath });
  if (rows.length === 0) return;
  insertUnresolvedRefsBatch(
    qb,
    rows.map((r) => ({
      fromNodeId: r.fromNodeId,
      referenceName: r.referenceName,
      referenceKind: r.referenceKind as EdgeKind,
      line: r.line,
      column: r.column,
      filePath: r.filePath,
      language: r.language as Language,
    })),
  );
}

/**
 * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
 * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
 */
export function deleteSpecificResolvedReferences(
  qb: QueryBuilder,
  refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>,
): void {
  if (refs.length === 0) return;
  qb.queries.deleteSpecificResolved ??= deleteSpecificResolvedQuery(qb.db);
  const stmt = qb.queries.deleteSpecificResolved;
  const deleteMany = qb.db.transaction((items: typeof refs) => {
    for (const ref of items) {
      stmt.run(ref);
    }
  });
  deleteMany(refs);
}
