import { errMsg } from '../../errors.js';
import type { LlmEndpointConfig } from '../../llm/client.js';
import { getEmbeddingModel } from '../../llm/provider.js';
import type { SqliteDatabase } from '../../db/sqlite-adapter.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import {
  auditEmbeddingStorage,
  cleanupObsoleteEmbeddings,
  formatEmbeddingAudit,
  formatEmbeddingCleanup,
} from './runtime.js';

interface EmbeddingMaintenanceGraph {
  projectRoot: string;
  db: {
    getDb: () => SqliteDatabase;
    hasVecExtension: () => boolean;
  };
  llm: {
    config: { getEffectiveLlmConfig: () => Promise<LlmEndpointConfig | null | undefined> };
    embed: {
      embeddingCache: { invalidate: () => void };
      hnswByDim: { clear: () => void };
    };
  };
  close: () => void;
}

export interface AdminEmbeddingMaintenanceCommandDeps {
  adminCmd: CliOptionCommand;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, options?: { autoMigrate?: boolean }) => Promise<EmbeddingMaintenanceGraph>;
    };
  }>;
  loadDbIndex: () => Promise<{ dbReclaimAfterBulkDelete: (db: unknown) => void }>;
  writeStdout: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminEmbeddingMaintenanceCommands(deps: AdminEmbeddingMaintenanceCommandDeps): void {
  registerAuditCommand(deps);
  registerCleanupCommand(deps);
}

function registerAuditCommand(deps: AdminEmbeddingMaintenanceCommandDeps): void {
  deps.adminCmd
    .command('embedding-audit [path]')
    .description(
      "Audit embedding models, dimensions, refs/orphans, and acceleration artifacts (mirrors cartograph_admin action='embedding-audit')",
    )
    .action(async (pathArg: string | undefined) => {
      const projectPath = deps.resolveProjectPath(pathArg);
      if (!ensureInitialized(deps, projectPath)) return;
      try {
        const { default: Cartograph } = await deps.loadCartograph();
        const cg = await Cartograph.open(projectPath);
        try {
          const activeModel = getEmbeddingModel(await cg.llm.config.getEffectiveLlmConfig());
          const report = auditEmbeddingStorage({ db: cg.db.getDb(), projectRoot: cg.projectRoot, activeModel });
          deps.writeStdout(`${formatEmbeddingAudit(report)}\n`);
        } finally {
          cg.close();
        }
      } catch (error_) {
        fail(deps, `Embedding audit failed: ${errMsg(error_)}`);
      }
    });
}

function registerCleanupCommand(deps: AdminEmbeddingMaintenanceCommandDeps): void {
  deps.adminCmd
    .command('embedding-cleanup [path]')
    .description(
      "Dry-run safe obsolete embedding cleanup; --confirm applies it (mirrors cartograph_admin action='embedding-cleanup')",
    )
    .option(
      '--confirm',
      'Detach superseded legacy refs, delete safely orphaned non-active rows, then reconcile vec/pgvector/HNSW artifacts',
    )
    .action(async (pathArg: string | undefined, opts: Record<string, boolean | undefined>) => {
      const projectPath = deps.resolveProjectPath(pathArg);
      if (!ensureInitialized(deps, projectPath)) return;
      try {
        const { default: Cartograph } = await deps.loadCartograph();
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });
        try {
          const activeModel = getEmbeddingModel(await cg.llm.config.getEffectiveLlmConfig());
          const result = cleanupObsoleteEmbeddings({
            db: cg.db.getDb(),
            projectRoot: cg.projectRoot,
            activeModel,
            vecLoaded: cg.db.hasVecExtension(),
            confirm: opts['confirm'] === true,
          });
          if (!result.dryRun && (result.deletedRows > 0 || result.deletedRefs > 0)) {
            cg.llm.embed.embeddingCache.invalidate();
            cg.llm.embed.hnswByDim.clear();
          }
          if (!result.dryRun && result.deletedRows > 0) {
            const { dbReclaimAfterBulkDelete } = await deps.loadDbIndex();
            dbReclaimAfterBulkDelete(cg.db);
          }
          deps.writeStdout(`${formatEmbeddingCleanup(result)}\n`);
        } finally {
          cg.close();
        }
      } catch (error_) {
        fail(deps, `Embedding cleanup failed: ${errMsg(error_)}`);
      }
    });
}

function ensureInitialized(deps: AdminEmbeddingMaintenanceCommandDeps, projectPath: string): boolean {
  if (deps.isInitialized(projectPath)) return true;
  fail(deps, `Cartograph not initialized in ${projectPath}`);
  return false;
}

function fail(deps: AdminEmbeddingMaintenanceCommandDeps, message: string): void {
  deps.error(message);
  process.exitCode = 1;
}
