import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as edgeQueries from '../src/db/queries-edges.js';
import * as fileQueries from '../src/db/queries-files.js';
import * as nestedFunctionQueries from '../src/db/queries-nested-functions.js';
import * as parseCacheQueries from '../src/db/queries-parse-cache.js';
import * as nodeQueries from '../src/db/queries.js';
import * as unresolvedRefQueries from '../src/db/queries-unresolved-refs.js';
import * as profileModule from '../src/extraction/profile.js';
import * as frameworkIndex from '../src/resolution/frameworks/index.js';
import type { ExtractionError, ExtractionResult, FileRecord, Node } from '../src/types.js';

const calls: Array<{ name: string; value?: unknown }> = [];
let cachedParse: ExtractionResult | null = null;
let throwInsertNodes = false;
let frameworkExtractCalls = 0;
let legacyExtractCalls = 0;
let wrongLanguageCalls = 0;
let missingAnchorCalls = 0;

vi.spyOn(nodeQueries, 'qbTransaction').mockImplementation(((_queries: unknown, fn: () => void) => {
  calls.push({ name: 'txn:start' });
  fn();
  calls.push({ name: 'txn:end' });
}) as never);

vi.spyOn(edgeQueries, 'insertEdges').mockImplementation(((_queries: unknown, edges: unknown) =>
  calls.push({ name: 'insertEdges', value: edges })) as never);

vi.spyOn(fileQueries, 'getAllFiles').mockImplementation((() => []) as never);
vi.spyOn(fileQueries, 'getFilesNeedingReextract').mockImplementation((() => []) as never);
vi.spyOn(fileQueries, 'getFileByPath').mockImplementation(((_queries: unknown, filePath: string) => {
  calls.push({ name: 'getFileByPath', value: filePath });
  return null as FileRecord | null;
}) as never);
vi.spyOn(fileQueries, 'reconcileFileNodeCounts').mockImplementation((() => {}) as never);
vi.spyOn(fileQueries, 'removeFileFromIndex').mockImplementation((() => {}) as never);
vi.spyOn(fileQueries, 'removeFileFromIndexInTx').mockImplementation(((_queries: unknown, filePath: string) =>
  calls.push({ name: 'removeFileFromIndexInTx', value: filePath })) as never);
vi.spyOn(fileQueries, 'upsertFile').mockImplementation(((_queries: unknown, record: unknown) =>
  calls.push({ name: 'upsertFile', value: record })) as never);

vi.spyOn(unresolvedRefQueries, 'insertUnresolvedRefsBatch').mockImplementation(((_queries: unknown, refs: unknown) =>
  calls.push({ name: 'insertUnresolvedRefsBatch', value: refs })) as never);

vi.spyOn(nestedFunctionQueries, 'upsertNestedFunctionsForFile').mockImplementation(((
  _queries: unknown,
  filePath: string,
  manifest: unknown,
) => calls.push({ name: 'upsertNestedFunctionsForFile', value: { filePath, manifest } })) as never);

vi.spyOn(parseCacheQueries, 'evictParseCacheIfOversized').mockImplementation((() => {}) as never);
vi.spyOn(parseCacheQueries, 'getLatestStructHashForFile').mockImplementation((() => null) as never);
vi.spyOn(parseCacheQueries, 'getCachedParse').mockImplementation(((entry: unknown) => {
  calls.push({ name: 'getCachedParse', value: entry });
  return cachedParse;
}) as never);
vi.spyOn(parseCacheQueries, 'putCachedParse').mockImplementation(((entry: unknown) =>
  calls.push({ name: 'putCachedParse', value: entry })) as never);

vi.spyOn(profileModule, 'profile').mockImplementation(((_label: string, fn: () => unknown) => fn()) as never);
vi.spyOn(profileModule, 'profileTagged').mockImplementation(((args: { fn: () => unknown }) => args.fn()) as never);
vi.spyOn(profileModule, 'profileAsyncTagged').mockImplementation(((args: { fn: () => Promise<unknown> }) =>
  args.fn()) as never);
vi.spyOn(profileModule, 'flushProfileReport').mockImplementation((() => {}) as never);
vi.spyOn(profileModule, 'snapshotProfileDelta').mockImplementation((() => []) as never);
vi.spyOn(profileModule, 'mergeProfileEntries').mockImplementation((() => {}) as never);

