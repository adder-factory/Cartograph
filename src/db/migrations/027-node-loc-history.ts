import type { MigrationModule } from './types.js';

/**
 * Node LoC history table — one row per (node_id, indexed_ts) snapshot.
 *
 * Drives the `recently_grew` biomarker: a symbol that grew sharply
 * since its previous indexed snapshot is a stronger refactor target
 * than an evergreen-large symbol that's been stable for months. The
 * static `large_method` rule alone can't tell those apart.
 *
 * Storage shape: append-only on every analyseProject pass that
 * actually touches the symbol (the per-file content-hash cache short-
 * circuits unchanged files, so we don't write redundant snapshots).
 * `idx_node_loc_history_node_ts` makes "the previous snapshot for
 * this node" a sub-millisecond lookup.
 *
 * No retention policy in v1 — typical projects produce ~10–100 rows
 * per analysable symbol per year, well under any storage concern.
 * If a future codebase blows that budget, a one-time `DELETE WHERE
 * indexed_ts < ?` sweep is enough.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add node_loc_history table — per-symbol LoC snapshots driving recently_grew',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_loc_history (
        node_id TEXT NOT NULL,
        indexed_ts INTEGER NOT NULL,
        loc INTEGER NOT NULL,
        PRIMARY KEY (node_id, indexed_ts),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_node_loc_history_node_ts
        ON node_loc_history(node_id, indexed_ts DESC);
    `);
  },
};
