import { errMsg } from '../../errors.js';
import { parseMaxAgeDays } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

interface PruneStoreGraph {
  queries: unknown;
  db: { getSize: () => number };
  close: () => void;
}

export interface AdminPruneStoreCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts?: { autoMigrate?: boolean }) => Promise<PruneStoreGraph>;
    };
  }>;
  loadSummaryQueries: () => Promise<{
    MS_PER_DAY: number;
    PRUNE_STORE_DEFAULT_DAYS: number;
    pruneOrphanStoreRows: (
      queries: unknown,
      options: { maxAgeMs: number },
    ) => { summariesPruned: number; embeddingsPruned: number };
  }>;
  loadDbIndex: () => Promise<{ dbReclaimAfterBulkDelete: (db: unknown) => void }>;
  formatNumber: (n: number) => string;
  formatBytes: (bytes: number) => string;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminPruneStoreCommand(deps: AdminPruneStoreCommandDeps): void {
  const {
    adminCmd,
    error,
    formatBytes,
    formatNumber,
    info,
    isInitialized,
    loadCartograph,
    loadDbIndex,
    loadSummaryQueries,
    resolveProjectPath,
    success,
  } = deps;
  adminCmd
    .command('prune-store [path]')
    .description(
      "Evict cold orphan summary_store/embedding_store rows (mirrors cartograph_admin MCP tool with action='prune-store')",
    )
    .option(
      '--max-age-days <number>',
      'Evict orphans older than this many days (default uses PRUNE_STORE_DEFAULT_DAYS; 0 = evict every orphan now)',
    )
    .action(async (pathArg: string | undefined, opts) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exitCode = 1;
          return;
        }
        const { pruneOrphanStoreRows, MS_PER_DAY, PRUNE_STORE_DEFAULT_DAYS } = await loadSummaryQueries();
        const parsed = parseMaxAgeDays(
          (opts as Record<string, string | undefined>)['maxAgeDays'],
          PRUNE_STORE_DEFAULT_DAYS,
        );
        if (!parsed.ok) {
          error(parsed.error);
          process.exitCode = 1;
          return;
        }

        const { default: Cartograph } = await loadCartograph();
        // Write path: opt in to auto-migration so a cold project that's
        // never touched the new prune-store action still picks up
        // migration 053 on first run.
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });
        try {
          const { dbReclaimAfterBulkDelete } = await loadDbIndex();
          const sizeBefore = cg.db.getSize();
          const result = pruneOrphanStoreRows(cg.queries, {
            maxAgeMs: parsed.value * MS_PER_DAY,
          });
          const totalPruned = result.summariesPruned + result.embeddingsPruned;
          // Deleting rows only moves pages to the freelist. Reclaim the
          // freelist and truncate the WAL so the prune actually shrinks
          // the DB. Skipped when nothing was deleted.
          if (totalPruned > 0) {
            dbReclaimAfterBulkDelete(cg.db);
          }
          const sizeAfter = cg.db.getSize();
          success(
            `Pruned ${formatNumber(result.summariesPruned)} summary_store + ` +
              `${formatNumber(result.embeddingsPruned)} embedding_store row(s) ` +
              `older than ${parsed.value} day(s).`,
          );
          if (totalPruned > 0) {
            const reclaimed = sizeBefore - sizeAfter;
            info(
              `Database: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} ` +
                `(reclaimed ${formatBytes(Math.max(0, reclaimed))}).`,
            );
          }
        } finally {
          cg.close();
        }
      } catch (err) {
        error(`Failed to prune store: ${errMsg(err)}`);
        process.exitCode = 1;
      }
    });
}
