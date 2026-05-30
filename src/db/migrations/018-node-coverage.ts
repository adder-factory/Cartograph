import type { MigrationModule } from './types.js';

/**
 * Per-symbol code coverage from external CI artifacts (lcov, cobertura,
 * jacoco, coverage.py). One row per (node_id, source) so multiple
 * coverage providers can coexist without overwriting each other.
 *
 * The agent angle: once this table is populated, queries like
 *   "high-centrality functions with no coverage"
 *   "this PR adds branches with coverage_pct = 0"
 * become single SQL joins against `nodes` + `centrality` + this table.
 *
 * Coverage is per-symbol, not per-line: we summarise the line/branch
 * stats inside the symbol's source span. Line-level data lives in the
 * raw lcov file that fed the ingestion — agents that need it can
 * re-parse the source artifact.
 */
export const MIGRATION: MigrationModule = {
  description: 'Per-symbol code coverage from external CI artifacts',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_coverage (
        node_id TEXT NOT NULL,
        -- 'lcov' | 'cobertura' | 'jacoco' | 'coverage_py' | 'manual'
        source TEXT NOT NULL,
        -- Lines inside the symbol's start_line..end_line span that the
        -- coverage tool reported as executable AND covered (hits >= 1).
        covered_lines INTEGER NOT NULL,
        -- Total executable lines inside the symbol span. covered/total = pct.
        total_lines INTEGER NOT NULL,
        -- Branch coverage if the source provides it (lcov BRDA records,
        -- cobertura branch-rate). NULL when the source is line-only.
        covered_branches INTEGER,
        total_branches INTEGER,
        -- Wall-clock time the coverage report was ingested. Lets agents
        -- detect stale data ("this run is 30 days old, don't trust it").
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, source),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_node_coverage_source ON node_coverage(source);
      -- For "lowest coverage first" scans without a centrality join.
      CREATE INDEX IF NOT EXISTS idx_node_coverage_pct
        ON node_coverage(source, (CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)));
    `);
  },
};
