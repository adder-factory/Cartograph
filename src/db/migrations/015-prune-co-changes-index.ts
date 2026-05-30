import type { MigrationModule } from './types.js';

/**
 * Drop `idx_co_changes_a` — fully covered by the `(file_a, file_b)`
 * primary key index on `co_changes` via SQLite's left-prefix scan.
 *
 * `idx_co_changes_b` (on `file_b` alone) is kept: the PK leads with
 * `file_a`, so it cannot serve `WHERE file_b = ?` lookups.
 *
 * See `scripts/spikes/spike-edge-indexes.mjs` for the analogous
 * measurement on the `edges` table; the same left-prefix-scan
 * argument applies here.
 */
export const MIGRATION: MigrationModule = {
  description: 'Drop redundant idx_co_changes_a index',
  up: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_co_changes_a;
    `);
  },
};
