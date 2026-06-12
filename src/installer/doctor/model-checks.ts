import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from '../../config.js';
import {
  isPostgresServerVersionSupported,
  postgresMinimumVersionRemediation,
  postgresConnectionSummary,
  postgresServerVersionInfoFromRow,
  postgresUnsupportedVersionMessage,
  postgresSqlOptions,
  resolveDatabaseConfig,
  type DatabaseConfig,
  type PostgresServerVersionInfo,
} from '../../db/database-config.js';
import { withDerivedPostgresSchema } from '../../db/project-ownership.js';
import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.js';
import { createDatabase, readSqliteRuntimeCapabilities } from '../../db/sqlite-adapter.js';
import { configuredModelFilesFromLlm, LLM_TIER_KEYS, type ConfiguredModelFile } from '../../features/backend/index.js';
import { MODELS_DIR_DEFAULT } from '../../llm/recommended-models.js';
import { formatBytes } from '../../utils.js';
import type { CheckResult } from './contract.js';

const ENGINES_BUN_MIN = '1.3.0';
const BUN_DOWNLOAD_URL = 'https://bun.sh';
const SEMVER_COMPONENT_COUNT = 3;
const MAX_RENDERED_MISSING_MODEL_FILES = 4;

interface PartialModelFile {
  readonly path: string;
  readonly sizeBytes: number;
}

interface MissingConfiguredModelFile extends ConfiguredModelFile {
  readonly partialDownload: PartialModelFile | null;
}

