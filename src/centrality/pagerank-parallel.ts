/**
 * Parallel PageRank — fans the inner per-target loop out across
 * worker_threads. Each worker owns an LPT-assigned list of target
 * indices (B38) and writes its slice of the `next[]` vector via
 * SharedArrayBuffer (zero-copy). Per-iteration sync uses one
 * postMessage round-trip per worker.
 *
 * B10 (2026-05-24) — original parallelisation. The serial PageRank
 * inner step in {@link ../centrality/index.ts:pageRankStep} dominates
 * the postHook wall on edge-heavy graphs. Sharding the target loop
 * across N workers compresses the wall by close to N× when
 * convergence is limited by raw compute.
 *
 * B38 (2026-05-25) — switched contiguous `partitionRange` to LPT
 * bin-pack (`partitionByLpt`). Per-target compute scales with
 * in-degree; code graphs are power-law so contiguous slicing
 * imbalanced one worker by ~7× on microsoft/TypeScript. LPT achieves
 * 1.00× imbalance (perfect) at O(N log N) precompute. See
 * `bench/probe-pagerank-balance.mts` + `bench/probe-pagerank-iter-cost.mts`.
 *
 * B39 (2026-05-25) — precompute dangling-node index list in
 * `buildSharedCSR` so the per-iter danglingSum loop iterates only
 * dangling indices instead of branching across all N nodes.
 *
 * B40 (2026-05-25) — bumped DEFAULT_PARALLEL_EDGE_THRESHOLD from
 * 50_000 → 500_000 after empirically measuring that parallel loses
 * to serial on 112K-edge graphs (per-iter danglingSum + CSR-build +
 * spawn overhead exceeds the saved compute below ~500K edges).
 *
 * Routing: callers (`computePageRank` in `index.ts`) gate on the
 * edge count to skip the worker-spawn overhead for small graphs
 * where the serial path is faster. Override the threshold via
 * `CARTOGRAPH_PAGERANK_PARALLEL_EDGE_THRESHOLD` (default 500_000).
 * Force serial via `CARTOGRAPH_PAGERANK_SERIAL=1`.
 *
 * Bit-for-bit parity with the serial path is NOT guaranteed because
 * Float64 addition isn't associative: per-target `next[t]` writes
 * are independent so the LPT partition's iteration-order change
 * doesn't affect the per-target result, but the danglingSum
 * accumulation order differs from the serial path. Scores match to
 * ~12 decimal places. The parity test
 * `__tests__/pagerank-parallel.test.ts` pins the tolerance.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { PR_DAMPING, PR_ITERATIONS } from './index.js';

interface NodeRef {
  readonly id: string;
}

interface EdgeRef {
  readonly source: string;
  readonly target: string;
}

interface ParallelPageRankResult {
  readonly scores: Map<string, number>;
  readonly iterations: number;
  readonly durationMs: number;
}

/** Default threshold above which the parallel path is used. Below
 *  this, the worker-spawn cost dominates the saved compute and the
 *  serial path wins. Tune via env var.
 *
 *  B40 (2026-05-25) — bumped 50K → 500K after empirically measuring
 *  microsoft/TypeScript (112K PR-edges): parallel wall ~131ms,
 *  serial wall ~111ms. The parallel path loses by ~20ms because
 *  the per-iteration danglingSum loop + CSR-build + LPT-partition
 *  setup overhead (~85ms total) exceeds the saved compute on
 *  graphs this small. The 50K threshold from B10 was an unbenched
 *  guess; empirical crossover on this hardware appears to be
 *  ~500K-1M edges. See `bench/probe-pagerank-balance.mts` +
 *  `bench/probe-pagerank-iter-cost.mts` to re-tune on different
 *  hardware. */
export const DEFAULT_PARALLEL_EDGE_THRESHOLD = 500_000;

/** Resolve the threshold honoring the env-var override. */
function resolveEdgeThreshold(): number {
  const raw = process.env['CARTOGRAPH_PAGERANK_PARALLEL_EDGE_THRESHOLD'];
  if (!raw) return DEFAULT_PARALLEL_EDGE_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PARALLEL_EDGE_THRESHOLD;
}

/** True when the env override forces the serial path regardless of
 *  edge count. Used by benches that need A/B timing. */
export function isSerialForced(): boolean {
  return process.env['CARTOGRAPH_PAGERANK_SERIAL'] === '1';
}