vi.spyOn(frameworkIndex, 'getAllFrameworkResolvers').mockImplementation((() => [
  {
    name: 'typescript-route',
    languages: ['typescript'],
    anchors: ['Framework.route'],
    detect: () => true,
    resolve: () => null,
    extract: () => {
      frameworkExtractCalls++;
      return {
        nodes: [node('framework:route', 'route'), node('framework:route', 'routeDuplicate')],
        references: [{ fromNodeId: 'framework:route', referenceName: 'handler', referenceKind: 'calls' }],
      };
    },
  },
  {
    name: 'wrong-language',
    languages: ['python'],
    anchors: ['Py.route'],
    detect: () => true,
    resolve: () => null,
    extractNodes: () => {
      wrongLanguageCalls++;
      return [node('wrong:language', 'wrongLanguage')];
    },
  },
  {
    name: 'missing-anchor',
    languages: ['typescript'],
    anchors: ['Never.Here'],
    detect: () => true,
    resolve: () => null,
    extractNodes: () => {
      missingAnchorCalls++;
      return [node('missing:anchor', 'missingAnchor')];
    },
  },
  {
    name: 'legacy',
    detect: () => true,
    resolve: () => null,
    extractNodes: () => {
      legacyExtractCalls++;
      return [node('framework:route', 'legacyDuplicate'), node('legacy:node', 'legacyNode')];
    },
  },
]) as never);

const { eoProcessOneFile, eoRunIndexRetryPhaseIfNeeded } = await import('../src/extraction/extraction-phases.js');

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

function stats(size = 100) {
  return { size, mtimeMs: 1234.56 } as fs.Stats;
}

