import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Dedup edges and enforce UNIQUE(source, target, kind, line, col) so INSERT OR IGNORE actually dedupes',
  up: (db) => {
    // Tolerate edges-table-missing (synthetic test DBs that only need
    // the FTS / nodes side of the schema): if there's no edges table,
    // there are no duplicates to dedup or unique constraint to add.
    const hasEdges =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='edges'`).get() as { c: number })
        .c > 0;
    if (!hasEdges) return;

    // Without a UNIQUE constraint the existing `INSERT OR IGNORE INTO
    // edges` was a no-op for dedup purposes. Collapse accumulated
    // duplicates first, then add the UNIQUE index. COALESCE keeps
    // NULL line/col values comparable.
    db.exec(`
      DELETE FROM edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM edges
        GROUP BY source, target, kind, COALESCE(line, -1), COALESCE(col, -1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
        ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));
    `);
  },
};
