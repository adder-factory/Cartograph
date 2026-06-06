import { describe, expect, it } from 'vitest';
import { parseMaxAgeDays, registerAdminPruneStoreCommand } from '../src/features/admin-prune-store/index.js';

describe('admin prune-store feature runtime', () => {
  it('parses max age as a result value', () => {
    expect(parseMaxAgeDays(undefined, 30)).toEqual({ ok: true, value: 30 });
    expect(parseMaxAgeDays('0', 30)).toEqual({ ok: true, value: 0 });
    expect(parseMaxAgeDays('7.5', 30)).toEqual({ ok: true, value: 7.5 });
    expect(parseMaxAgeDays('-1', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got '-1'.",
    });
    expect(parseMaxAgeDays('old', 30)).toEqual({
      ok: false,
      error: "--max-age-days must be a non-negative number. Got 'old'.",
    });
  });
});

describe('admin prune-store feature CLI', () => {
  it('prunes orphan store rows, reclaims the DB, and closes the graph', async () => {
    let action: ((pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) | undefined;
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
});

function fakeCommand(
  setAction: (fn: (pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) => void,
) {
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
    action(fn: (pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) {
      setAction(fn);
      return this;
    },
  };
}