/** Returns true iff the parallel path SHOULD be used for `edgeCount`. */
export function shouldUseParallel(edgeCount: number): boolean {
  if (isSerialForced()) return false;
  return edgeCount >= resolveEdgeThreshold();
}

/** Size the worker pool — `os.cpus().length - 1` capped to keep one
 *  core free for the main thread (which does the danglingSum
 *  precompute + buffer swaps). Floor at 2 (no point spawning a
 *  single worker — that's just adding overhead). */
function resolveWorkerCount(): number {
  // Lazy import — avoid pulling `node:os` into modules that don't
  // need it at load time.
  const os = require('node:os') as typeof import('node:os');
  const cpus = typeof os.cpus === 'function' ? os.cpus().length : 4;
  return Math.max(2, Math.min(cpus - 1, 16));
}

/** Build CSR (Compressed Sparse Row) adjacency over SharedArrayBuffers.
 *  Returns the shared buffers + the node-id → index map (kept on main
 *  for the final score assembly). */
function buildSharedCSR(
  nodes: ReadonlyArray<NodeRef>,
  edges: ReadonlyArray<EdgeRef>,
): {
  N: number;
  outDegBuf: SharedArrayBuffer;
  inEdgesFlatBuf: SharedArrayBuffer;
  inEdgesOffsetsBuf: SharedArrayBuffer;
  edgeCount: number;
  /** B39 (2026-05-25) — index list of nodes with out-degree zero.
   *  Pre-computed once during CSR build so the per-iteration
   *  danglingSum loop iterates only the dangling indices instead of
   *  branching across all N nodes every iteration. On TS-scale graphs
   *  the per-iter `for (i=0;i<N;i++) if (outDeg[i]===0) sum+=pr[i]`
   *  was 38% of the parallel wall. */
  danglingIndices: Int32Array;
} {
  const N = nodes.length;
  const idx = new Map<string, number>();
  for (let i = 0; i < N; i++) idx.set(nodes[i]!.id, i);
  // Pass 1: count in-edges per target + out-degrees.
  const outDegBuf = new SharedArrayBuffer(N * Int32Array.BYTES_PER_ELEMENT);
  const outDeg = new Int32Array(outDegBuf);
  const inCount = new Int32Array(N);
  let edgeCount = 0;
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    inCount[t]! += 1;
    outDeg[s]! += 1;
    edgeCount++;
  }
  // Build CSR offsets via prefix-sum.
  const inEdgesOffsetsBuf = new SharedArrayBuffer((N + 1) * Int32Array.BYTES_PER_ELEMENT);
  const inEdgesOffsets = new Int32Array(inEdgesOffsetsBuf);
  let running = 0;
  for (let t = 0; t < N; t++) {
    inEdgesOffsets[t] = running;
    running += inCount[t]!;
  }
  inEdgesOffsets[N] = running;
  // Pass 2: scatter source indices into the flat buffer using a
  // temporary write-cursor (reuses `inCount` as the cursor — its
  // values are about to be overwritten anyway).
  const inEdgesFlatBuf = new SharedArrayBuffer(edgeCount * Int32Array.BYTES_PER_ELEMENT);
  const inEdgesFlat = new Int32Array(inEdgesFlatBuf);
  const writeCursor = new Int32Array(N); // re-zero; cleaner than mutating inCount
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    inEdgesFlat[inEdgesOffsets[t]! + writeCursor[t]!] = s;
    writeCursor[t]! += 1;
  }
  // B39 — precompute dangling-node index list. Single O(N) walk
  // here saves PR_ITERATIONS × O(N) on the per-iter loop.
  let danglingCount = 0;
  for (let i = 0; i < N; i++) if (outDeg[i] === 0) danglingCount++;
  const danglingIndices = new Int32Array(danglingCount);
  let dCursor = 0;
  for (let i = 0; i < N; i++) if (outDeg[i] === 0) danglingIndices[dCursor++] = i;
  return { N, outDegBuf, inEdgesFlatBuf, inEdgesOffsetsBuf, edgeCount, danglingIndices };
}

interface WorkerHandle {
  readonly worker: Worker;
  /** Compute-cost proxy (sum of in-edges across this worker's
   *  assigned targets). Diagnostic only; the worker itself iterates
   *  the assigned `targets` array. */
  readonly load: number;
}

