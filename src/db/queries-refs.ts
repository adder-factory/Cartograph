/**
 * Reference-table queries — the three sibling tables that record
 * out-of-band references not captured by AST node/edge extraction:
 *
 *   - `config_refs`        : env-var / feature-flag read sites
 *   - `build_context_refs` : `__dirname`, `import.meta.*` sites
 *   - `sql_refs`           : table-name string-literal references
 *
 * All three tables follow the same shape (apply / clear / delete /
 * prune) plus a few read-side helpers per table. Co-located here
 * because they share that shape and the per-file-path lifecycle.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain ref helpers as direct members. The functions read
 * / write via the `@internal`-tagged `db` and `queries` fields on
 * the parent `QueryBuilder`. Prepared statements are declared at
 * module scope via {@link defineQuery} — Zod schemas drive both
 * compile-time and runtime validation of params + rows. Lazy-cached
 * on `qb.queries.X` to mirror the existing `qb.stmts.X` pattern.
 *
 * Conditional WHERE clauses are split via Pattern C — one static
 * `defineQuery` per filter variant, dispatched at runtime — so every
 * SQL string stays prepared-once and the typed wrapper applies.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Shared row / param schemas ───────────────────────────────────────────

const PathOnlyParams = z.object({ filePath: z.string() });

const ConfigRefByKeyRowSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  sourceNodeId: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceKind: z.string().nullable(),
});

const ConfigKeyForNodeRowSchema = z.object({
  configKey: z.string(),
  line: z.number(),
});

const SqlTableRowSchema = z.object({
  tableName: z.string(),
  reads: z.number(),
  writes: z.number(),
  ddl: z.number(),
  total: z.number(),
});

const SqlTableForNodeRowSchema = z.object({
  tableName: z.string(),
  op: z.string(),
});

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const deleteConfigRefsByFileQuery = defineQuery({
  sql: 'DELETE FROM config_refs WHERE file_path = @filePath',
  params: PathOnlyParams,
  row: z.never(),
});

const insertConfigRefQuery = defineQuery({
  sql: `INSERT INTO config_refs (config_kind, config_key, source_node_id, file_path, line)
     VALUES (@configKind, @configKey, @sourceNodeId, @filePath, @line)`,
  params: z.object({
    configKind: z.string(),
    configKey: z.string(),
    sourceNodeId: z.string().nullable(),
    filePath: z.string(),
    line: z.number(),
  }),
  row: z.never(),
});

const getConfigRefsByKeyQuery = defineQuery({
  sql: `SELECT cr.file_path AS filePath,
            cr.line AS line,
            cr.source_node_id AS sourceNodeId,
            n.name AS sourceName,
            n.kind AS sourceKind
     FROM config_refs cr
     LEFT JOIN nodes n ON n.id = cr.source_node_id
     WHERE cr.config_kind = @configKind AND cr.config_key = @configKey
     ORDER BY cr.file_path ASC, cr.line ASC`,
  params: z.object({ configKind: z.string(), configKey: z.string() }),
  row: ConfigRefByKeyRowSchema,
});

const getConfigKeysForNodeQuery = defineQuery({
  sql: `SELECT config_key AS configKey, line
     FROM config_refs
     WHERE source_node_id = @nodeId
     ORDER BY config_key ASC, line ASC`,
  params: z.object({ nodeId: z.string() }),
  row: ConfigKeyForNodeRowSchema,
});

const deleteBuildContextRefsByFileQuery = defineQuery({
  sql: 'DELETE FROM build_context_refs WHERE file_path = @filePath',
  params: PathOnlyParams,
  row: z.never(),
});

const insertBuildContextRefQuery = defineQuery({
  sql: `INSERT INTO build_context_refs (ref_kind, source_node_id, file_path, line)
     VALUES (@refKind, @sourceNodeId, @filePath, @line)`,
  params: z.object({
    refKind: z.string(),
    sourceNodeId: z.string().nullable(),
    filePath: z.string(),
    line: z.number(),
  }),
  row: z.never(),
});

const insertSqlRefQuery = defineQuery({
  sql: `INSERT INTO sql_refs (table_name, op, source_node_id, file_path, line)
     VALUES (@tableName, @op, @sourceNodeId, @filePath, @line)`,
  params: z.object({
    tableName: z.string(),
    op: z.string(),
    sourceNodeId: z.string().nullable(),
    filePath: z.string(),
    line: z.number(),
  }),
  row: z.never(),
});

const deleteSqlRefsByFileQuery = defineQuery({
  sql: 'DELETE FROM sql_refs WHERE file_path = @filePath',
  params: PathOnlyParams,
  row: z.never(),
});

const getSqlTablesQuery = defineQuery({
  sql: `SELECT lower(table_name) AS tableName,
            SUM(CASE WHEN op = 'read'  THEN 1 ELSE 0 END) AS reads,
            SUM(CASE WHEN op = 'write' THEN 1 ELSE 0 END) AS writes,
            SUM(CASE WHEN op = 'ddl'   THEN 1 ELSE 0 END) AS ddl,
            COUNT(*)                                       AS total
     FROM sql_refs
     GROUP BY lower(table_name)
     ORDER BY total DESC, tableName ASC
     LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: SqlTableRowSchema,
});

const getSqlTablesForNodeQuery = defineQuery({
  sql: `SELECT DISTINCT lower(table_name) AS tableName, op
     FROM sql_refs
     WHERE source_node_id = @nodeId
     ORDER BY tableName ASC, op ASC`,
  params: z.object({ nodeId: z.string() }),
  row: SqlTableForNodeRowSchema,
});

const ConfigKeyAggRowSchema = z.object({
  configKey: z.string(),
  reads: z.number(),
  distinctFiles: z.number(),
});

const getConfigKeysAllQuery = defineQuery({
  sql: `SELECT config_key AS configKey,
            COUNT(*) AS reads,
            COUNT(DISTINCT file_path) AS distinctFiles
     FROM config_refs
     GROUP BY config_key
     ORDER BY reads DESC, config_key ASC
     LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: ConfigKeyAggRowSchema,
});

const getConfigKeysByKindQuery = defineQuery({
  sql: `SELECT config_key AS configKey,
            COUNT(*) AS reads,
            COUNT(DISTINCT file_path) AS distinctFiles
     FROM config_refs
     WHERE config_kind = @configKind
     GROUP BY config_key
     ORDER BY reads DESC, config_key ASC
     LIMIT @limit`,
  params: z.object({ configKind: z.string(), limit: z.number() }),
  row: ConfigKeyAggRowSchema,
});

const SqlRefByTableRowSchema = z.object({
  op: z.enum(['read', 'write', 'ddl']),
  filePath: z.string(),
  line: z.number(),
  sourceNodeId: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceKind: z.string().nullable(),
});

const getSqlRefsByTableAnyOpQuery = defineQuery({
  sql: `SELECT sr.op AS op,
            sr.file_path AS filePath,
            sr.line AS line,
            sr.source_node_id AS sourceNodeId,
            n.name AS sourceName,
            n.kind AS sourceKind
     FROM sql_refs sr
     LEFT JOIN nodes n ON n.id = sr.source_node_id
     WHERE lower(sr.table_name) = @tableName
     ORDER BY sr.file_path ASC, sr.line ASC`,
  params: z.object({ tableName: z.string() }),
  row: SqlRefByTableRowSchema,
});

const getSqlRefsByTableAndOpQuery = defineQuery({
  sql: `SELECT sr.op AS op,
            sr.file_path AS filePath,
            sr.line AS line,
            sr.source_node_id AS sourceNodeId,
            n.name AS sourceName,
            n.kind AS sourceKind
     FROM sql_refs sr
     LEFT JOIN nodes n ON n.id = sr.source_node_id
     WHERE lower(sr.table_name) = @tableName AND sr.op = @op
     ORDER BY sr.file_path ASC, sr.line ASC`,
  params: z.object({ tableName: z.string(), op: z.enum(['read', 'write', 'ddl']) }),
  row: SqlRefByTableRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    deleteConfigRefsByFile?: TypedQuery<{ filePath: string }, never>;
    insertConfigRef?: TypedQuery<
      {
        configKind: string;
        configKey: string;
        sourceNodeId: string | null;
        filePath: string;
        line: number;
      },
      never
    >;
    getConfigRefsByKey?: TypedQuery<
      { configKind: string; configKey: string },
      {
        filePath: string;
        line: number;
        sourceNodeId: string | null;
        sourceName: string | null;
        sourceKind: string | null;
      }
    >;
    getConfigKeysForNode?: TypedQuery<{ nodeId: string }, { configKey: string; line: number }>;
    deleteBuildContextRefsByFile?: TypedQuery<{ filePath: string }, never>;
    insertBuildContextRef?: TypedQuery<
      { refKind: string; sourceNodeId: string | null; filePath: string; line: number },
      never
    >;
    insertSqlRef?: TypedQuery<
      {
        tableName: string;
        op: string;
        sourceNodeId: string | null;
        filePath: string;
        line: number;
      },
      never
    >;
    deleteSqlRefsByFile?: TypedQuery<{ filePath: string }, never>;
    getSqlTables?: TypedQuery<
      { limit: number },
      { tableName: string; reads: number; writes: number; ddl: number; total: number }
    >;
    getSqlTablesForNode?: TypedQuery<{ nodeId: string }, { tableName: string; op: string }>;
    getConfigKeysAll?: TypedQuery<{ limit: number }, { configKey: string; reads: number; distinctFiles: number }>;
    getConfigKeysByKind?: TypedQuery<
      { configKind: string; limit: number },
      { configKey: string; reads: number; distinctFiles: number }
    >;
    getSqlRefsByTableAnyOp?: TypedQuery<
      { tableName: string },
      {
        op: 'read' | 'write' | 'ddl';
        filePath: string;
        line: number;
        sourceNodeId: string | null;
        sourceName: string | null;
        sourceKind: string | null;
      }
    >;
    getSqlRefsByTableAndOp?: TypedQuery<
      { tableName: string; op: 'read' | 'write' | 'ddl' },
      {
        op: 'read' | 'write' | 'ddl';
        filePath: string;
        line: number;
        sourceNodeId: string | null;
        sourceName: string | null;
        sourceKind: string | null;
      }
    >;
  }
}

// ===========================================================================
// Config references (env vars / feature flags read sites)
// ===========================================================================

export function applyConfigRefs(
  qb: QueryBuilder,
  rows: Array<{
    configKind: 'env';
    configKey: string;
    sourceNodeId: string | null;
    filePath: string;
    line: number;
  }>,
): void {
  if (rows.length === 0) return;
  const distinctFiles = new Set(rows.map((r) => r.filePath));
  qb.queries.deleteConfigRefsByFile ??= deleteConfigRefsByFileQuery(qb.db);
  qb.queries.insertConfigRef ??= insertConfigRefQuery(qb.db);
  const deleteStmt = qb.queries.deleteConfigRefsByFile;
  const insertStmt = qb.queries.insertConfigRef;
  qb.db.transaction(() => {
    for (const f of distinctFiles) deleteStmt.run({ filePath: f });
    for (const r of rows) {
      insertStmt.run({
        configKind: r.configKind,
        configKey: r.configKey,
        sourceNodeId: r.sourceNodeId,
        filePath: r.filePath,
        line: r.line,
      });
    }
  })();
}

export function clearConfigRefs(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM config_refs');
}

export function deleteConfigRefsForPaths(qb: QueryBuilder, filePaths: Iterable<string>): void {
  qb.queries.deleteConfigRefsByFile ??= deleteConfigRefsByFileQuery(qb.db);
  const stmt = qb.queries.deleteConfigRefsByFile;
  qb.db.transaction(() => {
    for (const p of filePaths) stmt.run({ filePath: p });
  })();
}

export function pruneOrphanedConfigRefs(qb: QueryBuilder): void {
  qb.db.exec(`DELETE FROM config_refs WHERE file_path NOT IN (SELECT path FROM files)`);
}

/**
 * Pattern C — two static `defineQuery` variants (with/without
 * `WHERE config_kind = @configKind`) dispatched at runtime, so every
 * SQL path stays prepared-once.
 */
