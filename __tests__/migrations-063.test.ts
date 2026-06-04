import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_063 } from '../src/db/migrations/063-file-summaries.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-063-'));
}

function createFilesTable(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    ) STRICT;
  `);
}

function seedFile(db: SqliteDatabase, filePath: string): void {
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(filePath, 'hash', 'typescript', 10, 1, 1);
}

describe('Migration 063 — file summaries', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a strict file-owned summaries table with FK cascade and model index', () => {
    const { db } = createDatabase(path.join(dir, 'pre-063.db'));
    try {
      createFilesTable(db);
      MIG_063.up(db);

      const createSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_summaries'`).get() as {
          sql: string;
        }
      ).sql;
      expect(createSql).toMatch(/STRICT,\s*WITHOUT ROWID/i);
      expect(
        db
          .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type = 'index' AND name = 'idx_file_summaries_model'`)
          .get(),
      ).not.toBeNull();

      expect(() =>
        db
          .prepare(
            `INSERT INTO file_summaries (file_path, summary, content_hash, model, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run('missing.ts', 'summary', 'hash', 'model', 1),
      ).toThrow(/FOREIGN KEY constraint failed/);

      seedFile(db, 'src/a.ts');
      db.prepare(
        `INSERT INTO file_summaries (file_path, summary, content_hash, model, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('src/a.ts', 'summary', 'hash', 'model', 1);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM file_summaries`).get() as { n: number }).n).toBe(1);

      db.prepare(`DELETE FROM files WHERE path = ?`).run('src/a.ts');
      expect((db.prepare(`SELECT COUNT(*) AS n FROM file_summaries`).get() as { n: number }).n).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
