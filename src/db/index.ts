/**
 * Database Layer
 *
 * Handles graph database initialization and connection management.
 * SQLite is the default backend; PostgreSQL is selected through the
 * configured adapter boundary.
 */

import { type SqliteDatabase, type SqliteBackend, type SqliteStatement, createDatabase } from './sqlite-adapter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CartographConfig } from '../types.js';
import type { SchemaVersion } from './types.js';
import { runMigrations, getCurrentVersion, verifySchemaIntegrity, CURRENT_SCHEMA_VERSION } from './migrations.js';
import { bootstrapPostgresIntentSearch } from './queries-intent-search.js';
import { bootstrapVecTables } from './vec-helpers.js';
import { bootstrapPgvector, bootstrapPgvectorTables } from './pgvector-helpers.js';
import { compact } from '../utils.js';
import { resolveAssetPath } from '../assets.js';
import { enforceProjectRootOwnership, projectRootFromDbPath, withDerivedPostgresSchema } from './project-ownership.js';
import {
  assertPostgresServerVersionSupported,
  readPostgresServerVersionInfo,
  resolveDatabaseConfig,
  type DatabaseConfig,
} from './database-config.js';
import { PostgresAdapter, readPostgresMutationEpoch } from './postgres-adapter.js';

export type { SqliteDatabase, SqliteBackend } from './sqlite-adapter.js';

/** Read the backend's affected-row epoch when it supports one. */
export function readDatabaseMutationEpoch(db: SqliteDatabase): number | null {
  return readPostgresMutationEpoch(db);
}

interface DatabaseOpenOptions {
  database?: CartographConfig['database'];
}

function assertValidDatabasePath(dbPath: string): string {
  if (!dbPath || dbPath.includes('\0')) {
    throw new Error('Invalid database path: path must be a non-empty .db file path');
  }
  const rawSegments = dbPath.split(/[\\/]+/);
  if (rawSegments.includes('..')) {
    throw new Error(`Invalid database path: path traversal segments are not allowed (${dbPath})`);
  }
  if (path.extname(dbPath).toLowerCase() !== '.db') {
    throw new Error(`Invalid database path: expected a .db file (${dbPath})`);
  }

  const resolved = path.resolve(dbPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Invalid database path: refusing to open symlinked database file (${dbPath})`);
    }
    if (stat.isDirectory()) {
      throw new Error(`Invalid database path: expected a .db file, got a directory (${dbPath})`);
    }
  }
  return resolved;
}

function createConfiguredDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): { db: SqliteDatabase; backend: SqliteBackend; vecLoaded: boolean; database: DatabaseConfig } {
  const database = resolveDatabaseConfig(options.database);
  if (database.provider === 'postgres') {
    // No configured schema → derive a per-project one rather than
    // landing every project on `public` (shared-instance separation;
    // see project-ownership.ts).
    withDerivedPostgresSchema(database, projectRootFromDbPath(dbPath));
    const db = new PostgresAdapter({ ...database, provider: 'postgres' });
    try {
      assertPostgresServerVersionSupported(readPostgresServerVersionInfo(db));
    } catch (err) {
      db.close();
      throw err;
    }
    return { db, backend: 'postgres', vecLoaded: false, database };
  }
  return { ...createDatabase(dbPath), database };
}

/**
 * Enforce the open()-time schema-version policy: newer-than-binary
 * always refuses, behind-on-postgres refuses (fresh-init-only, with
 * the pre-derivation implicit-`public` upgrade hint when it applies),
 * behind-on-sqlite migrates only under `autoMigrate`.
 */
function migrateOrRefuse(
  db: SqliteDatabase,
  policy: { backend: SqliteBackend; autoMigrate: boolean; schemaDerived: boolean },
): void {
  const currentVersion = getCurrentVersion(db);
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${currentVersion} is newer than this binary supports (v${CURRENT_SCHEMA_VERSION}). ` +
        `The DB was opened by a newer cartograph process. Upgrade this binary, or query the project from a ` +
        `newer cartograph install.`,
    );
  }
  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;
  if (policy.backend === 'postgres') {
    // A derived schema at v0 is the signature of the pre-1.0.3
    // upgrade path: the project's data lives in the old implicit
    // `public` schema, and the freshly-derived schema is empty.
    const upgradeHint =
      policy.schemaDerived && currentVersion === 0
        ? ` If this project previously stored its index in PostgreSQL's implicit \`public\` schema ` +
          `(the pre-derivation default), set \`database.schema: "public"\` in .cartograph/config.json ` +
          `(or CARTOGRAPH_DATABASE_SCHEMA=public) to reconnect to the existing data.`
        : '';
    throw new Error(
      `PostgreSQL database schema v${currentVersion} is behind this binary's v${CURRENT_SCHEMA_VERSION}. ` +
        `PostgreSQL storage currently supports fresh initialization only; run \`cartograph admin init\` against an ` +
        `empty PostgreSQL schema or recreate the configured schema.${upgradeHint}`,
    );
  }
  if (!policy.autoMigrate) {
    throw new Error(
      `Database schema v${currentVersion} is behind this binary's v${CURRENT_SCHEMA_VERSION}. ` +
        `Refusing to silently migrate — running the migration would lock out any process still ` +
        `bound to the older schema (typically a long-running MCP server).\n\n` +
        `To upgrade explicitly, run ONE of:\n` +
        `  cartograph admin migrate   # apply forward migrations only (cheapest)\n` +
        `  cartograph admin sync       # migrate + incremental re-extract\n` +
        `  cartograph admin index --force  # migrate + full re-extract\n\n` +
        `After migrating, restart any MCP server still bound to the old schema (its tools will ` +
        `return "stale code, restart" until you do).`,
    );
  }
  runMigrations(db, currentVersion);
}

