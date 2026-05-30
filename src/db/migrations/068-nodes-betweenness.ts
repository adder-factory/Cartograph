import type { MigrationModule } from './types.js';

/**
 * Add `nodes.betweenness` column for sampled betweenness centrality.
 *
 * What this stores: per-node Brandes-betweenness over the calls +
 * references subgraph, sampled at K source pivots (default 200).
 * Higher values mean "more shortest paths pass through me" — the
 * canonical structural-bridge signal that PageRank misses. See
 * `src/centrality/betweenness.ts` for the algorithm + sampling.
 *
 * Schema shape mirrors `nodes.centrality` (PageRank's column): a
 * nullable REAL that's NULL until the first compute pass, with a
 * DESC index for top-N queries. Both centralities can live side by
 * side without conflict — they're independent rankings of the same
 * subgraph.
 *
 * Backfill: none. The next centrality / dedicated betweenness pass
 * will populate it on the indexed nodes; existing rows keep
 * `betweenness = NULL` until then. NULL is the right "unknown"
 * sentinel for a metric that's expensive to compute and not always
 * needed.
 *
 * Idempotent: PRAGMA-guarded ADD COLUMN + `CREATE INDEX IF NOT EXISTS`
 * so re-running on an already-migrated DB is a no-op (and
 * partial-schema test setups that don't have `nodes` skip cleanly).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add nodes.betweenness column + DESC index for sampled betweenness centrality',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'betweenness')) {
      db.exec('ALTER TABLE nodes ADD COLUMN betweenness REAL DEFAULT NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_betweenness ON nodes(betweenness DESC)');
  },
};
