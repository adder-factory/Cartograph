import type { MigrationModule } from './types.js';

/**
 * Drop three columns that have writers (or once had writers) but
 * zero readers anywhere in the codebase.
 *
 *   - `edges.provenance` + `idx_edges_provenance` (added by mig 002,
 *     reserved for an SCIP-importer integration that never landed).
 *   - `nodes.type_parameters` (JSON array; never read).
 *   - `nodes.is_abstract` (boolean flag; never read — only the
 *     extractor tests' INSERT lists carried it).
 *
 * The dead-by-design rationale lives in
 * `project_cartograph_provenance_is_dead_by_design.md` and the
 * 2026-05-11 schema audit (`Edge.provenance` had 0 non-NULL rows in
 * the live DB; `Node.typeParameters` / `Node.isAbstract` have no
 * `.typeParameters` / `.isAbstract` reads in `src/`).
 *
 * Implementation notes.
 *
 *   - SQLite ≥ 3.35 supports `ALTER TABLE … DROP COLUMN`, including
 *     on STRICT tables. The runtime here (`node:sqlite` on Node 22)
 *     is well past that.
 *   - DROP COLUMN refuses to remove an indexed column, so
 *     `idx_edges_provenance` (single-column index on `provenance`)
 *     must drop first. The index also auto-drops with the column,
 *     but the explicit `DROP INDEX` keeps the order deterministic
 *     and survives SQLite versions that don't auto-drop.
 *   - Per-column presence guards via PRAGMA make the migration
 *     idempotent on partial-schema test fixtures (migrations-015-016
 *     bootstraps a v14 DB with `nodes (id TEXT PRIMARY KEY)` only).
 *     On a real production DB at v57 every column is present and
 *     the guards are no-ops.
 *
 * API break authorized for this drop per
 * `feedback_cartograph_api_breakage_authorized.md` — the public
 * `Edge.provenance` / `Node.typeParameters` / `Node.isAbstract`
 * fields disappear from `src/types.ts` in the same change.
 */
export const MIGRATION: MigrationModule = {
  description: 'Drop dead columns: edges.provenance, nodes.type_parameters, nodes.is_abstract',
  up: (db) => {
    const hasNodes = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | { one: number }
      | undefined;
    if (hasNodes) {
      const nodeCols = new Set(
        (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (nodeCols.has('is_abstract')) {
        db.exec('ALTER TABLE nodes DROP COLUMN is_abstract');
      }
      if (nodeCols.has('type_parameters')) {
        db.exec('ALTER TABLE nodes DROP COLUMN type_parameters');
      }
    }

    const hasEdges = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='edges'").get() as
      | { one: number }
      | undefined;
    if (hasEdges) {
      const edgeCols = new Set(
        (db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (edgeCols.has('provenance')) {
        // DROP COLUMN rejects an indexed column, so the single-column
        // index must drop first. IF EXISTS keeps fresh DBs that never
        // created it (or partial fixtures) happy.
        db.exec('DROP INDEX IF EXISTS idx_edges_provenance');
        db.exec('ALTER TABLE edges DROP COLUMN provenance');
      }
    }
  },
};
