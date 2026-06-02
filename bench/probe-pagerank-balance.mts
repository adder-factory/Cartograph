/**
 * PageRank worker-pool load-balance probe.
 *
 * Loads nodes + PR_EDGE_KINDS edges from an indexed project, builds
 * the per-target in-degree distribution, and reports:
 *
 *   1. The actual contiguous partition the current
 *      `computePageRankParallel` would use (`partitionRange(N, W)`).
 *   2. The per-partition SUM of in-edges (= per-worker compute cost
 *      proxy — each per-target contribution is one inner-loop step,
 *      which sums in-edges).
 *   3. The MAX vs MEAN ratio across partitions (≫ 1.0 means the
 *      contiguous partition is imbalanced; ≈ 1.0 means it's already
 *      balanced and work-stealing/LPT wouldn't help).
 *   4. A what-if comparison: round-robin partition + LPT bin-pack
 *      partition over the same per-target sizes.
 *   5. The actual wall-clock comparison: serial PageRank vs current
 *      parallel PageRank.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path bun bench/probe-pagerank-balance.mts
 */

import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getAllNodes } from '../src/db/queries.js';
import { computePageRank, PR_EDGE_KINDS } from '../src/centrality/index.js';
import { computePageRankParallel } from '../src/centrality/pagerank-parallel.js';
import * as os from 'node:os';

function partitionRangeContiguous(N: number, workerCount: number): Array<{ tStart: number; tEnd: number }> {
  const slices: Array<{ tStart: number; tEnd: number }> = [];
  const base = Math.floor(N / workerCount);
  let cursor = 0;
  for (let i = 0; i < workerCount; i++) {
    const tStart = cursor;
    const tEnd = i === workerCount - 1 ? N : cursor + base;
    slices.push({ tStart, tEnd });
    cursor = tEnd;
  }
  return slices;
}

function lptPartition(inEdgeCounts: Int32Array, workerCount: number): number[][] {
  // Longest-Processing-Time-First bin pack. Sort target indices by
  // their in-edge count desc, then greedily assign each to the
  // currently-least-loaded worker.
  const order = Array.from({ length: inEdgeCounts.length }, (_, i) => i).sort(
    (a, b) => inEdgeCounts[b]! - inEdgeCounts[a]!,
  );
  const buckets: number[][] = Array.from({ length: workerCount }, () => []);
  const loads = new Array<number>(workerCount).fill(0);
  for (const t of order) {
    let minIdx = 0;
    let minLoad = loads[0]!;
    for (let i = 1; i < workerCount; i++) {
      if (loads[i]! < minLoad) {
        minLoad = loads[i]!;
        minIdx = i;
      }
    }
    buckets[minIdx]!.push(t);
    loads[minIdx]! += inEdgeCounts[t]!;
  }
  return buckets;
}

function sumLoad(targets: number[], inEdgeCounts: Int32Array): number {
  let s = 0;
  for (const t of targets) s += inEdgeCounts[t]!;
  return s;
}

