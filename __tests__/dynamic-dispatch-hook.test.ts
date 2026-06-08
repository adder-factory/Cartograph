import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as edgeQueries from '../src/db/queries-edges.js';
import * as metadataQueries from '../src/db/queries-metadata.js';
import * as searchQueries from '../src/db/queries-search.js';
import * as edgeHelpers from '../src/index-hooks/edge-resolution-helpers.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';

const state = {
  targets: [] as Array<{ path: string; language: string }>,
  inserted: [] as unknown[][],
  metadata: new Map<string, string>(),
  nameIndexes: new Map<string, Map<string, string>>(),
  yielded: 0,
};

vi.spyOn(edgeHelpers, 'yieldToEventLoop').mockImplementation(async () => {
  state.yielded++;
});
vi.spyOn(edgeHelpers, 'collectTargets').mockImplementation((() => state.targets) as never);
vi.spyOn(edgeQueries, 'insertEdges').mockImplementation(((_queries: unknown, edges: unknown[]) => {
  state.inserted.push(edges);
  return edges;
}) as never);
vi.spyOn(metadataQueries, 'getMetadata').mockImplementation(
  ((_queries: unknown, key: string) => state.metadata.get(key) ?? null) as never,
);
vi.spyOn(metadataQueries, 'setMetadata').mockImplementation(((_queries: unknown, key: string, value: string) => {
  state.metadata.set(key, value);
}) as never);
vi.spyOn(searchQueries, 'getSymbolNameIndexByFile').mockImplementation(
  ((_queries: unknown, filePath: string) => state.nameIndexes.get(filePath) ?? new Map()) as never,
);

const { HOOK, DYNAMIC_DISPATCH_ALGO_VERSION, dynamicDispatchInternalsForTest } = await import(
  '../src/index-hooks/dynamic-dispatch.js'
);

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dynamic-dispatch-hook-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function ctx(projectRoot: string): IndexHookContext {
  return {
    projectRoot,
    queries: {},
    config: {},
  } as IndexHookContext;
}

beforeEach(() => {
  state.targets = [];
  state.inserted = [];
  state.metadata.clear();
  state.nameIndexes.clear();
  state.yielded = 0;
  vi.clearAllMocks();
});

describe('dynamic-dispatch hook', () => {
  it('recognizes bounded object and Map dispatch tables', () => {
    const source = `
const HANDLERS = { save: saveOrder, cancel: cancelOrder, compact };
const ACTIONS = new Map([['archive', archiveOrder], ['restore', restoreOrder]]);
HANDLERS[kind]?.();
ACTIONS.get(kind)?.();
`;
    const tables = dynamicDispatchInternalsForTest.collectDispatchTables(source);
    expect(tables).toEqual([
      { name: 'HANDLERS', kind: 'object', targets: ['saveOrder', 'cancelOrder', 'compact'] },
      { name: 'ACTIONS', kind: 'map', targets: ['archiveOrder', 'restoreOrder'] },
    ]);
    expect(dynamicDispatchInternalsForTest.hasDispatchCall(source, tables[0]!)).toBe(true);
    expect(dynamicDispatchInternalsForTest.hasDispatchCall(source, tables[1]!)).toBe(true);
  });

  it('emits inferred calls edges for local same-file dispatch targets', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(
        path.join(root, 'src', 'dispatch.ts'),
        `
function saveOrder() {}
function cancelOrder() {}
function archiveOrder() {}
function noisy() {}
const HANDLERS = { save: saveOrder, cancel: cancelOrder };
const ACTIONS = new Map([['archive', archiveOrder], ['missing', missingOrder]]);
HANDLERS[kind]?.();
ACTIONS.get(kind)?.();
`,
      );
      state.targets = [{ path: 'src/dispatch.ts', language: 'typescript' }];
      state.nameIndexes.set(
        'src/dispatch.ts',
        new Map([
          ['saveOrder', 'fn:save'],
          ['cancelOrder', 'fn:cancel'],
          ['archiveOrder', 'fn:archive'],
          ['noisy', 'fn:noisy'],
        ]),
      );

      await HOOK.afterIndexAll(ctx(root));

      expect(state.inserted).toHaveLength(1);
      expect(state.inserted[0]).toEqual([
        {
          source: 'file:src/dispatch.ts',
          target: 'fn:save',
          kind: 'calls',
          confidence: 'INFERRED',
          metadata: { hook: 'dynamic-dispatch', table: 'HANDLERS', tableKind: 'object' },
        },
        {
          source: 'file:src/dispatch.ts',
          target: 'fn:cancel',
          kind: 'calls',
          confidence: 'INFERRED',
          metadata: { hook: 'dynamic-dispatch', table: 'HANDLERS', tableKind: 'object' },
        },
        {
          source: 'file:src/dispatch.ts',
          target: 'fn:archive',
          kind: 'calls',
          confidence: 'INFERRED',
          metadata: { hook: 'dynamic-dispatch', table: 'ACTIONS', tableKind: 'map' },
        },
      ]);
      expect(state.metadata.get('last_mined_dynamic_dispatch_algo_version')).toBe(DYNAMIC_DISPATCH_ALGO_VERSION);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('self-heals on algo-version mismatch before changed-file sync', async () => {
    const root = tempProject();
    try {
      state.targets = [];
      await HOOK.afterSync(ctx(root), { changedFilePaths: [], filesRemoved: 0 } as never);
      expect(state.metadata.get('last_mined_dynamic_dispatch_algo_version')).toBe(DYNAMIC_DISPATCH_ALGO_VERSION);

      state.metadata.set('last_mined_dynamic_dispatch_algo_version', DYNAMIC_DISPATCH_ALGO_VERSION);
      await HOOK.afterSync(ctx(root), { changedFilePaths: [], filesRemoved: 0 } as never);
      expect(state.inserted).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
