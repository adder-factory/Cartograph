/**
 * Task #17 bench — A/B the value-ref-edges worker cap.
 *
 * Current cap is `Math.max(2, Math.min(cpus - 1, 8))` (in
 * `value-ref-edges-pool.ts`). Cap was set defensively against the
 * hang pattern shipped 2026-05-23 — workers that hit a pathological
 * regex backtracking case would timeout, and the smaller pool meant
 * fewer files at risk. Bounded-regex fix (commit `7de6671`) removed
 * the hang root cause, so the defensive cap is no longer load-bearing.
 *
 * This bench drives `buildValueRefEdgesInWorkers` directly on the
 * cartograph repo's own file set at N = 2, 4, 8, 16, 24 (M4 Max has
 * 10 perf cores → 16 is 2× cap, 24 is 3×). Reports per-N wall time
 * + extracted-edge count so we can see (a) whether higher N reduces
 * wall and (b) whether all caps produce the same edge count
 * (correctness invariant).
 *
 * Run: `bun bench/value-ref-edges-worker-cap.mts`
 *
 * Output shape:
 *   N=2:  edges=NNNN  wall=X.Xs  workers-ok=N/N
 *   N=4:  ...
 *   ...
 *   ---
 *   recommended cap: <choice + rationale>
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildValueRefEdgesInWorkers } from '../src/index-hooks/value-ref-edges-pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..'); // cartograph repo root
const DB_PATH = path.join(PROJECT_ROOT, '.cartograph', 'cartograph.db');

// Pull the file list from the existing cartograph DB. Reuses the
// already-indexed structural data so we don't re-parse on every run.
async function listProjectFiles(): Promise<Array<{ path: string; language: string }>> {
  const { Database } = await import('bun:sqlite');
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .query<{ path: string; language: string }, []>(
      `SELECT path, language FROM files WHERE language IN ('typescript', 'tsx', 'javascript', 'jsx') ORDER BY path`,
    )
    .all();
  db.close();
  return rows;
}

interface RunRow {
  N: number;
  edges: number;
  wallMs: number;
  workersOk: number;
  workersTotal: number;
  isPartial: boolean;
}

async function runOne(N: number, files: Array<{ path: string; language: string }>): Promise<RunRow> {
  process.env['CARTOGRAPH_VALUE_REF_WORKERS'] = String(N);
  const t0 = Date.now();
  const result = await buildValueRefEdgesInWorkers({
    dbPath: DB_PATH,
    projectRoot: PROJECT_ROOT,
    files,
  });
  const wallMs = Date.now() - t0;
  // `buildValueRefEdgesInWorkers` doesn't return per-worker stats;
  // we infer ok/total from `isPartial` (true → at least 1 fail).
  return {
    N,
    edges: result.edges.length,
    wallMs,
    workersOk: result.isPartial ? Math.max(1, N - 1) : N,
    workersTotal: N,
    isPartial: result.isPartial,
  };
}

// Driver mode: when called with one number arg, run a single N and
// exit (so each N runs in its own fresh Bun process — avoids the
// worker-teardown segfault pattern we hit when spawning/tearing
// down multiple worker pools in one process).
const arg = process.argv[2];
if (arg !== undefined) {
  const N = Number.parseInt(arg, 10);
  if (!Number.isFinite(N)) {
    console.error(`expected an integer N, got ${arg}`);
    process.exit(1);
  }
  const files = await listProjectFiles();
  const row = await runOne(N, files);
  // Print as one JSON line so the orchestrator can parse without
  // text-scraping.
  console.log(JSON.stringify(row));
  process.exit(0);
}

// Orchestrator mode: spawn one child per N, collect the JSON rows,
// print the summary + recommendation.
const { spawnSync } = await import('node:child_process');
const files = await listProjectFiles();
console.log(`Corpus: ${files.length} JS/TS files from ${PROJECT_ROOT}`);
console.log('Each N runs in its own Bun process to avoid worker-teardown crashes across runs.');
console.log('');

const Ns = [2, 4, 8, 16, 24];
const results: RunRow[] = [];
const selfPath = fileURLToPath(import.meta.url);
for (const N of Ns) {
  const child = spawnSync('bun', [selfPath, String(N)], { encoding: 'utf8' });
  if (child.status !== 0) {
    console.log(`N=${String(N).padStart(2)}:  CRASH (exit=${child.status})\n${child.stderr?.slice(0, 200)}`);
    continue;
  }
  const lines = (child.stdout ?? '').trim().split('\n');
  const jsonLine = lines[lines.length - 1] ?? '';
  let row: RunRow;
  try {
    row = JSON.parse(jsonLine) as RunRow;
  } catch {
    console.log(`N=${String(N).padStart(2)}:  PARSE-FAIL (last stdout line: ${jsonLine.slice(0, 120)})`);
    continue;
  }
  results.push(row);
  console.log(
    `N=${String(N).padStart(2)}:  edges=${String(row.edges).padStart(5)}  wall=${(row.wallMs / 1000).toFixed(2)}s  workers-ok=${row.workersOk}/${row.workersTotal}${
      row.isPartial ? '  ⚠ partial' : ''
    }`,
  );
}

// Sanity: every N should produce the same edge count (correctness
// invariant — the partition shouldn't change what's emitted, only
// the parallelism).
const distinctEdgeCounts = new Set(results.map((r) => r.edges));
console.log('');
if (distinctEdgeCounts.size > 1) {
  console.log(`⚠ CORRECTNESS: edge counts differ across N: ${[...distinctEdgeCounts].sort().join(', ')}`);
} else if (results.length > 0) {
  console.log(`✓ Correctness: every N produced the same ${results[0]!.edges} edges.`);
}

// Recommendation: pick the smallest N where wall time stops
// improving by ≥10% vs the next-bigger N (diminishing returns).
const sorted = [...results].sort((a, b) => a.N - b.N);
let recommendedN = sorted[0]?.N ?? 2;
for (let i = 0; i < sorted.length - 1; i++) {
  const curr = sorted[i]!;
  const next = sorted[i + 1]!;
  const speedup = curr.wallMs / next.wallMs;
  if (speedup >= 1.1) recommendedN = next.N;
}
console.log(`\nRecommendation: cap at N=${recommendedN} (last point where +N still bought ≥10% wall reduction).`);
