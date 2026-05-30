import type { MigrationModule } from './types.js';

/**
 * Edge confidence (#8). Adds a categorical column on edges
 * surfacing how sure the resolver is that this edge points at the
 * right target:
 *
 *   - `EXTRACTED`: concrete imports / fully-qualified / file-path
 *     resolution. Trustworthy.
 *   - `INFERRED`: heuristic same-name match, fuzzy dispatch,
 *     framework patterns below the high-confidence threshold.
 *     Verify before acting.
 *   - `AMBIGUOUS`: dynamic dispatch on an unresolved type, or a
 *     tie between equally-plausible targets.
 *
 * Backfill default `EXTRACTED` for legacy rows. The numeric
 * `confidence` already in `metadata` JSON is the underlying signal;
 * this column promotes it to a queryable / indexable surface so the
 * MCP `callers` / `callees` / `impact` tools can filter without
 * round-tripping through JSON.
 *
 * Distinct from the (still-dead) `provenance` column added by
 * migration 002 — provenance is the source pipeline (tree-sitter /
 * scip / heuristic), confidence is the resolver's correctness guess.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add edges.confidence — categorical edge correctness signal for callers/callees/impact filtering (#8)',
  up: (db) => {
    // Partial-schema test setups can run individual migrations without
    // the `edges` table present — skip in that case (mirrors the
    // tableExists guard in migration 021 / 023).
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edges'").get();
    if (!tableExists) return;
    // Idempotent ADD COLUMN: schema.sql already has the column for
    // fresh-init DBs, but tests bootstrap then back-date the version
    // to replay migrations forward — the second ALTER would otherwise
    // fail with "duplicate column name". Same convention used by
    // migrations 020 / 021 / 023 / 030.
    const cols = db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'confidence')) {
      // Nullable so legacy / structural / extractor-direct edges
      // need no producer change — read-side cast collapses NULL to
      // the safe 'EXTRACTED' default.
      db.exec(`ALTER TABLE edges ADD COLUMN confidence TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence)`);
  },
};
