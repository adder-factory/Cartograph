/**
 * Per-file summary queries (the LLM-generated file-level prose
 * descriptions stored in `file_summaries`).
 *
 * The `file_summaries` table is the summary tier BETWEEN symbol and
 * directory: one paragraph per file, rolled up from the file's symbol
 * summaries by `src/llm/file-summarizer.ts`. Mirrors
 * `queries-directory-summaries.ts` — the difference is the FK to
 * `files(path)`: a deleted/renamed file drops its summary by cascade,
 * so `pruneOrphanFileSummaries` is a belt-and-suspenders pass for the
 * case where FK enforcement is off rather than the primary GC.
 *
 * Prompt-injection note: the file-summary text embeds LLM-generated
 * symbol summaries verbatim. Same accepted risk as the directory tier
 * — all data originates from the user's own codebase; don't forward
 * `file_summaries` text to untrusted external systems unsanitised.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

/** Return type shared by file-summary and directory-summary single-row lookups. */
export interface SummaryRecord {
  summary: string;
  contentHash: string;
  model: string;
}

/** The two summary tables `getSummaryByKey` reads, and their key columns.
 *  Closed unions — NOT free strings — so `table` / `keyColumn` can never
 *  carry a caller-supplied value into the interpolated SQL below. */
type SummaryTable = 'file_summaries' | 'directory_summaries';
type SummaryKeyColumn = 'file_path' | 'dir_path';

interface GetSummaryByKeyArgs {
  qb: QueryBuilder;
  /** Which summary table to read. */
  table: SummaryTable;
  /** The primary-key column in that table. */
  keyColumn: SummaryKeyColumn;
  /** Value to match on `keyColumn`. */
  keyValue: string;
}

// ─── Zod schemas + typed query definitions ────────────────────────────────

const SummaryByKeyRowSchema = z.object({
  summary: z.string(),
  content_hash: z.string(),
  model: z.string(),
});

type SummaryByKeyRow = z.infer<typeof SummaryByKeyRowSchema>;

const KeyValueParamsSchema = z.object({ keyValue: z.string() });
type KeyValueParams = z.infer<typeof KeyValueParamsSchema>;

// One typed query per (table, keyColumn) combination so the SQL is
// static for {@link defineQuery}. The two closed unions admit only the
// two real pairings; a future third table would slot in here.
const getFileSummaryByKeyQuery = defineQuery({
  sql: 'SELECT summary, content_hash, model FROM file_summaries WHERE file_path = @keyValue',
  params: KeyValueParamsSchema,
  row: SummaryByKeyRowSchema,
});

const getDirectorySummaryByKeyQuery = defineQuery({
  sql: 'SELECT summary, content_hash, model FROM directory_summaries WHERE dir_path = @keyValue',
  params: KeyValueParamsSchema,
  row: SummaryByKeyRowSchema,
});

/**
 * Generic single-row summary lookup shared by `getFileSummary` and
 * `getDirectorySummary`. Both tables store identical `summary /
 * content_hash / model` columns; only the table name and key column
 * differ. Centralising the query here eliminates the clone finding on
 * those two public helpers.
 */
export function getSummaryByKey(args: GetSummaryByKeyArgs): SummaryRecord | null {
  const { qb, table, keyValue } = args;
  let row: SummaryByKeyRow | undefined;
  if (table === 'file_summaries') {
    qb.queries.getFileSummaryByKey ??= getFileSummaryByKeyQuery(qb.db);
    row = qb.queries.getFileSummaryByKey.get({ keyValue });
  } else {
    qb.queries.getDirectorySummaryByKey ??= getDirectorySummaryByKeyQuery(qb.db);
    row = qb.queries.getDirectorySummaryByKey.get({ keyValue });
  }
  if (!row) return null;
  return { summary: row.summary, contentHash: row.content_hash, model: row.model };
}

/** Read a single file's cached summary, or null. */
export function getFileSummary(qb: QueryBuilder, filePath: string): SummaryRecord | null {
  return getSummaryByKey({ qb, table: 'file_summaries', keyColumn: 'file_path', keyValue: filePath });
}

/** All file summaries (for cartograph status / explore). */
export function getAllFileSummaries(qb: QueryBuilder): Array<{ filePath: string; summary: string }> {
  qb.queries.getAllFileSummaries ??= getAllFileSummariesQuery(qb.db);
  const rows = qb.queries.getAllFileSummaries.all({});
  return rows.map((r) => ({ filePath: r.file_path, summary: r.summary }));
}

/**
 * Batch-read file summaries for a set of paths into a `path → summary`
 * map, in a single `WHERE file_path IN (...)` query. Used by
 * `cartograph_files` to fold the per-file paragraph into a filtered
 * listing. Paths absent from `file_summaries` are simply missing from
 * the map. The caller (`cartograph_files`) already caps the path list
 * at 80 entries, well under SQLite's bound-parameter limit.
 */
export function getFileSummaries(qb: QueryBuilder, filePaths: ReadonlyArray<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (filePaths.length === 0) return out;
  qb.queries.getFileSummariesByPaths ??= getFileSummariesByPathsQuery(qb.db);
  const rows = qb.queries.getFileSummariesByPaths.all({
    filePathsJson: JSON.stringify(filePaths),
  });
  for (const r of rows) out.set(r.file_path, r.summary);
  return out;
}

