import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_050 } from '../src/db/migrations/050-embedding-store.js';

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-050-')), 'test.db');
}

function buffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
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

    CREATE TABLE vec_symbol_embeddings_2 (
      rowid INTEGER PRIMARY KEY,
      embedding BLOB
    );

    CREATE TABLE vec_symbol_embeddings_bad (
      rowid INTEGER PRIMARY KEY,
      embedding BLOB
    );
  `);
}

describe('Migration 050 — content-addressed embedding store', () => {
  let dbPath: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dbPath = tempDb();
    db = createDatabase(dbPath).db;
    setupLegacyEmbeddingSchema(db);
  });

  afterEach(() => {
    db.close();
    const dir = path.dirname(dbPath);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates legacy symbol embeddings into deduplicated store rows, refs, and a writable compatibility view', () => {
    const shared = buffer([1, 0]);
    const unique = buffer([0, 1]);

    db.prepare(`INSERT INTO nodes (id, body_hash) VALUES (?, ?), (?, ?), (?, ?)`).run(
      'node:a',
      'hash:shared',
      'node:b',
      'hash:shared',
      'node:c',
      '',
    );
    db.prepare(
      `INSERT INTO symbol_embeddings
        (node_id, embedding, embedding_model, source_content_hash, summary_hash_at_embed, grain, chunk_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('node:a', shared, 'model-a', 'old-a', 'summary-a', 'symbol', 0);
    db.prepare(
      `INSERT INTO symbol_embeddings
        (node_id, embedding, embedding_model, source_content_hash, summary_hash_at_embed, grain, chunk_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('node:b', shared, 'model-a', 'old-b', 'summary-b', 'symbol', 0);
    db.prepare(
      `INSERT INTO symbol_embeddings
        (node_id, embedding, embedding_model, source_content_hash, summary_hash_at_embed, grain, chunk_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('node:c', unique, 'model-a', 'old-c', null, null, 0);
    db.prepare(`INSERT INTO vec_symbol_embeddings_2 (rowid, embedding) VALUES (1, ?), (2, ?)`).run(shared, unique);
    db.prepare(`INSERT INTO vec_symbol_embeddings_bad (rowid, embedding) VALUES (1, ?)`).run(shared);

    MIG_050.up(db);

    const symbolEntity = db.prepare(`SELECT type FROM sqlite_master WHERE name = 'symbol_embeddings'`).get() as {
      type: string;
    };
    expect(symbolEntity.type).toBe('view');

    const stores = db
      .prepare(`SELECT body_hash AS bodyHash, model, grain FROM embedding_store ORDER BY body_hash`)
      .all() as Array<{ bodyHash: string; model: string; grain: string }>;
    expect(stores).toEqual([
      { bodyHash: 'hash:shared', model: 'model-a', grain: 'symbol' },
      { bodyHash: 'node:node:c', model: 'model-a', grain: 'symbol' },
    ]);

    const refs = db
      .prepare(
        `SELECT node_id AS nodeId, body_hash AS bodyHash, model, grain, summary_hash_at_embed AS summaryHash
           FROM embedding_refs
          ORDER BY node_id`,
      )
      .all() as Array<{ nodeId: string; bodyHash: string; model: string; grain: string; summaryHash: string }>;
    expect(refs).toEqual([
      { nodeId: 'node:a', bodyHash: 'hash:shared', model: 'model-a', grain: 'symbol', summaryHash: 'summary-a' },
      { nodeId: 'node:b', bodyHash: 'hash:shared', model: 'model-a', grain: 'symbol', summaryHash: 'summary-b' },
      { nodeId: 'node:c', bodyHash: 'node:node:c', model: 'model-a', grain: 'symbol', summaryHash: '' },
    ]);

    const viewRows = db
      .prepare(
        `SELECT node_id AS nodeId, source_content_hash AS bodyHash, grain FROM symbol_embeddings ORDER BY node_id`,
      )
      .all() as Array<{ nodeId: string; bodyHash: string; grain: string }>;
    expect(viewRows).toEqual([
      { nodeId: 'node:a', bodyHash: 'hash:shared', grain: 'symbol' },
      { nodeId: 'node:b', bodyHash: 'hash:shared', grain: 'symbol' },
      { nodeId: 'node:c', bodyHash: 'node:node:c', grain: 'symbol' },
    ]);

    const clearedVecRows = db.prepare(`SELECT COUNT(*) AS n FROM vec_symbol_embeddings_2`).get() as { n: number };
    const untouchedInvalidVecRows = db.prepare(`SELECT COUNT(*) AS n FROM vec_symbol_embeddings_bad`).get() as {
      n: number;
    };
    expect(clearedVecRows.n).toBe(0);
    expect(untouchedInvalidVecRows.n).toBe(1);

    db.prepare(
      `INSERT INTO symbol_embeddings
        (node_id, embedding, embedding_model, source_content_hash, summary_hash_at_embed, grain, chunk_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('node:a', buffer([0.5, 0.5]), 'model-a', 'hash:new', 'summary-new', 'symbol', 0);
    expect(
      db
        .prepare(
          `SELECT body_hash AS bodyHash, summary_hash_at_embed AS summaryHash FROM embedding_refs WHERE node_id = ?`,
        )
        .get('node:a'),
    ).toEqual({ bodyHash: 'hash:new', summaryHash: 'summary-new' });

    db.prepare(`UPDATE symbol_embeddings SET source_content_hash = ?, summary_hash_at_embed = ? WHERE node_id = ?`).run(
      'hash:updated',
      'summary-updated',
      'node:a',
    );
    expect(
      db
        .prepare(
          `SELECT body_hash AS bodyHash, summary_hash_at_embed AS summaryHash FROM embedding_refs WHERE node_id = ?`,
        )
        .get('node:a'),
    ).toEqual({ bodyHash: 'hash:updated', summaryHash: 'summary-updated' });

    db.prepare(`DELETE FROM symbol_embeddings WHERE node_id = ?`).run('node:a');
    expect(db.prepare(`SELECT 1 FROM embedding_refs WHERE node_id = ?`).get('node:a')).toBeNull();
  });

  it('no-ops when the legacy embedding table or nodes table is absent', () => {
    const emptyDbPath = tempDb();
    const emptyDb = createDatabase(emptyDbPath).db;
    try {
      expect(() => MIG_050.up(emptyDb)).not.toThrow();
      expect(emptyDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'embedding_store'`).get()).toBeNull();
    } finally {
      emptyDb.close();
      const dir = path.dirname(emptyDbPath);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
