import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig, saveConfig } from '../../config.js';
import {
  type DatabaseProvider,
  isPostgresServerVersionSupported,
  postgresMinimumVersionRemediation,
  postgresServerVersionInfoFromRow,
  postgresSqlOptions,
  postgresUnsupportedVersionMessage,
  resolveDatabaseConfig,
  type DatabaseConfig,
} from '../../db/database-config.js';
import { DatabaseConnection, getDatabasePath } from '../../db/index.js';

export interface StorageMigrationOptions {
  projectPath: string;
  database: DatabaseConfig;
  force?: boolean;
}

export interface StorageMigrationSummaryBase {
  tablesCopied: number;
  rowsCopied: number;
  configPath: string;
  sourceProvider: DatabaseProvider;
  targetProvider: DatabaseProvider;
}

export interface SqliteToPostgresMigrationSummary extends StorageMigrationSummaryBase {
  sourceProvider: 'sqlite';
  targetProvider: 'postgres';
  sqliteBackupPath: string;
  postgresSchema: string;
}

export interface PostgresToSqliteMigrationSummary extends StorageMigrationSummaryBase {
  sourceProvider: 'postgres';
  targetProvider: 'sqlite';
  sqlitePath: string;
  postgresSchema: string;
  postgresSentinelBackupPath: string;
  configBackupPath: string;
}

export type StorageMigrationSummary = SqliteToPostgresMigrationSummary | PostgresToSqliteMigrationSummary;

export type StorageMigrationResult =
  | { ok: true; summary: StorageMigrationSummary }
  | {
      ok: false;
      exitCode: 1;
      error: {
        code: string;
        message: string;
        remediation?: string;
      };
    };

interface CopyTableSummary {
  table: string;
  rows: number;
}

interface ColumnInfo {
  name: string;
}

const MIGRATABLE_TABLES = [
  'files',
  'nodes',
  'role_assignments',
  'edges',
  'co_changes',
  'unresolved_refs',
  'project_metadata',
  'symbol_issues',
  'config_refs',
  'sql_refs',
  'build_context_refs',
  'string_imports',
  'summary_store',
  'summary_refs',
  'test_names',
  'nested_function_names',
  'nested_function_popularity',
  'embedding_store',
  'embedding_refs',
  'directory_summaries',
  'file_summaries',
  'node_coverage',
  'code_health_findings',
  'parse_cache',
  'node_loc_history',
  'mcp_sessions',
  'mcp_tool_calls',
  'mcp_macros',
  'agent_notes',
  'node_metrics',
  'summary_priority_queue',
  'commit_intents',
  'symbol_chunk_embeddings',
  'hnsw_meta',
] as const;

const SERIAL_ID_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['edges', 'id'],
  ['unresolved_refs', 'id'],
  ['config_refs', 'id'],
  ['sql_refs', 'id'],
  ['build_context_refs', 'id'],
  ['string_imports', 'id'],
  ['test_names', 'id'],
  ['nested_function_names', 'id'],
  ['agent_notes', 'id'],
];

const COPY_BATCH_SIZE = 250;