/** Apply standard PRAGMAs to a freshly-opened SQLite database. */
function dbApplyPragmas(db: SqliteDatabase): void {
  // busy_timeout MUST be applied first: `journal_mode = WAL` and
  // `auto_vacuum` both acquire a lock, and a coexisting process (MCP
  // server file-watcher, background summarizer) can hold one. Without
  // the timeout already in effect, those pragmas throw `database is
  // locked` immediately instead of waiting — observed as an unhandled
  // rejection on CLI cold-start while the MCP server was running.
  // Wait up to 2 minutes (indexing operations can hold locks a while).
  db.pragma('busy_timeout = 120000');
  // Incremental auto-vacuum — freed pages go onto the freelist and are
  // returned to the OS by `PRAGMA incremental_vacuum` (run from
  // `dbRunMaintenance`). Set early, before any table exists: on a fresh
  // DB it takes effect immediately; on an existing one it primes the
  // mode so the next VACUUM converts the file. Without it the DB only
  // ever grows — re-indexes and migrations leave dead pages that are
  // never reclaimed (a real index was observed at 72% freelist / ~760 MB
  // of dead space).
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // Safe with WAL mode
  db.pragma('cache_size = -64000'); // 64 MB page cache
  db.pragma('temp_store = MEMORY'); // Temp tables in memory
  db.pragma('mmap_size = 268435456'); // 256 MB memory-mapped I/O
  // G21 — wal_autocheckpoint. bun:sqlite's default is 1000 pages
  // (~4 MB at the 4 KB page default), which fires far too often
  // during the postHook write storm. Empirically swept on a
  // 5000-file synthetic with 3-import cross-file edge density
  // (`BENCH_FILE_COUNT=5000 bun bench/wal-autocheckpoint.mts` —
  // the bench's default `BENCH_AUTOCHECKPOINT_VALUES` reproduces
  // the table below):
  //
  //   value (pages)   median wall   transient WAL ceiling
  //   1000 (default)        8584ms                  ~10 MB
  //   5000                  7675ms (-11%)           ~22 MB
  //   10000                 7447ms (-13%)           ~44 MB
  //   20000                 7204ms (-16%)           ~82 MB    ← knee
  //   40000                 7154ms (-17%)          ~163 MB
  //
  // 20000 is the knee — 96% of the 40000 win for half the WAL
  // ceiling. The WAL is transient (checkpointed to the main DB on
  // close), so the ceiling cost is paid only during an active
  // index/sync. The CARTOGRAPH_WAL_AUTOCHECKPOINT env override is
  // bench-only scaffolding for re-running the sweep; production
  // callers should not set it.
  const walAutocheckpointRaw = process.env['CARTOGRAPH_WAL_AUTOCHECKPOINT'];
  if (walAutocheckpointRaw === undefined) {
    db.pragma('wal_autocheckpoint = 20000');
  } else {
    const n = Number(walAutocheckpointRaw);
    if (Number.isFinite(n) && n >= 0) db.pragma(`wal_autocheckpoint = ${Math.floor(n)}`);
  }
}