/**
 * Longest-Processing-Time-First (LPT) bin-pack partition over the
 * per-target in-edge counts.
 *
 * B38 (2026-05-25) — replaces the prior contiguous `partitionRange`
 * which gave each worker a `[tStart, tEnd)` slice. Per-target compute
 * scales with in-degree, and code graphs are power-law: a few
 * popular functions have thousands of callers, most have zero or
 * one. Adjacent index positions can cluster around the same high-
 * degree node (siblings in a class, or alphabetically-ordered
 * functions in the same file), so the contiguous slicer routinely
 * gave one worker 7× the work of the median (measured 61,030 vs
 * 8,636 on microsoft/TypeScript; the parallel wall was bounded by
 * the long-pole worker).
 *
 * LPT sorts targets by in-edge count desc + greedily assigns each
 * to the currently-least-loaded bin. O(N log N) precompute,
 * deterministic, no Atomics/SharedArrayBuffer queue primitives. On
 * the TS corpus this drops the imbalance to 1.00× (perfectly
 * balanced down to single-edge granularity).
 *
 * Cache locality: the prior contiguous slices gave each worker a
 * monotonic walk over `inEdgesOffsets`; LPT bins are scattered.
 * In practice this is fine because (a) `inEdgesOffsets` is
 * (N+1) × 4 bytes ≈ 1-2 MB on TS-scale graphs and fits in L2, and
 * (b) the worker's hot data is `pr[src]` reads (scattered through
 * the rank vector regardless of partition strategy) and the
 * contiguous-within-target `inEdgesFlat[k]` range. Bench confirms.
 *
 * @internal Used by `spawnWorkers`. Also exported for the bench
 * scripts (`bench/probe-pagerank-balance.mts`,
 * `bench/probe-pagerank-iter-cost.mts`) which need to compare it
 * against contiguous + round-robin partitions on real graph data.
 */
export function partitionByLpt(inEdgeCounts: Int32Array, workerCount: number): Int32Array[] {
  const N = inEdgeCounts.length;
  // Sort target indices by their in-edge count, desc.
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  // Sort indices in place by inEdgeCounts[i] desc. The Int32Array's
  // sort is numeric by default but we need a custom comparator —
  // convert to Array for sort, write back.
  const orderArr = Array.from(order);
  orderArr.sort((a, b) => inEdgeCounts[b]! - inEdgeCounts[a]!);
  // Greedy assign each target to the currently-least-loaded bucket.
  const bucketsRaw: number[][] = Array.from({ length: workerCount }, () => []);
  const loads = new Float64Array(workerCount);
  for (const t of orderArr) {
    let minIdx = 0;
    let minLoad = loads[0]!;
    for (let i = 1; i < workerCount; i++) {
      if (loads[i]! < minLoad) {
        minLoad = loads[i]!;
        minIdx = i;
      }
    }
    bucketsRaw[minIdx]!.push(t);
    loads[minIdx]! += inEdgeCounts[t]!;
  }
  // Materialise as Int32Arrays for zero-copy postMessage transfer.
  // Targets within a bucket stay in load-desc order, but that
  // doesn't affect correctness or convergence — only iteration order
  // changes, and per-target `next[t]` writes are independent.
  return bucketsRaw.map((b) => Int32Array.from(b));
}

/** Spawn the worker fleet with shared buffers + per-worker target
 *  ranges. Each worker exits when its `Worker.terminate()` lands at
 *  the end of `computePageRankParallel`.
 *
 *  Error listeners are attached HERE (once per worker) — never inside
 *  the per-iteration loop — so the EventEmitter listener-count cap
 *  doesn't trip after PR_ITERATIONS=40 message rounds. Errors are
 *  pushed into the shared `errorSink` ref so the orchestrator can
 *  check it after each iteration and bail. */
interface SpawnWorkersArgs {
  workerCount: number;
  N: number;
  damping: number;
  prBuf: SharedArrayBuffer;
  nextBuf: SharedArrayBuffer;
  outDegBuf: SharedArrayBuffer;
  inEdgesFlatBuf: SharedArrayBuffer;
  inEdgesOffsetsBuf: SharedArrayBuffer;
  errorSink: { error: Error | null };
  /** B29 (2026-05-24) — flipped to `false` by the orchestrator's
   *  `finally` block before `terminate()` so the persistent 'exit'
   *  listener can distinguish "worker died mid-iteration" (real bug)
   *  from "we just terminated as the normal cleanup path" (expected). */
  iterationActive: { value: boolean };
  /** B29 (2026-05-24) — the in-flight iteration's `settle()` function.
   *  The persistent 'exit' listener calls this to resolve the current
   *  iteration immediately on silent worker death, rather than
   *  waiting the full per-iteration timeout. `runOneIteration` writes
   *  to `.fn` on entry and clears it on settle. */
  currentSettle: { fn: (() => void) | null };
}

