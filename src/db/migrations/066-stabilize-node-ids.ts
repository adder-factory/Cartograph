import type { MigrationModule } from './types.js';

/**
 * Stabilize node ids: drop `line` from the id formula in
 * `generateNodeId` in favour of a per-(filePath, kind, name) ordinal.
 *
 * **Why** — pre-2026-05-21 the formula was
 * `sha256(filePath:kind:name:line)`, so every line shift produced a
 * different id. A pure-whitespace formatter pass (biome's 607-file
 * format on 2026-05-21 was the trigger) made every symbol on every
 * touched file get a brand-new id, which cascade-deleted every edge,
 * role_assignment, code_health_finding, and node_loc_history row
 * pointing at the old ids — wall clock ~5 minutes for the followup
 * `admin sync`. The new formula returns the same id for the same
 * `(filePath, kind, name, occurrence-order)` regardless of line
 * movement, so a stable UPSERT re-extract path leaves all referencing
 * tables intact (the format-only fast path lives in
 * `eoPersistFileExtraction`).
 *
 * **What this migration does**:
 *  1. Wipes every pre-existing node so the next sync re-extracts under
 *     the new id formula. Cascade-deletes the dependent rows
 *     (edges / role_assignments / code_health_findings /
 *     node_loc_history / unresolved_refs); the corresponding hooks
 *     repopulate them on next index. Summaries + embeddings are keyed
 *     by `body_hash` (not by node id) so they survive the wipe and
 *     re-attach automatically.
 *  2. Adds `struct_hash TEXT NOT NULL DEFAULT ''` to `parse_cache` —
 *     the per-file structural fingerprint used by the format-only
 *     fast path to detect "same shape, different whitespace".
 *  3. Clears the existing parse_cache rows (their payloads have
 *     pre-stable ids embedded inside the cached ExtractionResult).
 *  4. Zeroes `files.content_hash` for every tracked file so the next
 *     sync's content-changed gate fires on every file (otherwise the
 *     git fast-path would skip them — disk content didn't move, but
 *     we need the re-extract under the new id formula).
 *
 * **Side effects on first sync after upgrade**:
 *  - One forced full re-extract pass (~ minutes on a large repo).
 *  - Stale-summary/embedding count goes briefly non-zero until the
 *    background summarize/embed phases catch up. (Confirmed via
 *    `__tests__/parse-cache.test.ts` — payload-versioned guard
 *    treats missing/old `_v` envelopes as misses.)
 *
 * `requiresFkDisable` is intentionally OFF: the cascade deletes are
 * exactly the right semantics here — we WANT every row referencing
 * the old ids to disappear.
 */
/**
 * Each step is guarded against a partial fixture (some migration
 * tests bootstrap a minimal subset of tables before running the
 * migration chain — `__tests__/migrations-022.test.ts` etc.). The
 * guards make the migration a no-op for tables that don't exist in
 * the test's reduced schema while still doing the right thing on
 * every real (full-schema) install.
 */
function tableExists(db: import('../sqlite-adapter.js').SqliteDatabase, name: string): boolean {
  // bun:sqlite's `.get()` on `SELECT 1 ...` with no rows has returned
  // a stale row from a prior prepared-statement under some path —
  // caught during migration-066 bring-up where `tableExists(db, 'files')`
  // returned true even though `sqlite_master` had no row for `files`.
  // COUNT(*) returns exactly one row by definition, so the integer-
  // value read can't be confused with "row absent" semantics.
  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = '${name}'`)
    .all() as Array<{ c: number }>;
  return (rows[0]?.c ?? 0) > 0;
}

function columnExists(db: import('../sqlite-adapter.js').SqliteDatabase, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export const MIGRATION: MigrationModule = {
  description:
    'Stabilize node ids (drop line from id formula); add parse_cache.struct_hash for the format-only fast path',
  up: (db) => {
    // 1. Cascade-wipe every pre-existing node. Edges, role_assignments,
    //    code_health_findings, node_loc_history, and unresolved_refs
    //    cascade-delete by FK. After this the next sync re-extracts
    //    every tracked file under the new id formula. Skipped when the
    //    `files` table the FK depends on isn't present (partial-fixture
    //    test bootstraps that don't run the full chain) — without
    //    `files`, the cascade trigger from nodes.file_path can't fire
    //    and bun:sqlite raises `no such table: files`.
    if (tableExists(db, 'nodes') && tableExists(db, 'files')) db.exec('DELETE FROM nodes;');

    // 2. Add struct_hash. DEFAULT '' so existing rows (we clear them
    //    in step 3 below but the column has to be addable beforehand)
    //    have a sentinel that always-mismatches the first computed
    //    hash, forcing one initial full-path extract per file. Guarded
    //    against test fixtures whose `parse_cache` already lists
    //    struct_hash (created via the modern schema.sql before this
    //    migration runs).
    if (tableExists(db, 'parse_cache') && !columnExists(db, 'parse_cache', 'struct_hash')) {
      db.exec("ALTER TABLE parse_cache ADD COLUMN struct_hash TEXT NOT NULL DEFAULT '';");
    }

    // 3. Clear parse_cache — every cached payload was serialized under
    //    the pre-stable id formula; replaying one would re-introduce
    //    the stale ids the wipe in step 1 just removed.
    if (tableExists(db, 'parse_cache')) db.exec('DELETE FROM parse_cache;');

    // 4. Zero each file's content_hash so the next sync's content-
    //    changed gate fires for every tracked file. (Without this, the
    //    git fast-path / content-hash diff would mark every file as
    //    unchanged — disk content didn't move — and skip the
    //    re-extract.) Files vanished from disk get reaped by the
    //    existing `eoReapVanishedFiles` sweep.
    if (tableExists(db, 'files')) db.exec("UPDATE files SET content_hash = '';");
  },
};
