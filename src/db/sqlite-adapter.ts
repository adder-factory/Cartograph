/**
 * SQLite Adapter — Bun-only.
 *
 * Wraps `bun:sqlite`'s `Database` in the `SqliteDatabase` interface the
 * rest of the codebase talks to. Single backend, no fallbacks: cartograph
 * runs on Bun, so `bun:sqlite` is the only SQLite path. The previous
 * NodeSqliteAdapter + better-sqlite3 fallback were dropped in the
 * all-in-Bun consolidation.
 *
 * Smoothed-over differences vs the prior NodeSqliteAdapter shape:
 * - bun:sqlite's `.transaction(fn)` is native (SAVEPOINT-aware), so the
 *   depth-tracking savepoint dance from NodeSqliteAdapter is gone.
 * - `pragma()` has no dedicated method; route through prepare()/exec()
 *   directly. Same shape NodeSqliteAdapter used.
 * - `.open` property doesn't exist on the Bun handle; tracked manually.
 * - macOS-only: Apple's system libsqlite3 has SQLITE_OMIT_LOAD_EXTENSION,
 *   so `loadExtension()` would fail. The fix is `Database.setCustomSQLite()`
 *   pointing at a Homebrew libsqlite3 — applied once at module load before
 *   the first Database constructor runs.
 *
 * `strict: true` is set on every Database — matches better-sqlite3 +
 * node:sqlite semantics so bare named-param keys (`{id: 1}` binds to
 * `@id`) work and unknown params throw instead of binding NULL silently.
 * The `extractNamedPlaceholders` filter below absorbs the deliberate
 * superset-binding pattern (`bindingsFromObject(record, FULL_SCHEMA)`
 * passing more keys than the SQL references — canonical:
 * `upsertFile` SCHEMA includes churn-managed columns the SQL omits).
 */

import { createRequire } from 'module';
import { errMsg } from '../errors.js';

// `createRequire` lets ESM modules synchronously load `bun:sqlite` +
// `sqlite-vec`. Dynamic `await import()` would force createDatabase to
// become async and cascade through every caller.
const requireCjs = createRequire(import.meta.url);

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * Streaming row iterator. Lets memory-bounded callers early-exit a
   * query without materialising the full result set. Use this for any
   * query whose row count could exceed the agent's tolerance for large
   * payloads (cartograph_sql escape hatch, large grep result merges).
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
  /**
   * SQLite extension loader — exposed so sqlite-vec.load(db) duck-types
   * it directly without unwrapping the adapter.
   */
  loadExtension?(file: string, entrypoint?: string): void;
}

export type SqliteBackend = 'bun-sqlite';

/**
 * Pull every `@name`, `:name`, `$name` placeholder out of a SQL string.
 * Used to filter named-binding objects down to the keys the SQL actually
 * references — bun:sqlite (in strict mode) throws on unused params,
 * while callers deliberately pass superset binding objects (canonical:
 * `upsertFile`'s SCHEMA includes churn-managed columns the SQL omits).
 *
 * The regex is permissive: it doesn't try to track string-literal
 * boundaries, so a `@name` token inside a quoted string would also be
 * returned. That's fine in this codebase — no SQL strings use that
 * shape, and over-including is harmless.
 *
 * Trade-off: this also silences the strict-mode "Unknown named
 * parameter" diagnostic that would have caught a typo'd binding key.
 * Acceptable here because the codebase uses superset-binding patterns
 * on purpose. If a typo bug surfaces, the symptom will be "value not
 * bound" / NULL rather than a thrown error.
 */
function extractNamedPlaceholders(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /[@:$]([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Buffer) &&
    !(value instanceof Uint8Array)
  );
}

// ─── Bun setCustomSQLite (macOS only) ────────────────────────────────────────
// bun:sqlite uses the system libsqlite3 on macOS by default — and Apple's
// bundled copy has SQLITE_OMIT_LOAD_EXTENSION, so loadExtension() fails with
// "This build of sqlite3 does not support dynamic extension loading". The
// workaround is `Database.setCustomSQLite(path)` pointing at a Homebrew
// libsqlite3, called BEFORE the first Database constructor runs.
//
// Path resolution:
//   1. CARTOGRAPH_BUN_SQLITE_PATH env var (explicit override)
//   2. /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib (arm64 Homebrew default)
//   3. /usr/local/opt/sqlite/lib/libsqlite3.dylib   (Intel Homebrew default)
//
// On Linux this is a no-op — bun:sqlite ships its own recent SQLite with
// extension loading enabled.
let bunCustomSqliteApplied = false;
function applyBunCustomSqliteOnce(): void {
  if (bunCustomSqliteApplied || process.platform !== 'darwin') return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = requireCjs('bun:sqlite') as { Database: { setCustomSQLite?: (p: string) => void } };
  if (typeof Database.setCustomSQLite !== 'function') return;
  const candidates = [
    process.env['CARTOGRAPH_BUN_SQLITE_PATH'],
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const candidate of candidates) {
    try {
      Database.setCustomSQLite(candidate);
      bunCustomSqliteApplied = true;
      return;
    } catch {
      // Try the next candidate.
    }
  }
  // Mark applied anyway so we don't retry on every connection; without a
  // custom SQLite the bun:sqlite default still works for non-extension paths,
  // and vec0 will simply report unavailable via tryLoadVecExtension.
  bunCustomSqliteApplied = true;
}

