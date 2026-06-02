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
import { type AffectedCoreInput, DEFAULT_DEPTH, buildIndexedPathSets, findAffectedTests } from '../../affected-core.js';
import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MIN, RETRIEVE_K_MAX } from '../../mcp/tools/ask.js';
import { buildDirRollup, filterFilesByDir } from '../../mcp/tools/files.js';
import {
  type FileTreeNode,
  buildFileTree,
  compareFileTreeChildren,
  recurseFileTreeChildren as sharedRecurseFileTreeChildren,
} from '../../file-tree-render.js';
import { isInitialized } from '../../directory.js';
import { globToSafeRegex } from '../../utils.js';
import { errMsg } from '../../errors.js';
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

interface AtRangeOptions {
  projectPath?: string;
  limit?: string;
  diff?: string;
  ranges?: string;
  compact?: boolean;
  fields?: string;
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
  appendFeatureReadiness: (lines: string[], cg: any, options: { summaryBreakdown: boolean }) => void;
  appendInlineHotspots: (lines: string[], cg: any, topN: number) => void;
  appendInlineBiomarkers: (lines: string[], cg: any, topN: number) => void;
}

interface FindOptions {
  projectPath?: string;
  by?: string;
  query?: string;
  limit?: string;
  kind?: string;
  mode?: string;
  symbol?: string;
  sameLanguage?: boolean;
  differentLanguage?: boolean;
  languageFilter?: string;
  caseSensitive?: boolean;
  pathFilter?: string;
  language?: string;
  key?: string;
  op?: string;
  includeTests?: boolean;
  since?: string;
  allowStale?: boolean;
  compact?: boolean;
  fields?: string;
}

interface AffectedOptions {
  projectPath?: string;
  files?: string[];
  stdin?: boolean;
  depth?: string;
  filter?: string;
  includeTests?: boolean;
  json?: boolean;
  quiet?: boolean;
}

interface ChangedFilesResult {
  changedFiles: string[];
  derivedFromGit: boolean;
}

interface AffectedOutputArgs {
  changedFiles: string[];
  sortedTests: string[];
  totalDependents: number;
  barrelsReached: string[];
  derivedFromGit: boolean;
  options: AffectedOptions;
}

async function readDiffOption(diff: string): Promise<string> {
  if (diff === '-') {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      process.stdin.on('error', reject);
    });
  }
  if (diff.includes('\n') || diff.startsWith('@@') || diff.startsWith('diff --git')) {
    return diff;
  }
  if (fs.existsSync(diff)) return fs.readFileSync(diff, 'utf-8');
  warn(`--diff: "${diff}" is not an existing file — treating it as inline diff text.`);
  return diff;
}

function parseRangeSpecs(raw: string): Array<{ file: string; startLine: number; endLine: number }> {
  const ranges: Array<{ file: string; startLine: number; endLine: number }> = [];
  for (const spec of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(.+):(\d+)-(\d+)$/.exec(spec);
    if (!m) {
      error(`Invalid --ranges spec '${spec}' — expected 'file:startLine-endLine'.`);
      process.exit(1);
    }
    ranges.push({ file: m[1]!, startLine: Number.parseInt(m[2]!, 10), endLine: Number.parseInt(m[3]!, 10) });
  }
  if (ranges.length === 0) {
    error('--ranges had no valid `file:startLine-endLine` specs.');
    process.exit(1);
  }
  return ranges;
}

async function buildAtRangeArgs(
  file: string | undefined,
  startLine: string | undefined,
  endLine: string | undefined,
  options: AtRangeOptions,
): Promise<Record<string, unknown> | null> {
  const args: Record<string, unknown> = {};
  if (!assignIntArg({ args, key: 'limit', raw: options.limit ?? '20', optionName: '--limit', opts: { min: 1 } }))
    return null;
  if (options.compact) args['compact'] = true;
  if (options.fields) {
    args['fields'] = options.fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  const modeFlags = [options.diff !== undefined, options.ranges !== undefined].filter(Boolean).length;
  if (modeFlags > 1) {
    error('--diff and --ranges are mutually exclusive.');
    process.exit(1);
  }
  if (options.diff !== undefined) {
    if (file !== undefined || startLine !== undefined || endLine !== undefined) {
      error('--diff is mutually exclusive with positional file/startLine/endLine.');
      process.exit(1);
    }
    args['diff'] = await readDiffOption(options.diff);
    return args;
  }
  if (options.ranges !== undefined) {
    if (file !== undefined || startLine !== undefined || endLine !== undefined) {
      error('--ranges is mutually exclusive with positional file/startLine/endLine.');
      process.exit(1);
    }
    args['ranges'] = parseRangeSpecs(options.ranges);
    return args;
  }
  if (file === undefined || startLine === undefined || endLine === undefined) {
    error('Pass <file> <startLine> <endLine> positionally OR use --diff <pathOrText|-> OR --ranges <list>.');
    process.exit(1);
  }
  const startNum = Number.parseInt(startLine, 10);
  const endNum = Number.parseInt(endLine, 10);
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
    error('startLine and endLine must be numbers.');
    process.exitCode = 1;
    return null;
  }
  args['file'] = file;
  args['startLine'] = startNum;
  args['endLine'] = endNum;
  return args;
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
    console.log(line ? chalk.dim(line) : '');
  }
  console.log('\n' + chalk.dim('Retrieval sources:'));
  for (const c of result.citations) {
    const loc = c.node.startLine ? `:${c.node.startLine}` : '';
    console.log(chalk.dim(`  • ${c.node.name} (${c.node.kind}) ${c.node.filePath}${loc}`));
  }
  console.log(
    chalk.dim(
      `\n  retrieve ${result.retrieveMs}ms · chat ${result.chatMs}ms · model ${displayModelName(askModel)} · ${report.counter}`,
    ),
  );
}

