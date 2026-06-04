import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_066 } from '../src/db/migrations/066-stabilize-node-ids.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-066-'));
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function columnNames(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
}

function createPre066Shape(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      body_hash TEXT NOT NULL
    );

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
    );

    CREATE TABLE unresolved_refs (
      id INTEGER PRIMARY KEY,
      from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      reference_name TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      col INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL
    );

    CREATE TABLE role_assignments (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      role TEXT NOT NULL
    );

    CREATE TABLE code_health_findings (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      biomarker TEXT NOT NULL,
      severity TEXT NOT NULL
    );

    CREATE TABLE node_loc_history (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );

    CREATE TABLE parse_cache (
      content_hash TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      file_path TEXT NOT NULL,
      payload TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );

    CREATE TABLE summary_store (
      content_hash TEXT PRIMARY KEY,
      summary TEXT NOT NULL
    );

    CREATE TABLE embedding_store (
      content_hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    );
  `);
}

function seedPre066Shape(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('src/a.ts', 'file-hash-before', 'typescript', 100, 1, 1);
  db.prepare(
    `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('n_old', 'a', 'src/a.ts::a', 'function', 'typescript', 'src/a.ts', 1, 2, 0, 0, 1, 'body-hash');
  db.prepare(`INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)`).run('n_old', 'n_old', 'calls');
  db.prepare(
    `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('n_old', 'b', 'calls', 1, 0, 'src/a.ts', 'typescript');
  db.prepare(`INSERT INTO role_assignments (node_id, role) VALUES (?, ?)`).run('n_old', 'business_logic');
  db.prepare(`INSERT INTO code_health_findings (node_id, biomarker, severity) VALUES (?, ?, ?)`).run(
    'n_old',
    'complex_method',
    'warning',
  );
  db.prepare(`INSERT INTO node_loc_history (node_id, file_path, start_line, end_line) VALUES (?, ?, ?, ?)`).run(
    'n_old',
    'src/a.ts',
    1,
    2,
  );
  db.prepare(
    `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('file-hash-before', 'typescript', 'src/a.ts', '{}', 1);
  db.prepare(`INSERT INTO summary_store (content_hash, summary) VALUES (?, ?)`).run('body-hash', 'summary survives');
  db.prepare(`INSERT INTO embedding_store (content_hash, embedding) VALUES (?, ?)`).run(
    'body-hash',
    new Uint8Array([1, 2]),
  );
}

describe('Migration 066 — stabilize node ids', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('wipes stale structural rows, clears old parse cache, and preserves content-addressed stores', () => {
    const { db } = createDatabase(path.join(dir, 'pre-066.db'));
    try {
      createPre066Shape(db);
      seedPre066Shape(db);

      MIG_066.up(db);

      expect(count(db, 'nodes')).toBe(0);
      expect(count(db, 'edges')).toBe(0);
      expect(count(db, 'unresolved_refs')).toBe(0);
      expect(count(db, 'role_assignments')).toBe(0);
      expect(count(db, 'code_health_findings')).toBe(0);
      expect(count(db, 'node_loc_history')).toBe(0);
      expect(count(db, 'parse_cache')).toBe(0);
      expect(columnNames(db, 'parse_cache')).toContain('struct_hash');
      expect(count(db, 'summary_store')).toBe(1);
      expect(count(db, 'embedding_store')).toBe(1);
      expect(
        (db.prepare(`SELECT content_hash FROM files WHERE path = ?`).get('src/a.ts') as { content_hash: string })
          .content_hash,
      ).toBe('');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
