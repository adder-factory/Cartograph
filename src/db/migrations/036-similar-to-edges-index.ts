import type { MigrationModule } from './types.js';

/**
 * Add a partial index on edges (source, kind) covering similar_to edges
 * to make backfill traversals cheap. The partial index filters to
 * kind='similar_to' so the index size stays proportional to the
 * graph's actual semantic edges, not all edges.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add partial index on edges (source, kind) for similar_to edges — fast similarity traversal',
  up: (db) => {
    const hasEdges =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='edges'`).get() as { c: number })
        .c > 0;
    if (!hasEdges) return;
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_source_kind_similar_to
        ON edges (source, kind)
        WHERE kind = 'similar_to';
    `);
  },
};