function spawnWorkers(args: SpawnWorkersArgs): WorkerHandle[] {
  // Resolve the worker entry next to this module — `.ts` under bun
  // (the hook-worker child has TS-loader support), `.js` in a built
  // `dist/`. Matches the biomarker worker-pool pattern.
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = fileURLToPath(new URL(`./pagerank-worker${ext}`, import.meta.url));
  // B38 (2026-05-25) — size-aware LPT bin-pack partition. Per-target
  // compute scales with in-degree (the inner loop sums in-edges);
  // contiguous slicing imbalanced one worker by 7× on TS. LPT
  // achieves 1.00× imbalance (perfect balance) at O(N log N)
  // precompute cost. See `partitionByLpt` doc above for rationale.
  const offsets = new Int32Array(args.inEdgesOffsetsBuf, 0, args.N + 1);
  const perTargetCounts = new Int32Array(args.N);
  for (let t = 0; t < args.N; t++) {
    perTargetCounts[t] = offsets[t + 1]! - offsets[t]!;
  }
  const targetsByWorker = partitionByLpt(perTargetCounts, args.workerCount);
  return targetsByWorker.map((targets) => {
    const worker = new Worker(workerPath, {
      workerData: {
        targets,
        N: args.N,
        damping: args.damping,
        prBuf: args.prBuf,
        nextBuf: args.nextBuf,
        outDegBuf: args.outDegBuf,
        inEdgesFlatBuf: args.inEdgesFlatBuf,
        inEdgesOffsetsBuf: args.inEdgesOffsetsBuf,
      },
    });
    // Capture errors into the shared sink; the orchestrator checks
    // after each iteration. The persistent `.on` is safe — we never
    // remove this listener for the worker's lifetime.
    worker.on('error', (err) => {
      args.errorSink.error ??= err instanceof Error ? err : new Error(String(err));
    });
    // B29 (2026-05-24) — also capture silent exits. A worker that
    // process.exit()s without an 'error' event would otherwise leave
    // `runOneIteration`'s `--remaining` counter above zero (same
    // hang-class as B28 v1's missing exit handler). Three things
    // happen on mid-iteration exit:
    //   1. Suppress the "post-completion expected exit" case via
    //      `iterationActive` (the finally block in
    //      `computePageRankParallel` flips this to false before
    //      calling `terminate()`, so its synthetic exit is silent).
    //   2. Populate `errorSink` so the orchestrator's per-iteration
    //      `if (errorSink.error)` check picks up the failure on the
    //      next loop iteration and throws.
    //   3. Call the in-flight iteration's `settle()` (via
    //      `currentSettle.fn`) to resolve immediately, rather than
    //      waiting the full per-iteration timeout (~60s). Matches
    //      B28 v2's pattern where the exit handler resolves the
    //      promise directly.
    worker.on('exit', (code) => {
      if (!args.iterationActive.value) return;
      args.errorSink.error ??= new Error(`pagerank worker exited with code ${code} mid-iteration`);
      args.currentSettle.fn?.();
    });
    let load = 0;
    for (const target of targets) {
      load += perTargetCounts[target]!;
    }
    return { worker, load };
  });
}

/** Per-iteration wall-clock budget (B29). Sized to be comfortably
 *  larger than the heaviest realistic iteration (~1-5s for a 500K-edge
 *  graph across 8 workers) but tight enough that a worker stuck on
 *  pure compute (no exit, no error) is still bounded. Worker death
 *  resolves much faster — the persistent 'exit' listener calls
 *  `currentSettle.fn()` immediately. Override via
 *  `CARTOGRAPH_PAGERANK_ITERATION_TIMEOUT_MS`. */
const DEFAULT_ITERATION_TIMEOUT_MS = 60_000;

