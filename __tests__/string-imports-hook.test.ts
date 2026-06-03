import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fileQueries from '../src/db/queries-files.js';
import * as metadataQueries from '../src/db/queries-metadata.js';
import * as stringImportQueries from '../src/db/queries-string-imports.js';
import * as errorModule from '../src/errors.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';
import {
  LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY,
  STRING_IMPORTS_ALGO_VERSION,
} from '../src/string-imports/index.js';
import * as stringImports from '../src/string-imports/index.js';

const state = {
  files: new Map<string, { path: string; language: string }>(),
  metadata: new Map<string, string>(),
  calls: [] as Array<{ name: string; value?: unknown }>,
  throwExtract: false,
};

vi.spyOn(stringImports, 'extractStringImports').mockImplementation(((
  _root: string,
  targets: Array<{ path: string; language: string }>,
) => {
  state.calls.push({ name: 'extractStringImports', value: targets });
  if (state.throwExtract) throw new Error('extract failed');
  return targets.map((target) => ({
    filePath: target.path,
    line: 1,
    moduleName: './x',
    raw: 'import x',
    containerKind: 'string_literal',
  }));
}) as never);

vi.spyOn(fileQueries, 'getAllFiles').mockImplementation((() => [...state.files.values()]) as never);
vi.spyOn(fileQueries, 'getFileByPath').mockImplementation(
  ((_queries: unknown, filePath: string) => state.files.get(filePath) ?? null) as never,
);

vi.spyOn(stringImportQueries, 'applyStringImports').mockImplementation(((_queries: unknown, refs: unknown) =>
  state.calls.push({ name: 'applyStringImports', value: refs })) as never);
vi.spyOn(stringImportQueries, 'clearStringImports').mockImplementation((() =>
  state.calls.push({ name: 'clearStringImports' })) as never);
vi.spyOn(stringImportQueries, 'deleteStringImportsForPaths').mockImplementation(((_queries: unknown, paths: string[]) =>
  state.calls.push({ name: 'deleteStringImportsForPaths', value: paths })) as never);
vi.spyOn(stringImportQueries, 'pruneOrphanedStringImports').mockImplementation((() =>
  state.calls.push({ name: 'pruneOrphanedStringImports' })) as never);

vi.spyOn(metadataQueries, 'getMetadata').mockImplementation(
  ((_queries: unknown, key: string) => state.metadata.get(key) ?? null) as never,
);
vi.spyOn(metadataQueries, 'setMetadata').mockImplementation(((_queries: unknown, key: string, value: string) => {
  state.calls.push({ name: 'setMetadata', value: { key, value } });
  state.metadata.set(key, value);
}) as never);

vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) =>
  state.calls.push({ name: 'logDebug', value: message })) as never);

const { HOOK } = await import('../src/index-hooks/string-imports.js');

function ctx(config: Record<string, unknown> = {}): IndexHookContext {
  return { projectRoot: '/repo', queries: {}, config } as IndexHookContext;
}

beforeEach(() => {
  state.files = new Map([
    ['src/a.ts', { path: 'src/a.ts', language: 'typescript' }],
    ['src/b.py', { path: 'src/b.py', language: 'python' }],
  ]);
  state.metadata.clear();
  state.calls = [];
  state.throwExtract = false;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('string-imports hook', () => {
  it('does nothing when string import mining is disabled', () => {
    HOOK.afterIndexAll(ctx({ enableStringImports: false }));
    HOOK.afterSync(ctx({ enableStringImports: false }), { changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never);
    expect(state.calls).toEqual([]);
  });

  it('runs a full refresh after indexAll and stamps the current algorithm version', () => {
    HOOK.afterIndexAll(ctx());

    expect(state.calls.map((call) => call.name)).toEqual([
      'clearStringImports',
      'extractStringImports',
      'applyStringImports',
      'setMetadata',
    ]);
    expect(state.calls.find((call) => call.name === 'extractStringImports')?.value).toEqual([
      { path: 'src/a.ts', language: 'typescript' },
      { path: 'src/b.py', language: 'python' },
    ]);
    expect(state.metadata.get(LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY)).toBe(STRING_IMPORTS_ALGO_VERSION);
  });

  it('self-heals stale algorithm metadata before changed-file handling', () => {
    state.metadata.set(LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY, 'old');

    HOOK.afterSync(ctx(), { changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never);

    expect(state.calls[0]?.name).toBe('clearStringImports');
    expect(state.calls.some((call) => call.name === 'deleteStringImportsForPaths')).toBe(false);
  });

  it('refreshes only changed indexed files on sync and prunes removed-file rows', () => {
    state.metadata.set(LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY, STRING_IMPORTS_ALGO_VERSION);

    HOOK.afterSync(ctx(), { changedFilePaths: ['src/a.ts', 'src/missing.ts'], filesRemoved: 0 } as never);

    expect(state.calls.map((call) => call.name)).toEqual([
      'pruneOrphanedStringImports',
      'deleteStringImportsForPaths',
      'extractStringImports',
      'applyStringImports',
      'setMetadata',
    ]);
    expect(state.calls.find((call) => call.name === 'deleteStringImportsForPaths')?.value).toEqual(['src/a.ts']);
    expect(state.calls.find((call) => call.name === 'extractStringImports')?.value).toEqual([
      { path: 'src/a.ts', language: 'typescript' },
    ]);

    state.calls = [];
    HOOK.afterSync(ctx(), { changedFilePaths: undefined, filesRemoved: 1 } as never);
    expect(state.calls.map((call) => call.name)).toContain('pruneOrphanedStringImports');
    expect(state.calls.some((call) => call.name === 'deleteStringImportsForPaths')).toBe(false);
  });

  it('logs and swallows extractor failures so index hooks remain best-effort', () => {
    state.throwExtract = true;

    HOOK.afterIndexAll(ctx());

    expect(state.calls.some((call) => call.name === 'logDebug' && String(call.value).includes('extract failed'))).toBe(
      true,
    );
    expect(state.metadata.get(LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY)).toBeUndefined();
  });
});
