import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

export interface TestNameRow {
  filePath: string;
  line: number;
  description: string;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const TestNameRowSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  description: z.string(),
}) satisfies z.ZodType<TestNameRow>;

const getEnclosingTestNameQuery = defineQuery({
  sql: `
    SELECT file_path AS filePath, line, description
    FROM test_names
    WHERE file_path = @filePath AND line <= @line
    ORDER BY line DESC
    LIMIT 1
  `,
  params: z.object({ filePath: z.string(), line: z.number() }),
  row: TestNameRowSchema,
});

const getFilesWithTestNamesQuery = defineQuery({
  sql: 'SELECT DISTINCT file_path FROM test_names',
  params: z.object({}),
  row: z.object({ file_path: z.string() }),
});

const deleteTestNamesForPathQuery = defineQuery({
  sql: 'DELETE FROM test_names WHERE file_path = @filePath',
  params: z.object({ filePath: z.string() }),
  row: z.never(),
});

const insertTestNameQuery = defineQuery({
  sql:
    `INSERT INTO test_names (file_path, line, description) ` +
    // file_path is FK to files; the row is silently dropped if the
    // files row was deleted concurrently between hook scan and write.
    `VALUES (@filePath, @line, @description)`,
  params: z.object({
    filePath: z.string(),
    line: z.number(),
    description: z.string(),
  }),
  row: z.never(),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    getEnclosingTestName?: TypedQuery<{ filePath: string; line: number }, TestNameRow>;
    getFilesWithTestNames?: TypedQuery<Record<string, never>, { file_path: string }>;
    deleteTestNamesForPath?: TypedQuery<{ filePath: string }, never>;
    insertTestName?: TypedQuery<{ filePath: string; line: number; description: string }, never>;
  }
}

/**
 * Find the innermost `it/test/describe(...)` descriptor enclosing a
 * given line in a test file. Returns the test_name row with the
 * largest `line` value that is still `<= queryLine`. Used by the
 * callers renderer (FRICTION-D, 2026-05-14) to anchor test-file
 * call-site rows on the enclosing test case description rather than
 * line 1 of the file.
 *
 * The lookup is a best-effort heuristic: test_names doesn't track
 * scope depth, so the row before the call line is the most likely
 * enclosing descriptor in practice. If two `it()` blocks both have
 * descriptions above the line, the later one wins — which is the
 * desired "innermost" approximation. Returns `null` when no
 * descriptor exists above the line (call sits before the first test).
 */
export function getEnclosingTestName(qb: QueryBuilder, args: { filePath: string; line: number }): TestNameRow | null {
  qb.queries.getEnclosingTestName ??= getEnclosingTestNameQuery(qb.db);
  return qb.queries.getEnclosingTestName.get(args) ?? null;
}

/**
 * Set of file paths the test-name miner extracted at least one
 * `it/test/describe(...)` descriptor from — i.e. files with actual
 * runnable test cases, as opposed to test-flagged support modules
 * (harness, fixtures, type-only files) that carry no test blocks.
 * Returns an empty set when the miner has not run; callers should
 * treat an empty set as "no data" rather than "no test files".
 */
export function getFilesWithTestNames(qb: QueryBuilder): Set<string> {
  qb.queries.getFilesWithTestNames ??= getFilesWithTestNamesQuery(qb.db);
  const rows = qb.queries.getFilesWithTestNames.all({});
  return new Set(rows.map((r) => r.file_path));
}

export function clearAllTestNames(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM test_names');
}

export function deleteTestNamesForPaths(qb: QueryBuilder, paths: ReadonlyArray<string>): void {
  if (paths.length === 0) return;
  qb.queries.deleteTestNamesForPath ??= deleteTestNamesForPathQuery(qb.db);
  const stmt = qb.queries.deleteTestNamesForPath;
  qb.db.transaction(() => {
    for (const p of paths) stmt.run({ filePath: p });
  })();
}

export function insertTestNames(qb: QueryBuilder, rows: ReadonlyArray<TestNameRow>): number {
  if (rows.length === 0) return 0;
  qb.queries.insertTestName ??= insertTestNameQuery(qb.db);
  const stmt = qb.queries.insertTestName;
  let written = 0;
  qb.db.transaction(() => {
    for (const r of rows) {
      try {
        stmt.run(r);
        written++;
      } catch {
        // FK violation when files row is gone — race-safe skip.
      }
    }
  })();
  return written;
}
