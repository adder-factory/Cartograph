/**
 * Purpose-built fixture codebase for the ranking-regression gate
 * (`ranking-regression.test.ts`).
 *
 * Hand-crafted rather than synthesised so the symbol set has the
 * deliberate ranking TRAPS a regression gate needs:
 *
 *  - **Token-collision shape symbols.** The watcher cluster carries
 *    three `Watcher*` interfaces (`WatcherOptions` / `WatcherStats` /
 *    `WatcherState`) that all match the token "watcher" — they exist
 *    to compete with the gating *function* `watcherHandleFileEvent`
 *    for entry-point slots. This is the F-r9-1 shape: a behaviour
 *    query ("how does the file watcher trigger a sync") that the
 *    scorer used to answer with shape symbols while dropping the
 *    function that actually does the work.
 *  - **Distinct themes** (watcher/sync, auth, payment, cache, db) so a
 *    themed query has something to be discriminated *against* — a
 *    scorer that returns everything for everything fails these.
 *  - **Cross-file calls** so the graph has real centrality + edges;
 *    ranking that ignores centrality ranks differently.
 *
 * Keep the corpus small (indexes in well under a second) but never
 * trivially small — ranking only means something when symbols
 * compete.
 */

export const RANKING_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/watcher.ts': `import { runSync } from './sync.js';

/** Tuning knobs for a {@link FileWatcher}. */
export interface WatcherOptions { debounceMs: number; }
/** Counters a watcher reports back. */
export interface WatcherStats { eventsHandled: number; lastEventAt: number; }
/** Mutable run-state carried between file events. */
export interface WatcherState { running: boolean; pending: string[]; }

/**
 * Decide whether a file-system event should trigger a sync. This is
 * the gating function — the real answer to "how does the watcher
 * trigger a sync" — and must out-rank the Watcher* shape interfaces.
 */
export function watcherHandleFileEvent(state: WatcherState, path: string): void {
  state.pending.push(path);
  if (state.pending.length > 0) {
    runSync(state.pending);
    state.pending = [];
  }
}

/** Watches a directory and forwards events to the gating function. */
export class FileWatcher {
  private state: WatcherState = { running: false, pending: [] };
  constructor(private options: WatcherOptions) {}
  start(): void { this.state.running = true; }
  onEvent(path: string): void { watcherHandleFileEvent(this.state, path); }
  getStats(): WatcherStats { return { eventsHandled: 0, lastEventAt: Date.now() }; }
}
`,

  'src/sync.ts': `/** Outcome of an incremental sync pass. */
export interface SyncResult { changed: number; }

/** Run an incremental sync over a set of changed files. */
export function runSync(files: string[]): SyncResult {
  return syncChangedFiles(files);
}

/** Re-index only the files that actually changed. */
export function syncChangedFiles(files: string[]): SyncResult {
  return { changed: files.length };
}
`,

  'src/auth.ts': `/** An authenticated user session. */
export interface AuthSession { userId: string; token: string; }

/** Check that an auth token is well-formed. */
export function validateToken(token: string): boolean {
  return token.length > 0;
}

/** Authenticate a user and open a session. */
export function authenticateUser(name: string, token: string): AuthSession | null {
  if (!validateToken(token)) return null;
  return { userId: name, token };
}
`,

  'src/payment.ts': `/** Result of a payment attempt. */
export interface PaymentResult { ok: boolean; amount: number; }

/** Charge a payment for the given amount. */
export function processPayment(amount: number): PaymentResult {
  return { ok: amount > 0, amount };
}

/** Reverse a previously-charged payment. */
export function refundPayment(amount: number): PaymentResult {
  return processPayment(-amount);
}
`,

  'src/cache.ts': `/** A tiny in-memory key/value cache. */
export class CacheStore {
  private entries = new Map<string, unknown>();
  lookup(key: string): unknown { return cacheLookup(this.entries, key); }
  invalidate(key: string): void { invalidateCache(this.entries, key); }
}

/** Read a value out of the cache. */
export function cacheLookup(entries: Map<string, unknown>, key: string): unknown {
  return entries.get(key);
}

/** Evict a stale entry from the cache. */
export function invalidateCache(entries: Map<string, unknown>, key: string): void {
  entries.delete(key);
}
`,

  'src/db.ts': `/** A handle to a database connection. */
export interface DbConnection { url: string; }

/** Run a SQL query against the database. */
export function queryDatabase(conn: DbConnection, sql: string): unknown[] {
  return [conn.url, sql];
}
`,

  'src/postgres-maintenance.ts': `/** Refresh only the active PostgreSQL schema's planner statistics. */
export const POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL = 'ANALYZE';

export interface SyncWriteResult { filesModified: number; hookWrites: number; }
export interface MaintenanceDb { exec(sql: string): void; }

/** Decide whether a sync wrote anything that makes PostgreSQL ANALYZE useful. */
export function cgSyncHasDatabaseWrites(result: SyncWriteResult): boolean {
  return result.filesModified > 0 || result.hookWrites > 0;
}

/** Run schema-scoped PostgreSQL maintenance without starving autovacuum. */
export function dbRunMaintenance(db: MaintenanceDb): void {
  db.exec(POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL);
}

/** Finish an incremental sync and avoid database-wide ANALYZE on no-op passes. */
export function syncPostgresGraph(result: SyncWriteResult, db: MaintenanceDb): void {
  if (cgSyncHasDatabaseWrites(result)) dbRunMaintenance(db);
}
`,

  'src/maintenance-request.ts': `/** Shape-only request fields that must not displace executable PostgreSQL maintenance roots. */
export interface MaintenanceRequest {
  fix: boolean;
  index: string;
  request: string;
}
`,

  'src/server.ts': `import { authenticateUser } from './auth.js';
import { processPayment } from './payment.js';

/** Boot the HTTP server. */
export function startServer(): void {
  handleRequest('/');
}

/** Handle one incoming HTTP request. */
export function handleRequest(route: string): void {
  authenticateUser('user', 'token');
  processPayment(1);
}
`,

  'src/index.ts': `import { FileWatcher } from './watcher.js';
import { startServer } from './server.js';
import { CacheStore } from './cache.js';

/** Application entry point — wires the subsystems together. */
export function main(): void {
  const watcher = new FileWatcher({ debounceMs: 100 });
  watcher.start();
  watcher.onEvent('a.ts');
  startServer();
  new CacheStore().lookup('k');
}
`,
};
