/**
 * Migration 064 — restore the `nodes.file_path` FK that migration 056
 * silently failed to add.
 *
 * Migration 056's FK-injection regex anchors on a `\n)` table-closing
 * paren. By the time it runs, `nodes` has `ALTER TABLE ADD COLUMN`
 * columns appended, so its stored CREATE ends on a content line —
 * `... body_hash TEXT NOT NULL DEFAULT '') STRICT` — and the regex
 * never matched: 056 rebuilt `nodes` to the same no-FK shape and
 * reported success. Without the FK, `deleteFile`'s cascade was a
 * no-op, so re-extraction accumulated duplicate nodes.
 *
 * These tests build a DB in that exact broken shape and assert
 * migration 064 repairs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase } from '../src/db/sqlite-adapter.js';
import type { SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { DatabaseConnection } from '../src/db/index.js';
import { MIGRATION as MIG_064 } from '../src/db/migrations/064-restore-nodes-file-path-fk.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-064-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A DB with the broken pre-064 shape: a `files` table and a `nodes`
 * table WITHOUT the `file_path` FK, whose CREATE ends on a content
 * line (`'') STRICT`) — the exact shape that defeated migration 056.
 */
function brokenDb(dir: string): SqliteDatabase {
  const { db } = createDatabase(path.join(dir, 'broken.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    `CREATE TABLE files (
       path TEXT PRIMARY KEY,
       content_hash TEXT NOT NULL,
       language TEXT NOT NULL,
       size INTEGER NOT NULL,
       modified_at INTEGER NOT NULL,
       indexed_at INTEGER NOT NULL,
       needs_reextract INTEGER NOT NULL DEFAULT 0
     ) STRICT`,
  );
  // No FOREIGN KEY; closing paren sits on a content line after the
  // ALTER-style appended `role` / `body_hash` columns.
  db.exec(
    `CREATE TABLE "nodes" (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       qualified_name TEXT NOT NULL,
       file_path TEXT NOT NULL,
       language TEXT NOT NULL,
       start_line INTEGER NOT NULL,
       end_line INTEGER NOT NULL,
       start_column INTEGER NOT NULL,
       end_column INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
, role TEXT, body_hash TEXT NOT NULL DEFAULT '') STRICT`,
  );
  return db;
}

function seedFile(db: SqliteDatabase, fpath: string): void {
  db.prepare(
    'INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(fpath, 'h', 'typescript', 0, 0, 0);
}

function seedNode(db: SqliteDatabase, id: string, fpath: string, line: number): void {
  db.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column, updated_at)
     VALUES (?, 'method', 'dup', 'C::dup', ?, 'typescript', ?, ?, 0, 0, 0)`,
  ).run(id, fpath, line, line + 5);
}

function nodesFk(db: SqliteDatabase): Array<{ table: string; from: string }> {
  return db.prepare('PRAGMA foreign_key_list(nodes)').all() as Array<{ table: string; from: string }>;
}

describe('Migration 064 — restore nodes.file_path FK', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('adds the file_path FK to a nodes table that lacks it', () => {
    const db = brokenDb(dir);
    try {
      expect(nodesFk(db)).toHaveLength(0); // broken: no FK
      seedFile(db, 'src/x.ts');
      seedNode(db, 'method:a', 'src/x.ts', 10);

      MIG_064.up(db);

      const fk = nodesFk(db);
      expect(fk.some((f) => f.table === 'files' && f.from === 'file_path')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('makes the cascade live — deleting a files row drops its nodes', () => {
    const db = brokenDb(dir);
    try {
      seedFile(db, 'src/x.ts');
      // Three rows for one symbol — the duplicate-accumulation the
      // missing cascade caused.
      seedNode(db, 'method:a', 'src/x.ts', 10);
      seedNode(db, 'method:b', 'src/x.ts', 24);
      seedNode(db, 'method:c', 'src/x.ts', 38);

      MIG_064.up(db);
      // Migration copies the rows as-is; the heal happens on re-extract.
      expect((db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(3);

      db.exec('PRAGMA foreign_keys = ON');
      db.exec("DELETE FROM files WHERE path = 'src/x.ts'");
      // The restored FK cascade now drops every node for that file.
      expect((db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('flags every file for re-extraction so the next sync purges duplicates', () => {
    const db = brokenDb(dir);
    try {
      seedFile(db, 'src/x.ts');
      seedFile(db, 'src/y.ts');
      MIG_064.up(db);
      const rows = db.prepare('SELECT needs_reextract FROM files').all() as Array<{
        needs_reextract: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.needs_reextract === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('purges true orphan nodes (file_path with no files row)', () => {
    const db = brokenDb(dir);
    try {
      seedFile(db, 'src/x.ts');
      seedNode(db, 'method:live', 'src/x.ts', 10);
      seedNode(db, 'method:orphan', 'src/gone.ts', 10); // no files row
      MIG_064.up(db);
      const ids = (db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['method:live']);
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second run on a repaired DB is a no-op', () => {
    const db = brokenDb(dir);
    try {
      seedFile(db, 'src/x.ts');
      MIG_064.up(db);
      expect(() => MIG_064.up(db)).not.toThrow();
      expect(nodesFk(db).some((f) => f.table === 'files')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is a no-op rebuild on a fresh DB (schema.sql already declares the FK)', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const db = conn.getDb();
      expect(nodesFk(db).some((f) => f.table === 'files')).toBe(true); // fresh: FK present
      expect(() => MIG_064.up(db)).not.toThrow();
      expect(nodesFk(db).some((f) => f.table === 'files')).toBe(true);
    } finally {
      conn.close();
    }
  });
});
