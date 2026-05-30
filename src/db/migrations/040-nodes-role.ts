import type { MigrationModule } from './types.js';

/**
 * Move LLM-derived role classification from `symbol_summaries.role`
 * onto `nodes.role` so the classifier can run on nodes that have a
 * docstring but no summary (the "cascade" — see
 * `project_role_classifier_input_eval_2026_05_08.md` memory note for
 * the empirical justification: B↔baseline 66.7% vs A↔baseline 68.8%
 * — fallback quality only 2 pts below summary-input).
 *
 * Migration is column-additive on `nodes` plus a backfill from the
 * old location. The old `symbol_summaries.role` column stays in
 * place for one cycle (read-side fallback removed in this migration;
 * write-side stops; future migration drops the dead column).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add nodes.role + nodes.role_model + idx_nodes_role; backfill from symbol_summaries.role',
  up: (db) => {
    const hasNodes =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes'`).get() as { c: number })
        .c > 0;
    if (!hasNodes) return;

    const hasRole =
      (db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('nodes') WHERE name='role'`).get() as { c: number }).c >
      0;
    if (!hasRole) {
      db.exec(`ALTER TABLE nodes ADD COLUMN role TEXT`);
    }
    const hasRoleModel =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('nodes') WHERE name='role_model'`).get() as {
          c: number;
        }
      ).c > 0;
    if (!hasRoleModel) {
      db.exec(`ALTER TABLE nodes ADD COLUMN role_model TEXT`);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role)`);

    const hasSummariesTable =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='symbol_summaries'`).get() as {
          c: number;
        }
      ).c > 0;
    if (!hasSummariesTable) return;

    const summariesHasRoleColumn =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('symbol_summaries') WHERE name='role'`).get() as {
          c: number;
        }
      ).c > 0;
    if (!summariesHasRoleColumn) return;

    db.exec(`
      UPDATE nodes
         SET role = (SELECT s.role FROM symbol_summaries s WHERE s.node_id = nodes.id),
             role_model = (SELECT s.role_model FROM symbol_summaries s WHERE s.node_id = nodes.id)
       WHERE nodes.role IS NULL
         AND EXISTS (
           SELECT 1 FROM symbol_summaries s
            WHERE s.node_id = nodes.id
              AND s.role IS NOT NULL
              AND s.role != ''
         )
    `);
  },
};
