import type { MigrationModule } from './types.js';

/**
 * Add `summary_priority_queue.attempts` for poison-row eviction.
 *
 * The previous design left a queue row in place indefinitely when
 * the local LLM consistently returned empty/whitespace responses
 * for a particular body, producing the "1 pending, 1 error" loop
 * every summarise pass without ever clearing. Caught 2026-05-11:
 * `constant:097fe4ca…` from `scripts/probe-cyclomatic.ts:15` (a
 * single-line top-level constant in a debug probe script) hit the
 * same error each pass with no path to drop out of the queue.
 *
 * `attempts INTEGER NOT NULL DEFAULT 0` lets the wiring layer
 * increment the counter on each failed summarise attempt and
 * DELETE the row once it crosses a MAX threshold — turning a
 * permanent poison row into a bounded retry budget. Reads default
 * 0 for existing rows so the next attempt counts as the first.
 *
 * Existing rows are NOT backfilled — they start at attempts=0 and
 * get the full retry budget on next summarize, even if they have
 * been failing historically. Acceptable cost: at most one extra
 * round of "Errors: N" per stuck row before eviction.
 *
 * Pattern mirrors migration 059: pre-flight `nodes.start_line`
 * guard (mig-034 triggers reparse the surrounding schema during
 * ALTER, surfacing missing columns on partial-schema test
 * fixtures), `sqlite_master` table-existence guard, and a per-
 * column PRAGMA check so the ADD COLUMN is idempotent on DBs
 * already migrated past this version.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add summary_priority_queue.attempts for poison-row eviction',
  up: (db) => {
    // Partial-schema test fixtures (migrations-015-016 starts at v14
    // with `nodes (id TEXT PRIMARY KEY)` only) leave the broader
    // schema in a state where mig-034's `nodes_rtree_ai/ad/au`
    // triggers reference `NEW.start_line` / `NEW.end_line` columns
    // that the minimal `nodes` table doesn't have. SQLite's
    // `ALTER TABLE ... ADD COLUMN` reparses the surrounding schema
    // and surfaces the invalid triggers as `error in trigger
    // nodes_rtree_ai: no such column: NEW.start_line`. Production
    // DBs always have these columns since v1, so the guard is a
    // no-op there. Same pattern as migration 054 / 056 / 059's
    // pre-flight start_line check.
    const nodeCols = new Set(
      (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!nodeCols.has('start_line') || !nodeCols.has('end_line')) {
      return;
    }

    const hasPriorityQueue = db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='summary_priority_queue'")
      .get() as { one: number } | undefined;
    if (!hasPriorityQueue) {
      return;
    }

    const cols = new Set(
      (db.prepare('PRAGMA table_info(summary_priority_queue)').all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!cols.has('attempts')) {
      db.exec('ALTER TABLE summary_priority_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
  },
};
