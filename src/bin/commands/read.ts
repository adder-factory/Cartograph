/**
 * Top-level read-query CLI commands (at-range / ask / status / find /
 * digest / files / affected) — extracted from the bin/cartograph.ts
 * decomposition; side-effecting module: importing it registers the
 * commands on `program`.
 */
import * as fs from 'node:fs';
import { getSummaryCoverage, getWeightedSummaryCoverage } from '../../db/queries-summaries.js';
import { SUMMARIZABLE_KINDS } from '../../llm/summarizer.js';
import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import { getFileSummaries } from '../../db/queries-file-summaries.js';
import { buildIndexedPathSets, findAffectedTests } from '../../affected-core.js';
import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MIN, RETRIEVE_K_MAX } from '../../mcp/tools/ask.js';
import { buildDirRollup, filterFilesByDir } from '../../mcp/tools/files.js';
import { registerAffectedCommand as registerAffectedFeatureCommand } from '../../features/affected/index.js';
import { registerAtRangeCommand as registerAtRangeFeatureCommand } from '../../features/at-range/index.js';
import { registerFilesCommand as registerFilesFeatureCommand } from '../../features/files/index.js';
import { isValidFindAxis, parseFieldsOption, registerFindCommand } from '../../features/find/index.js';
import { isInitialized } from '../../directory.js';
import { errMsg } from '../../errors.js';
import { detectPackageManager, packageScriptCommand, readPackageScripts } from '../../package-scripts.js';
import {
  program,
  error,
  success,
  info,
  warn,
  chalk,
  resolveProjectPath,
  loadCartograph,
  assignIntArg,
  formatNumber,
  runViaMCP,
} from '../_cli-core.js';

/** Mirrors MAX_INLINE_TOP_N in src/mcp/tools/status.ts — kept as a local
 *  literal so `--top-*` help text can reference the cap without forcing a
 *  top-level import of status.ts. The dynamic-import path still clamps
 *  with the real `parseInlineTopN`. */
const STATUS_MAX_INLINE_TOP_N = 30;

function out(message = ''): void {
  process.stdout.write(`${message}\n`);
}

interface StatusOptions {
  json?: boolean;
  verbose?: boolean;
  topHotspots?: string;
  topBiomarkers?: string;
  summaryBreakdown?: boolean;
}

interface StatusRollupConfig {
  topHotspots: number;
  topBiomarkers: number;
  summaryBreakdown: boolean;
  appendFeatureReadiness: (
    lines: string[],
    cg: any,
    options: { summaryBreakdown: boolean; surface?: 'mcp' | 'cli' },
  ) => void;
  appendInlineHotspots: (lines: string[], cg: any, topN: number) => void;
  appendInlineBiomarkers: (lines: string[], cg: any, topN: number) => void;
}