async function buildStatusRollupConfig(options: StatusOptions): Promise<StatusRollupConfig> {
  const { appendFeatureReadiness, appendInlineBiomarkers, appendInlineHotspots, parseInlineTopN } = await import(
    '../../mcp/tools/status.js'
  );
  const verbose = options.verbose === true;
  const rawTopHotspots = parseInlineTopN(options.topHotspots);
  const rawTopBiomarkers = parseInlineTopN(options.topBiomarkers);
  return {
    topHotspots: verbose && rawTopHotspots === 0 ? 5 : rawTopHotspots,
    topBiomarkers: verbose && rawTopBiomarkers === 0 ? 5 : rawTopBiomarkers,
    summaryBreakdown: options.summaryBreakdown === true || verbose,
    appendFeatureReadiness,
    appendInlineHotspots,
    appendInlineBiomarkers,
  };
}

function printUninitializedStatus(projectPath: string, options: StatusOptions): void {
  if (options.json) {
    console.log(JSON.stringify({ initialized: false, projectPath }));
    return;
  }
  console.log(chalk.bold('\nCartograph Status\n'));
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
  args.rollups.appendFeatureReadiness(jsonRollups, args.cg, { summaryBreakdown: args.rollups.summaryBreakdown });
  args.rollups.appendInlineHotspots(jsonRollups, args.cg, args.rollups.topHotspots);
  args.rollups.appendInlineBiomarkers(jsonRollups, args.cg, args.rollups.topBiomarkers);
  console.log(
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
  console.log(chalk.bold('Index Statistics:'));
  console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
  console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
  console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
  console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  const vec = cg.db.hasVecExtension();
  const vecSuffix = vec ? ' + sqlite-vec' : '';
  const backendLabel = chalk.magenta(`bun:sqlite${vecSuffix}`);
  console.log(`  Backend:   ${backendLabel}`);
  if (!vec) {
    console.log(chalk.yellow('  ⚠ sqlite-vec did not load — vector search is on the slow in-memory brute-force path.'));
    console.log(chalk.dim('     sqlite-vec ships prebuilts for darwin/linux x64+arm64 and windows-x64.'));
  } else if (!hnswAvailable) {
    console.log(chalk.dim('  ℹ hnswlib-node not installed — similar_to edge builds use the vec0 brute-force path;'));
    console.log(chalk.dim('     `npm install hnswlib-node` adds the O(log N) accelerator for large repos.'));
  }
  console.log();
}

function printCountBreakdown(title: string, entries: Record<string, number>): void {
  console.log(chalk.bold(title));
  const sorted = Object.entries(entries)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sorted) {
    console.log(`  ${label.padEnd(15)} ${formatNumber(count)}`);
  }
  console.log();
}

async function printParseCacheStatus(cg: any): Promise<void> {
  try {
    const { getParseCacheStats } = await import('../../db/queries-parse-cache.js');
    const pc = getParseCacheStats(cg.queries);
    if (pc.rows === 0) return;
    const sizeMB = (pc.sizeBytes / 1024 / 1024).toFixed(1);
    const stale = pc.staleVersionRows > 0 ? chalk.yellow(`  (${pc.staleVersionRows} stale, will LRU out)`) : '';
    console.log(chalk.bold('Parse Cache:'));
    console.log(
      `  Replayable: ${formatNumber(pc.currentVersionRows)} entries (${sizeMB} MB) · schema _v${pc.currentVersion}${stale}`,
    );
    console.log();
  } catch {
    /* pre-migration-026 DB */
  }
}

function printPendingChanges(changes: any, realModifiedCount: number, healOnly: string[]): void {
  const totalChanges = changes.added.length + realModifiedCount + changes.removed.length + healOnly.length;
  if (totalChanges === 0) {
    success('Index is up to date');
    console.log();
    return;
  }
  console.log(chalk.bold('Pending Changes:'));
  if (changes.added.length > 0) console.log(`  Added:     ${changes.added.length} files`);
  if (realModifiedCount > 0) console.log(`  Modified:  ${realModifiedCount} files`);
  if (changes.removed.length > 0) console.log(`  Removed:   ${changes.removed.length} files`);
  if (healOnly.length > 0) {
    console.log(
      `  Heal-flagged (re-extract): ${healOnly.length} files ` +
        `(extraction-logic-version drift; no on-disk content change)`,
    );
  }
  info('Run "cartograph admin sync" to update the index');
  console.log();
}

async function printLlmStatus(cg: any, projectPath: string): Promise<void> {
  console.log(chalk.bold('LLM Enrichment:'));
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  if (!llmConfig) {
    console.log(
      '  No LLM configured. Run `cartograph admin install-models --write-config` for the recommended stack (llama-server HTTP — embed :8080 / chat :8081 / ask :8082 / reranker :8083), or set config.llm in .cartograph/config.json.',
    );
    console.log();
    return;
  }
  const { getAskModel, getChatModel, getEmbeddingModel, getDisplayEndpoint } = await import('../../llm/provider.js');
  const chatModel = getChatModel(llmConfig);
  const askModel = getAskModel(llmConfig);
  console.log(`  Endpoint:  ${getDisplayEndpoint(llmConfig)} (configured)`);
  console.log(`  Model:     ${chatModel ?? '(no summarize model)'}`);
  if (askModel && askModel !== chatModel) {
    const askProvider = llmConfig.askLlm?.provider;
    const askProviderSuffix = askProvider ? ` (${askProvider})` : '';
    console.log(`  Ask model: ${askModel}${askProviderSuffix}`);
  }
  const embedModel = getEmbeddingModel(llmConfig);
  if (embedModel) console.log(`  Embed:     ${embedModel}`);
  printSummaryCoverage(cg);
  const { getDetachedSummarizeState } = await import('../../llm/detached-summarize.js');
  const bg = getDetachedSummarizeState(projectPath);
  if (bg.running) {
    console.log(`  Summaries: background pass running (pid ${bg.pid}) — coverage is still climbing`);
  }
  console.log();
}