function parseUnsignedDecimalInteger(raw: string): number | null {
  if (!/^\d+$/u.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseSemverComponent(raw: string): number {
  return parseUnsignedDecimalInteger(raw) ?? 0;
}

function parseSchemaVersion(raw: number | string | undefined): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === 'string') return parseUnsignedDecimalInteger(raw);
  return null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(parseSemverComponent);
  const pb = b.split('.').map(parseSemverComponent);
  for (let i = 0; i < SEMVER_COMPONENT_COUNT; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

export function checkBunRuntime(): CheckResult {
  const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun;
  if (!bunGlobal) {
    return {
      id: 'bun-runtime',
      name: 'Bun runtime',
      status: 'fail',
      detail: 'Not running under Bun.',
      remediation: `Install Bun ≥ ${ENGINES_BUN_MIN} from ${BUN_DOWNLOAD_URL}, then re-run cartograph commands via bun (or via the cartograph binary which spawns bun internally).`,
    };
  }

  const version = bunGlobal.version ?? '0.0.0';
  if (compareSemver(version, ENGINES_BUN_MIN) < 0) {
    return {
      id: 'bun-runtime',
      name: 'Bun runtime',
      status: 'fail',
      detail: `Bun ${version} is older than the required ${ENGINES_BUN_MIN}.`,
      remediation: `Upgrade Bun: \`bun upgrade\` (or reinstall from ${BUN_DOWNLOAD_URL}).`,
    };
  }

  return { id: 'bun-runtime', name: 'Bun runtime', status: 'ok', detail: `Bun ${version}` };
}

export function resolveModelsDir(): string {
  return process.env['CARTOGRAPH_MODELS_DIR'] ?? MODELS_DIR_DEFAULT;
}

export async function checkModels(llm: Record<string, unknown> | null): Promise<CheckResult> {
  if (hasConfiguredLlmTier(llm)) {
    const localModelFiles = configuredModelFilesFromLlm(llm);
    if (localModelFiles.length === 0) {
      return {
        id: 'llm-models',
        name: 'LLM models',
        status: 'ok',
        detail: 'Current LLM config uses backend model IDs; no local GGUF model directory is required.',
      };
    }
    return {
      id: 'llm-models',
      name: 'LLM models',
      status: 'ok',
      detail: `${localModelFiles.length} configured local model file path${
        localModelFiles.length === 1 ? '' : 's'
      } will be checked from config.`,
    };
  }

  const modelsDir = resolveModelsDir();
  const modelsDirExists = await fsp
    .access(modelsDir)
    .then(() => true)
    .catch(() => false);
  if (!modelsDirExists) {
    return {
      id: 'llm-models',
      name: 'LLM models',
      status: 'warn',
      detail: `${modelsDir} does not exist.`,
      remediation:
        '`cartograph admin install-models` to download the recommended GGUF set (~7 GB), ' +
        'or `cartograph admin install-models --minimal` for the smallest viable subset (embed + 3B chat, ~2.1 GB).',
    };
  }

  const entries = await fsp.readdir(modelsDir);
  const ggufs = entries.filter((f) => f.endsWith('.gguf'));
  if (ggufs.length === 0) {
    return {
      id: 'llm-models',
      name: 'LLM models',
      status: 'warn',
      detail: `${modelsDir} exists but contains no .gguf files.`,
      remediation: '`cartograph admin install-models` to download the recommended set.',
    };
  }

  return {
    id: 'llm-models',
    name: 'LLM models',
    status: 'ok',
    detail: `${ggufs.length} model${ggufs.length === 1 ? '' : 's'} present under ${modelsDir}`,
  };
}

function hasConfiguredLlmTier(llm: Record<string, unknown> | null): boolean {
  if (!llm) return false;
  return LLM_TIER_KEYS.some((tier) => {
    const block = llm[tier];
    return typeof block === 'object' && block !== null;
  });
}

export async function checkProjectInit(projectPath: string): Promise<CheckResult> {
  const cgDir = path.join(projectPath, '.cartograph');
  const cgDirExists = await fsp
    .access(cgDir)
    .then(() => true)
    .catch(() => false);
  if (!cgDirExists) {
    return {
      id: 'project-init',
      name: 'Project init',
      status: 'fail',
      detail: `No \`.cartograph/\` directory at ${projectPath}.`,
      remediation: `\`cartograph admin init ${projectPath}\` to create one.`,
    };
  }
  return { id: 'project-init', name: 'Project init', status: 'ok', detail: `${cgDir} present` };
}

export async function checkProjectConfig(projectPath: string): Promise<CheckResult> {
  const configPath = path.join(projectPath, '.cartograph', 'config.json');
  const configExists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) {
    return {
      id: 'project-config',
      name: 'Project config',
      status: 'warn',
      detail: `No config.json at ${configPath}.`,
      remediation:
        '`cartograph admin install-models --write-config` to regenerate a working recommended config, or hand-author `.cartograph/config.json`.',
    };
  }

  try {
    JSON.parse(await fsp.readFile(configPath, 'utf8')) as unknown;
  } catch (e) {
    return {
      id: 'project-config',
      name: 'Project config',
      status: 'fail',
      detail: `${configPath} is not valid JSON: ${(e as Error).message}`,
      remediation: 'Hand-fix the JSON, or delete and re-run `cartograph admin init`.',
    };
  }

  let runtimeConfig: Record<string, unknown>;
  try {
    runtimeConfig = loadConfig(projectPath) as unknown as Record<string, unknown>;
  } catch (e) {
    return {
      id: 'project-config',
      name: 'Project config',
      status: 'fail',
      detail: `${configPath} failed runtime validation: ${(e as Error).message}`,
      remediation: 'Fix `.cartograph/config.json`, or re-run `cartograph admin install-models --write-config`.',
    };
  }

  const llm = runtimeConfig['llm'] as Record<string, unknown> | undefined;
  if (!llm || Object.keys(llm).length === 0) {
    return {
      id: 'project-config',
      name: 'Project config',
      status: 'warn',
      detail: `${configPath} present but no \`llm\` block configured.`,
      remediation:
        'LLM-driven features (semantic search, dead-code judge, ask) need at least an embedding model. ' +
        'Run `cartograph admin install-models --write-config` to install + wire the recommended GGUF set in one go.',
    };
  }

  return { id: 'project-config', name: 'Project config', status: 'ok', detail: `${configPath} valid` };
}

export async function checkDatabaseStorage(projectPath: string): Promise<CheckResult> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath);
  } catch (e) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `Cannot read storage config: ${(e as Error).message}`,
      remediation: 'Fix `.cartograph/config.json`, then re-run `cartograph doctor`.',
    };
  }

  let database: DatabaseConfig;
  try {
    database = resolveDatabaseConfig(config.database);
  } catch (e) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: (e as Error).message,
      remediation:
        'Set `database.url` in `.cartograph/config.json`, or export CARTOGRAPH_DATABASE_URL / DATABASE_URL before running Cartograph.',
    };
  }

  if (database.provider === 'postgres') {
    // Same derivation as the connection layer — doctor must inspect
    // the schema the project will actually use, not `public`.
    return checkPostgresStorage(withDerivedPostgresSchema(database, projectPath), projectPath);
  }
  return checkSqliteStorage(projectPath);
}

