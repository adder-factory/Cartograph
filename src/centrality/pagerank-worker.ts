/**
 * PageRank worker — receives an assigned target-index list +
 * shared adjacency buffers, computes its slice of `next[]` per
 * iteration, signals completion back to main.
 *
 * Lifecycle: spawned once at the start of `computePageRankParallel`,
 * reused across all `PR_ITERATIONS` iterations, terminated at the
 * end. Per-iteration overhead is ONE postMessage (the "step" signal)
 * and ONE postMessage back (the "done" signal) — small, dominated by
 * the actual compute work.
 *
 * Memory model: all adjacency (CSR `inEdgesFlat` + `inEdgesOffsets`),
 * out-degrees, and the rank vectors are SharedArrayBuffer-backed, so
 * the worker reads/writes via aliased typed-array views with zero
 * copy. Convergence semantics match the serial path bit-for-bit
 * because per-target `next[t]` writes are independent — the partition
 * shape changes only the ORDER worker iterates its targets, not the
 * per-target sum order (which still walks `inEdgesFlat[off0..off1)`
 * the same way).
 *
 * B38 (2026-05-25) — workers receive an `Int32Array` of target
 * indices (their LPT-balanced assignment) instead of a `[tStart, tEnd)`
 * contiguous range. The hot loop iterates the assigned array; the
 * partition decision is on main. See `pagerank-parallel.ts:partitionByLpt`
 * for the imbalance bench + rationale.
 */

import { parentPort, workerData } from 'node:worker_threads';

interface WorkerInit {
  /** Target indices assigned to this worker by the LPT bin-pack. */
  readonly targets: Int32Array;
  readonly N: number;
  readonly damping: number;
  readonly prBuf: SharedArrayBuffer; // Float64Array (length N) — current rank
  readonly nextBuf: SharedArrayBuffer; // Float64Array (length N) — next rank (this worker writes its slice)
  readonly outDegBuf: SharedArrayBuffer; // Int32Array (length N)
  readonly inEdgesFlatBuf: SharedArrayBuffer; // Int32Array — source indices, packed CSR
  readonly inEdgesOffsetsBuf: SharedArrayBuffer; // Int32Array (length N+1) — CSR row offsets
}

interface StepMessage {
  readonly type: 'step';
  /** Precomputed by main: `(1 - damping)/N + (damping * danglingSum)/N`. */
  readonly basePlusDangling: number;
}

interface DoneMessage {
  readonly type: 'done';
}

const init = workerData as WorkerInit;

// Bind typed-array views ONCE at startup; reused across all iterations.
const pr = new Float64Array(init.prBuf);
const next = new Float64Array(init.nextBuf);
const outDeg = new Int32Array(init.outDegBuf);
const inEdgesFlat = new Int32Array(init.inEdgesFlatBuf);
const inEdgesOffsets = new Int32Array(init.inEdgesOffsetsBuf);
const targets = init.targets;
const numTargets = targets.length;

parentPort!.on('message', (msg: StepMessage) => {
  if (msg.type !== 'step') return;
  const { basePlusDangling } = msg;
  const damping = init.damping;
  for (let i = 0; i < numTargets; i++) {
    const t = targets[i]!;
    const off0 = inEdgesOffsets[t]!;
    const off1 = inEdgesOffsets[t + 1]!;
    let s = 0;
    for (let k = off0; k < off1; k++) {
      const src = inEdgesFlat[k]!;
      s += pr[src]! / outDeg[src]!;
    }
    next[t] = basePlusDangling + damping * s;
  }
  const reply: DoneMessage = { type: 'done' };
  parentPort!.postMessage(reply);
});
