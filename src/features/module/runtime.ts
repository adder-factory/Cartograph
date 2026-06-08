import type Cartograph from '../../index.js';
import { getSymbolRoles } from '../../db/queries-roles.js';
import { getAllDirectorySummaries, getDirectorySummary } from '../../db/queries-directory-summaries.js';
import { countSymbolSummaries } from '../../db/queries-summaries.js';
import { getAllFiles } from '../../db/queries-files.js';
import { SUMMARIZABLE_KINDS } from '../../llm/summarizer.js';
import {
  renderMarkdownCardList,
  renderMarkdownKeyValueCard,
  type KeyValueCardRow,
  type MarkdownCardListSpec,
  type MarkdownKeyValueCardSpec,
} from '../../rendering/result-spec.js';

/** One indexed-directory row consumed by {@link buildModuleSummariesSpec}. */
export interface DirectorySummaryRow {
  readonly dirPath: string;
  readonly summary: string;
}

export interface ModuleSummaryResult {
  readonly ok: true;
  readonly body: string;
}

export interface ModuleSummaryError {
  readonly ok: false;
  readonly message: string;
}

export type ModuleSummaryOutcome = ModuleSummaryResult | ModuleSummaryError;

/** Default cap for the no-arg "list all" path. */
export const LIST_ALL_DEFAULT_LIMIT = 20;

/** Cap on the role-mix preview list (top-N most-frequent roles). */
const TOP_ROLES = 5;
/** Cap on the inline `**Top exports:**` list before the `(+N more)` rollup. */
const TOP_EXPORTS = 8;
/** Minimum summarised-symbol count before the footer says a paragraph can be cached. */
const MIN_SUMMARISED_FOR_PARAGRAPH = 3;
/** Multiplier used to render a 0-1 fraction as a percent in the role-mix output. */
const PCT_MULTIPLIER = 100;

interface ExportNode {
  name: string;
  kind: string;
}

interface ModuleStats {
  langCounts: Map<string, number>;
  allNodeIds: string[];
  exportNodes: ExportNode[];
  intraDirEdges: number;
  outboundEdges: number;
  inboundEdges: number;
}

/** Inputs for {@link buildModuleReport}. */
export interface ModuleReportInput {
  dirPath: string;
  dirFilesCount: number;
  summary: string | null;
  totalSymbols: number;
  summarisedHere: number;
  langCounts: Map<string, number>;
  roleCounts: Map<string, number>;
  exportNodes: ExportNode[];
  intraDirEdges: number;
  inboundEdges: number;
  outboundEdges: number;
}

function success(body: string): ModuleSummaryOutcome {
  return { ok: true, body };
}

function failure(message: string): ModuleSummaryOutcome {
  return { ok: false, message };
}

/**
 * Build the list-all module-summaries card-list spec. One H3 card per
 * indexed directory; the title interpolates `(showing N of M)` from
 * the slice/total counts. rowBody wraps the cached LLM paragraph
 * through {@link tidyTruncatedSummary} so a bare trailing `...` does
 * not leak through.
 */
export function buildModuleSummariesSpec(args: {
  all: ReadonlyArray<DirectorySummaryRow>;
  limit: number;
}): MarkdownCardListSpec<DirectorySummaryRow> {
  const { all, limit } = args;
  const slice = all.slice(0, limit);
  const overflow = all.length - slice.length;
  const footers =
    overflow > 0
      ? [
          `_... ${overflow} more director${overflow === 1 ? 'y' : 'ies'} not shown. Pass \`limit: ${Math.min(all.length, limit * 2)}\` to see more, or pass a \`dirPath\` for a single directory._`,
        ]
      : undefined;
  const spec: MarkdownCardListSpec<DirectorySummaryRow> = {
    title: `Module summaries (showing ${slice.length} of ${all.length})`,
    rows: slice,
    rowHeading: (r) => r.dirPath,
    rowBody: (r) => [tidyTruncatedSummary(r.summary)],
    emptyState: '',
  };
  return footers ? { ...spec, footers } : spec;
}

