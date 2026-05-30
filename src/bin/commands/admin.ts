/**
 * `cartograph admin` family subcommands — extracted from the
 * bin/cartograph.ts decomposition; this is a side-effecting module:
 * importing it registers the commands on `adminCmd`.
 */
import * as path from 'path';
import * as fs from 'fs';
import { getCartographDir, isInitialized } from '../../directory.js';
import { createShimmerProgress } from '../../ui/shimmer-progress.js';
import { formatBytes } from '../../utils.js';
import { errMsg } from '../../errors.js';
import { writeScipExport, writeScipImport } from '../../scip/index.js';
import { parseConcurrency } from '../../llm/concurrency.js';
import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from '../../embeddings/similarity-defaults.js';
import {
  adminCmd,
  loadCartograph,
  resolveProjectPath,
  chalk,
  colors,
  success,
  error,
  info,
  warn,
  formatNumber,
  formatDuration,
  createVerboseProgress,
  attachUnknownActionHandler,
  assignIntArg,
  assignFloatArg,
  awaitSummarisationWithProgress,
  printIndexResult,
  type IndexResult,
} from '../_cli-core.js';

/**
 * cartograph admin init [path]
 */
adminCmd
  .command('init [path]')
  .description(
    "Initialize Cartograph in a project directory — creates .cartograph/ and ensures the project .gitignore excludes it (mirrors cartograph_admin MCP tool with action='init')",
  )
  .option('-i, --index', 'Run initial indexing after initialization')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await import('@clack/prompts');

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
          process.stdout.write(`${colors.dim}│${colors.reset}\n`);
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
      cg.destroy();
    } catch (err) {
      clack.log.error(`Failed: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin uninit [path]
 */
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
        // Confirm with user
        const readline = await import('readline');
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

/**
 * cartograph admin index [path]
 */
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
  .action(
    async (
      pathArg: string | undefined,
      options: {
        force?: boolean;
        quiet?: boolean;
        verbose?: boolean;
        profile?: boolean;
        clearParseCache?: boolean | string;
        parseWorkers?: string;
      },
    ) => {
      const projectPath = resolveProjectPath(pathArg);

      // Parse --parse-workers once: a positive integer overrides the
      // pool-size default; anything else is rejected loudly rather than
      // silently ignored.
      let parseWorkers: number | undefined;
      if (options.parseWorkers !== undefined) {
        const n = Number.parseInt(options.parseWorkers, 10);
        if (!Number.isInteger(n) || n < 1) {
          error(`--parse-workers must be a positive integer (got "${options.parseWorkers}")`);
          process.exit(1);
        }
        parseWorkers = n;
      }

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
          // Quiet mode: no UI, no background summarisation (the process
          // exits immediately and would kill in-flight LLM work anyway).
          if (options.clearParseCache) {
            const { clearParseCache } = await import('../../db/queries-parse-cache.js');
            const lang = typeof options.clearParseCache === 'string' ? options.clearParseCache : undefined;
            clearParseCache(cg.queries, lang);
          }
          // `--force` clear is threaded INTO indexAll so it runs under the
          // file lock (a contended --force must not wipe the index).
          const result = await cg.indexAll({
            summarize: false,
            profile: !!options.profile,
            clearStructural: !!options.force,
            ...(parseWorkers !== undefined && { parseWorkers }),
          });
          if (!result.success) process.exit(1);
          if (options.profile && result.profile) {
            // Quiet+profile is the scripted use case (CI bench, etc.) —
            // emit a single compact JSON line so it parses cleanly.
            process.stdout.write(JSON.stringify(result.profile) + '\n');
          }
          cg.destroy();
          return;
        }

        const clack = await import('@clack/prompts');
        clack.intro('Indexing project');

        if (options.force) {
          // The structural clear is threaded into indexAll (below) so it
          // runs UNDER the file lock — a contended --force then leaves the
          // existing index intact instead of wiping it with no rebuild.
          clack.log.info(
            'Full re-index (--force): structural index will be cleared under lock, then rebuilt (nothing is cleared if the lock is held); LLM caches preserved',
          );
        }
        if (options.clearParseCache) {
          const { clearParseCache } = await import('../../db/queries-parse-cache.js');
          const lang = typeof options.clearParseCache === 'string' ? options.clearParseCache : undefined;
          const dropped = clearParseCache(cg.queries, lang);
          clack.log.info(
            lang
              ? `Cleared ${dropped} parse-cache entries for language=${lang}`
              : `Cleared ${dropped} parse-cache entries (every file will fully re-parse)`,
          );
        }

        let result: IndexResult;

        // `summarize: false` — the LLM summary tail is NOT run inline.
        // After base indexing the CLI hands it to a detached process
        // (see below), so the in-process background pass must not also
        // fire. Without this both would run and double the GPU load.
        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
            summarize: false,
            profile: !!options.profile,
            clearStructural: !!options.force,
            ...(parseWorkers !== undefined && { parseWorkers }),
          });
        } else {
          process.stdout.write(`${colors.dim}│${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
            summarize: false,
            profile: !!options.profile,
            clearStructural: !!options.force,
            ...(parseWorkers !== undefined && { parseWorkers }),
          });
          await progress.stop();
        }

        printIndexResult(clack, result, projectPath);

        if (options.profile && result.profile) {
          const p = result.profile;
          const lines: string[] = [];
          // Profile-table layout: column widths + the percent scale.
          const PERCENT_SCALE = 100;
          const LABEL_WIDTH = 14;
          const DURATION_WIDTH = 8;
          const PERCENT_WIDTH = 2;
          const fmt = (label: string, ms: number | undefined): string => {
            if (ms === undefined) return '';
            const pct = result.durationMs > 0 ? Math.round((ms / result.durationMs) * PERCENT_SCALE) : 0;
            return `  ${label.padEnd(LABEL_WIDTH)} ${formatDuration(ms).padStart(DURATION_WIDTH)}  (${pct.toString().padStart(PERCENT_WIDTH)}%)`;
          };
          lines.push(fmt('scan', p.scanMs));
          lines.push(fmt('parse+store', p.parseStoreMs));
          if (p.retryMs && p.retryMs > 0) lines.push(fmt('retry', p.retryMs));
          lines.push(fmt('resolve', p.resolveMs));
          lines.push(fmt('postHooks', p.postHooksMs));
          // Per-hook breakdown when postHooks is non-trivial. Sorted
          // descending so the dominant sub-hook is at the top.
          if (p.postHooksByHook && p.postHooksMs && p.postHooksMs > 0) {
            const sorted = Object.entries(p.postHooksByHook).sort((a, b) => b[1] - a[1]);
            for (const [name, ms] of sorted) {
              const pct = p.postHooksMs > 0 ? Math.round((ms / p.postHooksMs) * 100) : 0;
              lines.push(
                `    ${name.padEnd(12)} ${formatDuration(ms).padStart(8)}  (${pct.toString().padStart(2)}% of postHooks)`,
              );
            }
          }
          lines.push(fmt('maintenance', p.maintenanceMs));
          lines.push(fmt('total', result.durationMs));
          clack.note(lines.filter(Boolean).join('\n'), 'Phase timings');
        }

        if (!result.success) {
          process.exit(1);
        }

        // Base graph is complete and queryable NOW. Hand the slow LLM
        // summary tail (minutes) to a detached process so the CLI
        // returns immediately instead of making the user sit and wait.
        const llmCfgForSummary = await cg.llm.getEffectiveLlmConfig();
        const eagerLimitCfg = cg.config.llm?.summarizeEagerLimit;
        cg.destroy(); // release DB handles before the child opens them

        if (!llmCfgForSummary) {
          clack.log.info(
            'No LLM configured — symbol summaries skipped. Run ' +
              '`cartograph admin install-models --write-config` to enable them.',
          );
        } else if (eagerLimitCfg === 0) {
          clack.log.info(
            'Summaries: ad-hoc only (config.llm.summarizeEagerLimit = 0) — ' +
              'generated on demand as `find mode:intent` references symbols.',
          );
        } else {
          const { spawnDetachedSummarize } = await import('../../llm/detached-summarize.js');
          const detached = spawnDetachedSummarize(projectPath);
          if (detached.spawned) {
            clack.log.success(
              `Base index ready — cartograph is usable now. Symbol summaries are ` +
                `generating in the background (pid ${detached.pid}); run \`cartograph status\` ` +
                `for coverage, or \`cartograph admin summarize --all\` to wait for a full pass.`,
            );
          } else {
            clack.log.info(`Base index ready. Background summarization ${detached.reason}.`);
          }
        }

        clack.outro('Done');
      } catch (err) {
        error(`Failed to index: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

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
          await cg.llm.embedAll();
        } catch (err) {
          error(`Embed pass failed: ${errMsg(err)}`);
          cg.destroy();
          process.exit(1);
        }
        cg.destroy();
        return;
      }

      const clack = await import('@clack/prompts');
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
        process.stdout.write(`${colors.dim}│${colors.reset}\n`);
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
        const embedResult = await cg.llm.embedAll({});
        clack.log.success(
          `Embedded ${embedResult.generated}/${embedResult.candidates} symbols ` +
            `(${embedResult.errors} errors, ${embedResult.durationMs}ms)`,
        );
      } catch (err) {
        clack.log.warn(`Embed pass skipped: ${errMsg(err)}`);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      error(`Failed to embed-only index: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin sync [path]
 */
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
        cg.destroy();
        return;
      }

      const clack = await import('@clack/prompts');
      clack.intro('Syncing Cartograph');

      process.stdout.write(`${colors.dim}│${colors.reset}\n`);
      const progress = createShimmerProgress();

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

      await progress.stop();

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (totalChanges === 0) {
        clack.log.info('Already up to date');
      } else {
        clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
        const details: string[] = [];
        if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
        if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
        if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
        clack.log.info(
          `${details.join(', ')} — ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`,
        );
      }

      // Await any background summarisation kicked off by sync() so
      // the work persists before exit.
      await awaitSummarisationWithProgress(cg, clack);

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${errMsg(err)}`);
        if (process.env['CG_DEBUG']) console.error(err);
      }
      process.exit(1);
    }
  });

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

        const llmConfig = await cg.llm.getEffectiveLlmConfig();
        if (!llmConfig) {
          if (!options.quiet) {
            error(
              'No LLM available. Add config.llm to .cartograph/config.json (run `cartograph admin install-models --write-config` for the recommended stack — llama-server HTTP for every tier — or set provider: "anthropic-api" for Claude).',
            );
          }
          cg.destroy();
          process.exit(1);
        }

        // Match the MCP `cartograph_admin({action: 'summarize'})` clamp [1, 16] so both
        // surfaces enforce the same upper bound. Local LLMs and rate-
        // limited cloud endpoints both work poorly past ~8 concurrent.
        const concurrency = parseConcurrency(options.concurrency);

        // Lever C — eager-summary cap. `--all` wins, then `--limit`,
        // else undefined so the service falls back to
        // config.llm.summarizeEagerLimit (then the built-in default).
        let eagerLimit: number | undefined;
        if (options.all) {
          eagerLimit = Number.POSITIVE_INFINITY;
        } else if (options.limit !== undefined) {
          const parsed = Number(options.limit);
          if (!Number.isInteger(parsed) || parsed < 0) {
            if (!options.quiet)
              error('--limit must be a non-negative integer (0 = ad-hoc only; use --all for an uncapped pass)');
            cg.destroy();
            process.exit(1);
          }
          eagerLimit = parsed;
        }

        // Conditional spread — `exactOptionalPropertyTypes` rejects an
        // explicit `eagerLimit: undefined` (let the service default it).
        const eagerLimitOpt = eagerLimit !== undefined ? { eagerLimit } : {};

        if (options.quiet) {
          await cg.llm.summarizeAll({ concurrency, ...eagerLimitOpt });
          cg.destroy();
          return;
        }

        const clack = await import('@clack/prompts');
        clack.intro('Summarising indexed symbols');

        const progress = createShimmerProgress();
        progress.onProgress({ phase: 'parsing', current: 0, total: 0 });

        const result = await cg.llm.summarizeAll({
          concurrency,
          ...eagerLimitOpt,
          onProgress: (done, total) => {
            progress.onProgress({ phase: 'parsing', current: done, total });
          },
        });

        await progress.stop();

        const skipped = result.candidates - result.generated - result.errors - result.cacheHits - result.deferred;
        clack.log.success(
          `Summarised ${formatNumber(result.generated)} new symbols in ${formatDuration(result.durationMs)}`,
        );
        const details: string[] = [];
        if (result.cacheHits > 0) details.push(`Cache hits: ${formatNumber(result.cacheHits)}`);
        if (result.errors > 0) details.push(`Errors: ${formatNumber(result.errors)}`);
        if (skipped > 0) details.push(`Skipped: ${formatNumber(skipped)}`);
        if (details.length > 0) clack.log.info(details.join(' — '));
        // Lever C — make the eager-limit visible: the deferred tail is
        // not lost, it summarises on demand when intent-search hits it.
        if (result.deferred > 0) {
          clack.log.info(
            `Deferred ${formatNumber(result.deferred)} lower-priority symbols — they summarise on demand ` +
              `when \`find mode:intent\` references them. Run \`cartograph admin summarize --all\` for a full pass.`,
          );
        }

        // Surface the embed-phase result. Three states: ran-with-work,
        // ran-but-failed, ran-and-cached (silent, nothing to print).
        if (result.embed) {
          if (result.embed.failed) {
            clack.log.warn(
              `Embed phase failed: ${result.embed.failureReason ?? 'unknown error'}. ` +
                `Summaries are persisted; rerun \`cartograph admin embed\` once the embedding endpoint is back.`,
            );
          } else if (result.embed.generated > 0) {
            const counters: string[] = [];
            if (result.embed.errors > 0) counters.push(`${formatNumber(result.embed.errors)} errors`);
            if (result.embed.skipped > 0)
              counters.push(`${formatNumber(result.embed.skipped)} skipped — too large for embed server's batch size`);
            clack.log.success(
              `Embedded ${formatNumber(result.embed.generated)} new vectors in ${formatDuration(result.embed.durationMs)}` +
                (counters.length > 0 ? ` (${counters.join(', ')})` : ''),
            );
          }
        }

        clack.outro('Done');
        cg.destroy();
      } catch (err) {
        if (!options.quiet) error(`Failed to summarise: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

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
      const concurrency = parseConcurrency(options.concurrency);

      if (options.quiet) {
        await cg.llm.embedAll({ concurrency });
        cg.destroy();
        return;
      }

      const clack = await import('@clack/prompts');
      clack.intro('Embedding indexed symbols');
      const result = await cg.llm.embedAll({ concurrency });
      const counters: string[] = [];
      if (result.errors > 0) counters.push(`${formatNumber(result.errors)} errors`);
      if (result.skipped > 0)
        counters.push(`${formatNumber(result.skipped)} skipped — too large for embed server's batch size`);
      clack.log.success(
        `Embedded ${formatNumber(result.generated)} new vectors in ${formatDuration(result.durationMs)}` +
          (counters.length > 0 ? ` (${counters.join(', ')})` : ''),
      );
      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      if (!options.quiet) error(`Failed to embed: ${errMsg(err)}`);
      process.exit(1);
    }
  });

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
      const concurrency = parseConcurrency(options.concurrency);

      if (options.quiet) {
        await cg.llm.classifyAll({ concurrency });
        cg.destroy();
        return;
      }

      const clack = await import('@clack/prompts');
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
      cg.destroy();
    } catch (err) {
      if (!options.quiet) error(`Failed to classify: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin unlock [path]
 */
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

      if (!fs.existsSync(lockPath)) {
        info('No lock file found — nothing to do');
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin migrate [path]
 *
 * Apply forward schema migrations on the project DB. Cheapest
 * recovery path when a read-style command fails with "Database
 * schema vN is behind this binary's vM" — opens the DB with
 * autoMigrate=true, which runs migrations once and exits.
 */
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
      cg.destroy();
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

/**
 * cartograph admin build-similarity-edges [path]
 *
 * Build similar_to edges over the embedding space. For each node with
 * an embedding, finds its k nearest neighbors and creates edges when
 * similarity exceeds the threshold.
 */
adminCmd
  .command('build-similarity-edges [path]')
  .option('--k <number>', `Number of nearest neighbors to find (default ${DEFAULT_SIMILAR_K})`)
  .option('--min-score <number>', `Minimum similarity threshold 0..1 (default ${DEFAULT_SIMILAR_MIN_SCORE})`)
  .description(
    "Build similar_to edges from embeddings (mirrors cartograph_admin MCP tool with action='build-similarity-edges')",
  )
  .action(async (pathArg: string | undefined, opts) => {
    const projectPath = resolveProjectPath(pathArg);
    try {
      if (!isInitialized(projectPath)) {
        error(`Cartograph not initialized in ${projectPath}`);
        process.exit(1);
      }
      const { default: Cartograph } = await loadCartograph();
      const cg = await Cartograph.open(projectPath);
      const { buildSimilarToEdges } = await import('../../embeddings/similar-edges.js');
      // Route --k / --min-score through the shared validators so bad
      // input (NaN, negative, out-of-range) is rejected with a clean
      // error instead of being silently coerced to the default / clamped.
      const o = opts as Record<string, string | undefined>;
      const parsed: Record<string, unknown> = {};
      if (!assignIntArg({ args: parsed, key: 'k', raw: o['k'], optionName: '--k', opts: { min: 1, max: 100 } })) {
        cg.destroy();
        return;
      }
      if (
        !assignFloatArg({
          args: parsed,
          key: 'minScore',
          raw: o['minScore'],
          optionName: '--min-score',
          opts: { min: 0, max: 1 },
        })
      ) {
        cg.destroy();
        return;
      }
      const k = (parsed['k'] as number | undefined) ?? DEFAULT_SIMILAR_K;
      const minScore = (parsed['minScore'] as number | undefined) ?? DEFAULT_SIMILAR_MIN_SCORE;
      const result = await buildSimilarToEdges(cg, { k, minScore });
      cg.destroy();
      success(`Built similarity edges: ${result.written} edges from ${result.processed} nodes.`);
      if (result.reason) {
        info(`Note: ${result.reason}`);
      }
    } catch (err) {
      error(`Failed to build similarity edges: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin prune-store [path]
 *
 * Evict cold orphan rows from the content-addressed summary_store /
 * embedding_store tables — orphans whose `last_ref_at` is older than
 * `--max-age-days` and have no live ref. Active rows (any with at
 * least one ref) are NEVER evicted; recent orphans within the
 * freshness window are kept as the revert/rename reuse pool.
 *
 * Pass `--max-age-days 0` to evict EVERY orphan immediately,
 * regardless of age — the full cache-eviction sweep. Vec0 mirror
 * rows are deleted in lockstep (vec0 has no FK). After the delete,
 * `dbRunMaintenance` returns the freed pages to the OS so the DB
 * file actually shrinks.
 */
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
        process.exit(1);
      }
      const { pruneOrphanStoreRows, MS_PER_DAY, PRUNE_STORE_DEFAULT_DAYS } = await import(
        '../../db/queries-summaries.js'
      );
      const raw = (opts as Record<string, string>)['maxAgeDays'];
      const maxAgeDays = raw === undefined ? PRUNE_STORE_DEFAULT_DAYS : Number.parseFloat(raw);
      if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
        error(`--max-age-days must be a non-negative number. Got '${raw}'.`);
        process.exit(1);
      }
      const { default: Cartograph } = await loadCartograph();
      // Write path: opt in to auto-migration so a cold project that's
      // never touched the new prune-store action still picks up
      // migration 053 on first run.
      const cg = await Cartograph.open(projectPath, { autoMigrate: true });
      try {
        const { dbReclaimAfterBulkDelete } = await import('../../db/index.js');
        const sizeBefore = cg.db.getSize();
        const result = pruneOrphanStoreRows(cg.queries, {
          maxAgeMs: maxAgeDays * MS_PER_DAY,
        });
        const totalPruned = result.summariesPruned + result.embeddingsPruned;
        // Deleting rows only moves pages to the freelist — the file
        // still occupies the same disk. Reclaim the freelist AND
        // truncate the WAL so the prune actually shrinks the DB.
        // Skipped when nothing was deleted (no freelist to reclaim).
        if (totalPruned > 0) {
          dbReclaimAfterBulkDelete(cg.db);
        }
        const sizeAfter = cg.db.getSize();
        success(
          `Pruned ${formatNumber(result.summariesPruned)} summary_store + ` +
            `${formatNumber(result.embeddingsPruned)} embedding_store row(s) ` +
            `older than ${maxAgeDays} day(s).`,
        );
        if (totalPruned > 0) {
          const reclaimed = sizeBefore - sizeAfter;
          info(
            `Database: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} ` +
              `(reclaimed ${formatBytes(Math.max(0, reclaimed))}).`,
          );
        }
      } finally {
        cg.destroy();
      }
    } catch (err) {
      error(`Failed to prune store: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin scip-export [path]
 *
 * Export the cartograph index to a SCIP protobuf file.
 * Mirrors cartograph_admin({action: 'scip-export'}).
 */
adminCmd
  .command('scip-export [path]')
  .description(
    "Export the cartograph index to a SCIP protobuf file (mirrors cartograph_admin MCP tool with action='scip-export')",
  )
  .option('-o, --out <file>', 'Output .scip file path (default: <project>/index.scip)')
  .action(async (pathArg: string | undefined, options: { out?: string }) => {
    const projectPath = resolveProjectPath(pathArg);
    try {
      if (!isInitialized(projectPath)) {
        error(`Cartograph not initialized in ${projectPath}`);
        process.exit(1);
      }
      const { default: Cartograph } = await loadCartograph();
      const cg = await Cartograph.open(projectPath);
      const outPath = options.out ?? path.join(projectPath, 'index.scip');
      const result = writeScipExport(cg.queries, cg.projectRoot, outPath);
      cg.destroy();
      info(`Exported SCIP index → ${result.outPath}`);
      info(
        `${result.stats.documents} documents, ${result.stats.symbols} symbols, ${result.stats.occurrences} occurrences (${result.stats.bytes} bytes)`,
      );
      if (result.stats.disambiguated > 0) {
        info(`${result.stats.disambiguated} symbol(s) disambiguated (name collision)`);
      }
    } catch (err) {
      error(`SCIP export failed: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin scip-import [path]
 *
 * Import a SCIP protobuf index into the cartograph graph (per-file replace).
 * Mirrors cartograph_admin({action: 'scip-import'}).
 */
adminCmd
  .command('scip-import [path]')
  .description(
    "Import a SCIP protobuf index into the cartograph graph — per-file replace (mirrors cartograph_admin MCP tool with action='scip-import')",
  )
  .option('-i, --in <file>', 'Input .scip file path (default: <project>/index.scip)')
  .action(async (pathArg: string | undefined, options: { in?: string }) => {
    const projectPath = resolveProjectPath(pathArg);
    try {
      if (!isInitialized(projectPath)) {
        error(`Cartograph not initialized in ${projectPath}`);
        process.exit(1);
      }
      const inPath = options.in ?? path.join(projectPath, 'index.scip');
      if (!fs.existsSync(inPath)) {
        error(`SCIP file not found: ${inPath}`);
        process.exit(1);
      }
      const { default: Cartograph } = await loadCartograph();
      const cg = await Cartograph.open(projectPath);
      const bytes = fs.readFileSync(inPath);
      const result = writeScipImport(cg.queries, cg.projectRoot, bytes);
      cg.destroy();
      info(`Imported SCIP index ← ${inPath}`);
      info(
        `${result.stats.documents} documents, ${result.stats.files} files, ${result.stats.nodes} nodes, ${result.stats.edges} edges`,
      );
      if (result.stats.skippedDocuments > 0) {
        info(`${result.stats.skippedDocuments} document(s) skipped (unsafe path)`);
      }
      if (result.stats.unresolvedEdges > 0) {
        info(`${result.stats.unresolvedEdges} edge(s) dropped (target symbol had no definition)`);
      }
    } catch (err) {
      error(`SCIP import failed: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph admin install-models [--dir <path>]
 *
 * Download the curated GGUF set (Qwen2.5-Coder 3B + 7B, jina-code,
 * bge-reranker-v2-m3) into ~/.cartograph/models/ (override via --dir).
 * Idempotent — files already present are skipped.
 *
 * Mirrors cartograph_admin({action: 'install-models'}).
 */
adminCmd
  .command('install-models')
  .description(
    "Download the recommended GGUF set into ~/.cartograph/models/ (mirrors cartograph_admin MCP tool with action='install-models').",
  )
  .option('--dir <path>', 'Directory to install GGUFs into (overrides ~/.cartograph/models)')
  .option(
    '--minimal',
    'Only install the smallest viable subset (embed + 3B chat, ~2.1 GB) instead of the full ~7 GB set.',
  )
  .option(
    '--write-config',
    'After download, merge the recommended LLM block into .cartograph/config.json (creates a .bak.<timestamp> first). Default off for back-compat.',
  )
  .option('-p, --project-path <path>', 'Project root for --write-config (default: cwd)')
  .action(async (options: { dir?: string; minimal?: boolean; writeConfig?: boolean; projectPath?: string }) => {
    try {
      const { installRecommendedModels } = await import('../../installer/install-models.js');
      const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await import('../../llm/recommended-models.js');
      const installOpts = options.dir ? { dir: options.dir } : {};
      const result = await installRecommendedModels({
        ...installOpts,
        models: options.minimal ? MINIMAL_MODELS : RECOMMENDED_MODELS,
        onProgress: ({ model, downloaded, total }) => {
          const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);
          const pct = total > 0 ? ((downloaded / total) * 100).toFixed(0) : '?';
          process.stderr.write(`\r${model.filename}: ${mb(downloaded)}/${total > 0 ? mb(total) : '?'} MB (${pct}%)   `);
        },
      });
      process.stderr.write('\n');
      if (result.downloaded.length > 0) {
        success(`Downloaded ${result.downloaded.length} model${result.downloaded.length === 1 ? '' : 's'}:`);
        for (const m of result.downloaded) info(`  ${m.filename} — ${m.description}`);
      }
      if (result.skipped.length > 0) {
        info(`Already present (skipped): ${result.skipped.map((m) => m.filename).join(', ')}`);
      }
      info('');

      if (options.writeConfig) {
        const projectRoot = resolveProjectPath(options.projectPath);
        const { writeRecommendedLlmConfig } = await import('../../installer/recommended-config.js');
        const writeOpts: { projectRoot: string; dir?: string } = { projectRoot };
        if (options.dir) writeOpts.dir = options.dir;
        const { configPath, backupPath, diff } = writeRecommendedLlmConfig(writeOpts);
        if (backupPath) {
          info(`Backup written: ${backupPath}`);
        }
        success(`Updated ${configPath}`);
        if (diff.addedOrUpdated.length > 0) {
          info(`  added/updated: ${diff.addedOrUpdated.join(', ')}`);
        }
      } else {
        info(
          'Next: re-run with `--write-config` to merge the recommended LLM block into .cartograph/config.json, or set `llm.summarizeLlm`, `llm.askLlm`, `llm.embeddingLlm`, `llm.rerankerLlm` by hand.',
        );
      }
    } catch (err) {
      error(`install-models failed: ${errMsg(err)}`);
      process.exit(1);
    }
  });

// The `cartograph admin install-shim` command was removed 2026-05-24c
// when the in-process LLM pathway (libcgshim + mini-nllc) was deleted
// in step 4c of the migration. Embed / chat / rerank all run via HTTP
// against an OpenAI-compat backend now — see CLAUDE.md "Native
// dependencies + runtime architecture" + the `recommended-config`
// helper for setup guidance.

attachUnknownActionHandler(adminCmd, 'admin');