async function checkSqliteStorage(projectPath: string): Promise<CheckResult> {
  const dbPath = path.join(projectPath, '.cartograph', 'cartograph.db');
  const exists = await fsp
    .access(dbPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `No SQLite database at ${dbPath}.`,
      remediation: `Run \`cartograph admin init ${projectPath}\` to create the database, or configure PostgreSQL with \`database.provider: "postgres"\`.`,
    };
  }
  let opened: ReturnType<typeof createDatabase> | null = null;
  try {
    opened = createDatabase(dbPath);
    const capabilities = readSqliteRuntimeCapabilities(opened.db);
    const vecDetail = opened.vecLoaded
      ? 'sqlite-vec loaded'
      : 'sqlite-vec unavailable; in-memory vector fallback active';
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'ok',
      detail:
        `SQLite database present at ${dbPath}; SQLite ${capabilities.version}; ` +
        `STRICT/FTS5/RTree/JSON ok; ${vecDetail}.`,
    };
  } catch (e) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `SQLite check failed: ${(e as Error).message}`,
      remediation:
        'Upgrade Bun, set CARTOGRAPH_BUN_SQLITE_PATH to a modern SQLite build, or configure PostgreSQL 18+ with `database.provider: "postgres"`.',
    };
  } finally {
    opened?.db.close();
  }
}

async function checkPostgresStorage(database: DatabaseConfig, projectPath: string): Promise<CheckResult> {
  const schema = database.schema ?? 'public';
  const sentinelPath = path.join(projectPath, '.cartograph', 'cartograph.db');
  const initRecovery =
    `If this is a new or intentionally reset PostgreSQL schema, remove the PostgreSQL sentinel ` +
    `\`${sentinelPath}\` and run \`cartograph admin init ${projectPath}\`; otherwise recreate the configured schema.`;
  if (!/^[A-Za-z_]\w*$/.test(schema)) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `Invalid PostgreSQL schema name: ${schema}`,
      remediation:
        'Use a simple PostgreSQL schema identifier such as `cartograph`, or omit `database.schema` to get an auto-derived per-project schema.',
    };
  }

  const sql = new Bun.SQL(postgresSqlOptions({ ...database, maxConnections: 1 }));
  try {
    await sql`SELECT 1`;
    const serverRows = await sql`
      SELECT
        current_setting('server_version_num') AS server_version_num,
        current_setting('server_version') AS version,
        current_setting('io_method', true) AS io_method
    `;
    const serverInfo = postgresServerVersionInfoFromRow(
      serverRows[0] as { server_version_num?: unknown; version?: unknown; io_method?: unknown } | undefined,
    );
    if (!isPostgresServerVersionSupported(serverInfo.versionNum)) {
      return {
        id: 'database-storage',
        name: 'Database storage',
        status: 'fail',
        detail: postgresUnsupportedVersionMessage(serverInfo),
        remediation: postgresMinimumVersionRemediation(),
      };
    }
    const schemaRows = await sql.unsafe('SELECT to_regnamespace($1) AS name', [schema]);
    const schemaName = (schemaRows[0] as { name?: string | null } | undefined)?.name;
    if (!schemaName) {
      return {
        id: 'database-storage',
        name: 'Database storage',
        status: 'fail',
        detail: `PostgreSQL is reachable, but schema "${schema}" does not exist.`,
        remediation: initRecovery,
      };
    }
    const versionTableRows = await sql.unsafe('SELECT to_regclass($1) AS name', [`${schema}.schema_versions`]);
    const versionTableName = (versionTableRows[0] as { name?: string | null } | undefined)?.name;
    if (!versionTableName) {
      return {
        id: 'database-storage',
        name: 'Database storage',
        status: 'fail',
        detail: `PostgreSQL schema "${schema}" exists, but Cartograph tables are not initialized.`,
        remediation: initRecovery,
      };
    }
    const schemaIdent = quoteIdent(schema);
    const versionRows = await sql.unsafe(
      `SELECT version FROM ${schemaIdent}.schema_versions ORDER BY version DESC LIMIT 1`,
    );
    const version = parseSchemaVersion((versionRows[0] as { version?: number | string } | undefined)?.version);
    if (version !== CURRENT_SCHEMA_VERSION) {
      return {
        id: 'database-storage',
        name: 'Database storage',
        status: 'fail',
        detail: `PostgreSQL schema "${schema}" is at version ${version || 'unknown'}; expected ${CURRENT_SCHEMA_VERSION}.`,
        remediation: initRecovery,
      };
    }
    return await checkPostgresRuntimePrivileges({ sql, database, schema, version, serverInfo });
  } catch (e) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `PostgreSQL check failed: ${(e as Error).message}`,
      remediation: 'Verify `database.url`, network access, credentials, and that the configured database is running.',
    };
  } finally {
    await sql.close();
  }
}

