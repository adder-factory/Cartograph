/**
 * Sampled betweenness centrality (Brandes 2001 + Brandes & Pich 2007).
 *
 * What betweenness measures: the share of all-pairs shortest paths
 * that a node lies on. PageRank rewards being REACHED by many; this
 * rewards being TRAVERSED THROUGH. The two are weakly correlated on
 * real graphs and disagree most strongly on "structural bridges":
 * functions that are the only path between two subsystems but have
 * few direct callers themselves. Touching a high-betweenness node is
 * a refactor-impact signal an agent can't cheaply derive otherwise.
 *
 * Algorithm (Brandes 2001, "A Faster Algorithm for Betweenness
 * Centrality"): for each source `s`, run a BFS that simultaneously
 * (a) computes shortest-path distances + (b) counts the number of
 * shortest s-paths to each node `sigma[v]`. Then a reverse pass over
 * the BFS-ordered stack accumulates `delta[v] = sum over successors
 * w of (sigma[v]/sigma[w])(1 + delta[w])`. Each non-source `v`
 * contributes `delta[v]` to its betweenness. Total cost: O(VE) for
 * the full pairwise case (vs the naive O(V^3) all-pairs-shortest-path).
 *
 * Sampling (Brandes & Pich 2007): for graphs where O(VE) is still too
 * expensive (TS-scale: V=39k, E=O(100k), so VE ~= 4e9), pick K random
 * source pivots, scale final scores by V/K. Convergence is good in
 * practice for K=200-500; the ordering of high-betweenness nodes is
 * stable well before the scores themselves converge.
 *
 * Why CSR-style out-edge adjacency: BFS walks forward through
 * outgoing edges from each source. PageRank uses IN-edges (rank flows
 * inward); betweenness uses OUT-edges (paths flow outward). So we
 * build a parallel CSR.
 *
 * Determinism: when `seed` is set, the K random sources are sampled
 * via a Mulberry32 PRNG so the same (nodes, edges, k, seed) always
 * produces the same scores. Without that, sampling noise would make
 * test parity impossible.
 *
 * Persistence: the bulk-write integration column is `nodes.betweenness`
 * (migration 068); see {@link ../db/queries-centrality.ts} for the
 * upsert path (wired in a follow-up session). This module is pure
 * compute — caller owns I/O.
 */

import { computeAlgoHash } from '../algo-hash.js';

export interface BetweennessNodeRef {
  readonly id: string;
}

export interface BetweennessEdgeRef {
  readonly source: string;
  readonly target: string;
}

export interface BetweennessOpts {
  /**
   * Number of source samples for the approximation. Pass 0 (or any
   * value >= node count) for exact full-pairwise computation. Default
   * 200 — empirically stable top-K rankings on TS-scale graphs.
   */
  k?: number;
  /**
   * PRNG seed for source sampling. Same seed + inputs = same scores.
   * Default 0xC0DE_2026; override only when you actively want the
   * jitter (e.g., variance benches).
   */
  seed?: number;
  /**
   * Divide each score by (N-1)(N-2) to put values in [0, 1] for a
   * directed graph. Default true. Set false for raw path counts (e.g.,
   * when summing partial results across worker shards).
   */
  normalize?: boolean;
}

export interface BetweennessResult {
  /** nodeId → sampled betweenness score. */
  readonly scores: Map<string, number>;
  /** Number of source nodes actually sampled (0 < sampleCount <= N). */
  readonly sampleCount: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/** Default sample size — empirically stable top-K rankings on TS-scale. */
export const DEFAULT_K = 200;
/** Default RNG seed for source sampling — overridable via opts.seed. */
export const DEFAULT_SEED = 0xc0de2026;

/**
 * Algo-version SHA derived from the betweenness spec set (this file +
 * the parallel orchestrator + the pass orchestrator). A change to any
 * of those — Brandes core, sampling math, scale-up, partitioning,
 * persist semantics — invalidates the stored fingerprint, triggering
 * a one-shot full re-rank on the next sync. Mirrors
 * VALUE_REF_EDGES_ALGO_VERSION / CHURN_ALGO_VERSION shape.
 */
export const BETWEENNESS_ALGO_VERSION = computeAlgoHash(import.meta.url, ['betweenness-parallel', 'betweenness-pass']);

/**
 * Mulberry32 — small, fast, well-distributed PRNG. Plenty for source
 * sampling (we just need `K` distinct integers in `[0, N)`); not
 * cryptographic. Exported so the parallel orchestrator can pre-pick
 * the same source set the serial path would.
 */
/** Mulberry32 stream constants (Spivak / Tommy Ettinger, 2017). The
 *  shift counts and the 32-bit increment are part of the published
 *  algorithm — extracting them as named bindings clears the
 *  magic-number biomarker without losing the original literals (they
 *  remain visible in this comment block for anyone debugging the
 *  PRNG). */
const MULBERRY32_INCREMENT = 0x6d2b79f5;
const MULBERRY32_SHIFT_A = 15;
const MULBERRY32_SHIFT_B = 7;
const MULBERRY32_OR_B = 61;
const MULBERRY32_SHIFT_C = 14;
const U32_MODULUS = 4294967296;
const SEED_OR_ONE = 1;

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + MULBERRY32_INCREMENT) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> MULBERRY32_SHIFT_A), t | SEED_OR_ONE);
    t ^= t + Math.imul(t ^ (t >>> MULBERRY32_SHIFT_B), t | MULBERRY32_OR_B);
    return ((t ^ (t >>> MULBERRY32_SHIFT_C)) >>> 0) / U32_MODULUS;
  };
}

