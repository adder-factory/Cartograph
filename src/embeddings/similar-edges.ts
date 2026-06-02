/**
 * Build similar_to edges from embedding similarity. For each node with
 * an embedding, query for its k nearest neighbors (excluding self) and
 * write edges when similarity exceeds the threshold.
 *
 * Idempotent: runs deleteAllSimilarToEdges first.
 *
 * KNN backend: HNSW (hnswlib-node) when available, with brute-force
 * vec0 as the fallback. HNSW is built once per buildSimilarToEdges
 * call (one index per embedding dim) instead of per-row vec0 scans —
 * extrapolated 312k symbols drops from ~30 min to ~3-5 min.
 */

import path from 'node:path';

import type { Cartograph } from '../index.js';
import { findSimilarViaVec } from '../db/vec-helpers.js';
import { deleteAllSimilarToEdges, insertSimilarToEdges } from '../db/queries-similarity.js';
import { HnswIndex, type HnswEmbeddingRow } from './hnsw-index.js';
import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from './similarity-defaults.js';
export { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from './similarity-defaults.js';

// DEFAULT_SIMILAR_K / DEFAULT_SIMILAR_MIN_SCORE live in the dependency-
// free `similarity-defaults` module so the CLI / MCP can read them at
// command-definition time without loading this HNSW-heavy module.

const FLOAT32_BYTES = 4;

export interface BuildSimilarToEdgesOpts {
  k?: number;
  minScore?: number;
}

export interface BuildSimilarToEdgesResult {
  written: number;
  processed: number;
  reason?: string;
}

type EmbeddingRow = HnswEmbeddingRow;
type SimilarEdge = { source: string; target: string; score: number };

/**
 * Fetch all symbol embeddings that have a non-null embedding vector.
 */
function fetchEmbeddingRows(db: ReturnType<Cartograph['db']['getDb']>): EmbeddingRow[] {
  // Design C (migration 050): vec0/HNSW key off embedding_store.rowid;
  // attribute each store row to an arbitrary ref (rename/copy share a
  // store row — any node attribution is valid).
  return db
    .prepare(
      `SELECT s.rowid AS rowid,
              (SELECT r.node_id FROM embedding_refs r
                WHERE r.body_hash = s.body_hash
                  AND r.model = s.model
                  AND r.grain = s.grain
                LIMIT 1) AS node_id,
              s.embedding AS embedding,
              s.model AS embedding_model
         FROM embedding_store s
        WHERE s.embedding IS NOT NULL
          AND s.grain = 'symbol'`,
    )
    .all()
    .filter((r): r is EmbeddingRow => (r as { node_id: string | null }).node_id !== null) as EmbeddingRow[];
}

interface ComputeEdgesForRowArgs {
  db: ReturnType<Cartograph['db']['getDb']>;
  row: EmbeddingRow;
  k: number;
  minScore: number;
  hnswByDim: Map<number, HnswIndex>;
  /** node_id → unit-normalised embedding vector, for exact cosine rescoring. */
  unitByNode: Map<string, Float32Array>;
}

/**
 * Float32 view over an embedding BLOB. Zero-copy when aligned.
 */
function viewVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / FLOAT32_BYTES);
}

/**
 * Return an L2-normalised copy of `v`. A zero vector is returned
 * unchanged (its norm is 0 — any later dot product is 0).
 */
function unitVector(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (const value of v) sumSq += value * value;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/**
 * Dot product of two unit vectors == cosine similarity. Vectors are
 * expected to be equal-length (all embeddings share one model's
 * dimensionality); a mismatch is defensively truncated to the shorter
 * length rather than throwing — heterogeneous-dim pairs cannot occur
 * with a single embedding model but the guard keeps a corrupt row from
 * crashing the whole edge-build pass.
 */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Compute similar-to edges for a single embedding row by querying its
 * k nearest neighbors, filtering out self-matches and below-threshold pairs.
 *
 * Uses the prebuilt HNSW index for the row's dim when present; falls
 * back to per-row vec0 scan otherwise.
 *
 * The KNN backend distance is used ONLY for candidate retrieval/order.
 * The persisted `score` is recomputed as an exact cosine similarity
 * (`dot` of L2-normalised vectors) so it is always in [-1, 1]
 * regardless of whether the embedding model emits normalised vectors.
 * The HNSW `'ip'` space returns `1 - rawDot`, which is *not* cosine
 * when the stored vectors aren't unit-length — recomputing here keeps
 * writer, reader, and the documented 0..1 `--min-score` scale aligned.
 */
function computeEdgesForRow({ db, row, k, minScore, hnswByDim, unitByNode }: ComputeEdgesForRowArgs): SimilarEdge[] {
  const dim = row.embedding.length / FLOAT32_BYTES;
  const queryVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dim);

  const hnsw = hnswByDim.get(dim);
  const hits = hnsw
    ? hnsw.query(queryVec, k + 1, row.embedding_model)
    : findSimilarViaVec({
        db,
        vecLoaded: true,
        queryVec,
        model: row.embedding_model,
        k: k + 1, // +1 to account for self-match
      });

  const srcUnit = unitByNode.get(row.node_id);
  const edges: SimilarEdge[] = [];
  for (const hit of hits) {
    if (hit.nodeId === row.node_id) continue;
    const tgtUnit = unitByNode.get(hit.nodeId);
    // Exact cosine when both vectors are available; otherwise fall
    // back to the backend's `1 - distance` (correct for vec0's cosine
    // metric, approximate for HNSW 'ip' on un-normalised vectors).
    const similarity = srcUnit && tgtUnit ? dot(srcUnit, tgtUnit) : 1 - hit.distance;
    if (similarity < minScore) continue;
    edges.push({ source: row.node_id, target: hit.nodeId, score: similarity });
  }
  return edges;
}

