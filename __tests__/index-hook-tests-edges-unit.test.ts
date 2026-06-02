import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  files: [] as Array<{ path: string }>,
  subjectsByTest: new Map<string, string[]>(),
  nodesByFile: new Map<string, Array<{ kind: string; name: string }>>(),
  inserted: [] as unknown[][],
  deleteAll: [] as string[],
  deleteSource: [] as Array<{ source: string; kind: string }>,
  inlineRust: new Set<string>(),
};

vi.mock('../src/db/queries-files.js', () => ({
  getAllFiles: vi.fn(() => state.files),
}));

vi.mock('../src/db/queries-edges.js', () => ({
  insertEdges: vi.fn((_queries: unknown, edges: unknown[]) => {
    state.inserted.push(edges);
  }),
  deleteAllEdgesByKind: vi.fn((_queries: unknown, kind: string) => {
    state.deleteAll.push(kind);
  }),
  deleteEdgesBySourceAndKind: vi.fn((_queries: unknown, source: string, kind: string) => {
    state.deleteSource.push({ source, kind });
  }),
}));

vi.mock('../src/tests-edges/index.js', () => ({
  isTestFile: vi.fn((filePath: string) => /(^|\/)(__tests__|tests)\//.test(filePath) || /[._-]test\./.test(filePath)),
  findTestSubjects: vi.fn((testFile: string) => state.subjectsByTest.get(testFile) ?? []),
  cargoIntegrationCrateRoot: vi.fn((filePath: string) => {
    const marker = '/tests/';
    const idx = filePath.indexOf(marker);
    return idx >= 0 ? filePath.slice(0, idx) : null;
  }),
  findRustCrateEntryPoint: vi.fn((crateRoot: string, allFilePaths: Set<string>) => {
    const lib = `${crateRoot}/src/lib.rs`;
    const main = `${crateRoot}/src/main.rs`;
    if (allFilePaths.has(lib)) return lib;
    if (allFilePaths.has(main)) return main;
    return null;
  }),
  rustFileHasInlineTests: vi.fn((content: string) => state.inlineRust.has(content)),
}));

vi.mock('../src/utils.js', () => ({
  readFileSafe: vi.fn((filePath: string) => filePath),
}));

const { HOOK } = await import('../src/index-hooks/tests-edges.js');

function ctx() {
  return {
    projectRoot: '/repo',
    queries: {
      getNodesByFile: (filePath: string) => state.nodesByFile.get(filePath) ?? [],
    },
  } as never;
}

beforeEach(() => {
  state.files = [];
  state.subjectsByTest = new Map();
  state.nodesByFile = new Map();
  state.inserted = [];
  state.deleteAll = [];
  state.deleteSource = [];
  state.inlineRust = new Set();
  vi.clearAllMocks();
});

describe('tests-edges index hook', () => {
  it('rebuilds convention, import-fallback, package-path, and Rust test edges after indexAll', () => {
    state.files = [
      { path: 'src/foo.ts' },
      { path: '__tests__/foo.test.ts' },
      { path: '__tests__/fallback.test.ts' },
      { path: 'src/util/index.ts' },
      { path: 'src/main/kotlin/org/acme/Table.kt' },
      { path: 'crates/app/src/lib.rs' },
      { path: 'crates/app/tests/api_test.rs' },
      { path: 'crates/app/src/logic.rs' },
      { path: 'crates/app/src/helper_test.rs' },
    ];
    state.subjectsByTest.set('__tests__/foo.test.ts', ['src/foo.ts']);
    state.nodesByFile.set('__tests__/fallback.test.ts', [
      { kind: 'import', name: '../src/util' },
      { kind: 'import', name: 'org.acme.Table' },
      { kind: 'import', name: 'vitest' },
      { kind: 'function', name: 'notImport' },
    ]);
    state.inlineRust.add('/repo/crates/app/src/logic.rs');
    state.inlineRust.add('/repo/crates/app/src/helper_test.rs');

    HOOK.afterIndexAll!(ctx());

    expect(state.deleteAll).toEqual(['tests']);
    expect(state.inserted.flat()).toEqual([
      { source: 'file:__tests__/foo.test.ts', target: 'file:src/foo.ts', kind: 'tests' },
      { source: 'file:__tests__/fallback.test.ts', target: 'file:src/util/index.ts', kind: 'tests' },
      {
        source: 'file:__tests__/fallback.test.ts',
        target: 'file:src/main/kotlin/org/acme/Table.kt',
        kind: 'tests',
      },
      { source: 'file:crates/app/tests/api_test.rs', target: 'file:crates/app/src/lib.rs', kind: 'tests' },
      { source: 'file:crates/app/src/logic.rs', target: 'file:crates/app/src/logic.rs', kind: 'tests' },
    ]);
  });

  it('refreshes only changed tracked tests and Rust files after sync', () => {
    state.files = [
      { path: 'src/foo.ts' },
      { path: '__tests__/foo.test.ts' },
      { path: 'crates/app/src/lib.rs' },
      { path: 'crates/app/tests/api.rs' },
    ];
    state.subjectsByTest.set('__tests__/foo.test.ts', ['src/foo.ts']);

    HOOK.afterSync!(ctx(), {
      changedFilePaths: ['__tests__/foo.test.ts', 'crates/app/tests/api.rs', 'deleted.test.ts'],
      filesAdded: 0,
      filesModified: 2,
      filesRemoved: 0,
    } as never);

    expect(state.deleteSource).toEqual([
      { source: 'file:__tests__/foo.test.ts', kind: 'tests' },
      { source: 'file:crates/app/tests/api.rs', kind: 'tests' },
      { source: 'file:crates/app/tests/api.rs', kind: 'tests' },
    ]);
    expect(state.inserted.flat()).toEqual([
      { source: 'file:__tests__/foo.test.ts', target: 'file:src/foo.ts', kind: 'tests' },
      { source: 'file:crates/app/tests/api.rs', target: 'file:crates/app/src/lib.rs', kind: 'tests' },
    ]);
  });

  it('falls back to a full rebuild on sync results without changedFilePaths', () => {
    state.files = [{ path: 'src/foo.ts' }, { path: '__tests__/foo.test.ts' }];
    state.subjectsByTest.set('__tests__/foo.test.ts', ['src/foo.ts']);

    HOOK.afterSync!(ctx(), { filesAdded: 1, filesModified: 0, filesRemoved: 0 } as never);

    expect(state.deleteAll).toEqual(['tests']);
    expect(state.inserted.flat()).toEqual([
      { source: 'file:__tests__/foo.test.ts', target: 'file:src/foo.ts', kind: 'tests' },
    ]);
  });
});