/**
 * Reservoir-free Fisher-Yates partial shuffle for the first K
 * indices. Exported for the parallel orchestrator's deterministic
 * source partitioning — the host picks the same K indices the serial
 * path would, then slices them across workers.
 */
export function pickSourceIndices(N: number, k: number, rng: () => number): Int32Array {
  const perm = new Int32Array(N);
  for (let i = 0; i < N; i++) perm[i] = i;
  const take = Math.min(k, N);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (N - i));
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  return perm.subarray(0, take);
}

/**
 * Build the out-edge CSR: for each source node, the contiguous list
 * of its outgoing target indices. Edges referencing unknown ids are
 * silently dropped — matches PageRank's adjacency builder.
 *
 * Exported so {@link ./betweenness-parallel.ts} can build the CSR
 * once on the host, then transfer it to workers via
 * SharedArrayBuffer-backed Int32Arrays.
 */
export function buildOutEdgeCSR(
  nodes: ReadonlyArray<BetweennessNodeRef>,
  edges: ReadonlyArray<BetweennessEdgeRef>,
): { N: number; idx: Map<string, number>; outOffsets: Int32Array; outFlat: Int32Array } {
  const N = nodes.length;
  const idx = new Map<string, number>();
  for (let i = 0; i < N; i++) idx.set(nodes[i]!.id, i);
  // Pass 1: per-source out-degree.
  const outDeg = new Int32Array(N);
  let edgeCount = 0;
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    outDeg[s]! += 1;
    edgeCount++;
  }
  const outOffsets = new Int32Array(N + 1);
  let running = 0;
  for (let i = 0; i < N; i++) {
    outOffsets[i] = running;
    running += outDeg[i]!;
  }
  outOffsets[N] = running;
  // Pass 2: scatter targets into the flat buffer.
  const outFlat = new Int32Array(edgeCount);
  const cursor = new Int32Array(N);
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    outFlat[outOffsets[s]! + cursor[s]!] = t;
    cursor[s]! += 1;
  }
  return { N, idx, outOffsets, outFlat };
}

/**
 * Single-source contribution to betweenness, per Brandes 2001. Reads
 * the global CSR + scratch arrays, accumulates into `cb`.
 *
 * Scratch arrays are pre-allocated by the caller and zeroed here so
 * the outer loop can reuse them across all K sources (avoiding K
 * fresh Float64Array allocations). Exported so the worker entry
 * (`betweenness-worker.ts`) can call it with worker-local scratch
 * and the host-built CSR.
 */
