import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type Cartograph from '../../index.js';
import { getSymbolRoles } from '../../db/queries-roles.js';
import { getAllDirectorySummaries, getDirectorySummary } from '../../db/queries-directory-summaries.js';
import { countSymbolSummaries } from '../../db/queries-summaries.js';
import { getAllFiles } from '../../db/queries-files.js';
import { SUMMARIZABLE_KINDS } from '../../llm/summarizer.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import {
  renderMarkdownCardList,
  renderMarkdownKeyValueCard,
  type KeyValueCardRow,
  type MarkdownCardListSpec,
  type MarkdownKeyValueCardSpec,
} from './_result-spec.js';

/** One indexed-directory row consumed by {@link buildModuleSummariesSpec}.
 *  Mirrors the shape returned by `getAllDirectorySummaries`. */
export interface DirectorySummaryRow {
  readonly dirPath: string;
  readonly summary: string;
}

/** Cap on the role-mix preview list (top-N most-frequent roles). */
const TOP_ROLES = 5;
/** Cap on the inline `**Top exports:**` list before the `(+N more)` rollup. */
const TOP_EXPORTS = 8;
/** Minimum summarised-symbol count below which the footer says "not yet available" instead of "not yet cached". */
const MIN_SUMMARISED_FOR_PARAGRAPH = 3;
/** Multiplier (100) used to render a 0–1 fraction as a percent in the role-mix output. */
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

/**
 * Accumulate language counts and symbol IDs from files in a directory.
 */
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

/**
 * Accumulate edge counts (intra-dir vs outbound/inbound) for files in a directory.
 */
