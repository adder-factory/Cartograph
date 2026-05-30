import type { MigrationModule } from './types.js';

/**
 * Staleness-redesign Phase 5 — role survival across force reindex.
 *
 * `nodes.role` + `nodes.role_model` (migration 040) live ON the
 * structural `nodes` table. `clearStructural` does `DELETE FROM
 * nodes`, and even normal sync's `INSERT OR REPLACE INTO nodes`
 * re-inserts rows without populating those columns (the extractor
 * doesn't know about roles). Either path wipes the classifier's
 * output — verified 2026-05-11: roles went 3537 → 0 after one
 * `cartograph_admin action=index force=true`.
 *
 * Mirror the summary/embedding refs pattern (migrations 049 / 050):
 * a side table that `clearStructural` deliberately doesn't truncate,
 * plus a post-index hook (`src/index-hooks/role-restore.ts`) that
 * copies values back into `nodes.role` gated on body_hash equality.
 *
 * `body_hash` carries Design A staleness on the restore path: when
 * the re-extracted body produces a different hash, the role isn't
 * restored — leaving the next classify pass to repopulate it. Same
 * staleness semantics as `getStaleArtifactsCount` uses for summaries
 * and embeddings.
 *
 * Data migration: copy every currently-classified (id, role,
 * role_model, body_hash) tuple into `role_assignments`. After this
 * runs, the side table has full coverage of existing classifications;
 * a force reindex immediately restores them via the hook.
 *
 * `nodes.role` stays in place as a read-cache. The hook keeps it in
 * sync; readers continue to `SELECT role FROM nodes` (zero call-site
 * changes — there are ~15 readers across queries-roles.ts and the
 * MCP tools, none need to know about the side table).
 *
 * See `project_cartograph_staleness_redesign.md` for the full design.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add role_assignments side table for Phase 5 role survival across force reindex',
  up: (db) => {
    const hasNodes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!hasNodes) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS role_assignments (
        node_id      TEXT NOT NULL PRIMARY KEY,
        role         TEXT NOT NULL,
        role_model   TEXT NOT NULL DEFAULT '',
        body_hash    TEXT NOT NULL DEFAULT '',
        generated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_role_assignments_body_hash
        ON role_assignments(body_hash);
    `);

    // Backfill is only meaningful when the nodes table has the role
    // columns added by migration 040. Partial-schema test fixtures
    // (see __tests__/migrations-015-016.test.ts) run a subset of
    // migrations against a minimal `nodes` table without `role`; the
    // SELECT below would throw and roll the whole migration back.
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    const hasRole = cols.some((c) => c.name === 'role');
    const hasRoleModel = cols.some((c) => c.name === 'role_model');
    const hasBodyHash = cols.some((c) => c.name === 'body_hash');
    if (!hasRole) return;

    // Backfill: copy currently-classified roles into role_assignments.
    // INSERT OR IGNORE makes the migration safe to re-run after a
    // manual rollback (the second run finds existing rows and skips).
    // Use a literal 0 for generated_at — nodes.updated_at isn't
    // present in every partial fixture, and the next classify pass
    // overwrites the field anyway.
    const roleModelExpr = hasRoleModel ? "COALESCE(role_model, '')" : "''";
    const bodyHashExpr = hasBodyHash ? "COALESCE(body_hash, '')" : "''";
    db.exec(`
      INSERT OR IGNORE INTO role_assignments
        (node_id, role, role_model, body_hash, generated_at)
      SELECT id,
             role,
             ${roleModelExpr},
             ${bodyHashExpr},
             0
        FROM nodes
       WHERE role IS NOT NULL AND role <> '';
    `);
  },
};