interface BunSqliteHandle {
  prepare(sql: string): unknown;
  exec(sql: string): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  loadExtension(file: string, entrypoint?: string): void;
  close(): void;
}

export class BunSqliteAdapter implements SqliteDatabase {
  private _db: BunSqliteHandle;
  private _open: boolean;

  constructor(dbPath: string) {
    applyBunCustomSqliteOnce();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = requireCjs('bun:sqlite') as {
      Database: new (path: string, opts?: { strict?: boolean }) => BunSqliteHandle;
    };
    this._db = new Database(dbPath, { strict: true });
    this._open = true;
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql) as {
      run: (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
      iterate?: (...args: unknown[]) => IterableIterator<unknown>;
    };
    const placeholders = extractNamedPlaceholders(sql);
    const filterParams = (params: unknown[]): unknown[] => {
      if (params.length !== 1 || !isPlainObject(params[0])) return params;
      if (placeholders.size === 0) return params;
      const obj = params[0];
      const filtered: Record<string, unknown> = {};
      for (const key of placeholders) {
        if (key in obj) filtered[key] = obj[key];
      }
      return [filtered];
    };
    return {
      run(...params: unknown[]) {
        const result = stmt.run(...filterParams(params));
        return {
          changes: typeof result.changes === 'bigint' ? Number(result.changes) : result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get(...params: unknown[]) {
        return stmt.get(...filterParams(params));
      },
      all(...params: unknown[]) {
        return stmt.all(...filterParams(params));
      },
      iterate(...params: unknown[]) {
        if (typeof stmt.iterate === 'function') return stmt.iterate(...filterParams(params));
        const rows = stmt.all(...filterParams(params));
        return rows[Symbol.iterator]();
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string): unknown {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return undefined;
    }
    return (this._db.prepare(`PRAGMA ${trimmed}`) as { get: () => unknown }).get();
  }

  loadExtension(file: string, entrypoint?: string): void {
    this._db.loadExtension(file, entrypoint);
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return this._db.transaction(fn);
  }

  close(): void {
    if (!this._open) return;
    this._db.close();
    this._open = false;
  }
}

/**
 * Try to load the sqlite-vec extension into the connection.
 * Optional dep — failure is normal (extension not installed for this
 * platform). Returns `true` only if the load succeeded AND a
 * smoke-test SELECT confirmed `vec_version()` is available.
 *
 * Side effect on success: subsequent SQL on this connection can use
 * `vec0` virtual tables and the `MATCH ... AND k = N` KNN syntax.
 */
function tryLoadVecExtension(db: SqliteDatabase): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = requireCjs('sqlite-vec');
    sqliteVec.load(db);
    const probe = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
    return !!(probe && typeof probe.v === 'string');
  } catch {
    return false;
  }
}

/**
 * Create a database connection on `bun:sqlite`. Single backend, no
 * fallbacks. Returns the active backend tag alongside the db so each
 * `DatabaseConnection` can report its own backend (instead of relying
 * on a process-global singleton, which would race when multiple DBs
 * are opened in the same process — e.g. MCP explicit-project queries).
 *
 * `vecLoaded` reports whether the sqlite-vec extension was successfully
 * loaded into THIS connection. The query layer keys an indexed-vector
 * path off this flag; when false, similarity search uses the existing
 * in-memory brute-force cache.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend; vecLoaded: boolean } {
  try {
    const db = new BunSqliteAdapter(dbPath);
    const vecLoaded = tryLoadVecExtension(db);
    return { db, backend: 'bun-sqlite', vecLoaded };
  } catch (error) {
    throw new Error(`Failed to open bun:sqlite at ${dbPath}: ${errMsg(error)}`);
  }
}
