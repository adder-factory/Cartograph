/**
 * Parallel sampled Brandes betweenness — fans K source pivots
 * across N worker_threads. Each worker accumulates its local
 * `cb[]`; the host element-wise sums the per-worker vectors and
 * applies the standard scale-up + normalization.
 *
 * Why this is structurally simpler than `pagerank-parallel.ts`:
 * PageRank has a forty-iteration outer loop where each iteration
 * reads the previous iteration's full rank vector — workers must
 * barrier on every iteration. Brandes betweenness has no such
 * dependency: each source's BFS + dependency-accumulation is
 * independent. So workers run fire-and-forget for their slice,
 * post their cb buffer back via transferable ArrayBuffer, and
 * exit. The orchestrator awaits all of them with `Promise.all`
 * and reduces.
 *
 * Routing: callers (`runBetweennessPass`) gate on edge count + K
 * to skip the worker-spawn cost for small graphs where the serial
 * path wins. Default threshold 20 K edges + K >= 50 sources.
 * Override via `CARTOGRAPH_BETWEENNESS_PARALLEL_EDGE_THRESHOLD`.
 * Force serial via `CARTOGRAPH_BETWEENNESS_SERIAL=1`.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  buildOutEdgeCSR,
  DEFAULT_K,
  DEFAULT_SEED,
  makeRng,
  pickSourceIndices,
  type BetweennessEdgeRef,
  type BetweennessNodeRef,
  type BetweennessOpts,
  type BetweennessResult,
} from './betweenness.js';

/** Edge-count floor above which the parallel path makes sense. Below it,
 *  per-worker spawn cost (~50-200 ms) dominates the per-source compute. */
export const DEFAULT_PARALLEL_EDGE_THRESHOLD = 20_000;

/** Sample-count floor — if K is too small (e.g., K=10), per-source cost is
 *  too low to amortise spawn even on big graphs. */
export const DEFAULT_PARALLEL_K_THRESHOLD = 50;

/** Per-worker reply timeout. Sized to be comfortably larger than even
 *  the heaviest realistic worker slice on TS-scale (K/M = 25 sources,
 *  each ~50-150 ms = ~4 s) but tight enough that a stuck worker is
 *  bounded. Override via `CARTOGRAPH_BETWEENNESS_WORKER_TIMEOUT_MS`. */
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;

function resolveEdgeThreshold(): number {
  const raw = process.env['CARTOGRAPH_BETWEENNESS_PARALLEL_EDGE_THRESHOLD'];
  if (!raw) return DEFAULT_PARALLEL_EDGE_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PARALLEL_EDGE_THRESHOLD;
}

function resolveWorkerTimeoutMs(): number {
  const raw = process.env['CARTOGRAPH_BETWEENNESS_WORKER_TIMEOUT_MS'];
  if (!raw) return DEFAULT_WORKER_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKER_TIMEOUT_MS;
}

/** Forced-serial escape hatch for A/B benching. */
export function isSerialForced(): boolean {
  return process.env['CARTOGRAPH_BETWEENNESS_SERIAL'] === '1';
}

/** Decide whether to route through the worker pool. */
export function shouldUseParallel(edgeCount: number, k: number): boolean {
  if (isSerialForced()) return false;
  if (k < DEFAULT_PARALLEL_K_THRESHOLD) return false;
  return edgeCount >= resolveEdgeThreshold();
}

/** Size the worker pool — `os.cpus().length - 1`, capped to 16, floor 2. */
function resolveWorkerCount(): number {
  // Lazy import — avoid pulling `node:os` into modules that don't need it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const cpus = typeof os.cpus === 'function' ? os.cpus().length : 4;
  return Math.max(2, Math.min(cpus - 1, 16));
}

/** Partition a source-index array into `workerCount` roughly-equal
 *  contiguous slices. Last slice absorbs the remainder. */
function partitionSources(sources: Int32Array, workerCount: number): number[][] {
  const slices: number[][] = [];
  const total = sources.length;
  const base = Math.floor(total / workerCount);
  let cursor = 0;
  for (let i = 0; i < workerCount; i++) {
    const start = cursor;
    const end = i === workerCount - 1 ? total : cursor + base;
    const slice: number[] = [];
    for (let j = start; j < end; j++) slice.push(sources[j]!);
    slices.push(slice);
    cursor = end;
  }
  return slices;
}

