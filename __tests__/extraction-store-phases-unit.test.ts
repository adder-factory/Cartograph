import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbQueries from '../src/db/queries.js';
import type { ExtractionResult, FileRecord, Node } from '../src/types.js';

const calls: Array<{ name: string; value?: unknown }> = [];
let existingFile: FileRecord | null = null;
let priorStructHash: string | null = null;
let throwInsertNodes = false;

vi.spyOn(dbQueries, 'qbTransaction').mockImplementation(((_queries: unknown, fn: () => void) => {
  calls.push({ name: 'txn:start' });
  fn();
  calls.push({ name: 'txn:end' });
}) as typeof dbQueries.qbTransaction);

vi.mock('../src/db/queries-edges.js', () => ({
  insertEdges: vi.fn((_queries: unknown, edges: unknown) => calls.push({ name: 'insertEdges', value: edges })),
}));

vi.mock('../src/db/queries-files.js', () => ({
  getAllFiles: vi.fn(() => []),
  getFilesNeedingReextract: vi.fn(() => []),
  getFileByPath: vi.fn((_queries: unknown, filePath: string) => {
    calls.push({ name: 'getFileByPath', value: filePath });
    return existingFile;
  }),
  reconcileFileNodeCounts: vi.fn(),
  removeFileFromIndex: vi.fn(),
  removeFileFromIndexInTx: vi.fn((_queries: unknown, filePath: string) =>
    calls.push({ name: 'removeFileFromIndexInTx', value: filePath }),
  ),
  upsertFile: vi.fn((_queries: unknown, record: unknown) => calls.push({ name: 'upsertFile', value: record })),
}));

vi.mock('../src/db/queries-unresolved-refs.js', () => ({
  insertUnresolvedRefsBatch: vi.fn((_queries: unknown, refs: unknown) =>
    calls.push({ name: 'insertUnresolvedRefsBatch', value: refs }),
  ),
}));

vi.mock('../src/db/queries-nested-functions.js', () => ({
  upsertNestedFunctionsForFile: vi.fn((_queries: unknown, filePath: string, manifest: unknown) =>
    calls.push({ name: 'upsertNestedFunctionsForFile', value: { filePath, manifest } }),
  ),
}));

vi.mock('../src/db/queries-parse-cache.js', () => ({
  evictParseCacheIfOversized: vi.fn(),
  getCachedParse: vi.fn(() => null),
  getLatestStructHashForFile: vi.fn(() => priorStructHash),
  putCachedParse: vi.fn((entry: unknown) => calls.push({ name: 'putCachedParse', value: entry })),
}));

vi.mock('../src/extraction/profile.js', () => ({
  profile: vi.fn((_label: string, fn: () => unknown) => fn()),
  profileTagged: vi.fn((args: { fn: () => unknown }) => args.fn()),
  profileAsyncTagged: vi.fn((args: { fn: () => Promise<unknown> }) => args.fn()),
  flushProfileReport: vi.fn(),
  snapshotProfileDelta: vi.fn(() => []),
  mergeProfileEntries: vi.fn(),
}));

vi.mock('../src/resolution/frameworks/index.js', () => ({
  getAllFrameworkResolvers: vi.fn(() => [
    {
      name: 'bun',
      languages: ['typescript'],
      anchors: ['Bun.serve'],
      detect: () => true,
      resolve: () => null,
      extract: () => ({
        nodes: [node('framework:route', 'route')],
        references: [{ fromNodeId: 'framework:route', referenceName: 'handler', referenceKind: 'calls' }],
      }),
    },
    {
      name: 'wrong-language',
      languages: ['python'],
      anchors: ['Py.route'],
      detect: () => true,
      resolve: () => null,
      extractNodes: () => [node('wrong:language', 'wrongLanguage')],
    },
    {
      name: 'missing-anchor',
      languages: ['typescript'],
      anchors: ['Never.Here'],
      detect: () => true,
      resolve: () => null,
      extractNodes: () => [node('missing:anchor', 'missingAnchor')],
    },
    {
      name: 'legacy',
      detect: () => true,
      resolve: () => null,
      extractNodes: () => [node('framework:route', 'duplicateRoute'), node('legacy:node', 'legacyNode')],
    },
  ]),
}));

const { eoStoreExtractionResult, eoTryStoreResult } = await import('../src/extraction/extraction-phases.js');

function node(id: string, name: string): Node {
  return {
    id,
    name,
    kind: 'function',
    filePath: 'src/app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 1,
  } as Node;
}

function stats() {
  return { size: 100, mtimeMs: 1234.56 } as never;
}

function extractionResult(): ExtractionResult {
  return {
    nodes: [node('src:main', 'main'), { ...node('', 'invalid'), id: '' }],
    edges: [
      { source: 'src:main', target: 'framework:route', type: 'calls' },
      { source: 'src:main', target: 'missing:node', type: 'calls' },
    ],
    unresolvedReferences: [
      { fromNodeId: 'src:main', referenceName: 'helper', referenceKind: 'calls' },
      { fromNodeId: 'missing:node', referenceName: 'dropped', referenceKind: 'calls' },
    ],
    nestedFunctionManifest: [
      { parentNodeId: 'src:main', childNodeId: 'src:main.inner', ordinal: 0 },
      { parentNodeId: 'missing:node', childNodeId: 'missing.inner', ordinal: 1 },
    ],
    errors: [],
    durationMs: 1,
  } as ExtractionResult;
}

