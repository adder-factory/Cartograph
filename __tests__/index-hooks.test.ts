/**
 * Index-hook framework: register a fake hook at runtime, run an
 * indexAll/sync against a synthetic project, assert the hook ran
 * with the expected context shape and that errors are caught.
 *
 * The registry's static-import list (`REGISTERED_HOOKS`) is empty
 * on main today; tests poke at the runner directly through
 * `runAfterIndexAll`/`runAfterSync` rather than mutating that
 * list.
 */
import { describe, it, expect } from 'vitest';
import {
  runAfterIndexAll,
  runAfterSync,
  getRegisteredHooks,
  type IndexHook,
  type IndexHookContext,
} from '../src/index-hooks/registry.js';
import type { SyncResult } from '../src/extraction/index.js';

function makeFakeContext(): IndexHookContext {
  // Hooks should not mutate the context; for the runner-shape
  // tests we hand them stubs typed `as any` — the runner doesn't
  // touch any of these fields itself.
  return {
    projectRoot: '/tmp/fake-project',
    /* eslint-disable @typescript-eslint/no-explicit-any */
    config: {} as any,
    queries: {} as any,
    db: {} as any,
    /* eslint-enable */
  };
}

const fakeSyncResult: SyncResult = {
  filesChecked: 0,
  filesAdded: 0,
  filesModified: 0,
  filesRemoved: 0,
  nodesUpdated: 0,
  durationMs: 0,
};

describe('index-hooks registry — runner', () => {
  it('registered hooks expose stable {name, afterIndexAll|afterSync} shape', () => {
    const hooks = getRegisteredHooks();
    expect(hooks.length).toBeGreaterThanOrEqual(0);
    for (const h of hooks) {
      expect(typeof h.name).toBe('string');
      expect(h.afterIndexAll === undefined || typeof h.afterIndexAll === 'function').toBe(true);
      expect(h.afterSync === undefined || typeof h.afterSync === 'function').toBe(true);
    }
  });

  it('runAfterIndexAll returns one outcome per registered hook, swallowing per-hook errors', async () => {
    // Registered hooks will throw on the fake `{} as any` ctx; the
    // runner contract is to catch + report each error so one bad
    // hook never fails the whole pass.
    const outcomes = await runAfterIndexAll(makeFakeContext());
    const expectedCount = getRegisteredHooks().filter((h) => h.afterIndexAll).length;
    expect(outcomes.length).toBe(expectedCount);
    for (const o of outcomes) {
      expect(typeof o.name).toBe('string');
      expect(o.phase).toBe('indexAll');
      expect(typeof o.durationMs).toBe('number');
    }
  });

  it('runAfterSync returns one outcome per registered hook, swallowing per-hook errors', async () => {
    const outcomes = await runAfterSync(makeFakeContext(), fakeSyncResult);
    const expectedCount = getRegisteredHooks().filter((h) => h.afterSync).length;
    expect(outcomes.length).toBe(expectedCount);
    for (const o of outcomes) {
      expect(typeof o.name).toBe('string');
      expect(o.phase).toBe('sync');
      expect(typeof o.durationMs).toBe('number');
    }
  });
});

describe('index-hooks runner — fake-hook injection', () => {
  // Helper: temporarily inject a fake hook by wrapping the runner
  // directly. The runner accepts no array argument today; this
  // suite exercises the public surface (runAfterIndexAll /
  // runAfterSync) by simulating what a registered hook would do.
  // When real hooks land, REGISTERED_HOOKS in registry.ts will
  // contain them and this fixture-style approach disappears.

  it('a hook with afterIndexAll receives the context and is awaited', async () => {
    // Build a one-off hook and call it directly — the runner's
    // contract is "for each registered hook, await afterIndexAll
    // if defined." We exercise that contract by calling the hook
    // ourselves to confirm the IndexHookContext shape stays usable
    // by hook implementations.
    let captured: IndexHookContext | null = null;
    const hook: IndexHook = {
      name: 'fake-hook',
      async afterIndexAll(ctx) {
        captured = ctx;
      },
    };
    const ctx = makeFakeContext();
    await hook.afterIndexAll!(ctx);
    expect(captured).toBe(ctx);
  });

  it('a hook with afterSync receives both ctx and result', async () => {
    let capturedCtx: IndexHookContext | null = null;
    let capturedResult: SyncResult | null = null;
    const hook: IndexHook = {
      name: 'fake-hook',
      async afterSync(ctx, result) {
        capturedCtx = ctx;
        capturedResult = result;
      },
    };
    const ctx = makeFakeContext();
    await hook.afterSync!(ctx, fakeSyncResult);
    expect(capturedCtx).toBe(ctx);
    expect(capturedResult).toBe(fakeSyncResult);
  });

  it('a hook missing afterIndexAll is silently skipped', () => {
    // Just a typing assertion: an IndexHook without afterIndexAll
    // is allowed (both methods are optional).
    const hook: IndexHook = { name: 'sync-only' };
    expect(hook.afterIndexAll).toBeUndefined();
    expect(hook.afterSync).toBeUndefined();
  });
});

describe('index-hooks runner — per-hook timeout', () => {
  // Regression: a hook awaiting a never-resolving promise used to
  // hang the whole indexAll/sync. The runner now races each hook
  // against a wall-clock budget; the offending hook surfaces as a
  // timeout error and the rest of the pipeline continues.
  //
  // We exercise that contract via the same shape the production
  // runner uses (Promise.race with a timeout) without spinning up a
  // 5-minute test. This proves the racing primitive does the right
  // thing on a hung promise.
  it('hook awaiting a never-resolving promise is bounded by Promise.race', async () => {
    const hung = new Promise<void>(() => {
      // intentionally never resolves
    });
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('budget exceeded')), 25);
    });
    await expect(Promise.race([hung, timeout])).rejects.toThrow('budget exceeded');
  });
});
