/**
 * `cartograph admin` family subcommands — extracted from the
 * bin/cartograph.ts decomposition.
 */
import * as fs from 'node:fs';
import { getCartographDir as defaultGetCartographDir, isInitialized as defaultIsInitialized } from '../../directory.js';
import { createShimmerProgress as defaultCreateShimmerProgress } from '../../ui/shimmer-progress.js';
import { formatBytes as defaultFormatBytes } from '../../utils.js';
import {
  writeScipExport as defaultWriteScipExport,
  writeScipImport as defaultWriteScipImport,
} from '../../scip/index.js';
import { parseConcurrency as defaultParseConcurrency } from '../../llm/concurrency.js';
import { registerAdminDoctorCommand } from '../../features/admin-doctor/index.js';
import { registerAdminIndexingCommands } from '../../features/admin-indexing/index.js';
import { registerAdminLlmEnrichmentCommands } from '../../features/admin-llm-enrichment/index.js';
import { registerAdminInstallModelsCommand } from '../../features/admin-install-models/index.js';
import { registerAdminLlmSetupCommands } from '../../features/admin-llm-setup/index.js';
import { registerAdminMigrateCommand } from '../../features/admin-migrate/index.js';
import { registerAdminProjectLifecycleCommands } from '../../features/admin-project-lifecycle/index.js';
import { registerAdminPruneStoreCommand } from '../../features/admin-prune-store/index.js';
import { registerAdminSimilarityEdgesCommand } from '../../features/admin-similarity-edges/index.js';
import { registerAdminStorageMigrateCommand } from '../../features/admin-storage-migrate/index.js';
import { registerAdminUnlockCommand } from '../../features/admin-unlock/index.js';
import { registerScipAdminCommands } from '../../features/scip-admin/index.js';
import type { Command } from 'commander';
import {
  adminCmd as cliAdminCmd,
  loadCartograph as cliLoadCartograph,
  resolveProjectPath as cliResolveProjectPath,
  chalk as cliChalk,
  colors as cliColors,
  success as cliSuccess,
  error as cliError,
  info as cliInfo,
  warn as cliWarn,
  formatNumber as cliFormatNumber,
  formatDuration as cliFormatDuration,
  createVerboseProgress as cliCreateVerboseProgress,
  attachUnknownActionHandler as cliAttachUnknownActionHandler,
  assignIntArg as cliAssignIntArg,
  assignFloatArg as cliAssignFloatArg,
  awaitSummarisationWithProgress as cliAwaitSummarisationWithProgress,
  printIndexResult as cliPrintIndexResult,
} from '../_cli-core.js';

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

