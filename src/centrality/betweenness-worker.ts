/**
 * Betweenness worker — runs Brandes' single-source pass against a
 * slice of source indices and posts back its local cb accumulator.
 *
 * Why this is simpler than `pagerank-worker.ts`: each source's BFS +
 * dependency-accumulation is independent of every other source's.
 * There's no per-iteration barrier, no shared mutable state during
 * compute, and no need for SharedArrayBuffer ping-pong of result
 * vectors. Workers each own a Float64Array `cb` of size N; the host
 * reduces them by element-wise sum after every worker replies.
 *
 * The CSR (`outOffsets`, `outFlat`) IS shared via SharedArrayBuffer —
 * read-only on the worker side, so no synchronization needed. Copying
 * it per-worker would waste memory on TS-scale (~400 KB per worker).
 *
 * Lifecycle: one-shot. The orchestrator spawns one fresh worker per
 * source-slice, awaits its 'done' message, then terminates it. Worker
 * spawn cost (~50-200 ms per CLAUDE.md's biomarker-worker measurements)
 * is amortised across the slice's source count (K/M ~= 25 sources at
 * K=200, M=8 — each ~50-150 ms of compute, so spawn cost is ~5-15%
 * of the worker's wall).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { brandesSingleSource } from './betweenness.js';
import { parseBetweennessWorkerInit, type BetweennessWorkerReply } from './betweenness-worker-contract.js';

async function main(): Promise<void> {
  if (!parentPort) throw new Error('betweenness-worker must run inside a Worker');
  const start = Date.now();
  try {
    const init = parseBetweennessWorkerInit(workerData);
    const N = init.N;
    const outOffsets = new Int32Array(init.outOffsetsBuf);
    const outFlat = new Int32Array(init.outFlatBuf);
    // Worker-local scratch: same per-source ceiling as the serial
    // path. predCap = edge count (one predecessor entry per edge, in
    // the worst case).
    const predCap = Math.max(1, outFlat.length);
    const cb = new Float64Array(N);
    const dist = new Int32Array(N);
    const sigma = new Float64Array(N);
    const delta = new Float64Array(N);
    const stack = new Int32Array(N);
    const queue = new Int32Array(N);
    const predHead = new Int32Array(N);
    const predNext = new Int32Array(predCap);
    const predFlat = new Int32Array(predCap);

    for (const source of init.sourceIndices) {
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

    const reply: BetweennessWorkerReply = {
      ok: true,
      cbBuf: cb.buffer,
      durationMs: Date.now() - start,
    };
    parentPort.postMessage(reply, [cb.buffer]);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    const reply: BetweennessWorkerReply = { ok: false, error: msg };
    parentPort.postMessage(reply);
  }
}

await main();
