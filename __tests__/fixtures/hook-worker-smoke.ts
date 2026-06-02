/**
 * Runnable smoke harness for the forked hook-worker — executed UNDER
 * `tsx` by `__tests__/hook-worker-integration.test.ts`.
 *
 * It must run under tsx, NOT vitest: the hook-worker child needs tsx's
 * `.js`→`.ts` module resolver, which only activates in a tsx-launched
 * process tree (see `src/index-hooks/hook-worker.ts`). The vitest suite
 * forces the in-process fallback (`CARTOGRAPH_HOOKS_IN_PROCESS=1`), so
 * the real fork/IPC/handshake path can only be exercised here.
 *
 * Initialises an empty temp project (just `.cartograph/` + schema — no
 * indexing needed; the hooks run fine on an empty graph), drives
 * `HookWorkerClient.runPhase` directly, and prints a one-line JSON
 * verdict. A non-null outcome array proves the fork + IPC + handshake
 * worked and the child ran the real hook registry; `null` would mean
 * it fell back to in-process.
 *
 * Usage: `tsx hook-worker-smoke.ts <projectDir>`
 */

import { Cartograph, getDatabasePath } from '../../src/index.js';
import { HookWorkerClient } from '../../src/index-hooks/hook-worker-client.js';

/** stdout marker so the test can find the verdict amid other output. */
const MARKER = '__HOOK_WORKER_SMOKE__';

async function main(): Promise<void> {
  const projectDir = process.argv[2];
  if (!projectDir) throw new Error('usage: hook-worker-smoke.ts <projectDir>');

  const cg = Cartograph.initSync(projectDir);
  const client = new HookWorkerClient();
  let outcomes: Awaited<ReturnType<HookWorkerClient['runPhase']>>;
  try {
    outcomes = await client.runPhase({
      phase: 'sync',
      projectRoot: cg.projectRoot,
      dbPath: getDatabasePath(cg.projectRoot),
      config: cg.config,
      syncResult: {
        filesChecked: 0,
        filesAdded: 0,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 0,
      },
    });
  } finally {
    await client.terminate();
    cg.close();
  }

  const names = Array.isArray(outcomes) ? outcomes.map((o) => o.name) : null;
  // `viaWorker`: a non-null array means the forked child ran the phase
  // (null is the in-process-fallback signal). `ok` additionally checks
  // a known registered hook ran — i.e. the child executed the real
  // hook registry, not a stub.
  const ok = Array.isArray(outcomes) && outcomes.length > 0 && names!.includes('centrality');
  console.log(`${MARKER}${JSON.stringify({ ok, viaWorker: outcomes !== null, names })}`);
  process.exit(ok ? 0 : 1);
}

try {
  await main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`${MARKER}${JSON.stringify({ ok: false, error: message })}`);
  process.exit(1);
}