export function getConfigKeys(
  qb: QueryBuilder,
  opts: { configKind?: 'env'; limit?: number } = {},
): Array<{
  configKey: string;
  reads: number;
  distinctFiles: number;
}> {
  const limit = opts.limit ?? 200;
  const configKind = opts.configKind;
  if (configKind) {
    qb.queries.getConfigKeysByKind ??= getConfigKeysByKindQuery(qb.db);
    return qb.queries.getConfigKeysByKind.all({ configKind, limit });
  }
  qb.queries.getConfigKeysAll ??= getConfigKeysAllQuery(qb.db);
  return qb.queries.getConfigKeysAll.all({ limit });
}

export function getConfigRefsByKey(
  qb: QueryBuilder,
  configKey: string,
  opts: { configKind?: 'env' } = {},
): Array<{
  filePath: string;
  line: number;
  sourceNodeId: string | null;
  sourceName: string | null;
  sourceKind: string | null;
}> {
  const kind = opts.configKind ?? 'env';
  qb.queries.getConfigRefsByKey ??= getConfigRefsByKeyQuery(qb.db);
  return qb.queries.getConfigRefsByKey.all({ configKind: kind, configKey });
}

export function getConfigKeysForNode(qb: QueryBuilder, nodeId: string): Array<{ configKey: string; line: number }> {
  qb.queries.getConfigKeysForNode ??= getConfigKeysForNodeQuery(qb.db);
  return qb.queries.getConfigKeysForNode.all({ nodeId });
}