function state(rootDir = '/tmp/cartograph') {
  return {
    rootDir,
    config: { maxFileSize: 10_000 },
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

function counters() {
  return {
    filesIndexed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    totalNodes: 0,
    totalEdges: 0,
    processed: 0,
  };
}

function parsedResult(extra: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    nodes: [node('src:main', 'main')],
    edges: [{ source: 'src:main', target: 'framework:route', type: 'calls' }],
    unresolvedReferences: [{ fromNodeId: 'src:main', referenceName: 'helper', referenceKind: 'calls' }],
    errors: [],
    durationMs: 1,
    ...extra,
  } as ExtractionResult;
}

beforeEach(() => {
  calls.length = 0;
  cachedParse = null;
  throwInsertNodes = false;
  frameworkExtractCalls = 0;
  legacyExtractCalls = 0;
  wrongLanguageCalls = 0;
  missingAnchorCalls = 0;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('extraction phase orchestration branches', () => {
  it('parses, stores, merges framework output, and accumulates successful file counters', async () => {
    const count = counters();
    const errors: ExtractionError[] = [];
    const progress: unknown[] = [];
    const result = parsedResult({
      errors: [{ message: 'non-fatal parse note', severity: 'warning' }],
    });

    await eoProcessOneFile(state(), {
      filePath: 'src/app.ts',
      content: 'Framework.route("/ok", handler);\nPy.route("/wrong", handler);\nexport function main() { return 1; }\n',
      stats: stats(),
      error: null,
      total: 1,
      errors,
      counters: count,
      onProgress: (item) => progress.push(item),
      requestParse: async () => result,
    });

    const inserted = calls.find((call) => call.name === 'insertNodes')?.value as Node[];
    expect(inserted.map((n) => [n.id, n.name, n.language])).toEqual([
      ['src:main', 'main', 'typescript'],
      ['framework:route', 'route', 'typescript'],
      ['legacy:node', 'legacyNode', 'typescript'],
    ]);
    expect(frameworkExtractCalls).toBe(1);
    expect(legacyExtractCalls).toBe(1);
    expect(wrongLanguageCalls).toBe(0);
    expect(missingAnchorCalls).toBe(0);
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
    expect(calls.some((call) => call.name === 'putCachedParse')).toBe(true);
    expect(count).toMatchObject({ processed: 1, filesIndexed: 1, totalNodes: 3, totalEdges: 1 });
    expect(errors).toEqual([{ message: 'non-fatal parse note', severity: 'warning', filePath: 'src/app.ts' }]);
    expect(progress).toEqual([{ phase: 'parsing', current: 0, total: 1, currentFile: 'src/app.ts' }]);
  });

  it('records parse failures before the store phase', async () => {
    const count = counters();
    const errors: ExtractionError[] = [];

    await eoProcessOneFile(state(), {
      filePath: 'src/broken.ts',
      content: 'broken',
      stats: stats(),
      error: null,
      total: 1,
      errors,
      counters: count,
      onProgress: undefined,
      requestParse: async () => {
        throw new Error('parser exploded');
      },
    });

    expect(count).toMatchObject({ processed: 1, filesErrored: 1, filesIndexed: 0 });
    expect(errors).toEqual([
      { message: 'parser exploded', filePath: 'src/broken.ts', severity: 'error', code: 'parse_error' },
    ]);
    expect(calls.some((call) => call.name === 'insertNodes')).toBe(false);
    expect(calls.some((call) => call.name === 'upsertFile')).toBe(false);
  });

  it('uses cached parse results without invoking the parser and still stores the file', async () => {
    const st = state();
    const count = counters();
    const errors: ExtractionError[] = [];
    cachedParse = parsedResult({ edges: [] });

    await eoProcessOneFile(st, {
      filePath: 'src/cached.ts',
      content: 'export function main() { return 1; }\n',
      stats: stats(),
      error: null,
      total: 1,
      errors,
      counters: count,
      onProgress: undefined,
      requestParse: async () => {
        throw new Error('cache hit should not parse');
      },
    });

    expect(st.cacheHits.count).toBe(1);
    expect(calls.find((call) => call.name === 'getCachedParse')?.value).toMatchObject({
      language: 'typescript',
      filePath: 'src/cached.ts',
    });
    expect(calls.some((call) => call.name === 'insertNodes')).toBe(true);
    expect(count).toMatchObject({ processed: 1, filesIndexed: 1, totalNodes: 3, totalEdges: 0 });
    expect(errors).toEqual([]);
  });

  it('accounts store errors separately and does not count the parsed nodes as indexed', async () => {
    const count = counters();
    const errors: ExtractionError[] = [];
    throwInsertNodes = true;

    await eoProcessOneFile(state(), {
      filePath: 'src/locked.ts',
      content: 'export function main() { return 1; }\n',
      stats: stats(),
      error: null,
      total: 1,
      errors,
      counters: count,
      onProgress: undefined,
      requestParse: async () => parsedResult(),
    });

    expect(count).toMatchObject({ processed: 1, filesErrored: 1, filesIndexed: 0, totalNodes: 0, totalEdges: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ filePath: 'src/locked.ts', severity: 'error', code: 'store_error' });
    expect(errors[0]?.message).toContain('database is locked');
  });

  it('classifies parser-produced warning-only and error-only empty results after the no-store branch', async () => {
    const count = counters();
    const errors: ExtractionError[] = [];

    await eoProcessOneFile(state(), {
      filePath: 'src/warning-only.ts',
      content: 'warning',
      stats: stats(),
      error: null,
      total: 2,
      errors,
      counters: count,
      onProgress: undefined,
      requestParse: async () =>
        parsedResult({
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: 'syntax warning', severity: 'warning' }],
        }),
    });

    await eoProcessOneFile(state(), {
      filePath: 'src/error-only.ts',
      content: 'error',
      stats: stats(),
      error: null,
      total: 2,
      errors,
      counters: count,
      onProgress: undefined,
      requestParse: async () =>
        parsedResult({
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: 'syntax error', severity: 'error' }],
        }),
    });

    expect(calls.some((call) => call.name === 'insertNodes')).toBe(false);
    expect(count).toMatchObject({ processed: 2, filesSkipped: 1, filesErrored: 1, filesIndexed: 0 });
    expect(errors).toEqual([
      { message: 'syntax warning', severity: 'warning', filePath: 'src/warning-only.ts' },
      { message: 'syntax error', severity: 'error', filePath: 'src/error-only.ts' },
    ]);
  });

  it('reruns eligible worker parse failures and removes the original error after a successful retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extraction-retry-success-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src/retry.ts'), 'export function main() { return 1; }\n');
      const retryError: ExtractionError = {
        message: 'Worker exited with code 1',
        severity: 'error',
        code: 'parse_error',
        filePath: 'src/retry.ts',
      };
      const errors = [retryError];
      const count = { filesIndexed: 0, filesErrored: 1, totalNodes: 0, totalEdges: 0 };
      const log: string[] = [];
      let recycled = 0;
      let parsed = 0;

      const retryMs = await eoRunIndexRetryPhaseIfNeeded(state(root), {
        errors,
        counters: count,
        env: {
          pool: null,
          hasWorker: true,
          poolSize: 1,
          getSlowFiles: () => [],
          recycleWorker: async () => {
            recycled++;
          },
          requestParse: async () => {
            parsed++;
            return parsedResult({ edges: [] });
          },
        },
        signal: undefined,
        log: (message) => log.push(message),
      });

      expect(retryMs).toBeGreaterThanOrEqual(0);
      expect(recycled).toBe(1);
      expect(parsed).toBe(1);
      expect(errors).toEqual([]);
      expect(count).toEqual({ filesIndexed: 1, filesErrored: 0, totalNodes: 3, totalEdges: 0 });
      expect(log).toEqual([
        'Retrying 1 files that failed due to WASM memory errors...',
        'Retry OK: src/retry.ts (3 nodes)',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
