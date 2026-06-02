/**
 * HNSW approximate KNN over `symbol_embeddings`.
 *
 * Drop-in shape for `db/vec-helpers.ts.findSimilarViaVec` so callers
 * can swap with one branch. Wraps `usearch` (optional dep, NAPI-RS
 * native addon); silently unavailable when the module isn't installed.
 *
 * USearch swap (2026-05-20): replaces `hnswlib-node`. Same HNSW algo
 * with strictly better ergonomics — 9× faster parallel build, ~2×
 * faster query, half the on-disk footprint at F16 quantization,
 * `view()` mmap-without-RAM persistence, and parallel `add(..., 0)`
 * threads ships out of the box (drops the patched hnswlib-node fork
 * we maintained just for the same parallel-insert behavior).
 *
 * IMPORTANT metric convention: we use `MetricKind.IP` (inner product),
 * NOT `MetricKind.Cos`, because jina-v2-base-code (and the rest of
 * our supported embedding models) emit pre-normalised vectors —
 * inner product on L2-normalised inputs equals cosine similarity.
 * USearch's `Cos` re-normalises internally, which on
 * already-normalised input collapses recall by ≈10 percentage points
 * (measured on real cartograph embeddings,
 * `bench/usearch-recall-compare.mts`). The IP-on-normalised
 * convention matches the prior hnswlib-node integration and the
 * vec0 mirror tables, so `similarity = 1 - distance` arithmetic
 * stays unchanged.
 *
 * Quantization: F16 by default. The 768d jina embeddings tolerate
 * F16 without measurable recall loss (the recall ceiling is the M=16
 * graph, not the scalar precision). Override via the
 * `CARTOGRAPH_USEARCH_QUANT` env var: `f32` | `f16` | `i8` | `b1`.
 *
 * One index per embedding dimension, mirroring vec0's per-dim table
 * layout. Persisted to `.cartograph/hnsw_<dim>.bin` (file extension
 * kept for back-compat with rebuild-checks; USearch's `.usearch`
 * format is opaque-blob and content-detected on load).
 *
 * Recall: measured on cartograph's own jina-v2-base-code symbol
 * embeddings (`bench/hnsw-ef-recall-sweep.mts`). recall@10 at a fixed
 * `expansion_search` degrades as the index grows — so query-time
 * `expansion_search` is scaled to the index size (see
 * `efForIndexSize`), holding recall@10 ≈0.94+ from small repos up to
 * ≈24k vectors. `connectivity` (M) and `expansion_add` are fixed at
 * the same values used by the prior hnswlib path so recall sweeps
 * remain comparable.
 *
 * USearch uses BigInt keys; we convert at the boundary (rowid ↔
 * BigInt) so the caller's number-typed `rowid` plumbing is unchanged.
 */

import type { Buffer } from 'node:buffer';

import type { SqliteDatabase } from '../db/sqlite-adapter.js';

/** Float32 = 4 bytes per element. */
const FLOAT32_BYTES = 4;

/** HNSW build parameters — favouring quality over build speed.
 *  connectivity=16 is the USearch default and matches the hnswlib M=16
 *  we used previously; expansion_add=200 yields the same recall
 *  ceiling on the embedding distributions we see. */
const HNSW_CONNECTIVITY = 16;
const HNSW_EXPANSION_ADD = 200;
/** Query-time expansion_search — the dominant recall knob. */
const HNSW_EF_QUERY_MIN = 128;
const HNSW_EF_QUERY_MAX = 384;

/** Query-time `ef` for an index holding `size` vectors.
 *  @internal exported for unit tests. */
export function efForIndexSize(size: number): number {
  return Math.min(HNSW_EF_QUERY_MAX, Math.max(HNSW_EF_QUERY_MIN, Math.round(size / 64)));
}

/** USearch quantization knob — F16 default (free 2× win at no measurable
 *  recall cost on jina embeddings). Override via env var. */
