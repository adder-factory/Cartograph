import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db/index.js';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersion,
  runMigrations,
  verifySchemaIntegrity,
} from '../src/db/migrations.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-history-'));
  dirs.push(dir);
  return path.join(dir, name);
}

function userTableAndViewNames(db: SqliteDatabase): string[] {
  return (
    db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'view', 'index', 'trigger')
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE 'vec_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string }>
  ).map((row) => `${row.type}:${row.name}`);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function normalizeSql(sql: string | null): string {
  return (sql ?? '').replaceAll(/\s+/g, ' ').replaceAll(/\s+\(/g, '(').trim();
}

function userObjects(db: SqliteDatabase): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('table', 'view', 'index', 'trigger')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'vec_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

function userObjectSqlShape(db: SqliteDatabase): string[] {
  return userObjects(db)
    .filter((row) => row.type !== 'table' && row.type !== 'index')
    .map((row) => `${row.type}:${row.name}:${row.tbl_name}:${normalizeSql(row.sql)}`);
}

function tableColumnShape(db: SqliteDatabase): string[] {
  const out: string[] = [];
  for (const row of userObjects(db).filter((obj) => obj.type === 'table' || obj.type === 'view')) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdent(row.name)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>;
    for (const col of columns) {
      out.push(
        `${row.type}:${row.name}:${col.name}:${col.type}:${col.notnull}:${col.dflt_value ?? ''}:${col.pk}:${col.hidden}`,
      );
    }
  }
  return out.sort();
}

function tableForeignKeyShape(db: SqliteDatabase): string[] {
  const out: string[] = [];
  for (const row of userObjects(db).filter((obj) => obj.type === 'table')) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(row.name)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    for (const fk of fks) {
      out.push(
        `${row.name}:${fk.id}:${fk.seq}:${fk.table}:${fk.from}:${fk.to}:${fk.on_update}:${fk.on_delete}:${fk.match}`,
      );
    }
  }
  return out;
}

function tableIndexShape(db: SqliteDatabase): string[] {
  const out: string[] = [];
  for (const row of userObjects(db).filter((obj) => obj.type === 'table')) {
    const indexes = db.prepare(`PRAGMA index_list(${quoteIdent(row.name)})`).all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const index of indexes.filter((idx) => !idx.name.startsWith('sqlite_'))) {
      out.push(`${row.name}:${index.name}:${index.unique}:${index.origin}:${index.partial}`);
      const cols = db.prepare(`PRAGMA index_xinfo(${quoteIdent(index.name)})`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>;
      for (const col of cols) {
        const indexedColumn = col.name ?? `cid:${col.cid}`;
        out.push(`${row.name}:${index.name}:${col.seqno}:${indexedColumn}:${col.desc}:${col.coll}:${col.key}`);
      }
    }
  }
  return out.sort();
}

function expectSchemaShapeParity(db: SqliteDatabase, fresh: SqliteDatabase): void {
  expect(userTableAndViewNames(db)).toEqual(userTableAndViewNames(fresh));
  expect(userObjectSqlShape(db)).toEqual(userObjectSqlShape(fresh));
  expect(tableColumnShape(db)).toEqual(tableColumnShape(fresh));
  expect(tableForeignKeyShape(db)).toEqual(tableForeignKeyShape(fresh));
  expect(tableIndexShape(db)).toEqual(tableIndexShape(fresh));
}

function tempRebuildObjects(db: SqliteDatabase): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => /__.*_tmp$/.test(name));
}

function foreignKeyViolations(db: SqliteDatabase): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all();
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function nodesFilePathFk(db: SqliteDatabase): Array<{ table: string; from: string }> {
  return db.prepare('PRAGMA foreign_key_list(nodes)').all() as Array<{ table: string; from: string }>;
}

function setCurrentVersionForFixture(db: SqliteDatabase, version: number): void {
  db.exec('DELETE FROM schema_versions');
  db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
    version,
    Date.now(),
    `legacy v${version} fixture`,
  );
}

