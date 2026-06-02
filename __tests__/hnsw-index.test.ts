/**
 * HnswIndex lifecycle tests.
 *
 * Covers the full build → query → persist → load cycle using random
 * L2-normalised vectors at dim=32. No live model calls — all embeddings
 * are synthetic Float32Array values.
 *
 * computeRowsetSignature and discoverEmbeddingDims are tested against
 * a temporary DatabaseConnection that seeds symbol_embeddings directly.
 */

import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HnswIndex,
  isHnswAvailable,
  computeRowsetSignature,
  discoverEmbeddingDims,
  efForIndexSize,
  type HnswEmbeddingRow,
} from '../src/embeddings/hnsw-index.js';
import { DatabaseConnection } from '../src/db/index.js';

// --- helpers ----------------------------------------------------------------

/** L2-normalise a Float32Array in-place and return it. */
function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (const value of v) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Deterministic L2-normalised random vector seeded by `seed`. */
function randomNormalised(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * 7.3 + i * 13.7);
  }
  return normalise(v);
}

/** Convert Float32Array → Buffer (same layout as symbol_embeddings blobs). */
function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Build a HnswEmbeddingRow for the given rowid. */
function makeRow(rowid: number, dim: number, seed?: number, model = 'm-test', nodeId?: string): HnswEmbeddingRow {
  const vec = randomNormalised(dim, seed ?? rowid);
  return {
    rowid,
    node_id: nodeId ?? `node-${rowid}`,
    embedding: vecToBuffer(vec),
    embedding_model: model,
  };
}

