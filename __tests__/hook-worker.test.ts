/**
 * `HookWorkerClient` — the main-process handle to the off-thread
 * index-hook runner.
 *
 * The forked child cannot resolve the project's TypeScript under the
 * vitest harness's loader, so the child path itself is not exercised
 * here (it is covered by the `cartograph admin sync` CLI smoke, which
 * runs under tsx). What these tests pin is the CLIENT's contract that
 * `Cartograph.sync` / `indexAll` depend on:
 *
 *  - `runPhase` returns `null` when the client is disabled — the
 *    signal for the caller to run hooks in-process.
 *  - `runPhase` NEVER hangs and NEVER throws when the child cannot be
 *    spawned — it rejects the spawn handshake and returns `null`. This
 *    is the regression guard for the bug where an early child `exit`
 *    (no `ready`, no `error` event) left the spawn promise unsettled.
 *  - `terminate` is a safe no-op before any spawn and is idempotent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  HookWorkerClient,
  PHASE_TIMEOUT_MS_INDEX_ALL,
  PHASE_TIMEOUT_MS_SYNC,
  phaseTimeoutMs,
  type RunPhaseArgs,
} from '../src/index-hooks/hook-worker-client.js';
import { HOOK_TIMEOUT_MS } from '../src/index-hooks/registry.js';
import type { CartographConfig } from '../src/types.js';

const HOOKS_IN_PROCESS_ENV = 'CARTOGRAPH_HOOKS_IN_PROCESS';

// The `test:fast` npm script's outer wrapper sets
// CARTOGRAPH_HOOKS_IN_PROCESS=1 for the whole suite (the bun:test
// migration moved this out of the deleted vitest.config.ts). Raw
// `bun test __tests__/hook-worker.test.ts` runs without it set, so
// the assertion at the top of the first test (which probes the env
// var as a precondition) used to fail. Hoist the env-set to the
// file level so the file is invocation-agnostic — passes the same
// under `bun test` direct or via `npm run test:fast`.
let savedHooksInProcess: string | undefined;
beforeAll(() => {
  savedHooksInProcess = process.env[HOOKS_IN_PROCESS_ENV];
  process.env[HOOKS_IN_PROCESS_ENV] = '1';
});
afterAll(() => {
  if (savedHooksInProcess === undefined) delete process.env[HOOKS_IN_PROCESS_ENV];
  else process.env[HOOKS_IN_PROCESS_ENV] = savedHooksInProcess;
});

const phaseArgs: RunPhaseArgs = {
  phase: 'sync',
  projectRoot: '/tmp/does-not-exist-cartograph-hook-test',
  dbPath: '/tmp/does-not-exist-cartograph-hook-test/.cartograph/cartograph.db',
  config: {} as CartographConfig,
  syncResult: {
    filesChecked: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    nodesUpdated: 0,
    durationMs: 0,
  },
};

describe('HookWorkerClient', () => {
  it('runPhase returns null when disabled via CARTOGRAPH_HOOKS_IN_PROCESS', async () => {
    // The file-level beforeAll above sets CARTOGRAPH_HOOKS_IN_PROCESS=1
    // so a default-constructed client is disabled regardless of how
    // this file is invoked.
    expect(process.env[HOOKS_IN_PROCESS_ENV]).toBeTruthy();
    const client = new HookWorkerClient();
    const result = await client.runPhase(phaseArgs);
    expect(result).toBeNull();
  });

  it('terminate is a safe, idempotent no-op before any spawn', async () => {
    const client = new HookWorkerClient();
    await expect(client.terminate()).resolves.toBeUndefined();
    await expect(client.terminate()).resolves.toBeUndefined();
  });

  // B1 (2026-05-23) — the whole-phase wall-clock budget is phase-shaped.
  // Sync (small changeset) reuses the 5-min per-hook cap; indexAll (full
  // pass with cross-file biomarkers + centrality on the whole graph) gets
  // 30 min so a large repo doesn't get its post-hook killed mid-run.
  // Symptom that motivated the split: microsoft/TypeScript indexAll hit
  // the 5-min cap, leaving `code_health_findings` empty and surfacing as
  // a false "Project clean ✓".
  it('phaseTimeoutMs returns the per-phase budget — 5 min for sync, 30 min for indexAll', () => {
    expect(PHASE_TIMEOUT_MS_SYNC).toBe(HOOK_TIMEOUT_MS);
    expect(PHASE_TIMEOUT_MS_INDEX_ALL).toBe(30 * 60 * 1000);
    expect(phaseTimeoutMs('sync')).toBe(PHASE_TIMEOUT_MS_SYNC);
    expect(phaseTimeoutMs('indexAll')).toBe(PHASE_TIMEOUT_MS_INDEX_ALL);
    // The whole point of the split: indexAll must be strictly more
    // generous than sync, or the original bug regresses.
    expect(PHASE_TIMEOUT_MS_INDEX_ALL).toBeGreaterThan(PHASE_TIMEOUT_MS_SYNC);
  });

  it('runPhase never hangs or throws when the child cannot spawn', async () => {
    // Force a real fork attempt by clearing the in-process override.
    // The forked child cannot resolve the project TS under the vitest
    // loader, so it exits early without a `ready` handshake — the
    // client must reject the spawn and return null (NOT hang on an
    // unsettled promise). Regression guard for the spawn-handshake bug.
    const saved = process.env['CARTOGRAPH_HOOKS_IN_PROCESS'];
    delete process.env['CARTOGRAPH_HOOKS_IN_PROCESS'];
    try {
      const client = new HookWorkerClient();
      const result = await client.runPhase(phaseArgs);
      // null (spawn failed → caller falls back) is the expected
      // outcome under the harness; an outcome array would mean the
      // child somehow ran. Either is valid — a hang/throw is not.
      expect(result === null || Array.isArray(result)).toBe(true);
      await client.terminate();
    } finally {
      if (saved !== undefined) process.env['CARTOGRAPH_HOOKS_IN_PROCESS'] = saved;
    }
  }, 30_000);
});