export async function migrateSqliteProjectToPostgres(
  options: StorageMigrationOptions,
): Promise<StorageMigrationResult> {
  const projectPath = path.resolve(options.projectPath);
  const database = resolveDatabaseConfig(options.database);
  if (database.provider !== 'postgres') {
    return failure(
      'invalid-target-provider',
      'Storage migration target must be PostgreSQL.',
      'Pass `--database-url postgres://...` or set CARTOGRAPH_DATABASE_URL / DATABASE_URL.',
    );
  }

  const dbPath = getDatabasePath(projectPath);
  if (!(await fileExists(dbPath))) {
    return failure(
      'missing-sqlite-source',
      `No SQLite database found at ${dbPath}.`,
      'Run this command from a SQLite-backed Cartograph project before switching the config to PostgreSQL.',
    );
  }

  const existingConfig = loadConfig(projectPath);
  if (existingConfig.database?.provider === 'postgres') {
    return failure(
      'already-postgres',
      'This project is already configured for PostgreSQL storage.',
      'Run `cartograph status` to verify the current backend, or restore the SQLite config before migrating.',
    );
  }

  const targetReady = await prepareTargetSchema(database, options.force === true);
  if (!targetReady.ok) return targetReady;

  let source: DatabaseConnection | undefined;
  let target: DatabaseConnection | undefined;
  try {
    source = DatabaseConnection.open(dbPath, { database: { provider: 'sqlite' } });
    target = DatabaseConnection.initialize(dbPath, { database });

    const copied = copyStorageTables(source, target);
    const rowsCopied = copied.reduce((sum, table) => sum + table.rows, 0);
    const tablesCopied = copied.filter((table) => table.rows > 0).length;

    source.close();
    source = undefined;
    target.close();
    target = undefined;

    const sqliteBackupPath = await backupSqliteDatabase(dbPath);
    await writePostgresSentinel(dbPath);
    const nextConfig = { ...existingConfig, database };
    saveConfig(projectPath, nextConfig);

    return {
      ok: true,
      summary: {
        tablesCopied,
        rowsCopied,
        sourceProvider: 'sqlite',
        targetProvider: 'postgres',
        sqliteBackupPath,
        configPath: path.join(projectPath, '.cartograph', 'config.json'),
        postgresSchema: database.schema ?? 'public',
      },
    };
  } catch (err) {
    return failure(
      'migration-failed',
      err instanceof Error ? err.message : String(err),
      'Verify the source SQLite database is current and the PostgreSQL schema is empty, or retry with `--force` to recreate the target schema.',
    );
  } finally {
    source?.close();
    target?.close();
  }
}

export async function migratePostgresProjectToSqlite(options: {
  projectPath: string;
}): Promise<StorageMigrationResult> {
  const projectPath = path.resolve(options.projectPath);
  const existingConfig = loadConfig(projectPath);
  const database = resolveDatabaseConfig(existingConfig.database);
  if (database.provider !== 'postgres') {
    return failure(
      'already-sqlite',
      'This project is already configured for SQLite storage.',
      'Run `cartograph status` to verify the current backend.',
    );
  }

  const dbPath = getDatabasePath(projectPath);
  const suffix = timestampSuffix();
  const sqliteTempPath = `${dbPath}.sqlite-rebuild.${suffix}.tmp.db`;
  let source: DatabaseConnection | undefined;
  let target: DatabaseConnection | undefined;
  try {
    await removeDatabaseFiles(sqliteTempPath);
    source = DatabaseConnection.open(dbPath, { database });
    target = DatabaseConnection.initialize(sqliteTempPath, { database: { provider: 'sqlite' } });

    const copied = copyStorageTables(source, target);
    assertCopiedRowCounts(source, target);
    assertSqliteForeignKeys(target);
    finalizeSqliteDatabase(target);
    const rowsCopied = copied.reduce((sum, table) => sum + table.rows, 0);
    const tablesCopied = copied.filter((table) => table.rows > 0).length;

    source.close();
    source = undefined;
    target.close();
    target = undefined;

    const configPath = path.join(projectPath, '.cartograph', 'config.json');
    const configBackupPath = `${configPath}.pre-sqlite-${suffix}.bak`;
    await fs.copyFile(configPath, configBackupPath);

    const postgresSentinelBackupPath = await backupCurrentDatabaseFile(dbPath, `postgres-sentinel-backup.${suffix}`);
    await renameDatabaseFiles(sqliteTempPath, dbPath);

    const nextConfig = { ...existingConfig };
    delete nextConfig.database;
    saveConfig(projectPath, nextConfig);

    return {
      ok: true,
      summary: {
        tablesCopied,
        rowsCopied,
        sourceProvider: 'postgres',
        targetProvider: 'sqlite',
        sqlitePath: dbPath,
        configPath,
        postgresSchema: database.schema ?? 'public',
        postgresSentinelBackupPath,
        configBackupPath,
      },
    };
  } catch (err) {
    await removeDatabaseFiles(sqliteTempPath);
    return failure(
      'migration-failed',
      err instanceof Error ? err.message : String(err),
      'Verify the PostgreSQL source is reachable and the project is not being concurrently reconfigured, then retry.',
    );
  } finally {
    source?.close();
    target?.close();
  }
}

