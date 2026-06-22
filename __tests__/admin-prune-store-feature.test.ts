import { describe, expect, it, vi } from 'vitest';
import {
  parseMaxAgeDays,
  registerAdminPruneStoreCommand,
  type AdminPruneStoreCommandDeps,
} from '../src/features/admin-prune-store/index.js';

type PruneAction = (pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>;

describe('admin prune-store feature runtime', () => {
  it('parses max age as a result value', () => {
    expect(parseMaxAgeDays(undefined, 30)).toEqual({ ok: true, value: 30 });
    expect(parseMaxAgeDays('0', 30)).toEqual({ ok: true, value: 0 });
    expect(parseMaxAgeDays('7.5', 30)).toEqual({ ok: true, value: 7.5 });
    expect(parseMaxAgeDays('.5', 30)).toEqual({ ok: true, value: 0.5 });
    expect(parseMaxAgeDays('-1', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got '-1'.",
    });
    expect(parseMaxAgeDays('old', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got 'old'.",
    });
    expect(parseMaxAgeDays('7.5days', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got '7.5days'.",
    });
    expect(parseMaxAgeDays('1e3', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got '1e3'.",
    });
    expect(parseMaxAgeDays('   ', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got '   '.",
    });
  });
});

describe('admin prune-store feature CLI', () => {
  it('prunes orphan store rows, reclaims the DB, and closes the graph', async () => {
    let action: PruneAction | undefined;
    const calls: string[] = [];
    let sizeCall = 0;

    registerAdminPruneStoreCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      loadCartograph: async () => ({
        default: {
          open: async (projectPath, opts) => {
            calls.push(`open:${projectPath}:${JSON.stringify(opts)}`);
            return {
              queries: { id: 'queries' },
              db: { getSize: () => (sizeCall++ === 0 ? 4096 : 2048) },
              close: () => calls.push('close'),
            };
          },
        },
      }),
      loadSummaryQueries: async () => ({
        MS_PER_DAY: 100,
        PRUNE_STORE_DEFAULT_DAYS: 30,
        pruneOrphanStoreRows: (_queries, opts) => {
          calls.push(`prune:${JSON.stringify(opts)}`);
          return { summariesPruned: 2, embeddingsPruned: 1 };
        },
      }),
      loadDbIndex: async () => ({
        dbReclaimAfterBulkDelete: () => calls.push('reclaim'),
      }),
      formatNumber: (n) => String(n),
      formatBytes: (bytes) => `${bytes} B`,
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });

    expect(action).toBeDefined();
    await action!('/repo', { maxAgeDays: '7' });

    expect(calls).toEqual([
      'open:/repo:{"autoMigrate":true}',
      'prune:{"maxAgeMs":700}',
      'reclaim',
      'success:Pruned 2 summary_store + 1 embedding_store row(s) older than 7 day(s).',
      'info:Database: 4096 B → 2048 B (reclaimed 2048 B).',
      'close',
    ]);
  });

  it('reports an uninitialized project without hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const calls: string[] = [];
      const action = registerAction({
        resolveProjectPath: (pathArg) => pathArg ?? '/repo',
        isInitialized: () => false,
        loadCartograph: async () => {
          calls.push('loadCartograph');
          throw new Error('loadCartograph should not run');
        },
        loadSummaryQueries: async () => {
          calls.push('loadSummaryQueries');
          throw new Error('loadSummaryQueries should not run');
        },
        loadDbIndex: async () => {
          calls.push('loadDbIndex');
          throw new Error('loadDbIndex should not run');
        },
        error: (message) => calls.push(`error:${message}`),
      });

      await action('/repo', {});

      expect(calls).toEqual(['error:Cartograph not initialized in /repo']);
      expect(process.exitCode).toBe(1);
    });
  });

  it('reports invalid max-age input without opening the graph or hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const calls: string[] = [];
      const action = registerAction({
        resolveProjectPath: (pathArg) => pathArg ?? '/repo',
        isInitialized: () => true,
        loadSummaryQueries: async () => {
          calls.push('loadSummaryQueries');
          return {
            MS_PER_DAY: 100,
            PRUNE_STORE_DEFAULT_DAYS: 30,
            pruneOrphanStoreRows: () => {
              calls.push('prune');
              return { summariesPruned: 0, embeddingsPruned: 0 };
            },
          };
        },
        loadCartograph: async () => {
          calls.push('loadCartograph');
          throw new Error('loadCartograph should not run');
        },
        loadDbIndex: async () => {
          calls.push('loadDbIndex');
          throw new Error('loadDbIndex should not run');
        },
        error: (message) => calls.push(`error:${message}`),
      });

      await action('/repo', { maxAgeDays: '-1' });

      expect(calls).toEqual(['loadSummaryQueries', "error:--max-age-days must be a non-negative number. Got '-1'."]);
      expect(process.exitCode).toBe(1);
    });
  });

  it('reports prune failures, closes the graph, and does not hard-exit', async () => {
    await withProcessExitGuard(async () => {
      const calls: string[] = [];
      const action = registerAction({
        resolveProjectPath: (pathArg) => pathArg ?? '/repo',
        isInitialized: () => true,
        loadCartograph: async () => ({
          default: {
            open: async (projectPath, opts) => {
              calls.push(`open:${projectPath}:${JSON.stringify(opts)}`);
              return {
                queries: { id: 'queries' },
                db: { getSize: () => 4096 },
                close: () => calls.push('close'),
              };
            },
          },
        }),
        loadSummaryQueries: async () => ({
          MS_PER_DAY: 100,
          PRUNE_STORE_DEFAULT_DAYS: 30,
          pruneOrphanStoreRows: () => {
            calls.push('prune');
            throw new Error('delete failed');
          },
        }),
        loadDbIndex: async () => ({
          dbReclaimAfterBulkDelete: () => calls.push('reclaim'),
        }),
        error: (message) => calls.push(`error:${message}`),
      });

      await action('/repo', { maxAgeDays: '7' });

      expect(calls).toEqual([
        'open:/repo:{"autoMigrate":true}',
        'prune',
        'close',
        'error:Failed to prune store: delete failed',
      ]);
      expect(process.exitCode).toBe(1);
    });
  });
});

function fakeCommand(setAction: (fn: PruneAction) => void) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(fn: PruneAction) {
      setAction(fn);
      return this;
    },
  };
}

function registerAction(overrides: Partial<AdminPruneStoreCommandDeps>): PruneAction {
  let action: PruneAction | undefined;
  registerAdminPruneStoreCommand({
    adminCmd: fakeCommand((fn) => {
      action = fn;
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    isInitialized: () => true,
    loadCartograph: async () => ({
      default: {
        open: async () => ({
          queries: {},
          db: { getSize: () => 0 },
          close: () => {},
        }),
      },
    }),
    loadSummaryQueries: async () => ({
      MS_PER_DAY: 1,
      PRUNE_STORE_DEFAULT_DAYS: 30,
      pruneOrphanStoreRows: () => ({ summariesPruned: 0, embeddingsPruned: 0 }),
    }),
    loadDbIndex: async () => ({
      dbReclaimAfterBulkDelete: () => {},
    }),
    formatNumber: (n) => String(n),
    formatBytes: (bytes) => `${bytes} B`,
    success: () => {},
    info: () => {},
    error: () => {},
    ...overrides,
  });
  if (!action) throw new Error('prune-store action was not registered');
  return action;
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<void> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await run();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    process.exitCode = 0;
  }
}
