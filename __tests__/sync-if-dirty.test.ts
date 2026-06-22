/**
 * Tests for the sync-if-dirty gate.
 *
 * The original gate keyed off working-tree dirt only, so commits,
 * merges, checkouts, and rebases (clean tree, HEAD moved) skipped the
 * sync and left the index answering from the old graph. The gate now
 * also consults index freshness (indexed sha vs HEAD + content drift)
 * before declaring there's nothing to do.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSyncIfDirtyCommand, type SyncIfDirtyCommandDeps } from '../src/features/sync-if-dirty/cli.js';
import type { FreshnessInfo } from '../src/freshness.js';

function freshnessFixture(overrides: Partial<FreshnessInfo>): FreshnessInfo {
  return {
    isStale: false,
    indexedSha: 'a'.repeat(40),
    currentSha: 'a'.repeat(40),
    indexedAt: 1,
    filesChanged: 0,
    breakdown: null,
    commitsAhead: 0,
    banner: null,
    severity: 'fresh',
    contentDriftedFiles: 0,
    ...overrides,
  } as FreshnessInfo;
}

interface Harness {
  deps: SyncIfDirtyCommandDeps;
  syncCalls: unknown[];
  closeCalls: number[];
  infoMessages: string[];
  errorMessages: string[];
  loadCalls: number[];
}

function makeHarness(args: {
  dirty: boolean;
  freshness: FreshnessInfo | null;
  initialized?: boolean;
  syncError?: Error;
}): Harness {
  const syncCalls: unknown[] = [];
  const closeCalls: number[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const loadCalls: number[] = [];
  const graph = {
    sync: async (opts: unknown) => {
      syncCalls.push(opts);
      if (args.syncError) throw args.syncError;
      return {};
    },
    close: () => {
      closeCalls.push(1);
    },
    stats: { getFreshness: () => args.freshness },
  };
  const deps: SyncIfDirtyCommandDeps = {
    program: undefined as never, // not used by runSyncIfDirtyCommand
    resolveProjectPath: (p) => p ?? '/fake/project',
    isInitialized: () => args.initialized ?? true,
    hasUncommittedChanges: () => args.dirty,
    loadCartograph: async () => {
      loadCalls.push(1);
      return {
        default: { open: async () => graph },
      };
    },
    info: (m) => {
      infoMessages.push(m);
    },
    error: (m) => {
      errorMessages.push(m);
    },
    writeStderr: () => {},
  };
  return { deps, syncCalls, closeCalls, infoMessages, errorMessages, loadCalls };
}

function forbidProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('process.exit should not be called');
  });
}

describe('runSyncIfDirtyCommand gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('dirty working tree syncs without consulting freshness', async () => {
    const h = makeHarness({ dirty: true, freshness: null });
    await runSyncIfDirtyCommand(undefined, {}, h.deps);
    expect(h.syncCalls.length).toBe(1);
    expect(h.infoMessages).toContain('Synced changed files');
  });

  it('clean tree + index in sync with HEAD skips the sync', async () => {
    const h = makeHarness({ dirty: false, freshness: freshnessFixture({}) });
    await runSyncIfDirtyCommand(undefined, {}, h.deps);
    expect(h.syncCalls.length).toBe(0);
    expect(h.infoMessages.some((m) => m.includes('skipping sync'))).toBe(true);
    expect(h.closeCalls.length).toBe(1); // graph opened for the check must still be closed
  });

  it('clean tree + HEAD moved since last index (isStale) syncs — the original bug', async () => {
    const h = makeHarness({
      dirty: false,
      freshness: freshnessFixture({ isStale: true, currentSha: 'b'.repeat(40), commitsAhead: 16 }),
    });
    await runSyncIfDirtyCommand(undefined, {}, h.deps);
    expect(h.syncCalls.length).toBe(1);
  });

  it('clean tree + content drift on matching HEAD syncs', async () => {
    const h = makeHarness({
      dirty: false,
      freshness: freshnessFixture({ contentDriftedFiles: 3 }),
    });
    await runSyncIfDirtyCommand(undefined, {}, h.deps);
    expect(h.syncCalls.length).toBe(1);
  });

  it('clean tree + never-stamped index (null freshness) errs toward syncing', async () => {
    const h = makeHarness({ dirty: false, freshness: null });
    await runSyncIfDirtyCommand(undefined, {}, h.deps);
    expect(h.syncCalls.length).toBe(1);
  });

  it('invalid max-file-size reports the parse error without hard-exiting or loading the graph', async () => {
    const exitSpy = forbidProcessExit();
    const h = makeHarness({ dirty: true, freshness: null });

    await runSyncIfDirtyCommand(undefined, { maxFileSize: '11mb' }, h.deps);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(h.errorMessages).toEqual(['--max-file-size must be between 1 byte and 10mb (got "11mb")']);
    expect(h.loadCalls).toEqual([]);
    expect(h.syncCalls).toEqual([]);
  });

  it('uninitialized projects report the expected failure without hard-exiting or loading the graph', async () => {
    const exitSpy = forbidProcessExit();
    const h = makeHarness({ dirty: true, freshness: null, initialized: false });

    await runSyncIfDirtyCommand('/missing/project', {}, h.deps);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(h.errorMessages).toEqual(['Cartograph not initialized in /missing/project']);
    expect(h.loadCalls).toEqual([]);
    expect(h.syncCalls).toEqual([]);
  });

  it('sync failures set exitCode, close the graph, and do not hard-exit', async () => {
    const exitSpy = forbidProcessExit();
    const h = makeHarness({ dirty: true, freshness: null, syncError: new Error('disk full') });

    await runSyncIfDirtyCommand(undefined, {}, h.deps);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(h.errorMessages).toEqual(['Failed to sync: disk full']);
    expect(h.closeCalls.length).toBe(1);
  });
});