function resolveQuantization(usearch: USearchNs): string {
  const want = (process.env['CARTOGRAPH_USEARCH_QUANT'] ?? 'f16').toLowerCase();
  switch (want) {
    case 'f32':
      return usearch.ScalarKind.F32;
    case 'f16':
      return usearch.ScalarKind.F16;
    case 'i8':
      return usearch.ScalarKind.I8;
    case 'b1':
      return usearch.ScalarKind.B1;
    case 'bf16':
      return usearch.ScalarKind.BF16;
    default:
      return usearch.ScalarKind.F16;
  }
}

// ─── USearch module surface (typed minimally — keeps the file
//     self-contained even when usearch's types aren't loaded yet) ─────────
interface UMatches {
  keys: BigUint64Array;
  distances: Float32Array;
}
interface UIndex {
  add(keys: bigint | bigint[] | BigUint64Array, vectors: Float32Array, threads?: number): void;
  search(vec: Float32Array, k: number, threads?: number): UMatches;
  save(path: string): void;
  load(path: string): void;
  view(path: string): void;
  size(): number;
  dimensions(): number;
}
interface UIndexCtorArgs {
  dimensions: number;
  metric: string;
  quantization: string;
  connectivity: number;
  expansion_add: number;
  expansion_search: number;
  multi: boolean;
}
type UIndexCtor = new (args: UIndexCtorArgs) => UIndex;
interface UMetricKindNs {
  Cos: string;
  IP: string;
  L2sq: string;
  [k: string]: string;
}
interface UScalarKindNs {
  F32: string;
  F16: string;
  BF16: string;
  I8: string;
  B1: string;
  [k: string]: string;
}
interface USearchNs {
  Index: UIndexCtor;
  MetricKind: UMetricKindNs;
  ScalarKind: UScalarKindNs;
}

/** Module-level cache for the usearch import. The native binding is
 *  heavy (~3MB); share one require across all instances. */
let mod: USearchNs | null | undefined;

/** Runtime type-guard: the imported namespace exposes Index +
 *  MetricKind + ScalarKind at the top level (native-ESM shape). */
function hasUSearchExports(ns: { Index?: unknown; MetricKind?: unknown; ScalarKind?: unknown }): ns is USearchNs {
  return ns.Index != null && ns.MetricKind != null && ns.ScalarKind != null;
}

async function loadUsearchModule(): Promise<USearchNs | null> {
  if (mod !== undefined) return mod;
  try {
    const imported = await import('usearch');
    // usearch ships as a hybrid package; under native ESM `await
    // import()` wraps named exports on the namespace, but the `Index`
    // class can live under `.default` depending on the loader (same
    // hazard the prior hnswlib-node load handled). Probe both shapes.
    // The forced-cast pattern is structurally required here — the TS
    // module declaration's signature differs from the actual runtime
    // shape we need to probe.
    const ns = imported as unknown as {
      Index?: unknown;
      MetricKind?: unknown;
      ScalarKind?: unknown;
      default?: USearchNs;
    };
    if (hasUSearchExports(ns)) {
      mod = ns as unknown as USearchNs;
    } else if (ns.default?.Index) {
      mod = ns.default;
    } else {
      mod = null;
    }
  } catch {
    mod = null;
  }
  return mod;
}

/** True when the optional dep is importable. Cheap after first call
 *  thanks to the module cache. */
export async function isHnswAvailable(): Promise<boolean> {
  return (await loadUsearchModule()) !== null;
}

/** Subset of `symbol_embeddings` rows the index needs. */
export interface HnswEmbeddingRow {
  rowid: number;
  node_id: string;
  embedding: Buffer;
  embedding_model: string;
}

/** Result of a build pass. */
export interface HnswBuildResult {
  built: boolean;
  rowCount: number;
  /** When `built=false`, why we didn't build. */
  reason?: string;
}

/** A KNN hit. Mirrors `vec-helpers.VecHit` so callers swap. */
export interface HnswHit {
  nodeId: string;
  /** Cosine distance ≈ 1 - similarity. */
  distance: number;
}

