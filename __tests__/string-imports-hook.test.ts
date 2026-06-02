import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexHookContext } from '../src/index-hooks/types.js';

const state = {
  files: new Map<string, { path: string; language: string }>(),
  metadata: new Map<string, string>(),
  calls: [] as Array<{ name: string; value?: unknown }>,
  throwExtract: false,
};

vi.mock('../src/string-imports/index.js', () => ({
  STRING_IMPORTS_ALGO_VERSION: 'algo-test',
  LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY: 'last-string-imports',
  extractStringImports: vi.fn((_root: string, targets: Array<{ path: string; language: string }>) => {
    state.calls.push({ name: 'extractStringImports', value: targets });
    if (state.throwExtract) throw new Error('extract failed');
    return targets.map((target) => ({ filePath: target.path, line: 1, moduleName: './x', raw: 'import x', containerKind: 'string_literal' }));
  }),
}));

vi.mock('../src/db/queries-files.js', () => ({
  getAllFiles: vi.fn(() => [...state.files.values()]),
  getFileByPath: vi.fn((_queries: unknown, filePath: string) => state.files.get(filePath) ?? null),
}));

vi.mock('../src/db/queries-string-imports.js', () => ({
  applyStringImports: vi.fn((_queries: unknown, refs: unknown) => state.calls.push({ name: 'applyStringImports', value: refs })),
  clearStringImports: vi.fn(() => state.calls.push({ name: 'clearStringImports' })),
  deleteStringImportsForPaths: vi.fn((_queries: unknown, paths: string[]) =>
    state.calls.push({ name: 'deleteStringImportsForPaths', value: paths }),
  ),
  pruneOrphanedStringImports: vi.fn(() => state.calls.push({ name: 'pruneOrphanedStringImports' })),
}));

vi.mock('../src/db/queries-metadata.js', () => ({
  getMetadata: vi.fn((_queries: unknown, key: string) => state.metadata.get(key) ?? null),
  setMetadata: vi.fn((_queries: unknown, key: string, value: string) => {
    state.calls.push({ name: 'setMetadata', value: { key, value } });
    state.metadata.set(key, value);
  }),
}));

vi.mock('../src/errors.js', () => ({
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  logDebug: vi.fn((message: string) => state.calls.push({ name: 'logDebug', value: message })),
}));

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
    expect(state.metadata.get('last-string-imports')).toBe('algo-test');
  });

  it('self-heals stale algorithm metadata before changed-file handling', () => {
    state.metadata.set('last-string-imports', 'old');

    HOOK.afterSync(ctx(), { changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never);

    expect(state.calls[0]?.name).toBe('clearStringImports');
    expect(state.calls.some((call) => call.name === 'deleteStringImportsForPaths')).toBe(false);
  });

  it('refreshes only changed indexed files on sync and prunes removed-file rows', () => {
    state.metadata.set('last-string-imports', 'algo-test');

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
    expect(state.metadata.get('last-string-imports')).toBeUndefined();
  });
});
