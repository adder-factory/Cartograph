import type { MigrationModule } from './types.js';

/**
 * F-U fix: add `FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE
 * CASCADE` to `role_assignments` and reap the orphan rows that
 * accumulated before the FK existed.
 *
 * Background. Migration 052 created `role_assignments` as a side
 * table keyed by `node_id` but WITHOUT a FK, mirroring the original
 * schema-049 / schema-050 pattern. The sibling `summary_refs` /
 * `embedding_refs` tables both got their FKs added when they were
 * recreated by migration 057 (the post-054 repair). `role_assignments`
 * was also recreated by 057 but kept its pre-existing no-FK shape —
 * so dead-node cascades sweep summaries and embeddings but skip
 * role_assignments. Result: a live audit (2026-05-11) found 1709
 * orphan rows out of 3425 — ~50% of the table was dead-node garbage.
 *
 * This migration:
 *   1. Re-creates `role_assignments` with the FK in place (rebuild
 *      pattern from migrations 055 / 056 / 057).
 *   2. Copies live (non-orphan) rows over via a JOIN against `nodes`,
 *      dropping every orphan in one step.
 *   3. Preserves the `idx_role_assignments_body_hash` index from
 *      migration 052.
 *
 * Idempotent. The CREATE uses `IF NOT EXISTS` and the rebuild is
 * skipped when the stored CREATE statement already declares the FK,
 * so a re-application is a no-op on DBs that already have the FK.
 *
 * Reap step runs unconditionally (even when the FK rebuild is
 * skipped). SQLite's FK CASCADE only fires on parent DELETEs at the
 * time the row is dropped — it does NOT retroactively sweep orphans
 * that snuck in via `PRAGMA foreign_keys = OFF` or pre-existed before
 * the FK was added. So even on a fresh DB whose schema.sql declares
 * the FK from the start, the explicit DELETE here protects against
 * any orphans that accumulated during a deferred-FK window.
 *
 * `requiresFkDisable: true` because the rebuild swaps the parent
 * table out from under existing rows. The cascade-on-delete behaviour
 * is what we WANT in production, so disabling FK during the
 * transaction is correct here.
 */

interface ObjectRow {
  name: string;
  sql: string | null;
}

const TEMP_SUFFIX = '__fk_tmp';