/**
 * HNSW index for one embedding dimension. USearch-backed since
 * 2026-05-20; previously hnswlib-node.
 *
 * Lifecycle:
 *   1. `await HnswIndex.create(dim)` → instance or null when dep missing
 *   2. `await index.build(rows)` OR `index.load(path, db)` to populate
 *   3. `index.query(vec, k, model?)` for KNN lookups
 *   4. `index.persist(path)` to save the build for later loads
 */
export class HnswIndex {
  private nsw: UIndex | null = null;
  /** rowid → (node_id, model). Repopulated on every build/load. */
  private rowidToMeta = new Map<number, { nodeId: string; model: string }>();
  private readonly dim: number;
  private readonly ns: USearchNs;
  private readonly quant: string;

  private constructor(ns: USearchNs, dim: number) {
    this.ns = ns;
    this.dim = dim;
    this.quant = resolveQuantization(ns);
  }

  /** Returns null when the optional dep is missing. */
  static async create(dim: number): Promise<HnswIndex | null> {
    const m = await loadUsearchModule();
    if (!m) return null;
    return new HnswIndex(m, dim);
  }

  /**
   * Build the index over `rows`. Filters out rows whose embedding
   * length doesn't match `this.dim`. Subsequent calls overwrite —
   * the previous index is dropped.
   *
   * USearch's `add(..., threads=0)` parallelises across all cores
   * out of the box — no patched fork needed for the parallel-insert
   * fast path the prior hnswlib-node integration depended on.
   */
  async build(rows: HnswEmbeddingRow[]): Promise<HnswBuildResult> {
    const filtered = rows.filter((r) => r.embedding.length === this.dim * FLOAT32_BYTES);
    if (filtered.length === 0) {
      this.nsw = null;
      this.rowidToMeta.clear();
      return { built: false, rowCount: 0, reason: 'no embeddings at this dim' };
    }
    const { Index, MetricKind } = this.ns;
    const expansionSearch = efForIndexSize(filtered.length);
    const nsw = new Index({
      dimensions: this.dim,
      metric: MetricKind.IP,
      quantization: this.quant,
      connectivity: HNSW_CONNECTIVITY,
      expansion_add: HNSW_EXPANSION_ADD,
      expansion_search: expansionSearch,
      multi: false,
    });

    // Pack all vectors into one flat Float32Array — USearch's add()
    // accepts an n*d matrix in row-major layout and inserts the batch
    // in parallel.
    const newMeta = new Map<number, { nodeId: string; model: string }>();
    const keys = new BigUint64Array(filtered.length);
    const flat = new Float32Array(filtered.length * this.dim);
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i]!;
      const view = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.length / FLOAT32_BYTES,
      );
      flat.set(view, i * this.dim);
      keys[i] = BigInt(row.rowid);
      newMeta.set(row.rowid, {
        nodeId: row.node_id,
        model: row.embedding_model,
      });
    }
    nsw.add(keys, flat, 0); // 0 = auto threads
    this.nsw = nsw;
    this.rowidToMeta = newMeta;
    return { built: true, rowCount: filtered.length };
  }

  /**
   * Top-K KNN. `model` is an optional post-filter so multiple
   * embedding models can coexist in `symbol_embeddings` (matches the
   * vec-helpers convention).
   *
   * Over-fetches by 4× when a model filter is active so the post-
   * filter doesn't drop us below `k` — same heuristic as vec-helpers
   * and chosen to tolerate up to 75% wrong-model rows.
   */
  query(queryVec: Float32Array, k: number, model?: string): HnswHit[] {
    if (!this.nsw) return [];
    if (queryVec.length !== this.dim) return [];
    const indexSize = this.rowidToMeta.size;
    if (indexSize === 0) return [];
    const desired = model ? Math.max(k * 4, k + 5) : k;
    const fetch = Math.min(desired, indexSize);
    const r = this.nsw.search(queryVec, fetch, 0);
    const out: HnswHit[] = [];
    for (let i = 0; i < r.keys.length && out.length < k; i++) {
      const rowid = Number(r.keys[i]);
      const meta = this.rowidToMeta.get(rowid);
      if (!meta) continue;
      if (model && meta.model !== model) continue;
      out.push({ nodeId: meta.nodeId, distance: r.distances[i] as number });
    }
    return out;
  }

  /** Persist the underlying graph + vectors to disk. */
  persist(path: string): void {
    if (!this.nsw) throw new Error('HnswIndex.persist called before build/load');
    this.nsw.save(path);
  }

  /**
   * Load from disk. The on-disk file holds only the graph + vectors,
   * so we repopulate `rowidToMeta` from `embedding_store`. The caller
   * is responsible for confirming the index is up-to-date (see
   * hnsw-meta-checks: row count + max rowid signature).
   *
   * Returns false on disk error or if the index is empty after load —
   * caller falls back to a fresh build.
   */
  load(path: string, db: SqliteDatabase): boolean {
    const { Index, MetricKind } = this.ns;
    const nsw = new Index({
      dimensions: this.dim,
      metric: MetricKind.IP,
      quantization: this.quant,
      connectivity: HNSW_CONNECTIVITY,
      expansion_add: HNSW_EXPANSION_ADD,
      expansion_search: HNSW_EF_QUERY_MIN,
      multi: false,
    });
    try {
      nsw.load(path);
    } catch {
      this.nsw = null;
      return false;
    }
    const newMeta = new Map<number, { nodeId: string; model: string }>();
    const rows = db
      .prepare(
        `SELECT s.rowid AS rowid,
                (SELECT r.node_id FROM embedding_refs r
                  WHERE r.body_hash = s.body_hash
                    AND r.model = s.model
                    AND r.grain = s.grain
                  LIMIT 1) AS node_id,
                s.model AS embedding_model
           FROM embedding_store s
          WHERE s.embedding IS NOT NULL
            AND s.grain = 'symbol'`,
      )
      .all() as Array<{ rowid: number; node_id: string | null; embedding_model: string }>;
    for (const r of rows) {
      if (r.node_id === null) continue;
      newMeta.set(r.rowid, { nodeId: r.node_id, model: r.embedding_model });
    }
    this.nsw = nsw;
    this.rowidToMeta = newMeta;
    return this.rowidToMeta.size > 0;
  }

  /** True after a successful build or load. */
  isReady(): boolean {
    return this.nsw !== null;
  }

  /** Number of embeddings in the current index. */
  size(): number {
    return this.rowidToMeta.size;
  }

  /** The dimensionality of this index. */
  getDim(): number {
    return this.dim;
  }
}

