/**
 * G10.8 reproducer / diagnostic — exercises the
 * {@link HookWorkerClient} spawn/recycle/terminate lifecycle and
 * watches whether hook-worker children accumulate over time.
 *
 * Background: session 2026-05-21 observed two `hook-worker.ts`
 * children of an MCP server PID (76866 and 77199) sitting at 0% CPU,
 * 55+ minutes old, no IPC fd on the older one. The HookWorkerClient
 * pattern is supposed to have ONE child at a time per Cartograph
 * instance, recycled every 100 phases or on terminate(). Two
 * simultaneous children indicates either:
 *   (a) terminate()/recycle() called kill() but the child stayed alive;
 *   (b) a respawn fired before the prior child died.
 * The legacy `child_process.fork` shape was documented as having an
 * "IPC channel polling stops after ~1-in-3 spawns" bug (#27002 in the
 * codebase comment); Bun.spawn({ipc}) was the migration target. This
 * bench checks whether the equivalent failure mode recurred under Bun.
 *
 * Shape:
 *   1. Initialise a Cartograph in a temp dir (small synthetic project).
 *   2. Drive `sync()` N times. After each phase, snapshot the live
 *      hook-worker PIDs that descend from this process.
 *   3. Close the Cartograph; one final snapshot after a short settle.
 *   4. Report: peak concurrent children, total distinct PIDs across
 *      the run, final lingering count. Exit non-zero on lingering > 0.
 *
 * Tune via env:
 *   - `BENCH_PHASES=10` — number of `sync()` calls (default 10).
 *     Set ≥ 101 to exercise the RECYCLE_INTERVAL=100 path (fire-and-
 *     forget terminate + immediate re-spawn — the most plausible
 *     mechanical source of an orphan if a respawn fires before the
 *     prior child's IPC channel close is observed); ≥ 201 triggers
 *     it twice. Verified clean at 201 phases: 3 distinct PIDs
 *     observed across the run, peak concurrent = 1.
 *   - `BENCH_POST_CLOSE_WAIT_MS=500` — quiescence after close (default 500).
 *
 * Caveat: PID snapshots run AFTER each `await cg.sync()` resolves, not
 * during. A child that spawned + exited within one phase boundary
 * would be invisible. Peak-concurrent is therefore a LOWER BOUND on
 * the true peak; an orphan that lingers past a snapshot will show up.
 *
 * Run: `bun bench/hook-worker-spawn-cycle.mts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';

const PHASES = Number(process.env['BENCH_PHASES'] ?? 10);
const POST_CLOSE_WAIT_MS = Number(process.env['BENCH_POST_CLOSE_WAIT_MS'] ?? 500);

interface ChildSnapshot {
  readonly iter: number;
  readonly label: string;
  readonly pids: number[];
  readonly tMs: number;
}

function pgrepHookWorkerChildren(ownerPid: number): number[] {
  // pgrep emits one PID per line for every process whose command line
  // matches the pattern. Filter to ones parented to `ownerPid` so we
  // only see our own bench's children, not other live MCP servers.
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
      const ppid = Number(ppidRaw);
      if (ppid === ownerPid) out.push(pid);
    } catch {
      // Process disappeared between pgrep and ps — skip.
    }
  }
  return out;
}

async function main(): Promise<void> {
  const ownerPid = process.pid;
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spawn-cycle-'));
  fs.mkdirSync(path.join(tDir, 'src'));
  // Tiny project so each sync is fast.
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

  recordSnapshot(-1, 'pre-init');

  // `CARTOGRAPH_HOOKS_IN_PROCESS` MUST NOT be set — the in-process
  // shortcut bypasses the very child-spawn path this bench measures.
  if (process.env['CARTOGRAPH_HOOKS_IN_PROCESS']) {
    console.error('FATAL: CARTOGRAPH_HOOKS_IN_PROCESS is set; clear it to exercise the spawn path.');
    process.exit(2);
  }

  const cg = await Cartograph.init(tDir, { config: { llm: { endpoint: '' } } });
  recordSnapshot(-1, 'post-init');

  // Full index (warms parse cache + fires `runAfterIndexAll`).
  await cg.indexAll({ summarize: false });
  recordSnapshot(0, 'post-indexAll');

  for (let i = 1; i <= PHASES; i++) {
    await cg.sync();
    recordSnapshot(i, `post-sync-${i}`);
  }

  cg.close();
  // Give the SIGTERM time to land before snapshotting.
  await new Promise((r) => setTimeout(r, POST_CLOSE_WAIT_MS));
  recordSnapshot(PHASES + 1, 'post-close');

  fs.rmSync(tDir, { recursive: true, force: true });

  console.log('\n=== hook-worker spawn-cycle bench ===');
  console.log(`owner pid: ${ownerPid}, phases: ${PHASES}, post-close wait: ${POST_CLOSE_WAIT_MS}ms`);
  console.log('\nper-snapshot:');
  for (const s of snapshots) {
    console.log(
      `  ${String(s.tMs).padStart(6)}ms  ${s.label.padEnd(18)}  pids=[${s.pids.join(',')}]  (${s.pids.length})`,
    );
  }
  console.log('\nsummary:');
  console.log(`  peak concurrent children: ${peakConcurrent}`);
  console.log(`  distinct PIDs across run: ${allPidsSeen.size}`);
  const lingering = snapshots.at(-1)!.pids.length;
  console.log(`  lingering after close: ${lingering}`);
  if (peakConcurrent > 1) console.warn('  ⚠️  proliferation observed (>1 concurrent child)');
  if (lingering > 0) {
    console.error('  ❌ orphan children after close');
    process.exit(1);
  }
  console.log('  ✓ no orphans after close');
}

try {
  await main();
} catch (err) {
  console.error('bench failed:', err);
  process.exit(1);
}