interface PostgresRuntimeCheckContext {
  sql: Bun.SQL;
  database: DatabaseConfig;
  schema: string;
  version: number;
  serverInfo: PostgresServerVersionInfo;
}

async function checkPostgresRuntimePrivileges(ctx: PostgresRuntimeCheckContext): Promise<CheckResult> {
  const { sql, database, schema, version, serverInfo } = ctx;
  const dmlProbe = await probePostgresDml(sql, schema);
  if (dmlProbe !== null) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail: `PostgreSQL schema "${schema}" is initialized, but runtime write privilege failed: ${dmlProbe}`,
      remediation: `Grant SELECT/INSERT/UPDATE/DELETE on tables in schema "${schema}" to the configured role, then re-run \`cartograph doctor\`.`,
    };
  }
  const ddlProbe = await probePostgresDdl(sql, schema);
  const pgvectorProbe = await probePostgresPgvector(sql, schema, database.pgvector ?? 'auto');
  if (pgvectorProbe.status === 'fail') {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'fail',
      detail:
        `${postgresRuntimeDetail(serverInfo)}; schema "${schema}" is at version ${version}; runtime writes ok; ` +
        `${pgvectorProbe.detail}.`,
      remediation: pgvectorProbe.remediation,
    };
  }
  if (ddlProbe !== null) {
    return {
      id: 'database-storage',
      name: 'Database storage',
      status: 'warn',
      detail:
        `${postgresRuntimeDetail(serverInfo)}; schema "${schema}" is at version ${version}; runtime writes ok; ` +
        `schema DDL probe failed: ${ddlProbe}; ${pgvectorProbe.detail}. ${postgresConnectionSummary(database)}.`,
      remediation: `Grant CREATE on schema "${schema}" for init/rebuild workflows, or keep using a separate admin role for \`cartograph admin init\` and \`cartograph admin storage-migrate --force\`.`,
    };
  }
  return {
    id: 'database-storage',
    name: 'Database storage',
    status: 'ok',
    detail:
      `${postgresRuntimeDetail(serverInfo)}; schema "${schema}" is at version ${version}; runtime writes ok; ` +
      `schema DDL ok; ${pgvectorProbe.detail}. ${postgresConnectionSummary(database)}.`,
  };
}

function postgresRuntimeDetail(info: PostgresServerVersionInfo): string {
  const io = info.ioMethod ? `, io_method=${info.ioMethod}` : '';
  return `PostgreSQL ${info.version || '18+'}${io}; PG18 planner/storage paths available`;
}

type PgvectorProbeResult = { status: 'ok'; detail: string } | { status: 'fail'; detail: string; remediation: string };

