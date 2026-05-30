/**
 * Role-restore index hook — Phase 5 of the staleness redesign.
 *
 * `nodes.role` + `nodes.role_model` (migration 040) live on the
 * structural `nodes` table, so `clearStructural` deletes them with
 * the row, and the extractor's `INSERT OR REPLACE INTO nodes` on
 * sync re-inserts without populating them. This hook copies values
 * back from `role_assignments` (migration 052) into `nodes.role`,
 * gated on body_hash equality so a body change drops the role
 * naturally (next classify pass repopulates).
 *
 * Runs first in the registered-hooks order so downstream hooks that
 * might read `nodes.role` (today: none structurally — future-proofed)
 * see restored values.
 *
 * Restoration is a single UPDATE; no per-node loop. The query is
 * O(rows in role_assignments) bounded by an idx_nodes_role on the
 * matched side and idx_role_assignments_body_hash on the source
 * side. ~3500-row scale produces single-digit ms on indexed DBs.
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import { logDebug, errMsg } from '../errors.js';

function restore(ctx: IndexHookContext): void {
  try {
    const db = ctx.db.getDb();
    // Table-exists guard: in fresh DBs that haven't run migration 052
    // yet (forward-compat path during the partial-upgrade window) the
    // query would throw. Migration ordering normally prevents this,
    // but the hook can be called from contexts (tests, partial DB
    // setups) where the schema isn't fully applied.
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_assignments'").get();
    if (!hasTable) return;

    // Restore role + role_model only where:
    //  - the node currently lacks a role (NULL) — never overwrite a
    //    freshly-classified value (sync calls this AFTER the classify
    //    pipeline may have just written one)
    //  - the node has a non-empty body_hash (post-migration-048
    //    re-extraction completed)
    //  - role_assignments has a matching body_hash row (body
    //    unchanged since the role was assigned — Design A staleness)
    const result = db
      .prepare(
        `UPDATE nodes
            SET role = (SELECT ra.role
                          FROM role_assignments ra
                         WHERE ra.node_id = nodes.id
                           AND ra.body_hash = nodes.body_hash),
                role_model = (SELECT ra.role_model
                                FROM role_assignments ra
                               WHERE ra.node_id = nodes.id
                                 AND ra.body_hash = nodes.body_hash)
          WHERE nodes.role IS NULL
            AND nodes.body_hash <> ''
            AND EXISTS (
              SELECT 1 FROM role_assignments ra
               WHERE ra.node_id = nodes.id
                 AND ra.body_hash = nodes.body_hash
            )`,
      )
      .run();
    if ((result.changes ?? 0) > 0) {
      logDebug(`role-restore hook: restored ${result.changes} role assignments`);
    }
  } catch (err) {
    logDebug(`role-restore hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'role-restore',
  afterIndexAll(ctx) {
    restore(ctx);
  },
  afterSync(ctx) {
    restore(ctx);
  },
};
