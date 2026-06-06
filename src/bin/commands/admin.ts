/**
 * `cartograph admin` family subcommands — extracted from the
 * bin/cartograph.ts decomposition; this is a side-effecting module:
 * importing it registers the commands on `adminCmd`.
 */
import * as path from 'node:path';
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
  registerAdminInstallModelsCommand,
  printInstallModelResults as printInstallModelResultsWithDeps,
  type InstallModelResult,
} from '../../features/admin-install-models/index.js';
import { registerAdminLlmSetupCommands } from '../../features/admin-llm-setup/index.js';
import { registerAdminPruneStoreCommand } from '../../features/admin-prune-store/index.js';
import { registerAdminSimilarityEdgesCommand } from '../../features/admin-similarity-edges/index.js';
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
  type IndexResult,
} from '../_cli-core.js';

interface AdminIndexOptions {
  force?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  profile?: boolean;
  clearParseCache?: boolean | string;
  parseWorkers?: string;
}

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

type LoadedCartographModule = Awaited<ReturnType<typeof cliLoadCartograph>>;
type AdminIndexGraph = Awaited<ReturnType<LoadedCartographModule['default']['open']>>;

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

const PHASE_PERCENT_SCALE = 100;
const PHASE_LABEL_WIDTH = 14;
const PHASE_DURATION_WIDTH = 8;
const PHASE_PERCENT_WIDTH = 2;
const POST_HOOK_LABEL_WIDTH = 12;

function removeLockFileIfPresent(lockPath: string): boolean {
  if (!fs.existsSync(lockPath)) return false;
  fs.unlinkSync(lockPath);
  return true;
}