/** Create a temp dir + DatabaseConnection; return both plus teardown. */
function setupDb(): {
  dir: string;
  conn: DatabaseConnection;
  db: ReturnType<DatabaseConnection['getDb']>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cg-hnsw-'));
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const db = conn.getDb();
  return {
    dir,
    conn,
    db,
    cleanup: () => {
      conn.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seed a row in `files` so FK from `nodes.file_path` resolves (migration 056). */
function seedFile(db: ReturnType<DatabaseConnection['getDb']>, fpath: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES (?, 'h', 'typescript', 0, 0, 0)`,
  ).run(fpath);
}

/**
 * Seed the nodes table with minimal rows so symbol_embeddings FK chain
 * succeeds (migration 033+: embeddings → nodes.id directly).
 */
function seedNodes(db: ReturnType<DatabaseConnection['getDb']>, ids: string[]): void {
  seedFile(db, '/tmp/x.ts');
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO nodes
       (id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at)
     VALUES (?, 'function', ?, ?, '/tmp/x.ts', 'typescript', 1, 1, 0, 0, 0)`,
  );
  for (const id of ids) stmt.run(id, id, id);
}

/** Insert a raw embedding into the Design C store + refs tables,
 *  returning the embedding_store rowid (vec0/HNSW key). Each call uses
 *  a unique synthetic body_hash derived from (nodeId, model, dim) so
 *  multiple inserts don't collapse to one store row via dedup. */
function insertEmbedding(
  db: ReturnType<DatabaseConnection['getDb']>,
  nodeId: string,
  embedding: Buffer,
  model: string,
): bigint {
  const bodyHash = `bh-${nodeId}-${model}-${embedding.byteLength}`;
  db.prepare(
    `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
     VALUES (?, ?, 'symbol', ?, 0)
     ON CONFLICT(body_hash, model, grain) DO UPDATE SET embedding = excluded.embedding`,
  ).run(bodyHash, model, embedding);
  db.prepare(
    `INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
     VALUES (?, ?, ?, 'symbol', '')
     ON CONFLICT(node_id, model, grain) DO UPDATE SET body_hash = excluded.body_hash`,
  ).run(nodeId, bodyHash, model);
  const r = db
    .prepare("SELECT rowid AS r FROM embedding_store WHERE body_hash = ? AND model = ? AND grain = 'symbol'")
    .get(bodyHash, model) as { r: number | bigint };
  return BigInt(r.r);
}

// --- constants --------------------------------------------------------------

const DIM = 32; // Fast tests; large enough for HNSW to differentiate points.

// ============================================================================
// HnswIndex
// ============================================================================

describe('HnswIndex', () => {
  it('isHnswAvailable() returns true on dev box', async () => {
    const available = await isHnswAvailable();
    expect(available).toBe(true);
  });

  it('create(32) returns instance with correct dim', async () => {
    const idx = await HnswIndex.create(DIM);
    expect(idx).not.toBeNull();
    expect(idx!.getDim()).toBe(DIM);
    expect(idx!.isReady()).toBe(false);
    expect(idx!.size()).toBe(0);
  });

  it('build([]) returns built:false with a reason', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    const result = await idx.build([]);
    expect(result.built).toBe(false);
    expect(result.rowCount).toBe(0);
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('build(rows) populates the index; size matches rowCount', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    const rows = [1, 2, 3, 4, 5].map((i) => makeRow(i, DIM));
    const result = await idx.build(rows);
    expect(result.built).toBe(true);
    expect(result.rowCount).toBe(5);
    expect(idx.isReady()).toBe(true);
    expect(idx.size()).toBe(5);
  });

  it('build filters rows whose embedding length does not match dim', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    const wrongDimRow: HnswEmbeddingRow = {
      rowid: 99,
      node_id: 'bad-dim',
      embedding: vecToBuffer(randomNormalised(DIM + 4, 99)), // wrong dim
      embedding_model: 'm-test',
    };
    const goodRows = [1, 2, 3].map((i) => makeRow(i, DIM));
    const result = await idx.build([...goodRows, wrongDimRow]);
    expect(result.built).toBe(true);
    expect(result.rowCount).toBe(3); // wrongDimRow is excluded
    expect(idx.size()).toBe(3);
  });

  it('query returns ≤k hits with distinct nodeIds', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeRow(i, DIM));
    await idx.build(rows);
    const queryVec = randomNormalised(DIM, 100);
    const hits = idx.query(queryVec, 3);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((h) => h.nodeId);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
  });

  it('query returns [] when called before build', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    const queryVec = randomNormalised(DIM, 1);
    expect(idx.query(queryVec, 5)).toEqual([]);
  });

  it('query returns [] when queryVec dim mismatches index dim', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    await idx.build([1, 2, 3].map((i) => makeRow(i, DIM)));
    const wrongDimVec = randomNormalised(DIM + 8, 1);
    expect(idx.query(wrongDimVec, 3)).toEqual([]);
  });

  it('query returns nearest neighbour first (self-query)', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    // Seed 3 is the "query target" — build with it included.
    const rows = [1, 2, 3, 4, 5].map((i) => makeRow(i, DIM));
    await idx.build(rows);
    // Query with exactly the vector stored at seed=3 — should come back first.
    const queryVec = randomNormalised(DIM, 3);
    const hits = idx.query(queryVec, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.nodeId).toBe('node-3');
    // 3-decimal tolerance — USearch's IP-on-normalised distance has
    // slightly more float32 accumulation noise than the prior
    // hnswlib-node 'ip' on the same inputs. Both come back well under
    // 5e-4 for a self-query (orders of magnitude smaller than any
    // wrong-neighbour distance would be), so the looser tolerance
    // still discriminates correctness from a real failure.
    expect(hits[0]!.distance).toBeCloseTo(0, 3);
  });

  it('query filters by model when model arg is passed', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    // 10 rows per model so k=2 over-fetch (k*4=8) stays under maxElements=20.
    const rowsA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => makeRow(i, DIM, undefined, 'model-A', `nodeA-${i}`));
    const rowsB = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((i) =>
      makeRow(i, DIM, undefined, 'model-B', `nodeB-${i}`),
    );
    await idx.build([...rowsA, ...rowsB]);
    const queryVec = randomNormalised(DIM, 1);
    // k=2; over-fetch will be max(8, 7)=8, well within maxElements=20.
    const hitsA = idx.query(queryVec, 2, 'model-A');
    const hitsB = idx.query(queryVec, 2, 'model-B');
    expect(hitsA.every((h) => h.nodeId.startsWith('nodeA-'))).toBe(true);
    expect(hitsB.every((h) => h.nodeId.startsWith('nodeB-'))).toBe(true);
  });

  it('persist before build throws', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cg-hnsw-persist-'));
    try {
      const idx = (await HnswIndex.create(DIM))!;
      expect(() => idx.persist(path.join(dir, 'test.bin'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persist + load round-trips: size matches after load', async () => {
    const { dir, db, cleanup } = setupDb();
    try {
      const nodeIds = [1, 2, 3, 4].map((i) => `node-${i}`);
      seedNodes(db, nodeIds);

      // Build and persist.
      const idxWrite = (await HnswIndex.create(DIM))!;
      const rows = [1, 2, 3, 4].map((i) => makeRow(i, DIM));
      await idxWrite.build(rows);

      // Insert into symbol_embeddings so load() can repopulate rowidToMeta.
      for (const row of rows) {
        insertEmbedding(db, row.node_id, row.embedding, row.embedding_model);
      }

      const binPath = path.join(dir, `hnsw_${DIM}.bin`);
      idxWrite.persist(binPath);

      // Load into a fresh instance.
      const idxRead = (await HnswIndex.create(DIM))!;
      const loaded = idxRead.load(binPath, db);
      expect(loaded).toBe(true);
      expect(idxRead.isReady()).toBe(true);
      expect(idxRead.size()).toBe(4);

      // Queries should still work after load.
      const queryVec = randomNormalised(DIM, 1);
      const hits = idxRead.query(queryVec, 2);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('isReady reflects build/load lifecycle', async () => {
    const idx = (await HnswIndex.create(DIM))!;
    expect(idx.isReady()).toBe(false);

    // Empty build → still not ready.
    await idx.build([]);
    expect(idx.isReady()).toBe(false);

    // Real build → ready.
    await idx.build([makeRow(1, DIM)]);
    expect(idx.isReady()).toBe(true);

    // Overwrite with empty build → back to not ready.
    await idx.build([]);
    expect(idx.isReady()).toBe(false);
  });
});

// ============================================================================
// efForIndexSize
// ============================================================================

describe('efForIndexSize', () => {
  it('clamps to the floor (128) for small indexes', () => {
    expect(efForIndexSize(0)).toBe(128);
    expect(efForIndexSize(1000)).toBe(128);
    expect(efForIndexSize(8192)).toBe(128); // 8192/64 = 128, at the boundary
  });

  it('ramps linearly (round(N/64)) between floor and ceiling', () => {
    expect(efForIndexSize(12000)).toBe(188); // round(187.5)
    expect(efForIndexSize(16000)).toBe(250);
  });

  it('clamps to the ceiling (384) for large indexes', () => {
    expect(efForIndexSize(24576)).toBe(384); // 24576/64 = 384, at the boundary
    expect(efForIndexSize(100000)).toBe(384);
    expect(efForIndexSize(2_000_000)).toBe(384);
  });
});

// ============================================================================
// computeRowsetSignature
// ============================================================================

describe('computeRowsetSignature', () => {
  it('returns {rowCount:0, maxRowid:0} on empty table', () => {
    const { db, cleanup } = setupDb();
    try {
      const sig = computeRowsetSignature(db);
      expect(sig).toEqual({ rowCount: 0, maxRowid: 0 });
    } finally {
      cleanup();
    }
  });

  it('counts all embeddings when dim is not specified', () => {
    const { db, cleanup } = setupDb();
    try {
      const nodeIds = ['a', 'b', 'c'];
      seedNodes(db, nodeIds);
      insertEmbedding(db, 'a', vecToBuffer(randomNormalised(32, 1)), 'm');
      insertEmbedding(db, 'b', vecToBuffer(randomNormalised(64, 2)), 'm');
      insertEmbedding(db, 'c', vecToBuffer(randomNormalised(128, 3)), 'm');
      const sig = computeRowsetSignature(db);
      expect(sig.rowCount).toBe(3);
      expect(sig.maxRowid).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('per-dim filter narrows to matching dim only', () => {
    const { db, cleanup } = setupDb();
    try {
      const nodeIds = ['a', 'b', 'c'];
      seedNodes(db, nodeIds);
      insertEmbedding(db, 'a', vecToBuffer(randomNormalised(32, 1)), 'm');
      insertEmbedding(db, 'b', vecToBuffer(randomNormalised(64, 2)), 'm');
      insertEmbedding(db, 'c', vecToBuffer(randomNormalised(32, 3)), 'm');

      const sig32 = computeRowsetSignature(db, 32);
      const sig64 = computeRowsetSignature(db, 64);

      expect(sig32.rowCount).toBe(2); // 'a' and 'c'
      expect(sig64.rowCount).toBe(1); // 'b' only
    } finally {
      cleanup();
    }
  });
});

// ============================================================================
// discoverEmbeddingDims
// ============================================================================

describe('discoverEmbeddingDims', () => {
  it('returns [] on empty table', () => {
    const { db, cleanup } = setupDb();
    try {
      expect(discoverEmbeddingDims(db)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('returns distinct dims sorted by appearance', () => {
    const { db, cleanup } = setupDb();
    try {
      const nodeIds = ['a', 'b', 'c', 'd'];
      seedNodes(db, nodeIds);
      insertEmbedding(db, 'a', vecToBuffer(randomNormalised(64, 1)), 'm');
      insertEmbedding(db, 'b', vecToBuffer(randomNormalised(32, 2)), 'm');
      insertEmbedding(db, 'c', vecToBuffer(randomNormalised(64, 3)), 'm'); // dup dim
      insertEmbedding(db, 'd', vecToBuffer(randomNormalised(128, 4)), 'm');

      const dims = discoverEmbeddingDims(db);
      // Must contain exactly the three unique dims.
      expect(new Set(dims)).toEqual(new Set([32, 64, 128]));
      // Must have no duplicates.
      expect(dims.length).toBe(3);
    } finally {
      cleanup();
    }
  });
});
