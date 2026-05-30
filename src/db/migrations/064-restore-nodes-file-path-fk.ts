import type { MigrationModule } from './types.js';

/**
 * Restore the `FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE
 * CASCADE` on `nodes` — migration 056 was meant to add it but silently
 * never did, on every upgraded DB.
 *
 * Root cause. Migration 056 injects the FK by regex, anchored on a
 * `\n)` table-closing paren. By the time 056 runs, `nodes` has columns
 * appended by earlier `ALTER TABLE ADD COLUMN` migrations (`role`,
 * `role_model`, `body_hash`), so its stored CREATE ends on a CONTENT
 * line — `... body_hash TEXT NOT NULL DEFAULT '') STRICT` — with no
 * newline before the `)`. Neither 056 regex matched, so `tempCreateSql`
 * came out identical to the source: 056 rebuilt `nodes` to the exact
 * same no-FK shape and reported success. `PRAGMA foreign_key_list
 * (nodes)` on a live upgraded DB returns zero rows.
 *
 * Impact. `deleteFile` deletes only the `files` row and trusts the
 * cascade to drop that file's `nodes`. With the FK absent the cascade
 * is a no-op, so every re-extraction (`eoPersistFileExtraction` →
 * `removeFileFromIndexInTx`) left the prior extraction's nodes behind
 * and inserted a fresh set alongside them. Upgraded DBs accumulated
 * thousands of stale duplicate nodes (e.g. 20 rows for a method that
 * exists once in source, at drifting / overlapping line ranges).
 *
 * This migration:
 *   1. Rebuilds `nodes` WITH the FK — injecting the clause before the
 *      table-closing `)` located by `lastIndexOf`, robust to the
 *      ALTER-mangled shape that defeated 056's regex.
 *   2. Post-verifies via `PRAGMA foreign_key_list` and throws if the
 *      FK still isn't there — 056's failure mode was that it could
 *      silently no-op; this one cannot.
 *   3. Flags every `files` row `needs_reextract = 1` so the next sync
 *      re-extracts each file once: the now-present cascade purges the
 *      accumulated duplicates and the file re-inserts clean.
 *
 * `requiresFkDisable: true` — the rebuild swaps `nodes` out from under
 * every FK that references `nodes(id)` (edges, *_refs, summary_refs, …).
 *
 * Idempotent: the rebuild is skipped when the FK is already declared
 * (fresh DBs get it from `schema.sql`), and the re-extract flag is set
 * only when the FK was actually restored — so a re-run is a true
 * no-op rather than spuriously re-flagging every file.
 */

interface ObjectRow {
  name: string;
  sql: string | null;
}

const TEMP_SUFFIX = '__nodes_fk_restore_tmp';

export const MIGRATION: MigrationModule = {
  description: 'Restore the file_path FK on nodes (migration 056 silently no-op-ed it)',
  requiresFkDisable: true,
  up: (db) => {
    const hasTable = (name: string): boolean =>
      !!db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!hasTable('files') || !hasTable('nodes')) return;

    // Partial-schema guard — same shape migrations 054 / 056 / 062 use.
    // Minimal test fixtures bootstrap a bare `nodes` without the rtree
    // columns the migration-034 triggers reference; skip cleanly there.
    const nodeCols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name);
    if (!nodeCols.includes('start_line') || !nodeCols.includes('end_line')) return;

    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | ObjectRow
      | undefined;
    if (!row || !row.sql) return;

    const fkAlready = /FOREIGN\s+KEY\s*\(\s*file_path\s*\)\s+REFERENCES\s+files/i.test(row.sql);
    if (fkAlready) return; // already correct (fresh DB, or a re-run) — true no-op

    restoreFilePathFk(db, row);
    // Post-verify — this migration exists precisely because 056 could
    // silently no-op. Fail loud if the FK still isn't there.
    const fkList = db.prepare('PRAGMA foreign_key_list(nodes)').all() as Array<{ table: string }>;
    if (!fkList.some((fk) => fk.table === 'files')) {
      throw new Error('migration 064: nodes.file_path FK still absent after rebuild');
    }

    // Heal the duplicates 056's missing cascade let accumulate: flag
    // every file for one re-extraction. The next sync's per-file
    // removeFileFromIndexInTx now cascades the stale rows away. Done
    // only here — a DB that already had the FK never accumulated
    // duplicates, so a re-run must not re-flag every file.
    const hasReextractCol = (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).some(
      (c) => c.name === 'needs_reextract',
    );
    if (hasReextractCol) {
      db.exec('UPDATE files SET needs_reextract = 1');
    }
  },
};

function restoreFilePathFk(db: import('../sqlite-adapter.js').SqliteDatabase, table: ObjectRow): void {
  if (!table.sql) return;

  // Purge true orphans first (nodes whose file has no `files` row) so
  // the rebuilt table satisfies the FK / post-migration fk_check.
  db.exec('DELETE FROM "nodes" WHERE file_path NOT IN (SELECT path FROM files)');

  // Indexes + triggers are cascaded away by the DROP — capture them to
  // recreate after the rename. Trigger SQL embeds the name `nodes`,
  // which resolves correctly again post-rename.
  const indexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='nodes' AND sql IS NOT NULL")
    .all() as ObjectRow[];
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='nodes'")
    .all() as ObjectRow[];

  const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>)
    .map((c) => `"${c.name}"`)
    .join(', ');

  const tempName = `nodes${TEMP_SUFFIX}`;
  // `\b` lives inside the unquoted branch only — after a closing `"`
  // it never matches (quote and space are both non-word chars), which
  // is how migration 056 silently failed on the quoted `"nodes"` shape.
  const renameRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"nodes"|nodes\b)/i;
  const renamedSql = table.sql.replace(renameRegex, `CREATE TABLE ${tempName}`);
  if (renamedSql === table.sql) {
    throw new Error('migration 064: could not rename `nodes` in its CREATE statement');
  }

  // Inject the FK before the table-closing `)`. Located via
  // lastIndexOf — robust to an ALTER-mangled CREATE whose closing paren
  // sits on a content line (`...DEFAULT '') STRICT`). Everything after
  // the table-closer is table options only; assert that and throw on
  // anything unexpected rather than silently mis-injecting.
  const close = renamedSql.lastIndexOf(')');
  if (close < 0) {
    throw new Error('migration 064: nodes CREATE statement has no closing paren');
  }
  const suffix = renamedSql.slice(close + 1);
  if (!/^[\s;]*(?:STRICT|WITHOUT\s+ROWID)?[\s;]*$/i.test(suffix)) {
    throw new Error(`migration 064: unexpected content after nodes table-closing paren: ${JSON.stringify(suffix)}`);
  }
  const fkClause = ',\n    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE\n';
  const tempCreateSql = renamedSql.slice(0, close) + fkClause + renamedSql.slice(close);

  db.exec(tempCreateSql);
  // INSERT ... SELECT preserves rowid by implicit assignment, so the
  // FTS5 `content='nodes'` mirror and the rtree rowid mapping stay
  // valid without an explicit rebuild (same guarantee migration 056
  // relied on).
  db.exec(`INSERT INTO ${tempName} (${cols}) SELECT ${cols} FROM "nodes"`);
  db.exec('DROP TABLE "nodes"');
  db.exec(`ALTER TABLE ${tempName} RENAME TO "nodes"`);

  for (const idx of indexes) {
    if (idx.sql) db.exec(idx.sql);
  }
  for (const trg of triggers) {
    if (trg.sql) db.exec(trg.sql);
  }
}
