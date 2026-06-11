/**
 * Tests for the sync-if-dirty gate.
 *
 * The original gate keyed off working-tree dirt only, so commits,
 * merges, checkouts, and rebases (clean tree, HEAD moved) skipped the
 * sync and left the index answering from the old graph. The gate now
 * also consults index freshness (indexed sha vs HEAD + content drift)
 * before declaring there's nothing to do.
 */

import { describe, it, expect } from 'vitest';
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
}

function makeHarness(args: { dirty: boolean; freshness: FreshnessInfo | null }): Harness {
  const syncCalls: unknown[] = [];
  const closeCalls: number[] = [];
  const infoMessages: string[] = [];
  const graph = {
    sync: async (opts: unknown) => {
      syncCalls.push(opts);
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
    isInitialized: () => true,
    hasUncommittedChanges: () => args.dirty,
    loadCartograph: async () => ({
      default: { open: async () => graph },
    }),
    info: (m) => {
      infoMessages.push(m);
    },
    error: () => {},
    writeStderr: () => {},
  };
  return { deps, syncCalls, closeCalls, infoMessages };
}

describe('runSyncIfDirtyCommand gate', () => {
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
});