function resolveIterationTimeoutMs(): number {
  const raw = process.env['CARTOGRAPH_PAGERANK_ITERATION_TIMEOUT_MS'];
  if (!raw) return DEFAULT_ITERATION_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ITERATION_TIMEOUT_MS;
}

/** Race the workers' "done" replies for one PageRank iteration. The
 *  per-worker error / exit listeners are attached at spawn (not here)
 *  to avoid EventEmitter listener accumulation across PR_ITERATIONS=40
 *  calls.
 *
 *  B29 (2026-05-24) — gated on a per-iteration `setTimeout` so a
 *  silently-stuck worker (no error event, no exit event, but no 'done'
 *  reply either) surfaces as `errorSink.error` after the budget rather
 *  than hanging the whole computation. The orchestrator checks
 *  `errorSink.error` after each iteration and throws.
 *
 *  The persistent 'exit' listener at spawn handles the
 *  worker-dies-silently case; this timeout handles the
 *  worker-stuck-but-alive case. Together they make the iteration
 *  loop bounded — same resilience shape as G9's
 *  `runOneRuleInWorker`, just adapted to the long-lived-worker model. */
interface RunIterationArgs {
  workers: ReadonlyArray<WorkerHandle>;
  basePlusDangling: number;
  errorSink: { error: Error | null };
  timeoutMs: number;
  /** Shared ref so the persistent 'exit' listener at spawn can call
   *  the in-flight iteration's `settle()` to resolve immediately on
   *  silent worker death. Written on entry, cleared on settle. */
  currentSettle: { fn: (() => void) | null };
}

/** Race the workers' "done" replies for one PageRank iteration. The
 *  per-worker error / exit listeners are attached at spawn (not here)
 *  to avoid EventEmitter listener accumulation across PR_ITERATIONS=40
 *  calls.
 *
 *  B29 (2026-05-24) — three things bound this iteration:
 *
 *   1. **Normal path**: every worker posts 'done', `--remaining`
 *      reaches 0, `settle()` resolves the promise.
 *   2. **Silent-worker-death path**: the persistent 'exit' listener
 *      at spawn populates `errorSink` AND calls `currentSettle.fn()`
 *      directly — the promise resolves immediately, and the
 *      orchestrator's `if (errorSink.error) throw` catches it on
 *      the next loop pass. No 60s wait.
 *   3. **Stuck-but-alive worker path**: the `setTimeout(timeoutMs)`
 *      below fires, populates `errorSink`, and settles. Bounded
 *      by `timeoutMs` (default 60s).
 *
 *  Together these match B28 v2's resilience guarantees adapted to
 *  the long-lived-worker model. */
function runOneIteration(args: RunIterationArgs): Promise<void> {
  const { workers, basePlusDangling, errorSink, timeoutMs, currentSettle } = args;
  return new Promise((resolve) => {
    let remaining = workers.length;
    let settled = false;
    const perHookListeners: Array<{ handle: WorkerHandle; listener: (msg: { type: string }) => void }> = [];
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // Detach the per-iteration message listeners so they don't
      // accumulate across iterations (they're created fresh each
      // call but a leaked one would fire on the next iteration's
      // 'done' and decrement an unrelated counter).
      for (const { listener, handle } of perHookListeners) {
        handle.worker.off('message', listener);
      }
      clearTimeout(timer);
      currentSettle.fn = null;
      resolve();
    };
    // Expose `settle` to the persistent 'exit' listener BEFORE
    // posting work, so a worker that dies on the postMessage
    // round-trip can still resolve us.
    currentSettle.fn = settle;
    const timer = setTimeout(() => {
      if (settled) return;
      errorSink.error ??= new Error(
        `pagerank iteration exceeded ${timeoutMs}ms budget (${remaining}/${workers.length} workers still pending)`,
      );
      settle();
    }, timeoutMs);
    for (const h of workers) {
      const listener = (msg: { type: string }): void => {
        if (msg.type !== 'done') return;
        h.worker.off('message', listener);
        if (--remaining === 0) settle();
      };
      perHookListeners.push({ handle: h, listener });
      h.worker.on('message', listener);
      h.worker.postMessage({ type: 'step', basePlusDangling });
    }
  });
}

