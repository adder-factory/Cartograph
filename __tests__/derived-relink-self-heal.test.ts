/**
 * Derived-data self-heal: re-linking summary_refs / embedding_refs from the
 * content-addressed stores after a re-extract cascade-deletes them, and the
 * bounded similar_to repair. See src/index-hooks/derived-relink.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getSymbolSummary } from '../src/db/queries-summaries.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { relinkDerivedRefsFromStore } from '../src/db/relink-refs.js';
import { repairSimilarToForNodes } from '../src/embeddings/similar-edges.js';
import { HOOK as DERIVED_RELINK_HOOK } from '../src/index-hooks/derived-relink.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';
import type { SyncResult } from '../src/extraction/index.js';
import type { CartographConfig } from '../src/types.js';
import type { Node } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(): { dbConn: DatabaseConnection; qb: QueryBuilder; db: ReturnType<DatabaseConnection['getDb']> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relink-'));
  dirs.push(dir);
  const dbConn = DatabaseConnection.initialize(path.join(dir, 'cartograph.db'));
  const db = dbConn.getDb();
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES ('src/a.ts', '', 'typescript', 0, 0, 0)`,
  ).run();
  // vecLoaded must be passed through so upsertSymbolEmbedding mirrors to vec0.
  return { dbConn, qb: new QueryBuilder(db, dbConn.hasVecExtension()), db };
}

function makeNode(id: string, bodyHash: string): Node {
  return {
    id,
    name: id,
    qualifiedName: id,
    kind: 'function',
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    bodyHash,
  } as Node;
}

function f32(values: number[]): Buffer {
  const arr = Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

describe('relinkDerivedRefsFromStore — summaries', () => {
  it('re-pins a summary from summary_store after the ref was cascade-evicted', () => {
    const { dbConn, qb, db } = open();
    try {
      qb.insertNode(makeNode('fn:1', 'bh1'));
      // Cached summary survives in the store; the per-node ref does not.
      db.prepare(
        `INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES ('bh1','m','sum A',5)`,
      ).run();
      expect(getSymbolSummary(qb, 'fn:1')).toBeNull();

      expect(relinkDerivedRefsFromStore(qb).summaries).toBe(1);
      expect(getSymbolSummary(qb, 'fn:1')?.summary).toBe('sum A');
    } finally {
      dbConn.close();
    }
  });

  it('picks the most-recently-generated summary on multiple models, and skips bodies absent from the store', () => {
    const { dbConn, qb, db } = open();
    try {
      qb.insertNode(makeNode('fn:1', 'bh1'));
      qb.insertNode(makeNode('fn:2', 'bh-absent'));
      db.prepare(
        `INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES ('bh1','old','stale',1)`,
      ).run();
      db.prepare(
        `INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES ('bh1','new','fresh',9)`,
      ).run();

      relinkDerivedRefsFromStore(qb);
      const got = getSymbolSummary(qb, 'fn:1');
      expect(got?.summary).toBe('fresh');
      expect(got?.model).toBe('new');
      // No store row for fn:2's body → no ref invented.
      expect(getSymbolSummary(qb, 'fn:2')).toBeNull();
    } finally {
      dbConn.close();
    }
  });

  it('scopes to the given nodeIds and no-ops on an empty set', () => {
    const { dbConn, qb, db } = open();
    try {
      qb.insertNode(makeNode('fn:1', 'bh1'));
      qb.insertNode(makeNode('fn:2', 'bh1'));
      db.prepare(`INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES ('bh1','m','s',1)`).run();

      expect(relinkDerivedRefsFromStore(qb, ['fn:1']).summaries).toBe(1);
      expect(getSymbolSummary(qb, 'fn:1')?.summary).toBe('s');
      expect(getSymbolSummary(qb, 'fn:2')).toBeNull();
      expect(relinkDerivedRefsFromStore(qb, [])).toEqual({ summaries: 0, embeddings: 0 });
    } finally {
      dbConn.close();
    }
  });
});

describe('relinkDerivedRefsFromStore — embeddings', () => {
  it('re-pins an embedding ref from embedding_store after eviction (vec vector survives)', () => {
    const { dbConn, qb, db } = open();
    try {
      qb.insertNode(makeNode('fn:1', 'bh1'));
      db.prepare(
        `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
         VALUES ('bh1','m','symbol',?,1)`,
      ).run(f32([1, 0, 0, 0]));
      expect((db.prepare('SELECT COUNT(*) AS n FROM embedding_refs').get() as { n: number }).n).toBe(0);

      expect(relinkDerivedRefsFromStore(qb, ['fn:1']).embeddings).toBe(1);
      const ref = db.prepare(`SELECT node_id, body_hash, grain FROM embedding_refs WHERE node_id='fn:1'`).get();
      expect(ref).toMatchObject({ node_id: 'fn:1', body_hash: 'bh1', grain: 'symbol' });
    } finally {
      dbConn.close();
    }
  });
});

describe('repairSimilarToForNodes', () => {
  it('no-ops without sqlite-vec or with an empty node set', () => {
    const { dbConn, qb } = open();
    try {
      expect(repairSimilarToForNodes({ db: dbConn.getDb(), queries: qb, vecLoaded: false, nodeIds: ['x'] })).toBe(0);
      expect(
        repairSimilarToForNodes({ db: dbConn.getDb(), queries: qb, vecLoaded: dbConn.hasVecExtension(), nodeIds: [] }),
      ).toBe(0);
    } finally {
      dbConn.close();
    }
  });

  it('rebuilds a re-extracted node’s outgoing similar_to edges from the surviving vec0 index', () => {
    const { dbConn, qb, db } = open();
    try {
      if (!dbConn.hasVecExtension()) return; // sqlite-vec not available in this build
      qb.insertNode(makeNode('fn:1', 'bh1'));
      qb.insertNode(makeNode('fn:2', 'bh2'));
      // Near-identical vectors → high cosine; writes store + ref + vec0 mirror.
      upsertSymbolEmbedding({ qb, nodeId: 'fn:1', embedding: f32([1, 0, 0, 0]), model: 'm', summaryHashAtEmbed: '' });
      upsertSymbolEmbedding({
        qb,
        nodeId: 'fn:2',
        embedding: f32([0.99, 0.01, 0, 0]),
        model: 'm',
        summaryHashAtEmbed: '',
      });

      const wrote = repairSimilarToForNodes({
        db,
        queries: qb,
        vecLoaded: true,
        nodeIds: ['fn:1'],
        k: 5,
        minScore: 0.5,
      });
      expect(wrote).toBeGreaterThanOrEqual(1);
      const edge = db.prepare(`SELECT target FROM edges WHERE kind='similar_to' AND source='fn:1'`).get() as
        | { target: string }
        | undefined;
      expect(edge?.target).toBe('fn:2');

      // Simulate a re-extract of fn:1: its outgoing edge cascades away, but the
      // vec0 vector (keyed by store rowid) survives. Re-link + repair restore it.
      db.prepare(`DELETE FROM edges WHERE source='fn:1'`).run();
      relinkDerivedRefsFromStore(qb, ['fn:1']);
      const rewrote = repairSimilarToForNodes({ db, queries: qb, vecLoaded: true, nodeIds: ['fn:1'], minScore: 0.5 });
      expect(rewrote).toBeGreaterThanOrEqual(1);
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind='similar_to' AND source='fn:1'`).get() as { n: number })
          .n,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      dbConn.close();
    }
  });
});

describe('derived-relink HOOK.afterSync (wiring)', () => {
  it('re-links refs and repairs similar_to for the changed files, and no-ops a clean sync', async () => {
    const { dbConn, qb, db } = open();
    try {
      if (!dbConn.hasVecExtension()) return;
      // Two embedded symbols in the same file; a cached summary for fn:1.
      qb.insertNode(makeNode('fn:1', 'bh1'));
      qb.insertNode(makeNode('fn:2', 'bh2'));
      upsertSymbolEmbedding({ qb, nodeId: 'fn:1', embedding: f32([1, 0, 0, 0]), model: 'm', summaryHashAtEmbed: '' });
      upsertSymbolEmbedding({
        qb,
        nodeId: 'fn:2',
        embedding: f32([0.99, 0.01, 0, 0]),
        model: 'm',
        summaryHashAtEmbed: '',
      });
      db.prepare(
        `INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES ('bh1','m','does a thing',5)`,
      ).run();
      // Seed similar_to both ways so the feature is "in use" and survives the fn:1 wipe.
      repairSimilarToForNodes({ db, queries: qb, vecLoaded: true, nodeIds: ['fn:1', 'fn:2'], minScore: 0.5 });

      // Simulate a whole-file re-extract that cascade-evicted fn:1's derived data.
      db.prepare("DELETE FROM embedding_refs WHERE node_id='fn:1'").run();
      db.prepare("DELETE FROM summary_refs WHERE node_id='fn:1'").run();
      db.prepare("DELETE FROM edges WHERE kind='similar_to' AND source='fn:1'").run();
      expect(getSymbolSummary(qb, 'fn:1')).toBeNull();

      // Drive the hook end-to-end (config/projectRoot are unused by afterSync).
      const ctx: IndexHookContext = { projectRoot: '/unused', config: {} as CartographConfig, queries: qb, db: dbConn };
      const result: SyncResult = {
        filesChecked: 1,
        filesAdded: 0,
        filesModified: 1,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
        changedFilePaths: ['src/a.ts'],
      };
      await DERIVED_RELINK_HOOK.afterSync!(ctx, result);

      // Summary + embedding refs re-linked from the stores; similar_to repaired.
      expect(getSymbolSummary(qb, 'fn:1')?.summary).toBe('does a thing');
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM embedding_refs WHERE node_id='fn:1'").get() as { n: number }).n,
      ).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind='similar_to' AND source='fn:1'").get() as { n: number })
          .n,
      ).toBeGreaterThanOrEqual(1);

      // A clean sync (no changedFilePaths) is a no-op.
      const before = (db.prepare('SELECT COUNT(*) AS n FROM summary_refs').get() as { n: number }).n;
      await DERIVED_RELINK_HOOK.afterSync!(ctx, { ...result, changedFilePaths: [] });
      expect((db.prepare('SELECT COUNT(*) AS n FROM summary_refs').get() as { n: number }).n).toBe(before);
    } finally {
      dbConn.close();
    }
  });
});