// ===========================================================================
// Build-context Refs (__dirname, import.meta.*) — see migration 024
// ===========================================================================

export function applyBuildContextRefs(
  qb: QueryBuilder,
  rows: Array<{
    refKind: string;
    sourceNodeId: string | null;
    filePath: string;
    line: number;
  }>,
): void {
  if (rows.length === 0) return;
  const distinctFiles = new Set(rows.map((r) => r.filePath));
  qb.queries.deleteBuildContextRefsByFile ??= deleteBuildContextRefsByFileQuery(qb.db);
  qb.queries.insertBuildContextRef ??= insertBuildContextRefQuery(qb.db);
  const deleteStmt = qb.queries.deleteBuildContextRefsByFile;
  const insertStmt = qb.queries.insertBuildContextRef;
  qb.db.transaction(() => {
    for (const f of distinctFiles) deleteStmt.run({ filePath: f });
    for (const r of rows) {
      insertStmt.run({
        refKind: r.refKind,
        sourceNodeId: r.sourceNodeId,
        filePath: r.filePath,
        line: r.line,
      });
    }
  })();
}

export function clearBuildContextRefs(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM build_context_refs');
}

export function deleteBuildContextRefsForPaths(qb: QueryBuilder, filePaths: Iterable<string>): void {
  qb.queries.deleteBuildContextRefsByFile ??= deleteBuildContextRefsByFileQuery(qb.db);
  const stmt = qb.queries.deleteBuildContextRefsByFile;
  qb.db.transaction(() => {
    for (const p of filePaths) stmt.run({ filePath: p });
  })();
}