function state() {
  return {
    rootDir: '/tmp/cartograph',
    config: {},
    queries: {
      insertNodes: vi.fn((nodes: unknown) => {
        calls.push({ name: 'insertNodes', value: nodes });
        if (throwInsertNodes) throw new Error('database is locked');
      }),
      updateNode: vi.fn((updated: unknown) => calls.push({ name: 'updateNode', value: updated })),
    },
    cacheHits: { count: 0 },
  } as never;
}

beforeEach(() => {
  calls.length = 0;
  existingFile = null;
  priorStructHash = null;
  throwInsertNodes = false;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('extraction store phase persistence', () => {
  it('persists valid parsed and framework nodes while filtering invalid edges, refs, and nested rows', () => {
    const result = extractionResult();

    eoStoreExtractionResult(state(), {
      filePath: 'src/app.ts',
      content: 'Bun.serve({ fetch() { return new Response("ok"); } });',
      language: 'typescript',
      stats: stats(),
      result,
    });

    const inserted = calls.find((call) => call.name === 'insertNodes')!.value as Node[];
    expect(inserted.map((n) => n.id)).toEqual(['src:main', 'framework:route', 'legacy:node']);
    expect(inserted.some((n) => n.id === 'wrong:language')).toBe(false);
    expect(inserted.some((n) => n.id === 'missing:anchor')).toBe(false);

    expect(calls.find((call) => call.name === 'insertEdges')?.value).toEqual([
      { source: 'src:main', target: 'framework:route', type: 'calls' },
    ]);
    expect(calls.find((call) => call.name === 'insertUnresolvedRefsBatch')?.value).toEqual([
      {
        fromNodeId: 'src:main',
        referenceName: 'helper',
        referenceKind: 'calls',
        filePath: 'src/app.ts',
        language: 'typescript',
      },
      {
        fromNodeId: 'framework:route',
        referenceName: 'handler',
        referenceKind: 'calls',
        filePath: 'src/app.ts',
        language: 'typescript',
      },
    ]);
    expect(calls.find((call) => call.name === 'upsertNestedFunctionsForFile')?.value).toEqual({
      filePath: 'src/app.ts',
      manifest: [{ parentNodeId: 'src:main', childNodeId: 'src:main.inner', ordinal: 0 }],
    });
    expect(calls.some((call) => call.name === 'removeFileFromIndexInTx')).toBe(false);
    expect(calls.at(-2)?.name).toBe('putCachedParse');
  });

  it('updates existing nodes in place on the format-only fast path', () => {
    eoStoreExtractionResult(state(), {
      filePath: 'src/app.ts',
      content: 'export function main() { return 1; }',
      language: 'typescript',
      stats: stats(),
      result: extractionResult(),
    });
    priorStructHash = (calls.find((call) => call.name === 'putCachedParse')!.value as { structHash: string })
      .structHash;
    existingFile = { path: 'src/app.ts', contentHash: 'old', language: 'typescript' } as FileRecord;
    calls.length = 0;

    eoStoreExtractionResult(state(), {
      filePath: 'src/app.ts',
      content: 'export function main() { return 2; }',
      language: 'typescript',
      stats: stats(),
      result: extractionResult(),
    });

    expect(calls.some((call) => call.name === 'removeFileFromIndexInTx')).toBe(false);
    expect(calls.some((call) => call.name === 'insertEdges')).toBe(false);
    expect(calls.some((call) => call.name === 'insertUnresolvedRefsBatch')).toBe(false);
    expect(calls.filter((call) => call.name === 'updateNode').map((call) => (call.value as Node).id)).toEqual([
      'src:main',
      'framework:route',
      'legacy:node',
    ]);
  });

  it('replaces the old extraction when an existing file changes shape', () => {
    existingFile = { path: 'src/app.ts', contentHash: 'old', language: 'typescript' } as FileRecord;
    priorStructHash = 'different-shape';

    eoStoreExtractionResult(state(), {
      filePath: 'src/app.ts',
      content: 'export function main() { return 1; }',
      language: 'typescript',
      stats: stats(),
      result: extractionResult(),
    });

    expect(calls.find((call) => call.name === 'removeFileFromIndexInTx')?.value).toBe('src/app.ts');
    expect(calls.some((call) => call.name === 'insertNodes')).toBe(true);
  });

  it('accounts store failures separately from parse failures', () => {
    throwInsertNodes = true;
    const errors: Array<{ code?: string; message: string }> = [];
    const counters = { filesErrored: 0 };

    expect(
      eoTryStoreResult(state(), {
        filePath: 'src/app.ts',
        content: 'export function main() {}',
        language: 'typescript',
        stats: stats(),
        result: extractionResult(),
        errors: errors as never,
        counters,
      }),
    ).toBe(false);

    expect(counters.filesErrored).toBe(1);
    expect(errors[0]?.code).toBe('store_error');
    expect(errors[0]?.message).toContain('database is locked');
  });

  it('does not persist parser-only error results that contain no nodes', () => {
    const errors: unknown[] = [];
    const counters = { filesErrored: 0 };

    expect(
      eoTryStoreResult(state(), {
        filePath: 'src/broken.ts',
        content: 'broken',
        language: 'typescript',
        stats: stats(),
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: 'parse' }],
          durationMs: 1,
        } as never,
        errors: errors as never,
        counters,
      }),
    ).toBe(true);

    expect(calls).toEqual([]);
    expect(counters.filesErrored).toBe(0);
  });
});
