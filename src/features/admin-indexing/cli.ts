import { errMsg } from '../../errors.js';
import {
  indexAllOptions,
  parseMaxFileSizeValue,
  parseParseWorkersValue,
  phaseTimingLines,
  printSyncResult,
  type AdminIndexOptions,
  type AdminIndexResult,
  type SyncResult,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

type ClackPrompts = typeof import('@clack/prompts');

export interface AdminIndexGraph {
  queries: unknown;
  config: { llm?: { summarizeEagerLimit?: number } };
  close: () => void;
  indexAll: (opts: object) => Promise<AdminIndexResult>;
  sync: (opts: object) => Promise<SyncResult>;
  llm: {
    config: { getEffectiveLlmConfig: () => Promise<unknown> };
    embed: {
      embedAll: (opts?: Record<string, unknown>) => Promise<{
        generated: number;
        candidates: number;
        errors: number;
        skipped?: number;
        durationMs: number;
      }>;
    };
  };
}

export interface AdminIndexingCommandDeps {
  adminCmd: CommandLike;
  colors: { dim: string; reset: string };
  error: (message: string) => void;
  info: (message: string) => void;
  formatNumber: (n: number) => string;
  formatDuration: (ms: number) => string;
  createVerboseProgress: () => any;
  createShimmerProgress: () => { onProgress: any; stop: () => Promise<void> };
  awaitSummarisationWithProgress: (cg: any, clack: ClackPrompts) => Promise<void>;
  printIndexResult: (clack: ClackPrompts, result: AdminIndexResult, projectPath: string) => void;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{
    default: {
      open: (projectPath: string, opts?: { autoMigrate?: boolean }) => Promise<AdminIndexGraph>;
    };
  }>;
  loadClack: () => Promise<ClackPrompts>;
  loadParseCache: () => Promise<{ clearParseCache: (queries: unknown, language?: string) => number }>;
  loadDetachedSummarize: () => Promise<{
    spawnDetachedSummarize: (projectPath: string) => { spawned: boolean; pid?: number; reason?: string };
  }>;
  resolveProjectPath: (pathArg?: string) => string;
  writeStdout: (message: string) => void;
  writeStderr: (message: string) => void;
}

interface RunQuietIndexArgs {
  cg: AdminIndexGraph;
  options: AdminIndexOptions;
  parseWorkers: number | undefined;
  maxFileSize: number | undefined;
  deps: AdminIndexingCommandDeps;
}

interface InteractiveIndexArgs extends RunQuietIndexArgs {
  projectPath: string;
}

interface PrepareInteractiveIndexArgs {
  cg: AdminIndexGraph;
  clack: ClackPrompts;
  options: AdminIndexOptions;
  deps: AdminIndexingCommandDeps;
}

interface BackgroundSummaryStatusArgs {
  cg: AdminIndexGraph;
  clack: ClackPrompts;
  projectPath: string;
  deps: Pick<AdminIndexingCommandDeps, 'loadDetachedSummarize'>;
}

interface EmbedOnlyOptions {
  quiet?: boolean;
  verbose?: boolean;
  maxFileSize?: string;
}

interface InteractiveEmbedOnlyArgs {
  cg: AdminIndexGraph;
  projectPath: string;
  options: EmbedOnlyOptions;
  maxFileSize: number | undefined;
  deps: AdminIndexingCommandDeps;
}

export function registerAdminIndexingCommands(deps: AdminIndexingCommandDeps): void {
  registerIndexCommand(deps);
  registerEmbedOnlyCommand(deps);
  registerSyncCommand(deps);
}

function registerIndexCommand(deps: AdminIndexingCommandDeps): void {
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
    .option(
      '--max-file-size <size>',
      'Transiently override config.maxFileSize for this index run. Use bytes or a kb/mb suffix, up to 10mb.',
    )
    .action((pathArg: string | undefined, options: AdminIndexOptions) => runAdminIndexCommand(pathArg, options, deps));
}

export async function runAdminIndexCommand(
  pathArg: string | undefined,
  options: AdminIndexOptions,
  deps: AdminIndexingCommandDeps,
): Promise<void> {
  const { error, info, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const parsed = parseParseWorkersValue(options.parseWorkers);
  if (!parsed.ok) {
    error(parsed.error);
    process.exit(1);
  }
  const parseWorkers = parsed.value;
  const parsedMaxFileSize = parseMaxFileSizeValue(options.maxFileSize);
  if (!parsedMaxFileSize.ok) {
    error(parsedMaxFileSize.error);
    process.exit(1);
  }
  const maxFileSize = parsedMaxFileSize.value;
  let cg: AdminIndexGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      error(`Cartograph not initialized in ${projectPath}`);
      info('Run "cartograph admin init" first');
      process.exit(1);
    }

    const { default: Cartograph } = await loadCartograph();
    // Write path (admin index): explicitly opt in to auto-migration.
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (options.quiet) {
      await runQuietIndex({ cg, options, parseWorkers, maxFileSize, deps });
      cg = undefined;
      return;
    }

    await runInteractiveIndex({ cg, projectPath, options, parseWorkers, maxFileSize, deps });
    cg = undefined;
  } catch (err) {
    cg?.close();
    error(`Failed to index: ${errMsg(err)}`);
    process.exit(1);
  }
}

