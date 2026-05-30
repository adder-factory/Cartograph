/**
 * Embedding helpers
 *
 * Tier-1 enrichment: turn every indexed symbol into a Float32 vector
 * so we can do semantic search by cosine similarity. The embedding
 * model is configured via `embeddingLlm` in `.cartograph/config.json`.
 * Only `'openai-compat'` is supported after the in-process pathway
 * was deleted 2026-05-24c step 4c — HTTP via the official `openai`
 * npm SDK targeting llama-server / Ollama / mlx_lm / cloud (see
 * `src/llm/embedding-client.ts`).
 *
 * Storage shape: 768-dim (or whatever the model emits) Float32 bytes
 * stored as a BLOB on `symbol_embeddings` (a separate table from
 * `symbol_summaries` so common-path summary scans don't drag the
 * BLOB along their page chain). L2-normalised at write time so the
 * search-side cosine similarity is a pure dot product.
 *
 * Coverage: every node with kind NOT IN ('file', 'import', 'export')
 * is a candidate — not just those with LLM-generated summaries. Input
 * text is built from name + signature + docstring + summary (when
 * available). This moves semantic search recall from ~19% to ~100%.
 */

import { Buffer } from 'node:buffer';
import { LlmEndpointError } from './client.js';
import type { EmbeddingProvider } from './embedding-client.js';
import type { QueryBuilder } from '../db/queries.js';
import { getEmbeddableNodes, upsertSymbolEmbedding } from '../db/queries-embeddings.js';
import { logDebug, logWarn } from '../errors.js';
import { compact } from '../utils.js';
import { recommendedTuning } from '../installer/hardware-tuning.js';

/** Batch size per embed() call. Large enough to amortise per-call HTTP
 *  overhead; the backend's continuous-batching scheduler handles
 *  intra-batch parallelism. */
const EMBED_BATCH = 32;

/** Concurrent embedding batches in flight against the HTTP backend.
 *  Hardware-aware: the default scales with the user's machine via
 *  `recommendedTuning().embed.cartographConcurrency` (computed once
 *  at module load — see `src/installer/hardware-tuning.ts`). On an
 *  M-series Mac with ≥ 16 GB unified memory this resolves to 8;
 *  on a small 8 GB box it's 4; on a tiny < 8 GB box it's 2. Users
 *  can still override per-call via the `concurrency` field on
 *  EmbedOptions or via the CLI's `--concurrency N` flag.
 *
 *  The number should match the user's `llama-server --parallel N` so
 *  every backend slot stays full without piling extra requests up at
 *  the client. The `install-llama-cpp` preset's `nextSteps` strings
 *  surface the right `--parallel N` per tier so the two sides stay
 *  in sync by default.  */
const DEFAULT_EMBED_CONCURRENCY = recommendedTuning().embed.cartographConcurrency;

