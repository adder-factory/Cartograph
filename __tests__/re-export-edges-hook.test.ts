import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAllFiles, getFileByPath } from '../src/db/queries-files.js';
// Real helpers captured BEFORE vi.mock (bun does not hoist) — the mock
// below delegates to them whenever this suite is not actively running,
// so a leaked mock can't starve another test file's hooks of real
// import/symbol resolution (module-leak canary).
import * as realHelpers from '../src/index-hooks/edge-resolution-helpers.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';

/* Value snapshots taken NOW — before the vi.mock() calls below execute.
   Factory bodies must not read the live namespaces: bun rebinds existing
   namespace imports to the mock, so `realX.fn()` inside a factory would
   call the mock itself (infinite recursion). */
const REAL_HELPERS = { ...realHelpers };

const state = {
  active: false,
  refreshCalls: [] as Array<{ hookName: string; options: unknown; edges: unknown[] }>,
  targets: new Map<string, string>(),
  symbols: new Map<string, string>(),
};

type TargetOptions = { scope: 'all' } | { scope: 'files'; files: string[] };

// Shared by the collectTargets mock and the refreshEdgesHook fallback below.
function realCollectTargets(ctx: IndexHookContext, options: TargetOptions) {
  if (options.scope === 'all') {
    return getAllFiles(ctx.queries).map((file) => ({ path: file.path, language: file.language }));
  }
  return options.files
    .map((filePath) => getFileByPath(ctx.queries, filePath))
    .filter((file): file is NonNullable<typeof file> => file !== null)
    .map((file) => ({ path: file.path, language: file.language }));
}

vi.mock('../src/index-hooks/edge-resolution-helpers.js', () => ({
  ...REAL_HELPERS,
  PER_FILE_YIELD_INTERVAL: 2,
  collectTargets: vi.fn((ctx: IndexHookContext, options: TargetOptions) => realCollectTargets(ctx, options)),
  yieldToEventLoop: vi.fn(async () => {}),
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
      if (!state.active || args.hookName !== 're-export-edges') {
        await REAL_HELPERS.refreshEdgesHook(args as never);
        return;
      }
      const edges = await args.buildEdges(args.ctx, [
        { path: 'src/barrel.ts', language: 'typescript' },
        { path: 'src/ignored.py', language: 'python' },
        { path: 'src/self.ts', language: 'typescript' },
        { path: 'src/empty.ts', language: 'typescript' },
      ]);
      state.refreshCalls.push({ hookName: args.hookName, options: args.options, edges });
    },
  ),
  resolveTargetFile: vi.fn((...args: Parameters<typeof REAL_HELPERS.resolveTargetFile>) =>
    state.active ? (state.targets.get(`${args[0]}:${args[1]}`) ?? null) : REAL_HELPERS.resolveTargetFile(...args),
  ),
  lookupSymbolByNameInFile: vi.fn((...args: Parameters<typeof REAL_HELPERS.lookupSymbolByNameInFile>) =>
    state.active ? (state.symbols.get(`${args[2]}:${args[1]}`) ?? null) : REAL_HELPERS.lookupSymbolByNameInFile(...args),
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

afterAll(() => {
  // Return the mocked helpers to real behavior for later test files in
  // the same bun process (module-leak canary).
  state.active = false;
});

beforeEach(() => {
  state.active = true;
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