/**
 * Build per-dim HNSW indexes once before the per-row query loop and
 * persist each to `.cartograph/hnsw_<dim>.bin` for reuse by query-time
 * semantic search. Returns an empty map when the optional dep is
 * missing — callers fall back to vec0 transparently.
 */
async function buildHnswByDim(rows: EmbeddingRow[], cg: Cartograph): Promise<Map<number, HnswIndex>> {
  const byDim = new Map<number, EmbeddingRow[]>();
  for (const row of rows) {
    const d = row.embedding.length / FLOAT32_BYTES;
    let bucket = byDim.get(d);
    if (!bucket) {
      bucket = [];
      byDim.set(d, bucket);
    }
    bucket.push(row);
  }
  const out = new Map<number, HnswIndex>();
  for (const [dim, rs] of byDim) {
    const idx = await HnswIndex.create(dim);
    if (!idx) continue;
    const built = await idx.build(rs);
    if (!built.built) continue;
    try {
      idx.persist(path.join(cg.projectRoot, '.cartograph', `hnsw_${dim}.bin`));
    } catch {
      // Disk error on persist is non-fatal: query path still works
      // off the in-memory index built above. The next sync's postHook
      // trigger will retry persistence.
    }
    out.set(dim, idx);
  }
  return out;
}

/**
 * Atomically replace all similar_to edges in the database with the
 * newly-computed edge set.
 */
function writeSimilarEdgesAtomically(
  db: ReturnType<Cartograph['db']['getDb']>,
  queries: Cartograph['queries'],
  edges: SimilarEdge[],
): void {
  db.transaction(() => {
    deleteAllSimilarToEdges(queries);
    insertSimilarToEdges(queries, edges);
  })();
}

/**
 * Build similar_to edges over the embedding space. For each symbol
 * with an embedding:
 *   1. Build one HNSW index per embedding dim (or fall back to vec0)
 *   2. Query for its k+1 nearest neighbors (k+1 to account for self-match)
 *   3. Filter out self and below-threshold matches
 *   4. Write edges with similarity score in metadata
 *
 * Returns idempotency-safe result counts. If vec extension is not loaded,
 * returns {written: 0, processed: 0} silently (no error).
 */
export async function buildSimilarToEdges(
  cg: Cartograph,
  opts?: BuildSimilarToEdgesOpts,
): Promise<BuildSimilarToEdgesResult> {
  const k = opts?.k ?? DEFAULT_SIMILAR_K;
  const minScore = opts?.minScore ?? DEFAULT_SIMILAR_MIN_SCORE;

  const dbConn = cg.db;
  const db = dbConn.getDb();
  const queries = cg.queries;

  if (!dbConn.hasVecExtension()) {
    return { written: 0, processed: 0, reason: 'vec extension not loaded' };
  }

  const rows = fetchEmbeddingRows(db);
  const hnswByDim = await buildHnswByDim(rows, cg);

  // Precompute one L2-normalised vector per node so edge scores are an
  // exact cosine similarity, independent of the KNN backend's distance
  // metric (HNSW 'ip' space yields `1 - rawDot`, not cosine, when the
  // model's embeddings aren't unit-length — which is the case here).
  const unitByNode = new Map<string, Float32Array>();
  for (const row of rows) {
    if (!unitByNode.has(row.node_id)) {
      unitByNode.set(row.node_id, unitVector(viewVec(row.embedding)));
    }
  }

  const edges: SimilarEdge[] = [];
  for (const row of rows) {
    edges.push(...computeEdgesForRow({ db, row, k, minScore, hnswByDim, unitByNode }));
  }

  writeSimilarEdgesAtomically(db, queries, edges);
  return { written: edges.length, processed: rows.length };
}