interface EmbedOptions {
  // `| undefined` is intentional — under `exactOptionalPropertyTypes:
  // true`, `prop?: T` rejects callers that spread `prop: undefined`.
  // Adding `| undefined` lets the common pattern `{ signal: maybe }`
  // type-check without forcing every call site to conditional-spread.
  signal?: AbortSignal | undefined;
  concurrency?: number | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

interface EmbedResult {
  /** Symbols evaluated as candidates (lack a fresh embedding for this model). */
  candidates: number;
  /** Embeddings written this run. */
  generated: number;
  /** Skipped because the cached embedding is still valid. */
  cacheHits: number;
  /** Failures (timeout, network). */
  errors: number;
  /**
   * Inputs the embed server rejected as too large to fit its
   * physical batch size, even when retried per-row. Tracked
   * separately from `errors` because they're a server-capability
   * miss (the model could embed them with a larger configured
   * batch), not a pipeline failure.
   */
  skipped: number;
  durationMs: number;
}

/** Convert a Float32Array to a SQLite BLOB buffer (little-endian, no copy). */
export function vectorToBytes(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Read a SQLite BLOB back into a Float32Array view (zero-copy when aligned). */
export function bytesToVector(b: Buffer | Uint8Array): Float32Array {
  // Make sure we get a fresh, aligned ArrayBuffer regardless of how the
  // SQLite driver hands us the bytes.
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
}

/** Cosine similarity for two L2-normalised vectors == plain dot product. */
export function cosineNormalised(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Input fields for {@link buildEmbedText}. */
export interface BuildEmbedTextArgs {
  name: string;
  signature: string | null;
  docstring: string | null;
  /** Optional; `null` and `undefined` are both treated as absent. */
  summary?: string | null;
}

/**
 * The text we feed the embedder for a symbol. Combines name +
 * signature + docstring + summary (all optional except name). Keeping
 * this deterministic means a content-hash-style cache key is
 * well-defined.
 *
 * Inclusion order under the {@link MAX_EMBED_INPUT_CHARS} cap:
 * name → signature → docstring → summary. Name + signature carry the
 * lexical / structural shape and are always included in full (signature
 * itself only truncates as a last resort when it alone exceeds the cap).
 * Docstring adds author-written intent; summary adds LLM-generated
 * intent. Summary sits last because it is the longest field and the
 * one most likely to overflow — the cap silently truncates it at a
 * word boundary (with `…`) or drops it entirely if no room remains.
 */

// jina-embeddings-v2 has an 8192-token context window; ~6000 chars
// gives safe headroom (≈4 chars/token average with formatting joins).
const MAX_EMBED_INPUT_CHARS = 6000;

export function buildEmbedText({ name, signature, docstring, summary }: BuildEmbedTextArgs): string {
  const trimmed = [name, signature?.trim() ?? null, docstring?.trim() ?? null, summary?.trim() ?? null] as const;

  const parts: string[] = [];
  let used = 0;

  for (const part of trimmed) {
    if (!part) continue;
    const sep = parts.length > 0 ? 1 : 0; // '\n' separator
    if (used + sep + part.length <= MAX_EMBED_INPUT_CHARS) {
      parts.push(part);
      used += sep + part.length;
    } else {
      // Truncate at a word boundary; always include at least the name.
      // Reserve 1 char for the '…' so the final output stays within the cap.
      const room = MAX_EMBED_INPUT_CHARS - used - sep - 1;
      if (room <= 0) break;
      const cut = part.slice(0, room);
      const wordBoundary = cut.lastIndexOf(' ');
      parts.push(wordBoundary > 0 ? cut.slice(0, wordBoundary) + '…' : cut + '…');
      break;
    }
  }

  return parts.join('\n');
}

interface EmbedAllArgs {
  queries: QueryBuilder;
  client: EmbeddingProvider;
  embeddingModel: string;
  options?: EmbedOptions;
}

/**
 * Embed every node that doesn't yet have an embedding for the current
 * model. Covers all symbols with kind NOT IN ('file', 'import',
 * 'export') — not just those with LLM-generated summaries. Input text
 * is built from name + signature + docstring + summary (summary used
 * when available for richer representation). Idempotent — second call
 * is a pure cache check.
 *
 * Performance shape:
 *
 *  1. **Length-sorted batches.** Inputs are sorted by built embed-text
 *     length BEFORE batching, so each ONNX batch contains roughly
 *     uniform-length items. The model still pads to the longest item
 *     in the batch, but neighbouring batches share that padding cost
 *     instead of every batch paying for the largest input project-wide.
 *
 *  2. **Pipelined persists.** Each worker keeps the previous batch's
 *     vectors in `pendingPersist`. On the next loop iteration the next
 *     embed call is dispatched first (returning a Promise), THEN the
 *     prior batch is persisted to SQLite synchronously, THEN the
 *     embed promise is awaited. SQLite writes happen while the native
 *     ONNX inference runs, hiding most of the write cost. The final
 *     pendingPersist is drained after the loop exits.
 */
export async function embedAllNodes(args: EmbedAllArgs): Promise<EmbedResult> {
  const { queries, client, embeddingModel, options = {} } = args;
  const t0 = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_EMBED_CONCURRENCY);

  const candidates = getEmbeddableNodes(queries, embeddingModel);
  // Length-sorted batching — sort by built embed-text length so each
  // batch's items pad to a similar max length. Mixed-length batches
  // pay the full padding tax for every short item; uniform batches
  // pay it once. Documented ~50% wall-time reduction on BERT
  // encoders for variable-length corpora (sentence-transformers
  // Smart Batching).
  candidates.sort((a, b) => embedTextLengthFor(a) - embedTextLengthFor(b));
  const total = candidates.length;
  const counters = { done: 0, generated: 0, errors: 0, skipped: 0 };

  // Build batches up front so workers can pull them off a shared queue.
  const batches: Array<typeof candidates> = [];
  for (let i = 0; i < candidates.length; i += EMBED_BATCH) {
    batches.push(candidates.slice(i, i + EMBED_BATCH));
  }

  let nextBatch = 0;
  const worker = (): Promise<void> =>
    runEmbedWorker({
      client,
      queries,
      embeddingModel,
      batches,
      counters,
      total,
      nextBatchRef: { get: () => nextBatch, take: () => nextBatch++ },
      signal: options.signal,
      onProgress: options.onProgress,
    });

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    candidates: total,
    generated: counters.generated,
    cacheHits: 0, // getEmbeddableNodes already filters cache hits out
    errors: counters.errors,
    skipped: counters.skipped,
    durationMs: Date.now() - t0,
  };
}

/** Sort key for length-sorted batching — see embedAllNodes header. */
function embedTextLengthFor(c: {
  name: string;
  signature: string | null;
  docstring: string | null;
  summary: string | null;
}): number {
  return buildEmbedText(c).length;
}

/**
 * One embed worker. Pulls batches off the shared `nextBatch` index,
 * pipelines persists with the next batch's embed call so SQLite
 * writes happen during native ONNX work (hides most write cost).
 */
interface RunEmbedWorkerArgs {
  client: EmbeddingProvider;
  queries: QueryBuilder;
  embeddingModel: string;
  batches: ReadonlyArray<
    ReadonlyArray<{
      nodeId: string;
      name: string;
      signature: string | null;
      docstring: string | null;
      summary: string | null;
      summaryHash: string;
    }>
  >;
  counters: { done: number; generated: number; errors: number; skipped: number };
  total: number;
  nextBatchRef: { get: () => number; take: () => number };
  signal: AbortSignal | undefined;
  onProgress: ((done: number, total: number) => void) | undefined;
}

async function runEmbedWorker(args: RunEmbedWorkerArgs): Promise<void> {
  const { client, queries, embeddingModel, batches, counters, total, nextBatchRef, signal, onProgress } = args;
  /** Vectors from batch N awaiting persist while batch N+1 embed runs. */
  type PendingPersist = { batch: (typeof batches)[number]; vecs: Float32Array[] };
  let pendingPersist: PendingPersist | null = null;

  while (nextBatchRef.get() < batches.length) {
    if (signal?.aborted) break;
    const i = nextBatchRef.take();
    if (i >= batches.length) break;
    const batch = batches[i]!;
    // Stage 1: dispatch the next embed call (returns a Promise; native
    // ONNX work runs off-thread).
    const vecsPromise = embedBatchVecsOnly({ client, queries, embeddingModel, batch, batchIdx: i, signal });
    // Stage 2: persist the PREVIOUS batch synchronously while the
    // native side is busy. No-op on the first iteration.
    if (pendingPersist) {
      counters.generated += persistEmbeddingsForBatch({
        queries,
        batch: pendingPersist.batch,
        vecs: pendingPersist.vecs,
        embeddingModel,
      });
      pendingPersist = null;
    }
    // Stage 3: await this batch's vectors.
    const result = await vecsPromise;
    counters.done += batch.length;
    if (result.kind === 'errored') {
      counters.errors += batch.length;
      onProgress?.(counters.done, total);
      continue;
    }
    if (result.kind === 'fallback') {
      counters.generated += result.generated;
      counters.skipped += result.skipped;
      onProgress?.(counters.done, total);
      continue;
    }
    // Stash for the next iteration to persist while embedding the next batch.
    pendingPersist = { batch, vecs: result.vecs };
    onProgress?.(counters.done, total);
  }

  // Drain the trailing pending persist (last batch in the queue).
  if (pendingPersist) {
    counters.generated += persistEmbeddingsForBatch({
      queries,
      batch: pendingPersist.batch,
      vecs: pendingPersist.vecs,
      embeddingModel,
    });
  }
}

/**
 * Embed one batch and persist the resulting vectors. Endpoint or
 * shape errors are caught + logged (debug for endpoint errors,
 * warn for unexpected shapes); the caller bumps the `errors`
 * counter using the returned `errored` flag instead of doing the
 * try/catch inline. Pulled out of the worker so its body sits at
 * depth 1 instead of nesting `while/try/if/for/if` four levels.
 */
interface EmbedOneBatchArgs {
  client: EmbeddingProvider;
  queries: QueryBuilder;
  embeddingModel: string;
  batch: ReadonlyArray<{
    nodeId: string;
    name: string;
    signature: string | null;
    docstring: string | null;
    summary: string | null;
    summaryHash: string;
  }>;
  batchIdx: number;
  signal?: AbortSignal | undefined;
}

/**
 * Detect the llama.cpp / server "input too large to process" family of
 * errors. The exact message varies by server version but they all
 * mention the physical batch size or a length cap, so the regex stays
 * deliberately loose. When this trips, the offending row(s) inside the
 * batch get isolated via per-row retry — not all rows fail, just the
 * over-length ones, and `errors` doesn't bump on capability misses.
 */
function isInputTooLargeError(err: unknown): boolean {
  if (!(err instanceof LlmEndpointError)) return false;
  return /too large to process|exceeds.*batch size|input.*length.*exceeds|context length/i.test(err.message);
}

/**
 * Embed a batch and return vectors only — no persist. The caller
 * stashes the vecs and persists them on the NEXT loop iteration so
 * SQLite writes happen while native ONNX runs the next batch (see
 * `runEmbedWorker` pipeline). Three return shapes:
 *
 *  - `{ kind: 'vecs', vecs }` — happy path, caller persists later
 *  - `{ kind: 'fallback', generated, skipped }` — server hit per-row
 *    cap; per-row retry already persisted what it could (the per-row
 *    path can't be deferred without re-architecting it too)
 *  - `{ kind: 'errored' }` — endpoint or shape error, caller bumps
 *    the errors counter
 */
type BatchVecsResult =
  | { kind: 'vecs'; vecs: Float32Array[] }
  | { kind: 'fallback'; generated: number; skipped: number }
  | { kind: 'errored' };

async function embedBatchVecsOnly(args: EmbedOneBatchArgs): Promise<BatchVecsResult> {
  const { client, queries, embeddingModel, batch, batchIdx, signal } = args;
  try {
    const inputs = batch.map((c) =>
      buildEmbedText({ name: c.name, signature: c.signature, docstring: c.docstring, summary: c.summary }),
    );
    const vecs = await client.embed(inputs, compact({ signal }));
    if (vecs.length !== batch.length) {
      throw new LlmEndpointError(`embedding response length mismatch: got ${vecs.length}, want ${batch.length}`);
    }
    return { kind: 'vecs', vecs };
  } catch (err) {
    if (isInputTooLargeError(err)) {
      // Per-row retry persists per row, so it can't be deferred onto
      // the pipelined-persist channel. Run the existing per-row path
      // inline; the worker treats this as a `fallback` (already-
      // persisted) and moves on without stashing vecs.
      logDebug('Embedder: batch hit server size cap, retrying per-row', { batch: batchIdx });
      const r = await embedBatchPerRow({ client, queries, embeddingModel, batch, batchIdx, signal });
      return { kind: 'fallback', generated: r.generated, skipped: r.skipped };
    }
    if (err instanceof LlmEndpointError) {
      logDebug('Embedder: endpoint error', { batch: batchIdx, error: err.message });
    } else {
      logWarn('Embedder: unexpected error', { batch: batchIdx, error: String(err) });
    }
    return { kind: 'errored' };
  }
}

/**
 * Retry path when the whole batch tripped the server's per-input size
 * cap. Each row gets embedded individually; rows that still hit the
 * cap are counted as `skipped` (not `errors` — the model could embed
 * them with a larger configured batch size, so this is a server-
 * capability miss, not a pipeline failure). Other per-row errors fall
 * through to `skipped` too with a warn log.
 */
async function embedBatchPerRow(
  args: EmbedOneBatchArgs,
): Promise<{ generated: number; errored: boolean; skipped: number }> {
  const { client, queries, embeddingModel, batch, signal } = args;
  let generated = 0;
  let skipped = 0;
  for (const row of batch) {
    if (signal?.aborted) break;
    const wasGenerated = await embedOneRow({ client, queries, embeddingModel, row, signal });
    if (wasGenerated === null) {
      skipped++;
    } else {
      generated += wasGenerated;
    }
  }
  return { generated, errored: false, skipped };
}

/** Embed a single row; returns 1 if upserted, 0 if skipped by DB, null on error. */
async function embedOneRow(args: {
  client: EmbedOneBatchArgs['client'];
  queries: QueryBuilder;
  embeddingModel: string;
  row: EmbedOneBatchArgs['batch'][number];
  signal: EmbedOneBatchArgs['signal'];
}): Promise<number | null> {
  const { client, queries, embeddingModel, row, signal } = args;
  const input = buildEmbedText({
    name: row.name,
    signature: row.signature,
    docstring: row.docstring,
    summary: row.summary,
  });
  try {
    const vecs = await client.embed([input], compact({ signal }));
    if (vecs.length !== 1) throw new LlmEndpointError(`per-row embed expected 1 vec, got ${vecs.length}`);
    const includedSummary = !!(row.summary && row.summary.trim().length > 0);
    const summaryHashAtEmbed = includedSummary ? row.summaryHash : '';
    const written = upsertSymbolEmbedding({
      qb: queries,
      nodeId: row.nodeId,
      embedding: vectorToBytes(vecs[0]!),
      model: embeddingModel,
      summaryHashAtEmbed,
    });
    return written ? 1 : 0;
  } catch (err) {
    if (isInputTooLargeError(err)) {
      logDebug('Embedder: skipping over-length row', { nodeId: row.nodeId });
    } else {
      logWarn('Embedder: per-row retry failed', { nodeId: row.nodeId, error: String(err) });
    }
    return null;
  }
}

interface PersistEmbeddingsArgs {
  queries: QueryBuilder;
  batch: ReadonlyArray<{ nodeId: string; summary: string | null; summaryHash: string }>;
  vecs: ReadonlyArray<Float32Array>;
  embeddingModel: string;
}

/** Upsert one embedding per batch row; tolerate stale-handle races
 *  (the parent node may have been deleted mid-flight). Returns
 *  the count of rows actually written.
 *
 *  `summaryHashAtEmbed` is the summary's content_hash when the
 *  embed text included a summary, else `''`. The "no-summary"
 *  case has to be sentinel-mapped here rather than echoing
 *  `summaryHash` directly, because a node can have a summary row
 *  whose text was empty/stale that the embed text rightly skipped. */
function persistEmbeddingsForBatch(args: PersistEmbeddingsArgs): number {
  const { queries, batch, vecs, embeddingModel } = args;
  let generated = 0;
  for (let k = 0; k < batch.length; k++) {
    const row = batch[k]!;
    const includedSummary = !!(row.summary && row.summary.trim().length > 0);
    const summaryHashAtEmbed = includedSummary ? row.summaryHash : '';
    if (
      upsertSymbolEmbedding({
        qb: queries,
        nodeId: row.nodeId,
        embedding: vectorToBytes(vecs[k]!),
        model: embeddingModel,
        summaryHashAtEmbed,
      })
    ) {
      generated++;
    }
  }
  return generated;
}

/**
 * Run an in-process semantic search by scanning every embedding and
 * keeping the top-K. O(N) but for cartograph-sized indexes (≤ 50K
 * symbols, ~150 MB of vectors) this is single-digit ms in practice.
 *
 * If the index ever grows past that, the right next step is the
 * `sqlite-vec` extension — but it's a native dep so we defer until
 * needed.
 */
interface SemanticHit {
  nodeId: string;
  score: number;
}

/**
 * Maintain `heap` as the bottom-of-min sorted top-K (ascending by
 * score). Insert when there's room; otherwise replace the weakest hit
 * if the new one beats it. Sort cost O(k log k) per call, but k is
 * small (≤ 50) so this stays well below dot-product time.
 */
function pushTopK(heap: SemanticHit[], k: number, hit: SemanticHit): void {
  if (heap.length < k) {
    heap.push(hit);
    heap.sort((a, b) => a.score - b.score);
  } else if (hit.score > heap[0]!.score) {
    heap[0] = hit;
    heap.sort((a, b) => a.score - b.score);
  }
}

export function topKByCosine(
  query: Float32Array,
  candidates: ReadonlyArray<{ nodeId: string; embedding: Buffer | Uint8Array }>,
  k: number,
): SemanticHit[] {
  const heap: SemanticHit[] = [];
  for (const c of candidates) {
    const v = bytesToVector(c.embedding);
    const score = cosineNormalised(query, v);
    pushTopK(heap, k, { nodeId: c.nodeId, score });
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * Top-K cosine search over a flat decoded matrix. Used by the
 * EmbeddingCache to avoid per-query SQLite fetch + Float32Array
 * decode. The matrix is `ids.length * dim` floats laid out row-major
 * (row i for `ids[i]` starts at offset `i * dim`).
 */
interface TopKByCosineMatrixArgs {
  query: Float32Array;
  /** Flat row-major matrix: row i for `ids[i]` starts at offset `i * dim`. */
  matrix: Float32Array;
  ids: ReadonlyArray<string>;
  dim: number;
  k: number;
}

export function topKByCosineMatrix(args: TopKByCosineMatrixArgs): SemanticHit[] {
  const { query, matrix, ids, dim, k } = args;
  const heap: SemanticHit[] = [];
  const n = ids.length;
  const qLen = Math.min(query.length, dim);
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let score = 0;
    for (let d = 0; d < qLen; d++) score += matrix[off + d]! * query[d]!;
    pushTopK(heap, k, { nodeId: ids[i]!, score });
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * In-memory cache of every embedding for a given model, decoded once
 * into a flat `Float32Array` matrix. Avoids re-fetching from SQLite
 * and re-decoding `Float32Array` views on every similarity query.
 *
 * Lifetime: instance-scoped (one per Cartograph). Invalidated by:
 *   - `indexAll` and `sync` finishing (new embeddings may exist).
 *   - `clear()` / `clearCoChanges()` (the table was emptied).
 *   - `embedAllNodes()` finishing inside the same process.
 *
 * This is a best-effort cache: a stale cache costs at most one
 * iteration of "ranked by mostly-fresh-but-missing-the-newest
 * embeddings" — never wrong, just a bit out of date until the next
 * invalidation.
 */
interface CachedEmbeddings {
  matrix: Float32Array;
  ids: string[];
  dim: number;
  model: string;
  /** Row count in `symbol_embeddings` for `model` at last build.
   *  Compared against a fresh count on each {@link EmbeddingCache.get}
   *  so out-of-process writes (agent-bridge `save_summaries` →
   *  external embed pass) don't pin the cache at "empty". Same-count-
   *  different-row edits still need indexAll/sync to invalidate. */
  dbCount: number;
}

export interface EmbeddingFetcher {
  getAllEmbeddings(model: string): Array<{ nodeId: string; embedding: Buffer | Uint8Array }>;
  /** Optional — when present, the cache uses it for sub-millisecond
   *  freshness checks instead of relying on explicit `invalidate()`. */
  getEmbeddingsCount?(model: string): number;
}

export class EmbeddingCache {
  private cached: CachedEmbeddings | null = null;

  /**
   * Return the cached matrix for `model`, rebuilding from `fetcher`
   * on miss. The returned matrix is owned by the cache — callers
   * must not mutate it.
   */
  get(fetcher: EmbeddingFetcher, model: string): CachedEmbeddings {
    const dbCount = fetcher.getEmbeddingsCount?.(model);
    if (this.cached && this.cached.model === model) {
      // When the fetcher can't tell us the row count, fall back to
      // the legacy "trust the cache until invalidate()" behaviour.
      const fresh = dbCount === undefined || this.cached.dbCount === dbCount;
      if (fresh) return this.cached;
    }
    const rows = fetcher.getAllEmbeddings(model);
    if (rows.length === 0) {
      this.cached = { matrix: new Float32Array(0), ids: [], dim: 0, model, dbCount: dbCount ?? 0 };
      return this.cached;
    }
    const firstVec = bytesToVector(rows[0]!.embedding);
    const dim = firstVec.length;
    // Skip mismatched-dim rows (a model upgrade in flight could leave
    // some old vectors). Build a packed matrix of only the kept rows
    // so `ids[i]` always lines up with row `i` in the matrix.
    const ids: string[] = [];
    const buf = new Float32Array(rows.length * dim);
    let written = 0;
    for (const row of rows) {
      const v = bytesToVector(row.embedding);
      if (v.length !== dim) continue;
      buf.set(v, written * dim);
      ids.push(row.nodeId);
      written++;
    }
    const allKept = written === rows.length;
    const matrix = allKept ? buf : buf.slice(0, written * dim);
    this.cached = { matrix, ids, dim, model, dbCount: dbCount ?? rows.length };
    return this.cached;
  }

  /** Drop the cache. Next `get()` rebuilds from SQLite. */
  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Reciprocal Rank Fusion: combine FTS (lexical) and semantic rankings
 * into one score. Proven robust default for hybrid search.
 *
 * For each result that appears in either ranking, score is sum over
 * lists of `1 / (k + rank)`. k=60 is the canonical constant.
 */
export function reciprocalRankFusion<T extends { id: string }>(
  rankings: ReadonlyArray<ReadonlyArray<T>>,
  k = 60,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of rankings) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.id;
      out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return out;
}
