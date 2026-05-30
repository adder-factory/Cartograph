import type { MigrationModule } from './types.js';

/**
 * Track per-dim HNSW index staleness so postHooks can decide whether
 * to rebuild without rescanning every row. (rowCount, maxRowid) is a
 * cheap signature: if either drifts vs the snapshot taken at last
 * build, the on-disk index is stale.
 *
 * Per-dim primary key mirrors vec0's per-dim layout — one HNSW index
 * per embedding dimension, persisted to .cartograph/hnsw_<dim>.bin
 * alongside cartograph.db.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add hnsw_meta table for HNSW index staleness tracking',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hnsw_meta (
        dim         INTEGER PRIMARY KEY,
        row_count   INTEGER NOT NULL,
        max_rowid   INTEGER NOT NULL,
        built_at    INTEGER NOT NULL,
        file_path   TEXT NOT NULL,
        recall_hint REAL,
        ef_query    INTEGER
      )
    `);
  },
};