function validateAskQuestion(question: string): boolean {
  if (question.trim().length === 0) {
    error('ask: the question must not be empty.');
    process.exitCode = 1;
    return false;
  }
  if (question.length > 4096) {
    error(`ask: the question must be at most 4096 characters (got ${question.length}).`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function parseRetrieveK(raw: string | undefined): number | null {
  const retrieveKArgs: Record<string, unknown> = {};
  if (
    !assignIntArg({
      args: retrieveKArgs,
      key: 'retrieveK',
      raw,
      optionName: '--retrieve-k',
      opts: { min: RETRIEVE_K_MIN, max: RETRIEVE_K_MAX },
    })
  ) {
    return null;
  }
  return (retrieveKArgs['retrieveK'] as number | undefined) ?? RETRIEVE_K_DEFAULT;
}

async function printAskAnnotations(
  cg: Parameters<typeof import('../../mcp/tools/ask.js')['groundCitations']>[0],
  result: {
    answer: string;
    citations: Array<{ node: { name: string; kind: string; filePath: string; startLine?: number } }>;
    retrieveMs: number;
    chatMs: number;
  },
  askModel: string,
): Promise<void> {
  const { groundCitations, buildCitationReport } = await import('../../mcp/tools/ask.js');
  const { displayModelName } = await import('../../mcp/tools/shared.js');
  const cited = groundCitations(cg, result.answer);
  const report = buildCitationReport(cited);
  for (const line of report.sections) {
    out(line ? chalk.dim(line) : '');
  }
  out('\n' + chalk.dim('Retrieval sources:'));
  for (const c of result.citations) {
    const loc = c.node.startLine ? `:${c.node.startLine}` : '';
    out(chalk.dim(`  • ${c.node.name} (${c.node.kind}) ${c.node.filePath}${loc}`));
  }
  out(
    chalk.dim(
      `\n  retrieve ${result.retrieveMs}ms · chat ${result.chatMs}ms · model ${displayModelName(askModel)} · ${report.counter}`,
    ),
  );
}

async function buildStatusRollupConfig(options: StatusOptions): Promise<StatusRollupConfig> {
  const { appendFeatureReadiness, appendInlineBiomarkers, appendInlineHotspots, resolveStatusRollups } = await import(
    '../../mcp/tools/status.js'
  );
  const rollups = resolveStatusRollups(options);
  return {
    ...rollups,
    appendFeatureReadiness,
    appendInlineHotspots,
    appendInlineBiomarkers,
  };
}

function printUninitializedStatus(projectPath: string, options: StatusOptions): void {
  if (options.json) {
    out(JSON.stringify({ initialized: false, projectPath }));
    return;
  }
  out(chalk.bold('\nCartograph Status\n'));
  info(`Project: ${projectPath}`);
  warn('Not initialized');
  info('Run "cartograph admin init" to initialize');
}

async function loadStatusChangeInfo(cg: any): Promise<{ changes: any; healOnly: string[]; realModifiedCount: number }> {
  const { classifyChangedFiles, realModifiedCount: computeRealModified } = await import(
    '../../changed-files-classify.js'
  );
  const changes = classifyChangedFiles(cg);
  if (!changes) throw new Error('Failed to read changed files from the index');
  return { changes, healOnly: changes.healOnly, realModifiedCount: computeRealModified(changes) };
}

function printStatusJson(args: {
  cg: any;
  projectPath: string;
  stats: any;
  changes: any;
  healOnly: string[];
  realModifiedCount: number;
  hnswAvailable: boolean;
  rollups: StatusRollupConfig;
}): void {
  const jsonRollups: string[] = [];
  args.rollups.appendFeatureReadiness(jsonRollups, args.cg, {
    summaryBreakdown: args.rollups.summaryBreakdown,
    surface: 'cli',
  });
  args.rollups.appendInlineHotspots(jsonRollups, args.cg, args.rollups.topHotspots);
  args.rollups.appendInlineBiomarkers(jsonRollups, args.cg, args.rollups.topBiomarkers);
  out(
    JSON.stringify({
      initialized: true,
      projectPath: args.projectPath,
      fileCount: args.stats.fileCount,
      nodeCount: args.stats.nodeCount,
      edgeCount: args.stats.edgeCount,
      dbSizeBytes: args.stats.dbSizeBytes,
      backend: args.cg.db.getBackend(),
      vecExtension: args.cg.db.hasVecExtension(),
      hnswAvailable: args.hnswAvailable,
      nodesByKind: args.stats.nodesByKind,
      languages: Object.entries(args.stats.filesByLanguage)
        .filter(([, count]) => (count as number) > 0)
        .map(([lang]) => lang),
      pendingChanges: {
        added: args.changes.added.length,
        modified: args.realModifiedCount,
        removed: args.changes.removed.length,
        healFlagged: args.healOnly.length,
      },
      rollups: jsonRollups.filter((l) => l !== ''),
    }),
  );
}

function printStatusIndexStats(stats: any, cg: any, hnswAvailable: boolean): void {
  out(chalk.bold('Index Statistics:'));
  out(`  Files:     ${formatNumber(stats.fileCount)}`);
  out(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
  out(`  Edges:     ${formatNumber(stats.edgeCount)}`);
  out(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  const vec = cg.db.hasVecExtension();
  const vecSuffix = vec ? ' + sqlite-vec' : '';
  const backendLabel = chalk.magenta(`bun:sqlite${vecSuffix}`);
  out(`  Backend:   ${backendLabel}`);
  if (!vec) {
    out(chalk.yellow('  ⚠ sqlite-vec did not load — vector search is on the slow in-memory brute-force path.'));
    out(chalk.dim('     sqlite-vec ships prebuilts for darwin/linux x64+arm64 and windows-x64.'));
  } else if (!hnswAvailable) {
    out(chalk.dim('  ℹ USearch unavailable — similar_to edge builds use the vec0 brute-force path;'));
    out(chalk.dim('     `bun install` re-fetches the optional `usearch` accelerator for large repos.'));
  }
  out();
}

function printCountBreakdown(title: string, entries: Record<string, number>): void {
  out(chalk.bold(title));
  const sorted = Object.entries(entries)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sorted) {
    out(`  ${label.padEnd(15)} ${formatNumber(count)}`);
  }
  out();
}

async function printParseCacheStatus(cg: any): Promise<void> {
  try {
    const { getParseCacheStats } = await import('../../db/queries-parse-cache.js');
    const pc = getParseCacheStats(cg.queries);
    if (pc.rows === 0) return;
    const sizeMB = (pc.sizeBytes / 1024 / 1024).toFixed(1);
    const stale = pc.staleVersionRows > 0 ? chalk.yellow(`  (${pc.staleVersionRows} stale, will LRU out)`) : '';
    out(chalk.bold('Parse Cache:'));
    out(
      `  Replayable: ${formatNumber(pc.currentVersionRows)} entries (${sizeMB} MB) · schema _v${pc.currentVersion}${stale}`,
    );
    out();
  } catch {
    /* pre-migration-026 DB */
  }
}

function printPendingChanges(changes: any, realModifiedCount: number, healOnly: string[]): void {
  const totalChanges = changes.added.length + realModifiedCount + changes.removed.length + healOnly.length;
  if (totalChanges === 0) {
    success('Index is up to date');
    out();
    return;
  }
  out(chalk.bold('Pending Changes:'));
  if (changes.added.length > 0) out(`  Added:     ${changes.added.length} files`);
  if (realModifiedCount > 0) out(`  Modified:  ${realModifiedCount} files`);
  if (changes.removed.length > 0) out(`  Removed:   ${changes.removed.length} files`);
  if (healOnly.length > 0) {
    out(
      `  Heal-flagged (re-extract): ${healOnly.length} files ` +
        `(extraction-logic-version drift; no on-disk content change)`,
    );
  }
  info('Run "cartograph admin sync" to update the index');
  out();
}

async function printLlmStatus(cg: any, projectPath: string): Promise<void> {
  out(chalk.bold('LLM Enrichment:'));
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  if (!llmConfig) {
    out(
      '  No LLM configured. Run `cartograph admin install-models --write-config` for the recommended stack (llama-server HTTP — embed :8080 / chat :8081 / ask :8082 / reranker :8083), or set config.llm in .cartograph/config.json.',
    );
    out();
    return;
  }
  const { getAskModel, getChatModel, getEmbeddingModel, getDisplayEndpoint } = await import('../../llm/provider.js');
  const chatModel = getChatModel(llmConfig);
  const askModel = getAskModel(llmConfig);
  out(`  Endpoint:  ${getDisplayEndpoint(llmConfig)} (configured)`);
  out(`  Model:     ${chatModel ?? '(no summarize model)'}`);
  if (askModel && askModel !== chatModel) {
    const askProvider = llmConfig.askLlm?.provider;
    const askProviderSuffix = askProvider ? ` (${askProvider})` : '';
    out(`  Ask model: ${askModel}${askProviderSuffix}`);
  }
  const embedModel = getEmbeddingModel(llmConfig);
  if (embedModel) out(`  Embed:     ${embedModel}`);
  printSummaryCoverage(cg);
  const { getDetachedSummarizeState } = await import('../../llm/detached-summarize.js');
  const bg = getDetachedSummarizeState(projectPath);
  if (bg.running) {
    out(`  Summaries: background pass running (pid ${bg.pid}) — coverage is still climbing`);
  }
  out();
}

function printSummaryCoverage(cg: any): void {
  const cov = getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  if (cov.total === 0) return;
  const pct = Math.round((cov.summarised / cov.total) * 100);
  const weighted = getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  const weightedSuffix =
    weighted.weightedRatio === null ? '' : ` — centrality-weighted ${Math.round(weighted.weightedRatio * 100)}%`;
  out(`  Summaries: ${formatNumber(cov.summarised)}/${formatNumber(cov.total)} (${pct}%)${weightedSuffix}`);
}

function printStatusRollups(cg: any, rollups: StatusRollupConfig): void {
  const rollupLines: string[] = [];
  rollups.appendFeatureReadiness(rollupLines, cg, { summaryBreakdown: rollups.summaryBreakdown, surface: 'cli' });
  rollups.appendInlineHotspots(rollupLines, cg, rollups.topHotspots);
  rollups.appendInlineBiomarkers(rollupLines, cg, rollups.topBiomarkers);
  if (rollupLines.length === 0) return;
  for (const line of rollupLines) {
    printStatusRollupLine(line);
  }
  out();
}

function printStatusRollupLine(line: string): void {
  if (line === '') {
    out();
  } else if (line.startsWith('### ')) {
    out(chalk.bold(line.slice(4)));
  } else {
    out(line);
  }
}

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

interface ReadCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface ReadCommandDeps {
  program: CommandLike;
  error: typeof error;
  info: typeof info;
  resolveProjectPath: typeof resolveProjectPath;
  loadCartograph: () => Promise<ReadCartographModule>;
  runViaMCP: typeof runViaMCP;
  isInitialized: typeof isInitialized;
  getAllFilesWithSymbolCount: typeof getAllFilesWithSymbolCount;
  getFileSummaries: typeof getFileSummaries;
  filterFilesByDir: typeof filterFilesByDir;
  buildDirRollup: typeof buildDirRollup;
  buildIndexedPathSets: typeof buildIndexedPathSets;
  findAffectedTests: typeof findAffectedTests;
  loadGitUtils: () => Promise<{ listChangedFilesSince: (projectPath: string, ref: string) => string[] | null }>;
}

const defaultReadCommandDeps: ReadCommandDeps = {
  program,
  error,
  info,
  resolveProjectPath,
  loadCartograph: loadCartograph as () => Promise<ReadCartographModule>,
  runViaMCP,
  isInitialized,
  getAllFilesWithSymbolCount,
  getFileSummaries,
  filterFilesByDir,
  buildDirRollup,
  buildIndexedPathSets,
  findAffectedTests,
  loadGitUtils: (() => import('../../git-utils.js')) as ReadCommandDeps['loadGitUtils'],
};

function registerAtRangeReadCommand(deps: ReadCommandDeps): void {
  registerAtRangeFeatureCommand({ ...deps, warn });
}

function registerFilesReadCommand(deps: ReadCommandDeps): void {
  registerFilesFeatureCommand({
    ...deps,
    writeLine: out,
    style: {
      bold: chalk.bold,
      cyan: chalk.cyan,
      dim: chalk.dim,
    },
  });
}

function registerAffectedReadCommand(deps: ReadCommandDeps): void {
  registerAffectedFeatureCommand({
    ...deps,
    readStdin: () => fs.readFileSync(0, 'utf-8'),
    packageDeps: {
      detectPackageManager,
      readPackageScripts,
      packageScriptCommand,
    },
    writeLine: out,
    style: {
      bold: chalk.bold,
      cyan: chalk.cyan,
      dim: chalk.dim,
      yellow: chalk.yellow,
    },
  });
}

registerAtRangeReadCommand(defaultReadCommandDeps);

/**
 * cartograph ask <question> [path]
 *
 * Natural-language Q&A over the indexed codebase. Hybrid-retrieves
 * relevant symbols via FTS+semantic, then asks the configured chat
 * model. Requires LLM (config.llm).
 *
 * CLI/MCP alignment exception (B11): direct implementation so the
 * LLM response can be streamed to stdout token-by-token. The MCP
 * version returns the completed answer in one block — fine for the
 * agent surface, less helpful for an interactive human shell.
 */
program
  .command('ask')
  .description(
    `Ask a natural-language question about the codebase (requires LLM). The question is capped at 4096 characters.`,
  )
  .argument('<question>', 'Natural-language question about the codebase (capped at 4096 characters).')
  .argument('[path]', 'Path to a project with .cartograph/ (default: current directory). Equivalent to --project-path.')
  .option('-p, --project-path <path>', 'Project path (alias of the [path] positional)')
  .option(
    '-k, --retrieve-k <n>',
    `Number of candidates to feed the model (default ${RETRIEVE_K_DEFAULT}, range ${RETRIEVE_K_MIN}-${RETRIEVE_K_MAX})`,
  )
  .option('-q, --quiet', 'Print only the answer (no sources block)')
  .action(
    async (
      question: string,
      pathArg: string | undefined,
      options: { projectPath?: string; retrieveK?: string; quiet?: boolean },
    ) => {
      // Mirror the MCP `cartograph_ask` input validation (validateString):
      // reject an empty / whitespace-only question and cap the length at
      // 4096 chars, so the CLI fails fast with a clean message instead of
      // forwarding junk to the LLM.
      if (!validateAskQuestion(question)) return;
      // `-p, --project-path` is an alias of the [path] positional so `ask`
      // matches the `local-chat` / `summaries` project-path convention.
      // The explicit flag wins on conflict.
      const projectPath = resolveProjectPath(options.projectPath ?? pathArg);
      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.open(projectPath);
        const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
        const { getChatModel, getAskModel } = await import('../../llm/provider.js');
        const chatModel = getChatModel(llmConfig);
        if (!chatModel) {
          error('No LLM available. Configure config.llm.summarizeLlm in .cartograph/config.json.');
          cg.close();
          process.exit(1);
        }
        // Prefer the ask model id for the trailer — that's what actually
        // generated this answer. Falls back to chatModel when no ask
        // override is configured (single-provider setup).
        const askModel = getAskModel(llmConfig) ?? chatModel;
        // Route `--retrieve-k` through `assignIntArg` so an out-of-range
        // value is REJECTED with a clean message (matching every other
        // bounded numeric flag) rather than silently clamped. `cg` is
        // already open here, so destroy it before returning on a bad arg.
        const retrieveK = parseRetrieveK(options.retrieveK);
        if (retrieveK === null) {
          cg.close();
          return;
        }
        const result = await cg.llm.ask(question, { retrieveK });
        out(result.answer);
        if (!options.quiet) {
          // Verified-citations block — mirror the MCP `cartograph_ask`
          // surface (friction #33). `groundCitations` resolves every
          // backtick-quoted identifier in the answer against the index;
          // `buildCitationReport` is the shared renderer so the CLI and
          // MCP citation sections cannot diverge.
          await printAskAnnotations(cg, result, askModel);
        }
        cg.close();
      } catch (err) {
        error(`Failed to answer: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

/**
 * cartograph status [path]
 *
 * CLI/MCP alignment: as of B14 the MCP `cartograph_status` tool mirrors
 * Pending Changes and the no-LLM hint. Remaining intentional
 * divergence is CLI-only: --json output, ANSI color formatting, and
 * the CLI-specific LLM status formatting that MCP doesn't replicate.
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .option(
    '--verbose',
    'One-call onboarding view — enable all three composite rollups at sensible defaults (--top-hotspots 5, --top-biomarkers 5, --summary-breakdown). Mirrors cartograph_status `verbose`.',
  )
  .option(
    '--top-hotspots <n>',
    `Inline the top-N hotspots (risk = centrality × churn). Default 0 (suppressed). Negative / non-numeric → suppressed; values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}. Mirrors cartograph_status \`topHotspots\`.`,
  )
  .option(
    '--top-biomarkers <n>',
    `Inline the top-N biomarker findings (warning+ severity, worst-first). Default 0 (suppressed). Negative / non-numeric → suppressed; values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}. Mirrors cartograph_status \`topBiomarkers\`.`,
  )
  .option(
    '--summary-breakdown',
    'Expand the Summaries readiness line into per-phase counts (structural / neighbor-prop / llm + body-floor skips). Mirrors cartograph_status `summaryBreakdown`.',
  )
  .action(
    async (
      pathArg: string | undefined,
      options: {
        json?: boolean;
        verbose?: boolean;
        topHotspots?: string;
        topBiomarkers?: string;
        summaryBreakdown?: boolean;
      },
    ) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          printUninitializedStatus(projectPath, options);
          return;
        }

        const rollups = await buildStatusRollupConfig(options);
        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.open(projectPath);
        const stats = cg.stats.getStats();
        const { changes, healOnly, realModifiedCount } = await loadStatusChangeInfo(cg);
        const hnswAvailable = await (await import('../../embeddings/hnsw-index.js')).isHnswAvailable();

        if (options.json) {
          printStatusJson({ cg, projectPath, stats, changes, healOnly, realModifiedCount, hnswAvailable, rollups });
          cg.close();
          return;
        }

        out(chalk.bold('\nCartograph Status\n'));
        out(`${chalk.cyan('Project:')} ${projectPath}`);
        out();
        printStatusIndexStats(stats, cg, hnswAvailable);
        printCountBreakdown('Nodes by Kind:', stats.nodesByKind);
        printCountBreakdown('Files by Language:', stats.filesByLanguage);
        await printParseCacheStatus(cg);
        printPendingChanges(changes, realModifiedCount, healOnly);
        await printLlmStatus(cg, projectPath);
        printStatusRollups(cg, rollups);

        cg.close();
      } catch (err) {
        error(`Failed to get status: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

registerFindCommand(defaultReadCommandDeps);

/**
 * cartograph digest [path]
 */
function registerDigestCommand(deps: ReadCommandDeps): void {
  const { program, runViaMCP } = deps;
  program
    .command('digest')
    .description(
      '"Land in a new repo" overview — hotspots, code health, entry points, recent churn, suggested next queries (mirrors cartograph_digest MCP tool)',
    )
    .option('-p, --project-path <path>', 'Project path')
    .action(async (options: { projectPath?: string }) => {
      await runViaMCP('cartograph_digest', {}, options.projectPath);
    });
}

registerDigestCommand(defaultReadCommandDeps);

registerFilesReadCommand(defaultReadCommandDeps);

export function registerReadCommands(deps: ReadCommandDeps = defaultReadCommandDeps): void {
  registerAtRangeReadCommand(deps);
  registerFindCommand(deps);
  registerDigestCommand(deps);
  registerFilesReadCommand(deps);
  registerAffectedReadCommand(deps);
}

registerAffectedReadCommand(defaultReadCommandDeps);

export const __readCommandInternals = {
  validateAskQuestion,
  parseRetrieveK,
  printUninitializedStatus,
  buildStatusRollupConfig,
  printStatusJson,
  printStatusIndexStats,
  printCountBreakdown,
  printParseCacheStatus,
  printPendingChanges,
  printLlmStatus,
  printSummaryCoverage,
  printStatusRollups,
  printStatusRollupLine,
  parseFieldsOption,
  isValidFindAxis,
};