export async function runQuietIndex(args: RunQuietIndexArgs): Promise<void> {
  const { cg, options, parseWorkers, deps } = args;
  let result: AdminIndexResult | undefined;
  try {
    // Quiet mode: no UI, no background summarisation (the process
    // exits immediately and would kill in-flight LLM work anyway).
    await clearParseCacheIfRequested(cg, options.clearParseCache, deps);
    // `--force` clear is threaded INTO indexAll so it runs under the
    // file lock (a contended --force must not wipe the index).
    result = await cg.indexAll(indexAllOptions(options, parseWorkers, args.maxFileSize));
    if (options.profile && result.profile) {
      // Quiet+profile is the scripted use case (CI bench, etc.) —
      // emit a single compact JSON line so it parses cleanly.
      deps.writeStdout(JSON.stringify(result.profile) + '\n');
    }
  } finally {
    cg.close();
  }

  if (!result.success) {
    for (const err of result.errors) {
      const location = err.filePath ? `${err.filePath}: ` : '';
      deps.writeStderr(`${location}${err.message}\n`);
    }
    process.exit(1);
  }
}

async function runInteractiveIndex(args: InteractiveIndexArgs): Promise<void> {
  const { cg, projectPath, options, parseWorkers, maxFileSize, deps } = args;
  const { printIndexResult } = deps;
  const clack = await deps.loadClack();
  clack.intro('Indexing project');

  await prepareInteractiveIndex({ cg, clack, options, deps });
  const result = await runIndexWithProgress({ cg, options, parseWorkers, maxFileSize, deps });
  printIndexResult(clack, result, projectPath);

  if (options.profile && result.profile) {
    clack.note(phaseTimingLines(result, deps).join('\n'), 'Phase timings');
  }
  if (!result.success) process.exit(1);

  await reportBackgroundSummaryStatus({ cg, clack, projectPath, deps });
  clack.outro('Done');
}

async function prepareInteractiveIndex(args: PrepareInteractiveIndexArgs): Promise<void> {
  const { cg, clack, options, deps } = args;
  if (options.force) {
    // The structural clear is threaded into indexAll (below) so it
    // runs UNDER the file lock — a contended --force then leaves the
    // existing index intact instead of wiping it with no rebuild.
    clack.log.info(
      'Full re-index (--force): structural index will be cleared under lock, then rebuilt (nothing is cleared if the lock is held); LLM caches preserved',
    );
  }
  const dropped = await clearParseCacheIfRequested(cg, options.clearParseCache, deps);
  if (!dropped) return;
  clack.log.info(
    dropped.lang
      ? `Cleared ${dropped.count} parse-cache entries for language=${dropped.lang}`
      : `Cleared ${dropped.count} parse-cache entries (every file will fully re-parse)`,
  );
}

