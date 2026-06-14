import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as edgeQueries from '../src/db/queries-edges.js';
import * as fileQueries from '../src/db/queries-files.js';
import * as searchQueries from '../src/db/queries-search.js';
import * as errorModule from '../src/errors.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';

const state = {
  files: new Map<string, { path: string; language: string }>(),
  symbols: new Map<string, Array<{ id: string }>>(),
  inserted: [] as unknown[],
  logs: [] as string[],
};

vi.spyOn(fileQueries, 'getAllFiles').mockImplementation((() => [
  ...state.files.values(),
]) as typeof fileQueries.getAllFiles);
vi.spyOn(fileQueries, 'getFileByPath').mockImplementation(
  ((_queries: unknown, filePath: string) => state.files.get(filePath) ?? null) as typeof fileQueries.getFileByPath,
);
vi.spyOn(searchQueries, 'getNodesByNameAndFile').mockImplementation(
  ((_queries: unknown, name: string, filePath: string) =>
    state.symbols.get(`${filePath}:${name}`) ?? []) as typeof searchQueries.getNodesByNameAndFile,
);
vi.spyOn(edgeQueries, 'insertEdges').mockImplementation(((_queries: unknown, edges: unknown[]) =>
  state.inserted.push(edges)) as typeof edgeQueries.insertEdges);
vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) =>
  state.logs.push(message)) as typeof errorModule.logDebug);

const {
  collectTargets,
  existsAsFile,
  lookupSymbolByNameInFile,
  readFileSafe,
  refreshEdgesHook,
  resolveTargetFile,
  yieldToEventLoop,
} = await import('../src/index-hooks/edge-resolution-helpers.js');

function ctx(projectRoot = '/repo'): IndexHookContext {
  return { projectRoot, queries: {}, config: {} } as IndexHookContext;
}

beforeEach(() => {
  state.files = new Map([
    ['src/a.ts', { path: 'src/a.ts', language: 'typescript' }],
    ['src/b.py', { path: 'src/b.py', language: 'python' }],
  ]);
  state.symbols.clear();
  state.inserted = [];
  state.logs = [];
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('edge-resolution helper primitives', () => {
  it('collects all-file and changed-file targets from the index', () => {
    expect(collectTargets(ctx(), { scope: 'all' })).toEqual([
      { path: 'src/a.ts', language: 'typescript' },
      { path: 'src/b.py', language: 'python' },
    ]);
    expect(collectTargets(ctx(), { scope: 'files', files: ['src/b.py', 'missing.ts'] })).toEqual([
      { path: 'src/b.py', language: 'python' },
    ]);
  });

  it('resolves relative module specifiers to direct files and directory indexes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export const target = 1;');
      fs.writeFileSync(path.join(root, 'src', 'module.mts'), 'export const moduleTarget = 1;');
      fs.writeFileSync(path.join(root, 'src', 'lib', 'index.tsx'), 'export const lib = 1;');

      expect(resolveTargetFile('src', './target.js', root)).toBe('src/target.ts');
      expect(resolveTargetFile('src', './module.mjs', root)).toBe('src/module.mts');
      expect(resolveTargetFile('src', './lib', root)).toBe(path.join('src', 'lib', 'index.tsx'));
      expect(resolveTargetFile('src', 'react', root)).toBeNull();
      expect(resolveTargetFile('src', './missing', root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves aliased module specifiers through tsconfig paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-alias-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      fs.writeFileSync(path.join(root, 'src', 'aliased.ts'), 'export const aliased = 1;');

      expect(resolveTargetFile('src', '@/aliased', root)).toBe('src/aliased.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a CUSTOM tsconfig path alias that is not in the hard-coded fallback list', () => {
    // `@feature/` is NOT one of the built-in FALLBACK_ALIASES (@/, ~/, @src/,
    // src/, @app/, app/), so resolution depends entirely on the hook context
    // surfacing the project's tsconfig `paths` via getProjectAliases. If the
    // alias map memoization is broken (never loaded / always undefined), the
    // import falls through to the fallback list (miss) and direct lookup
    // (miss) and resolves to null.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-custom-alias-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@feature/*': ['src/feature/*'] } } }),
      );
      fs.writeFileSync(path.join(root, 'src', 'feature', 'widget.ts'), 'export const widget = 1;');

      expect(resolveTargetFile('src', '@feature/widget', root)).toBe('src/feature/widget.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes backslashes in fromDir to forward slashes before resolving', () => {
    // A Windows-style fromDir (`src\sub`) must be normalized to `src/sub` so
    // the relative import resolves from the right directory. Dropping the
    // separator entirely (`srcsub`) would point at a non-existent directory.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-backslash-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'sub', 'target.ts'), 'export const t = 1;');

      expect(resolveTargetFile('src\\sub', './target', root)).toBe('src/sub/target.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads file contents as a utf8 string and returns null for unreadable paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-readfile-'));
    try {
      const filePath = path.join(root, 'data.txt');
      fs.writeFileSync(filePath, 'alpha beta');

      const contents = readFileSafe(filePath);
      expect(typeof contents).toBe('string');
      expect(contents).toBe('alpha beta');

      expect(readFileSafe(path.join(root, 'does-not-exist.txt'))).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports existing files as true and missing paths / directories as false', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-resolution-exists-'));
    try {
      const filePath = path.join(root, 'data.txt');
      fs.writeFileSync(filePath, 'x');

      expect(existsAsFile(filePath)).toBe(true);
      // A directory is not a file.
      expect(existsAsFile(root)).toBe(false);
      // A non-existent path makes statSync throw — the catch must return false.
      expect(existsAsFile(path.join(root, 'missing'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('looks up a symbol id by name and file path', () => {
    state.symbols.set('src/a.ts:target', [{ id: 'node:target' }, { id: 'node:second' }]);

    expect(lookupSymbolByNameInFile(ctx(), 'target', 'src/a.ts')).toBe('node:target');
    expect(lookupSymbolByNameInFile(ctx(), 'missing', 'src/a.ts')).toBeNull();
  });

  it('collects targets, inserts non-empty edge batches, and skips empty batches', async () => {
    await refreshEdgesHook({
      ctx: ctx(),
      options: { scope: 'files', files: ['src/a.ts'] },
      hookName: 'test-hook',
      buildEdges: (_hookCtx, targets) =>
        targets.map((target) => ({
          source: `file:${target.path}`,
          target: 'node:target',
          kind: 'references' as const,
        })),
    });
    expect(state.inserted).toEqual([[{ source: 'file:src/a.ts', target: 'node:target', kind: 'references' }]]);

    await refreshEdgesHook({
      ctx: ctx(),
      options: { scope: 'files', files: ['src/a.ts'] },
      hookName: 'empty-hook',
      buildEdges: () => [],
    });
    expect(state.inserted).toHaveLength(1);
  });

  it('logs and swallows build failures', async () => {
    await refreshEdgesHook({
      ctx: ctx(),
      options: { scope: 'all' },
      hookName: 'broken-hook',
      buildEdges: () => {
        throw new Error('scanner failed');
      },
    });

    expect(state.logs).toEqual(['broken-hook hook failed: scanner failed']);
    expect(state.inserted).toEqual([]);
  });

  it('yields back to the event loop', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});