function printSummaryCoverage(cg: any): void {
  const cov = getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  if (cov.total === 0) return;
  const pct = Math.round((cov.summarised / cov.total) * 100);
  const weighted = getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  const weightedSuffix =
    weighted.weightedRatio === null ? '' : ` — centrality-weighted ${Math.round(weighted.weightedRatio * 100)}%`;
  console.log(`  Summaries: ${formatNumber(cov.summarised)}/${formatNumber(cov.total)} (${pct}%)${weightedSuffix}`);
}

function printStatusRollups(cg: any, rollups: StatusRollupConfig): void {
  const rollupLines: string[] = [];
  rollups.appendFeatureReadiness(rollupLines, cg, { summaryBreakdown: rollups.summaryBreakdown });
  rollups.appendInlineHotspots(rollupLines, cg, rollups.topHotspots);
  rollups.appendInlineBiomarkers(rollupLines, cg, rollups.topBiomarkers);
  if (rollupLines.length === 0) return;
  for (const line of rollupLines) {
    printStatusRollupLine(line);
  }
  console.log();
}

function printStatusRollupLine(line: string): void {
  if (line === '') {
    console.log();
  } else if (line.startsWith('### ')) {
    console.log(chalk.bold(line.slice(4)));
  } else {
    console.log(line);
  }
}