function formatAllDirectorySummaries(all: ReadonlyArray<DirectorySummaryRow>, limit: number): string {
  return renderMarkdownCardList(buildModuleSummariesSpec({ all, limit }));
}

function tidyTruncatedSummary(summary: string): string {
  const trimmed = summary.trimEnd();
  const body = stripTrailingEllipsis(trimmed);
  if (body === null) return trimmed;
  if (endsWithSentenceTerminator(body)) return body;
  const lastTerminator = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '));
  if (lastTerminator > 0) {
    return body.slice(0, lastTerminator + 1) + ' [summary truncated]';
  }
  return body + ' [summary truncated]';
}

function stripTrailingEllipsis(summary: string): string | null {
  if (summary.endsWith('...')) return summary.slice(0, -3).trimEnd();
  if (summary.endsWith('…')) return summary.slice(0, -1).trimEnd();
  return null;
}

function endsWithSentenceTerminator(value: string): boolean {
  const last = value.at(-1);
  return last === '.' || last === '!' || last === '?';
}

function formatLanguages(langCounts: ReadonlyMap<string, number>): string {
  return [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
}

function formatRoleMix(roleCounts: ReadonlyMap<string, number>): string {
  const total = [...roleCounts.values()].reduce((a, b) => a + b, 0);
  return [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ROLES)
    .map(([role, n]) => `${role} ${Math.round((n / total) * PCT_MULTIPLIER)}%`)
    .join(', ');
}

function formatTopExports(exportNodes: ReadonlyArray<ExportNode>): string {
  const top = exportNodes
    .slice(0, TOP_EXPORTS)
    .map((e) => `\`${e.name}\` (${e.kind})`)
    .join(', ');
  const overflow = exportNodes.length - TOP_EXPORTS;
  const more = overflow > 0 ? ` (+${overflow} more)` : '';
  return `${top}${more}`;
}

function formatLlmParagraphHint(dirPath: string, summarisedHere: number, totalSymbols: number): string {
  if (summarisedHere < MIN_SUMMARISED_FOR_PARAGRAPH) {
    return `> _Quoted directory "${dirPath}" — LLM paragraph not yet available (${summarisedHere} / ${totalSymbols} symbols summarised; needs >=${MIN_SUMMARISED_FOR_PARAGRAPH}). Run \`cartograph_admin({action: 'summarize'})\` (local LLM) or use the agent-bridge \`cartograph_summaries({action: 'pending'})\` + \`cartograph_summaries({action: 'save'})\`._`;
  }
  return `> _Quoted directory "${dirPath}" — LLM paragraph not yet cached (${summarisedHere} / ${totalSymbols} summarised). Trigger with \`cartograph_admin({action: 'summarize'})\` or use \`cartograph_summaries({action: 'pending'})\` to populate via the agent bridge._`;
}

function listAllModuleSummaries(cg: Cartograph, limit: number): ModuleSummaryOutcome {
  const all = getAllDirectorySummaries(cg.queries);
  if (all.length === 0) {
    return success('No module summaries cached yet. Run a sync after the LLM background pass to populate them.');
  }
  return success(formatAllDirectorySummaries(all, limit));
}

function buildRoleCounts(rolesMap: Map<string, string>): Map<string, number> {
  const roleCounts = new Map<string, number>();
  for (const role of rolesMap.values()) {
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  return roleCounts;
}

function buildModuleStatsReport(cg: Cartograph, dirPath: string): ModuleSummaryOutcome {
  const dirPrefix = dirPath + '/';
  const allFiles = getAllFiles(cg.queries);

  if (allFiles.some((f) => f.path === dirPath)) {
    const slash = dirPath.lastIndexOf('/');
    const parent = slash >= 0 ? dirPath.slice(0, slash) : '.';
    return failure(
      `"${dirPath}" is a file, not a directory — pass its parent directory (e.g. \`${parent}\`). For one file's symbols use \`cartograph_files({format: 'symbols', file: '${dirPath}'})\` or \`cartograph_at_range\`.`,
    );
  }

  const dirFiles = allFiles.filter((f) => f.path.startsWith(dirPrefix));
  if (dirFiles.length === 0) {
    return failure(
      `Directory "${dirPath}" has no indexed files and no summarisable symbols (path doesn't match anything in the index — check spelling or run \`cartograph_admin({action: 'index'})\`).`,
    );
  }

  const indexedFiles = new Set(allFiles.map((f) => f.path));
  const stats = aggregateModuleStats({ cg, dirFiles, dirPath, dirPrefix, indexedFiles });
  const { langCounts, allNodeIds, exportNodes, intraDirEdges, outboundEdges, inboundEdges } = stats;

  const rolesMap = allNodeIds.length > 0 ? getSymbolRoles(cg.queries, allNodeIds) : new Map<string, string>();
  const roleCounts = buildRoleCounts(rolesMap);
  const summarisedHere = allNodeIds.length > 0 ? countSymbolSummaries(cg.queries, allNodeIds) : 0;
  const totalSymbols = allNodeIds.length;
  const summary = getDirectorySummary(cg.queries, dirPath)?.summary ?? null;

  if (totalSymbols === 0) {
    return success(
      `Directory "${dirPath}" has indexed files but no summarisable symbols (kinds like function/method/class/interface). Files: ${dirFiles.length}.`,
    );
  }

  return success(
    buildModuleReport({
      dirPath,
      dirFilesCount: dirFiles.length,
      summary,
      totalSymbols,
      summarisedHere,
      langCounts,
      roleCounts,
      exportNodes,
      intraDirEdges,
      inboundEdges,
      outboundEdges,
    }),
  );
}

function accumulateSymbolsAndLanguages(
  cg: Cartograph,
  dirFiles: ReadonlyArray<{ path: string; language: string }>,
): { langCounts: Map<string, number>; allNodeIds: string[]; exportNodes: ExportNode[] } {
  const langCounts = new Map<string, number>();
  const allNodeIds: string[] = [];
  const exportNodes: ExportNode[] = [];
  for (const f of dirFiles) {
    langCounts.set(f.language, (langCounts.get(f.language) ?? 0) + 1);
    for (const n of cg.queries.getNodesByFile(f.path)) {
      if (SUMMARIZABLE_KINDS.has(n.kind)) allNodeIds.push(n.id);
      if (n.isExported) exportNodes.push({ name: n.name, kind: n.kind });
    }
  }
  return { langCounts, allNodeIds, exportNodes };
}

interface AccumulateEdgeCountsArgs {
  cg: Cartograph;
  dirFiles: ReadonlyArray<{ path: string; language: string }>;
  dirPath: string;
  dirPrefix: string;
  indexedFiles: ReadonlySet<string>;
}

function accumulateEdgeCounts(args: AccumulateEdgeCountsArgs): {
  intraDirEdges: number;
  outboundEdges: number;
  inboundEdges: number;
} {
  const { cg, dirFiles, dirPath, dirPrefix, indexedFiles } = args;
  let intraDirEdges = 0;
  let outboundEdges = 0;
  let inboundEdges = 0;
  for (const f of dirFiles) {
    const deps = cg.internals.graphManager.getFileDependencies(f.path, indexedFiles);
    const depCounts = countDependencyEdges({ filePath: f.path, deps, dirPath, dirPrefix });
    intraDirEdges += depCounts.intraDirEdges;
    outboundEdges += depCounts.outboundEdges;

    const dependents = cg.internals.graphManager.getFileDependents(f.path);
    inboundEdges += countInboundEdges({ filePath: f.path, dependents, dirPath, dirPrefix });
  }
  return { intraDirEdges, outboundEdges, inboundEdges };
}

function isPathInDirectory(filePath: string, dirPath: string, dirPrefix: string): boolean {
  return filePath.startsWith(dirPrefix) || filePath === dirPath;
}

function countDependencyEdges(args: {
  filePath: string;
  deps: ReadonlyArray<string>;
  dirPath: string;
  dirPrefix: string;
}): { intraDirEdges: number; outboundEdges: number } {
  const { filePath, deps, dirPath, dirPrefix } = args;
  let intraDirEdges = 0;
  let outboundEdges = 0;
  for (const depPath of deps) {
    if (depPath === filePath) continue;
    if (isPathInDirectory(depPath, dirPath, dirPrefix)) intraDirEdges++;
    else outboundEdges++;
  }
  return { intraDirEdges, outboundEdges };
}

function countInboundEdges(args: {
  filePath: string;
  dependents: ReadonlyArray<string>;
  dirPath: string;
  dirPrefix: string;
}): number {
  const { filePath, dependents, dirPath, dirPrefix } = args;
  let inboundEdges = 0;
  for (const dependentPath of dependents) {
    if (dependentPath !== filePath && !isPathInDirectory(dependentPath, dirPath, dirPrefix)) inboundEdges++;
  }
  return inboundEdges;
}

interface AggregateModuleStatsArgs {
  cg: Cartograph;
  dirFiles: ReadonlyArray<{ path: string; language: string }>;
  dirPath: string;
  dirPrefix: string;
  indexedFiles: ReadonlySet<string>;
}

function aggregateModuleStats(args: AggregateModuleStatsArgs): ModuleStats {
  const { cg, dirFiles, dirPath, dirPrefix, indexedFiles } = args;
  const { langCounts, allNodeIds, exportNodes } = accumulateSymbolsAndLanguages(cg, dirFiles);
  const { intraDirEdges, outboundEdges, inboundEdges } = accumulateEdgeCounts({
    cg,
    dirFiles,
    dirPath,
    dirPrefix,
    indexedFiles,
  });
  return { langCounts, allNodeIds, exportNodes, intraDirEdges, outboundEdges, inboundEdges };
}

export function buildModuleReportSpec(input: ModuleReportInput): MarkdownKeyValueCardSpec {
  const rows: KeyValueCardRow[] = [{ label: 'Files', value: String(input.dirFilesCount) }];
  if (input.langCounts.size > 0) {
    rows.push({ label: 'Languages', value: formatLanguages(input.langCounts) });
  }
  rows.push(
    {
      label: 'Symbols',
      value: `${input.totalSymbols} summarisable (${input.summarisedHere} have LLM summaries)`,
    },
    {
      label: 'Coupling',
      value: `${input.intraDirEdges} intra-dir, ${input.inboundEdges} inbound, ${input.outboundEdges} outbound`,
    },
  );
  if (input.roleCounts.size > 0) {
    rows.push({ label: 'Role mix', value: formatRoleMix(input.roleCounts) });
  }
  if (input.exportNodes.length > 0) {
    rows.push({ label: 'Top exports', value: formatTopExports(input.exportNodes) });
  }

  const preamble: ReadonlyArray<string> | undefined = input.summary ? [tidyTruncatedSummary(input.summary)] : undefined;
  const footers: ReadonlyArray<string> | undefined =
    !input.summary && input.totalSymbols > 0
      ? [formatLlmParagraphHint(input.dirPath, input.summarisedHere, input.totalSymbols)]
      : undefined;

  return {
    title: input.dirPath,
    rows,
    emptyState: '',
    ...(preamble ? { preamble } : {}),
    ...(footers ? { footers } : {}),
  };
}

function buildModuleReport(input: ModuleReportInput): string {
  return renderMarkdownKeyValueCard(buildModuleReportSpec(input));
}

export function normalizeModuleDirPath(dirPathRaw: string): string {
  let dirPath = dirPathRaw.trim();
  if (dirPath.startsWith('./')) dirPath = dirPath.slice(2);
  while (dirPath.endsWith('/')) dirPath = dirPath.slice(0, -1);
  return dirPath;
}

export function runModuleSummary(
  cg: Cartograph,
  args: { dirPath?: string | undefined; limit: number },
): ModuleSummaryOutcome {
  const dirPathRaw = args.dirPath;
  if (!dirPathRaw || dirPathRaw.trim().length === 0) {
    return listAllModuleSummaries(cg, args.limit);
  }
  return buildModuleStatsReport(cg, normalizeModuleDirPath(dirPathRaw));
}
