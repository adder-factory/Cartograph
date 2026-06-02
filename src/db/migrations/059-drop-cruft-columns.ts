import type { MigrationModule } from './types.js';

/**
 * Drop two more sets of dead columns surfaced by the 2026-05-11
 * schema audit (F12 + F13). Bundled together since same theme,
 * same risk surface.
 *
 *   - F12: `summary_priority_queue.last_query` — written by
 *     `enqueueForSummary` (`queries-summary-priority.ts`) but never
 *     SELECTed anywhere. Speculative debug column from migration
 *     041.
 *   - F13: `hnsw_meta.recall_hint` + `hnsw_meta.ef_query` —
 *     INSERTed as hardcoded NULL at `hnsw-build.ts:160-167` and
 *     SELECTed back in the row shape at line 205, but the only
 *     consumer (`shouldRebuildDim`) reads `row_count` /
 *     `max_rowid` only. Speculative tuning columns added in
 *     migration 042 that never got wired up.
 *
 * Schema.sql is updated in the same change set so fresh installs
 * never create the columns; existing DBs drop them here.
 *
 * Pattern mirrors migration 058: per-column presence guards via
 * PRAGMA keep the drops idempotent on partial-schema test
 * fixtures and on DBs already migrated past this version.
 *
 * (F11 — the stale `(1, …, 'Initial schema')` INSERT at the top
 * of schema.sql — is a static SQL cleanup with no per-DB action.
 * Existing rows are harmless audit trail; only future fresh
 * installs change behavior. Handled in the same commit's
 * schema.sql edit.)
 */
export const MIGRATION: MigrationModule = {
  description: 'Drop dead cruft columns: summary_priority_queue.last_query, hnsw_meta.recall_hint, hnsw_meta.ef_query',
  up: (db) => {
    // Partial-schema test fixtures (migrations-015-016 starts at v14
    // with `nodes (id TEXT PRIMARY KEY)` only) leave the broader
    // schema in a state where mig-034's `nodes_rtree_ai/ad/au`
    // triggers reference `NEW.start_line` / `NEW.end_line` columns
    // that the minimal `nodes` table doesn't have. SQLite's
    // `ALTER TABLE ... DROP COLUMN` reparses the surrounding schema
    // during its internal table rebuild and surfaces the invalid
    // triggers as `error in trigger nodes_rtree_ai: no such column:
    // NEW.start_line`. Production DBs always have these columns
    // since v1, so the guard is a no-op there. Same pattern as
    // migration 054 / 056's pre-flight start_line check.
    const nodeCols = new Set(
      (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!nodeCols.has('start_line') || !nodeCols.has('end_line')) {
      return;
    }

    const hasPriorityQueue = db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='summary_priority_queue'")
      .get() as { one: number } | undefined;
    if (hasPriorityQueue) {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(summary_priority_queue)').all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (cols.has('last_query')) {
        db.exec('ALTER TABLE summary_priority_queue DROP COLUMN last_query');
      }
    }

    const hasHnswMeta = db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='hnsw_meta'")
      .get() as { one: number } | undefined;
    if (hasHnswMeta) {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(hnsw_meta)').all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (cols.has('recall_hint')) {
        db.exec('ALTER TABLE hnsw_meta DROP COLUMN recall_hint');
      }
      if (cols.has('ef_query')) {
        db.exec('ALTER TABLE hnsw_meta DROP COLUMN ef_query');
      }
    }
  },
};
