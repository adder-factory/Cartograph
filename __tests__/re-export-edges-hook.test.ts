import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexHookContext } from '../src/index-hooks/types.js';

const state = {
  refreshCalls: [] as Array<{ hookName: string; options: unknown; edges: unknown[] }>,
  targets: new Map<string, string>(),
  symbols: new Map<string, string>(),
};

vi.mock('../src/index-hooks/edge-resolution-helpers.js', () => ({
  PER_FILE_YIELD_INTERVAL: 2,
  yieldToEventLoop: vi.fn(async () => {}),
  refreshEdgesHook: vi.fn(async (args: {
    ctx: IndexHookContext;
    options: unknown;
    hookName: string;
    buildEdges: (ctx: IndexHookContext, files: Array<{ path: string; language: string }>) => Promise<unknown[]>;
  }) => {
    const edges = await args.buildEdges(args.ctx, [
      { path: 'src/barrel.ts', language: 'typescript' },
      { path: 'src/ignored.py', language: 'python' },
      { path: 'src/self.ts', language: 'typescript' },
      { path: 'src/empty.ts', language: 'typescript' },
    ]);
    state.refreshCalls.push({ hookName: args.hookName, options: args.options, edges });
  }),
  resolveTargetFile: vi.fn((fileDir: string, source: string) => state.targets.get(`${fileDir}:${source}`) ?? null),
  lookupSymbolByNameInFile: vi.fn((_ctx: IndexHookContext, name: string, targetFile: string) =>
    state.symbols.get(`${targetFile}:${name}`) ?? null,
  ),
}));

const { HOOK } = await import('../src/index-hooks/re-export-edges.js');

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-re-export-hook-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function ctx(projectRoot: string): IndexHookContext {
  return { projectRoot, queries: {}, config: {} } as IndexHookContext;
}

beforeEach(() => {
  state.refreshCalls = [];
  state.targets.clear();
  state.symbols.clear();
  vi.clearAllMocks();
});

describe('re-export-edges hook', () => {
  it('emits references for named re-exports and skips wildcard, self, missing, and unsupported files', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(
        path.join(root, 'src', 'barrel.ts'),
        [
          "export { foo, bar as publicBar, missing } from './target.js';",
          "export * from './target.js';",
          "export { local } from './barrel.js';",
          "export { nope } from './missing.js';",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(root, 'src', 'self.ts'), "export { local } from './self.js';");
      fs.writeFileSync(path.join(root, 'src', 'empty.ts'), 'export const empty = true;');

      state.targets.set('src:./target.js', 'src/target.ts');
      state.targets.set('src:./barrel.js', 'src/barrel.ts');
      state.targets.set('src:./self.js', 'src/self.ts');
      state.symbols.set('src/target.ts:foo', 'target:foo');
      state.symbols.set('src/target.ts:bar', 'target:bar');

      await HOOK.afterIndexAll(ctx(root));

      expect(state.refreshCalls).toHaveLength(1);
      expect(state.refreshCalls[0]!.hookName).toBe('re-export-edges');
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'all' });
      expect(state.refreshCalls[0]!.edges).toEqual([
        { source: 'file:src/barrel.ts', target: 'target:foo', kind: 'references' },
        { source: 'file:src/barrel.ts', target: 'target:bar', kind: 'references' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes changed files on sync and skips no-op syncs', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { foo } from './target.js';");
      state.targets.set('src:./target.js', 'src/target.ts');
      state.symbols.set('src/target.ts:foo', 'target:foo');

      await HOOK.afterSync(ctx(root), { changedFilePaths: [], filesRemoved: 0 } as never);
      expect(state.refreshCalls).toEqual([]);

      await HOOK.afterSync(ctx(root), { changedFilePaths: ['src/barrel.ts'], filesRemoved: 0 } as never);
      expect(state.refreshCalls).toHaveLength(1);
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'files', files: ['src/barrel.ts'] });

      await HOOK.afterSync(ctx(root), { changedFilePaths: undefined, filesRemoved: 1 } as never);
      expect(state.refreshCalls.at(-1)!.options).toEqual({ scope: 'files', files: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
