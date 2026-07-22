/**
 * Index-hook types.
 *
 * `IndexHook`s are derived-signal passes that run AFTER core
 * indexing/sync has finished — centrality computation, churn
 * mining, issue history, config-ref extraction, SQL call-site
 * scanning, co-change graph mining, etc. Today every such PR
 * mutates `Cartograph` directly (private method + call site in
 * `indexAll` + call site in `sync`), forcing every-PR conflicts
 * on adjacent lines.
 *
 * After the registry refactor, each pass is its own file:
 *   - exports a `HOOK: IndexHook` constant
 *   - registers itself in `./registry.ts` (1 import line + 1 array entry)
 *   - implements `afterIndexAll` and/or `afterSync`
 *
 * `Cartograph` stops growing per-pass methods. The hook runner
 * inside `Cartograph` is a small generic loop that calls every
 * registered hook in sequence, swallowing errors so one broken
 * hook doesn't fail the whole index/sync.
 */

import type { CartographConfig } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import type { DatabaseConnection } from '../db/index.js';
import type { SyncResult } from '../extraction/index.js';

/**
 * Per-call context handed to every hook. Stable shape so hooks
 * don't need to import private members of `Cartograph`.
 */
export interface IndexHookContext {
  readonly projectRoot: string;
  readonly config: CartographConfig;
  readonly queries: QueryBuilder;
  readonly db: DatabaseConnection;
}

export interface IndexHook {
  /** Stable identifier for logging / opt-out. */
  readonly name: string;

  /**
   * Whether affected PostgreSQL rows from this hook should request the
   * post-sync statistics refresh. Defaults to true. Set false only for a hook
   * whose normal no-op reconciliation intentionally rewrites rows and should
   * leave statistics maintenance to autovacuum.
   */
  readonly requestPostgresMaintenanceAfterWrites?: boolean;

  /**
   * Run after a full `indexAll` completes successfully. Treat
   * this as a clean-slate signal — clear any cached state your
   * pass owns and re-derive from scratch.
   */
  afterIndexAll?(ctx: IndexHookContext): Promise<void> | void;

  /**
   * Run after `sync` completes. `result.changedFilePaths` (when
   * present) is the bounded set of paths touched in this sync;
   * hooks should use it to do incremental work where possible.
   */
  afterSync?(ctx: IndexHookContext, result: SyncResult): Promise<void> | void;
}

/** Per-hook outcome reported back from the registry runner. */
export interface IndexHookOutcome {
  readonly name: string;
  readonly phase: 'indexAll' | 'sync';
  readonly durationMs: number;
  /** True when this hook reported maintenance-relevant PostgreSQL DML rows. */
  readonly mutated?: boolean;
  /** Defined when the hook threw; the runner caught it. */
  readonly error?: Error;
}
