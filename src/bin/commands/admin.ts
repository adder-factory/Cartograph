/**
 * `cartograph admin` family subcommands — extracted from the
 * bin/cartograph.ts decomposition; this is a side-effecting module:
 * importing it registers the commands on `adminCmd`.
 */
import * as fs from 'node:fs';
import { getCartographDir as defaultGetCartographDir, isInitialized as defaultIsInitialized } from '../../directory.js';
import { createShimmerProgress as defaultCreateShimmerProgress } from '../../ui/shimmer-progress.js';
import { formatBytes as defaultFormatBytes } from '../../utils.js';
import { errMsg } from '../../errors.js';
import {
  writeScipExport as defaultWriteScipExport,
  writeScipImport as defaultWriteScipImport,
} from '../../scip/index.js';
import { parseConcurrency as defaultParseConcurrency } from '../../llm/concurrency.js';
import { registerAdminDoctorCommand } from '../../features/admin-doctor/index.js';
import {
  clearParseCacheIfRequested as clearParseCacheIfRequestedWithDeps,
  indexAllOptions,
  parseParseWorkersValue,
  phaseTimingLines as phaseTimingLinesWithDeps,
  printSyncResult as printSyncResultWithDeps,
  registerAdminIndexingCommands,
  reportBackgroundSummaryStatus as reportBackgroundSummaryStatusWithDeps,
  runQuietIndex as runQuietIndexWithDeps,
  type AdminIndexGraph,
  type AdminIndexOptions,
  type AdminIndexResult,
  type SyncResult,
} from '../../features/admin-indexing/index.js';
import {
  registerAdminInstallModelsCommand,
  printInstallModelResults as printInstallModelResultsWithDeps,
  type InstallModelResult,
} from '../../features/admin-install-models/index.js';
import { registerAdminLlmSetupCommands } from '../../features/admin-llm-setup/index.js';
import { registerAdminMigrateCommand } from '../../features/admin-migrate/index.js';
import { registerAdminProjectLifecycleCommands } from '../../features/admin-project-lifecycle/index.js';
import { registerAdminPruneStoreCommand } from '../../features/admin-prune-store/index.js';
import { registerAdminSimilarityEdgesCommand } from '../../features/admin-similarity-edges/index.js';
import { registerAdminUnlockCommand } from '../../features/admin-unlock/index.js';
import { registerScipAdminCommands } from '../../features/scip-admin/index.js';
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

