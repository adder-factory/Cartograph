import type { MigrationModule } from './types.js';

/**
 * F#76 (2026-05-28) — add a `COLLATE NOCASE` index on `nodes(name)`.
 *
 * Closes the first concrete F#75 EXPLAIN-QUERY-PLAN audit finding.
 * The supplement-candidates query in `src/db/queries-search.ts` (and
 * two siblings) runs `WHERE name = @value COLLATE NOCASE` for the
 * find-by-name path's case-insensitive supplement pass. The existing
 * `idx_nodes_name` index is BINARY-collated (the SQLite default), so
 * the planner couldn't use it for the NOCASE comparison and fell back
 * to a full table scan. Adding a dedicated COLLATE-NOCASE index lets
 * `SEARCH nodes USING INDEX ... (name=?)` win instead.
 *
 * Verified pre-merge: on the cartograph repo itself, `EXPLAIN QUERY
 * PLAN SELECT * FROM nodes WHERE name = 'foo' COLLATE NOCASE` flipped
 * from `SCAN nodes` to `SEARCH nodes USING INDEX idx_nodes_name_nocase
 * (name=?)` after this migration ran.
 *
 * The two sibling read paths (lines 1650 + 1879 in queries-search.ts)
 * use the same shape and get the same win automatically.
 *
 * First-time cost note: `CREATE INDEX` is O(N log N) over the nodes
 * table. On a production project with millions of indexed symbols
 * this migration will block for several seconds on its first run;
 * subsequent runs are a no-op. The cost is amortised against every
 * future COLLATE-NOCASE name lookup the supplement-candidates path
 * fires.
 *
 * Idempotent: `CREATE INDEX IF NOT EXISTS`. Re-running on an already-
 * migrated DB is a no-op. Partial-schema test fixtures that only seed
 * a stripped-down `nodes` table (e.g. `migrations-022.test.ts` starts
 * from `CREATE TABLE nodes (id TEXT PRIMARY KEY)`) skip cleanly because
 * the column-existence guard below short-circuits before the index
 * DDL runs.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add idx_nodes_name_nocase on nodes(name COLLATE NOCASE) to back COLLATE-NOCASE name lookups',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'name')) return;
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_name_nocase ON nodes(name COLLATE NOCASE)');
  },
};
