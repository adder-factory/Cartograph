import type { MigrationModule } from './types.js';

/**
 * Per-symbol metrics snapshot — the current values of every metric
 * the biomarker engine computes, regardless of whether a finding
 * fired. Distinct from `code_health_findings` (which only stores
 * threshold-exceeding values) and `node_loc_history` (which is the
 * append-only LoC time-series for the recently_grew biomarker).
 *
 * One row per analysable symbol; OVERWRITTEN on every analyseProject
 * pass that touched the symbol. PRIMARY KEY on node_id keeps the
 * upsert atomic. Used by the viewer to surface cyclomatic +
 * max_nesting on clean symbols, which previously read "—" because
 * the only persistence path was via findings.
 *
 * Why a separate table rather than columns on `nodes`: the existing
 * `nodes` table is wide and write-heavy via the parser; piling
 * biomarker columns on it would broaden every parse-write
 * transaction. A narrow per-domain table mirrors the conventions
 * used for node_coverage / node_loc_history.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add node_metrics — per-symbol cyclomatic/nesting/params/etc. snapshot driving viewer panel reads',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_metrics (
        node_id TEXT PRIMARY KEY,
        loc INTEGER NOT NULL,
        cyclomatic INTEGER NOT NULL,
        max_nesting INTEGER NOT NULL,
        max_conditional_operands INTEGER NOT NULL,
        param_count INTEGER NOT NULL,
        magic_number_count INTEGER NOT NULL,
        hardcoded_url_count INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
    `);
  },
};
