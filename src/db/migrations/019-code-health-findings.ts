import type { MigrationModule } from './types.js';

/**
 * Per-symbol code-health findings produced by the biomarker engine
 * (see `src/biomarkers/`). One row per (node_id, biomarker) so the
 * same symbol can carry multiple findings (e.g. a function flagged
 * both `large_method` and `complex_method`).
 *
 * Goal: expose static-analysis signals an AI agent can call before
 * making a change. The killer query an agent asks:
 *
 *   "I'm about to touch function X. Are there code-health issues
 *    I should know about?"
 *
 * answered by `SELECT * FROM code_health_findings WHERE node_id = ?`.
 *
 * Severity is a fixed lattice: 'info' | 'warning' | 'error'. The
 * aggregate Code Health score (1-10) is computed at query time from
 * this table — no separate score column, so adding a new biomarker
 * doesn't require a backfill.
 */
export const MIGRATION: MigrationModule = {
  description: 'Per-symbol biomarker findings for the Code Health score',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_health_findings (
        node_id TEXT NOT NULL,
        biomarker TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
        -- Numeric value the threshold was checked against (LoC, depth,
        -- cyclomatic count). Lets agents reason about how-bad-is-bad
        -- without re-running the analysis.
        metric INTEGER NOT NULL,
        -- Free-form JSON detail (e.g. extra context for Brain Method
        -- pointing at the constituent biomarker hits).
        detail TEXT,
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, biomarker),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_findings_biomarker ON code_health_findings(biomarker);
      CREATE INDEX IF NOT EXISTS idx_findings_severity ON code_health_findings(severity);
    `);
  },
};