export function pruneOrphanedBuildContextRefs(qb: QueryBuilder): void {
  qb.db.exec(`DELETE FROM build_context_refs WHERE file_path NOT IN (SELECT path FROM files)`);
}

// ===========================================================================
// SQL references (table-name string-literal refs from app code)
// ===========================================================================

export function applySqlRefs(
  qb: QueryBuilder,
  rows: Array<{
    tableName: string;
    op: 'read' | 'write' | 'ddl';
    sourceNodeId: string | null;
    filePath: string;
    line: number;
  }>,
): void {
  if (rows.length === 0) return;
  qb.queries.insertSqlRef ??= insertSqlRefQuery(qb.db);
  const stmt = qb.queries.insertSqlRef;
  qb.db.transaction(() => {
    for (const r of rows) {
      stmt.run({
        tableName: r.tableName,
        op: r.op,
        sourceNodeId: r.sourceNodeId,
        filePath: r.filePath,
        line: r.line,
      });
    }
  })();
}

export function replaceAllSqlRefs(
  qb: QueryBuilder,
  rows: Array<{
    tableName: string;
    op: 'read' | 'write' | 'ddl';
    sourceNodeId: string | null;
    filePath: string;
    line: number;
  }>,
): void {
  qb.queries.insertSqlRef ??= insertSqlRefQuery(qb.db);
  const insert = qb.queries.insertSqlRef;
  qb.db.transaction(() => {
    qb.db.exec('DELETE FROM sql_refs');
    for (const r of rows) {
      insert.run({
        tableName: r.tableName,
        op: r.op,
        sourceNodeId: r.sourceNodeId,
        filePath: r.filePath,
        line: r.line,
      });
    }
  })();
}