export async function clearParseCacheIfRequested(
  cg: AdminIndexGraph,
  clearParseCacheOption: boolean | string | undefined,
  deps: Pick<AdminIndexingCommandDeps, 'loadParseCache'>,
): Promise<{ count: number; lang: string | undefined } | null> {
  if (!clearParseCacheOption) return null;
  const { clearParseCache } = await deps.loadParseCache();
  const lang = typeof clearParseCacheOption === 'string' ? clearParseCacheOption : undefined;
  return { count: clearParseCache(cg.queries, lang), lang };
}

async function runIndexWithProgress(args: RunQuietIndexArgs): Promise<AdminIndexResult> {
  const { cg, options, parseWorkers, maxFileSize, deps } = args;
  // `summarize: false` — the LLM summary tail is NOT run inline.
  // After base indexing the CLI hands it to a detached process
  // (see below), so the in-process background pass must not also
  // fire. Without this both would run and double the GPU load.
  const { colors, createShimmerProgress, createVerboseProgress, writeStdout } = deps;
  if (options.verbose) {
    return cg.indexAll({
      onProgress: createVerboseProgress(),
      verbose: true,
      ...indexAllOptions(options, parseWorkers, maxFileSize),
    });
  }

  writeStdout(`${colors.dim}│${colors.reset}\n`);
  const progress = createShimmerProgress();
  try {
    return await cg.indexAll({
      onProgress: progress.onProgress,
      ...indexAllOptions(options, parseWorkers, maxFileSize),
    });
  } finally {
    await progress.stop();
  }
}

