import type { MigrationModule } from './types.js';

/**
 * Rebuild `nodes` to attach the `role` CHECK constraint.
 *
 * Background. Migration 040 added `nodes.role` via a bare
 * `ALTER TABLE nodes ADD COLUMN role TEXT` (no CHECK). Migration 054's
 * strictify rebuild attempted to inject the CHECK via a regex fixup
 * (`PER_TABLE_FIXUPS['nodes']`), but the regex required a trailing
 * comma on the `role TEXT` definition. SQLite's `ALTER TABLE ADD
 * COLUMN` appends the new column inline before the closing
 * parenthesis without per-column newlines — sqlite_master ends up
 * with `... updated_at INTEGER NOT NULL\n      , centrality REAL ...,
 * role TEXT, role_model TEXT, body_hash ...`. The original regex
 * `/(^\s+)role\s+TEXT,/im` requires a line-leading match it never
 * gets, so 054 silently no-ops on that one fixup and the resulting
 * `nodes` table ships STRICT but without the role enum CHECK.
 *
 * Consequence. Fresh installs (from `schema.sql` direct) enforce the
 * role enum at the DB layer. Upgraded installs (anyone whose DB
 * went through ≤040) don't — a typo'd or stale-extractor role value
 * silently writes and corrupts downstream role-histogram queries.
 *
 * Fix. Read the current `nodes` CREATE statement from sqlite_master,
 * inject the CHECK after `role TEXT` with a permissive regex
 * (matches inline / multiline / trailing-comma / no-comma shapes),
 * and execute the standard table-rebuild dance (CREATE temp,
 * INSERT (rowid + all cols), DROP, RENAME, restore indexes +
 * triggers).
 *
 * Rowid preservation is load-bearing — `nodes_fts` (FTS5 with
 * `content='nodes'`) and `nodes_rtree` (manual r-tree from migration
 * 034) both key on `nodes.rowid`. The INSERT explicitly carries
 * `rowid` into the temp table so the FTS5/r-tree pointers remain
 * valid across the rebuild.
 *
 * Idempotent. Skips when the existing CREATE already contains
 * `CHECK (role IS NULL OR role IN`, so a fresh-from-schema.sql install
 * is a no-op, and a re-run on a DB that already went through this
 * migration is a no-op.
 *
 * FK-disable required. `requiresFkDisable: true` prevents the
 * `DROP TABLE nodes` step from cascade-deleting every FK-referencing
 * row (edges, unresolved_refs, summary_refs, embedding_refs, etc.).
 * The migration runner toggles foreign_keys off for this migration's
 * transaction; rows survive the rebuild and FK enforcement is
 * re-enabled when the migration finishes.
 */

const ROLE_LABELS = [
  'api_endpoint',
  'business_logic',
  'data_model',
  'util',
  'framework_glue',
  'test_helper',
  'unknown',
];

interface ObjectRow {
  name: string;
  sql: string | null;
}

export const MIGRATION: MigrationModule = {
  description: 'Rebuild nodes to attach the role CHECK constraint (closes drift from migration 040)',
  requiresFkDisable: true,
  up: (db) => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`).get() as
      | { sql: string | null }
      | undefined;
    if (!row?.sql) return;

    const originalSql = row.sql;

    // Idempotent: skip if the CHECK is already attached. Match either
    // spelling that ships in this codebase (schema.sql line 56,
    // PER_TABLE_FIXUPS['nodes']).
    if (/role\s+TEXT\s+CHECK\s*\(\s*role\s+IS\s+NULL/i.test(originalSql)) return;

    // Inject the CHECK after `role TEXT`. Permissive matching:
    //   - whitespace tolerance around the column name
    //   - matches `role TEXT,` (followed by another column) AND
    //     `role TEXT)` (last column) AND `role TEXT\n   ...` (multi-
    //     line CREATE TABLE shape)
    //   - negative lookahead on a leading `_` so `role_model TEXT`
    //     doesn't false-match
    const quotedRoles = ROLE_LABELS.map((v) => `'${v}'`).join(', ');
    const inList = `(${quotedRoles})`;
    const checkClause = `CHECK (role IS NULL OR role IN ${inList})`;
    const injectionRegex = /(?<!\w)role\s+TEXT(?!\s+CHECK)\b/i;
    if (!injectionRegex.test(originalSql)) {
      throw new Error(
        `[migration 067] could not locate \`role TEXT\` in nodes CREATE statement: ${originalSql.slice(0, 200)}…`,
      );
    }
    const newCreate = originalSql.replace(injectionRegex, `role TEXT ${checkClause}`);

    // Capture indexes + triggers attached to nodes before the DROP
    // cascades them away. `sql IS NULL` skips SQLite's internal
    // auto-indexes (created for PRIMARY KEY / UNIQUE) — the rebuild's
    // CREATE TABLE re-establishes those.
    const indexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'nodes' AND sql IS NOT NULL`,
      )
      .all() as ObjectRow[];
    const triggers = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'nodes'`)
      .all() as ObjectRow[];

    // Column list (excluding rowid) for the INSERT. Read it from
    // PRAGMA table_info so we don't have to re-parse the CREATE
    // statement to discover ALTER-added columns.
    const cols = (db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length === 0) {
      throw new Error('[migration 067] nodes table reported zero columns — refusing to rebuild');
    }
    const colList = cols.map((c) => `"${c}"`).join(', ');

    // Rebuild dance. Renaming a temp into place avoids the FK-list
    // rewrite SQLite does on ALTER TABLE RENAME — the new table
    // already declares the FK in its CREATE statement.
    const TEMP_NAME = 'nodes__role_check_tmp';
    const tempCreate = newCreate.replace(/^CREATE\s+TABLE\s+"?nodes"?/i, `CREATE TABLE ${TEMP_NAME}`);
    if (tempCreate === newCreate) {
      throw new Error('[migration 067] could not rewrite CREATE TABLE name for temp rebuild');
    }

    db.exec(tempCreate);
    db.exec(`INSERT INTO ${TEMP_NAME} (rowid, ${colList}) SELECT rowid, ${colList} FROM nodes`);
    db.exec(`DROP TABLE nodes`);
    db.exec(`ALTER TABLE ${TEMP_NAME} RENAME TO nodes`);

    for (const idx of indexes) {
      if (idx.sql) db.exec(idx.sql);
    }
    for (const trg of triggers) {
      if (trg.sql) db.exec(trg.sql);
    }
  },
};
