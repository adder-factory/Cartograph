import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexHookContext } from '../src/index-hooks/types.js';

const state = {
  refreshCalls: [] as Array<{ hookName: string; options: unknown; edges: unknown[] }>,
  symbols: new Map<string, string>(),
  targets: new Map<string, string>(),
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
      { path: 'src/consumer.ts', language: 'typescript' },
      { path: 'src/ignored.py', language: 'python' },
      { path: 'src/no-import.ts', language: 'typescript' },
      { path: 'src/self.ts', language: 'typescript' },
    ]);
    state.refreshCalls.push({ hookName: args.hookName, options: args.options, edges });
  }),
  resolveTargetFile: vi.fn((fileDir: string, source: string) => state.targets.get(`${fileDir}:${source}`) ?? null),
  lookupSymbolByNameInFile: vi.fn((_ctx: IndexHookContext, name: string, targetFile: string) =>
    state.symbols.get(`${targetFile}:${name}`) ?? null,
  ),
}));

const { HOOK } = await import('../src/index-hooks/dynamic-import-edges.js');

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dynamic-import-hook-'));
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
  state.refreshCalls = [];
  state.symbols.clear();
  state.targets.clear();
  vi.clearAllMocks();
});

describe('dynamic-import-edges hook', () => {
  it('extracts destructured and inline dynamic import symbol references', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(
        path.join(root, 'src', 'consumer.ts'),
        [
          "const ignored = \"import('./inside-string').Nope\";",
          "// const { hidden } = await import('./commented.js');",
          "const { foo, bar: alias, type Baz, qux as renamed, ignoredMissing } = await import('./target.js');",
          "type Loaded = import('./types.js').Widget;",
          "const self = import('./consumer.js').local;",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(root, 'src', 'no-import.ts'), 'export const plain = 1;');
      fs.writeFileSync(path.join(root, 'src', 'self.ts'), "const { local } = await import('./self.js');");

      state.targets.set('src:./target.js', 'src/target.ts');
      state.targets.set('src:./types.js', 'src/types.ts');
      state.targets.set('src:./consumer.js', 'src/consumer.ts');
      state.targets.set('src:./self.js', 'src/self.ts');
      state.symbols.set('src/target.ts:foo', 'target:foo');
      state.symbols.set('src/target.ts:bar', 'target:bar');
      state.symbols.set('src/target.ts:Baz', 'target:Baz');
      state.symbols.set('src/target.ts:qux', 'target:qux');
      state.symbols.set('src/types.ts:Widget', 'types:Widget');

      await HOOK.afterIndexAll(ctx(root));

      expect(state.refreshCalls).toHaveLength(1);
      expect(state.refreshCalls[0]!.hookName).toBe('dynamic-import-edges');
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'all' });
      expect(state.refreshCalls[0]!.edges).toEqual([
        { source: 'file:src/consumer.ts', target: 'target:foo', kind: 'references' },
        { source: 'file:src/consumer.ts', target: 'target:bar', kind: 'references' },
        { source: 'file:src/consumer.ts', target: 'target:Baz', kind: 'references' },
        { source: 'file:src/consumer.ts', target: 'target:qux', kind: 'references' },
        { source: 'file:src/consumer.ts', target: 'types:Widget', kind: 'references' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes changed files on sync and skips no-op syncs', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "const { foo } = await import('./target.js');");
      state.targets.set('src:./target.js', 'src/target.ts');
      state.symbols.set('src/target.ts:foo', 'target:foo');

      await HOOK.afterSync(ctx(root), { changedFilePaths: [], filesRemoved: 0 } as never);
      expect(state.refreshCalls).toEqual([]);

      await HOOK.afterSync(ctx(root), { changedFilePaths: ['src/consumer.ts'], filesRemoved: 0 } as never);
      expect(state.refreshCalls).toHaveLength(1);
      expect(state.refreshCalls[0]!.options).toEqual({ scope: 'files', files: ['src/consumer.ts'] });

      await HOOK.afterSync(ctx(root), { changedFilePaths: undefined, filesRemoved: 1 } as never);
      expect(state.refreshCalls.at(-1)!.options).toEqual({ scope: 'files', files: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
