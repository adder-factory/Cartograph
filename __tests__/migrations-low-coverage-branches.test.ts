import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_001 } from '../src/db/migrations/001-initial-schema.js';
import { MIGRATION as MIG_049 } from '../src/db/migrations/049-summary-store.js';
import { MIGRATION as MIG_050 } from '../src/db/migrations/050-embedding-store.js';
import { MIGRATION as MIG_051 } from '../src/db/migrations/051-embedding-store-backfill.js';
import { MIGRATION as MIG_057 } from '../src/db/migrations/057-repair-strictify-drops.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): SqliteDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mig-low-coverage-'));
  dirs.push(dir);
  return createDatabase(path.join(dir, name)).db;
}

function nodeInsert(db: SqliteDatabase) {
  return db.prepare(
    `INSERT INTO nodes
      (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

function setupLegacySummarySchema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE nodes (id TEXT PRIMARY KEY);
    CREATE TABLE symbol_summaries (
      node_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      summary TEXT NOT NULL,
      model TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
  `);
}

function setupLegacyEmbeddingSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      body_hash TEXT
    );
    CREATE TABLE symbol_embeddings (
      node_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      embedding_model TEXT NOT NULL,
      source_content_hash TEXT,
      summary_hash_at_embed TEXT,
      grain TEXT,
      chunk_idx INTEGER
    );
  `);
}

function setupEmbeddingStoreSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, body_hash TEXT NOT NULL DEFAULT '');
    CREATE TABLE embedding_store (
      body_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      grain TEXT NOT NULL DEFAULT 'symbol',
      embedding BLOB NOT NULL,
      generated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (body_hash, model, grain)
    );
    CREATE TABLE embedding_refs (
      node_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      grain TEXT NOT NULL DEFAULT 'symbol',
      summary_hash_at_embed TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (node_id, model, grain)
    );
  `);
}

