import type { MigrationModule } from './types.js';

/**
 * Add `FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE`
 * to `nodes`. Follow-on to migration 055 (which did the same for the
 * five `*_refs`-style tables).
 *
 * Why now (and not in 055): nodes is the FTS5 content backing for
 * `nodes_fts` and `docstring_fts`, and the source of three trigger
 * cascades into `nodes_rtree` (migration 034). Rebuilding it has a
 * larger blast radius — every dependent FK target that references
 * `nodes(id)` (edges.source, edges.target, every *_refs.source_node_id,
 * summary_refs, embedding_refs, role_assignments, ...) must keep its
 * data through the rebuild. The standard SQLite approach for this is
 * `requiresFkDisable: true` (FK enforcement OFF for the duration of
 * the migration transaction) plus the same temp-table dance migration
 * 055 already proves out.
 *
 * Pre-flight audit (live DB at the time of this PR): 0 orphan nodes
 * across the workspace. Production code in eoPersistFileExtraction
 * already runs upsertFile BEFORE insertNodes (per the write-order fix
 * landed alongside migration 055), so the happy-path invariant the
 * FK requires is already true.
 *
 * Excluded from this PR: the same partial-schema test fixtures that
 * trip migration 054 also short-circuit here via the same nodes
 * column-presence guard — see migration 054's pre-flight comment for
 * the rationale.
 */

interface ObjectRow {
  name: string;
  sql: string | null;
}

const TEMP_SUFFIX = '__nodes_fk_tmp';

export const MIGRATION: MigrationModule = {
  description: 'Add file_path FK on nodes -> files(path) ON DELETE CASCADE',
  requiresFkDisable: true,
  up: (db) => {
    const hasFiles = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='files'").get() as
      | { one: number }
      | undefined;
    const hasNodes = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | { one: number }
      | undefined;
    if (!hasFiles || !hasNodes) return;

    // Same partial-schema guard migration 054 uses — the rtree
    // triggers reference NEW.start_line / NEW.end_line which the
    // partial test fixtures' minimal nodes don't have. On those, the
    // rebuild's INSERT step would trip the broken trigger. Production
    // DBs always have these columns since v1, so the guard is a
    // no-op there.
    const nodeCols = new Set(
      (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!nodeCols.has('start_line') || !nodeCols.has('end_line')) {
      return;
    }

    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | ObjectRow
      | undefined;
    if (!row?.sql) return;
    if (/FOREIGN\s+KEY\s*\(\s*file_path\s*\)\s+REFERENCES\s+files/i.test(row.sql)) return;

    try {
      addFilePathFkToNodes(db, row);
    } catch (err) {
      try {
        db.exec(`DROP TABLE IF EXISTS "nodes${TEMP_SUFFIX}"`);
      } catch {
        // Best-effort.
      }
      if (process.env['CARTOGRAPH_DEBUG_MIGRATIONS']) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[migration 056] skipped nodes: ${msg}`);
      }
    }
  },
};

function addFilePathFkToNodes(db: import('../sqlite-adapter.js').SqliteDatabase, table: ObjectRow): void {
  if (!table.sql) return;

  // 1. Defensive purge of any orphan nodes (live audit found 0).
  db.exec(`DELETE FROM "nodes" WHERE file_path NOT IN (SELECT path FROM files)`);

  // 2. Capture indexes + triggers so we can recreate them after the
  //    DROP cascades them away. The captured trigger SQL embeds the
  //    name `nodes`, which still resolves correctly after the
  //    rename-to step.
  const indexes = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
    .all('nodes') as ObjectRow[];
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`)
    .all('nodes') as ObjectRow[];

  const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name);
  const colList = cols.map((c) => `"${c}"`).join(', ');

  const tempName = `nodes${TEMP_SUFFIX}`;
  // `\b` belongs INSIDE the alternation, on the unquoted branch only:
  // a `\b` after `"nodes"` never matches (`"` is a non-word char, so
  // there is no word boundary after it), so the quoted-name shape
  // SQLite leaves once migration 054's strictify rename has run would
  // be missed and this rebuild would silently no-op. Mirrors the
  // corrected form in migration 064.
  const renameRegex = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:"nodes"|nodes\b)/i;
  const renamedSql = table.sql.replace(renameRegex, `CREATE TABLE ${tempName}`);
  const fkClause = `,\n    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE`;
  let tempCreateSql = renamedSql.replace(/(\n\)\s*STRICT[\s\w,]*?;?)$/i, `${fkClause}$1`);
  if (tempCreateSql === renamedSql) {
    // Fallback for a non-STRICT shape (test fixture predating 054).
    tempCreateSql = renamedSql.replace(/(\n\)\s*;?\s*)$/, `${fkClause}$1`);
  }

  db.exec(tempCreateSql);
  db.exec(`INSERT INTO ${tempName} (${colList}) SELECT ${colList} FROM "nodes"`);
  db.exec(`DROP TABLE "nodes"`);
  db.exec(`ALTER TABLE ${tempName} RENAME TO "nodes"`);

  // FTS5 with `content='nodes'` keeps working as long as the rowid
  // mapping is preserved. Our INSERT...SELECT preserves rowid by
  // implicit assignment; the rebuild therefore doesn't need an FTS
  // 'rebuild' command. (The vec0/HNSW concerns from migration 050
  // don't apply: nodes isn't a vec backing table.)

  for (const idx of indexes) {
    if (idx.sql) db.exec(idx.sql);
  }
  for (const trg of triggers) {
    if (trg.sql) db.exec(trg.sql);
  }
}
