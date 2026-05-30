import type { MigrationModule } from './types.js';

/**
 * Drop `idx_edges_source` and `idx_edges_target` — both fully covered
 * by the wider `idx_edges_source_kind` and `idx_edges_target_kind`
 * composite indexes via SQLite's left-prefix scan. Keeping the narrow
 * ones costs ~17-22% of DB size and ~1.3x bulk-insert time without
 * giving any query that the kind-prefixed indexes don't already cover.
 *
 * EXPLAIN confirms the planner now uses the wider indexes as covering
 * indexes for source-only / target-only queries:
 *   SEARCH edges USING COVERING INDEX idx_edges_source_kind (source=?)
 *
 * See `scripts/spikes/spike-edge-indexes.mjs` for the reproducer
 * (companion to PR #122 against `main`; this is the file-based form
 * for the post-#118 integration branch).
 */
export const MIGRATION: MigrationModule = {
  description: 'Drop redundant idx_edges_source and idx_edges_target indexes',
  up: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_edges_source;
      DROP INDEX IF EXISTS idx_edges_target;
    `);
  },
};