interface UpsertFileSummaryArgs {
  qb: QueryBuilder;
  filePath: string;
  contentHash: string;
  summary: string;
  model: string;
}

/**
 * Insert or replace a file summary, keyed on file_path.
 *
 * FK-safe per the repo convention (`upsertSymbolSummary` /
 * `upsertSymbolEmbedding`): the write is guarded by
 * `EXISTS (files WHERE path = ?)` so a sync that deleted the file
 * between the summarizer's row capture and this write produces a
 * zero-row no-op instead of an FK constraint error from the
 * `file_summaries → files(path)` foreign key. Returns `true` when a
 * row was written, `false` when the parent file was gone mid-flight —
 * the caller treats `false` as a skip, NOT an error.
 */
export function upsertFileSummary(args: UpsertFileSummaryArgs): boolean {
  const { qb, filePath, contentHash, summary, model } = args;
  qb.queries.upsertFileSummary ??= upsertFileSummaryQuery(qb.db);
  const info = qb.queries.upsertFileSummary.run({
    filePath,
    summary,
    contentHash,
    model,
    generatedAt: Date.now(),
  });
  return info.changes > 0;
}

/**
 * Garbage-collect `file_summaries` rows whose `file_path` no longer
 * corresponds to any indexed file.
 *
 * The FK `ON DELETE CASCADE` to `files(path)` already removes a row
 * when its file is deleted from the index — *provided FK enforcement
 * is on* for the connection that did the delete. This pass is the
 * belt-and-suspenders fallback for the case where it wasn't, and keeps
 * the file tier's lifecycle symmetric with `pruneOrphanDirectorySummaries`.
 *
 * Safe to call AFTER `summarizeAllFiles` completes; calling during
 * would race the file-summarizer's writes for newly-added files.
 */
export function pruneOrphanFileSummaries(qb: QueryBuilder): { fileSummariesDeleted: number } {
  qb.queries.countFileSummaries ??= countFileSummariesQuery(qb.db);
  const before = qb.queries.countFileSummaries.get({})?.c ?? 0;
  qb.db.exec('DELETE FROM file_summaries WHERE file_path NOT IN (SELECT path FROM files)');
  const after = qb.queries.countFileSummaries.get({})?.c ?? 0;
  return { fileSummariesDeleted: before - after };
}

// ─── Additional typed query definitions ───────────────────────────────────

const NoParamsSchema = z.object({});

const AllFileSummariesRowSchema = z.object({
  file_path: z.string(),
  summary: z.string(),
});
type AllFileSummariesRow = z.infer<typeof AllFileSummariesRowSchema>;

const getAllFileSummariesQuery = defineQuery({
  sql: 'SELECT file_path, summary FROM file_summaries ORDER BY file_path',
  params: NoParamsSchema,
  row: AllFileSummariesRowSchema,
});

const UpsertFileSummaryParamsSchema = z.object({
  filePath: z.string(),
  summary: z.string(),
  contentHash: z.string(),
  model: z.string(),
  generatedAt: z.number(),
});
type UpsertFileSummaryParams = z.infer<typeof UpsertFileSummaryParamsSchema>;

const upsertFileSummaryQuery = defineQuery({
  sql: `INSERT INTO file_summaries (file_path, summary, content_hash, model, generated_at)
     SELECT @filePath, @summary, @contentHash, @model, @generatedAt
     WHERE EXISTS (SELECT 1 FROM files WHERE path = @filePath)
     ON CONFLICT(file_path) DO UPDATE SET
       summary = excluded.summary,
       content_hash = excluded.content_hash,
       model = excluded.model,
       generated_at = excluded.generated_at`,
  params: UpsertFileSummaryParamsSchema,
  row: z.never(),
});

const CountRowSchema = z.object({ c: z.number() });
type CountRow = z.infer<typeof CountRowSchema>;

const countFileSummariesQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS c FROM file_summaries',
  params: NoParamsSchema,
  row: CountRowSchema,
});

// Pattern A — variable IN-list via json_each(@filePathsJson).
const getFileSummariesByPathsQuery = defineQuery({
  sql:
    `SELECT file_path, summary FROM file_summaries ` +
    `WHERE file_path IN (SELECT value FROM json_each(@filePathsJson))`,
  params: z.object({ filePathsJson: z.string() }),
  row: AllFileSummariesRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    getFileSummaryByKey?: TypedQuery<KeyValueParams, SummaryByKeyRow>;
    getDirectorySummaryByKey?: TypedQuery<KeyValueParams, SummaryByKeyRow>;
    getAllFileSummaries?: TypedQuery<Record<string, never>, AllFileSummariesRow>;
    upsertFileSummary?: TypedQuery<UpsertFileSummaryParams, never>;
    countFileSummaries?: TypedQuery<Record<string, never>, CountRow>;
    getFileSummariesByPaths?: TypedQuery<{ filePathsJson: string }, AllFileSummariesRow>;
  }
}