/**
 * Compute a cheap signature for the current embedding rowset.
 * Used to detect "rebuild needed" without a full diff: if N or
 * max(rowid) changed since the last build, the index is stale.
 *
 * Not cryptographic — just a stability hint paired with row count
 * via the hnsw_meta table.
 *
 * Pass `dim` to scope the signature to one embedding dimension —
 * required when comparing against per-dim hnsw_meta, since multiple
 * dims can coexist in symbol_embeddings.
 */
export function computeRowsetSignature(db: SqliteDatabase, dim?: number): { rowCount: number; maxRowid: number } {
  if (dim === undefined) {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(MAX(rowid), 0) AS m
           FROM embedding_store
          WHERE embedding IS NOT NULL`,
      )
      .get() as { c: number; m: number };
    return { rowCount: r.c, maxRowid: r.m };
  }
  const expectBytes = dim * FLOAT32_BYTES;
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(rowid), 0) AS m
         FROM embedding_store
        WHERE embedding IS NOT NULL
          AND LENGTH(embedding) = ?`,
    )
    .get(expectBytes) as { c: number; m: number };
  return { rowCount: r.c, maxRowid: r.m };
}

/**
 * Discover the distinct embedding dims currently present in
 * `embedding_store`. Used by the HNSW rebuild (`runEmbedPhase`) to
 * know which per-dim HNSW indexes to maintain.
 */
export function discoverEmbeddingDims(db: SqliteDatabase): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT LENGTH(embedding) AS bytes
         FROM embedding_store
        WHERE embedding IS NOT NULL
          AND grain = 'symbol'`,
    )
    .all() as Array<{ bytes: number }>;
  return rows.map((r) => r.bytes / FLOAT32_BYTES).filter((d) => d > 0 && Number.isInteger(d));
}
