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
import {
  parsePageRankStepMessage,
  parsePageRankWorkerInit,
  type PageRankWorkerReply,
} from './pagerank-worker-contract.js';

const init = parsePageRankWorkerInit(workerData);

// Bind typed-array views ONCE at startup; reused across all iterations.
const pr = new Float64Array(init.prBuf);
const next = new Float64Array(init.nextBuf);
const outDeg = new Int32Array(init.outDegBuf);
const inEdgesFlat = new Int32Array(init.inEdgesFlatBuf);
const inEdgesOffsets = new Int32Array(init.inEdgesOffsetsBuf);
const targets = init.targets;
const numTargets = targets.length;

parentPort!.on('message', (raw: unknown) => {
  try {
    const { basePlusDangling } = parsePageRankStepMessage(raw);
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
    const reply: PageRankWorkerReply = { type: 'done' };
    parentPort!.postMessage(reply);
  } catch (err) {
    const reply: PageRankWorkerReply = {
      type: 'error',
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    };
    parentPort!.postMessage(reply);
  }
});