export async function reportBackgroundSummaryStatus(args: BackgroundSummaryStatusArgs): Promise<void> {
  const { cg, clack, projectPath, deps } = args;
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

  const { spawnDetachedSummarize } = await deps.loadDetachedSummarize();
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

function registerEmbedOnlyCommand(deps: AdminIndexingCommandDeps): void {
  const { adminCmd } = deps;
  adminCmd
    .command('embed-only [path]')
    .description('Fast-lane index: skip reference resolution + postHooks; embed only (Stage 4 #9)')
    .option('-q, --quiet', 'Suppress progress output')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .option(
      '--max-file-size <size>',
      'Transiently override config.maxFileSize for this embed-only index run. Use bytes or a kb/mb suffix, up to 10mb.',
    )
    .action((pathArg: string | undefined, options: EmbedOnlyOptions) => runEmbedOnlyCommand(pathArg, options, deps));
}

async function runEmbedOnlyCommand(
  pathArg: string | undefined,
  options: EmbedOnlyOptions,
  deps: AdminIndexingCommandDeps,
): Promise<void> {
  const { error, info, isInitialized, loadCartograph, resolveProjectPath } = deps;
  const projectPath = resolveProjectPath(pathArg);
  const parsedMaxFileSize = parseMaxFileSizeValue(options.maxFileSize);
  if (!parsedMaxFileSize.ok) {
    error(parsedMaxFileSize.error);
    process.exit(1);
  }
  const maxFileSize = parsedMaxFileSize.value;
  let cg: AdminIndexGraph | undefined;

  try {
    if (!isInitialized(projectPath)) {
      error(`Cartograph not initialized in ${projectPath}`);
      info('Run "cartograph admin init" first');
      process.exit(1);
    }

    const { default: Cartograph } = await loadCartograph();
    cg = await Cartograph.open(projectPath, { autoMigrate: true });

    if (options.quiet) {
      await runQuietEmbedOnly(cg, maxFileSize, deps);
      return;
    }

    await runInteractiveEmbedOnly({ cg, projectPath, options, maxFileSize, deps });
  } catch (err) {
    error(`Failed to embed-only index: ${errMsg(err)}`);
    process.exit(1);
  } finally {
    cg?.close();
  }
}

async function runQuietEmbedOnly(
  cg: AdminIndexGraph,
  maxFileSize: number | undefined,
  deps: Pick<AdminIndexingCommandDeps, 'error'>,
): Promise<void> {
  const result = await cg.indexAll({
    summarize: false,
    embedOnly: true,
    ...(maxFileSize !== undefined && { maxFileSize }),
  });
  if (!result.success) process.exit(1);
  try {
    await cg.llm.embed.embedAll();
  } catch (err) {
    deps.error(`Embed pass failed: ${errMsg(err)}`);
    process.exit(1);
  }
}

async function runInteractiveEmbedOnly(args: InteractiveEmbedOnlyArgs): Promise<void> {
  const { cg, projectPath, options, maxFileSize, deps } = args;
  const clack = await deps.loadClack();
  clack.intro('Embed-only indexing (skip resolution + postHooks)');

  const result = options.verbose
    ? await cg.indexAll({
        onProgress: deps.createVerboseProgress(),
        verbose: true,
        embedOnly: true,
        summarize: false,
        ...(maxFileSize !== undefined && { maxFileSize }),
      })
    : await runEmbedOnlyWithShimmer(cg, maxFileSize, deps);
  deps.printIndexResult(clack, result, projectPath);
  await runEmbedOnlyEmbedPass(cg, clack);
  clack.outro('Done');
}

async function runEmbedOnlyWithShimmer(
  cg: AdminIndexGraph,
  maxFileSize: number | undefined,
  deps: AdminIndexingCommandDeps,
): Promise<AdminIndexResult> {
  deps.writeStdout(`${deps.colors.dim}│${deps.colors.reset}\n`);
  const progress = deps.createShimmerProgress();
  try {
    return await cg.indexAll({
      onProgress: progress.onProgress,
      embedOnly: true,
      summarize: false,
      ...(maxFileSize !== undefined && { maxFileSize }),
    });
  } finally {
    await progress.stop();
  }
}

async function runEmbedOnlyEmbedPass(cg: AdminIndexGraph, clack: ClackPrompts): Promise<void> {
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
}

function registerSyncCommand(deps: AdminIndexingCommandDeps): void {
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
    .option(
      '--max-file-size <size>',
      'Transiently override config.maxFileSize for this sync run. Use bytes or a kb/mb suffix, up to 10mb.',
    )
    .action(async (pathArg: string | undefined, options: { quiet?: boolean; maxFileSize?: string }) => {
      const projectPath = resolveProjectPath(pathArg);
      const parsedMaxFileSize = parseMaxFileSizeValue(options.maxFileSize);
      if (!parsedMaxFileSize.ok) {
        error(parsedMaxFileSize.error);
        process.exit(1);
      }
      const maxFileSize = parsedMaxFileSize.value;
      let cg: AdminIndexGraph | undefined;

      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) {
            error(`Cartograph not initialized in ${projectPath}`);
          }
          process.exit(1);
        }

        const { default: Cartograph } = await loadCartograph();
        // Write path (admin sync): opt in to auto-migration.
        cg = await Cartograph.open(projectPath, { autoMigrate: true });

        if (options.quiet) {
          // Quiet mode (git hooks, scripts): skip summarisation so the
          // hook stays fast. The next interactive sync/index picks up
          // any new symbols.
          await cg.sync({ summarize: false, ...(maxFileSize !== undefined && { maxFileSize }) });
          return;
        }

        const clack = await loadClack();
        clack.intro('Syncing Cartograph');

        writeStdout(`${colors.dim}│${colors.reset}\n`);
        const progress = createShimmerProgress();

        let result: SyncResult;
        try {
          result = await cg.sync({
            onProgress: progress.onProgress,
            ...(maxFileSize !== undefined && { maxFileSize }),
          });
        } finally {
          await progress.stop();
        }

        printSyncResult(clack, result, deps);

        // Await any background summarisation kicked off by sync() so
        // the work persists before exit.
        await awaitSummarisationWithProgress(cg, clack);

        clack.outro('Done');
      } catch (err) {
        if (!options.quiet) {
          error(`Failed to sync: ${errMsg(err)}`);
          if (process.env['CG_DEBUG']) writeStderr(`${errMsg(err)}\n`);
        }
        process.exit(1);
      } finally {
        cg?.close();
      }
    });
}