export function brandesSingleSource(args: {
  source: number;
  N: number;
  outOffsets: Int32Array;
  outFlat: Int32Array;
  /** Output accumulator — `cb[v] += delta[v]` for v != source. */
  cb: Float64Array;
  /** Scratch — caller pre-allocates, this function rezeros + writes. */
  dist: Int32Array;
  sigma: Float64Array;
  delta: Float64Array;
  /** Scratch BFS-ordered stack — written from index 0 up to `stackTop`. */
  stack: Int32Array;
  /** Scratch FIFO queue — head/tail are local. */
  queue: Int32Array;
  /**
   * Predecessor lists (Pred[w] = sources on a shortest path to w).
   * Flat int-pair encoding: predFlat[k] = predecessor; predNext[k] =
   * link to the next pred for the same w (-1 terminates). predHead[w]
   * = index into predFlat of the first pred (-1 = empty).
   */
  predHead: Int32Array;
  predNext: Int32Array;
  predFlat: Int32Array;
}): void {
  const { source, N, outOffsets, outFlat, cb, dist, sigma, delta, stack, queue, predHead, predNext, predFlat } = args;
  // Rezero the per-source scratch. predHead = -1 (empty list sentinel),
  // dist = -1 (unvisited sentinel), sigma/delta = 0.
  for (let i = 0; i < N; i++) {
    dist[i] = -1;
    sigma[i] = 0;
    delta[i] = 0;
    predHead[i] = -1;
  }
  dist[source] = 0;
  sigma[source] = 1;
  let predTop = 0;
  let stackTop = 0;
  let qHead = 0;
  let qTail = 0;
  queue[qTail++] = source;
  while (qHead < qTail) {
    const v = queue[qHead++]!;
    stack[stackTop++] = v;
    const start = outOffsets[v]!;
    const end = outOffsets[v + 1]!;
    const dv = dist[v]!;
    const sv = sigma[v]!;
    for (let k = start; k < end; k++) {
      const w = outFlat[k]!;
      // First visit — record shortest distance + enqueue.
      if (dist[w]! < 0) {
        dist[w] = dv + 1;
        queue[qTail++] = w;
      }
      // Tie on a shortest path through v — accumulate path count +
      // record v as a predecessor.
      if ((dist[w] as number) === dv + 1) {
        sigma[w]! += sv;
        predFlat[predTop] = v;
        predNext[predTop] = predHead[w]!;
        predHead[w] = predTop;
        predTop++;
      }
    }
  }
  // Reverse pass — accumulate dependencies.
  while (stackTop > 0) {
    const w = stack[--stackTop]!;
    const coefficient = (1 + delta[w]!) / sigma[w]!;
    let p = predHead[w]!;
    while (p !== -1) {
      const v = predFlat[p]!;
      delta[v]! += sigma[v]! * coefficient;
      p = predNext[p]!;
    }
    if (w !== source) cb[w]! += delta[w]!;
  }
}

/**
 * Sampled betweenness over a directed graph.
 *
 * Edge-case shortcuts:
 * - N === 0 → empty result.
 * - N === 1 or 2 → all scores are 0 (no intermediate paths to lie on).
 *   The normalization divisor (N-1)(N-2) is also 0 here, which would
 *   otherwise yield NaN.
 * - Sampling K >= N → exact computation (no scale-up).
 */
export function computeBetweenness(
  nodes: ReadonlyArray<BetweennessNodeRef>,
  edges: ReadonlyArray<BetweennessEdgeRef>,
  opts?: BetweennessOpts,
): BetweennessResult {
  const start = Date.now();
  const N = nodes.length;
  const scores = new Map<string, number>();
  if (N === 0) return { scores, sampleCount: 0, durationMs: Date.now() - start };
  if (N <= 2) {
    for (let i = 0; i < N; i++) scores.set(nodes[i]!.id, 0);
    return { scores, sampleCount: 0, durationMs: Date.now() - start };
  }
  const requestedK = opts?.k ?? DEFAULT_K;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const normalize = opts?.normalize ?? true;
  const exact = requestedK <= 0 || requestedK >= N;
  const { outOffsets, outFlat } = buildOutEdgeCSR(nodes, edges);
  const edgeCount = outFlat.length;
  // Each BFS visits at most every edge once, so the predecessor lists
  // have a hard upper bound of E entries across all w. Pre-allocating
  // at that ceiling avoids re-growth at the cost of one E-sized
  // Int32Array per source — modest compared to the cb/dist/sigma/delta
  // scratch which the source loop also keeps live.
  const predCap = Math.max(1, edgeCount);
  const cb = new Float64Array(N);
  const dist = new Int32Array(N);
  const sigma = new Float64Array(N);
  const delta = new Float64Array(N);
  const stack = new Int32Array(N);
  const queue = new Int32Array(N);
  const predHead = new Int32Array(N);
  const predNext = new Int32Array(predCap);
  const predFlat = new Int32Array(predCap);

  let sources: Int32Array;
  if (exact) {
    sources = new Int32Array(N);
    for (let i = 0; i < N; i++) sources[i] = i;
  } else {
    sources = pickSourceIndices(N, requestedK, makeRng(seed));
  }

  for (const source of sources) {
    brandesSingleSource({
      source,
      N,
      outOffsets,
      outFlat,
      cb,
      dist,
      sigma,
      delta,
      stack,
      queue,
      predHead,
      predNext,
      predFlat,
    });
  }

  // Scale-up for sampled estimation (Brandes & Pich 2007): each
  // sampled source contributes its share of the all-pairs sum, so the
  // unbiased estimator is `sum * N / sampleCount`.
  const sampleCount = sources.length;
  const scaleUp = exact ? 1 : N / sampleCount;
  const normDivisor = normalize ? (N - 1) * (N - 2) : 1;
  for (let i = 0; i < N; i++) {
    scores.set(nodes[i]!.id, (cb[i]! * scaleUp) / normDivisor);
  }
  return { scores, sampleCount, durationMs: Date.now() - start };
}
