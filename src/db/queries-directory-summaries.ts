/**
 * Per-directory summary queries (the LLM-generated module-level
 * descriptions stored in `directory_summaries`).
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain helpers as direct members. The functions read /
 * write the `directory_summaries` table via the `@internal`-tagged
 * `db` field on the parent `QueryBuilder`.
 */

import * as path from 'path';
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { getAllFilePaths } from './queries-files.js';
import { getSummaryByKey, type SummaryRecord } from './queries-file-summaries.js';

/** Pull every (file_path, name, kind, description) for symbols that
 *  carry a non-empty description — used to group by directory for the
 *  module-level synthesis pass. Cascade input: LLM summary if present,
 *  else extracted docstring; nodes with neither are skipped. The
 *  source label is dropped before the aggregator sees the rows since
 *  the directory-summarising prompt doesn't condition on per-symbol
 *  provenance.
 *
 *  Rows are ordered by PageRank centrality DESC (NULLs last). The
 *  directory-summary prompt slices the first N symbols per directory
 *  (`MAX_SYMBOLS_IN_PROMPT`); a `file_path` ordering fed it the
 *  alphabetically-first N — for a 67-file directory that is an
 *  unrepresentative sample clustered in a few early files, and the
 *  local model anchors its whole-module description on whatever leads.
 *  Centrality-first makes the sampled-and-lead symbols the directory's
 *  structural spine instead (FRICTION-M, 2026-05-15). `file_path` is
 *  the deterministic tiebreaker. */
export function getSummarisedSymbolsByDir(qb: QueryBuilder): Array<{
  filePath: string;
  name: string;
  kind: string;
  summary: string;
}> {
  qb.queries.getSummarisedSymbolsByDir ??= getSummarisedSymbolsByDirQuery(qb.db);
  const rows = qb.queries.getSummarisedSymbolsByDir.all({});
  return rows.map((r) => ({
    filePath: r.file_path,
    name: r.name,
    kind: r.kind,
    summary: r.summary,
  }));
}

/** Read a single directory's cached summary, or null. */
export function getDirectorySummary(qb: QueryBuilder, dirPath: string): SummaryRecord | null {
  return getSummaryByKey({ qb, table: 'directory_summaries', keyColumn: 'dir_path', keyValue: dirPath });
}

/** All directory summaries (for cartograph status / explore). */
export function getAllDirectorySummaries(qb: QueryBuilder): Array<{ dirPath: string; summary: string }> {
  qb.queries.getAllDirectorySummaries ??= getAllDirectorySummariesQuery(qb.db);
  const rows = qb.queries.getAllDirectorySummaries.all({});
  return rows.map((r) => ({ dirPath: r.dir_path, summary: r.summary }));
}

/**
 * Count `*_TOOL` constant declarations directly inside `dirPath`
 * (immediate children only — not nested sub-directories). This is a
 * STRUCTURAL signal for the directory-summary `mcp_tools` pattern
 * detector: a directory exporting several `XXX_TOOL` `ToolModule`
 * constants is unambiguously an MCP-tool directory.
 *
 * Counted over ALL nodes, NOT the summarised subset. The detector
 * otherwise sees only symbols `getSummarisedSymbolsByDir` returns
 * (those with a summary or docstring), and `*_TOOL` constants rarely
 * carry either — on `src/mcp/tools/` only 2 of 36 qualified, which
 * collapsed the detector's count below its floor (FRICTION-M).
 *
 * `dirPath` is matched on a path-segment boundary so `src/mcp/tools`
 * does not also count files under `src/mcp/tools-foo/`.
 */
export function getDirToolExportConstantCount(qb: QueryBuilder, dirPath: string): number {
  const normDir = dirPath.replace(/\/+$/, '');
  const escaped = normDir.replaceAll(/[\\%_]/g, (ch) => '\\' + ch);
  // `LIKE dir/%` keeps the subtree; `NOT LIKE dir/%/%` drops nested
  // sub-directories so only files immediately inside `dirPath` count —
  // matching how `groupByDir` buckets by the immediate parent dir.
  qb.queries.getDirToolExportConstantCount ??= getDirToolExportConstantCountQuery(qb.db);
  const row = qb.queries.getDirToolExportConstantCount.get({
    likeImmediate: escaped + '/%',
    likeNested: escaped + '/%/%',
  });
  return row?.c ?? 0;
}

