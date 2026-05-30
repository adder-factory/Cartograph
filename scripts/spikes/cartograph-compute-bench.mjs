// Benchmark cartograph's compute hot paths against the LIVE indexed data.
// Used during the 2026-05-09 embedding-features-arc planning to identify
// which compute step is the bottleneck for the 312k-symbol-in-minutes
// goal. Result: KNN (similar-edges) dominates (~35s on 5096 rows, would
// extrapolate to ~30 min at 312k); centrality is a non-issue (~5ms).
//
// Run from cartograph/ after build:
//   tsx scripts/spikes/cartograph-compute-bench.mjs
//
// What we measure:
//   1. PageRank centrality — pure-JS SpMV, currently the top postHook
//      on edge-heavy repos. Times computePageRank() in isolation (no DB writes).
//   2. Bulk KNN for similar_to edges — runs buildSimilarToEdges() and
//      measures the wall-clock to build the whole edge set.
//
// Output: per-iteration ms, median, ops/sec. Repeated N times to bound jitter.

import { performance } from 'node:perf_hooks';
import Cartograph from '../../src/index.js';
import { computePageRank, PR_EDGE_KINDS } from '../../src/centrality/index.js';
import { buildSimilarToEdges } from '../../src/embeddings/similar-edges.js';

const N_RUNS = 5;
const WARMUP = 2;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cg = await Cartograph.open('.');
const db = cg.queries.db;

// ── 1. PageRank ──────────────────────────────────────────────────
console.log('═══ PageRank centrality ═══');
const nodes = db.prepare('SELECT id FROM nodes').all();
const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
const edges = db.prepare(
  `SELECT source, target FROM edges WHERE kind IN (${edgePlaceholders})`,
).all(...PR_EDGE_KINDS);
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges (kinds: ${PR_EDGE_KINDS.join(', ')})`);

for (let i = 0; i < WARMUP; i++) computePageRank(nodes, edges);

const prTimes = [];
for (let i = 0; i < N_RUNS; i++) {
  const t0 = performance.now();
  const result = computePageRank(nodes, edges);
  const dt = performance.now() - t0;
  prTimes.push(dt);
  if (i === 0) {
    const top = [...result.scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`  top-3 by PR: ${top.map(([id, s]) => `${id.substring(0, 30)}=${s.toFixed(5)}`).join(', ')}`);
  }
}
console.log(`  per-run ms: [${prTimes.map((t) => t.toFixed(1)).join(', ')}]`);
console.log(`  median: ${median(prTimes).toFixed(1)}ms`);
console.log(`  effective edge-walks/sec: ${(edges.length * 40 / (median(prTimes) / 1000)).toFixed(0).toLocaleString()}`);

// ── 2. Bulk KNN (similar_to edges build) ─────────────────────────
console.log('\n═══ Bulk KNN — buildSimilarToEdges ═══');
const embedRowCount = db.prepare(
  'SELECT COUNT(*) AS c FROM symbol_embeddings WHERE embedding IS NOT NULL',
).get();
console.log(`embeddings: ${embedRowCount.c} rows`);

if (embedRowCount.c === 0) {
  console.log('  no embeddings present — skipping');
} else {
  for (let i = 0; i < WARMUP; i++) await buildSimilarToEdges(cg);

  const knnTimes = [];
  let lastResult = null;
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now();
    lastResult = await buildSimilarToEdges(cg);
    const dt = performance.now() - t0;
    knnTimes.push(dt);
  }
  console.log(`  per-run ms: [${knnTimes.map((t) => t.toFixed(0)).join(', ')}]`);
  console.log(`  median: ${median(knnTimes).toFixed(0)}ms`);
  if (lastResult) {
    console.log(`  result: ${lastResult.processed} processed, ${lastResult.written} edges${lastResult.reason ? ` (${lastResult.reason})` : ''}`);
    console.log(`  effective KNN queries/sec: ${(lastResult.processed / (median(knnTimes) / 1000)).toFixed(0).toLocaleString()}`);
  }
}

cg.close();
