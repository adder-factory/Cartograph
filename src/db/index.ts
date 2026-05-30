/**
 * Database Layer
 *
 * Handles SQLite database initialization and connection management.
 */

import { type SqliteDatabase, type SqliteBackend, createDatabase } from './sqlite-adapter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaVersion } from '../types.js';
import { runMigrations, getCurrentVersion, verifySchemaIntegrity, CURRENT_SCHEMA_VERSION } from './migrations.js';
import { bootstrapVecTables } from './vec-helpers.js';
import { compact } from '../utils.js';

export type { SqliteDatabase, SqliteBackend } from './sqlite-adapter.js';

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
  static initialize(dbPath: string): DatabaseConnection {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { db, backend, vecLoaded } = createDatabase(dbPath);
    dbApplyPragmas(db);

    const schemaPath = path.join(import.meta.dirname, 'schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf-8'));

    // Fresh-bootstrap integrity gate: if schema.sql was edited in a
    // way that omits a table or view, fail loud rather than mark the
    // DB as fully migrated and let the divergence escape into queries
    // that error at read time (the production-DB state that triggered
    // migration 057).
    verifySchemaIntegrity(db);

    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
        CURRENT_SCHEMA_VERSION,
        Date.now(),
        'Initial schema includes all migrations',
      );
    }

    // No-op on first init; kept for symmetry with `open()`.
    bootstrapVecTables(db, vecLoaded);

    return new DatabaseConnection({ db, dbPath, backend, vecLoaded });
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
  static open(dbPath: string, opts: { autoMigrate?: boolean } = {}): DatabaseConnection {
    if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

    const { db, backend, vecLoaded } = createDatabase(dbPath);
    dbApplyPragmas(db);

    const conn = new DatabaseConnection({ db, dbPath, backend, vecLoaded });
    const currentVersion = getCurrentVersion(db);
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${currentVersion} is newer than this binary supports (v${CURRENT_SCHEMA_VERSION}). ` +
          `The DB was opened by a newer cartograph process. Upgrade this binary, or query the project from a ` +
          `newer cartograph install.`,
      );
    }
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      if (!opts.autoMigrate) {
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

    // Bootstrap vec0 tables when the sqlite-vec extension is loaded.
    bootstrapVecTables(db, vecLoaded);

    return conn;
  }

  /** Get the underlying database instance. */
  getDb(): SqliteDatabase {
    return this.core.db;
  }

  /**
   * Get the SQLite backend serving this connection. Per-instance so
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

/** Optimize database (vacuum and analyze). */
export function dbOptimize(conn: DatabaseConnection): void {
  conn.getDb().exec('VACUUM');
  conn.getDb().exec('ANALYZE');
}

/** Freelist ratio (0.25 = 25%) at or above which a non-incremental
 *  (auto_vacuum ≠ 2) DB is worth a full VACUUM to reclaim dead pages.
 *  The VACUUM also converts the file to INCREMENTAL mode, so this
 *  branch fires at most once per legacy DB. */
const RECLAIM_FREELIST_RATIO = 0.25;

/** Read a single-value integer PRAGMA through the backend adapter.
 *  The two backends return different shapes: the node:sqlite adapter
 *  yields one row object (`{auto_vacuum: 2}`) while better-sqlite3's
 *  native `pragma()` yields an array of rows (`[{auto_vacuum: 2}]`) —
 *  unwrap both before pulling the single value. */
function readPragmaInt(db: SqliteDatabase, name: string): number {
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
function dbReclaimFreePages(conn: DatabaseConnection): void {
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
 * Lightweight maintenance to run after bulk writes (indexAll, sync):
 * `PRAGMA optimize`, a passive WAL checkpoint, then a freelist reclaim
 * (`dbReclaimFreePages`). Every step is best-effort — failures are
 * swallowed and never load-bearing.
 *
 * The reclaim is cheap in steady state (`incremental_vacuum` over a
 * small freelist). The one heavy case is the first run against a
 * pre-existing legacy DB bloated with dead pages — a single full VACUUM
 * compacts it and converts it to incremental for good.
 */
export function dbRunMaintenance(conn: DatabaseConnection): void {
  try {
    conn.getDb().exec('PRAGMA optimize');
  } catch {
    /* ignore */
  }
  try {
    conn.getDb().exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    /* ignore */
  }
  try {
    dbReclaimFreePages(conn);
  } catch {
    /* ignore */
  }
}

/**
 * Aggressively reclaim disk after a bulk DELETE (e.g. `prune-store`
 * evicting tens of thousands of orphan embedding rows).
 *
 * `dbRunMaintenance` alone is insufficient here: its PASSIVE checkpoint
 * runs *before* the freelist reclaim, so the pages that
 * `incremental_vacuum` shuffles end up parked in the WAL and never get
 * folded back into the main file — the `.db` shrinks but the `.db-wal`
 * balloons to match. This helper sequences the steps correctly:
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
    conn.getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
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
