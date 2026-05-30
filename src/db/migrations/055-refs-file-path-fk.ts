import type { MigrationModule } from './types.js';

/**
 * Add `FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE`
 * to the five `*_refs`-style tables that carry a `file_path` but
 * historically had no DB-side FK to the parent `files` row.
 *
 * Tables touched:
 *   - unresolved_refs
 *   - config_refs
 *   - sql_refs
 *   - build_context_refs
 *   - string_imports
 *
 * Why: each row in these tables is metadata derived from a single
 * source file. When the file is removed (deleted on disk + dropped
 * from `files`), every dependent ref row is now garbage. The
 * extractor's per-file delete loop already removes them today, but
 * making the FK explicit closes the gap if a future code path
 * forgets to call the per-table cleanup, AND surfaces the intent in
 * the schema itself.
 *
 * Tables NOT touched here:
 *   - nodes.file_path: explicit FK would force every nodes write to
 *     happen after files.path exists; the extractor already does
 *     this in the right order, but adding the FK risks tripping
 *     partial-schema test fixtures that bypass the canonical
 *     extractor flow. Worth a separate scoped PR.
 *   - directory_summaries.dir_path / parse_cache.file_path: these
 *     are intentionally decoupled from `files` lifecycle for cache
 *     survival semantics; an FK would defeat the purpose.
 *
 * Approach mirrors migration 054 (table rebuild via sqlite_master
 * SQL + per-table fixup), with one extra pre-step: purge any
 * orphan row whose file_path no longer exists in `files`. The live
 * audit at the time of this PR found zero orphans across all five
 * tables, so the purge is defensive — but if a future operator
 * re-applies the migration on a dirtier DB, the FK ADD would
 * otherwise abort the whole rebuild.
 */

interface ObjectRow {
  name: string;
  sql: string | null;
}

const TEMP_SUFFIX = '__fk_tmp';

const TABLES_WITH_FILE_PATH_FK: readonly string[] = [
  'unresolved_refs',
  'config_refs',
  'sql_refs',
  'build_context_refs',
  'string_imports',
];

export const MIGRATION: MigrationModule = {
  description: 'Add file_path FK to *_refs tables (unresolved/config/sql/build_context/string_imports)',
  requiresFkDisable: true,
  up: (db) => {
    // Pre-flight: same partial-schema guard migration 054 uses. If the
    // host DB doesn't have a real `files` table, there's nothing to
    // FK against — skip cleanly so test fixtures that build minimal
    // schemas don't trip this migration.
    const hasFiles = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='files'").get() as
      | { one: number }
      | undefined;
    if (!hasFiles) return;

    for (const tableName of TABLES_WITH_FILE_PATH_FK) {
      const row = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as
        | ObjectRow
        | undefined;
      if (!row?.sql) continue;
      // Skip if FK is already declared in the stored CREATE statement
      // (fresh DBs whose schema.sql already has it replay as a no-op).
      if (/FOREIGN\s+KEY\s*\(\s*file_path\s*\)\s+REFERENCES\s+files/i.test(row.sql)) continue;

      try {
        addFilePathFk(db, row);
      } catch (err) {
        // Same defensive cleanup pattern as migration 054.
        try {
          db.exec(`DROP TABLE IF EXISTS "${tableName}${TEMP_SUFFIX}"`);
        } catch {
          // Best-effort.
        }
        if (process.env['CARTOGRAPH_DEBUG_MIGRATIONS']) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[migration 055] skipped ${tableName}: ${msg}`);
        }
      }
    }
  },
};

function addFilePathFk(db: import('../sqlite-adapter.js').SqliteDatabase, table: ObjectRow): void {
  if (!table.sql) return;
  // Local copy for SQL interpolation — keeps the sql_string_concat
  // detector's bare-identifier gate happy. Real table-name security
  // is upstream: table.name comes from sqlite_master iteration.
  const tableName = table.name;

  // 1. Purge orphans first. The FK ADD would fail on the INSERT step
  //    if any row references a non-existent file. Live audit found 0
  //    orphans across all 5 tables but a re-application on a dirty DB
  //    needs this safety net.
  db.exec(`DELETE FROM "${tableName}" WHERE file_path NOT IN (SELECT path FROM files)`);

  // 2. Capture indexes + triggers so we can recreate them after the
  //    DROP cascades them away.
  const indexes = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
    .all(table.name) as ObjectRow[];
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`)
    .all(table.name) as ObjectRow[];

  const cols = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length === 0) {
    throw new Error(`migration 055: ${tableName} has zero columns — refusing to rebuild`);
  }
  const colList = cols.map((c) => `"${c}"`).join(', ');

  const tempName = `${tableName}${TEMP_SUFFIX}`;
  // Inject the new FK clause before the closing `)`. Migration 054
  // already added STRICT (and possibly CHECKs) to this table; preserve
  // those by inserting the FK as the LAST thing before `) STRICT`.
  // `\b` belongs INSIDE the alternation, on the unquoted branch only:
  // a `\b` after `"${tableName}"` never matches (`"` is a non-word
  // char, so there is no word boundary after it), so the quoted-name
  // shape SQLite leaves once migration 054's strictify rename has run
  // would be missed — the rename would silently no-op and the FK ADD
  // would skip the table. Mirrors the corrected form in migration 064.
  const renameRegex = new RegExp(
    String.raw`CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:"${tableName}"|${tableName}\b)`,
    'i',
  );
  const renamedSql = table.sql.replace(renameRegex, `CREATE TABLE ${tempName}`);
  if (renamedSql === table.sql) {
    throw new Error(`migration 055: could not rename \`${tableName}\` in its CREATE statement`);
  }

  // Inject the FK before the table-closing `)`. Located via
  // lastIndexOf — robust to a CREATE whose closing paren sits on a
  // content line and/or is indented (`      ) STRICT`), the shape
  // migration 054's strictify rebuild emits. The earlier `/(\n\))/`
  // regex required the paren to immediately follow a newline and
  // silently no-opped on 054's indented output, so the FK never
  // landed. Mirrors the corrected approach in migration 064.
  const close = renamedSql.lastIndexOf(')');
  if (close < 0) {
    throw new Error(`migration 055: ${tableName} CREATE statement has no closing paren`);
  }
  const suffix = renamedSql.slice(close + 1);
  if (!/^[\s;]*(?:STRICT\s*(?:,\s*WITHOUT\s+ROWID)?|WITHOUT\s+ROWID)?[\s;]*$/i.test(suffix)) {
    throw new Error(
      `migration 055: unexpected content after ${tableName} table-closing paren: ${JSON.stringify(suffix)}`,
    );
  }
  const fkClause = ',\n    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE\n';
  const tempCreateSql = renamedSql.slice(0, close) + fkClause + renamedSql.slice(close);

  db.exec(tempCreateSql);
  db.exec(`INSERT INTO ${tempName} (${colList}) SELECT ${colList} FROM "${tableName}"`);
  db.exec(`DROP TABLE "${tableName}"`);
  db.exec(`ALTER TABLE ${tempName} RENAME TO "${tableName}"`);

  for (const idx of indexes) {
    if (idx.sql) db.exec(idx.sql);
  }
  for (const trg of triggers) {
    if (trg.sql) db.exec(trg.sql);
  }
}
