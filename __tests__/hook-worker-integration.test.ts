/**
 * Integration test for the forked hook-worker — the child-side
 * contract the test-runner unit suite cannot reach.
 *
 * The test runner forces the in-process fallback
 * (`CARTOGRAPH_HOOKS_IN_PROCESS=1` in package.json scripts) because
 * the forked child cannot resolve the project's TypeScript via the
 * runner's loader. So the real fork + IPC + spawn-handshake path is
 * exercised here by spawning `__tests__/fixtures/hook-worker-smoke.ts`
 * under `bun` — a fresh process tree where bun's native TS resolver
 * is live — with `CARTOGRAPH_HOOKS_IN_PROCESS` cleared.
 *
 * `bun` is the runtime the live `cartograph serve --mcp` uses
 * post-2026-05-20 all-in-Bun migration (tsx cannot import bun:sqlite
 * / bun:ffi). When it is not on PATH (a bare CI image) the test
 * SKIPS rather than fails — it cannot meaningfully run, and a skip
 * is honest about that.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve `bun` on PATH, or null when it is unavailable. */
function resolveBun(): string | null {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  return probe.status === 0 ? 'bun' : null;
}

const bunBin = resolveBun();

describe('hook worker — integration (forked child under bun)', () => {
  it.skipIf(bunBin === null)(
    'runs the real hook phase in a forked child and returns outcomes',
    () => {
      const harness = fileURLToPath(new URL('./fixtures/hook-worker-smoke.ts', import.meta.url));
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hookworker-'));
      try {
        // Clear the in-process override the suite sets — the spawned
        // process must take the real forked-child path.
        const env = { ...process.env };
        delete env['CARTOGRAPH_HOOKS_IN_PROCESS'];

        const run = spawnSync(bunBin as string, [harness, projectDir], {
          encoding: 'utf-8',
          timeout: 120_000,
          env,
        });

        const verdictLine = (run.stdout ?? '').split('\n').find((l) => l.includes('__HOOK_WORKER_SMOKE__'));
        expect(
          verdictLine,
          `harness emitted no verdict (exit=${run.status}).\n` + `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        ).toBeTruthy();

        const verdict = JSON.parse(verdictLine!.slice(verdictLine!.indexOf('{'))) as {
          ok: boolean;
          viaWorker?: boolean;
          names?: string[] | null;
          error?: string;
        };

        // The decisive assertion: the phase ran in the forked child,
        // not the in-process fallback.
        expect(verdict.viaWorker, `expected the forked child to run; verdict: ${JSON.stringify(verdict)}`).toBe(true);
        expect(verdict.ok, `harness verdict: ${JSON.stringify(verdict)}`).toBe(true);
        expect(verdict.names).toContain('centrality');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
    130_000,
  );
});
