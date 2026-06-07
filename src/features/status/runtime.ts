import { classifyChangedFiles, realModifiedCount as computeRealModified } from '../../changed-files-classify.js';
import { getSummaryCoverage, getWeightedSummaryCoverage } from '../../db/queries-summaries.js';
import { SUMMARIZABLE_KINDS } from '../../llm/summarizer.js';

export const STATUS_MAX_INLINE_TOP_N = 30;

export interface StatusOptions {
  json?: boolean;
  verbose?: boolean;
  topHotspots?: string;
  topBiomarkers?: string;
  summaryBreakdown?: boolean;
}

export interface StatusRollupConfig {
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

interface StatusStyle {
  bold: (text: string) => string;
  cyan: (text: string) => string;
  dim: (text: string) => string;
  magenta: (text: string) => string;
  yellow: (text: string) => string;
}

export interface StatusPrinterDeps {
  writeLine: (message?: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  formatNumber: (value: number) => string;
  style: StatusStyle;
}

export interface StatusPrinter {
  printUninitializedStatus: (projectPath: string, options: StatusOptions) => void;
  printStatusJson: (args: PrintStatusJsonArgs) => void;
  printStatusHeader: (projectPath: string) => void;
  printStatusIndexStats: (stats: any, cg: any, hnswAvailable: boolean) => void;
  printCountBreakdown: (title: string, entries: Record<string, number>) => void;
  printParseCacheStatus: (cg: any) => Promise<void>;
  printPendingChanges: (changes: any, realModifiedCount: number, healOnly: string[]) => void;
  printLlmStatus: (cg: any, projectPath: string) => Promise<void>;
  printSummaryCoverage: (cg: any) => void;
  printStatusRollups: (cg: any, rollups: StatusRollupConfig) => void;
  printStatusRollupLine: (line: string) => void;
}

export interface PrintStatusJsonArgs {
  cg: any;
  projectPath: string;
  stats: any;
  changes: any;
  healOnly: string[];
  realModifiedCount: number;
  hnswAvailable: boolean;
  rollups: StatusRollupConfig;
}

export interface PrintStatusIndexStatsArgs {
  deps: StatusPrinterDeps;
  stats: any;
  cg: any;
  hnswAvailable: boolean;
}

export interface PrintPendingChangesArgs {
  deps: StatusPrinterDeps;
  changes: any;
  realModifiedCount: number;
  healOnly: string[];
}

export async function buildStatusRollupConfig(options: StatusOptions): Promise<StatusRollupConfig> {
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

export async function loadStatusChangeInfo(
  cg: any,
): Promise<{ changes: any; healOnly: string[]; realModifiedCount: number }> {
  const changes = classifyChangedFiles(cg);
  if (!changes) throw new Error('Failed to read changed files from the index');
  return { changes, healOnly: changes.healOnly, realModifiedCount: computeRealModified(changes) };
}

export function createStatusPrinter(deps: StatusPrinterDeps): StatusPrinter {
  return {
    printUninitializedStatus: (projectPath, options) => printUninitializedStatus(deps, projectPath, options),
    printStatusJson: (args) => printStatusJson(deps, args),
    printStatusHeader: (projectPath) => printStatusHeader(deps, projectPath),
    printStatusIndexStats: (stats, cg, hnswAvailable) => printStatusIndexStats({ deps, stats, cg, hnswAvailable }),
    printCountBreakdown: (title, entries) => printCountBreakdown(deps, title, entries),
    printParseCacheStatus: (cg) => printParseCacheStatus(deps, cg),
    printPendingChanges: (changes, realModifiedCount, healOnly) =>
      printPendingChanges({ deps, changes, realModifiedCount, healOnly }),
    printLlmStatus: (cg, projectPath) => printLlmStatus(deps, cg, projectPath),
    printSummaryCoverage: (cg) => printSummaryCoverage(deps, cg),
    printStatusRollups: (cg, rollups) => printStatusRollups(deps, cg, rollups),
    printStatusRollupLine: (line) => printStatusRollupLine(deps, line),
  };
}

export function printUninitializedStatus(deps: StatusPrinterDeps, projectPath: string, options: StatusOptions): void {
  if (options.json) {
    writeStatusLine(deps, JSON.stringify({ initialized: false, projectPath }));
    return;
  }
  writeStatusLine(deps, deps.style.bold('\nCartograph Status\n'));
  deps.info(`Project: ${projectPath}`);
  deps.warn('Not initialized');
  deps.info('Run "cartograph admin init" to initialize');
}

export function printStatusJson(deps: StatusPrinterDeps, args: PrintStatusJsonArgs): void {
  const jsonRollups: string[] = [];
  args.rollups.appendFeatureReadiness(jsonRollups, args.cg, {
    summaryBreakdown: args.rollups.summaryBreakdown,
    surface: 'cli',
  });
  args.rollups.appendInlineHotspots(jsonRollups, args.cg, args.rollups.topHotspots);
  args.rollups.appendInlineBiomarkers(jsonRollups, args.cg, args.rollups.topBiomarkers);
  writeStatusLine(
    deps,
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
      rollups: jsonRollups.filter((line) => line !== ''),
    }),
  );
}

export function printStatusHeader(deps: StatusPrinterDeps, projectPath: string): void {
  writeStatusLine(deps, deps.style.bold('\nCartograph Status\n'));
  writeStatusLine(deps, `${deps.style.cyan('Project:')} ${projectPath}`);
  writeStatusLine(deps);
}

export function printStatusIndexStats({ deps, stats, cg, hnswAvailable }: PrintStatusIndexStatsArgs): void {
  writeStatusLine(deps, deps.style.bold('Index Statistics:'));
  writeStatusLine(deps, `  Files:     ${deps.formatNumber(stats.fileCount)}`);
  writeStatusLine(deps, `  Nodes:     ${deps.formatNumber(stats.nodeCount)}`);
  writeStatusLine(deps, `  Edges:     ${deps.formatNumber(stats.edgeCount)}`);
  writeStatusLine(deps, `  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  const vec = cg.db.hasVecExtension();
  const vecSuffix = vec ? ' + sqlite-vec' : '';
  const backendLabel = deps.style.magenta(`bun:sqlite${vecSuffix}`);
  writeStatusLine(deps, `  Backend:   ${backendLabel}`);
  if (!vec) {
    writeStatusLine(
      deps,
      deps.style.yellow('  ⚠ sqlite-vec did not load — vector search is on the slow in-memory brute-force path.'),
    );
    writeStatusLine(
      deps,
      deps.style.dim('     sqlite-vec ships prebuilts for darwin/linux x64+arm64 and windows-x64.'),
    );
  } else if (!hnswAvailable) {
    writeStatusLine(
      deps,
      deps.style.dim('  ℹ USearch unavailable — similar_to edge builds use the vec0 brute-force path;'),
    );
    writeStatusLine(
      deps,
      deps.style.dim('     `bun install` re-fetches the optional `usearch` accelerator for large repos.'),
    );
  }
  writeStatusLine(deps);
}

export function printCountBreakdown(deps: StatusPrinterDeps, title: string, entries: Record<string, number>): void {
  writeStatusLine(deps, deps.style.bold(title));
  const sorted = Object.entries(entries)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sorted) {
    writeStatusLine(deps, `  ${label.padEnd(15)} ${deps.formatNumber(count)}`);
  }
  writeStatusLine(deps);
}

export async function printParseCacheStatus(deps: StatusPrinterDeps, cg: any): Promise<void> {
  try {
    const { getParseCacheStats } = await import('../../db/queries-parse-cache.js');
    const pc = getParseCacheStats(cg.queries);
    if (pc.rows === 0) return;
    const sizeMB = (pc.sizeBytes / 1024 / 1024).toFixed(1);
    const stale = pc.staleVersionRows > 0 ? deps.style.yellow(`  (${pc.staleVersionRows} stale, will LRU out)`) : '';
    writeStatusLine(deps, deps.style.bold('Parse Cache:'));
    writeStatusLine(
      deps,
      `  Replayable: ${deps.formatNumber(pc.currentVersionRows)} entries (${sizeMB} MB) · schema _v${
        pc.currentVersion
      }${stale}`,
    );
    writeStatusLine(deps);
  } catch {
    /* pre-migration-026 DB */
  }
}

export function printPendingChanges({ deps, changes, realModifiedCount, healOnly }: PrintPendingChangesArgs): void {
  const totalChanges = changes.added.length + realModifiedCount + changes.removed.length + healOnly.length;
  if (totalChanges === 0) {
    deps.success('Index is up to date');
    writeStatusLine(deps);
    return;
  }
  writeStatusLine(deps, deps.style.bold('Pending Changes:'));
  if (changes.added.length > 0) writeStatusLine(deps, `  Added:     ${changes.added.length} files`);
  if (realModifiedCount > 0) writeStatusLine(deps, `  Modified:  ${realModifiedCount} files`);
  if (changes.removed.length > 0) writeStatusLine(deps, `  Removed:   ${changes.removed.length} files`);
  if (healOnly.length > 0) {
    writeStatusLine(
      deps,
      `  Heal-flagged (re-extract): ${healOnly.length} files ` +
        `(extraction-logic-version drift; no on-disk content change)`,
    );
  }
  deps.info('Run "cartograph admin sync" to update the index');
  writeStatusLine(deps);
}

export async function printLlmStatus(deps: StatusPrinterDeps, cg: any, projectPath: string): Promise<void> {
  writeStatusLine(deps, deps.style.bold('LLM Enrichment:'));
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  if (!llmConfig) {
    writeStatusLine(
      deps,
      '  No LLM configured. Run `cartograph admin install-models --write-config` for the recommended stack (llama-server HTTP — embed :8080 / chat :8081 / ask :8082 / reranker :8083), or set config.llm in .cartograph/config.json.',
    );
    writeStatusLine(deps);
    return;
  }
  const { getAskModel, getChatModel, getEmbeddingModel, getDisplayEndpoint } = await import('../../llm/provider.js');
  const chatModel = getChatModel(llmConfig);
  const askModel = getAskModel(llmConfig);
  writeStatusLine(deps, `  Endpoint:  ${getDisplayEndpoint(llmConfig)} (configured)`);
  writeStatusLine(deps, `  Model:     ${chatModel ?? '(no summarize model)'}`);
  if (askModel && askModel !== chatModel) {
    const askProvider = llmConfig.askLlm?.provider;
    const askProviderSuffix = askProvider ? ` (${askProvider})` : '';
    writeStatusLine(deps, `  Ask model: ${askModel}${askProviderSuffix}`);
  }
  const embedModel = getEmbeddingModel(llmConfig);
  if (embedModel) writeStatusLine(deps, `  Embed:     ${embedModel}`);
  printSummaryCoverage(deps, cg);
  const { getDetachedSummarizeState } = await import('../../llm/detached-summarize.js');
  const bg = getDetachedSummarizeState(projectPath);
  if (bg.running) {
    writeStatusLine(deps, `  Summaries: background pass running (pid ${bg.pid}) — coverage is still climbing`);
  }
  writeStatusLine(deps);
}

export function printSummaryCoverage(deps: StatusPrinterDeps, cg: any): void {
  const cov = getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  if (cov.total === 0) return;
  const pct = Math.round((cov.summarised / cov.total) * 100);
  const weighted = getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
  const weightedSuffix =
    weighted.weightedRatio === null ? '' : ` — centrality-weighted ${Math.round(weighted.weightedRatio * 100)}%`;
  writeStatusLine(
    deps,
    `  Summaries: ${deps.formatNumber(cov.summarised)}/${deps.formatNumber(cov.total)} (${pct}%)${weightedSuffix}`,
  );
}

export function printStatusRollups(deps: StatusPrinterDeps, cg: any, rollups: StatusRollupConfig): void {
  const rollupLines: string[] = [];
  rollups.appendFeatureReadiness(rollupLines, cg, {
    summaryBreakdown: rollups.summaryBreakdown,
    surface: 'cli',
  });
  rollups.appendInlineHotspots(rollupLines, cg, rollups.topHotspots);
  rollups.appendInlineBiomarkers(rollupLines, cg, rollups.topBiomarkers);
  if (rollupLines.length === 0) return;
  for (const line of rollupLines) {
    printStatusRollupLine(deps, line);
  }
  writeStatusLine(deps);
}

export function printStatusRollupLine(deps: StatusPrinterDeps, line: string): void {
  if (line === '') {
    writeStatusLine(deps);
  } else if (line.startsWith('### ')) {
    writeStatusLine(deps, deps.style.bold(line.slice(4)));
  } else {
    writeStatusLine(deps, line);
  }
}

function writeStatusLine(deps: StatusPrinterDeps, message = ''): void {
  deps.writeLine(message);
}
