/**
 * Deferred derived-index maintenance for `indexAll`.
 *
 * Every INSERT into `nodes` fires three AFTER-INSERT triggers that
 * maintain the FTS5 (`nodes_fts`, `docstring_fts`) and R*Tree
 * (`nodes_rtree`) derived indexes one row at a time. Measured on a
 * real 11k-node index, that per-row trigger work is ~70% of the
 * node-store wall-clock against an on-disk WAL database.
 *
 * A full `indexAll` repopulates `nodes` wholesale, so the per-row
 * maintenance is pure waste — the derived indexes can be built once,
 * in bulk, from the final `nodes` content. `deferNodeDerivedIndexes`
 * drops the nine maintenance triggers (insert / delete / update for
 * each of the three indexes) before the bulk store;
 * `finalizeDeferredNodeIndexes` rebuilds the three indexes in one pass
 * and recreates the triggers.
 *
 * Scope: `indexAll` ONLY. `sync` re-extracts a small changed set where
 * per-row trigger maintenance is cheap and a whole-corpus rebuild
 * would cost far more than the work it replaces.
 *
 * Crash-safety: `finalizeDeferredNodeIndexes` MUST run from a `finally`
 * so a thrown or aborted `indexAll` still restores the triggers — and
 * it recreates them even if its own rebuild step fails. A hard kill
 * (SIGKILL) between defer and finalize is the one unrecoverable-in-place
 * case: it leaves the triggers dropped. That is acceptable because the
 * index is already incomplete and must be re-run — and the next
 * `indexAll` self-heals: `deferNodeDerivedIndexes` then captures fewer
 * than nine triggers, which makes `finalizeDeferredNodeIndexes` fall
 * back to re-applying `schema.sql` (all `CREATE TRIGGER IF NOT EXISTS`)
 * and restore the full set. (`DatabaseConnection.open` does NOT
 * re-apply `schema.sql` — only first-time `initialize` does — so a
 * plain reopen alone would not heal it.)
 */

import * as path from 'path';
import * as fs from 'fs';
import type { SqliteDatabase } from './sqlite-adapter.js';
import { logWarn } from '../errors.js';

/**
 * The nine `nodes` triggers that maintain the FTS5 + R*Tree derived
 * indexes — three (AFTER INSERT / DELETE / UPDATE) per index. All nine
 * are dropped together: keeping the delete/update triggers while the
 * insert trigger is gone would feed FTS5 `'delete'` commands for rows
 * that were never indexed, corrupting the external-content index.
 */
const NODE_DERIVED_INDEX_TRIGGERS = [
  'nodes_ai',
  'nodes_ad',
  'nodes_au',
  'nodes_rtree_ai',
  'nodes_rtree_ad',
  'nodes_rtree_au',
  'docstring_fts_ai',
  'docstring_fts_ad',
  'docstring_fts_au',
] as const;

/** Opaque handle returned by {@link deferNodeDerivedIndexes}. */
export interface DeferredNodeIndexHandle {
  /** `CREATE TRIGGER` SQL captured from `sqlite_master` before the drop. */
  readonly capturedTriggerSql: readonly string[];
}

/**
 * Drop the per-row FTS5 / R*Tree maintenance triggers on `nodes` so a
 * bulk `indexAll` doesn't pay the per-row trigger overhead. Returns a
 * handle to pass to {@link finalizeDeferredNodeIndexes}.
 */
export function deferNodeDerivedIndexes(db: SqliteDatabase): DeferredNodeIndexHandle {
  const names = NODE_DERIVED_INDEX_TRIGGERS.map((n) => `'${n}'`).join(',');
  const rows = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN (${names})`).all() as Array<{
    sql: string;
  }>;
  for (const name of NODE_DERIVED_INDEX_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  return { capturedTriggerSql: rows.map((r) => r.sql) };
}

/**
 * Rebuild `nodes_fts` / `docstring_fts` / `nodes_rtree` from the final
 * `nodes` content and recreate the triggers dropped by
 * {@link deferNodeDerivedIndexes}. Safe — and required — to call from a
 * `finally`: it leaves the DB with consistent derived indexes whether
 * the index pass completed, aborted, or threw.
 *
 * Trigger recreation runs from this function's own `finally`, so the
 * triggers are restored even if the rebuild step itself fails (e.g.
 * disk full) — a later `sync` then keeps the indexes maintained, albeit
 * over a stale base until the next full index.
 */
export function finalizeDeferredNodeIndexes(db: SqliteDatabase, handle: DeferredNodeIndexHandle): void {
  try {
    // Rebuild the three derived indexes from the final `nodes` content,
    // atomically.
    //
    // - `nodes_fts` / `docstring_fts`: FTS5 external-content tables, so
    //   the 'rebuild' command re-reads every content row and reproduces
    //   the trigger-maintained index. `docstring_fts`'s triggers are
    //   WHEN-guarded to skip null/empty docstrings, but 'rebuild' is
    //   still equivalent: an empty document contributes zero postings,
    //   so indexing it (vs the trigger skipping it) yields an identical
    //   term→doclist index — FTS5 keeps no separate per-rowid marker.
    // - `nodes_rtree`: the R*Tree has no rebuild command — clear and
    //   bulk re-insert from `nodes`.
    db.transaction(() => {
      // Multi-statement rebuild as a single literal — string concat
      // here would trip the `sql_string_concat` detector even though
      // every fragment is a static literal with no interpolation.
      db.exec(
        `INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');
         INSERT INTO docstring_fts(docstring_fts) VALUES('rebuild');
         DELETE FROM nodes_rtree;
         INSERT INTO nodes_rtree(id, start_line, end_line)
           SELECT rowid, start_line, end_line FROM nodes;`,
      );
    })();
  } finally {
    // Recreate the maintenance triggers UNCONDITIONALLY — even if the
    // rebuild above threw — so a subsequent `sync` still maintains the
    // derived indexes. The captured SQL is the exact prior definition;
    // if the capture was incomplete (a prior crash had already dropped
    // some), fall back to re-applying schema.sql, which is fully
    // `IF NOT EXISTS`-idempotent (pure DDL, no data statements).
    if (handle.capturedTriggerSql.length === NODE_DERIVED_INDEX_TRIGGERS.length) {
      for (const sql of handle.capturedTriggerSql) {
        db.exec(sql);
      }
    } else {
      logWarn('deferred-index: incomplete trigger capture — re-applying schema.sql to restore them', {
        captured: handle.capturedTriggerSql.length,
        expected: NODE_DERIVED_INDEX_TRIGGERS.length,
      });
      const schemaPath = path.join(import.meta.dirname, 'schema.sql');
      db.exec(fs.readFileSync(schemaPath, 'utf-8'));
    }
  }
}