type ClackPrompts = typeof import('@clack/prompts');

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  requiredOption(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

export interface AdminCommandDeps {
  adminCmd: CommandLike;
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
  attachUnknownActionHandler: (group: any, family: string) => void;
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
  loadClack: () => Promise<any>;
  loadReadline: () => Promise<{ createInterface: (...args: any[]) => any }>;
  loadParseCache: () => Promise<{ clearParseCache: (queries: unknown, language?: string) => number }>;
  loadDetachedSummarize: () => Promise<{
    spawnDetachedSummarize: (projectPath: string) => { spawned: boolean; pid?: number; reason?: string };
  }>;
  loadSimilarEdges: () => Promise<{
    buildSimilarToEdges: (
      cg: any,
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
  loadDbIndex: () => Promise<{ dbReclaimAfterBulkDelete: (db: any) => void }>;
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
    planLlmSetup: () => Promise<{
      recommendedPresetId: string;
      detectedBackends: ReadonlyArray<{ label: string; endpoint: string; models: readonly string[] }>;
      presets: ReadonlyArray<{ id: string; summary: string }>;
    }>;
    applyLlmSetupChoice: (opts: { projectRoot: string; preset: any }) => Promise<{
      applied: boolean;
      preset: string;
      configPath: string;
      backupPath?: string | null;
      notes: readonly string[];
      nextSteps: readonly string[];
    }>;
    writeLlmTierConcurrencyOverride: (opts: { projectRoot: string; tier: any; concurrency: number }) => Promise<{
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

let activeAdminCommandDeps: AdminCommandDeps = defaultAdminCommandDeps;

function parseParseWorkers(raw: string | undefined): number | undefined {
  const parsed = parseParseWorkersValue(raw);
  if (!parsed.ok) {
    activeAdminCommandDeps.error(parsed.error);
    process.exit(1);
  }
  return parsed.value;
}

function parseConcurrencyOption(raw: string | undefined): number {
  const { error, parseConcurrency } = activeAdminCommandDeps;
  if (raw === undefined) return parseConcurrency(undefined);
  if (!/^\d+$/.test(raw.trim())) {
    error('--concurrency must be a positive integer');
    process.exit(1);
  }
  return parseConcurrency(raw);
}

function phaseTimingLines(result: AdminIndexResult): string[] {
  return phaseTimingLinesWithDeps(result, activeAdminCommandDeps);
}

function parseEagerLimit(
  options: { quiet?: boolean; limit?: string; all?: boolean },
  onInvalid?: () => void,
): number | undefined {
  const { error } = activeAdminCommandDeps;
  if (options.all) return Number.POSITIVE_INFINITY;
  if (options.limit === undefined) return undefined;
  const parsed = Number(options.limit);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (!options.quiet)
      error('--limit must be a non-negative integer (0 = ad-hoc only; use --all for an uncapped pass)');
    onInvalid?.();
    process.exit(1);
  }
  return parsed;
}

function printInstallModelResults(result: InstallModelResult): void {
  printInstallModelResultsWithDeps(result, activeAdminCommandDeps);
}

function printSyncResult(clack: typeof import('@clack/prompts'), result: SyncResult): void {
  printSyncResultWithDeps(clack, result, activeAdminCommandDeps);
}

function printSummarizeDetails(
  clack: typeof import('@clack/prompts'),
  result: {
    candidates: number;
    generated: number;
    errors: number;
    cacheHits: number;
    deferred: number;
    durationMs: number;
    embed?: {
      failed?: boolean;
      failureReason?: string;
      generated: number;
      errors: number;
      skipped: number;
      durationMs: number;
    } | null;
  },
): void {
  const { formatNumber, formatDuration } = activeAdminCommandDeps;
  const skipped = result.candidates - result.generated - result.errors - result.cacheHits - result.deferred;
  clack.log.success(`Summarised ${formatNumber(result.generated)} new symbols in ${formatDuration(result.durationMs)}`);
  const details: string[] = [];
  if (result.cacheHits > 0) details.push(`Cache hits: ${formatNumber(result.cacheHits)}`);
  if (result.errors > 0) details.push(`Errors: ${formatNumber(result.errors)}`);
  if (skipped > 0) details.push(`Skipped: ${formatNumber(skipped)}`);
  if (details.length > 0) clack.log.info(details.join(' — '));
  if (result.deferred > 0) {
    clack.log.info(
      `Deferred ${formatNumber(result.deferred)} lower-priority symbols — they summarise on demand ` +
        `when \`find mode:intent\` references them. Run \`cartograph admin summarize --all\` for a full pass.`,
    );
  }
  printSummarizeEmbedDetails(clack, result.embed ?? undefined);
}

function printSummarizeEmbedDetails(
  clack: typeof import('@clack/prompts'),
  embed:
    | {
        failed?: boolean;
        failureReason?: string;
        generated: number;
        errors: number;
        skipped: number;
        durationMs: number;
      }
    | null
    | undefined,
): void {
  const { formatNumber, formatDuration } = activeAdminCommandDeps;
  if (!embed) return;
  if (embed.failed) {
    clack.log.warn(
      `Embed phase failed: ${embed.failureReason ?? 'unknown error'}. ` +
        `Summaries are persisted; rerun \`cartograph admin embed\` once the embedding endpoint is back.`,
    );
    return;
  }
  if (embed.generated === 0) return;
  const counters: string[] = [];
  if (embed.errors > 0) counters.push(`${formatNumber(embed.errors)} errors`);
  if (embed.skipped > 0)
    counters.push(`${formatNumber(embed.skipped)} skipped — too large for embed server's batch size`);
  clack.log.success(
    `Embedded ${formatNumber(embed.generated)} new vectors in ${formatDuration(embed.durationMs)}` +
      (counters.length > 0 ? ` (${counters.join(', ')})` : ''),
  );
}

async function runQuietIndex(
  cg: AdminIndexGraph,
  options: AdminIndexOptions,
  parseWorkers: number | undefined,
): Promise<void> {
  await runQuietIndexWithDeps({ cg, options, parseWorkers, deps: activeAdminCommandDeps });
}

async function clearParseCacheIfRequested(
  cg: AdminIndexGraph,
  clearParseCacheOption: boolean | string | undefined,
): Promise<{ count: number; lang: string | undefined } | null> {
  return clearParseCacheIfRequestedWithDeps(cg, clearParseCacheOption, activeAdminCommandDeps);
}

async function reportBackgroundSummaryStatus(
  cg: AdminIndexGraph,
  clack: ClackPrompts,
  projectPath: string,
): Promise<void> {
  return reportBackgroundSummaryStatusWithDeps({ cg, clack, projectPath, deps: activeAdminCommandDeps });
}

/**
 * cartograph admin summarize [path]
 *
 * Run an LLM-driven summarisation pass over symbols missing docstrings.
 * Requires `config.llm` to be configured. Cached by content_hash,
 * so re-runs are cheap.
 *
 * CLI/MCP alignment exception (B11): direct implementation rather
 * than runViaMCP shim — summarisation can take minutes on a
 * cold cache, and the CLI streams per-symbol progress. The MCP
 * version returns a single completion blob.
 */
function registerSummarizeCommand(deps: AdminCommandDeps): void {
  const { adminCmd, createShimmerProgress, error, isInitialized, loadCartograph, loadClack, resolveProjectPath } = deps;
  adminCmd
    .command('summarize [path]')
    .description('Generate one-line LLM summaries for indexed symbols (requires config.llm)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent LLM requests')
    .option(
      '--limit <n>',
      'Cap eager summary generations this pass; the importance-ordered tail defers to on-demand summarisation. `0` = ad-hoc only (summarise nothing eagerly). Overrides config.llm.summarizeEagerLimit',
    )
    .option(
      '--all',
      'Summarize every eligible symbol — uncapped full pass (overrides config.llm.summarizeEagerLimit and --limit)',
    )
    .action(
      async (
        pathArg: string | undefined,
        options: { quiet?: boolean; concurrency?: string; limit?: string; all?: boolean },
      ) => {
        const projectPath = resolveProjectPath(pathArg);
        try {
          if (!isInitialized(projectPath)) {
            if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
            process.exit(1);
          }
          const { default: Cartograph } = await loadCartograph();
          // Write path (summarize): opt in to auto-migration.
          const cg = await Cartograph.open(projectPath, { autoMigrate: true });

          const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
          if (!llmConfig) {
            if (!options.quiet) {
              error(
                'No LLM available. Add config.llm to .cartograph/config.json (run `cartograph admin install-models --write-config` for the recommended stack — llama-server HTTP for every tier — or set provider: "anthropic-api" for Claude).',
              );
            }
            cg.close();
            process.exit(1);
          }

          // Match the MCP `cartograph_admin({action: 'summarize'})` clamp [1, 16] so both
          // surfaces enforce the same upper bound. Local LLMs and rate-
          // limited cloud endpoints both work poorly past ~8 concurrent.
          const concurrency = parseConcurrencyOption(options.concurrency);

          // Lever C — eager-summary cap. `--all` wins, then `--limit`,
          // else undefined so the service falls back to
          // config.llm.summarizeEagerLimit (then the built-in default).
          const eagerLimit = parseEagerLimit(options, () => cg.close());

          // Conditional spread — `exactOptionalPropertyTypes` rejects an
          // explicit `eagerLimit: undefined` (let the service default it).
          const eagerLimitOpt = eagerLimit === undefined ? {} : { eagerLimit };

          if (options.quiet) {
            await cg.llm.summarizeAll({ concurrency, ...eagerLimitOpt });
            cg.close();
            return;
          }

          const clack = await loadClack();
          clack.intro('Summarising indexed symbols');

          const progress = createShimmerProgress();
          progress.onProgress({ phase: 'parsing', current: 0, total: 0 });

          const result = await cg.llm.summarizeAll({
            concurrency,
            ...eagerLimitOpt,
            onProgress: (done: number, total: number) => {
              progress.onProgress({ phase: 'parsing', current: done, total });
            },
          });

          await progress.stop();

          printSummarizeDetails(clack, result);

          clack.outro('Done');
          cg.close();
        } catch (err) {
          if (!options.quiet) error(`Failed to summarise: ${errMsg(err)}`);
          process.exit(1);
        }
      },
    );
}

/**
 * cartograph admin embed [path]
 *
 * Run an LLM-driven embedding pass over every indexed symbol. Covers
 * all nodes with kind not in (file, import, export) — not just those
 * with LLM-generated summaries. Input text: name + signature +
 * docstring + summary (summary used when available). Populates
 * `symbol_embeddings` for `cartograph_search({mode: 'semantic'})` /
 * hybrid retrieval. Idempotent — second runs are pure cache checks.
 *
 * CLI/MCP alignment exception (B11): direct implementation for the
 * same reason as `summarize` — embedding cold-cache runs take
 * minutes and the CLI streams per-symbol progress.
 */
function registerEmbedCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    error,
    formatDuration,
    formatNumber,
    isInitialized,
    loadCartograph,
    loadClack,
    resolveProjectPath,
  } = deps;
  adminCmd
    .command('embed [path]')
    .description('Generate embeddings for every indexed symbol (requires embedding provider)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent embedding requests')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean; concurrency?: string }) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        // Write path (embed): opt in to auto-migration.
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });

        // Clamped to [1, 16] — typical embedding endpoints rate-limit
        // around 4–8 concurrent requests; anything higher just queues.
        const concurrency = parseConcurrencyOption(options.concurrency);

        if (options.quiet) {
          await cg.llm.embed.embedAll({ concurrency });
          cg.close();
          return;
        }

        const clack = await loadClack();
        clack.intro('Embedding indexed symbols');
        const result = await cg.llm.embed.embedAll({ concurrency });
        const counters: string[] = [];
        if (result.errors > 0) counters.push(`${formatNumber(result.errors)} errors`);
        if (result.skipped > 0)
          counters.push(`${formatNumber(result.skipped)} skipped — too large for embed server's batch size`);
        clack.log.success(
          `Embedded ${formatNumber(result.generated)} new vectors in ${formatDuration(result.durationMs)}` +
            (counters.length > 0 ? ` (${counters.join(', ')})` : ''),
        );
        clack.outro('Done');
        cg.close();
      } catch (err) {
        if (!options.quiet) error(`Failed to embed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph admin classify [path]
 *
 * Run an LLM-driven role-classification pass over symbols with a
 * non-empty description (cascade input: summary if present, else
 * docstring). Idempotent; only symbols missing a role from the
 * active model are touched.
 *
 * Operationally symmetric to `cartograph admin embed`: one phase of the
 * `cartograph admin summarize` pipeline, runnable on its own. Useful when
 * you've added new summaries via the agent-bridge (`cartograph
 * summaries save`), or want to classify docstring-only symbols
 * without paying for a full summarise pass.
 *
 * CLI/MCP alignment exception (B11): direct implementation so the
 * CLI streams per-symbol progress for what can be a multi-minute
 * cold-cache run on large codebases.
 */
function registerClassifyCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    error,
    formatDuration,
    formatNumber,
    isInitialized,
    loadCartograph,
    loadClack,
    resolveProjectPath,
  } = deps;
  adminCmd
    .command('classify [path]')
    .description('Assign roles via the LLM (cascade input: summary if present, else docstring; requires config.llm)')
    .option('-q, --quiet', 'Suppress output')
    .option('-c, --concurrency <n>', 'Concurrent LLM requests')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean; concurrency?: string }) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        // Write path (classify): opt in to auto-migration.
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });

        // Clamped to [1, 16] — same band as summarize/embed; classifier
        // chat calls are short and per-symbol, so concurrency speeds the
        // happy path but local LLMs queue past ~8 anyway.
        const concurrency = parseConcurrencyOption(options.concurrency);

        if (options.quiet) {
          await cg.llm.classifyAll({ concurrency });
          cg.close();
          return;
        }

        const clack = await loadClack();
        clack.intro('Classifying symbol roles');
        const result = await cg.llm.classifyAll({ concurrency });
        clack.log.success(
          `Classified ${formatNumber(result.classified)} symbols in ${formatDuration(result.durationMs)}` +
            (result.errors > 0 ? ` (${formatNumber(result.errors)} errors)` : ''),
        );
        if (result.candidates === 0) {
          clack.log.info(
            'No candidates — every symbol with a description (summary or docstring) already has a role from the active model.',
          );
        }
        clack.outro('Done');
        cg.close();
      } catch (err) {
        if (!options.quiet) error(`Failed to classify: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

// The `cartograph admin install-shim` command was removed 2026-05-24c
// when the in-process LLM pathway (libcgshim + mini-nllc) was deleted
// in step 4c of the migration. Embed / chat / rerank all run via HTTP
// against an OpenAI-compat backend now — see CLAUDE.md "Native
// dependencies + runtime architecture" + the `recommended-config`
// helper for setup guidance.

export function registerAdminCommands(deps: AdminCommandDeps = defaultAdminCommandDeps): void {
  activeAdminCommandDeps = deps;
  registerAdminProjectLifecycleCommands(deps);
  registerAdminIndexingCommands(deps);
  registerSummarizeCommand(deps);
  registerEmbedCommand(deps);
  registerClassifyCommand(deps);
  registerAdminUnlockCommand(deps);
  registerAdminMigrateCommand(deps);
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

registerAdminCommands();

export const __adminCommandInternals = {
  parseParseWorkers,
  indexAllOptions,
  phaseTimingLines,
  parseEagerLimit,
  printInstallModelResults,
  printSyncResult,
  printSummarizeDetails,
  printSummarizeEmbedDetails,
  runQuietIndex,
  clearParseCacheIfRequested,
  reportBackgroundSummaryStatus,
};