export interface AdminCommandDeps {
  // The real commander Command — it is both the admin-family builder
  // passed to every sub-registrar and the value handed to
  // attachUnknownActionHandler, which reads Command-only members.
  adminCmd: Command;
  // DI seam: this single loadCartograph is forwarded to every admin
  // sub-registrar, each of which narrows the opened graph to its own
  // structural subset (AdminIndexGraph, ProjectLifecycleGraph, ...).
  // The real Cartograph is not assignable to those divergent subsets,
  // so only `any` flows through to all of them.
  // biome-ignore lint/suspicious/noExplicitAny: DI seam — real Cartograph is not assignable to the per-sub-registrar narrowed graph subsets
  loadCartograph: () => Promise<{ default: any }>;
  resolveProjectPath: (pathArg?: string) => string;
  chalk: typeof cliChalk;
  colors: typeof cliColors;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  formatNumber: (n: number) => string;
  formatDuration: (ms: number) => string;
  formatBytes: (bytes: number) => string;
  createVerboseProgress: typeof cliCreateVerboseProgress;
  createShimmerProgress: typeof defaultCreateShimmerProgress;
  attachUnknownActionHandler: (group: Command, family: string) => void;
  assignIntArg: (args: AssignNumericArgInput) => boolean;
  assignFloatArg: (args: AssignNumericArgInput) => boolean;
  awaitSummarisationWithProgress: typeof cliAwaitSummarisationWithProgress;
  printIndexResult: typeof cliPrintIndexResult;
  getCartographDir: (projectPath: string) => string;
  isInitialized: (projectPath: string) => boolean;
  parseConcurrency: (raw: string | undefined) => number;
  writeScipExport: typeof defaultWriteScipExport;
  writeScipImport: typeof defaultWriteScipImport;
  writeStdout: (message: string) => void;
  writeStderr: (message: string) => void;
  loadClack: () => Promise<typeof import('@clack/prompts')>;
  loadReadline: () => Promise<{ createInterface: typeof import('node:readline').createInterface }>;
  loadParseCache: () => Promise<{ clearParseCache: (queries: unknown, language?: string) => number }>;
  loadDetachedSummarize: () => Promise<{
    spawnDetachedSummarize: (projectPath: string) => { spawned: boolean; pid?: number; reason?: string };
  }>;
  loadSimilarEdges: () => Promise<{
    buildSimilarToEdges: (
      cg: unknown,
      options: { k: number; minScore: number },
    ) => Promise<{
      written: number;
      processed: number;
      reason?: string;
    }>;
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
  loadInstallModels: () => Promise<{
    installRecommendedModels: (opts: {
      dir?: string;
      models: readonly unknown[];
      onProgress: (progress: { model: { filename: string }; downloaded: number; total: number }) => void;
    }) => Promise<{
      downloaded: Array<{ filename: string; description: string }>;
      skipped: Array<{ filename: string }>;
    }>;
  }>;
  loadRecommendedModels: () => Promise<{ RECOMMENDED_MODELS: readonly unknown[]; MINIMAL_MODELS: readonly unknown[] }>;
  loadRecommendedConfig: () => Promise<{
    writeRecommendedLlmConfig: (opts: {
      projectRoot: string;
      dir?: string;
      includeAsk?: boolean;
      includeReranker?: boolean;
    }) => {
      configPath: string;
      backupPath?: string | null;
      diff: { addedOrUpdated: readonly string[] };
    };
  }>;
  loadDoctor: () => Promise<{
    runDoctor: (
      opts: Record<string, unknown>,
    ) => Promise<{ overallStatus: string; afterFix?: { overallStatus: string } }>;
    formatDoctorReport: (result: unknown) => string;
    formatDoctorJson: (result: unknown) => string;
  }>;
  loadLlmSetupPlan: () => Promise<{
    planLlmSetup: (opts?: { projectPath?: string }) => Promise<{
      recommendedPresetId: string;
      detectedBackends: ReadonlyArray<{ label: string; endpoint: string; models: readonly string[] }>;
      presets: ReadonlyArray<{ id: string; summary: string }>;
      localBackends: {
        configured: number;
        notRunning: ReadonlyArray<{ labels: readonly string[]; endpoint: string; modelExists: boolean }>;
        llamaServerOnPath: boolean;
        startCommand: string | null;
      };
    }>;
    applyLlmSetupChoice: (opts: { projectRoot: string; preset: string }) => Promise<{
      applied: boolean;
      preset: string;
      configPath: string;
      backupPath?: string | null;
      notes: readonly string[];
      nextSteps: readonly string[];
    }>;
    writeLlmTierConcurrencyOverride: (opts: { projectRoot: string; tier: string; concurrency: number }) => Promise<{
      configPath: string;
      backupPath?: string | null;
      configKey: string;
      previous?: number;
      concurrency: number;
    }>;
  }>;
  loadHardwareTuning: () => Promise<{
    describeHardware: () => string;
    recommendedTuning: () => {
      embed: { cartographConcurrency: number };
      chat: { cartographConcurrency: number };
      ask: { cartographConcurrency: number };
      reranker: { cartographConcurrency: number };
    };
  }>;
}

const defaultAdminCommandDeps: AdminCommandDeps = {
  adminCmd: cliAdminCmd,
  // biome-ignore lint/suspicious/noExplicitAny: matches the AdminCommandDeps.loadCartograph DI-seam type bridged onto every sub-registrar's narrowed graph subset
  loadCartograph: cliLoadCartograph as () => Promise<{ default: any }>,
  resolveProjectPath: cliResolveProjectPath,
  chalk: cliChalk,
  colors: cliColors,
  success: cliSuccess,
  error: cliError,
  info: cliInfo,
  warn: cliWarn,
  formatNumber: cliFormatNumber,
  formatDuration: cliFormatDuration,
  formatBytes: defaultFormatBytes,
  createVerboseProgress: cliCreateVerboseProgress,
  createShimmerProgress: defaultCreateShimmerProgress,
  attachUnknownActionHandler: cliAttachUnknownActionHandler,
  assignIntArg: cliAssignIntArg,
  assignFloatArg: cliAssignFloatArg,
  awaitSummarisationWithProgress: cliAwaitSummarisationWithProgress,
  printIndexResult: cliPrintIndexResult,
  getCartographDir: defaultGetCartographDir,
  isInitialized: defaultIsInitialized,
  parseConcurrency: defaultParseConcurrency,
  writeScipExport: defaultWriteScipExport,
  writeScipImport: defaultWriteScipImport,
  writeStdout: (message: string) => {
    process.stdout.write(message);
  },
  writeStderr: (message: string) => {
    process.stderr.write(message);
  },
  loadClack: () => import('@clack/prompts'),
  loadReadline: () => import('node:readline'),
  loadParseCache: (() => import('../../db/queries-parse-cache.js')) as AdminCommandDeps['loadParseCache'],
  loadDetachedSummarize: (() => import('../../llm/detached-summarize.js')) as AdminCommandDeps['loadDetachedSummarize'],
  loadSimilarEdges: (() => import('../../embeddings/similar-edges.js')) as AdminCommandDeps['loadSimilarEdges'],
  loadSummaryQueries: (() => import('../../db/queries-summaries.js')) as AdminCommandDeps['loadSummaryQueries'],
  loadDbIndex: (() => import('../../db/index.js')) as AdminCommandDeps['loadDbIndex'],
  loadInstallModels: (() => import('../../installer/install-models.js')) as AdminCommandDeps['loadInstallModels'],
  loadRecommendedModels: (() => import('../../llm/recommended-models.js')) as AdminCommandDeps['loadRecommendedModels'],
  loadRecommendedConfig: (() =>
    import('../../installer/recommended-config.js')) as unknown as AdminCommandDeps['loadRecommendedConfig'],
  loadDoctor: (() => import('../../installer/doctor.js')) as AdminCommandDeps['loadDoctor'],
  loadLlmSetupPlan: (() =>
    import('../../installer/llm-setup-plan.js')) as unknown as AdminCommandDeps['loadLlmSetupPlan'],
  loadHardwareTuning: () => import('../../installer/hardware-tuning.js'),
};

// The `cartograph admin install-shim` command was removed 2026-05-24c
// when the in-process LLM pathway (libcgshim + mini-nllc) was deleted
// in step 4c of the migration. Embed / chat / rerank all run via HTTP
// against an OpenAI-compat backend now — see CLAUDE.md "Native
// dependencies + runtime architecture" + the `recommended-config`
// helper for setup guidance.

export function registerAdminCommands(deps: AdminCommandDeps = defaultAdminCommandDeps): void {
  registerAdminProjectLifecycleCommands(deps);
  registerAdminIndexingCommands(deps);
  registerAdminLlmEnrichmentCommands(deps);
  registerAdminUnlockCommand(deps);
  registerAdminMigrateCommand(deps);
  registerAdminStorageMigrateCommand(deps);
  registerAdminSimilarityEdgesCommand(deps);
  registerAdminPruneStoreCommand(deps);
  registerScipAdminCommands({
    adminCmd: deps.adminCmd,
    resolveProjectPath: deps.resolveProjectPath,
    info: deps.info,
    error: deps.error,
    isInitialized: deps.isInitialized,
    openCartograph: async (projectPath) => {
      const { default: Cartograph } = await deps.loadCartograph();
      return await Cartograph.open(projectPath);
    },
    writeScipExport: deps.writeScipExport,
    writeScipImport: deps.writeScipImport,
    readFile: (filePath) => fs.promises.readFile(filePath),
  });
  registerAdminInstallModelsCommand(deps);
  registerAdminDoctorCommand(deps);
  registerAdminLlmSetupCommands(deps);
  deps.attachUnknownActionHandler(deps.adminCmd, 'admin');
}