export function storageMigrationSuccessMessage(summary: StorageMigrationSummary): string {
  if (summary.targetProvider === 'sqlite') {
    return (
      `Migrated ${summary.rowsCopied} row${summary.rowsCopied === 1 ? '' : 's'} across ` +
      `${summary.tablesCopied} table${summary.tablesCopied === 1 ? '' : 's'} from PostgreSQL schema ` +
      `"${summary.postgresSchema}" to SQLite database ${summary.sqlitePath}. ` +
      `PostgreSQL sentinel backup: ${summary.postgresSentinelBackupPath}`
    );
  }
  return (
    `Migrated ${summary.rowsCopied} row${summary.rowsCopied === 1 ? '' : 's'} across ` +
    `${summary.tablesCopied} table${summary.tablesCopied === 1 ? '' : 's'} to PostgreSQL schema ` +
    `"${summary.postgresSchema}". SQLite backup: ${summary.sqliteBackupPath}`
  );
}

async function prepareTargetSchema(
  database: DatabaseConfig,
  force: boolean,
): Promise<StorageMigrationResult | { ok: true }> {
  const schema = database.schema ?? 'public';
  if (!/^[A-Za-z_]\w*$/.test(schema)) {
    return failure(
      'invalid-schema',
      `Invalid PostgreSQL schema name: ${schema}`,
      'Use a simple schema identifier such as `cartograph`.',
    );
  }

  const sql = new Bun.SQL(postgresSqlOptions({ ...database, maxConnections: 1 }));
  try {
    await sql`SELECT 1`;
    const versionResult = await checkTargetPostgresVersion(sql);
    if (!versionResult.ok) return versionResult;
    const existingCount = await countSchemaObjects(sql, schema);
    if (existingCount > 0) {
      if (!force) {
        return failure(
          'target-not-empty',
          `PostgreSQL schema "${schema}" already contains ${existingCount} table/view object${existingCount === 1 ? '' : 's'}.`,
          'Use a new schema name, empty the schema, or pass `--force` to drop and recreate the target schema.',
        );
      }
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).simple();
    }
    return { ok: true };
  } catch (err) {
    return failure(
      'postgres-unreachable',
      `PostgreSQL target check failed: ${err instanceof Error ? err.message : String(err)}`,
      'Verify `--database-url`, credentials, network access, and that PostgreSQL is running.',
    );
  } finally {
    await sql.close();
  }
}

async function checkTargetPostgresVersion(sql: Bun.SQL): Promise<StorageMigrationResult | { ok: true }> {
  const rows = await sql`
    SELECT
      current_setting('server_version_num') AS server_version_num,
      current_setting('server_version') AS version,
      current_setting('io_method', true) AS io_method
  `;
  const info = postgresServerVersionInfoFromRow(
    rows[0] as { server_version_num?: unknown; version?: unknown; io_method?: unknown } | undefined,
  );
  if (isPostgresServerVersionSupported(info.versionNum)) return { ok: true };
  return failure(
    'unsupported-postgres-version',
    postgresUnsupportedVersionMessage(info),
    postgresMinimumVersionRemediation(),
  );
}