interface UpsertDirectorySummaryArgs {
  qb: QueryBuilder;
  dirPath: string;
  contentHash: string;
  summary: string;
  model: string;
}

/** Insert or replace a directory summary, keyed on dir_path. */
export function upsertDirectorySummary(args: UpsertDirectorySummaryArgs): void {
  const { qb, dirPath, contentHash, summary, model } = args;
  qb.queries.upsertDirectorySummary ??= upsertDirectorySummaryQuery(qb.db);
  qb.queries.upsertDirectorySummary.run({
    dirPath,
    summary,
    contentHash,
    model,
    generatedAt: Date.now(),
  });
}

/**
 * Garbage-collect `directory_summaries` rows whose `dir_path` no
 * longer corresponds to any indexed file. These accumulate when a
 * directory is deleted from disk, renamed, or removed via include-
 * pattern changes — the summary row sticks around forever otherwise
 * because there's no FK anchor.
 *
 * Live directories are derived from `files.path`: each indexed file
 * contributes ONLY its immediate parent directory (no ancestor
 * walk). Paths are normalised to posix forward slashes to match
 * how `dir-summarizer.ts:groupByDir` constructs `dir_path`
 * (`path.posix.dirname(filePath.replaceAll(/\\/g, '/'))`). Walking
 * ancestors here would let stale intermediate-dir summaries survive
 * — e.g. a `src` summary written when files lived directly in
 * `src/` but have all since moved into `src/core/` etc.
 *
 * Safe to call AFTER `summarizeAllDirectories` completes. Calling
 * during would race the dir-summarizer's own writes for newly-added
 * dirs.
 */
export function pruneOrphanDirectorySummaries(qb: QueryBuilder): { directorySummariesDeleted: number } {
  return qb.db.transaction(() => {
    const filePaths = getAllFilePaths(qb);

    // Live dirs are EXACTLY the immediate parents of indexed files.
    // Don't walk the ancestor chain: `dir-summarizer.ts:groupByDir`
    // (the only writer of directory_summaries) only emits a summary
    // for `path.posix.dirname(filePath)` — i.e. the directory the
    // file lives directly in. Walking ancestors here would mark
    // intermediate dirs as live and miss orphans like a `src`
    // summary that exists from when files lived directly in `src/`
    // but have since all moved into `src/core/` etc.
    const liveDirs = new Set<string>();
    for (const fp of filePaths) {
      const d = path.posix.dirname(fp.replaceAll('\\', '/'));
      if (d !== '.' && d !== '/' && d !== '') {
        liveDirs.add(d);
      }
    }

    qb.queries.countDirectorySummaries ??= countDirectorySummariesQuery(qb.db);
    const before = qb.queries.countDirectorySummaries.get({})?.c ?? 0;

    // Drop orphan directory summaries by passing the live-dirs set as
    // a JSON array; `json_each(@liveDirs)` materialises it as a virtual
    // table the planner can join against. Replaces the prior DROP-TEMP /
    // CREATE-TEMP / INSERT-loop / DELETE / DROP-TEMP cycle — one typed
    // DELETE, no temp-table DDL, no per-row INSERTs.
    qb.queries.deleteOrphanDirectorySummaries ??= deleteOrphanDirectorySummariesQuery(qb.db);
    qb.queries.deleteOrphanDirectorySummaries.run({
      liveDirs: JSON.stringify(Array.from(liveDirs)),
    });

    const after = qb.queries.countDirectorySummaries.get({})?.c ?? 0;
    return { directorySummariesDeleted: before - after };
  })();
}

// ─── Zod schemas + typed query definitions ────────────────────────────────

const NoParamsSchema = z.object({});

const SummarisedSymbolByDirRowSchema = z.object({
  file_path: z.string(),
  name: z.string(),
  kind: z.string(),
  summary: z.string(),
});
type SummarisedSymbolByDirRow = z.infer<typeof SummarisedSymbolByDirRowSchema>;