/** Core state bundle — groups the four immutable fields to keep the class lean. */
interface DbCore {
  db: SqliteDatabase;
  dbPath: string;
  backend: SqliteBackend;
  vecLoaded: boolean;
}

/**
 * Database connection wrapper with lifecycle management
 */
export class DatabaseConnection {
  private readonly core: DbCore;

  private constructor(core: DbCore) {
    this.core = core;
  }

  /**
   * Initialize a new database at the given path
   */
  static initialize(dbPath: string, opts: DatabaseOpenOptions = {}): DatabaseConnection {
    const resolvedDbPath = assertValidDatabasePath(dbPath);
    const dir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { db, backend, vecLoaded, database } = createConfiguredDatabase(resolvedDbPath, opts);
    // Same close-before-rethrow as open(): the postgres worker
    // thread otherwise pins the process open after a refusal.
    try {
      if (db.dialect === 'sqlite') dbApplyPragmas(db);

      const schemaPath = resolveAssetPath('db', db.dialect === 'postgres' ? 'schema-postgres.sql' : 'schema.sql');
      db.exec(fs.readFileSync(schemaPath, 'utf-8'));

      // Fresh-bootstrap integrity gate: if schema.sql was edited in a
      // way that omits a table or view, fail loud rather than mark the
      // DB as fully migrated and let the divergence escape into queries
      // that error at read time (the production-DB state that triggered
      // migration 057).
      if (db.dialect === 'sqlite') verifySchemaIntegrity(db);

      // `initialize` is the FRESH-database path: schema.sql builds every
      // table at CURRENT_SCHEMA_VERSION, so a genuinely fresh DB has an
      // empty schema_versions (version 0) and we stamp it current. But
      // schema.sql is all `CREATE TABLE IF NOT EXISTS`, so if it ran over a
      // NON-EMPTY DB already at an older version, those CREATEs no-oped and
      // the physical schema is still behind — stamping CURRENT here would
      // claim migrations ran that didn't, and `open()` would then never
      // migrate it (the version claims current). Refuse loudly instead.
      const currentVersion = getCurrentVersion(db);
      if (currentVersion === 0) {
        db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
          CURRENT_SCHEMA_VERSION,
          Date.now(),
          'Initial schema includes all migrations',
        );
      } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Refusing to initialize over an existing schema v${currentVersion} (binary is v${CURRENT_SCHEMA_VERSION}). ` +
            `\`init\` only stamps a fresh database; this DB is behind and its tables were not migrated by schema.sql ` +
            `(all CREATE TABLE IF NOT EXISTS). Run \`cartograph admin migrate\` to upgrade it, or initialize against ` +
            `an empty database / schema.`,
        );
      }

      // No-op on first init; kept for symmetry with `open()`.
      bootstrapVecTables(db, vecLoaded);
      if (backend === 'postgres') {
        const pgvectorLoaded = bootstrapPgvector(db, database);
        bootstrapPgvectorTables(db, pgvectorLoaded);
        // First open of a fresh schema stamps ownership; initializing
        // into a schema another project owns fails loudly.
        enforceProjectRootOwnership(db, resolvedDbPath, database.schema);
      }
      if (backend === 'postgres' && !fs.existsSync(resolvedDbPath)) {
        fs.writeFileSync(resolvedDbPath, 'postgres provider sentinel\n', 'utf-8');
      }

      return new DatabaseConnection({ db, dbPath: resolvedDbPath, backend, vecLoaded });
    } catch (err) {
      try {
        db.close();
      } catch {
        /* already closing on the error path */
      }
      throw err;
    }
  }

  /**
   * Open an existing database.
   *
   * Migration policy is gated by `opts.autoMigrate` (default `false`).
   * Read-style callers leave it false and get a clear error when the
   * DB is behind, so a silent migration can't lock out a long-lived
   * MCP server bound to the older schema. Write/admin entry points
   * (admin sync/index/migrate, embed, summarize, classify, coverage
   * load) opt in with `autoMigrate: true`. Newer-than-binary DBs
   * always fail to prevent silent old-code-vs-new-data corruption.
   */
  static open(
    dbPath: string,
    opts: { autoMigrate?: boolean; database?: CartographConfig['database'] } = {},
  ): DatabaseConnection {
    const resolvedDbPath = assertValidDatabasePath(dbPath);
    const database = resolveDatabaseConfig(opts.database);
    if (database.provider === 'sqlite' && !fs.existsSync(resolvedDbPath)) {
      throw new Error(`Database not found: ${resolvedDbPath}`);
    }

    // Re-capture the resolved config: createConfiguredDatabase fills
    // in the derived per-project schema for postgres, and the
    // bootstrap + ownership steps below must see that final value.
    const {
      db,
      backend,
      vecLoaded,
      database: resolvedDatabase,
    } = createConfiguredDatabase(resolvedDbPath, {
      database,
    });
    if (db.dialect === 'sqlite') dbApplyPragmas(db);

    const conn = new DatabaseConnection({ db, dbPath: resolvedDbPath, backend, vecLoaded });
    // try/catch wraps everything after connection creation: the
    // postgres adapter runs a worker thread that otherwise keeps the
    // process alive forever after a guard/version refusal — a
    // mismatch would HANG the CLI instead of exiting (observed live
    // on the ownership-mismatch path).
    try {
      migrateOrRefuse(db, {
        backend,
        autoMigrate: opts.autoMigrate === true,
        schemaDerived: resolvedDatabase.schemaDerived === true,
      });

      // Bootstrap vec0 tables when the sqlite-vec extension is loaded.
      bootstrapVecTables(db, vecLoaded);
      if (backend === 'postgres') {
        // Additive indexes for existing PostgreSQL schemas are DDL and may
        // take locks on large tables. Run them only on explicit write/admin
        // opens, never as a side effect of an ordinary read-style open.
        if (opts.autoMigrate === true) bootstrapPostgresIntentSearch(db);
        const pgvectorLoaded = bootstrapPgvector(db, resolvedDatabase);
        bootstrapPgvectorTables(db, pgvectorLoaded);
        // Schema is at CURRENT version here, so project_metadata exists.
        // Stamp-or-verify which project owns this schema — two projects
        // misconfigured onto one schema fail loudly instead of silently
        // interleaving graphs (shared-instance separation).
        enforceProjectRootOwnership(db, resolvedDbPath, resolvedDatabase.schema);
      }

      return conn;
    } catch (err) {
      try {
        conn.close();
      } catch {
        /* already closing on the error path */
      }
      throw err;
    }
  }

  /** Get the underlying database instance. */
  getDb(): SqliteDatabase {
    return this.core.db;
  }

  /** Prepare a statement under the backend's database-enforced read-only mode. */
  prepareReadOnly(sql: string): SqliteStatement {
    const prepareReadOnly = this.core.db.prepareReadOnly;
    if (!prepareReadOnly) {
      throw new Error(`Database adapter ${this.core.db.dialect} does not implement read-only statement execution.`);
    }
    return prepareReadOnly.call(this.core.db, sql);
  }

  /**
   * Get the storage backend serving this connection. Per-instance so
   * MCP explicit-project queries report the right backend.
   */
  getBackend(): SqliteBackend {
    return this.core.backend;
  }

  /**
   * Whether the sqlite-vec extension is loaded into this connection.
   * When true, vec0 virtual tables and KNN syntax are available.
   */
  hasVecExtension(): boolean {
    return this.core.vecLoaded;
  }

  /** Get database file path. */
  getPath(): string {
    return this.core.dbPath;
  }

  /** Get current schema version. */
  getSchemaVersion(): SchemaVersion | null {
    const row = this.core.db
      .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number; description: string | null } | undefined;
    if (!row) return null;
    return compact({
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description ?? undefined,
    });
  }

  /** Execute a function within a transaction. */
  transaction<T>(fn: () => T): T {
    return this.core.db.transaction(fn)();
  }

  /** Get database file size in bytes. */
  getSize(): number {
    if (this.core.backend === 'postgres') {
      return readPostgresSchemaSizeBytes(this.core.db);
    }
    return fs.statSync(this.core.dbPath).size;
  }

  /** Close the database connection. */
  close(): void {
    this.core.db.close();
  }

  /** Check if the database connection is open. */
  isOpen(): boolean {
    return this.core.db.open;
  }
}