function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('low-coverage DB migration branches', () => {
  it('migration 001 delete triggers keep nodes_fts and dependent rows in sync', () => {
    const db = tempDb('migration-001-delete.db');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      MIG_001.up(db);

      nodeInsert(db).run(
        'source',
        'function',
        'sourceThing',
        'pkg.sourceThing',
        'src/a.ts',
        'typescript',
        1,
        2,
        1,
        1,
        1,
      );
      nodeInsert(db).run(
        'target',
        'function',
        'targetThing',
        'pkg.targetThing',
        'src/b.ts',
        'typescript',
        3,
        4,
        1,
        1,
        1,
      );
      db.prepare(`INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)`).run(
        'source',
        'target',
        'calls',
        1,
        1,
      );
      db.prepare(
        `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('source', 'missingThing', 'calls', 1, 1, '[]');

      expect(db.prepare(`SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'sourceThing'`).get()).toEqual({
        id: 'source',
      });

      db.prepare(`DELETE FROM nodes WHERE id = ?`).run('target');
      expect(countRows(db, 'edges')).toBe(0);

      db.prepare(`DELETE FROM nodes WHERE id = ?`).run('source');
      expect(countRows(db, 'unresolved_refs')).toBe(0);
      expect(db.prepare(`SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'sourceThing'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('migration 049 rebuilds summary FTS around the content-addressed store and keeps it fresh', () => {
    const db = tempDb('migration-049-fts.db');
    try {
      setupLegacySummarySchema(db);
      db.exec(`
        INSERT INTO nodes (id) VALUES ('n1'), ('n2');
        INSERT INTO symbol_summaries VALUES ('n1', 'body-a', 'alpha original summary', 'model-a', 10);
        CREATE VIRTUAL TABLE summary_fts USING fts5(
          summary,
          content='symbol_summaries',
          content_rowid='ROWID'
        );
      `);

      MIG_049.up(db);

      expect(db.prepare(`SELECT summary FROM summary_fts WHERE summary_fts MATCH 'alpha'`).get()).toEqual({
        summary: 'alpha original summary',
      });

      db.prepare(`UPDATE symbol_summaries SET content_hash = ?, summary = ?, generated_at = ? WHERE node_id = ?`).run(
        'body-a',
        'beta revised summary',
        20,
        'n1',
      );
      expect(db.prepare(`SELECT summary FROM summary_fts WHERE summary_fts MATCH 'beta'`).get()).toEqual({
        summary: 'beta revised summary',
      });
      expect(db.prepare(`SELECT summary FROM summary_fts WHERE summary_fts MATCH 'alpha'`).get()).toBeNull();

      db.prepare(`INSERT INTO symbol_summaries VALUES (?, ?, ?, ?, ?)`).run(
        'n2',
        'body-b',
        'gamma inserted summary',
        'model-a',
        30,
      );
      expect(db.prepare(`SELECT summary FROM summary_fts WHERE summary_fts MATCH 'gamma'`).get()).toEqual({
        summary: 'gamma inserted summary',
      });

      db.prepare(`DELETE FROM summary_store WHERE body_hash = ? AND model = ?`).run('body-b', 'model-a');
      expect(db.prepare(`SELECT summary FROM summary_fts WHERE summary_fts MATCH 'gamma'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('migration 049 also skips when nodes exists but the legacy summaries table is absent', () => {
    const db = tempDb('migration-049-no-summaries.db');
    try {
      db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY)`);
      expect(() => MIG_049.up(db)).not.toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'summary_store'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('migration 050 skips when the legacy embeddings table exists without nodes', () => {
    const db = tempDb('migration-050-no-nodes.db');
    try {
      db.exec(`
        CREATE TABLE symbol_embeddings (
          node_id TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          embedding_model TEXT NOT NULL
        );
      `);
      expect(() => MIG_050.up(db)).not.toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'embedding_store'`).get()).toBeNull();
      expect(db.prepare(`SELECT type FROM sqlite_master WHERE name = 'symbol_embeddings'`).get()).toEqual({
        type: 'table',
      });
    } finally {
      db.close();
    }
  });

  it('migration 050 tolerates a vec mirror table that cannot be cleared', () => {
    const db = tempDb('migration-050-vec-catch.db');
    try {
      setupLegacyEmbeddingSchema(db);
      db.exec(`
        INSERT INTO nodes VALUES ('n1', 'body-a');
        INSERT INTO symbol_embeddings
          (node_id, embedding, embedding_model, source_content_hash, summary_hash_at_embed, grain, chunk_idx)
        VALUES ('n1', x'0102', 'model-a', 'old-a', 'summary-a', 'symbol', 0);
        CREATE TABLE vec_symbol_embeddings_8 (rowid INTEGER PRIMARY KEY, embedding BLOB);
        INSERT INTO vec_symbol_embeddings_8 VALUES (1, x'0102');
        CREATE TRIGGER vec_symbol_embeddings_8_block_delete
        BEFORE DELETE ON vec_symbol_embeddings_8 BEGIN
          SELECT RAISE(FAIL, 'blocked vec delete');
        END;
      `);

      expect(() => MIG_050.up(db)).not.toThrow();
      expect(countRows(db, 'vec_symbol_embeddings_8')).toBe(1);
      expect(db.prepare(`SELECT body_hash FROM embedding_store`).get()).toEqual({ body_hash: 'body-a' });
    } finally {
      db.close();
    }
  });

  it('migration 051 tolerates vec cleanup failures while still rebinding synthetic keys', () => {
    const db = tempDb('migration-051-vec-catch.db');
    try {
      setupEmbeddingStoreSchema(db);
      db.exec(`
        INSERT INTO nodes VALUES ('n1', 'body-a');
        INSERT INTO embedding_store VALUES ('node:n1', 'model-a', 'symbol', x'0102', 10);
        INSERT INTO embedding_refs VALUES ('n1', 'node:n1', 'model-a', 'symbol', 'summary-a');
        CREATE TABLE vec_symbol_embeddings_9 (rowid INTEGER PRIMARY KEY, embedding BLOB);
        INSERT INTO vec_symbol_embeddings_9 VALUES (1, x'0102');
        CREATE TRIGGER vec_symbol_embeddings_9_block_delete
        BEFORE DELETE ON vec_symbol_embeddings_9 BEGIN
          SELECT RAISE(FAIL, 'blocked vec delete');
        END;
      `);

      expect(() => MIG_051.up(db)).not.toThrow();
      expect(countRows(db, 'vec_symbol_embeddings_9')).toBe(1);
      expect(db.prepare(`SELECT body_hash FROM embedding_store`).get()).toEqual({ body_hash: 'body-a' });
      expect(db.prepare(`SELECT body_hash FROM embedding_refs WHERE node_id = ?`).get('n1')).toEqual({
        body_hash: 'body-a',
      });
    } finally {
      db.close();
    }
  });

  it('migration 057 skips partial schemas without nodes', () => {
    const db = tempDb('migration-057-no-nodes.db');
    try {
      expect(() => MIG_057.up(db)).not.toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'role_assignments'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('migration 057 recreated bump triggers refresh summary and embedding store last_ref_at', () => {
    const db = tempDb('migration-057-triggers.db');
    try {
      db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY)`);
      MIG_057.up(db);

      db.exec(`
        INSERT INTO nodes VALUES ('n1');
        INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at)
          VALUES ('body-a', 'model-a', 'summary A', 1, 0),
                 ('body-b', 'model-a', 'summary B', 1, 0);
        INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at, last_ref_at)
          VALUES ('body-a', 'model-a', 'symbol', x'0102', 1, 0),
                 ('body-b', 'model-a', 'symbol', x'0304', 1, 0);
      `);

      db.prepare(`INSERT INTO summary_refs (node_id, body_hash, model) VALUES (?, ?, ?)`).run(
        'n1',
        'body-a',
        'model-a',
      );
      expect(
        (
          db.prepare(`SELECT last_ref_at FROM summary_store WHERE body_hash = 'body-a'`).get() as {
            last_ref_at: number;
          }
        ).last_ref_at,
      ).toBeGreaterThan(0);

      db.prepare(`UPDATE summary_refs SET body_hash = ? WHERE node_id = ?`).run('body-b', 'n1');
      expect(
        (
          db.prepare(`SELECT last_ref_at FROM summary_store WHERE body_hash = 'body-b'`).get() as {
            last_ref_at: number;
          }
        ).last_ref_at,
      ).toBeGreaterThan(0);

      db.prepare(
        `INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('n1', 'body-a', 'model-a', 'symbol', 'summary-a');
      expect(
        (
          db.prepare(`SELECT last_ref_at FROM embedding_store WHERE body_hash = 'body-a'`).get() as {
            last_ref_at: number;
          }
        ).last_ref_at,
      ).toBeGreaterThan(0);

      db.prepare(`UPDATE embedding_refs SET body_hash = ? WHERE node_id = ? AND model = ? AND grain = ?`).run(
        'body-b',
        'n1',
        'model-a',
        'symbol',
      );
      expect(
        (
          db.prepare(`SELECT last_ref_at FROM embedding_store WHERE body_hash = 'body-b'`).get() as {
            last_ref_at: number;
          }
        ).last_ref_at,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