function parseParseWorkers(raw: string | undefined): number | undefined {
  const { error } = activeAdminCommandDeps;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    error(`--parse-workers must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
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

function indexAllOptions(
  options: Pick<AdminIndexOptions, 'force' | 'profile'>,
  parseWorkers: number | undefined,
): {
  summarize: false;
  profile: boolean;
  clearStructural: boolean;
  parseWorkers?: number;
} {
  return {
    summarize: false,
    profile: !!options.profile,
    clearStructural: !!options.force,
    ...(parseWorkers !== undefined && { parseWorkers }),
  };
}

function phaseTimingLines(result: IndexResult): string[] {
  const { formatDuration } = activeAdminCommandDeps;
  const p = result.profile;
  if (!p) return [];
  const fmt = (label: string, ms: number | undefined): string => {
    if (ms === undefined) return '';
    const pct = result.durationMs > 0 ? Math.round((ms / result.durationMs) * PHASE_PERCENT_SCALE) : 0;
    return `  ${label.padEnd(PHASE_LABEL_WIDTH)} ${formatDuration(ms).padStart(PHASE_DURATION_WIDTH)}  (${pct.toString().padStart(PHASE_PERCENT_WIDTH)}%)`;
  };
  const lines = [fmt('scan', p.scanMs), fmt('parse+store', p.parseStoreMs)];
  if (p.retryMs && p.retryMs > 0) lines.push(fmt('retry', p.retryMs));
  lines.push(fmt('resolve', p.resolveMs), fmt('postHooks', p.postHooksMs));
  if (p.postHooksByHook && p.postHooksMs && p.postHooksMs > 0) {
    const sorted = Object.entries(p.postHooksByHook).sort((a, b) => b[1] - a[1]);
    for (const [name, ms] of sorted) {
      const pct = p.postHooksMs > 0 ? Math.round((ms / p.postHooksMs) * PHASE_PERCENT_SCALE) : 0;
      lines.push(
        `    ${name.padEnd(POST_HOOK_LABEL_WIDTH)} ${formatDuration(ms).padStart(PHASE_DURATION_WIDTH)}  (${pct.toString().padStart(PHASE_PERCENT_WIDTH)}% of postHooks)`,
      );
    }
  }
  lines.push(fmt('maintenance', p.maintenanceMs), fmt('total', result.durationMs));
  return lines.filter(Boolean);
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

function printSyncResult(
  clack: typeof import('@clack/prompts'),
  result: { filesAdded: number; filesModified: number; filesRemoved: number; nodesUpdated: number; durationMs: number },
): void {
  const { formatNumber, formatDuration } = activeAdminCommandDeps;
  const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;
  if (totalChanges === 0) {
    clack.log.info('Already up to date');
    return;
  }
  clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
  const details: string[] = [];
  if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
  if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
  if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
  clack.log.info(
    `${details.join(', ')} — ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`,
  );
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

/**
 * cartograph admin init [path]
 */
function registerInitCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    colors,
    createShimmerProgress,
    createVerboseProgress,
    isInitialized,
    loadCartograph,
    loadClack,
    printIndexResult,
    writeStdout,
  } = deps;
  adminCmd
    .command('init [path]')
    .description(
      "Initialize Cartograph in a project directory — creates .cartograph/ and ensures the project .gitignore excludes it (mirrors cartograph_admin MCP tool with action='init')",
    )
    .option('-i, --index', 'Run initial indexing after initialization')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
      const projectPath = path.resolve(pathArg || process.cwd());
      const clack = await loadClack();

      clack.intro('Initializing Cartograph');

      try {
        if (isInitialized(projectPath)) {
          clack.log.warn(`Already initialized in ${projectPath}`);
          clack.log.info('Use "cartograph admin index" to re-index or "cartograph admin sync" to update');
          clack.outro('');
          return;
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.init(projectPath, { index: false });
        clack.log.success(`Initialized in ${projectPath}`);

        if (options.index) {
          let result: IndexResult;

          if (options.verbose) {
            result = await cg.indexAll({
              onProgress: createVerboseProgress(),
              verbose: true,
            });
          } else {
            writeStdout(`${colors.dim}│${colors.reset}\n`);
            const progress = createShimmerProgress();
            result = await cg.indexAll({
              onProgress: progress.onProgress,
            });
            await progress.stop();
          }

          printIndexResult(clack, result, projectPath);
        } else {
          clack.log.info('Run "cartograph admin index" to index the project');
        }

        clack.outro('Done');
        cg.close();
      } catch (err) {
        clack.log.error(`Failed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph admin uninit [path]
 */
function registerUninitCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    chalk,
    error,
    info,
    isInitialized,
    loadCartograph,
    loadReadline,
    resolveProjectPath,
    success,
    warn,
  } = deps;
  adminCmd
    .command('uninit [path]')
    .description(
      "Remove Cartograph from a project, deletes .cartograph/ directory (mirrors cartograph_admin MCP tool with action='uninit')",
    )
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          warn(`Cartograph is not initialized in ${projectPath}`);
          return;
        }

        if (!options.force) {
          const readline = await loadReadline();
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow('⚠ This will permanently delete all Cartograph data. Continue? (y/N) '), resolve);
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            info('Cancelled');
            return;
          }
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = Cartograph.openSync(projectPath);
        await cg.uninitialize();

        success(`Removed Cartograph from ${projectPath}`);
      } catch (err) {
        error(`Failed to uninitialize: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph admin index [path]
 */
function registerIndexCommand(deps: AdminCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('index [path]')
    .description("Index all files in the project (mirrors cartograph_admin MCP tool with action='index')")
    .option('-f, --force', 'Force full re-index even if already indexed')
    .option('-q, --quiet', 'Suppress progress output')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .option('--profile', 'Print per-phase timings (scan / parse+store / resolve / postHooks / maintenance)')
    .option(
      '--clear-parse-cache [language]',
      'Wipe the per-file parse cache before reindexing. ' +
        '`--force` alone preserves it intentionally so re-extracts replay; ' +
        'use this when the extractor itself changed and the schema-version ' +
        'envelope (PAYLOAD_VERSION) was not bumped to match. ' +
        'Pass a language (e.g. `--clear-parse-cache=typescript`) to drop ' +
        "only that language's entries — much faster when one extractor changed.",
    )
    .option(
      '--parse-workers <n>',
      'Parse-worker pool size. Default: CPU count − 1, floored at 1, ' +
        'capped at 16. Lower it on memory-constrained CI runners; raise ' +
        'it on big monorepos. Bench with --profile before settling on a value.',
    )
    .action(runAdminIndexCommand);
}

async function runAdminIndexCommand(pathArg: string | undefined, options: AdminIndexOptions): Promise<void> {
  const { error, info, isInitialized, loadCartograph, resolveProjectPath } = activeAdminCommandDeps;
  const projectPath = resolveProjectPath(pathArg);

  // Parse --parse-workers once: a positive integer overrides the
  // pool-size default; anything else is rejected loudly rather than
  // silently ignored.
  const parseWorkers = parseParseWorkers(options.parseWorkers);

  try {
    if (!isInitialized(projectPath)) {
      error(`Cartograph not initialized in ${projectPath}`);
      info('Run "cartograph admin init" first');
      process.exit(1);
    }

    const { default: Cartograph } = await loadCartograph();
    // Write path (admin index): explicitly opt in to auto-migration.
    const cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (options.quiet) {
      await runQuietIndex(cg, options, parseWorkers);
      return;
    }

    await runInteractiveIndex({ cg, projectPath, options, parseWorkers });
  } catch (err) {
    error(`Failed to index: ${errMsg(err)}`);
    process.exit(1);
  }
}

async function runQuietIndex(
  cg: AdminIndexGraph,
  options: AdminIndexOptions,
  parseWorkers: number | undefined,
): Promise<void> {
  // Quiet mode: no UI, no background summarisation (the process
  // exits immediately and would kill in-flight LLM work anyway).
  await clearParseCacheIfRequested(cg, options.clearParseCache);
  // `--force` clear is threaded INTO indexAll so it runs under the
  // file lock (a contended --force must not wipe the index).
  const result = await cg.indexAll(indexAllOptions(options, parseWorkers));
  if (!result.success) process.exit(1);
  if (options.profile && result.profile) {
    // Quiet+profile is the scripted use case (CI bench, etc.) —
    // emit a single compact JSON line so it parses cleanly.
    activeAdminCommandDeps.writeStdout(JSON.stringify(result.profile) + '\n');
  }
  cg.close();
}

async function runInteractiveIndex(args: {
  cg: AdminIndexGraph;
  projectPath: string;
  options: AdminIndexOptions;
  parseWorkers: number | undefined;
}): Promise<void> {
  const { cg, projectPath, options, parseWorkers } = args;
  const { printIndexResult } = activeAdminCommandDeps;
  const clack = await activeAdminCommandDeps.loadClack();
  clack.intro('Indexing project');

  await prepareInteractiveIndex(cg, clack, options);
  const result = await runIndexWithProgress(cg, options, parseWorkers);
  printIndexResult(clack, result, projectPath);

  if (options.profile && result.profile) {
    clack.note(phaseTimingLines(result).join('\n'), 'Phase timings');
  }
  if (!result.success) process.exit(1);

  await reportBackgroundSummaryStatus(cg, clack, projectPath);
  clack.outro('Done');
}

async function prepareInteractiveIndex(
  cg: AdminIndexGraph,
  clack: ClackPrompts,
  options: AdminIndexOptions,
): Promise<void> {
  if (options.force) {
    // The structural clear is threaded into indexAll (below) so it
    // runs UNDER the file lock — a contended --force then leaves the
    // existing index intact instead of wiping it with no rebuild.
    clack.log.info(
      'Full re-index (--force): structural index will be cleared under lock, then rebuilt (nothing is cleared if the lock is held); LLM caches preserved',
    );
  }
  const dropped = await clearParseCacheIfRequested(cg, options.clearParseCache);
  if (!dropped) return;
  clack.log.info(
    dropped.lang
      ? `Cleared ${dropped.count} parse-cache entries for language=${dropped.lang}`
      : `Cleared ${dropped.count} parse-cache entries (every file will fully re-parse)`,
  );
}

async function clearParseCacheIfRequested(
  cg: AdminIndexGraph,
  clearParseCacheOption: boolean | string | undefined,
): Promise<{ count: number; lang: string | undefined } | null> {
  if (!clearParseCacheOption) return null;
  const { clearParseCache } = await activeAdminCommandDeps.loadParseCache();
  const lang = typeof clearParseCacheOption === 'string' ? clearParseCacheOption : undefined;
  return { count: clearParseCache(cg.queries, lang), lang };
}

async function runIndexWithProgress(
  cg: AdminIndexGraph,
  options: AdminIndexOptions,
  parseWorkers: number | undefined,
): Promise<IndexResult> {
  // `summarize: false` — the LLM summary tail is NOT run inline.
  // After base indexing the CLI hands it to a detached process
  // (see below), so the in-process background pass must not also
  // fire. Without this both would run and double the GPU load.
  const { colors, createShimmerProgress, createVerboseProgress, writeStdout } = activeAdminCommandDeps;
  if (options.verbose) {
    return cg.indexAll({
      onProgress: createVerboseProgress(),
      verbose: true,
      ...indexAllOptions(options, parseWorkers),
    });
  }

  writeStdout(`${colors.dim}│${colors.reset}\n`);
  const progress = createShimmerProgress();
  const result = await cg.indexAll({
    onProgress: progress.onProgress,
    ...indexAllOptions(options, parseWorkers),
  });
  await progress.stop();
  return result;
}

async function reportBackgroundSummaryStatus(
  cg: AdminIndexGraph,
  clack: ClackPrompts,
  projectPath: string,
): Promise<void> {
  // Base graph is complete and queryable NOW. Hand the slow LLM
  // summary tail (minutes) to a detached process so the CLI
  // returns immediately instead of making the user sit and wait.
  const llmCfgForSummary = await cg.llm.config.getEffectiveLlmConfig();
  const eagerLimitCfg = cg.config.llm?.summarizeEagerLimit;
  cg.close(); // release DB handles before the child opens them

  if (!llmCfgForSummary) {
    clack.log.info(
      'No LLM configured — symbol summaries skipped. Run ' +
        '`cartograph admin install-models --write-config` to enable them.',
    );
    return;
  }
  if (eagerLimitCfg === 0) {
    clack.log.info(
      'Summaries: ad-hoc only (config.llm.summarizeEagerLimit = 0) — ' +
        'generated on demand as `find mode:intent` references symbols.',
    );
    return;
  }

  const { spawnDetachedSummarize } = await activeAdminCommandDeps.loadDetachedSummarize();
  const detached = spawnDetachedSummarize(projectPath);
  if (detached.spawned) {
    clack.log.success(
      `Base index ready — cartograph is usable now. Symbol summaries are ` +
        `generating in the background (pid ${detached.pid}); run \`cartograph status\` ` +
        `for coverage, or \`cartograph admin summarize --all\` to wait for a full pass.`,
    );
    return;
  }
  clack.log.info(`Base index ready. Background summarization ${detached.reason}.`);
}