async function countSchemaObjects(sql: Bun.SQL, schema: string): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT COUNT(*)::integer AS n
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type IN ('BASE TABLE', 'VIEW')`,
    [schema],
  );
  const value = (rows[0] as { n?: number | string } | undefined)?.n ?? 0;
  return typeof value === 'number' ? value : Number(value);
}

function copyStorageTables(source: DatabaseConnection, target: DatabaseConnection): CopyTableSummary[] {
  const sourceDb = source.getDb();
  const targetDb = target.getDb();
  const copied: CopyTableSummary[] = [];

  targetDb.transaction(() => {
    for (const table of MIGRATABLE_TABLES) {
      copied.push(copyTable(sourceDb, targetDb, table));
    }
    if (target.getBackend() === 'postgres') resetPostgresSequences(target);
  })();

  return copied;
}

function copyTable(
  sourceDb: ReturnType<DatabaseConnection['getDb']>,
  targetDb: ReturnType<DatabaseConnection['getDb']>,
  table: string,
): CopyTableSummary {
  const sourceColumns = columnNames(sourceDb, table);
  const targetColumnSet = new Set(columnNames(targetDb, table));
  const columns = sourceColumns.filter((column) => column !== 'rowid' && targetColumnSet.has(column));
  if (columns.length === 0) return { table, rows: 0 };

  const quotedTable = quoteIdent(table);
  const quotedColumns = columns.map(quoteIdent).join(', ');
  const namedParameters = columns.map(namedParameter).join(', ');
  const selectSql = `SELECT ${quotedColumns} FROM ${quotedTable}`;
  const rows = sourceDb.prepare(selectSql).all() as Record<string, unknown>[];
  if (rows.length === 0) return { table, rows: 0 };

  const insertSql = `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${namedParameters})`;
  const stmt = targetDb.prepare(insertSql);
  for (let i = 0; i < rows.length; i += COPY_BATCH_SIZE) {
    const batch = rows.slice(i, i + COPY_BATCH_SIZE);
    if (typeof stmt.runBatch === 'function') {
      stmt.runBatch(batch.map((row) => [row]));
    } else {
      for (const row of batch) stmt.run(row);
    }
  }

  return { table, rows: rows.length };
}

function columnNames(db: ReturnType<DatabaseConnection['getDb']>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[]).map((col) => col.name);
}

function assertCopiedRowCounts(source: DatabaseConnection, target: DatabaseConnection): void {
  const mismatches: string[] = [];
  for (const table of MIGRATABLE_TABLES) {
    const sourceCount = countRows(source.getDb(), table);
    const targetCount = countRows(target.getDb(), table);
    if (sourceCount !== targetCount) mismatches.push(`${table}: source=${sourceCount}, target=${targetCount}`);
  }
  if (mismatches.length > 0) throw new Error(`Row-count mismatches after copy: ${mismatches.join('; ')}`);
}

function countRows(db: ReturnType<DatabaseConnection['getDb']>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n?: number | string } | null;
  return typeof row?.n === 'number' ? row.n : Number(row?.n ?? 0);
}

function assertSqliteForeignKeys(target: DatabaseConnection): void {
  if (target.getDb().dialect !== 'sqlite') return;
  const rows = target.getDb().prepare('PRAGMA foreign_key_check').all();
  if (rows.length > 0) throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(rows.slice(0, 20))}`);
}

function finalizeSqliteDatabase(target: DatabaseConnection): void {
  if (target.getDb().dialect !== 'sqlite') return;
  try {
    target.getDb().prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  } catch {
    /* best effort */
  }
  try {
    target.getDb().prepare('PRAGMA optimize').all();
  } catch {
    /* best effort */
  }
}

function resetPostgresSequences(target: DatabaseConnection): void {
  const db = target.getDb();
  for (const [table, column] of SERIAL_ID_COLUMNS) {
    const quotedTable = quoteIdent(table);
    const quotedColumn = quoteIdent(column);
    const resetSql = `SELECT setval(pg_get_serial_sequence(@tableName, @columnName), max_id, true)
         FROM (SELECT MAX(${quotedColumn}) AS max_id FROM ${quotedTable}) s
        WHERE max_id IS NOT NULL`;
    db.prepare(resetSql).run({ tableName: table, columnName: column });
  }
}

async function backupSqliteDatabase(dbPath: string): Promise<string> {
  const backupPath = `${dbPath}.sqlite-backup.${timestampSuffix()}`;
  await renameDatabaseFiles(dbPath, backupPath);
  return backupPath;
}

async function backupCurrentDatabaseFile(dbPath: string, label: string): Promise<string> {
  const backupPath = `${dbPath}.${label}`;
  await renameDatabaseFiles(dbPath, backupPath);
  return backupPath;
}

async function writePostgresSentinel(dbPath: string): Promise<void> {
  await fs.writeFile(dbPath, 'postgres provider sentinel\n', 'utf-8');
}

function timestampSuffix(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}

function failure(code: string, message: string, remediation?: string): StorageMigrationResult {
  return {
    ok: false,
    exitCode: 1,
    error: {
      code,
      message,
      ...(remediation ? { remediation } : {}),
    },
  };
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_]\w*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function namedParameter(value: string): string {
  if (!/^[A-Za-z_]\w*$/.test(value)) throw new Error(`Unsafe SQL parameter name: ${value}`);
  return `@${value}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (isNodeErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

async function renameIfExists(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (err) {
    if (!isNodeErrorCode(err, 'ENOENT')) throw err;
  }
}

async function renameDatabaseFiles(sourcePath: string, targetPath: string): Promise<void> {
  await fs.rename(sourcePath, targetPath);
  await Promise.all([
    renameIfExists(`${sourcePath}-wal`, `${targetPath}-wal`),
    renameIfExists(`${sourcePath}-shm`, `${targetPath}-shm`),
  ]);
}

async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
