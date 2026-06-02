/**
 * sqlite-vec integration tests.
 *
 * Covers:
 *   - Extension loads on the native backend (when sqlite-vec is
 *     installed, which is true on this dev machine).
 *   - vec0 virtual table is bootstrapped on first DB open with
 *     existing embeddings.
 *   - upsertSymbolEmbedding mirrors the row into the dim-matching
 *     vec0 table.
 *   - findSimilarViaVec returns equivalent top-K nodeIds vs the
 *     in-memory `topKByCosine` fallback (within ordering tolerance).
 *   - Connection without vec extension still works (falls through to
 *     cache path).
 *
 * No real LLM calls — synthetic deterministic embeddings written
 * directly into symbol_embeddings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder, clearAll } from '../src/db/queries.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import {
  bootstrapVecTables,
  compactVecTables,
  ensureVecTable,
  findSimilarViaVec,
  mirrorEmbeddingToVec,
  vecTableNameForDim,
} from '../src/db/vec-helpers.js';
import { vectorToBytes } from '../src/llm/embeddings.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

const DIM = 8; // Small enough for fast tests, large enough that ordering is meaningful.

function unitVec(seed: number): Float32Array {
  // Deterministic L2-normalised vector seeded by `seed`. Spreads
  // values across the dim so different seeds produce different
  // directions in the unit sphere.
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.sin(seed * 7 + i * 13);
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i]! /= norm;
  return v;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vec-'));
}

function setup() {
  const dir = tempDir();
  // Init creates an empty DB at the right path with full schema.
  // Using DatabaseConnection directly — we don't need full Cartograph
  // for the helpers tests.
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const queries = new QueryBuilder(conn.getDb(), conn.hasVecExtension());
  return { dir, conn, queries, db: conn.getDb() };
}

function cleanup(dir: string, conn: DatabaseConnection): void {
  conn.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedNodesAndSummaries(db: ReturnType<DatabaseConnection['getDb']>, ids: string[]): void {
  // Since migration 033, symbol_embeddings.node_id → nodes.id directly.
  // Plant minimal rows in the nodes table — no summary needed for
  // embedding to succeed.
  // Migration 056 added FK nodes.file_path → files(path), so seed the
  // file row first so the node insert isn't rejected.
  db.prepare(
    `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES (?, 'h', 'typescript', 0, 0, 0)`,
  ).run('/tmp/x.ts');
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                        start_line, end_line, start_column, end_column, updated_at)
     VALUES (?, 'function', ?, ?, '/tmp/x.ts', 'typescript', 1, 1, 0, 0, 0)`,
  );
  for (const id of ids) {
    insertNode.run(id, id, id);
  }
}

describe('sqlite-vec extension', () => {
  it('hasVecExtension returns a boolean — true when sqlite-vec installed, false otherwise', () => {
    const { dir, conn } = setup();
    try {
      // Soft contract: never throw, always return a boolean. The
      // value depends on whether the optional `sqlite-vec` dep is
      // installed for this platform — true on dev machines that npm-
      // installed it, false on CI environments / contributor machines
      // where the optional install was skipped. Both states are
      // expected and supported.
      // Post-bun-migration (2026-05-20), `bun-sqlite` is the only
      // backend; the prior `native` (better-sqlite3) / `node-sqlite`
      // backends were dropped in the all-in-Bun consolidation.
      expect(conn.getBackend()).toBe('bun-sqlite');
      expect(typeof conn.hasVecExtension()).toBe('boolean');
    } finally {
      cleanup(dir, conn);
    }
  });
});

describe('vec-helpers — bootstrap + mirror + KNN', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;
  let db: ReturnType<DatabaseConnection['getDb']>;

  beforeEach(() => {
    const s = setup();
    dir = s.dir;
    conn = s.conn;
    queries = s.queries;
    db = s.db;
    // Skip if vec didn't load — we still want the suite green elsewhere.
    // sqlite-vec is an optional dep — skip the suite (don't fail) on
    // contributor / CI machines where its platform binary isn't
    // installed. The fallback in-memory path is exercised by the
    // existing similarity tests elsewhere.
    if (!conn.hasVecExtension()) {
      cleanup(dir, conn);
      // eslint-disable-next-line no-console
      console.warn('[sqlite-vec.test] extension not loaded — skipping vec-specific tests');
      return;
    }
    // Seed nodes (FK chain: embeddings -> nodes directly since migration 033).
    seedNodesAndSummaries(db, ['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  afterEach(() => {
    cleanup(dir, conn);
  });

  it('bootstrapVecTables creates a vec0 table for each dim with embeddings', () => {
    // Plant embeddings BEFORE any vec0 table exists (simulates a
    // pre-extension DB being opened by an extension-enabled session).
    const model = 'fake-model';
    db.prepare(
      // Design C: source_content_hash becomes the body_hash key in
      // embedding_store. Use a unique synthetic value per nodeId so
      // dedup doesn't collapse the rows.
      `INSERT INTO symbol_embeddings (node_id, embedding, embedding_model, source_content_hash)
       VALUES (?, ?, ?, ?)`,
    ).run('n1', vectorToBytes(unitVec(1)), model, 'h-n1');
    db.prepare(
      // Design C: source_content_hash becomes the body_hash key in
      // embedding_store. Use a unique synthetic value per nodeId so
      // dedup doesn't collapse the rows.
      `INSERT INTO symbol_embeddings (node_id, embedding, embedding_model, source_content_hash)
       VALUES (?, ?, ?, ?)`,
    ).run('n2', vectorToBytes(unitVec(2)), model, 'h-n2');

    bootstrapVecTables(db, true);

    // Table created and back-filled.
    const name = vecTableNameForDim(DIM);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('bootstrapVecTables is idempotent on repeated runs', () => {
    const model = 'fake-model';
    db.prepare(
      // Design C: source_content_hash becomes the body_hash key in
      // embedding_store. Use a unique synthetic value per nodeId so
      // dedup doesn't collapse the rows.
      `INSERT INTO symbol_embeddings (node_id, embedding, embedding_model, source_content_hash)
       VALUES (?, ?, ?, ?)`,
    ).run('n1', vectorToBytes(unitVec(1)), model, 'h-n1');
    bootstrapVecTables(db, true);
    bootstrapVecTables(db, true);
    bootstrapVecTables(db, true);
    const name = vecTableNameForDim(DIM);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('upsertSymbolEmbedding mirrors into the dim-matching vec0 table', () => {
    upsertSymbolEmbedding({
      qb: queries,
      nodeId: 'n1',
      embedding: vectorToBytes(unitVec(1)),
      model: 'fake-model',
      summaryHashAtEmbed: '',
    });
    upsertSymbolEmbedding({
      qb: queries,
      nodeId: 'n2',
      embedding: vectorToBytes(unitVec(2)),
      model: 'fake-model',
      summaryHashAtEmbed: '',
    });
    const name = vecTableNameForDim(DIM);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('findSimilarViaVec returns nearest neighbours by cosine distance', () => {
    const model = 'fake-model';
    for (let i = 1; i <= 5; i++) {
      upsertSymbolEmbedding({
        qb: queries,
        nodeId: `n${i}`,
        embedding: vectorToBytes(unitVec(i)),
        model,
        summaryHashAtEmbed: '',
      });
    }
    const queryVec = unitVec(3); // Should match n3 best (distance == 0).
    const hits = findSimilarViaVec({ db, vecLoaded: true, queryVec, model, k: 3 });
    expect(hits.length).toBe(3);
    expect(hits[0]!.nodeId).toBe('n3');
    expect(hits[0]!.distance).toBeCloseTo(0, 5);
    // Subsequent hits must have non-decreasing distance.
    expect(hits[1]!.distance).toBeGreaterThanOrEqual(hits[0]!.distance);
    expect(hits[2]!.distance).toBeGreaterThanOrEqual(hits[1]!.distance);
  });

  it('findSimilarViaVec post-filters by model so cross-model rows do not pollute', () => {
    upsertSymbolEmbedding({
      qb: queries,
      nodeId: 'n1',
      embedding: vectorToBytes(unitVec(1)),
      model: 'model-A',
      summaryHashAtEmbed: '',
    });
    upsertSymbolEmbedding({
      qb: queries,
      nodeId: 'n2',
      embedding: vectorToBytes(unitVec(1)),
      model: 'model-B',
      summaryHashAtEmbed: '',
    }); // same vec, different model
    upsertSymbolEmbedding({
      qb: queries,
      nodeId: 'n3',
      embedding: vectorToBytes(unitVec(2)),
      model: 'model-A',
      summaryHashAtEmbed: '',
    });
    const queryVec = unitVec(1);
    const hitsA = findSimilarViaVec({ db, vecLoaded: true, queryVec, model: 'model-A', k: 5 });
    const hitsB = findSimilarViaVec({ db, vecLoaded: true, queryVec, model: 'model-B', k: 5 });
    expect(hitsA.map((h) => h.nodeId).sort(byString)).toEqual(['n1', 'n3']);
    expect(hitsB.map((h) => h.nodeId)).toEqual(['n2']);
  });

  it('findSimilarViaVec returns [] when no embeddings exist for the dim yet', () => {
    // Vec0 table doesn't exist for DIM yet — no calls to upsert.
    const hits = findSimilarViaVec({ db, vecLoaded: true, queryVec: unitVec(1), model: 'any-model', k: 5 });
    expect(hits).toEqual([]);
  });

  it('mirrorEmbeddingToVec is a no-op when vecLoaded=false', () => {
    // Pretend the extension isn't there. The mirror call must not throw
    // and must not create a vec0 table.
    mirrorEmbeddingToVec(db, false, 1n, vectorToBytes(unitVec(1)), DIM);
    const name = vecTableNameForDim(DIM);
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    // bun:sqlite returns null for no rows; better-sqlite3 returned
    // undefined. Assert nullish, since the semantic is "row absent".
    expect(exists).toBeFalsy();
  });

  it('clear() sweeps vec0 rowids — no ghost rows after re-index', () => {
    const model = 'fake-model';
    for (let i = 1; i <= 5; i++) {
      upsertSymbolEmbedding({
        qb: queries,
        nodeId: `n${i}`,
        embedding: vectorToBytes(unitVec(i)),
        model,
        summaryHashAtEmbed: '',
      });
    }
    const name = vecTableNameForDim(DIM);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(5);

    clearAll(queries);
    // Source table is empty — vec0 must be too, no ghost rowids that
    // would later eat findSimilarViaVec's over-fetch budget on
    // re-index.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(0);
  });

  it('compactVecTables rebuilds vec0 from embedding_store after a bulk delete — rowid fidelity preserved', () => {
    const model = 'fake-model';
    for (let i = 1; i <= 5; i++) {
      upsertSymbolEmbedding({
        qb: queries,
        nodeId: `n${i}`,
        embedding: vectorToBytes(unitVec(i)),
        model,
        summaryHashAtEmbed: '',
      });
    }
    const name = vecTableNameForDim(DIM);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(5);

    // Snapshot the rowid → embedding mapping for the rows we'll keep,
    // so we can prove the rebuild carries rowids verbatim (the
    // embedding_refs → embedding_store.rowid → vec0.rowid join chain).
    const keptRowids = (
      db.prepare(`SELECT rowid AS r FROM embedding_store ORDER BY rowid LIMIT 3`).all() as Array<{ r: number }>
    ).map((row) => row.r);

    // Simulate a bulk eviction: delete 2 of the 5 embedding_store rows
    // directly (the canonical source vec0 mirrors).
    const dropRowids = (
      db.prepare(`SELECT rowid AS r FROM embedding_store ORDER BY rowid LIMIT -1 OFFSET 3`).all() as Array<{
        r: number;
      }>
    ).map((row) => row.r);
    for (const r of dropRowids) {
      db.prepare(`DELETE FROM embedding_store WHERE rowid = ?`).run(r);
    }
    // Vec0 still holds all 5 rows — DELETE FROM embedding_store does not
    // cascade (vec0 has no FK). compactVecTables must reconcile it.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(5);

    compactVecTables(db, true);

    // vec0 now matches the pruned embedding_store: 3 live rows.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(3);
    // The 3 surviving rows carry their ORIGINAL rowids — the rebuild
    // did not renumber them, so every embedding_refs pointer still
    // resolves.
    const survivingRowids = (
      db.prepare(`SELECT rowid AS r FROM ${name} ORDER BY rowid`).all() as Array<{ r: number | bigint }>
    ).map((row) => Number(row.r));
    expect(survivingRowids).toEqual(keptRowids);
    // The evicted rowids are gone from vec0.
    for (const r of dropRowids) {
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name} WHERE rowid = ?`).get(BigInt(r)) as { c: number }).c).toBe(
        0,
      );
    }
    // KNN still works against the compacted table — query the kept n1.
    const hits = findSimilarViaVec({ db, vecLoaded: true, queryVec: unitVec(1), model, k: 1 });
    expect(hits[0]!.nodeId).toBe('n1');
  });

  it('compactVecTables is a no-op when vecLoaded=false (no throw)', () => {
    expect(() => compactVecTables(db, false)).not.toThrow();
  });

  it('ensureVecTable rejects invalid dims silently (no throw, no table)', () => {
    ensureVecTable(db, 0);
    ensureVecTable(db, -1);
    ensureVecTable(db, Number.NaN);
    ensureVecTable(db, 99999);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_symbol_embeddings_%'`)
      .all();
    expect(tables).toEqual([]);
  });
});

describe('vec path equivalence — same top-K nodes as the in-memory scan', () => {
  // This bypasses the LLM-config resolver and asserts the contract
  // directly: given identical embeddings in symbol_embeddings,
  // findSimilarViaVec and topKByCosine return the same nodeId set
  // (order may differ within distance-ties, but the set must match).
  let dir: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;
  let db: ReturnType<DatabaseConnection['getDb']>;

  beforeEach(() => {
    const s = setup();
    dir = s.dir;
    conn = s.conn;
    queries = s.queries;
    db = s.db;
    // sqlite-vec is an optional dep — skip the suite (don't fail) on
    // contributor / CI machines where its platform binary isn't
    // installed. The fallback in-memory path is exercised by the
    // existing similarity tests elsewhere.
    if (!conn.hasVecExtension()) {
      cleanup(dir, conn);
      // eslint-disable-next-line no-console
      console.warn('[sqlite-vec.test] extension not loaded — skipping vec-specific tests');
      return;
    }
    // Seed nodes (FK chain: embeddings -> nodes directly since migration 033).
    seedNodesAndSummaries(db, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  afterEach(() => cleanup(dir, conn));

  it('vec KNN nodeId set matches in-memory brute-force top-K', async () => {
    const model = 'fake-model';
    const vectors: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 1; i <= 6; i++) {
      const id = `n${i}`;
      const vec = unitVec(i);
      vectors.push({ id, vec });
      upsertSymbolEmbedding({ qb: queries, nodeId: id, embedding: vectorToBytes(vec), model, summaryHashAtEmbed: '' });
    }

    const queryVec = unitVec(3);
    const k = 3;

    // Vec path
    const vecHits = findSimilarViaVec({ db, vecLoaded: true, queryVec, model, k });

    // In-memory brute-force baseline
    const { topKByCosine } = await import('../src/llm/embeddings.js');
    const inMem = topKByCosine(
      queryVec,
      vectors.map((v) => ({ nodeId: v.id, embedding: vectorToBytes(v.vec) })),
      k,
    );

    // Same set (order can differ on distance ties).
    expect(new Set(vecHits.map((h) => h.nodeId))).toEqual(new Set(inMem.map((h) => h.nodeId)));
  });
});