/**
 * cartograph admin embed-only [path]
 *
 * Fast-lane indexing for operators who only want semantic search
 * (`cartograph_search mode='semantic'` + `cartograph_ask`). Runs the
 * extractor, skips reference-resolution + every postHook (centrality,
 * biomarkers, churn, co-change, etc.), then runs the embed pass
 * synchronously so the CLI returns when embeddings are persisted.
 *
 * Drops indexing wall-clock by 70-90% on large repos vs full
 * `admin index`. Trade-off: NO biomarker findings, NO hotspot data,
 * NO call graph, NO classify roles. Use `admin index` to backfill
 * those later when needed.
 */
function registerEmbedOnlyCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    colors,
    createShimmerProgress,
    createVerboseProgress,
    error,
    info,
    isInitialized,
    loadCartograph,
    loadClack,
    printIndexResult,
    resolveProjectPath,
    writeStdout,
  } = deps;
  adminCmd
    .command('embed-only [path]')
    .description('Fast-lane index: skip reference resolution + postHooks; embed only (Stage 4 #9)')
    .option('-q, --quiet', 'Suppress progress output')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean; verbose?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          info('Run "cartograph admin init" first');
          process.exit(1);
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });

        if (options.quiet) {
          const result = await cg.indexAll({ summarize: false, embedOnly: true });
          if (!result.success) process.exit(1);
          try {
            await cg.llm.embed.embedAll();
          } catch (err) {
            error(`Embed pass failed: ${errMsg(err)}`);
            cg.close();
            process.exit(1);
          }
          cg.close();
          return;
        }

        const clack = await loadClack();
        clack.intro('Embed-only indexing (skip resolution + postHooks)');

        let result: IndexResult;
        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
            embedOnly: true,
            summarize: false,
          });
        } else {
          writeStdout(`${colors.dim}│${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
            embedOnly: true,
            summarize: false,
          });
          await progress.stop();
        }
        printIndexResult(clack, result, projectPath);

        // Embed pass — run synchronously so the CLI returns when embeddings
        // are persisted (the bgCtrl path is skipped because embedOnly
        // disables the auto-summarization trigger).
        try {
          clack.log.info('Running embed pass…');
          const embedResult = await cg.llm.embed.embedAll({});
          clack.log.success(
            `Embedded ${embedResult.generated}/${embedResult.candidates} symbols ` +
              `(${embedResult.errors} errors, ${embedResult.durationMs}ms)`,
          );
        } catch (err) {
          clack.log.warn(`Embed pass skipped: ${errMsg(err)}`);
        }

        clack.outro('Done');
        cg.close();
      } catch (err) {
        error(`Failed to embed-only index: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph admin sync [path]
 */
function registerSyncCommand(deps: AdminCommandDeps): void {
  const {
    adminCmd,
    awaitSummarisationWithProgress,
    colors,
    createShimmerProgress,
    error,
    isInitialized,
    loadCartograph,
    loadClack,
    resolveProjectPath,
    writeStderr,
    writeStdout,
  } = deps;
  adminCmd
    .command('sync [path]')
    .description("Sync changes since last index (mirrors cartograph_admin MCP tool with action='sync')")
    .option('-q, --quiet', 'Suppress output (for git hooks)')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) {
            error(`Cartograph not initialized in ${projectPath}`);
          }
          process.exit(1);
        }

        const { default: Cartograph } = await loadCartograph();
        // Write path (admin sync): opt in to auto-migration.
        const cg = await Cartograph.open(projectPath, { autoMigrate: true });

        if (options.quiet) {
          // Quiet mode (git hooks, scripts): skip summarisation so the
          // hook stays fast. The next interactive sync/index picks up
          // any new symbols.
          await cg.sync({ summarize: false });
          cg.close();
          return;
        }

        const clack = await loadClack();
        clack.intro('Syncing Cartograph');

        writeStdout(`${colors.dim}│${colors.reset}\n`);
        const progress = createShimmerProgress();

        const result = await cg.sync({
          onProgress: progress.onProgress,
        });

        await progress.stop();

        printSyncResult(clack, result);

        // Await any background summarisation kicked off by sync() so
        // the work persists before exit.
        await awaitSummarisationWithProgress(cg, clack);

        clack.outro('Done');
        cg.close();
      } catch (err) {
        if (!options.quiet) {
          error(`Failed to sync: ${errMsg(err)}`);
          if (process.env['CG_DEBUG']) writeStderr(`${errMsg(err)}\n`);
        }
        process.exit(1);
      }
    });
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