function describePartition(label: string, loads: number[], total: number): void {
  const max = Math.max(...loads);
  const min = Math.min(...loads);
  const mean = total / loads.length;
  const imbalance = max / mean;
  const loadCsv = loads.map((l) => l.toLocaleString()).join(', ');
  console.log(
    `  ${label.padEnd(26)} min=${min.toLocaleString().padStart(10)} max=${max.toLocaleString().padStart(10)} mean=${Math.round(mean).toLocaleString().padStart(10)} max/mean=${imbalance.toFixed(2)}×`,
  );
  console.log(`  ${''.padEnd(26)} per-worker: [${loadCsv}]`);
}

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing PageRank load balance against: ${projectRoot}\n`);

  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    const nodes = getAllNodes(cg.queries);
    const N = nodes.length;
    const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
    const edges = cg.queries.db
      .prepare(`SELECT source, target FROM edges WHERE kind IN (${edgePlaceholders})`)
      .all(...PR_EDGE_KINDS) as Array<{ source: string; target: string }>;

    console.log(`graph: ${N.toLocaleString()} nodes, ${edges.length.toLocaleString()} PR-edges`);

    // Build per-target in-degree distribution.
    const idx = new Map<string, number>();
    for (let i = 0; i < N; i++) idx.set(nodes[i]!.id, i);
    const inEdgeCounts = new Int32Array(N);
    for (const e of edges) {
      const t = idx.get(e.target);
      if (t !== undefined) inEdgeCounts[t]! += 1;
    }
    const totalEdges = inEdgeCounts.reduce((s, c) => s + c, 0);

    // Distribution summary.
    const sortedDeg = [...inEdgeCounts].sort((a, b) => b - a);
    const p99 = sortedDeg[Math.floor(N * 0.01)] ?? 0;
    const p95 = sortedDeg[Math.floor(N * 0.05)] ?? 0;
    const p50 = sortedDeg[Math.floor(N * 0.5)] ?? 0;
    console.log(`in-degree: max=${sortedDeg[0] ?? 0} p99=${p99} p95=${p95} median=${p50}  (power-law if max ≫ median)`);

    // 8 workers is the default cap (os.cpus()-1 ≤ 16, but POOL_CEILING is 16).
    const workerCount = Math.max(2, Math.min(os.cpus().length - 1, 16));
    console.log(`worker count: ${workerCount}\n`);

    // ─── Current: contiguous partition ─────────────────────────────────
    const contig = partitionRangeContiguous(N, workerCount);
    const contigLoads = contig.map(({ tStart, tEnd }) => {
      let s = 0;
      for (let t = tStart; t < tEnd; t++) s += inEdgeCounts[t]!;
      return s;
    });
    console.log('partition strategies (per-worker SUM of in-edges = compute cost proxy):');
    describePartition('contiguous (current)', contigLoads, totalEdges);

    // ─── Round-robin ───────────────────────────────────────────────────
    const rrBuckets: number[][] = Array.from({ length: workerCount }, () => []);
    for (let t = 0; t < N; t++) rrBuckets[t % workerCount]!.push(t);
    const rrLoads = rrBuckets.map((b) => sumLoad(b, inEdgeCounts));
    describePartition('round-robin', rrLoads, totalEdges);

    // ─── LPT bin pack ──────────────────────────────────────────────────
    const lptBuckets = lptPartition(inEdgeCounts, workerCount);
    const lptLoads = lptBuckets.map((b) => sumLoad(b, inEdgeCounts));
    describePartition('LPT bin-pack', lptLoads, totalEdges);

    // ─── Actual wall comparison ────────────────────────────────────────
    console.log('\nwall-clock comparison (3 runs each, median ms):');
    const serialTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      computePageRank(nodes, edges);
      serialTimes.push(Date.now() - t0);
    }
    const parTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await computePageRankParallel(nodes, edges);
      parTimes.push(Date.now() - t0);
    }
    const med = (xs: number[]): number => {
      const sorted = [...xs];
      sorted.sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    console.log(`  serial:   ${serialTimes.map((m) => m + 'ms').join(' / ')}  →  median ${med(serialTimes)}ms`);
    console.log(`  parallel: ${parTimes.map((m) => m + 'ms').join(' / ')}  →  median ${med(parTimes)}ms`);
    console.log(
      `  speedup: ${(med(serialTimes) / med(parTimes)).toFixed(2)}× (theoretical ceiling on perfect balance: ${workerCount}×)`,
    );

    const contigImbalance = Math.max(...contigLoads) / (totalEdges / workerCount);
    const lptImbalance = Math.max(...lptLoads) / (totalEdges / workerCount);
    console.log(
      `\nUpside of LPT vs contiguous: ${(contigImbalance / lptImbalance).toFixed(2)}× theoretical wall reduction (assuming compute is in-edge-proportional + perfect parallelism inside a worker).`,
    );
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