function parseFieldsOption(fields: string | undefined): string[] | undefined {
  return fields
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

type McpRunner = typeof runViaMCP;

let readCommandMcpRunner: McpRunner = runViaMCP;

function setReadCommandMcpRunnerForTest(runner: McpRunner): () => void {
  const previous = readCommandMcpRunner;
  readCommandMcpRunner = runner;
  return () => {
    readCommandMcpRunner = previous;
  };
}

async function runFindCommand(queryArg: string | undefined, options: FindOptions): Promise<void> {
  const query = queryArg === undefined && typeof options.query === 'string' ? options.query : queryArg;
  const by = options.by ?? 'name';
  if (!isValidFindAxis(by)) {
    error(`--by: must be 'name' | 'content' | 'env' | 'sql'; got '${by}'.`);
    process.exit(1);
  }
  if (by === 'content') return runFindContent(query, options);
  if (by === 'env' || by === 'sql') return runFindEnvOrSql(by, options);
  return runFindByName(query, options);
}

function isValidFindAxis(by: string): by is 'name' | 'content' | 'env' | 'sql' {
  return by === 'name' || by === 'content' || by === 'env' || by === 'sql';
}

async function runFindContent(query: string | undefined, options: FindOptions): Promise<void> {
  if (!query) {
    error('--by content: [query] is required (regex pattern).');
    process.exit(1);
  }
  const args: Record<string, unknown> = { by: 'content', query };
  if (!assignIntArg({ args, key: 'limit', raw: options.limit ?? '50', optionName: '--limit', opts: { min: 1 } }))
    return;
  if (options.caseSensitive) args['caseSensitive'] = true;
  if (options.pathFilter) args['pathFilter'] = options.pathFilter;
  if (options.language) args['language'] = options.language;
  if (options.since) args['since'] = options.since;
  if (options.allowStale) args['allowStale'] = true;
  await readCommandMcpRunner('cartograph_find', args, options.projectPath);
}

async function runFindEnvOrSql(by: 'env' | 'sql', options: FindOptions): Promise<void> {
  const args: Record<string, unknown> = { by };
  if (!assignIntArg({ args, key: 'limit', raw: options.limit ?? '30', optionName: '--limit', opts: { min: 1 } }))
    return;
  if (options.key) args['key'] = options.key;
  if (options.op) args['op'] = options.op;
  args['includeTests'] = options.includeTests;
  if (options.allowStale) args['allowStale'] = true;
  await readCommandMcpRunner('cartograph_find', args, options.projectPath);
}

async function runFindByName(query: string | undefined, options: FindOptions): Promise<void> {
  const mode = options.mode ?? 'exact';
  if (mode === 'fuzzy' || mode === 'semantic' || mode === 'intent') {
    return runFindDelegatedNameMode(mode, query, options);
  }
  if (mode !== 'exact') {
    error(`Unknown --mode: ${mode}. Valid: exact | fuzzy | semantic | intent.`);
    process.exit(1);
  }
  return runFindExactName(query, options);
}

async function runFindDelegatedNameMode(mode: string, query: string | undefined, options: FindOptions): Promise<void> {
  validateDelegatedNameMode(mode, query, options);
  const args: Record<string, unknown> = { by: 'name', mode };
  if (!assignIntArg({ args, key: 'limit', raw: options.limit ?? '10', optionName: '--limit', opts: { min: 1 } }))
    return;
  if (query) args['query'] = query;
  if (options.symbol) args['symbol'] = options.symbol;
  if (options.kind) args['kind'] = options.kind;
  if (options.sameLanguage) args['sameLanguage'] = true;
  if (options.differentLanguage) args['differentLanguage'] = true;
  if (options.languageFilter) args['languageFilter'] = options.languageFilter;
  if (options.pathFilter) args['pathFilter'] = options.pathFilter;
  if (options.allowStale) args['allowStale'] = true;
  await readCommandMcpRunner('cartograph_find', args, options.projectPath);
}

function validateDelegatedNameMode(mode: string, query: string | undefined, options: FindOptions): void {
  if (mode === 'semantic') {
    validateSemanticFind(query, options);
    return;
  }
  if (!query) {
    error(`--by name --mode ${mode}: [query] is required`);
    process.exit(1);
  }
}

function validateSemanticFind(query: string | undefined, options: FindOptions): void {
  if (!options.symbol && !query) {
    error('--by name --mode semantic: pass either [query] (concept text) or --symbol <name>');
    process.exit(1);
  }
  if (options.symbol && query) {
    error('--by name --mode semantic: [query] and --symbol are mutually exclusive — pick one');
    process.exit(1);
  }
  if (options.sameLanguage && options.differentLanguage) {
    error('--by name --mode semantic: --same-language and --different-language are mutually exclusive — pick one');
    process.exit(1);
  }
}

async function runFindExactName(query: string | undefined, options: FindOptions): Promise<void> {
  if (!query) {
    error('[query] is required for --by name --mode exact');
    process.exit(1);
  }
  const exactArgs: Record<string, unknown> = { by: 'name', mode: 'exact', query };
  if (
    !assignIntArg({
      args: exactArgs,
      key: 'limit',
      raw: options.limit ?? '10',
      optionName: '--limit',
      opts: { min: 1 },
    })
  )
    return;
  if (options.kind) exactArgs['kind'] = options.kind;
  if (options.compact) exactArgs['compact'] = true;
  const fields = parseFieldsOption(options.fields);
  if (fields) exactArgs['fields'] = fields;
  if (options.since) exactArgs['since'] = options.since;
  if (options.allowStale) exactArgs['allowStale'] = true;
  await readCommandMcpRunner('cartograph_find', exactArgs, options.projectPath);
}

async function collectAffectedChangedFiles(
  fileArgs: string[],
  options: AffectedOptions,
  projectPath: string,
): Promise<ChangedFilesResult | null> {
  const changedFiles = [...(fileArgs || []), ...(options.files ?? [])];
  if (options.stdin) changedFiles.push(...readFilesFromStdin());
  if (changedFiles.length > 0 || options.stdin) return { changedFiles, derivedFromGit: false };
  return deriveChangedFilesFromGit(projectPath, options);
}

function readFilesFromStdin(): string[] {
  return fs
    .readFileSync(0, 'utf-8')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

async function deriveChangedFilesFromGit(
  projectPath: string,
  options: AffectedOptions,
): Promise<ChangedFilesResult | null> {
  const { listChangedFilesSince } = await import('../../git-utils.js');
  const derived = listChangedFilesSince(projectPath, 'HEAD');
  if (derived === null) {
    if (!options.quiet) {
      info('No files provided and could not derive from git (git unavailable or no HEAD ref).');
      info('Use file arguments or --stdin.');
    }
    process.exit(0);
  }
  if (derived.length === 0) {
    printNoDerivedChanges(options);
    process.exit(0);
  }
  return { changedFiles: derived, derivedFromGit: true };
}

function printNoDerivedChanges(options: AffectedOptions): void {
  if (options.json) {
    console.log(JSON.stringify({ changedFiles: [], affectedTests: [], totalDependentsTraversed: 0 }, null, 2));
  } else if (!options.quiet) {
    info('No uncommitted changes — nothing to re-test.');
  }
}

function parseAffectedDepth(options: AffectedOptions, cg: any): number | null {
  const maxDepth = Number.parseInt(options.depth || String(DEFAULT_DEPTH), 10);
  if (!Number.isFinite(maxDepth)) {
    error(`Invalid value for --depth: "${options.depth}" is not a number`);
    cg.close();
    process.exitCode = 1;
    return null;
  }
  if (maxDepth < 1) {
    error('Invalid value for --depth: must be >= 1');
    cg.close();
    process.exitCode = 1;
    return null;
  }
  return maxDepth;
}

function buildAffectedFilter(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  const regexBody = globToSafeRegex(pattern);
  return regexBody === null ? null : new RegExp(regexBody);
}

function validateAffectedIndexedPaths(args: {
  changedFiles: string[];
  derivedFromGit: boolean;
  coreInput: AffectedCoreInput;
  cg: any;
  quiet?: boolean;
}): void {
  if (args.derivedFromGit) return;
  const missing = args.changedFiles.filter((f) => !args.coreInput.allIndexedPaths.has(f));
  if (missing.length === args.changedFiles.length) {
    error(
      `None of the ${args.changedFiles.length} input file${args.changedFiles.length === 1 ? '' : 's'} match indexed paths: ${missing.join(', ')}`,
    );
    args.cg.close();
    process.exit(1);
  }
  if (missing.length > 0 && !args.quiet) {
    info(
      `${missing.length} input path${missing.length === 1 ? '' : 's'} not in the index (skipped): ${missing.join(', ')}`,
    );
  }
}

function printAffectedOutput(args: AffectedOutputArgs): void {
  if (args.options.json) {
    printAffectedJson(args);
  } else if (args.options.quiet) {
    for (const t of args.sortedTests) console.log(t);
  } else {
    printAffectedHuman(args);
  }
}

function printAffectedJson(args: AffectedOutputArgs): void {
  console.log(
    JSON.stringify(
      {
        changedFiles: args.changedFiles,
        affectedTests: args.sortedTests,
        totalDependentsTraversed: args.totalDependents,
        barrelsReached: args.barrelsReached,
        derivedFromGit: args.derivedFromGit,
      },
      null,
      2,
    ),
  );
}

function printAffectedHuman(args: AffectedOutputArgs): void {
  if (args.derivedFromGit) printDerivedChangedFiles(args.changedFiles);
  printAffectedTestList(args.sortedTests);
  console.log(chalk.dim(`Traversed ${args.totalDependents} dependent${args.totalDependents === 1 ? '' : 's'} total.`));
  printBarrelWarning(args.barrelsReached);
}

function printDerivedChangedFiles(changedFiles: string[]): void {
  console.log(
    chalk.dim(
      `\nChanged set derived from \`git diff HEAD\` (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}):`,
    ),
  );
  for (const f of changedFiles) console.log(chalk.dim('  ' + f));
}

function printAffectedTestList(sortedTests: string[]): void {
  const AFFECTED_ROW_LIMIT = 40;
  if (sortedTests.length === 0) {
    info('No test files affected by the changed files.');
    return;
  }
  const shown = sortedTests.slice(0, AFFECTED_ROW_LIMIT);
  console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
  for (const t of shown) console.log('  ' + chalk.cyan(t));
  if (sortedTests.length > AFFECTED_ROW_LIMIT) {
    console.log(
      chalk.dim(
        `\n  … showing first ${shown.length} of ${sortedTests.length} (sorted). Pass --filter <glob> or narrow the input set to see fewer.`,
      ),
    );
  }
  console.log();
}

function printBarrelWarning(barrelsReached: string[]): void {
  if (barrelsReached.length === 0) return;
  const barrelList = barrelsReached.map((b) => `\`${b}\``).join(', ');
  console.log();
  console.log(
    chalk.yellow(
      `⚠ Traversal reached the public-API barrel (${barrelList}) — the blast radius is most of the suite. ` +
        `Narrow with \`cartograph tests-for\` for symbol-level test discovery.`,
    ),
  );
}

type FileListing = ReturnType<typeof getAllFilesWithSymbolCount>;
type FileListFormat = 'tree' | 'flat' | 'grouped' | 'summary';

function parseFilesOutputOptions(
  options: { format?: string; maxDepth?: string },
  close: () => void,
): { format: FileListFormat; maxDepth: number | undefined } | null {
  const format = (options.format || 'tree') as FileListFormat;
  const validFormats: FileListFormat[] = ['tree', 'flat', 'grouped', 'summary'];
  if (!validFormats.includes(format)) {
    error(`Invalid value for --format: "${format}" — valid values: ${validFormats.join(', ')}`);
    close();
    process.exitCode = 1;
    return null;
  }
  if (!options.maxDepth) return { format, maxDepth: undefined };
  const maxDepth = Number.parseInt(options.maxDepth, 10);
  if (!Number.isFinite(maxDepth)) {
    error(`Invalid value for --max-depth: "${options.maxDepth}" is not a number`);
    close();
    process.exitCode = 1;
    return null;
  }
  if (maxDepth < 1) {
    error('Invalid value for --max-depth: must be >= 1');
    close();
    process.exitCode = 1;
    return null;
  }
  return { format, maxDepth };
}

function printFilesOutput(
  files: FileListing,
  format: FileListFormat,
  includeMetadata: boolean,
  maxDepth: number | undefined,
  dir: string | undefined,
  queries: Parameters<typeof getFileSummaries>[0],
): void {
  switch (format) {
    case 'flat':
      printFlatFiles(files, includeMetadata, queries);
      break;
    case 'grouped':
      printGroupedFiles(files, includeMetadata);
      break;
    case 'summary':
      printFileSummary(files, maxDepth, dir);
      break;
    default:
      console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
      printFileTree({ files, includeMetadata, maxDepth, chalk });
      break;
  }
}

function printFlatFiles(files: FileListing, includeMetadata: boolean, queries: Parameters<typeof getFileSummaries>[0]): void {
  console.log(chalk.bold(`\nFiles (${files.length}):\n`));
  const flatSummaries =
    files.length <= 80
      ? getFileSummaries(
          queries,
          files.map((f) => f.path),
        )
      : undefined;
  const sortedFiles = [...files];
  sortedFiles.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) {
    if (includeMetadata) {
      const metadata = chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`);
      console.log(`  ${file.path} ${metadata}`);
    } else {
      console.log(`  ${file.path}`);
    }
    const summary = flatSummaries?.get(file.path);
    if (summary) console.log(`    ${chalk.dim(summary)}`);
  }
}

function printGroupedFiles(files: FileListing, includeMetadata: boolean): void {
  console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
  const byLang = new Map<string, FileListing>();
  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }
  const sortedLangs = [...byLang.entries()];
  sortedLangs.sort((a, b) => b[1].length - a[1].length);
  for (const [lang, langFiles] of sortedLangs) {
    console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
    const sortedLangFiles = [...langFiles];
    sortedLangFiles.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedLangFiles) {
      if (includeMetadata) {
        const metadata = chalk.dim(`(${file.nodeCount} symbols)`);
        console.log(`  ${file.path} ${metadata}`);
      } else {
        console.log(`  ${file.path}`);
      }
    }
    console.log();
  }
}

function printFileSummary(files: FileListing, maxDepth: number | undefined, dir: string | undefined): void {
  const rollup = buildDirRollup(files, maxDepth, dir);
  const filterPrefix = dir ? dir.replace(/\/+$/, '') : null;
  const header = filterPrefix
    ? `\nSubtree Summary — ${filterPrefix}/ (${rollup.totalFiles} files, ${rollup.totalSymbols} symbols):\n`
    : `\nProject Summary (${rollup.totalFiles} files, ${rollup.totalSymbols} symbols):\n`;
  console.log(chalk.bold(header));
  for (const row of rollup.rows) {
    const label = row.dir === null ? '(root)' : `${row.dir}/`;
    const filesText = chalk.dim(`${row.files} files`.padStart(10));
    const symbolsText = chalk.dim(`${row.symbols} symbols`.padStart(14));
    console.log(
      `  ${chalk.cyan(label.padEnd(40))} ${filesText} ${symbolsText}`,
    );
  }
}

/**
 * cartograph at-range <file> <startLine> <endLine>
 *
 * List indexed symbols whose line ranges overlap the given span.
 * O(log n) via the `nodes_rtree` R*Tree virtual table (mirrors
 * cartograph_at_range MCP tool). Useful for PR-review ("what symbols
 * does this diff hunk touch?") and diff-overlay workflows.
 */
program
  .command('at-range [file] [startLine] [endLine]')
  .description('List indexed symbols whose ranges overlap the given file:line span (R*Tree-backed, O(log n))')
  .option('-p, --project-path <path>', 'Path to the project (defaults to current directory)')
  .option('-l, --limit <n>', 'Maximum results (default 20)', '20')
  .option(
    '--diff <pathOrText>',
    "Unified diff to query — accepts a file path, '-' for stdin, or the diff TEXT itself (the MCP `diff` param takes the text; this flag accepts either). Server parses hunks and queries each. Mutually exclusive with the positional file/startLine/endLine and --ranges.",
  )
  .option(
    '--ranges <list>',
    "Bulk mode — comma-separated `file:startLine-endLine` specs (e.g. 'src/a.ts:10-20,src/b.ts:5-9'). Queries up to 100 ranges in one call. Mutually exclusive with the positional file/startLine/endLine and --diff.",
  )
  .option(
    '--compact',
    'Emit terse pipe-delimited rows instead of a markdown table (saves 50-70% output tokens on chained range queries)',
  )
  .option(
    '--fields <names>',
    '(--compact only) Comma-separated subset of fields to emit: name,kind,path,line,endLine,signature. Default: all six.',
  )
  .action(
    async (
      file: string | undefined,
      startLine: string | undefined,
      endLine: string | undefined,
      options: {
        projectPath?: string;
        limit?: string;
        diff?: string;
        ranges?: string;
        compact?: boolean;
        fields?: string;
      },
    ) => {
      const args = await buildAtRangeArgs(file, startLine, endLine, options);
      if (!args) return;
      await runViaMCP('cartograph_at_range', args, options.projectPath);
    },
  );

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
        console.log(result.answer);
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

        console.log(chalk.bold('\nCartograph Status\n'));
        console.log(chalk.cyan('Project:'), projectPath);
        console.log();
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

/**
 * cartograph find <query> — unified "find a thing" command.
 *
 * Mirrors `cartograph_find({by})` on the MCP side. Replaces the
 * pre-merge `cartograph search` / `cartograph grep` / `cartograph string-refs`
 * three-command family (2026-05-11). `by` is a flag (matches the
 * `cartograph graph --direction <d>` shape that landed earlier the same
 * day) so the CLI surface stays one command per MCP tool.
 *
 * `--by name --mode exact` (the default) keeps the chalk-coloured
 * relative-score rendering as a CLI-only direct path; every other
 * combination delegates straight to the MCP family handler.
 */
program
  .command('find [query]')
  .description(
    'Find a thing in the codebase — symbol by name (--by name), regex content (--by content), env-var reads (--by env), or SQL table refs (--by sql). Mirrors cartograph_find MCP tool.',
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('-b, --by <axis>', "Axis: 'name' (default) | 'content' | 'env' | 'sql'", 'name')
  // `--query <text>` aliases the `[query]` positional so the MCP
  // shape `cartograph find --by name --query X` parses (mirrors the
  // MCP arg name without changing the canonical positional form).
  // The positional wins on conflict; an empty positional + a passed
  // --query falls through to the existing query branches below.
  .option('--query <text>', 'Alias for the [query] positional (mirrors MCP arg name)')
  .option('-l, --limit <number>', 'Maximum results (default 10 for name, 50 for content, 30 for env/sql)')
  .option('-k, --kind <kind>', '(--by name) Filter by node kind (function, class, etc.)')
  .option('-m, --mode <m>', '(--by name) Search mode: exact (default) | fuzzy | semantic | intent', 'exact')
  .option(
    '-s, --symbol <name>',
    '(--by name --mode semantic) Source symbol name for peer lookup; mutually exclusive with [query]',
  )
  .option('--same-language', '(--by name --mode semantic + symbol) Restrict to same language as source')
  .option('--different-language', '(--by name --mode semantic + symbol) Restrict to a different language than source')
  .option(
    '--language-filter <lang>',
    '(--by name --mode semantic + query / --mode intent) Restrict results to one language',
  )
  .option('-c, --case-sensitive', '(--by content) Case-sensitive regex (default: insensitive)')
  .option('--path-filter <prefix>', '(--by content / --by name --mode intent) Restrict to files under this path prefix')
  .option('--language <lang>', '(--by content) Restrict to one language (typescript / python / …)')
  .option('--key <key>', '(--by env / --by sql) Specific env-var name or table name; omit for the top-N listing')
  .option('--op <op>', '(--by sql) Filter by op (read | write | ddl)')
  // Commander negation form: the destination key `includeTests` defaults
  // to `true` and `--no-include-tests` flips it to `false`. Matches the
  // codebase's other `--no-*` flags (--no-metadata, --no-dedupe-by-name,
  // --no-permissions). Closes handoff #3: previously only `--include-tests`
  // was registered (a plain boolean toggle that defaulted to `undefined`),
  // so users couldn't ask for the filter-out behavior the help text claimed.
  .option('--no-include-tests', '(--by env / --by sql) Hide test-only entries (default: keep them, ranked behind prod)')
  .option(
    '--since <call-id>',
    'Delta mode: pass a `c_xxxxxxxx` UID to return only NEW rows (--by name + --mode exact, or --by content)',
  )
  .option('--allow-stale', 'Bypass the freshness gate; query the cached index even when stale')
  .option('--compact', '(--by name --mode exact) Emit terse pipe-delimited rows (name|kind|path:line|sig:…|id:…)')
  .option(
    '--fields <fields>',
    '(--by name --mode exact, with --compact) Comma-separated subset of fields (name,kind,path,line,signature,id)',
  )
  .action(
    async (
      query: string | undefined,
      options: {
        projectPath?: string;
        by?: string;
        query?: string;
        limit?: string;
        kind?: string;
        mode?: string;
        symbol?: string;
        sameLanguage?: boolean;
        differentLanguage?: boolean;
        languageFilter?: string;
        caseSensitive?: boolean;
        pathFilter?: string;
        language?: string;
        key?: string;
        op?: string;
        includeTests?: boolean;
        since?: string;
        allowStale?: boolean;
        compact?: boolean;
        fields?: string;
      },
    ) => {
      await runFindCommand(query, options);
    },
  );

/**
 * cartograph digest [path]
 */
program
  .command('digest')
  .description(
    '"Land in a new repo" overview — hotspots, code health, entry points, recent churn, suggested next queries (mirrors cartograph_digest MCP tool)',
  )
  .option('-p, --project-path <path>', 'Project path')
  .action(async (options: { projectPath?: string }) => {
    await runViaMCP('cartograph_digest', {}, options.projectPath);
  });

/**
 * cartograph files [path]
 *
 * CLI/MCP alignment exception (B11): direct implementation rather
 * than runViaMCP shim because the CLI surface offers richer human-
 * UI features (--format=tree|flat|grouped, --dir / --pattern
 * filters, --json export, --no-metadata) that the agent-focused
 * MCP `cartograph_files` doesn't carry. The two surfaces share a
 * name but serve different audiences.
 */
program
  .command('files [dir]')
  .description('Show project file structure from the index')
  .option('-p, --project-path <path>', 'Project path')
  .option('--dir <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped, summary)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      dirArg: string | undefined,
      options: {
        projectPath?: string;
        dir?: string;
        pattern?: string;
        format?: string;
        maxDepth?: string;
        metadata?: boolean;
        json?: boolean;
      },
    ) => {
      // Positional `dir` is sugar for --dir; --dir wins on conflict so an
      // explicit flag still overrides a stray positional.
      if (dirArg && !options.dir) options.dir = dirArg;
      const projectPath = resolveProjectPath(options.projectPath);

      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.open(projectPath);
        // `nodeCount` corrected to a true symbol count by
        // getAllFilesWithSymbolCount (drops the file's own `kind='file'`
        // node) — the same shared correction the MCP `cartograph_files`
        // handler uses, so CLI and MCP counts can't drift.
        let files = getAllFilesWithSymbolCount(cg.queries);

        if (files.length === 0) {
          info('No files indexed. Run "cartograph admin index" first.');
          cg.close();
          return;
        }

        // Filter by directory — SEGMENT-boundary match (shared with
        // the MCP `cartograph_files`) so `--dir src/mcp/tools` does NOT
        // also capture the sibling file `src/mcp/tools.ts`.
        if (options.dir) {
          files = filterFilesByDir(files, options.dir);
        }

        // Filter by glob pattern. globToSafeRegex returns null only for a
        // pathologically long (>1024-char) glob — treat that as "matches
        // nothing" so the degenerate input can't fall through unfiltered.
        if (options.pattern) {
          const regexBody = globToSafeRegex(options.pattern);
          const regex = regexBody === null ? /(?!)/ : new RegExp(regexBody);
          files = files.filter((f) => regex.test(f.path));
        }

        if (files.length === 0) {
          info('No files found matching the criteria.');
          cg.close();
          return;
        }

        // JSON output
        if (options.json) {
          const output = files.map((f) => ({
            path: f.path,
            language: f.language,
            nodeCount: f.nodeCount,
            size: f.size,
          }));
          console.log(JSON.stringify(output, null, 2));
          cg.close();
          return;
        }

        const includeMetadata = options.metadata !== false;
        // Validate --format against the four documented values so an
        // unknown value errors cleanly instead of silently falling
        // through to the `tree` default in the switch below.
        const outputOptions = parseFilesOutputOptions(options, () => cg.close());
        if (!outputOptions) return;

        // Format output
        printFilesOutput(files, outputOptions.format, includeMetadata, outputOptions.maxDepth, options.dir, cg.queries);

        console.log();
        cg.close();
      } catch (err) {
        error(`Failed to list files: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

interface RenderCliTreeArgs {
  node: FileTreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  chalk: { dim: (s: string) => string; cyan: (s: string) => string };
}

type CliChalk = { dim: (s: string) => string; cyan: (s: string) => string };

function renderCliTreeNode(args: RenderCliTreeArgs): void {
  const { node, prefix, isLast, depth, includeMetadata, maxDepth, chalk } = args;
  const exceedsMaxDepth = maxDepth !== undefined && depth > maxDepth;
  if (exceedsMaxDepth) return;
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = isLast ? '    ' : '│   ';
  if (node.name) {
    let line = prefix + connector + node.name;
    if (node.file && includeMetadata) {
      line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
    }
    process.stdout.write(line + '\n');
  }
  const children = [...node.children.values()].sort(compareFileTreeChildren);
  sharedRecurseFileTreeChildren<FileTreeNode, CliChalk>(
    children,
    { prefix, childPrefix, depth, includeMetadata, maxDepth, parentName: node.name, extra: chalk },
    (child, cArgs, childIsLast) =>
      renderCliTreeNode({
        node: child,
        prefix: cArgs.prefix,
        isLast: childIsLast,
        depth: cArgs.depth,
        includeMetadata: cArgs.includeMetadata,
        maxDepth: cArgs.maxDepth,
        chalk: cArgs.extra,
      }),
  );
}

/**
 * Print files as a tree
 */
interface PrintFileTreeArgs {
  files: { path: string; language: string; nodeCount: number }[];
  includeMetadata: boolean;
  maxDepth: number | undefined;
  chalk: { dim: (s: string) => string; cyan: (s: string) => string };
}

function printFileTree(args: PrintFileTreeArgs): void {
  const { files, includeMetadata, maxDepth, chalk } = args;
  renderCliTreeNode({
    node: buildFileTree(files),
    prefix: '',
    isLast: true,
    depth: 0,
    includeMetadata,
    maxDepth,
    chalk,
  });
}

/**
 * cartograph affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   cartograph affected                        # auto: derive changed set from `git diff HEAD`
 *   git diff --name-only | cartograph affected --stdin
 *   cartograph affected src/lib/components/Editor.svelte src/routes/+page.svelte
 *
 * When neither file args nor --stdin are provided, the changed set
 * is derived from `git diff HEAD` (working tree vs HEAD, plus
 * untracked) — Friction-Y (2026-05-14). Clean tree exits with a
 * friendly hint, not an error.
 *
 * CLI/MCP alignment exception (B11): direct implementation rather
 * than runViaMCP shim because the CLI carries human/CI-specific
 * features (--stdin file-list piping, custom test-glob via
 * --filter, --quiet mode, --json export) that the MCP
 * `cartograph_affected` tool doesn't surface. Designed for `git
 * diff --name-only | cartograph affected --stdin` pipeline use.
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files (defaults to `git diff HEAD` when no files passed)')
  .option('-p, --project-path <path>', 'Project path')
  .option('--files <paths...>', 'Alias for positional file arguments — mirrors the MCP `files` param name')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', String(DEFAULT_DEPTH))
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option(
    '--include-tests',
    "Include test-file targets when walking the dependents graph (mirrors the MCP `includeTests` flag's surface; default off — affected reports only test files, and this surface keeps the canonical no-op behavior so a script can pass the flag uniformly across surfaces).",
  )
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(
    async (
      fileArgs: string[],
      options: {
        projectPath?: string;
        files?: string[];
        stdin?: boolean;
        depth?: string;
        filter?: string;
        includeTests?: boolean;
        json?: boolean;
        quiet?: boolean;
      },
    ) => {
      const projectPath = resolveProjectPath(options.projectPath);

      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const changed = await collectAffectedChangedFiles(fileArgs, options, projectPath);
        if (!changed) return;

        if (changed.changedFiles.length === 0) {
          if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
          process.exit(0);
        }

        const { default: Cartograph } = await loadCartograph();
        const cg = await Cartograph.open(projectPath);
        const maxDepth = parseAffectedDepth(options, cg);
        if (maxDepth === null) return;

        const coreInput: AffectedCoreInput = {
          files: changed.changedFiles,
          depth: maxDepth,
          customFilter: buildAffectedFilter(options.filter),
          ...buildIndexedPathSets(cg.queries),
        };
        validateAffectedIndexedPaths({
          changedFiles: changed.changedFiles,
          derivedFromGit: changed.derivedFromGit,
          coreInput,
          cg,
          quiet: options.quiet === true,
        });

        const { affectedTests, totalDependents, barrelsReached } = findAffectedTests(
          cg.internals.graphManager,
          coreInput,
        );
        const sortedTests = Array.from(affectedTests).sort((a, b) => a.localeCompare(b));

        printAffectedOutput({
          changedFiles: changed.changedFiles,
          sortedTests,
          totalDependents,
          barrelsReached,
          derivedFromGit: changed.derivedFromGit,
          options,
        });

        cg.close();
      } catch (err) {
        error(`Affected analysis failed: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

export const __readCommandInternals = {
  readDiffOption,
  parseRangeSpecs,
  buildAtRangeArgs,
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
  setReadCommandMcpRunnerForTest,
  runFindCommand,
  runFindContent,
  runFindEnvOrSql,
  runFindByName,
  runFindDelegatedNameMode,
  validateDelegatedNameMode,
  validateSemanticFind,
  runFindExactName,
  collectAffectedChangedFiles,
  readFilesFromStdin,
  deriveChangedFilesFromGit,
  printNoDerivedChanges,
  parseAffectedDepth,
  buildAffectedFilter,
  validateAffectedIndexedPaths,
  printAffectedOutput,
  printAffectedJson,
  printAffectedHuman,
  printDerivedChangedFiles,
  printAffectedTestList,
  printBarrelWarning,
  parseFilesOutputOptions,
  printFilesOutput,
  printGroupedFiles,
  printFileSummary,
  printFileTree,
};
