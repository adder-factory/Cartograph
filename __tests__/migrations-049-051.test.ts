import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_049 } from '../src/db/migrations/049-summary-store.js';
import { MIGRATION as MIG_051 } from '../src/db/migrations/051-embedding-store-backfill.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): SqliteDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mig-049-051-'));
  dirs.push(dir);
  return createDatabase(path.join(dir, name)).db;
}

describe('migration 049 summary store', () => {
  it('moves legacy symbol_summaries into content-addressed tables and keeps the compatibility view writable', () => {
    const db = tempDb('summary.db');
    try {
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
        INSERT INTO nodes (id) VALUES ('n1'), ('n2'), ('n3');
        INSERT INTO symbol_summaries VALUES
          ('n1', 'body-a', 'summary A', 'm', 10),
          ('n2', 'body-a', 'summary A duplicate body', 'm', 20);
      `);

      MIG_049.up(db);

      const store = db.prepare(`SELECT body_hash, model, summary FROM summary_store ORDER BY body_hash`).all() as Array<{
        body_hash: string;
        model: string;
        summary: string;
      }>;
      expect(store).toEqual([{ body_hash: 'body-a', model: 'm', summary: 'summary A' }]);

      const refs = db.prepare(`SELECT node_id, content_hash, summary FROM symbol_summaries ORDER BY node_id`).all();
      expect(refs).toEqual([
        { node_id: 'n1', content_hash: 'body-a', summary: 'summary A' },
        { node_id: 'n2', content_hash: 'body-a', summary: 'summary A' },
      ]);

      db.prepare(`INSERT INTO symbol_summaries VALUES (?, ?, ?, ?, ?)`).run('n3', 'body-c', 'summary C', 'm', 30);
      expect(
        (db.prepare(`SELECT summary FROM summary_store WHERE body_hash='body-c'`).get() as { summary: string })
          .summary,
      ).toBe('summary C');

      db.prepare(`UPDATE symbol_summaries SET content_hash=?, summary=? WHERE node_id=?`).run(
        'body-d',
        'summary D',
        'n3',
      );
      expect(
        (db.prepare(`SELECT body_hash FROM summary_refs WHERE node_id='n3'`).get() as { body_hash: string })
          .body_hash,
      ).toBe('body-d');

      db.prepare(`DELETE FROM symbol_summaries WHERE node_id=?`).run('n3');
      expect(db.prepare(`SELECT 1 FROM summary_refs WHERE node_id='n3'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is a no-op when the legacy summaries or nodes table is absent', () => {
    const db = tempDb('summary-noop.db');
    try {
      expect(() => MIG_049.up(db)).not.toThrow();
      db.exec(`CREATE TABLE symbol_summaries (node_id TEXT PRIMARY KEY, content_hash TEXT, summary TEXT, model TEXT, generated_at INTEGER)`);
      expect(() => MIG_049.up(db)).not.toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='summary_store'`).get()).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('migration 051 embedding store backfill', () => {
  it('rewrites synthetic node body hashes, resolves collisions, and leaves unknown body hashes untouched', () => {
    const db = tempDb('embedding.db');
    try {
      db.exec(`
        PRAGMA foreign_keys = OFF;
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
        CREATE TABLE vec_symbol_embeddings_4 (rowid INTEGER PRIMARY KEY);

        INSERT INTO nodes VALUES
          ('n1', 'real-a'),
          ('n2', 'real-b'),
          ('n3', 'real-b'),
          ('n4', '');
        INSERT INTO embedding_store VALUES
          ('real-a', 'm', 'symbol', x'01', 1),
          ('node:n1', 'm', 'symbol', x'02', 2),
          ('node:n2', 'm', 'symbol', x'03', 3),
          ('node:n3', 'm', 'symbol', x'04', 4),
          ('node:n4', 'm', 'symbol', x'05', 5);
        INSERT INTO embedding_refs VALUES
          ('n1', 'node:n1', 'm', 'symbol', ''),
          ('n2', 'node:n2', 'm', 'symbol', ''),
          ('n3', 'node:n3', 'm', 'symbol', ''),
          ('n4', 'node:n4', 'm', 'symbol', '');
        INSERT INTO vec_symbol_embeddings_4 VALUES (1), (2);
      `);

      MIG_051.up(db);

      const storeKeys = (
        db.prepare(`SELECT body_hash FROM embedding_store ORDER BY body_hash`).all() as Array<{ body_hash: string }>
      ).map((row) => row.body_hash);
      expect(storeKeys).toEqual(['node:n4', 'real-a', 'real-b']);

      const refs = db.prepare(`SELECT node_id, body_hash FROM embedding_refs ORDER BY node_id`).all();
      expect(refs).toEqual([
        { node_id: 'n1', body_hash: 'real-a' },
        { node_id: 'n2', body_hash: 'real-b' },
        { node_id: 'n3', body_hash: 'real-b' },
        { node_id: 'n4', body_hash: 'node:n4' },
      ]);

      expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_symbol_embeddings_4`).get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is a no-op when the content-addressed embedding tables are absent', () => {
    const db = tempDb('embedding-noop.db');
    try {
      expect(() => MIG_051.up(db)).not.toThrow();
      db.exec(`CREATE TABLE embedding_store (body_hash TEXT, model TEXT, grain TEXT)`);
      expect(() => MIG_051.up(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
