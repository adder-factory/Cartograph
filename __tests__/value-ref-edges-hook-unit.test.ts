import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dbIndex from '../src/db/index.js';
import * as metadataQueries from '../src/db/queries-metadata.js';
import * as searchQueries from '../src/db/queries-search.js';
import * as errorModule from '../src/errors.js';
// Real modules captured BEFORE vi.mock (bun does not hoist) — the mocks
// below delegate to them whenever this suite is not actively running, so
// a leaked factory can't poison another test file's hooks (module-leak
// canary). The spies above are already leak-safe via restoreAllMocks.
import * as realHelpers from '../src/index-hooks/edge-resolution-helpers.js';
import * as realPool from '../src/index-hooks/value-ref-edges-pool.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';

/* Value snapshots taken NOW — before the vi.mock() calls below execute.
   Factory bodies must not read the live namespaces: bun rebinds existing
   namespace imports to the mock, so `realX.fn()` inside a factory would
   call the mock itself (infinite recursion). */
const REAL_HELPERS = { ...realHelpers };
const REAL_POOL = { ...realPool };

type TargetOptions = { scope: 'all' } | { scope: 'files'; files: string[] };

const state = {
  active: false,
  refreshCalls: [] as Array<{ hookName: string; options: unknown; edges: unknown[] }>,
  metadata: new Map<string, string>(),
  calls: [] as Array<{ name: string; value?: unknown }>,
  useWorkers: false,
  workerResult: { edges: [] as unknown[], isPartial: false },
  nameIndexes: new Map<string, Map<string, string>>(),
  throwSetMetadata: false,
};

vi.spyOn(dbIndex, 'getDatabasePath').mockImplementation(
  ((projectRoot: string) => `${projectRoot}/.cartograph/cartograph.db`) as never,
);

vi.spyOn(metadataQueries, 'getMetadata').mockImplementation(
  ((_queries: unknown, key: string) => state.metadata.get(key) ?? null) as never,
);
vi.spyOn(metadataQueries, 'setMetadata').mockImplementation(((_queries: unknown, key: string, value: string) => {
  state.calls.push({ name: 'setMetadata', value: { key, value } });
  if (state.throwSetMetadata) throw new Error('metadata locked');
  state.metadata.set(key, value);
}) as never);

vi.spyOn(searchQueries, 'getSymbolNameIndexByFile').mockImplementation(
  ((_queries: unknown, filePath: string) => state.nameIndexes.get(filePath) ?? new Map()) as never,
);

vi.mock('../src/index-hooks/value-ref-edges-pool.js', () => ({
  ...REAL_POOL,
  shouldUseValueRefWorkers: vi.fn((...args: Parameters<typeof REAL_POOL.shouldUseValueRefWorkers>) =>
    state.active ? state.useWorkers : REAL_POOL.shouldUseValueRefWorkers(...args),
  ),
  buildValueRefEdgesInWorkers: vi.fn(async (...args: Parameters<typeof REAL_POOL.buildValueRefEdgesInWorkers>) => {
    if (!state.active) return REAL_POOL.buildValueRefEdgesInWorkers(...args);
    state.calls.push({ name: 'buildValueRefEdgesInWorkers', value: args[0] });
    return state.workerResult as never;
  }),
}));

vi.mock('../src/index-hooks/edge-resolution-helpers.js', () => ({
  ...REAL_HELPERS,
  PER_FILE_YIELD_INTERVAL: 2,
  yieldToEventLoop: vi.fn(async () => {
    if (!state.active) return REAL_HELPERS.yieldToEventLoop();
    state.calls.push({ name: 'yieldToEventLoop' });
  }),
  refreshEdgesHook: vi.fn(
    async (args: {
      ctx: IndexHookContext;
      options: TargetOptions;
      hookName: string;
      buildEdges: (ctx: IndexHookContext, files: Array<{ path: string; language: string }>) => Promise<unknown[]>;
    }) => {
      // Foreign hook, or this mock leaked into another test file's
      // indexAll (module-leak canary): run the REAL implementation so
      // its cross-file edges aren't poisoned.
      if (!state.active || args.hookName !== 'value-ref-edges') {
        await REAL_HELPERS.refreshEdgesHook(args as never);
        return;
      }
      const edges = await args.buildEdges(args.ctx, [
        { path: 'src/a.ts', language: 'typescript' },
        { path: 'src/b.js', language: 'javascript' },
        { path: 'src/ignored.py', language: 'python' },
        { path: 'src/missing.ts', language: 'typescript' },
      ]);
      state.refreshCalls.push({ hookName: args.hookName, options: args.options, edges });
    },
  ),
}));

vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) =>
  state.calls.push({ name: 'logDebug', value: message })) as never);

const { HOOK, VALUE_REF_EDGES_ALGO_VERSION } = await import('../src/index-hooks/value-ref-edges.js');

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-value-ref-hook-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function ctx(projectRoot: string): IndexHookContext {
  return {
    projectRoot,
    queries: {},
    config: {},
    db: { getBackend: () => 'bun-sqlite' },
  } as IndexHookContext;
}

beforeEach(() => {
  state.active = true;
  state.refreshCalls = [];
  state.metadata.clear();
  state.calls = [];
  state.useWorkers = false;
  state.workerResult = { edges: [], isPartial: false };
  state.nameIndexes.clear();
  state.throwSetMetadata = false;
  vi.clearAllMocks();
});

afterAll(() => {
  // Spies restore to the real implementations; the factory mocks above
  // delegate to real once the flag drops (module-leak canary).
  state.active = false;
  vi.restoreAllMocks();
});

describe('value-ref-edges hook orchestration', () => {
  it('mines in-process value-reference edges and stamps the algorithm version after a clean run', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const cfg = { onRun: runTask }; refine(checkTask);');
      fs.writeFileSync(path.join(root, 'src', 'b.js'), 'apply(otherTask);');
      state.nameIndexes.set(
        'src/a.ts',
        new Map([
          ['runTask', 'node:runTask'],
          ['checkTask', 'node:checkTask'],
        ]),
      );
      state.nameIndexes.set('src/b.js', new Map([['otherTask', 'node:otherTask']]));

      await HOOK.afterIndexAll(ctx(root));

      expect(state.refreshCalls).toHaveLength(1);
      expect(state.refreshCalls[0]!.hookName).toBe('value-ref-edges');
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'all' });
      expect(state.refreshCalls[0]!.edges).toEqual([
        { source: 'file:src/a.ts', target: 'node:checkTask', kind: 'references' },
        { source: 'file:src/a.ts', target: 'node:runTask', kind: 'references' },
        { source: 'file:src/b.js', target: 'node:otherTask', kind: 'references' },
      ]);
      expect(state.metadata.get('last_mined_value_ref_edges_algo_version')).toBe(VALUE_REF_EDGES_ALGO_VERSION);
      expect(state.calls.map((call) => call.name)).toContain('yieldToEventLoop');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses worker results for large batches and leaves metadata stale when the result is partial', async () => {
    const root = tempProject();
    try {
      state.useWorkers = true;
      state.workerResult = {
        edges: [{ source: 'file:src/a.ts', target: 'node:a', kind: 'references' }],
        isPartial: true,
      };

      await HOOK.afterIndexAll(ctx(root));

      expect(state.calls.find((call) => call.name === 'buildValueRefEdgesInWorkers')?.value).toMatchObject({
        dbPath: `${root}/.cartograph/cartograph.db`,
        projectRoot: root,
      });
      expect(state.refreshCalls[0]!.edges).toEqual([{ source: 'file:src/a.ts', target: 'node:a', kind: 'references' }]);
      expect(state.metadata.get('last_mined_value_ref_edges_algo_version')).toBeUndefined();
      expect(
        state.calls.some((call) => call.name === 'logDebug' && String(call.value).includes('partial result')),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('self-heals stale metadata before changed-file handling and skips no-op syncs when fresh', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'apply(runTask);');
      state.nameIndexes.set('src/a.ts', new Map([['runTask', 'node:runTask']]));

      state.metadata.set('last_mined_value_ref_edges_algo_version', 'old');
      await HOOK.afterSync(ctx(root), { changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never);
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'all' });

      state.refreshCalls = [];
      state.metadata.set('last_mined_value_ref_edges_algo_version', VALUE_REF_EDGES_ALGO_VERSION);
      await HOOK.afterSync(ctx(root), { changedFilePaths: [], filesRemoved: 0 } as never);
      expect(state.refreshCalls).toEqual([]);

      await HOOK.afterSync(ctx(root), { changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never);
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'files', files: ['src/a.ts'] });

      await HOOK.afterSync(ctx(root), { changedFilePaths: undefined, filesRemoved: 1 } as never);
      expect(state.refreshCalls.at(-1)!.options).toEqual({ scope: 'files', files: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('logs metadata stamp failures without failing the hook', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'apply(runTask);');
      state.nameIndexes.set('src/a.ts', new Map([['runTask', 'node:runTask']]));
      state.throwSetMetadata = true;

      await HOOK.afterIndexAll(ctx(root));

      expect(
        state.calls.some((call) => call.name === 'logDebug' && String(call.value).includes('metadata locked')),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