export function deleteSqlRefsForPaths(qb: QueryBuilder, filePaths: Iterable<string>): void {
  qb.queries.deleteSqlRefsByFile ??= deleteSqlRefsByFileQuery(qb.db);
  const stmt = qb.queries.deleteSqlRefsByFile;
  qb.db.transaction(() => {
    for (const p of filePaths) stmt.run({ filePath: p });
  })();
}

export function pruneOrphanedSqlRefs(qb: QueryBuilder): void {
  qb.db.exec(`DELETE FROM sql_refs WHERE file_path NOT IN (SELECT path FROM files)`);
}

export function getSqlTables(
  qb: QueryBuilder,
  opts: { limit?: number } = {},
): Array<{
  tableName: string;
  reads: number;
  writes: number;
  ddl: number;
  total: number;
}> {
  const limit = opts.limit ?? 100;
  qb.queries.getSqlTables ??= getSqlTablesQuery(qb.db);
  return qb.queries.getSqlTables.all({ limit });
}

/**
 * Pattern C — two static `defineQuery` variants (with/without
 * `AND sr.op = @op`) dispatched at runtime. The op column has no
 * dedicated index, so Pattern B (`@op IS NULL OR op = @op`) wouldn't
 * help the planner anyway; explicit dispatch keeps every variant
 * prepared-once and typed.
 */
export function getSqlRefsByTable(
  qb: QueryBuilder,
  tableName: string,
  opts: { op?: 'read' | 'write' | 'ddl' } = {},
): Array<{
  op: 'read' | 'write' | 'ddl';
  filePath: string;
  line: number;
  sourceNodeId: string | null;
  sourceName: string | null;
  sourceKind: string | null;
}> {
  const tableLower = tableName.toLowerCase();
  if (opts.op) {
    qb.queries.getSqlRefsByTableAndOp ??= getSqlRefsByTableAndOpQuery(qb.db);
    return qb.queries.getSqlRefsByTableAndOp.all({ tableName: tableLower, op: opts.op });
  }
  qb.queries.getSqlRefsByTableAnyOp ??= getSqlRefsByTableAnyOpQuery(qb.db);
  return qb.queries.getSqlRefsByTableAnyOp.all({ tableName: tableLower });
}

export function getSqlTablesForNode(qb: QueryBuilder, nodeId: string): Array<{ tableName: string; op: string }> {
  qb.queries.getSqlTablesForNode ??= getSqlTablesForNodeQuery(qb.db);
  return qb.queries.getSqlTablesForNode.all({ nodeId });
}