interface WorkerReplyOk {
  ok: true;
  cbBuf: ArrayBuffer;
  durationMs: number;
}
interface WorkerReplyErr {
  ok: false;
  error: string;
}
type WorkerReply = WorkerReplyOk | WorkerReplyErr;

/** Spawn a single worker for one source-slice. Resolves with the
 *  per-worker `Float64Array(N)` cb accumulator. Bounded by a timeout
 *  so a stuck worker can't hang the whole compute. */
function runOneWorker(args: {
  workerPath: string;
  N: number;
  outOffsetsBuf: SharedArrayBuffer;
  outFlatBuf: SharedArrayBuffer;
  sourceIndices: number[];
  timeoutMs: number;
}): Promise<Float64Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(args.workerPath, {
      workerData: {
        N: args.N,
        outOffsetsBuf: args.outOffsetsBuf,
        outFlatBuf: args.outFlatBuf,
        sourceIndices: args.sourceIndices,
      },
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `betweenness worker exceeded ${args.timeoutMs}ms budget (slice of ${args.sourceIndices.length} sources)`,
          ),
        ),
      );
    }, args.timeoutMs);
    worker.on('message', (msg: WorkerReply) => {
      if (!msg.ok) {
        settle(() => reject(new Error(msg.error)));
        return;
      }
      const cb = new Float64Array(msg.cbBuf);
      settle(() => resolve(cb));
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => {
      if (settled) return;
      settle(() => reject(new Error(`betweenness worker exited with code ${code} mid-compute`)));
    });
  });
}

/**
 * Convert a regular Int32Array into a SharedArrayBuffer-backed one.
 * Workers receive the SAB and reconstruct the view; no copy after
 * the initial materialisation.
 */
function toShared(view: Int32Array): { buf: SharedArrayBuffer; view: Int32Array } {
  const buf = new SharedArrayBuffer(view.length * Int32Array.BYTES_PER_ELEMENT);
  const shared = new Int32Array(buf);
  shared.set(view);
  return { buf, view: shared };
}

/**
 * Parallel sampled betweenness. Same input contract as the serial
 * {@link computeBetweenness}; same output shape; same determinism
 * guarantees (the host picks the K source indices via the seeded
 * RNG before partitioning, so the workers all see the same set of
 * sources as the serial path would have). The element-wise reduce
 * is associative + commutative for Float64 addition up to ULP, so
 * the parallel scores agree with the serial path to ~12 decimal
 * places — same drift class PageRank's parallel pin
 * (`pagerank-parallel.test.ts`) tolerates.
 */
export async function computeBetweennessParallel(
  nodes: ReadonlyArray<BetweennessNodeRef>,
  edges: ReadonlyArray<BetweennessEdgeRef>,
  opts?: BetweennessOpts,
): Promise<BetweennessResult> {
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
  const { buf: outOffsetsBuf } = toShared(outOffsets);
  const { buf: outFlatBuf } = toShared(outFlat);

  let sources: Int32Array;
  if (exact) {
    sources = new Int32Array(N);
    for (let i = 0; i < N; i++) sources[i] = i;
  } else {
    sources = pickSourceIndices(N, requestedK, makeRng(seed));
  }

  const workerCount = Math.min(resolveWorkerCount(), sources.length);
  const slices = partitionSources(sources, workerCount);
  // Skip empty slices when sources.length < workerCount (degenerate
  // edge case: K=3, M=8 → only 3 workers actually do work).
  const nonEmptySlices = slices.filter((s) => s.length > 0);

  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = fileURLToPath(new URL(`./betweenness-worker${ext}`, import.meta.url));
  const timeoutMs = resolveWorkerTimeoutMs();

  const perWorkerCbs = await Promise.all(
    nonEmptySlices.map((sourceIndices) =>
      runOneWorker({ workerPath, N, outOffsetsBuf, outFlatBuf, sourceIndices, timeoutMs }),
    ),
  );

  // Reduce: element-wise sum across worker cb arrays.
  const cb = new Float64Array(N);
  for (const wcb of perWorkerCbs) {
    for (let i = 0; i < N; i++) cb[i]! += wcb[i]!;
  }

  const sampleCount = sources.length;
  const scaleUp = exact ? 1 : N / sampleCount;
  const normDivisor = normalize ? (N - 1) * (N - 2) : 1;
  for (let i = 0; i < N; i++) {
    scores.set(nodes[i]!.id, (cb[i]! * scaleUp) / normDivisor);
  }
  return { scores, sampleCount, durationMs: Date.now() - start };
}