/**
 * cartograph admin unlock [path]
 */
function registerUnlockCommand(deps: AdminCommandDeps): void {
  const { adminCmd, error, getCartographDir, info, isInitialized, resolveProjectPath, success } = deps;
  adminCmd
    .command('unlock [path]')
    .description(
      "Remove a stale lock file that is blocking indexing (mirrors cartograph_admin MCP tool with action='unlock')",
    )
    .action(async (pathArg: string | undefined) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          return;
        }

        const lockPath = path.join(getCartographDir(projectPath), 'cartograph.lock');

        if (!removeLockFileIfPresent(lockPath)) {
          info('No lock file found — nothing to do');
          return;
        }

        success('Removed lock file. You can now run indexing again.');
      } catch (err) {
        error(`Failed to remove lock: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph admin migrate [path]
 *
 * Apply forward schema migrations on the project DB. Cheapest
 * recovery path when a read-style command fails with "Database
 * schema vN is behind this binary's vM" — opens the DB with
 * autoMigrate=true, which runs migrations once and exits.
 */
function registerMigrateCommand(deps: AdminCommandDeps): void {
  const { adminCmd, error, info, isInitialized, loadCartograph, resolveProjectPath, success } = deps;
  adminCmd
    .command('migrate [path]')
    .description(
      'Apply forward schema migrations on the project DB (mirrors cartograph_admin MCP tool with action=\'migrate\'). Use after a read-style command fails with "Database schema vN is behind".',
    )
    .action(async (pathArg: string | undefined) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        // Two-phase open lets us distinguish "already current" from
        // "migrated this run" without a separate version probe: the
        // default open() throws when the DB is behind, so success means
        // already-current. On the throw we re-open with autoMigrate=true
        // to actually run the migrations.
        let migratedThisRun = false;
        let cg: Awaited<ReturnType<typeof Cartograph.open>>;
        try {
          cg = await Cartograph.open(projectPath);
        } catch {
          cg = await Cartograph.open(projectPath, { autoMigrate: true });
          migratedThisRun = true;
        }
        const v = cg.db.getSchemaVersion();
        cg.close();
        if (migratedThisRun) {
          success(`Schema migrated to v${v?.version ?? '?'}.`);
          info(
            'Restart any MCP server still bound to the old schema (its tools will return "stale code, restart" until you do).',
          );
        } else {
          success(`Schema already current (v${v?.version ?? '?'}). Nothing to migrate.`);
        }
      } catch (err) {
        error(`Failed to migrate: ${errMsg(err)}`);
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
  registerInitCommand(deps);
  registerUninitCommand(deps);
  registerIndexCommand(deps);
  registerEmbedOnlyCommand(deps);
  registerSyncCommand(deps);
  registerSummarizeCommand(deps);
  registerEmbedCommand(deps);
  registerClassifyCommand(deps);
  registerUnlockCommand(deps);
  registerMigrateCommand(deps);
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
