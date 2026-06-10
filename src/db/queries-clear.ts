/**
 * Structural-clear logic, extracted from the (god-module) `queries.ts`.
 *
 * `clearStructural` is the `--force` reindex path: it wipes the
 * structural graph (`nodes`/`edges`/`files`/refs/…) while PRESERVING the
 * node-id-keyed side tables (agent notes, role assignments, LOC history,
 * summary/embedding caches) that re-link to the next index via stable ids.
 */

import type { QueryBuilder } from './queries.js';
import { logWarn } from '../errors.js';

/**
 * Clear ONLY structural data — nodes, edges, files, unresolved
 * refs, co-changes, and node-id-keyed analyses (coverage, health
 * findings) that would otherwise reference dead nodes.
 *
 * LLM-derived caches are LEFT IN PLACE so the next index run can
 * short-circuit unchanged symbols via the content-hash cache lookup.
 *
 * Side-effect: stale rows in summaries/embeddings whose node_id no
 * longer exists become orphans, reachable only by content-hash
 * lookup until either (a) a future re-index re-uses them, or
 * (b) clearAll() (full reset) wipes everything.
 */
export function clearStructural(qb: QueryBuilder): void {
  qb.nodeCache.clear();
  // The wipe deletes `nodes`, but the node-keyed tables NOT listed below
  // (agent_notes, role_assignments, node_loc_history, summary_refs,
  // embedding_refs) must SURVIVE — they re-link to the next index via
  // stable ids. Both schemas declare those FKs `ON DELETE CASCADE`, so
  // foreign-key enforcement has to be suppressed for the duration of the
  // wipe or the cascade would delete exactly the rows we mean to keep.
  if (qb.db.dialect === 'postgres') {
    clearStructuralWithFksDisabledPostgres(qb);
  } else {
    qb.db.exec('PRAGMA foreign_keys = OFF');
    try {
      runClearStructuralDeletes(qb);
    } finally {
      qb.db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** The dialect-independent DELETE sequence, wrapped in one transaction. */
function runClearStructuralDeletes(qb: QueryBuilder): void {
  qb.db.transaction(() => runClearStructuralDeletesBody(qb))();
}

/** The DELETE statements themselves — caller owns the transaction so the
 *  Postgres path can prepend a `SET LOCAL` on the SAME pinned connection. */
function runClearStructuralDeletesBody(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM unresolved_refs');
  qb.db.exec('DELETE FROM edges');
  qb.db.exec('DELETE FROM symbol_issues');
  qb.db.exec('DELETE FROM config_refs');
  qb.db.exec('DELETE FROM sql_refs');
  qb.db.exec('DELETE FROM build_context_refs');
  qb.db.exec('DELETE FROM string_imports');
  qb.db.exec('DELETE FROM node_coverage');
  qb.db.exec('DELETE FROM code_health_findings');
  qb.db.exec('DELETE FROM nodes');
  qb.db.exec('DELETE FROM files');
  qb.db.exec('DELETE FROM co_changes');
  qb.db.exec(
    `DELETE FROM project_metadata
     WHERE key LIKE 'biomarker_file_state_%'
        OR key IN (
          'last_centrality_fingerprint',
          'last_mined_issues_head'
        )`,
  );
}

/**
 * Postgres has no `PRAGMA foreign_keys`; the equivalent way to wipe
 * `nodes` without firing the `ON DELETE CASCADE` referential-integrity
 * triggers is `session_replication_role = replica` (the same switch
 * pg_restore / logical replication use). We issue it as `SET LOCAL`
 * INSIDE the wipe transaction so it (a) runs on the transaction's pinned
 * connection — correct even when the Bun.SQL adapter pools >1 connection,
 * where a session-level `SET` could land on a different connection than
 * the DELETEs — and (b) auto-resets at commit/rollback, needing no
 * restore.
 *
 * It requires replication/superuser privilege; we probe that in a
 * throwaway transaction first so a privilege failure (which aborts its
 * transaction) is cleanly distinguished from a real DELETE error. When
 * the role lacks the privilege we fall back to the plain cascade wipe but
 * WARN loudly — the silent alternative (cascade-deleting agent notes,
 * role assignments, LOC history, and summary/embedding caches) is exactly
 * what this function exists to avoid.
 */
function clearStructuralWithFksDisabledPostgres(qb: QueryBuilder): void {
  if (postgresCanSuppressFkTriggers(qb)) {
    qb.db.transaction(() => {
      qb.db.exec("SET LOCAL session_replication_role = 'replica'");
      runClearStructuralDeletesBody(qb);
    })();
    return;
  }
  logWarn(
    'clearStructural: the Postgres role cannot SET session_replication_role ' +
      '(needs replication/superuser privilege). `index --force` will ' +
      'cascade-clear node-keyed notes, roles, LOC history, and summary/' +
      'embedding caches; grant the privilege to preserve them across a ' +
      'forced reindex.',
  );
  runClearStructuralDeletes(qb);
}

/** True when the connecting Postgres role may set session_replication_role.
 *  Probed in a no-op transaction (SET LOCAL auto-resets at commit). */
function postgresCanSuppressFkTriggers(qb: QueryBuilder): boolean {
  try {
    qb.db.transaction(() => {
      qb.db.exec("SET LOCAL session_replication_role = 'replica'");
    })();
    return true;
  } catch {
    return false;
  }
}