// ===========================================================================
// Free-standing DB utility functions (extracted from DatabaseConnection to
// keep the class below the god_class threshold)
// ===========================================================================

/** PostgreSQL storage is schema-per-project, so status should report the
 * active schema's live relation size rather than pg_database_size(), which
 * includes every other project sharing the same database.
 */
export function readPostgresSchemaSizeBytes(db: SqliteDatabase): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n
       FROM pg_class c
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = current_schema()
         AND c.relkind IN ('r', 'p', 'm')`,
    )
    .get() as { n?: number | string | bigint } | null;
  const n = row?.n;
  if (typeof n === 'number') return n;
  if (typeof n === 'bigint') return Number(n);
  return Number(n ?? 0);
}

type DatabaseMaintenanceActivity = 'after-write' | 'idle';

interface DatabaseMaintenanceConnection {
  getBackend(): SqliteBackend;
  getDb(): Pick<SqliteDatabase, 'exec' | 'pragma'>;
}

/** Optimize SQLite storage; PostgreSQL performs a schema-scoped statistics refresh. */
export function dbOptimize(conn: DatabaseMaintenanceConnection): void {
  if (conn.getBackend() === 'postgres') {
    dbRunMaintenance(conn);
    return;
  }
  conn.getDb().exec('VACUUM');
  conn.getDb().exec('ANALYZE');
}

/** Freelist ratio (0.25 = 25%) at or above which a non-incremental
 *  (auto_vacuum ≠ 2) DB is worth a full VACUUM to reclaim dead pages.
 *  The VACUUM also converts the file to INCREMENTAL mode, so this
 *  branch fires at most once per legacy DB. */
const RECLAIM_FREELIST_RATIO = 0.25;

/** Read a single-value integer PRAGMA through the backend adapter.
 *  SQLite returns one row object for read pragmas through the Bun
 *  adapter, while PostgreSQL compatibility pragmas return the same
 *  shape with zero values for SQLite-only settings. */
function readPragmaInt(db: Pick<SqliteDatabase, 'pragma'>, name: string): number {
  const raw = db.pragma(name);
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  const v = row ? Object.values(row)[0] : 0;
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * Return free pages to the OS so the DB file tracks its live size.
 *
 * Incremental-auto-vacuum DBs (every DB created since auto_vacuum was
 * wired into `dbApplyPragmas`): `PRAGMA incremental_vacuum` releases the
 * freelist cheaply — work proportional to the freelist, no full-file
 * rewrite — so it runs every maintenance pass.
 *
 * Legacy DBs (auto_vacuum=0, created before that): only a full VACUUM
 * can shrink them. Gated on a meaningful freelist ratio so a healthy
 * legacy DB isn't rewritten for nothing; the VACUUM also converts the
 * file to INCREMENTAL, so this branch fires at most once per legacy DB
 * — afterwards it takes the cheap incremental path.
 */
function dbReclaimFreePages(conn: DatabaseMaintenanceConnection): void {
  const db = conn.getDb();
  if (readPragmaInt(db, 'auto_vacuum') === 2 /* INCREMENTAL */) {
    db.exec('PRAGMA incremental_vacuum');
    return;
  }
  const pageCount = readPragmaInt(db, 'page_count');
  const freelist = readPragmaInt(db, 'freelist_count');
  if (pageCount > 0 && freelist / pageCount >= RECLAIM_FREELIST_RATIO) {
    // Re-assert the target mode so the VACUUM converts the file (it
    // rebuilds in whatever auto_vacuum mode is currently set).
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
  }
}

/**
 * WAL truncate checkpoints can wait on active readers. Keep the
 * maintenance pass bounded — if another process is reading, skip the
 * truncation and let a later pass pick it up.
 */
const WAL_TRUNCATE_BUSY_TIMEOUT_MS = 250;

/**
 * PostgreSQL `ANALYZE` without a relation list walks every eligible table in
 * the database, including unrelated Cartograph project schemas. Run one
 * skip-locked statement per relation in only the active schema instead. This
 * avoids waiting when the initial relation lock is already held and reduces
 * conflict risk; PostgreSQL may still wait later on indexes or partitions.
 */
const POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL = `
DO $cartograph$
DECLARE
  relation_name text;
