/**
 * Migration 055 — file_path FK on the *_refs tables.
 *
 * Verifies:
 *   - Fresh DB declares the FK on every targeted table.
 *   - Insert of a ref whose file_path doesn't exist in `files` is
 *     rejected with FOREIGN KEY constraint failed.
 *   - Deleting a `files` row CASCADEs the dependent ref rows.
 *   - Insert with a present file_path succeeds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { DatabaseConnection } from '../src/db/index.js';
import { MIGRATION as MIG_055 } from '../src/db/migrations/055-refs-file-path-fk.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-055-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function seedFile(db: ReturnType<DatabaseConnection['getDb']>, fpath: string): void {
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fpath, 'h', 'typescript', 0, 0, 0);
}

const TARGETS = ['unresolved_refs', 'config_refs', 'sql_refs', 'build_context_refs', 'string_imports'] as const;

// Per-table insert helpers. Each accepts a (db, file_path) pair and
// performs the minimal-column INSERT for that table. Ordered to
// satisfy each table's NOT NULL columns including the node_id FK
// where present (seeded via `seedNode` in the cascade test).
const insertOrphan: Record<string, (db: ReturnType<DatabaseConnection['getDb']>, fp: string) => void> = {
  unresolved_refs: (db, fp) => {
    db.prepare(
      `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('n_seed', 'foo', 'calls', 1, 0, fp, 'typescript');
  },
  config_refs: (db, fp) => {
    db.prepare(
      `INSERT INTO config_refs (config_kind, config_key, source_node_id, file_path, line) VALUES (?, ?, ?, ?, ?)`,
    ).run('env', 'KEY', null, fp, 1);
  },
  sql_refs: (db, fp) => {
    db.prepare(`INSERT INTO sql_refs (table_name, op, source_node_id, file_path, line) VALUES (?, ?, ?, ?, ?)`).run(
      'users',
      'read',
      null,
      fp,
      1,
    );
  },
  build_context_refs: (db, fp) => {
    db.prepare(`INSERT INTO build_context_refs (ref_kind, source_node_id, file_path, line) VALUES (?, ?, ?, ?)`).run(
      'dirname',
      null,
      fp,
      1,
    );
  },
  string_imports: (db, fp) => {
    db.prepare(
      `INSERT INTO string_imports (file_path, line, module_name, raw, container_kind) VALUES (?, ?, ?, ?, ?)`,
    ).run(fp, 1, 'foo', `'foo'`, 'string_literal');
  },
};

function seedNode(db: ReturnType<DatabaseConnection['getDb']>): void {
  db.prepare(
    `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('n_seed', 's', 's', 'function', 'typescript', 'src/a.ts', 1, 2, 0, 0, 0, '');
}

function legacyRefsDb(dir: string, name: string): SqliteDatabase {
  const { db } = createDatabase(path.join(dir, name));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    `CREATE TABLE files (
       path TEXT PRIMARY KEY,
       content_hash TEXT NOT NULL,
       language TEXT NOT NULL,
       size INTEGER NOT NULL,
       modified_at INTEGER NOT NULL,
       indexed_at INTEGER NOT NULL
     ) STRICT`,
  );
  db.exec(
    `CREATE TABLE unresolved_refs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       from_node_id TEXT NOT NULL,
       reference_name TEXT NOT NULL,
       reference_kind TEXT NOT NULL,
       line INTEGER NOT NULL,
       col INTEGER NOT NULL,
       file_path TEXT NOT NULL,
       language TEXT NOT NULL
     ) STRICT`,
  );
  return db;
}

function hasFilePathFk(db: SqliteDatabase, tableName: string): boolean {
  const fks = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{ table: string; from: string }>;
  return fks.some((fk) => fk.table === 'files' && fk.from === 'file_path');
}

describe('Migration 055 — file_path FK on *_refs tables', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('fresh DB declares file_path FK on every targeted table', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const db = dbConn.getDb();
      for (const t of TARGETS) {
        const sql = (
          db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t) as { sql: string }
        ).sql;
        expect(sql).toMatch(/FOREIGN\s+KEY\s*\(\s*file_path\s*\)\s+REFERENCES\s+files/i);
      }
    } finally {
      dbConn.close();
    }
  });

  it('adds the file_path FK to an upgraded unresolved_refs table that lacks it', () => {
    const db = legacyRefsDb(dir, 'legacy-unresolved.db');
    try {
      expect(hasFilePathFk(db, 'unresolved_refs')).toBe(false);
      seedFile(db as ReturnType<DatabaseConnection['getDb']>, 'src/a.ts');
      db.prepare(
        `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('n_seed', 'foo', 'calls', 1, 0, 'src/a.ts', 'typescript');

      MIG_055.up(db);

      expect(hasFilePathFk(db, 'unresolved_refs')).toBe(true);
      db.prepare(`DELETE FROM files WHERE path = ?`).run('src/a.ts');
      expect((db.prepare('SELECT COUNT(*) AS n FROM unresolved_refs').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('throws instead of silently recording success when a ref-table rebuild fails', () => {
    const db = legacyRefsDb(dir, 'legacy-rebuild-fail.db');
    try {
      db.exec('CREATE TABLE unresolved_refs__fk_tmp (id INTEGER PRIMARY KEY)');
      expect(() => MIG_055.up(db)).toThrow();
      expect(db.prepare("SELECT 1 AS one FROM sqlite_master WHERE name='unresolved_refs__fk_tmp'").get()).toBeNull();
      expect(hasFilePathFk(db, 'unresolved_refs')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('skips partial fixtures that have ref tables but no files table', () => {
    const { db } = createDatabase(path.join(dir, 'partial-no-files.db'));
    try {
      db.exec(
        `CREATE TABLE unresolved_refs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           from_node_id TEXT NOT NULL,
           reference_name TEXT NOT NULL,
           reference_kind TEXT NOT NULL,
           line INTEGER NOT NULL,
           col INTEGER NOT NULL,
           file_path TEXT NOT NULL,
           language TEXT NOT NULL
         ) STRICT`,
      );

      expect(() => MIG_055.up(db)).not.toThrow();
      expect(hasFilePathFk(db, 'unresolved_refs')).toBe(false);
    } finally {
      db.close();
    }
  });

  for (const t of TARGETS) {
    it(`${t}: rejects insert with non-existent file_path`, () => {
      const dbConn = DatabaseConnection.initialize(path.join(dir, `reject-${t}.db`));
      try {
        const db = dbConn.getDb();
        // unresolved_refs needs a node_id to satisfy its other FK.
        if (t === 'unresolved_refs') {
          seedFile(db, 'src/a.ts');
          seedNode(db);
        }
        expect(() => insertOrphan[t]!(db, 'does/not/exist.ts')).toThrow(/FOREIGN KEY constraint failed/);
      } finally {
        dbConn.close();
      }
    });

    it(`${t}: CASCADEs ref rows when parent file is deleted`, () => {
      const dbConn = DatabaseConnection.initialize(path.join(dir, `cascade-${t}.db`));
      try {
        const db = dbConn.getDb();
        seedFile(db, 'src/a.ts');
        if (t === 'unresolved_refs') seedNode(db);
        insertOrphan[t]!(db, 'src/a.ts');
        const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        expect(before).toBe(1);
        db.prepare(`DELETE FROM files WHERE path = ?`).run('src/a.ts');
        const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        expect(after).toBe(0);
      } finally {
        dbConn.close();
      }
    });
  }
});