export const MIGRATION: MigrationModule = {
  description: 'Add node_id FK to role_assignments + reap dead-node orphans',
  requiresFkDisable: true,
  up: (db) => {
    const hasNodes = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | { one: number }
      | undefined;
    const hasRoleAssignments = db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='role_assignments'")
      .get() as { one: number } | undefined;
    if (!hasNodes || !hasRoleAssignments) return;

    // Partial-schema guard — same shape used by migrations 054 / 056.
    // Some test fixtures bootstrap a minimal `nodes (id TEXT PRIMARY KEY)`
    // before running forward migrations. By the time we reach 062 the
    // pre-existing `nodes_rtree_ai` trigger (migration 034) references
    // `NEW.start_line` / `NEW.end_line`; the trigger's CREATE succeeded
    // when the columns didn't exist (SQLite doesn't validate at CREATE
    // TRIGGER time), but any future write to `nodes` would fail. We
    // don't write to `nodes` here, BUT the JOIN-bearing INSERT below can
    // still get the trigger fired via SQLite's INSERT planner under
    // certain WITHOUT ROWID + virtual-table combinations on minimal
    // fixtures. Skip cleanly in that shape — production DBs always have
    // start_line / end_line so the guard is a no-op there.
    const nodeCols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name);
    if (!nodeCols.includes('start_line') || !nodeCols.includes('end_line')) {
      return;
    }

    const row = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name='role_assignments'`)
      .get() as ObjectRow | undefined;
    if (!row || !row.sql) return;

    // Always run the orphan reap — cheap DELETE, independent of FK
    // shape. CASCADE only sweeps orphans created by parent-DELETEs
    // AFTER the FK was added; rows pre-dating the FK (or inserted under
    // `PRAGMA foreign_keys = OFF`) survive without this step.
    db.exec(`DELETE FROM role_assignments WHERE node_id NOT IN (SELECT id FROM nodes)`);

    // Skip the rebuild when the FK is already declared — re-runs after
    // a schema.sql sync (or partial-schema fixtures whose CREATE
    // already has the FK) become a no-op for the table-rewrite.
    if (/FOREIGN\s+KEY\s*\(\s*node_id\s*\)\s+REFERENCES\s+nodes/i.test(row.sql)) return;

    rebuildRoleAssignmentsWithFk(db, row);
  },
};

function rebuildRoleAssignmentsWithFk(db: import('../sqlite-adapter.js').SqliteDatabase, table: ObjectRow): void {
  if (!table.sql) return;

  // Capture the existing index list — STRICT/WITHOUT ROWID is already
  // declared on the CREATE statement so the regex-based rewrite below
  // preserves them naturally. Indexes get dropped with the table and
  // must be recreated explicitly.
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='role_assignments' AND sql IS NOT NULL`,
    )
    .all() as ObjectRow[];

  const cols = (db.prepare(`PRAGMA table_info(role_assignments)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length === 0) {
    throw new Error('migration 062: role_assignments has zero columns — refusing to rebuild');
  }
  const colList = cols.map((c) => `"${c}"`).join(', ');

  const tempName = `role_assignments${TEMP_SUFFIX}`;
  // `\b` belongs INSIDE the alternation, on the unquoted branch only:
  // a `\b` after `"role_assignments"` never matches (`"` is a
  // non-word char, so there is no word boundary after it), so the
  // quoted-name shape SQLite leaves once migration 054's strictify
  // rename has run would be missed — the temp-table SQL would keep
  // the real name and `CREATE TABLE role_assignments` would throw
  // "already exists". Mirrors the corrected form in migration 064.
  const renameRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"role_assignments"|role_assignments\b)/i;
  const renamedSql = table.sql.replace(renameRegex, `CREATE TABLE ${tempName}`);
  if (renamedSql === table.sql) {
    throw new Error('migration 062: could not rename `role_assignments` in its CREATE statement');
  }

  // Inject the FK before the table-closing `)`. Located via
  // lastIndexOf — robust to a CREATE whose closing paren is indented
  // (`      ) STRICT, WITHOUT ROWID`), the shape migration 054's
  // strictify rebuild emits. The earlier `/(\n\))/` regex required
  // the paren to immediately follow a newline and silently no-opped
  // on 054's indented output. Mirrors the corrected approach in
  // migration 064.
  const close = renamedSql.lastIndexOf(')');
  if (close < 0) {
    throw new Error('migration 062: role_assignments CREATE statement has no closing paren');
  }
  const suffix = renamedSql.slice(close + 1);
  if (!/^[\s;]*(?:STRICT\s*(?:,\s*WITHOUT\s+ROWID)?|WITHOUT\s+ROWID)?[\s;]*$/i.test(suffix)) {
    throw new Error(
      `migration 062: unexpected content after role_assignments table-closing paren: ${JSON.stringify(suffix)}`,
    );
  }
  const fkClause = ',\n    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE\n';
  const tempCreateSql = renamedSql.slice(0, close) + fkClause + renamedSql.slice(close);

  db.exec(tempCreateSql);

  // Copy ONLY rows whose node_id still exists in `nodes`. Orphans are
  // dropped silently here — the rebuild IS the reap.
  const selectCols = cols.map((c) => `ra."${c}"`).join(', ');
  db.exec(
    `INSERT INTO ${tempName} (${colList})
       SELECT ${selectCols}
         FROM role_assignments ra
         JOIN nodes n ON n.id = ra.node_id`,
  );
  db.exec(`DROP TABLE role_assignments`);
  db.exec(`ALTER TABLE ${tempName} RENAME TO role_assignments`);

  for (const idx of indexes) {
    if (idx.sql) db.exec(idx.sql);
  }
}