function seedIndexedNode(db: SqliteDatabase, id: string, startLine: number): void {
  db.prepare(
    `INSERT INTO nodes (
       id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column, updated_at, body_hash
     ) VALUES (?, 'function', 'run', 'src/a.ts::run', 'src/a.ts', 'typescript', ?, ?, 0, 0, 1, 'body-hash')`,
  ).run(id, startLine, startLine + 1);
}

function seedIndexedFileWithDuplicateNodes(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count)
     VALUES ('src/a.ts', 'file-hash-before', 'typescript', 100, 1, 1, 2)`,
  ).run();
  seedIndexedNode(db, 'n_old_1', 1);
  seedIndexedNode(db, 'n_old_2', 12);
}

function rebuildNodesWithoutFilePathFk(db: SqliteDatabase): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) throw new Error('fixture setup failed: nodes table missing');

  const brokenSql = row.sql.replace(
    /,\s*(?:--[^\n]*(?:\n|$)\s*)*FOREIGN\s+KEY\s*\(\s*file_path\s*\)\s+REFERENCES\s+files\s*\(\s*path\s*\)\s+ON\s+DELETE\s+CASCADE/i,
    '',
  );
  if (brokenSql === row.sql) throw new Error('fixture setup failed: could not remove nodes.file_path FK');

  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const triggers = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'nodes' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const columns = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>)
    .map((col) => `"${col.name}"`)
    .join(', ');

  const tempName = 'nodes__historical_no_fk_tmp';
  const tempSql = brokenSql.replace(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"nodes"|nodes\b)/i,
    `CREATE TABLE ${tempName}`,
  );
  if (tempSql === brokenSql) throw new Error('fixture setup failed: could not rename nodes temp table');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(tempSql);
    db.exec(`INSERT INTO ${tempName} (rowid, ${columns}) SELECT rowid, ${columns} FROM nodes`);
    db.exec('DROP TABLE nodes');
    db.exec(`ALTER TABLE ${tempName} RENAME TO nodes`);
    for (const index of indexes) db.exec(index.sql);
    for (const trigger of triggers) db.exec(trigger.sql);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

describe('historical migration chains', () => {
  const historicalVersions = [48, 53, 56, 64, 66] as const;

  for (const version of historicalVersions) {
    it(`migrates a v${version} full-chain snapshot to current schema`, () => {
      const { db } = createDatabase(tempPath(`v${version}.db`));
      const fresh = DatabaseConnection.initialize(tempPath(`fresh-v${version}.db`));
      try {
        runMigrations(db, 0, version);
        expect(getCurrentVersion(db)).toBe(version);

        runMigrations(db, version);
        expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
        expect(() => verifySchemaIntegrity(db)).not.toThrow();
        expect(foreignKeyViolations(db)).toEqual([]);
        expect(tempRebuildObjects(db)).toEqual([]);
        expectSchemaShapeParity(db, fresh.getDb());
      } finally {
        db.close();
        fresh.close();
      }
    });
  }

  it('repairs a seeded v63 no-FK nodes shape through the full current chain', () => {
    const conn = DatabaseConnection.initialize(tempPath('seeded-v63-no-nodes-fk.db'));
    try {
      const db = conn.getDb();
      seedIndexedFileWithDuplicateNodes(db);
      rebuildNodesWithoutFilePathFk(db);
      setCurrentVersionForFixture(db, 63);

      expect(nodesFilePathFk(db).some((fk) => fk.table === 'files' && fk.from === 'file_path')).toBe(false);
      expect(count(db, 'nodes')).toBe(2);

      runMigrations(db, 63);

      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(nodesFilePathFk(db).some((fk) => fk.table === 'files' && fk.from === 'file_path')).toBe(true);
      expect(count(db, 'nodes')).toBe(0);
      expect(db.prepare('SELECT content_hash, needs_reextract FROM files WHERE path = ?').get('src/a.ts')).toEqual({
        content_hash: '',
        needs_reextract: 1,
      });
      expect(foreignKeyViolations(db)).toEqual([]);
      expect(tempRebuildObjects(db)).toEqual([]);
    } finally {
      conn.close();
    }
  });
});
