/**
 * PageRank per-iteration cost probe — instruments
 * `computePageRankParallel` end-to-end to attribute the wall to
 * setup + iter compute + danglingSum + IPC overhead.
 *
 * Used to investigate why LPT bin-pack (B38) didn't move the wall
 * on microsoft/TypeScript — strong suspicion is the per-iteration
 * postMessage × N-workers overhead is dominating the cheap compute
 * on this corpus.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path bun bench/probe-pagerank-iter-cost.mts
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { getAllNodes } from '../src/db/queries.js';
import { PR_DAMPING, PR_EDGE_KINDS, PR_ITERATIONS, computePageRank } from '../src/centrality/index.js';

interface PageRankEdge {
  source: string;
  target: string;
}

interface CsrProbeData {
  outDegBuf: SharedArrayBuffer;
  outDeg: Int32Array;
  inEdgesOffsetsBuf: SharedArrayBuffer;
  inEdgesOffsets: Int32Array;
  inEdgesFlatBuf: SharedArrayBuffer;
  prBuf: SharedArrayBuffer;
  nextBuf: SharedArrayBuffer;
  pr: Float64Array;
}

function buildCsrProbeData(nodes: ReadonlyArray<{ id: string }>, edges: ReadonlyArray<PageRankEdge>): CsrProbeData {
  const N = nodes.length;
  const idx = new Map<string, number>();
  for (let i = 0; i < N; i++) idx.set(nodes[i]!.id, i);
  const outDegBuf = new SharedArrayBuffer(N * 4);
  const outDeg = new Int32Array(outDegBuf);
  const inCount = new Int32Array(N);
  let ec = 0;
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    inCount[t]! += 1;
    outDeg[s]! += 1;
    ec++;
  }
  const inEdgesOffsetsBuf = new SharedArrayBuffer((N + 1) * 4);
  const inEdgesOffsets = new Int32Array(inEdgesOffsetsBuf);
  let running = 0;
  for (let t = 0; t < N; t++) {
    inEdgesOffsets[t] = running;
    running += inCount[t]!;
  }
  inEdgesOffsets[N] = running;
  const inEdgesFlatBuf = new SharedArrayBuffer(ec * 4);
  const inEdgesFlat = new Int32Array(inEdgesFlatBuf);
  const cursor = new Int32Array(N);
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    inEdgesFlat[inEdgesOffsets[t]! + cursor[t]!] = s;
    cursor[t]! += 1;
  }
  const prBuf = new SharedArrayBuffer(N * 8);
  const nextBuf = new SharedArrayBuffer(N * 8);
  const pr = new Float64Array(prBuf);
  pr.fill(1 / N);
  return { outDegBuf, outDeg, inEdgesOffsetsBuf, inEdgesOffsets, inEdgesFlatBuf, prBuf, nextBuf, pr };
}

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing PageRank per-iter cost against: ${projectRoot}`);

  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    const nodes = getAllNodes(cg.queries);
    const N = nodes.length;
    const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
    const edges = cg.queries.db
      .prepare(`SELECT source, target FROM edges WHERE kind IN (${edgePlaceholders})`)
      .all(...PR_EDGE_KINDS) as PageRankEdge[];
    console.log(`graph: ${N.toLocaleString()} nodes, ${edges.length.toLocaleString()} PR-edges`);
    console.log(
      `PR_ITERATIONS=${PR_ITERATIONS}, PR_DAMPING=${PR_DAMPING}, workers=${Math.max(2, Math.min(os.cpus().length - 1, 16))}\n`,
    );

    // ─── Serial: total + per-iter mean ────────────────────────────────
    const serialT0 = Date.now();
    computePageRank(nodes, edges);
    const serialMs = Date.now() - serialT0;
    console.log(`serial total: ${serialMs}ms (mean per-iter ${(serialMs / PR_ITERATIONS).toFixed(2)}ms)`);

    // ─── Parallel: setup + per-iter compute + per-iter danglingSum ───
    // Inline a stripped/instrumented copy of computePageRankParallel
    // so we can stamp per-phase wall without modifying production code.
    const { Worker } = await import('node:worker_threads');
    const { fileURLToPath } = await import('node:url');
    const { partitionByLpt } = await import('../src/centrality/pagerank-parallel.js');
    const here = fileURLToPath(import.meta.url);
    const ext = here.endsWith('.ts') ? '.ts' : '.js';
    const workerPath = fileURLToPath(new URL(`../src/centrality/pagerank-worker${ext}`, import.meta.url));

    const setupT0 = Date.now();
    const { outDegBuf, outDeg, inEdgesOffsetsBuf, inEdgesOffsets, inEdgesFlatBuf, prBuf, nextBuf, pr } =
      buildCsrProbeData(nodes, edges);
    const csrMs = Date.now() - setupT0;

    // LPT partition
    const lptT0 = Date.now();
    const perTargetCounts = new Int32Array(N);
    for (let t = 0; t < N; t++) perTargetCounts[t] = inEdgesOffsets[t + 1]! - inEdgesOffsets[t]!;
    const workerCount = Math.max(2, Math.min(os.cpus().length - 1, 16));
    const targetsByWorker = partitionByLpt(perTargetCounts, workerCount);
    const lptMs = Date.now() - lptT0;

    // Spawn workers
    const spawnT0 = Date.now();
    const workers = targetsByWorker.map((targets) => {
      return new Worker(workerPath, {
        workerData: { targets, N, damping: PR_DAMPING, prBuf, nextBuf, outDegBuf, inEdgesFlatBuf, inEdgesOffsetsBuf },
      });
    });
    const spawnMs = Date.now() - spawnT0;

    // Per-iteration loop with phase timing
    const iterTotals: number[] = [];
    const danglingTotals: number[] = [];
    const computeTotals: number[] = [];
    const next = new Float64Array(nextBuf);
    for (let it = 0; it < PR_ITERATIONS; it++) {
      const iterT0 = Date.now();
      let danglingSum = 0;
      for (let i = 0; i < N; i++) if (outDeg[i] === 0) danglingSum += pr[i]!;
      const baseline = (1 - PR_DAMPING) / N;
      const basePlusDangling = baseline + (PR_DAMPING * danglingSum) / N;
      const danglingMs = Date.now() - iterT0;
      const computeT0 = Date.now();
      await new Promise<void>((resolve) => {
        let remaining = workers.length;
        for (const w of workers) {
          const l = (m: { type: string }): void => {
            if (m.type !== 'done') return;
            w.off('message', l);
            if (--remaining === 0) resolve();
          };
          w.on('message', l);
          w.postMessage({ type: 'step', basePlusDangling });
        }
      });
      const computeMs = Date.now() - computeT0;
      pr.set(next);
      iterTotals.push(Date.now() - iterT0);
      danglingTotals.push(danglingMs);
      computeTotals.push(computeMs);
    }
    await Promise.all(workers.map((w) => w.terminate()));

    const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
    const totalIterMs = sum(iterTotals);
    const totalDanglingMs = sum(danglingTotals);
    const totalComputeMs = sum(computeTotals);
    console.log(`parallel setup: csr=${csrMs}ms + lpt=${lptMs}ms + spawn=${spawnMs}ms = ${csrMs + lptMs + spawnMs}ms`);
    console.log(`parallel iter loop (40 iters): total=${totalIterMs}ms`);
    console.log(
      `  danglingSum (main-thread O(N)):  ${totalDanglingMs}ms (mean ${(totalDanglingMs / PR_ITERATIONS).toFixed(2)}ms/iter)`,
    );
    console.log(
      `  workers compute + IPC roundtrip: ${totalComputeMs}ms (mean ${(totalComputeMs / PR_ITERATIONS).toFixed(2)}ms/iter)`,
    );
    console.log(`  other (pr.set + bookkeeping):    ${totalIterMs - totalDanglingMs - totalComputeMs}ms`);
    console.log(`parallel wall: ${csrMs + lptMs + spawnMs + totalIterMs}ms vs serial ${serialMs}ms`);
  } finally {
    cg.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