const getSummarisedSymbolsByDirQuery = defineQuery({
  sql: `SELECT n.file_path AS file_path, n.name AS name, n.kind AS kind,
            COALESCE(NULLIF(s.summary, ''), NULLIF(n.docstring, '')) AS summary
       FROM nodes n
       LEFT JOIN symbol_summaries s ON s.node_id = n.id
      WHERE COALESCE(NULLIF(s.summary, ''), NULLIF(n.docstring, '')) IS NOT NULL
      ORDER BY n.centrality IS NULL, n.centrality DESC, n.file_path`,
  params: NoParamsSchema,
  row: SummarisedSymbolByDirRowSchema,
});

const AllDirectorySummariesRowSchema = z.object({
  dir_path: z.string(),
  summary: z.string(),
});
type AllDirectorySummariesRow = z.infer<typeof AllDirectorySummariesRowSchema>;

const getAllDirectorySummariesQuery = defineQuery({
  sql: 'SELECT dir_path, summary FROM directory_summaries ORDER BY dir_path',
  params: NoParamsSchema,
  row: AllDirectorySummariesRowSchema,
});

const DirToolExportCountParamsSchema = z.object({
  likeImmediate: z.string(),
  likeNested: z.string(),
});
type DirToolExportCountParams = z.infer<typeof DirToolExportCountParamsSchema>;

const DirToolExportCountRowSchema = z.object({ c: z.number() });
type DirToolExportCountRow = z.infer<typeof DirToolExportCountRowSchema>;

const getDirToolExportConstantCountQuery = defineQuery({
  sql: `SELECT COUNT(*) AS c FROM nodes
      WHERE kind = 'constant'
        AND name LIKE '%\\_TOOL' ESCAPE '\\'
        AND file_path LIKE @likeImmediate ESCAPE '\\'
        AND file_path NOT LIKE @likeNested ESCAPE '\\'`,
  params: DirToolExportCountParamsSchema,
  row: DirToolExportCountRowSchema,
});

const UpsertDirectorySummaryParamsSchema = z.object({
  dirPath: z.string(),
  summary: z.string(),
  contentHash: z.string(),
  model: z.string(),
  generatedAt: z.number(),
});
type UpsertDirectorySummaryParams = z.infer<typeof UpsertDirectorySummaryParamsSchema>;

const upsertDirectorySummaryQuery = defineQuery({
  sql: `INSERT INTO directory_summaries (dir_path, summary, content_hash, model, generated_at)
     VALUES (@dirPath, @summary, @contentHash, @model, @generatedAt)
     ON CONFLICT(dir_path) DO UPDATE SET
       summary = excluded.summary,
       content_hash = excluded.content_hash,
       model = excluded.model,
       generated_at = excluded.generated_at`,
  params: UpsertDirectorySummaryParamsSchema,
  row: z.never(),
});

const CountRowSchema = z.object({ c: z.number() });
type CountRow = z.infer<typeof CountRowSchema>;

const countDirectorySummariesQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS c FROM directory_summaries',
  params: NoParamsSchema,
  row: CountRowSchema,
});

/**
 * Prune directory summaries whose `dir_path` isn't in the live-dirs
 * set passed as a JSON array (`@liveDirs = JSON.stringify([...])`).
 * Replaces an older DROP-TEMP / CREATE-TEMP / per-row INSERT / DELETE
 * cycle — one statement, no temp-table DDL.
 */
const deleteOrphanDirectorySummariesQuery = defineQuery({
  sql: 'DELETE FROM directory_summaries ' + 'WHERE dir_path NOT IN (SELECT value FROM json_each(@liveDirs))',
  params: z.object({ liveDirs: z.string() }),
  row: z.never(),
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    getSummarisedSymbolsByDir?: TypedQuery<Record<string, never>, SummarisedSymbolByDirRow>;
    getAllDirectorySummaries?: TypedQuery<Record<string, never>, AllDirectorySummariesRow>;
    getDirToolExportConstantCount?: TypedQuery<DirToolExportCountParams, DirToolExportCountRow>;
    upsertDirectorySummary?: TypedQuery<UpsertDirectorySummaryParams, never>;
    countDirectorySummaries?: TypedQuery<Record<string, never>, CountRow>;
    deleteOrphanDirectorySummaries?: TypedQuery<{ liveDirs: string }, never>;
  }
}