BEGIN
  FOR relation_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p', 'm')
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ANALYZE (SKIP_LOCKED) %I.%I',
      current_schema(),
      relation_name
    );
  END LOOP;
END
$cartograph$;
`;

function dbCheckpointWal(
  conn: DatabaseMaintenanceConnection,
  mode: 'PASSIVE' | 'TRUNCATE',
  opts: { busyTimeoutMs?: number } = {},
): void {
  const db = conn.getDb();
  if (opts.busyTimeoutMs === undefined) {
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
    return;
  }

  const priorBusyTimeout = readPragmaInt(db, 'busy_timeout');
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
  } finally {
    db.pragma(`busy_timeout = ${priorBusyTimeout}`);
  }
}

/**
 * Lightweight maintenance to run after bulk writes (indexAll, sync):
 * `PRAGMA optimize`, a freelist reclaim (`dbReclaimFreePages`), then a
 * bounded WAL truncate checkpoint. Every step is best-effort — failures
 * are swallowed and never load-bearing.
 *
 * The reclaim is cheap in steady state (`incremental_vacuum` over a
 * small freelist). The one heavy case is the first run against a
 * pre-existing legacy DB bloated with dead pages — a single full VACUUM
 * compacts it and converts it to incremental for good.
 *
 * The final TRUNCATE checkpoint is what keeps the on-disk `*.db-wal`
 * from staying large after post-hook write storms. It is attempted with
 * a short busy timeout so a long-lived reader cannot make routine sync
 * or index completion hang.
 *
 * PostgreSQL differs in two important ways: an idle sync does nothing, and a
 * write-bearing pass analyzes only the active project schema with
 * `SKIP_LOCKED` relation acquisition to reduce lock conflicts. A database-wide
 * `ANALYZE` from every no-op watcher sync can otherwise cancel autovacuum across
 * all project schemas and create unbounded dead-tuple growth.
 */
export function dbRunMaintenance(
  conn: DatabaseMaintenanceConnection,
  activity: DatabaseMaintenanceActivity = 'after-write',
): void {
  if (conn.getBackend() === 'postgres') {
    if (activity === 'idle') return;
    try {
      conn.getDb().exec(POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    conn.getDb().exec('PRAGMA optimize');
  } catch {
    /* ignore */
  }
  try {
    dbReclaimFreePages(conn);
  } catch {
    /* ignore */
  }
  try {
    dbCheckpointWal(conn, 'TRUNCATE', { busyTimeoutMs: WAL_TRUNCATE_BUSY_TIMEOUT_MS });
  } catch {
    /* ignore */
  }
}

/**
 * Aggressively reclaim disk after a bulk DELETE (e.g. `prune-store`
 * evicting tens of thousands of orphan embedding rows). This is the
 * reclaim-only subset of `dbRunMaintenance`, for call sites that do not
 * need a planner-stats refresh:
 *
 *   1. `incremental_vacuum` — return the freelist to the OS (auto_vacuum
 *      DBs). For a legacy auto_vacuum=0 DB this falls through to the
 *      ratio-gated full VACUUM inside `dbReclaimFreePages`.
 *   2. `wal_checkpoint(TRUNCATE)` — flush every modified page into the
 *      main DB and reset the `-wal` file to zero length, so the freed
 *      space is actually gone from disk and not merely shifted.
 *
 * Every step is best-effort — failures are swallowed and never
 * load-bearing (a TRUNCATE checkpoint can be blocked by a concurrent
 * reader; the next maintenance pass picks it up).
 */
export function dbReclaimAfterBulkDelete(conn: DatabaseConnection): void {
  try {
    dbReclaimFreePages(conn);
  } catch {
    /* ignore */
  }
  try {
    dbCheckpointWal(conn, 'TRUNCATE', { busyTimeoutMs: WAL_TRUNCATE_BUSY_TIMEOUT_MS });
  } catch {
    /* ignore */
  }
}

/**
 * Default database filename
 */
const DATABASE_FILENAME = 'cartograph.db';

/**
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.cartograph', DATABASE_FILENAME);
}
