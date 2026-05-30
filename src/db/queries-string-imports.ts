/**
 * String-import queries — the `string_imports` table backs the
 * `cartograph_imports source=literal` MCP tool by recording every
 * import-shaped string-literal / template-literal occurrence found
 * during extraction.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain string-import helpers as direct members. The
 * functions read / write the `string_imports` table via the
 * `@internal`-tagged `db` field on the parent `QueryBuilder`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

const ContainerKindSchema = z.enum(['template_string', 'string_literal']);

// ─── Typed query definitions ─────────────────────────────────────────────

const deleteStringImportsByFileQuery = defineQuery({
  sql: 'DELETE FROM string_imports WHERE file_path = @filePath',
  params: z.object({ filePath: z.string() }),
  row: z.never(),
});

const insertStringImportQuery = defineQuery({
  sql: `INSERT INTO string_imports (file_path, line, module_name, raw, container_kind)
         VALUES (@filePath, @line, @moduleName, @raw, @containerKind)`,
  params: z.object({
    filePath: z.string(),
    line: z.number(),
    moduleName: z.string(),
    raw: z.string(),
    containerKind: ContainerKindSchema,
  }),
  row: z.never(),
});

// Pattern C — four static `getStringImports*` variants for the
// optional `moduleNameLike` / `containerKind` filter combinations
// (none / module / kind / both). Pattern B sentinels would defeat the
// `idx_string_imports_kind` index on `container_kind`.
const StringImportRowSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  moduleName: z.string(),
  raw: z.string(),
  containerKind: ContainerKindSchema,
});

const getStringImportsAllQuery = defineQuery({
  sql: `SELECT file_path AS filePath, line, module_name AS moduleName,
            raw, container_kind AS containerKind
     FROM string_imports
     ORDER BY file_path, line
     LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: StringImportRowSchema,
});

const getStringImportsByModuleQuery = defineQuery({
  sql: `SELECT file_path AS filePath, line, module_name AS moduleName,
            raw, container_kind AS containerKind
     FROM string_imports
     WHERE module_name LIKE @moduleNameLike
     ORDER BY file_path, line
     LIMIT @limit`,
  params: z.object({ moduleNameLike: z.string(), limit: z.number() }),
  row: StringImportRowSchema,
});

const getStringImportsByKindQuery = defineQuery({
  sql: `SELECT file_path AS filePath, line, module_name AS moduleName,
            raw, container_kind AS containerKind
     FROM string_imports
     WHERE container_kind = @containerKind
     ORDER BY file_path, line
     LIMIT @limit`,
  params: z.object({ containerKind: ContainerKindSchema, limit: z.number() }),
  row: StringImportRowSchema,
});

const getStringImportsByModuleAndKindQuery = defineQuery({
  sql: `SELECT file_path AS filePath, line, module_name AS moduleName,
            raw, container_kind AS containerKind
     FROM string_imports
     WHERE module_name LIKE @moduleNameLike
       AND container_kind = @containerKind
     ORDER BY file_path, line
     LIMIT @limit`,
  params: z.object({
    moduleNameLike: z.string(),
    containerKind: ContainerKindSchema,
    limit: z.number(),
  }),
  row: StringImportRowSchema,
});

type StringImportRow = z.infer<typeof StringImportRowSchema>;

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    deleteStringImportsByFile?: TypedQuery<{ filePath: string }, never>;
    insertStringImport?: TypedQuery<
      {
        filePath: string;
        line: number;
        moduleName: string;
        raw: string;
        containerKind: 'template_string' | 'string_literal';
      },
      never
    >;
    getStringImportsAll?: TypedQuery<{ limit: number }, StringImportRow>;
    getStringImportsByModule?: TypedQuery<{ moduleNameLike: string; limit: number }, StringImportRow>;
    getStringImportsByKind?: TypedQuery<
      { containerKind: 'template_string' | 'string_literal'; limit: number },
      StringImportRow
    >;
    getStringImportsByModuleAndKind?: TypedQuery<
      {
        moduleNameLike: string;
        containerKind: 'template_string' | 'string_literal';
        limit: number;
      },
      StringImportRow
    >;
  }
}

export function applyStringImports(
  qb: QueryBuilder,
  rows: Array<{
    filePath: string;
    line: number;
    moduleName: string;
    raw: string;
    containerKind: 'template_string' | 'string_literal';
  }>,
): void {
  if (rows.length === 0) return;
  const distinctFiles = new Set(rows.map((r) => r.filePath));
  qb.queries.deleteStringImportsByFile ??= deleteStringImportsByFileQuery(qb.db);
  qb.queries.insertStringImport ??= insertStringImportQuery(qb.db);
  const deleteStmt = qb.queries.deleteStringImportsByFile;
  const insertStmt = qb.queries.insertStringImport;
  qb.db.transaction(() => {
    for (const f of distinctFiles) deleteStmt.run({ filePath: f });
    for (const r of rows) {
      insertStmt.run(r);
    }
  })();
}

export function clearStringImports(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM string_imports');
}

export function deleteStringImportsForPaths(qb: QueryBuilder, filePaths: Iterable<string>): void {
  qb.queries.deleteStringImportsByFile ??= deleteStringImportsByFileQuery(qb.db);
  const stmt = qb.queries.deleteStringImportsByFile;
  qb.db.transaction(() => {
    for (const p of filePaths) stmt.run({ filePath: p });
  })();
}

export function pruneOrphanedStringImports(qb: QueryBuilder): void {
  qb.db.exec(`DELETE FROM string_imports WHERE file_path NOT IN (SELECT path FROM files)`);
}

/**
 * Read string-literal import sites with optional filters. Returns
 * one row per occurrence ordered by file then line.
 */
export function getStringImports(
  qb: QueryBuilder,
  opts: {
    moduleNameLike?: string;
    containerKind?: 'template_string' | 'string_literal';
    limit?: number;
  } = {},
): Array<{
  filePath: string;
  line: number;
  moduleName: string;
  raw: string;
  containerKind: 'template_string' | 'string_literal';
}> {
  // Pattern C — four static variants for the optional
  // `moduleNameLike` / `containerKind` filter combinations.
  const limit = opts.limit ?? 200;
  if (opts.moduleNameLike && opts.containerKind) {
    qb.queries.getStringImportsByModuleAndKind ??= getStringImportsByModuleAndKindQuery(qb.db);
    return qb.queries.getStringImportsByModuleAndKind.all({
      moduleNameLike: opts.moduleNameLike,
      containerKind: opts.containerKind,
      limit,
    });
  }
  if (opts.moduleNameLike) {
    qb.queries.getStringImportsByModule ??= getStringImportsByModuleQuery(qb.db);
    return qb.queries.getStringImportsByModule.all({
      moduleNameLike: opts.moduleNameLike,
      limit,
    });
  }
  if (opts.containerKind) {
    qb.queries.getStringImportsByKind ??= getStringImportsByKindQuery(qb.db);
    return qb.queries.getStringImportsByKind.all({
      containerKind: opts.containerKind,
      limit,
    });
  }
  qb.queries.getStringImportsAll ??= getStringImportsAllQuery(qb.db);
  return qb.queries.getStringImportsAll.all({ limit });
}