/**
 * Compute PageRank in parallel using `workerCount` worker_threads.
 * Same input contract as the serial {@link computePageRank}; same
 * output shape. Sub-LSB-level float drift possible vs serial due to
 * the danglingSum precompute being computed in source-index order on
 * main rather than per-shard.
 *
 * Workers are spawned lazily (one fleet per call) and terminated
 * before return. The hook layer calls this once per indexAll/sync
 * so the per-call spawn cost is amortised across 40 iterations.
 */
export async function computePageRankParallel(
  nodes: ReadonlyArray<NodeRef>,
  edges: ReadonlyArray<EdgeRef>,
): Promise<ParallelPageRankResult> {
  const start = Date.now();
  const N = nodes.length;
  const scores = new Map<string, number>();
  if (N === 0) return { scores, iterations: 0, durationMs: Date.now() - start };

  const { outDegBuf, inEdgesFlatBuf, inEdgesOffsetsBuf, danglingIndices } = buildSharedCSR(nodes, edges);

  // Two ping-ponged rank buffers in shared memory. We alias the
  // `Float64Array` view from each on both main and worker side.
  const prBuf = new SharedArrayBuffer(N * Float64Array.BYTES_PER_ELEMENT);
  const nextBuf = new SharedArrayBuffer(N * Float64Array.BYTES_PER_ELEMENT);
  const pr = new Float64Array(prBuf);
  const next = new Float64Array(nextBuf);
  pr.fill(1 / N);

  const workerCount = resolveWorkerCount();
  const errorSink: { error: Error | null } = { error: null };
  // B29 (2026-05-24) — `iterationActive.value` gates the persistent
  // 'exit' listener so the expected `terminate()` in our finally block
  // doesn't surface as a spurious mid-iteration failure.
  const iterationActive = { value: true };
  // `currentSettle.fn` is set by `runOneIteration` on entry and lets
  // the persistent 'exit' listener resolve the in-flight iteration's
  // promise immediately on silent worker death (rather than waiting
  // the per-iteration timeout). See `runOneIteration`'s JSDoc.
  const currentSettle: { fn: (() => void) | null } = { fn: null };
  const workers = spawnWorkers({
    workerCount,
    N,
    damping: PR_DAMPING,
    prBuf,
    nextBuf,
    outDegBuf,
    inEdgesFlatBuf,
    inEdgesOffsetsBuf,
    errorSink,
    iterationActive,
    currentSettle,
  });
  const iterationTimeoutMs = resolveIterationTimeoutMs();

  try {
    for (let it = 0; it < PR_ITERATIONS; it++) {
      // Main thread computes the danglingSum (needs the full `pr[]`)
      // and the base-plus-dangling term per node. Workers add their
      // per-target sum on top.
      //
      // B39 (2026-05-25) — iterate the pre-computed dangling-index
      // list instead of branching `if (outDeg[i] === 0)` over all N
      // nodes. On TS this is a 38% wall reduction on the parallel
      // path (the per-iter `for (i=0;i<N;i++)` was the dominant
      // bottleneck after B38 LPT made worker compute cheap).
      let danglingSum = 0;
      for (const danglingIndex of danglingIndices) {
        danglingSum += pr[danglingIndex]!;
      }
      const baseline = (1 - PR_DAMPING) / N;
      const basePlusDangling = baseline + (PR_DAMPING * danglingSum) / N;

      await runOneIteration({ workers, basePlusDangling, errorSink, timeoutMs: iterationTimeoutMs, currentSettle });
      if (errorSink.error !== null) throw errorSink.error;

      // Swap the views without reallocating — the buffers stay put;
      // workers read from `prBuf` and write to `nextBuf` on every
      // step. We just relabel which buffer is "current" for the
      // next iteration. To make the workers see the swap, we'd need
      // to update their bound views — but they have BOTH views in
      // memory and we control which one they read/write by
      // alternating between two SETS of buffers. Simpler: copy
      // `next` back into `pr` in place (one O(N) memcpy per iter —
      // dwarfed by the O(N + E) iteration cost).
      pr.set(next);
    }

    for (let i = 0; i < N; i++) scores.set(nodes[i]!.id, pr[i]!);
    return { scores, iterations: PR_ITERATIONS, durationMs: Date.now() - start };
  } finally {
    // Flip iterationActive BEFORE `terminate()` so the persistent
    // 'exit' listener treats the upcoming exit as expected cleanup,
    // not a mid-iteration silent death.
    iterationActive.value = false;
    await Promise.all(workers.map((h) => h.worker.terminate()));
  }
}