async function probePostgresPgvector(
  sql: Bun.SQL,
  schema: string,
  mode: 'auto' | 'off' | 'require',
): Promise<PgvectorProbeResult> {
  if (mode === 'off') return { status: 'ok', detail: 'pgvector disabled by config' };
  const rows = await sql.unsafe(
    `SELECT n.nspname AS schema_name
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector'
      LIMIT 1`,
  );
  const extensionSchema = (rows[0] as { schema_name?: string } | undefined)?.schema_name;
  if (!extensionSchema) {
    if (mode === 'require') {
      return {
        status: 'fail',
        detail: 'pgvector required but the PostgreSQL `vector` extension is not installed',
        remediation:
          'Install pgvector in the configured database, use a pgvector-enabled image such as `pgvector/pgvector:pg18`, or set `database.pgvector` to `auto`/`off`.',
      };
    }
    return { status: 'ok', detail: 'pgvector unavailable; BYTEA storage with HNSW/in-memory fallbacks active' };
  }
  if (extensionSchema !== schema && extensionSchema !== 'public') {
    const detail = `pgvector installed in schema "${extensionSchema}", outside Cartograph search_path "${schema}, public"`;
    if (mode === 'require') {
      return {
        status: 'fail',
        detail,
        remediation: `Install pgvector in schema "${schema}" or "public", or expose schema "${extensionSchema}" on the Cartograph PostgreSQL search_path.`,
      };
    }
    return { status: 'ok', detail };
  }
  return { status: 'ok', detail: `pgvector available in schema "${extensionSchema}"` };
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function probePostgresDml(sql: Bun.SQL, schema: string): Promise<string | null> {
  const schemaIdent = quoteIdent(schema);
  const probeKey = `__cartograph_doctor_probe_${process.pid}`;
  await sql.unsafe('BEGIN').simple();
  try {
    await sql.unsafe(
      `INSERT INTO ${schemaIdent}.project_metadata (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [probeKey, 'insert', Date.now()],
    );
    await sql.unsafe(`UPDATE ${schemaIdent}.project_metadata SET value = $2 WHERE key = $1`, [probeKey, 'update']);
    await sql.unsafe(`DELETE FROM ${schemaIdent}.project_metadata WHERE key = $1`, [probeKey]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await rollbackQuietly(sql);
  }
}

async function probePostgresDdl(sql: Bun.SQL, schema: string): Promise<string | null> {
  const schemaIdent = quoteIdent(schema);
  await sql.unsafe('BEGIN').simple();
  try {
    await sql.unsafe(`CREATE TABLE ${schemaIdent}.__cartograph_doctor_probe (id INTEGER PRIMARY KEY)`).simple();
    await sql.unsafe(`DROP TABLE ${schemaIdent}.__cartograph_doctor_probe`).simple();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await rollbackQuietly(sql);
  }
}

async function rollbackQuietly(sql: Bun.SQL): Promise<void> {
  try {
    await sql.unsafe('ROLLBACK').simple();
  } catch {
    /* probe rollback is best effort */
  }
}

export async function checkConfiguredModelFiles(llm: Record<string, unknown> | null): Promise<CheckResult | null> {
  const configured = configuredModelFilesFromLlm(llm);
  if (configured.length === 0) return null;

  const missing = (
    await Promise.all(
      configured.map(async (entry) => {
        const exists = await fsp
          .access(entry.modelPath)
          .then(() => true)
          .catch(() => false);
        return exists ? null : { ...entry, partialDownload: await inspectPartialDownload(entry.modelPath) };
      }),
    )
  ).filter((entry): entry is MissingConfiguredModelFile => entry !== null);

  if (missing.length === 0) {
    return {
      id: 'configured-model-files',
      name: 'Configured model files',
      status: 'ok',
      detail: `${configured.length} configured local model file${configured.length === 1 ? '' : 's'} present.`,
    };
  }

  const rendered = missing.slice(0, MAX_RENDERED_MISSING_MODEL_FILES).map(renderMissingConfiguredModelFile).join('; ');
  const suffix =
    missing.length > MAX_RENDERED_MISSING_MODEL_FILES
      ? `; +${missing.length - MAX_RENDERED_MISSING_MODEL_FILES} more`
      : '';
  const hasPartialDownloads = missing.some((m) => m.partialDownload !== null);
  return {
    id: 'configured-model-files',
    name: 'Configured model files',
    status: 'warn',
    detail: `${missing.length} configured local model file${missing.length === 1 ? '' : 's'} missing: ${rendered}${suffix}`,
    remediation: hasPartialDownloads
      ? 'A `.partial` file means a previous model download was interrupted; the installer will remove stale partials and retry. Run `cartograph admin install-models` to finish the recommended GGUF set, edit/remove the unavailable tier(s), or run `cartograph admin install-models --minimal --write-config` to write an embed + 3B chat config.'
      : 'Install the missing GGUFs, edit/remove the unavailable tier(s), or run `cartograph admin install-models --minimal --write-config` to write an embed + 3B chat config.',
  };
}

async function inspectPartialDownload(modelPath: string): Promise<PartialModelFile | null> {
  const partialPath = `${modelPath}.partial`;
  try {
    const stat = await fsp.stat(partialPath);
    if (!stat.isFile()) return null;
    return { path: partialPath, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

function renderMissingConfiguredModelFile(entry: MissingConfiguredModelFile): string {
  const partial = entry.partialDownload;
  if (!partial) return `${entry.tier}: ${entry.modelPath}`;
  return `${entry.tier}: ${entry.modelPath} (partial download found: ${partial.path}, ${formatBytes(
    partial.sizeBytes,
  )})`;
}

/** Pull the parsed `llm` block out of a project's config. */
export async function readLlmFromConfig(projectPath: string): Promise<Record<string, unknown> | null> {
  const configPath = path.join(projectPath, '.cartograph', 'config.json');
  const configExists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) return null;
  try {
    const parsed = loadConfig(projectPath) as unknown as Record<string, unknown>;
    const llm = parsed['llm'] as Record<string, unknown> | undefined;
    if (!llm || typeof llm !== 'object') return null;
    return llm;
  } catch {
    return null;
  }
}
