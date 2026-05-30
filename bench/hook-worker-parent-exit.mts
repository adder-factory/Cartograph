/**
 * G10.8 reproducer candidate B — parent exits without explicit terminate.
 *
 * Hypothesis: the observed orphan children (PIDs 76866 / 77199 of MCP
 * PID 76819) survive because their parent's IPC channel was closed but
 * the child's `process.on('disconnect', () => process.exit(0))` handler
 * didn't fire under Bun's IPC adapter. The previous bench
 * (`hook-worker-spawn-cycle.mts`) proves the normal `close()` →
 * `terminate()` → `kill()` path is clean; this bench tests the
 * normal-process-exit path that the OS handles, which is what would
 * happen on a parent crash or SIGKILL.
 *
 * Shape: parent forks a Cartograph instance + hook-worker child, fires
 * one indexAll, prints the child PID, then exits WITHOUT calling
 * `cg.close()` or `hookWorker.terminate()`. The script's caller wraps
 * this in a shell that records the child PID, waits a moment after
 * exit, then `ps -p $CHILD_PID` to see whether the child survived.
 *
 * Expected on a healthy system: the child exits within ~100ms of the
 * parent's exit (SIGHUP from the OS or `disconnect` event closes it).
 * Failure mode (G10.8 hypothesis): the child sits idle on the event
 * loop, identical to PIDs 76866 / 77199.
 *
 * Run: see `scripts/hook-worker-parent-exit-runner.sh` which drives
 * this from outside and checks for orphan survival.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';

async function main(): Promise<void> {
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parent-exit-'));
  fs.mkdirSync(path.join(tDir, 'src'));
  fs.writeFileSync(
    path.join(tDir, 'src', 'a.ts'),
    'export function add(a: number, b: number): number { return a + b; }\n',
  );
  fs.writeFileSync(path.join(tDir, '.gitignore'), '.cartograph/\n');

  const cg = await Cartograph.init(tDir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });

  // Probe the child PID so the outer runner can monitor it.
  const ownPid = process.pid;
  const raw = execFileSync('pgrep', ['-f', 'hook-worker'], { encoding: 'utf8' });
  const childPids: number[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!/^\d+$/.test(t)) continue;
    const pid = Number(t);
    try {
      const ppidRaw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (Number(ppidRaw) === ownPid) childPids.push(pid);
    } catch {
      // disappeared
    }
  }
  // Print one line: PARENT=<pid> CHILDREN=<csv>
  console.log(`PARENT=${ownPid} CHILDREN=${childPids.join(',')} TEMPDIR=${tDir}`);

  // NB: deliberately NOT calling cg.close() or hookWorker.terminate().
  // The OS will reap the parent, and we observe externally whether the
  // child shuts down on its own via the `disconnect` event or sticks.
}

void main().then(
  () => {
    // Normal exit — Bun should fire 'disconnect' on the child's IPC
    // channel as the parent's end closes.
    process.exit(0);
  },
  (err) => {
    console.error('parent-exit bench failed:', err);
    process.exit(1);
  },
);