interface AccumulateEdgeCountsArgs {
  cg: Cartograph;
  dirFiles: ReadonlyArray<{ path: string; language: string }>;
  dirPath: string;
  dirPrefix: string;
  /** The full indexed-path set, hoisted so the per-file
   *  `getFileDependencies` calls below don't each re-query it. */
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

function isPathInDirectory(path: string, dirPath: string, dirPrefix: string): boolean {
  return path.startsWith(dirPrefix) || path === dirPath;
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

/**
 * Walk the directory's files once, accumulating language split,
 * summarisable-symbol IDs, exported names, and edge density (intra-
 * vs cross-dir) via the file-level dependency graph.
 */
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

/** Default cap (20) for the no-arg "list all" path — avoids dumping every
 *  cached directory summary in a single response. Callers can raise it via
 *  the `limit` parameter. */
const LIST_ALL_DEFAULT_LIMIT = 20;

/**
 * Build the list-all module-summaries card-list spec. One H3 card per
 * indexed directory; the title interpolates `(showing N of M)` from
 * the slice/total counts. rowBody wraps the cached LLM paragraph
 * through {@link tidyTruncatedSummary} so a bare trailing `…` doesn't
 * leak through.
 *
 * Footer fires only on overflow (`all.length > slice.length`) and
 * carries the "+N more" + recovery-hint copy with correct singular
 * (`directory`) / plural (`directories`) handling. The follow-up
 * `limit` suggestion doubles the current limit, capped at `all.length`.
 *
 * Caller (`listAllModuleSummaries`) short-circuits the
 * `all.length === 0` path via `textResult('No module summaries
 * cached yet …')` BEFORE this builder is called, AND `limit` is
 * Zod-validated `.int().min(1)`, so `slice.length === 0` is
 * unreachable. `emptyState: ''` is therefore the never-rendered
 * empty string.
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
          `_… ${overflow} more director${overflow === 1 ? 'y' : 'ies'} not shown. Pass \`limit: ${Math.min(all.length, limit * 2)}\` to see more, or pass a \`dirPath\` for a single directory._`,
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

/**
 * Render cached directory summaries. Used by the no-arg path of `handleModule`.
 * Accepts a limit so an unbounded listing can't silently saturate the context window.
 */
function formatAllDirectorySummaries(all: ReadonlyArray<DirectorySummaryRow>, limit: number): string {
  return renderMarkdownCardList(buildModuleSummariesSpec({ all, limit }));
}

/**
 * The directory-summariser appends a bare ` …` to a paragraph it had to
 * truncate to fit the char budget (see `truncateAtBoundary` /
 * `tidyLlmEnding` in `src/llm/dir-summarizer.ts`). Rendered verbatim the
 * trailing `…` reads like a generation failure — the agent can't tell a
 * deliberate clip from a crashed LLM call.
 *
 * This render-time pass makes the truncation unambiguous: if the
 * paragraph ends with a sentence-terminated clause followed by ` …`,
 * drop the dangling marker and keep the clean sentence(s); otherwise
 * (clip landed mid-sentence) replace the bare `…` with an explicit
 * `[summary truncated]` marker so it's clearly deliberate.
 */
const TRAILING_ELLIPSIS_RE = /\s*…\s*$/;
function tidyTruncatedSummary(summary: string): string {
  const trimmed = summary.trimEnd();
  if (!TRAILING_ELLIPSIS_RE.test(trimmed)) return trimmed;
  const body = trimmed.replace(TRAILING_ELLIPSIS_RE, '').trimEnd();
  // If what's left ends on a complete sentence, the clip is clean —
  // just drop the dangling ellipsis.
  if (/[.!?]$/.test(body)) return body;
  // Otherwise the clip landed mid-sentence: keep up to the last
  // complete sentence if there is one, else append an explicit marker.
  const lastTerminator = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '));
  if (lastTerminator > 0) {
    return body.slice(0, lastTerminator + 1) + ' [summary truncated]';
  }
  return body + ' [summary truncated]';
}

/** Render the language split as `ts 12, py 4`, sorted by descending file count. */
function formatLanguages(langCounts: ReadonlyMap<string, number>): string {
  return [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
}

/** Render the role-mix as `controller 40%, gateway 35%, …`, top-N only. */
function formatRoleMix(roleCounts: ReadonlyMap<string, number>): string {
  const total = [...roleCounts.values()].reduce((a, b) => a + b, 0);
  return [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ROLES)
    .map(([role, n]) => `${role} ${Math.round((n / total) * PCT_MULTIPLIER)}%`)
    .join(', ');
}

/** Render the top-N exports with a `(+N more)` suffix when truncated. */
function formatTopExports(exportNodes: ReadonlyArray<ExportNode>): string {
  const top = exportNodes
    .slice(0, TOP_EXPORTS)
    .map((e) => `\`${e.name}\` (${e.kind})`)
    .join(', ');
  const overflow = exportNodes.length - TOP_EXPORTS;
  const more = overflow > 0 ? ` (+${overflow} more)` : '';
  return `${top}${more}`;
}

/**
 * Footer hint when the LLM paragraph hasn't been cached yet. Two
 * messages: "not yet available" when summarisation hasn't reached
 * the threshold, vs "not yet cached" when symbols ARE summarised
 * but the directory paragraph itself is missing.
 */
function formatLlmParagraphHint(dirPath: string, summarisedHere: number, totalSymbols: number): string {
  if (summarisedHere < MIN_SUMMARISED_FOR_PARAGRAPH) {
    return `> _Quoted directory "${dirPath}" — LLM paragraph not yet available (${summarisedHere} / ${totalSymbols} symbols summarised; needs ≥${MIN_SUMMARISED_FOR_PARAGRAPH}). Run \`cartograph_admin({action: 'summarize'})\` (local LLM) or use the agent-bridge \`cartograph_summaries({action: 'pending'})\` + \`cartograph_summaries({action: 'save'})\`._`;
  }
  return `> _Quoted directory "${dirPath}" — LLM paragraph not yet cached (${summarisedHere} / ${totalSymbols} summarised). Trigger with \`cartograph_admin({action: 'summarize'})\` or use \`cartograph_summaries({action: 'pending'})\` to populate via the agent bridge._`;
}

/**
 * "List all modules" branch: render cached directory summaries
 * (or a one-liner when the LLM pass hasn't run yet).
 */
function listAllModuleSummaries(cg: ReturnType<ToolCtx['getCartograph']>, limit: number): ToolOutcome {
  const all = getAllDirectorySummaries(cg.queries);
  if (all.length === 0) {
    return ok(textResult('No module summaries cached yet. Run a sync after the LLM background pass to populate them.'));
  }
  return ok(renderToolResponse({ body: formatAllDirectorySummaries(all, limit) }));
}

/**
 * Tally per-role symbol counts from an id→role map. Returns an empty
 * Map when the role classifier hasn't run, so callers render a plain
 * rollup instead of complaining about missing data.
 */
function buildRoleCounts(rolesMap: Map<string, string>): Map<string, number> {
  const roleCounts = new Map<string, number>();
  for (const role of rolesMap.values()) {
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  return roleCounts;
}

/**
 * Build the module stats report for a specific directory. Separated from
 * {@link handleModule} so the per-directory path (after early-return guards)
 * doesn't push the handler past the large_method threshold.
 */
function buildModuleStatsReport(cg: ReturnType<ToolCtx['getCartograph']>, dirPath: string): ToolOutcome {
  const dirPrefix = dirPath + '/';
  const allFiles = getAllFiles(cg.queries);

  // A path that matches an indexed FILE exactly is a common typo —
  // `module src/index.ts` instead of `module src`. The dir-prefix filter
  // below treats the exact `f.path === dirPath` hit as a one-file
  // "directory" and would mislabel it `Quoted directory "src/index.ts"`.
  // Detect the file case up-front and error with a parent-dir hint.
  if (allFiles.some((f) => f.path === dirPath)) {
    const slash = dirPath.lastIndexOf('/');
    const parent = slash >= 0 ? dirPath.slice(0, slash) : '.';
    return err(
      `"${dirPath}" is a file, not a directory — pass its parent directory (e.g. \`${parent}\`). For one file's symbols use \`cartograph_node\` or \`cartograph_at_range\`.`,
    );
  }

  const dirFiles = allFiles.filter((f) => f.path.startsWith(dirPrefix));

  if (dirFiles.length === 0) {
    // No indexed files under this path — return an error (non-zero CLI
    // exit) so a typo'd directory doesn't silently succeed.
    return err(
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
    return ok(
      textResult(
        `Directory "${dirPath}" has indexed files but no summarisable symbols (kinds like function/method/class/interface). Files: ${dirFiles.length}.`,
      ),
    );
  }

  return ok(
    renderToolResponse({
      body: buildModuleReport({
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
    }),
  );
}

/**
 * Zod schema for `cartograph_module`. `limit` is `.int().min(1)` —
 * a zero, negative, or non-integer value is REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision; the CLI's
 * `--limit` uses the same `{ min: 1 }` floor), never silently floored.
 * The handler therefore drops the old `Math.floor(...)` clamp.
 */
const moduleSchema = z.object({
  dirPath: z
    .string()
    .optional()
    .describe('Project-relative directory path. When omitted, lists cached directory summaries (up to `limit`).'),
  limit: z
    .number()
    .int()
    .min(1)
    .default(LIST_ALL_DEFAULT_LIMIT)
    .describe(
      `Max directory summaries to return when \`dirPath\` is omitted (default ${LIST_ALL_DEFAULT_LIMIT}, positive integer).`,
    ),
  projectPath: projectPathField,
});

type ModuleArgs = z.infer<typeof moduleSchema>;

async function handleModule(ctx: ToolCtx, args: ModuleArgs): Promise<ToolOutcome> {
  const dirPathRaw = args.dirPath;
  const cg = ctx.getCartograph(args.projectPath);
  // Treat a whitespace-only `dirPath` the same as an omitted one — route
  // to the list-all path rather than running it as a real (always-empty)
  // directory lookup. `!dirPathRaw` alone only catches the falsy case.
  if (!dirPathRaw || dirPathRaw.trim().length === 0) {
    // `limit` is already a positive integer — Zod's `.int().min(1)`
    // rejected anything else at the dispatch boundary.
    return listAllModuleSummaries(cg, args.limit);
  }
  // Normalise a leading "./", surrounding whitespace, and a trailing slash before lookup
  const dirPath = dirPathRaw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return buildModuleStatsReport(cg, dirPath);
}

/** Inputs for {@link buildModuleReport} — bundled to keep the helper signature short. */
interface ModuleReportInput {
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

/**
 * Build the per-dir KeyValue-card spec — the canary consumer for
 * MarkdownKeyValueCardSpec (commit landing this spec). Title is the
 * directory path; preamble carries the optional LLM-synthesised
 * summary paragraph (passed through {@link tidyTruncatedSummary} to
 * strip the bare trailing `…`); rows are 6 conditional KV entries
 * (Files / Languages / Symbols / Coupling / Role mix / Top exports);
 * footer carries the optional `_Quoted directory..._` hint when the
 * LLM paragraph is missing.
 *
 * Caller (`buildModuleReport`) is only reached when the per-dir
 * branch in `handleModule` has a non-empty dirFiles set, so the spec
 * has at least the Files + Symbols + Coupling rows. `emptyState: ''`
 * is the never-rendered empty string.
 *
 * Edge-density (Coupling) signal — tells the agent at a glance
 * whether this is a leaf module (low inbound, low outbound) or a
 * hub. Same per-row context that lived as an inline comment
 * pre-migration; preserved here as a JSDoc note on the row label.
 */
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
  // Footer hint about the LLM paragraph state when it's missing.
  // Mentions both the LLM path (`cartograph_admin({action: 'summarize'})`)
  // and the agent-bridge path (`cartograph_summaries({action: 'pending'})`)
  // since the agent's environment may have one or the other.
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

/** Render the markdown report for one directory: heading + counts +
 *  coupling + footer hint. */
function buildModuleReport(input: ModuleReportInput): string {
  return renderMarkdownKeyValueCard(buildModuleReportSpec(input));
}

export const MODULE_TOOL = defineTool({
  name: 'cartograph_module',
  description:
    'LLM-synthesised paragraph describing what a directory/module DOES, built from symbol summaries — useful before drilling into specific symbols. ' +
    'Requires the directory-summarisation phase to have run.',
  schema: moduleSchema,
  handle: handleModule,
});
