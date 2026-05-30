/**
 * G10.8 reproducer candidate C — rapid forced terminate+respawn cycles.
 *
 * The first bench (`hook-worker-spawn-cycle.mts`) drives `cg.sync()`
 * sequentially: the natural recycle is at every 100th phase, so the
 * spawn/kill rhythm is slow. This bench forces an explicit
 * `hookWorker.terminate()` BETWEEN each `cg.sync()`, so every sync
 * fires a fresh `ensureSpawned`. If `kill()` ever fails to take
 * effect before the next `Bun.spawn` succeeds, an orphan accumulates.
 * Same snapshot-after-each-phase shape as the spawn-cycle bench; an
 * orphan that lingers past one phase boundary surfaces.
 *
 * Also exercises a genuine concurrent-spawn race: every
 * BENCH_CONCURRENT_EVERY iteration, four `hookWorker.runPhase(...)`
 * calls fire in parallel. They BYPASS `cg.sync()`'s mutex (which
 * would serialize the four), so they hit `ensureSpawned` concurrently
 * and share its cached `ready` promise. This is the closest analogue
 * the bench can synthesise for the live-MCP failure shape, where the
 * watcher fires async events while MCP tool requests are in flight.
 *
 * Tune via env:
 *   - `BENCH_ITERATIONS=20` — number of terminate/respawn cycles.
 *   - `BENCH_CONCURRENT_EVERY=5` — fire a 4-parallel-syncs burst every N iterations.
 *   - `BENCH_POST_CLOSE_WAIT_MS=500` — quiescence after final close.
 *
 * Run: `bun bench/hook-worker-rapid-terminate.mts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import type { CartographInternals } from '../src/index.js';
import { getDatabasePath } from '../src/db/index.js';

const ITERATIONS = Number(process.env['BENCH_ITERATIONS'] ?? 20);
const CONCURRENT_EVERY = Number(process.env['BENCH_CONCURRENT_EVERY'] ?? 5);
const POST_CLOSE_WAIT_MS = Number(process.env['BENCH_POST_CLOSE_WAIT_MS'] ?? 500);

interface ChildSnapshot {
  readonly iter: number;
  readonly label: string;
  readonly pids: number[];
  readonly tMs: number;
}

function pgrepHookWorkerChildren(ownerPid: number): number[] {
  let raw: string;
  try {
    raw = execFileSync('pgrep', ['-f', 'hook-worker'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!/^\d+$/.test(t)) continue;
    const pid = Number(t);
    try {
      const ppidRaw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (Number(ppidRaw) === ownerPid) out.push(pid);
    } catch {
      // process disappeared
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (process.env['CARTOGRAPH_HOOKS_IN_PROCESS']) {
    console.error('FATAL: CARTOGRAPH_HOOKS_IN_PROCESS is set; clear it to exercise the spawn path.');
    process.exit(2);
  }

  const ownerPid = process.pid;
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rapid-term-'));
  fs.mkdirSync(path.join(tDir, 'src'));
  fs.writeFileSync(
    path.join(tDir, 'src', 'a.ts'),
    'export function add(a: number, b: number): number { return a + b; }\n',
  );
  fs.writeFileSync(path.join(tDir, 'src', 'b.ts'), 'import { add } from "./a";\nexport const sum = add(1, 2);\n');
  fs.writeFileSync(path.join(tDir, '.gitignore'), '.cartograph/\n');

  const tStart = Date.now();
  const snapshots: ChildSnapshot[] = [];
  const allPidsSeen = new Set<number>();
  let peakConcurrent = 0;

  const recordSnapshot = (iter: number, label: string): void => {
    const pids = pgrepHookWorkerChildren(ownerPid);
    for (const p of pids) allPidsSeen.add(p);
    if (pids.length > peakConcurrent) peakConcurrent = pids.length;
    snapshots.push({ iter, label, pids, tMs: Date.now() - tStart });
  };

  const cg = await Cartograph.init(tDir, { config: { llm: { endpoint: '' } } });
  // `internals.hookWorker` is the public `@internal` field on the
  // Cartograph instance — used here to drive the spawn lifecycle
  // directly, bypassing the sync() mutex for the concurrent-burst path.
  const internals = (cg as unknown as { internals: CartographInternals }).internals;
  const hw = internals.hookWorker;
  const dbPath = getDatabasePath(cg.projectRoot);

  await cg.indexAll({ summarize: false });
  recordSnapshot(0, 'post-indexAll');

  for (let i = 1; i <= ITERATIONS; i++) {
    // Force a terminate BEFORE the next sync. The next sync's runPhase
    // calls ensureSpawned which spawns a fresh child.
    await hw.terminate();
    recordSnapshot(i, `post-term-${i}`);

    const isConcurrentBurst = i % CONCURRENT_EVERY === 0;
    if (isConcurrentBurst) {
      // 4 genuinely-concurrent `runPhase` calls — they bypass the
      // sync() mutex and hit ensureSpawned in parallel, sharing its
      // cached `ready` promise. The four calls each get a unique id
      // and the single spawned child handles them all.
      const runPhaseArgs = {
        phase: 'sync' as const,
        projectRoot: cg.projectRoot,
        dbPath,
        config: cg.config,
        syncResult: {
          filesChecked: 0,
          filesAdded: 0,
          filesModified: 0,
          filesRemoved: 0,
          nodesUpdated: 0,
          durationMs: 0,
        },
      };
      await Promise.all([
        hw.runPhase(runPhaseArgs),
        hw.runPhase(runPhaseArgs),
        hw.runPhase(runPhaseArgs),
        hw.runPhase(runPhaseArgs),
      ]);
      recordSnapshot(i, `post-burst-${i}`);
    } else {
      await cg.sync();
      recordSnapshot(i, `post-sync-${i}`);
    }
  }

  cg.close();
  await new Promise((r) => setTimeout(r, POST_CLOSE_WAIT_MS));
  recordSnapshot(ITERATIONS + 1, 'post-close');

  fs.rmSync(tDir, { recursive: true, force: true });

  console.log('\n=== hook-worker rapid-terminate bench ===');
  console.log(`owner pid: ${ownerPid}, iterations: ${ITERATIONS}, concurrent burst every ${CONCURRENT_EVERY}`);
  console.log('\nper-snapshot:');
  for (const s of snapshots) {
    console.log(
      `  ${String(s.tMs).padStart(6)}ms  ${s.label.padEnd(20)}  pids=[${s.pids.join(',')}]  (${s.pids.length})`,
    );
  }
  console.log('\nsummary:');
  console.log(`  peak concurrent children: ${peakConcurrent}`);
  console.log(`  distinct PIDs across run: ${allPidsSeen.size}`);
  const lingering = snapshots[snapshots.length - 1]!.pids.length;
  console.log(`  lingering after close: ${lingering}`);
  if (peakConcurrent > 1) console.warn('  ⚠️  proliferation observed (>1 concurrent child)');
  if (lingering > 0) {
    console.error('  ❌ orphan children after close');
    process.exit(1);
  }
  console.log('  ✓ no orphans after close');
}

void main().catch((err) => {
  console.error('bench failed:', err);
  process.exit(1);
});
