import { z } from 'zod';
import { projectPathField, nonEmptyString } from './_common-fields.js';
import { getOutgoingEdges } from '../../db/queries-edges.js';
import { existsSync, readFileSync } from 'node:fs';
import type { Node, Subgraph } from '../../types.js';
import { validatePathWithinRootReal, stripCommentsForRegex } from '../../utils.js';
import type Cartograph from '../../index.js';
import { applyDeltaSince, mintCallId } from './shared.js';
import { renderToolResponse, type ToolResponseSpec } from './_response.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import { getExploreBudget } from './explore-budget.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';

/** Maximum output for explore tool — sized to stay under MCP client token limits (~10k tokens). */
const EXPLORE_MAX_OUTPUT = 35000;
/** Per-relationship-kind cap in the relationship-map section. */
const MAX_RELATIONSHIPS_PER_KIND = 15;
/**
 * Per-file cap on the `defines:` / `references:` header sublines
 * (audit-4 #8). A hub file can surface 100+ comma-joined entries on a
 * single physical line — the largest token sink in the output. Capped
 * at 30 in full mode; trimmed harder under `--summary` since that mode
 * exists to cut tokens on a recon pass.
 */
const MAX_FILE_HEADER_ENTRIES = 30;
const MAX_FILE_HEADER_ENTRIES_SUMMARY = 12;
/** Lines we'll merge into one cluster when their start/end are within this gap. */
const CLUSTER_GAP_THRESHOLD = 15;
/** Lines of leading/trailing context kept around each clustered range. */
const CONTEXT_PADDING_LINES = 3;
/**
 * A run of this many or more consecutive pure-comment lines in a
 * rendered source slice collapses into a one-line marker; shorter runs
 * stay verbatim. License banners and multi-line doc blocks (`@param` /
 * `@brief` / `@sa <url>` clusters) are the only compressible fat measured
 * in explore output — 10-15% on doc-heavy C++/PHP, ~1-5% elsewhere — and
 * at the EXPLORE_MAX_OUTPUT cap that fat crowds real code out of the
 * budget. The floor keeps short comments (`// HACK`, a one-line doc
 * header) intact; the agent can still Read the file for full prose.
 */
const MIN_COLLAPSIBLE_COMMENT_RUN = 4;
/** Per-file overhead allowance reserved in the output budget for the markdown wrapper around each file's section. */
const FILE_BUDGET_OVERHEAD_CHARS = 200;
/** Below this many chars of remaining budget, give up on the next file rather than truncate to nothing useful. */
const MIN_FILE_BUDGET_CHARS = 500;
/** Score thresholds for the file relevance gate (entry point / connected / other). */
const ENTRY_FILE_SCORE = 10;
const CONNECTED_FILE_SCORE = 3;
const PERIPHERAL_FILE_SCORE = 1;
/** A file qualifies as "relevant" when its summed score reaches this threshold. */
const RELEVANT_FILE_SCORE_FLOOR = 3;

// handleExplore tunables — defaults the public tool exposes through
// `maxFiles` plus the contextBuilder's exploration shape. Bounded so
// a stray oversized argument can't make the tool walk the whole graph.
const DEFAULT_MAX_FILES = 12;
const MAX_MAX_FILES = 20;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TRAVERSAL_DEPTH = 3;
const DEFAULT_MAX_SUBGRAPH_NODES = 200;
const DEFAULT_MIN_SCORE = 0.2;
/** Minimum query-term length kept for relevance checking — single chars match too much. */
const MIN_QUERY_TERM_LEN = 3;
/** Cap on the "Additional relevant files" listing. */
const MAX_REMAINING_FILES_SHOWN = 10;
/** Pattern that flags low-value paths (tests, icons, i18n) — deprioritised in the sort. */
const LOW_VALUE_PATH_RE = /\/(tests?|__tests?__|spec)\/|\bicons?\b|\bi18n\b/i;

/**
 * Kinds whose AST node IS the declaration — treat as `defines:` in the
 * per-file header (Task #3). Anything else surfaced under the file
 * (edge-kinds like `calls` / `type_of`, or noise node-kinds) becomes
 * a `references:` entry.
 */
const DEFINITION_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'constant',
  'variable',
  'struct',
  'trait',
  'enum',
  'enum_member',
  'route',
  'component',
  'protocol',
  'namespace',
  'table',
  'resource',
]);

interface FileGroup {
  nodes: Node[];
  score: number;
}

type FileEntry = [string, FileGroup];

interface SymbolRef {
  name: string;
  kind: string;
}

interface RangeRef {
  start: number;
  end: number;
  name: string;
  kind: string;
}

interface RangeCluster {
  start: number;
  end: number;
  symbols: SymbolRef[];
}

interface BuildExploreBodyArgs {
  ctx: ToolCtx;
  query: string;
  cg: ReturnType<ToolCtx['getCartograph']>;
  subgraph: Subgraph;
  fileGroups: Map<string, FileGroup>;
  sortedFilesAll: FileEntry[];
  sortedFiles: FileEntry[];
  delta: ReturnType<typeof applyDeltaSince<FileEntry>>;
  maxFiles: number;
  /** Task #2 — when true, suppress source-code blocks + "Additional relevant
   *  files" listing. Per-file headers (defines/references) + relationship
   *  map stay. Default false (back-compat). */
  summary: boolean;
  /** Task #4 — prior-call row keys covering FILES + RELATIONSHIPS,
   *  resolved from the `since` UID. Filters the relationship map to
   *  rows the agent hasn't seen yet. */
  priorKeys: ReadonlySet<string> | null;
}

/**
 * Build the full explore output as a {@link import('./_response.js').ToolResponseSpec}.
 *
 * P5 chokepoint: this returns a spec — body + footers + freshness —
 * rather than a hand-assembled string. The delta-summary HEADER stays
 * in `body` (it describes the rows that follow); the call-id MARKER is
 * a `footers` entry the chokepoint places after truncation; the
 * stale-files note is supplied as `freshness` so the chokepoint owns
 * its placement. Truncation at `EXPLORE_MAX_OUTPUT` is applied by the
 * chokepoint at the handler return site (the result path was
 * previously unbounded — a latent bug; the chokepoint fixes it).
 */
function buildExploreBody(args: BuildExploreBodyArgs): ToolResponseSpec {
  const { ctx, query, cg, subgraph, fileGroups, sortedFilesAll, sortedFiles, delta, maxFiles, summary, priorKeys } =
    args;
  // FRICTION-28: when more files exist than `maxFiles` can render, tell the
  // caller exactly how many they're seeing and how to expand. Skip the
  // suffix when everything fit (it's noise then).
  const totalFiles = fileGroups.size;
  const framingSuffix =
    totalFiles > maxFiles
      ? `; capped at ${maxFiles} ${maxFiles === 1 ? 'file' : 'files'} (raise \`maxFiles\` to expand)`
      : '';
  const lines: string[] = [
    `## Exploration: ${query}`,
    '',
    `Found ${subgraph.nodes.size} symbols across ${totalFiles} files${framingSuffix}.`,
    '',
  ];
  if (delta.sinceUid && !delta.sinceMissing) {
    const sourceNote = summary
      ? 'Summary mode: source-code blocks suppressed.'
      : `showing source for ${sortedFiles.length} of ${sortedFilesAll.length} relevant files not surfaced in the prior call`;
    lines.push(`_Delta mode: ${sourceNote}. Relationship map below shows only NEW rows vs the prior call._`, '');
  } else if (summary) {
    lines.push('_Summary mode: source-code blocks suppressed; per-file headers and relationships only._', '');
  }
  const renderedRelKeys = appendRelationshipMap(lines, subgraph, priorKeys);
  const renderedFiles = appendFileSections({
    lines,
    sortedFiles,
    projectRoot: cg.projectRoot,
    cg,
    subgraph,
    maxFiles,
    summary,
  });
  if (!summary) {
    // "Additional relevant files" covers the FULL relevant set minus what was
    // rendered — files surfaced in a prior call still appear as a recovery
    // surface, and newly-relevant files that didn't fit the budget aren't lost.
    appendRemainingFiles({ lines, fileGroups, sortedFiles: sortedFilesAll, rendered: renderedFiles.paths });
  }
  appendCompletenessAndBudget({ lines, cg, filesIncluded: renderedFiles.count, summary });

  // Mint the call-id over the UNION of file keys + relationship keys so
  // a subsequent `since=<this-uid>` filters BOTH dimensions (Task #4).
  const fileKeys = sortedFilesAll.map((e) => fileKey(e[0]));
  const newCallId = mintCallId({
    callIds: ctx.callIds,
    toolName: 'cartograph_explore',
    currentKeys: [...fileKeys, ...renderedRelKeys.allKeys],
    priorKeys: delta.priorKeys,
  });
  const sinceMeta = buildExploreSinceMeta(delta, {
    fileCount: sortedFiles.length,
    relCount: renderedRelKeys.newCount,
  });
  // Delta-summary header → body (describes the rows); call-id marker →
  // footer (placed after truncation); stale-files note → freshness.
  const { header, marker } = splitCallIdFooter(newCallId, sinceMeta);
  const bodyText = lines.join('\n');
  const body = header + bodyText;
  return {
    body,
    footers: [marker],
    freshness: { cg, nodes: [...subgraph.nodes.values()] },
    maxLength: EXPLORE_MAX_OUTPUT,
  };
}

/**
 * Zod schema for `cartograph_explore`.
 *
 * `maxFiles` is `.int().min(1).max(20)` — the legacy handler clamped
 * to `[1, MAX_MAX_FILES]`; under the locked reject-out-of-range policy
 * an out-of-range / non-integer value is now REJECTED at the dispatch
 * boundary instead, so the handler drops the `clamp(numArg(...))` call.
 */
const exploreSchema = z.object({
  query: nonEmptyString.describe(
    'Symbol names, file names, or short code terms to explore (e.g. "AuthService loginUser session-manager"). NOT natural-language sentences.',
  ),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_FILES)
    .default(DEFAULT_MAX_FILES)
    .describe('Max files to include source code from (default: 12).'),
  summary: z
    .boolean()
    .default(false)
    .describe(
      'When true, suppress source-code blocks but keep the relationship map and per-file `defines:`/`references:` headers — structural shape at low token cost. Default false.',
    ),
  since: z
    .string()
    .optional()
    .describe(
      'Delta mode: pass a `c_xxxxxxxx` UID from a prior call to render ONLY new rows, paging both the source set and the relationship map. Each response ends with a fresh `> _call: c_xxxxxxxx_` marker.',
    ),
  projectPath: projectPathField,
});

type ExploreArgs = z.infer<typeof exploreSchema>;

async function handleExplore(ctx: ToolCtx, args: ExploreArgs): Promise<ToolOutcome> {
  const query = args.query;

  const cg = ctx.getCartograph(args.projectPath);
  // `maxFiles` is already an integer in [1, MAX_MAX_FILES] — Zod's
  // `.int().min().max()` rejected anything else at the dispatch boundary.
  const maxFiles = args.maxFiles;
  const summary = args.summary;

  const subgraph = await cg.internals.contextBuilder.findRelevantContext(query, {
    searchLimit: DEFAULT_SEARCH_LIMIT,
    traversalDepth: DEFAULT_TRAVERSAL_DEPTH,
    maxNodes: DEFAULT_MAX_SUBGRAPH_NODES,
    minScore: DEFAULT_MIN_SCORE,
  });

  if (subgraph.nodes.size === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: `No relevant code found for "${query}"`,
          freshness: { cg },
        },
      }),
    );
  }

  const fileGroups = groupAndScoreNodes(subgraph);
  const sortedFilesAll = sortRelevantFiles(fileGroups, query);

  // No-match guard: `findRelevantContext` can return a non-empty
  // subgraph (semantic seeding pulls in low-relevance peers) even when
  // nothing genuinely matches the query — the `size === 0` check above
  // alone lets a no-match query render a ~200-symbol dump of peripheral
  // files. When NO file clears `RELEVANT_FILE_SCORE_FLOOR`, treat the
  // run as a miss and return the same honest "nothing found" message.
  if (sortedFilesAll.length === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message:
            `No relevant code found for "${query}" — ${subgraph.nodes.size} symbols were ` +
            'reachable but none cleared the relevance floor. Try more specific symbol or ' +
            'file names, or run `cartograph_find(by=name)` first to confirm the names exist.',
          freshness: { cg },
        },
      }),
    );
  }

  // Delta-mode (#16, Task #4): row keys cover FILES (`file:<path>`) AND
  // RELATIONSHIP rows (`rel:<kind>:<source>:<target>`) so the relationship
  // map can also be paged (Task #4). applyDeltaSince filters the file rows
  // here; the relationship map filters its own rows below in
  // appendRelationshipMap using `priorKeys` resolved from the same UID.
  const fileRowKey = (entry: FileEntry) => fileKey(entry[0]);
  const delta = applyDeltaSince({
    callIds: ctx.callIds,
    sinceArg: args.since,
    rows: sortedFilesAll,
    rowKey: fileRowKey,
  });
  const sortedFiles = delta.rows;

  // P5 chokepoint: `buildExploreBody` returns a spec; the chokepoint
  // owns truncation (at EXPLORE_MAX_OUTPUT — the result path was
  // previously unbounded), footer placement, and freshness.
  return ok(
    renderToolResponse(
      buildExploreBody({
        ctx,
        query,
        cg,
        subgraph,
        fileGroups,
        sortedFilesAll,
        sortedFiles,
        delta,
        maxFiles,
        summary,
        priorKeys: delta.priorKeys,
      }),
    ),
  );
}

/** Optional `since` metadata footer for explore. */
function buildExploreSinceMeta(
  delta: ReturnType<typeof applyDeltaSince<FileEntry>>,
  newRows: { fileCount: number; relCount: number },
): { newCount: number; totalBefore: number; sinceUid: string; sinceMissing: boolean } | undefined {
  if (delta.sinceUid === null) return undefined;
  return {
    // Surface the combined new-row count (files + relationships) so the
    // shared delta summary line reflects what actually changed (Task #4).
    newCount: newRows.fileCount + newRows.relCount,
    totalBefore: delta.totalBefore,
    sinceUid: delta.sinceUid,
    sinceMissing: delta.sinceMissing,
  };
}

/** Row-key prefixes — files vs relationships share the call-id cache,
 *  prefixes avoid collision (e.g. a file named `calls:foo:bar`). */
function fileKey(path: string): string {
  return `file:${path}`;
}

function relKey(kind: string, source: string, target: string): string {
  return `rel:${kind}:${source}:${target}`;
}

/**
 * Group every analysable subgraph node by file, scoring entry-point
 * files (10), files directly connected to entry points (3), and
 * peripheral files (1). Skips import/export nodes — they add noise
 * without information when the agent is reading source code.
 */
/** Pick a per-node score tier: entry > connected > peripheral. */
function scoreFileNode(
  node: { id: string },
  entryNodeIds: ReadonlySet<string>,
  connectedToEntry: ReadonlySet<string>,
): number {
  if (entryNodeIds.has(node.id)) return ENTRY_FILE_SCORE;
  if (connectedToEntry.has(node.id)) return CONNECTED_FILE_SCORE;
  return PERIPHERAL_FILE_SCORE;
}

function groupAndScoreNodes(subgraph: Subgraph): Map<string, FileGroup> {
  const fileGroups = new Map<string, FileGroup>();
  const entryNodeIds = new Set(subgraph.roots);

  const connectedToEntry = new Set<string>();
  for (const edge of subgraph.edges) {
    if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
    if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
  }

  for (const node of subgraph.nodes.values()) {
    if (node.kind === 'import' || node.kind === 'export') continue;
    const group = fileGroups.get(node.filePath) ?? { nodes: [], score: 0 };
    group.nodes.push(node);
    group.score += scoreFileNode(node, entryNodeIds, connectedToEntry);
    fileGroups.set(node.filePath, group);
  }
  return fileGroups;
}

/**
 * Filter to relevant files (score ≥ floor) then sort:
 *   1. query-term match in path or symbol name first
 *   2. low-value paths (tests/icons/i18n) demoted
 *   3. higher score first
 *   4. larger group (more nodes) first
 */
function sortRelevantFiles(fileGroups: Map<string, FileGroup>, query: string): FileEntry[] {
  const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= RELEVANT_FILE_SCORE_FLOOR);
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= MIN_QUERY_TERM_LEN);

  const hasQueryRelevance = (filePath: string, nodes: Node[]): boolean => {
    const fp = filePath.toLowerCase();
    if (queryTerms.some((t) => fp.includes(t))) return true;
    return nodes.some((n) => queryTerms.some((t) => n.name.toLowerCase().includes(t)));
  };

  return relevantFiles.sort((a, b) => {
    const aPath = a[0].toLowerCase();
    const bPath = b[0].toLowerCase();

    const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
    const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
    if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

    const aLow = LOW_VALUE_PATH_RE.test(aPath);
    const bLow = LOW_VALUE_PATH_RE.test(bPath);
    if (aLow !== bLow) return aLow ? 1 : -1;

    if (a[1].score !== b[1].score) return b[1].score - a[1].score;
    return b[1].nodes.length - a[1].nodes.length;
  });
}

interface RelMapResult {
  /** ALL relationship row-keys observed (rendered OR skipped — full
   *  subgraph), for the call-id cache so a subsequent `since=<this>`
   *  filters them out. */
  allKeys: string[];
  /** Count of NEW relationship rows actually rendered in this call
   *  (after the priorKeys filter + per-kind cap). Powers the delta
   *  summary line. */
  newCount: number;
}

/**
 * Show how symbols connect (excluding `contains` — that's implied
 * by file grouping). Group edges by kind for readability and cap
 * each kind at MAX_RELATIONSHIPS_PER_KIND.
 *
 * Task #4: when `priorKeys` is supplied (caller passed a valid
 * `since=<uid>`), only render rows whose key is NOT in the prior set.
 * Still tracks ALL keys (rendered + filtered + over-cap) so the
 * follow-up call sees a complete continuation set.
 */
function appendRelationshipMap(
  lines: string[],
  subgraph: Subgraph,
  priorKeys: ReadonlySet<string> | null,
): RelMapResult {
  const significantEdges = subgraph.edges.filter((e) => e.kind !== 'contains');
  const allKeys: string[] = [];
  if (significantEdges.length === 0) return { allKeys, newCount: 0 };

  const byKind = new Map<string, Array<{ source: string; target: string; key: string; isNew: boolean }>>();
  // Dedupe by `source+target+kind` (the relKey). The subgraph edge list
  // can carry the same logical edge more than once — e.g. the same
  // `findPartialClones → add` call surfaced via two traversal paths —
  // which previously printed the row twice verbatim. relKey collapses
  // them; allKeys also stays deduped so the call-id continuation set
  // doesn't double-count.
  const seenRelKeys = new Set<string>();
  for (const edge of significantEdges) {
    const sourceNode = subgraph.nodes.get(edge.source);
    const targetNode = subgraph.nodes.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const key = relKey(edge.kind, sourceNode.name, targetNode.name);
    if (seenRelKeys.has(key)) continue;
    seenRelKeys.add(key);
    allKeys.push(key);
    const isNew = !priorKeys?.has(key);
    const group = byKind.get(edge.kind) ?? [];
    group.push({ source: sourceNode.name, target: targetNode.name, key, isNew });
    byKind.set(edge.kind, group);
  }

  // Per-kind: render only NEW rows (Task #4), capped at MAX_RELATIONSHIPS_PER_KIND.
  let headerPushed = false;
  let newCount = 0;
  for (const [kind, edges] of byKind) {
    const newRows = edges.filter((e) => e.isNew);
    if (newRows.length === 0) continue;
    if (!headerPushed) {
      lines.push('### Relationships', '');
      headerPushed = true;
    }
    lines.push(`**${kind}:**`);
    const shown = newRows.slice(0, MAX_RELATIONSHIPS_PER_KIND);
    for (const e of shown) {
      lines.push(`- ${e.source} → ${e.target}`);
    }
    newCount += shown.length;
    if (newRows.length > MAX_RELATIONSHIPS_PER_KIND) {
      const remaining = newRows.length - MAX_RELATIONSHIPS_PER_KIND;
      // Hint the caller how to continue: same UID surfaces as `since`
      // in the footer; passing it on the next call drops everything
      // already shown and surfaces the next page.
      lines.push(`- ... and ${remaining} more (pass the \`> _call: c_...\` UID as \`since\` to page)`);
    }
    lines.push('');
  }
  return { allKeys, newCount };
}

/**
 * For each sorted file: read source, build clusters from node ranges
 * + outgoing-edge line refs, format the contiguous sections under a
 * file heading, and stop when either the per-call file cap or the
 * output-char budget is exhausted. Returns the number of files
 * actually rendered.
 */
interface RenderedFiles {
  /** Number of files that received a source-code section. */
  count: number;
  /** Paths of files actually rendered (a subset of `sortedFiles` — may
   *  skip entries that failed to read or had no surface ranges). */
  paths: Set<string>;
}

interface AppendFileSectionsArgs {
  lines: string[];
  sortedFiles: FileEntry[];
  projectRoot: string;
  cg: Cartograph;
  subgraph: Subgraph;
  maxFiles: number;
  /** Task #2 — when true, emit per-file headers (defines/references)
   *  only; skip the fenced code blocks and the "### Source Code" heading. */
  summary: boolean;
}

function appendFileSections(args: AppendFileSectionsArgs): RenderedFiles {
  const { lines, sortedFiles, projectRoot, cg, subgraph, maxFiles, summary } = args;
  if (summary) lines.push('### Files', '');
  else lines.push('### Source Code', '');
  let totalChars = lines.join('\n').length;
  let filesIncluded = 0;
  const rendered = new Set<string>();

  for (const [filePath, group] of sortedFiles) {
    if (filesIncluded >= maxFiles) break;
    if (!summary && totalChars > EXPLORE_MAX_OUTPUT * 0.9) break;

    const fileLines = readFileLinesSafely(projectRoot, filePath);
    if (!fileLines) continue;

    const ranges = collectRangeRefs({ groupNodes: group.nodes, fileLineCount: fileLines.length, cg, subgraph });
    if (ranges.length === 0) continue;

    const clusters = clusterRanges(ranges);
    const lang = group.nodes[0]?.language ?? '';
    const { fileSection, allSymbols } = renderClusters(clusters, fileLines, lang);
    const { defines, references } = partitionDefinesReferences(allSymbols);

    if (summary) {
      // Summary mode: header only, no code block, no budget gate
      // (headers are cheap — a few hundred bytes per file at most).
      pushFileBlock({ lines, filePath, defines, references, lang, body: null, summary });
      filesIncluded++;
      rendered.add(filePath);
      continue;
    }

    const remainingBudget = EXPLORE_MAX_OUTPUT - totalChars - FILE_BUDGET_OVERHEAD_CHARS;
    if (fileSection.length > remainingBudget) {
      if (remainingBudget < MIN_FILE_BUDGET_CHARS) break;
      const trimmed = fileSection.slice(0, remainingBudget) + '\n// ... trimmed ...';
      pushFileBlock({ lines, filePath, defines, references, lang, body: trimmed, summary });
      totalChars += trimmed.length + FILE_BUDGET_OVERHEAD_CHARS;
      filesIncluded++;
      rendered.add(filePath);
      break;
    }

    pushFileBlock({ lines, filePath, defines, references, lang, body: fileSection, summary });
    totalChars += fileSection.length + FILE_BUDGET_OVERHEAD_CHARS;
    filesIncluded++;
    rendered.add(filePath);
  }
  return { count: filesIncluded, paths: rendered };
}

/** Symlink-safe file read returning split lines, or null on missing/unreadable. */
function readFileLinesSafely(projectRoot: string, filePath: string): string[] | null {
  const absPath = validatePathWithinRootReal(projectRoot, filePath);
  if (!absPath || !existsSync(absPath)) return null;
  try {
    return readFileSync(absPath, 'utf-8').split('\n');
  } catch {
    return null;
  }
}

/**
 * Collect line ranges to surface in the file: each analysable
 * node's start/end span, plus single-line ranges for outgoing
 * non-`contains` edges (template references, event handlers — they
 * aren't graph nodes themselves but the agent still wants to see
 * their call sites). Ranges sorted by start line for clustering.
 */
interface CollectRangeRefsArgs {
  groupNodes: Node[];
  fileLineCount: number;
  cg: Cartograph;
  subgraph: Subgraph;
}

function collectRangeRefs(args: CollectRangeRefsArgs): RangeRef[] {
  const { groupNodes, fileLineCount, cg, subgraph } = args;
  const ranges: RangeRef[] = groupNodes
    .filter((n) => n.startLine > 0 && n.endLine > 0)
    // Skip file/component nodes that span the entire file — they'd
    // create one giant cluster swallowing every other range.
    .filter((n) => !(n.kind === 'component' && n.startLine === 1 && n.endLine >= fileLineCount - 1))
    .map((n) => ({ start: n.startLine, end: n.endLine, name: n.name, kind: n.kind }));

  const seenEdges = new Set<string>(); // dedup by "line:target"
  for (const node of groupNodes) {
    for (const edge of getOutgoingEdges(cg.queries, node.id)) {
      if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
      // Skip self-loops (e.g. def_use where source === target) — they
      // produce phantom entries like `def_use(def_use)` in the header.
      if (edge.source === edge.target) continue;
      const key = `${edge.line}:${edge.target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      // Resolve the target node: prefer the in-subgraph fast path, then
      // fall back to the DB. If the target has no real name (anonymous /
      // synthetic node), skip this edge rather than printing the EdgeKind
      // value as if it were a symbol name (FRICTION-9).
      const targetNode = subgraph.nodes.get(edge.target) ?? cg.queries.getNodeById(edge.target);
      if (!targetNode?.name) continue;
      ranges.push({ start: edge.line, end: edge.line, name: targetNode.name, kind: edge.kind });
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Merge nearby ranges into a smaller number of clusters so the
 * rendered file section doesn't have huge gaps between distant
 * symbols. Two ranges merge when the next start is within
 * CLUSTER_GAP_THRESHOLD of the prior end.
 */
function clusterRanges(ranges: RangeRef[]): RangeCluster[] {
  if (ranges.length === 0) return [];
  const clusters: RangeCluster[] = [];
  let current: RangeCluster = {
    start: ranges[0]!.start,
    end: ranges[0]!.end,
    symbols: [{ name: ranges[0]!.name, kind: ranges[0]!.kind }],
  };

  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (r.start <= current.end + CLUSTER_GAP_THRESHOLD) {
      current.end = Math.max(current.end, r.end);
      current.symbols.push({ name: r.name, kind: r.kind });
    } else {
      clusters.push(current);
      current = { start: r.start, end: r.end, symbols: [{ name: r.name, kind: r.kind }] };
    }
  }
  clusters.push(current);
  return clusters;
}

/**
 * Materialise the actual file-section text from the clusters: each
 * cluster's [start - padding, end + padding] slice joined by a
 * `// ... (gap) ...` separator. Returns the combined section text
 * plus the flat symbol list for the file heading.
 *
 * Each cluster slice runs through {@link collapseCommentBlocks} BEFORE
 * the gap separators are added — collapsing on the joined text would
 * fold the `// ... (gap) ...` markers (themselves comment-only lines)
 * into the runs and corrupt them.
 */
function renderClusters(
  clusters: RangeCluster[],
  fileLines: string[],
  language: string,
): { fileSection: string; allSymbols: SymbolRef[] } {
  const allSymbols: SymbolRef[] = [];
  let fileSection = '';
  for (const cluster of clusters) {
    const startIdx = Math.max(0, cluster.start - 1 - CONTEXT_PADDING_LINES);
    const endIdx = Math.min(fileLines.length, cluster.end + CONTEXT_PADDING_LINES);
    const section = collapseCommentBlocks(fileLines.slice(startIdx, endIdx).join('\n'), language);
    if (fileSection.length > 0) fileSection += '\n\n// ... (gap) ...\n\n';
    fileSection += section;
    allSymbols.push(...cluster.symbols);
  }
  return { fileSection, allSymbols };
}

/**
 * Collapse long pure-comment blocks in a rendered source slice into a
 * single `// ... N lines of comments ...` marker so doc/license banners
 * don't crowd real code out of the EXPLORE_MAX_OUTPUT budget.
 *
 * Comment detection reuses {@link stripCommentsForRegex} (block comments,
 * Python triple-quotes, Ruby `=begin`, per-language line tokens) — it is
 * length- and newline-preserving, so a line is "pure comment" exactly
 * when stripping leaves it blank while the original was not. Lines with
 * trailing inline comments keep their code and are NOT collapsed. Runs
 * shorter than {@link MIN_COLLAPSIBLE_COMMENT_RUN} stay verbatim. An
 * unknown / empty language is a no-op (stripCommentsForRegex can't
 * classify it, so nothing is collapsed).
 *
 * Caveat — string-unawareness: stripCommentsForRegex's block-comment pass is
 * a regex, not a lexer, so the interior lines of a multi-line string /
 * template literal that happen to BE comment syntax (lines that are each a
 * standalone block comment) strip to blank and get collapsed as if they were
 * comments. This is a known, bounded limitation: it only affects how explore
 * RENDERS that span (the on-disk file is untouched and one Read away), and it
 * needs 4+ consecutive such lines inside a string to trigger. A real fix needs
 * a lexer; not worth it for a render-time token optimization. Locked by the
 * "string content that looks like comments" case in the test file.
 *
 * @internal Exported for `__tests__/explore-comment-collapse.test.ts`.
 */
export function collapseCommentBlocks(source: string, language: string): string {
  if (!language) return source;
  const lines = source.split('\n');
  const stripped = stripCommentsForRegex(source, language).split('\n');
  const isCommentOnly = (i: number): boolean => lines[i]!.trim() !== '' && (stripped[i] ?? '').trim() === '';

  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isCommentOnly(i)) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && isCommentOnly(j)) j++;
    const runLen = j - i;
    if (runLen >= MIN_COLLAPSIBLE_COMMENT_RUN) {
      const indent = lines[i]!.match(/^\s*/)?.[0] ?? '';
      out.push(`${indent}// ... ${runLen} lines of comments ...`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join('\n');
}

/**
 * Split symbol refs into `defines:` vs `references:` for the file
 * header (Task #3). A definition is a node-kind whose AST node IS
 * the declaration (function, class, interface, ...); everything else
 * — node-kinds like `parameter`/`field`/`property` AND edge-kind
 * labels surfaced from outgoing edges (`calls`, `type_of`, `imports`,
 * `instantiates`, `field_access`, ...) — is a reference. Dedups by
 * `(name, kind)` while preserving first-seen order.
 */
function partitionDefinesReferences(symbols: ReadonlyArray<SymbolRef>): { defines: string[]; references: string[] } {
  const defines: string[] = [];
  const references: string[] = [];
  const seenDef = new Set<string>();
  const seenRef = new Set<string>();
  for (const s of symbols) {
    const label = `${s.name}(${s.kind})`;
    if (DEFINITION_KINDS.has(s.kind)) {
      if (!seenDef.has(label)) {
        seenDef.add(label);
        defines.push(label);
      }
    } else {
      if (!seenRef.has(label)) {
        seenRef.add(label);
        references.push(label);
      }
    }
  }
  return { defines, references };
}

interface PushFileBlockArgs {
  lines: string[];
  filePath: string;
  defines: string[];
  references: string[];
  lang: string;
  /** Null in summary mode — header-only (Task #2). */
  body: string | null;
  /** Task #2 / audit-4 #8 — trims the header sublines harder. */
  summary: boolean;
}

/**
 * Render one capped `defines:` / `references:` subline (audit-4 #8).
 * A hub file's edge set can be 100+ entries; an uncapped comma-join is
 * the single largest token sink in `explore` output. Caps at `cap`
 * with a trailing `… and N more` continuation, mirroring every other
 * capped list in the codebase.
 */
function formatFileHeaderLine(label: string, entries: string[], cap: number): string {
  const shown = entries.slice(0, cap);
  const tail = entries.length > shown.length ? `, … and ${entries.length - shown.length} more` : '';
  return `${label}: ${shown.join(', ')}${tail}`;
}

/**
 * Write one file's heading + optional fenced code block into `lines`.
 *
 * Task #3 — header splits `defines:` (kinds whose AST node IS the
 * declaration) from `references:` (edge-kinds + non-declaration
 * node-kinds surfaced via outgoing edges). Either line is omitted
 * when empty so the header stays compact.
 *
 * Task #2 — when `body` is null, only the header is emitted.
 */
function pushFileBlock(args: PushFileBlockArgs): void {
  const { lines, filePath, defines, references, lang, body, summary } = args;
  const cap = summary ? MAX_FILE_HEADER_ENTRIES_SUMMARY : MAX_FILE_HEADER_ENTRIES;
  lines.push(`#### ${filePath}`);
  if (defines.length > 0) lines.push(formatFileHeaderLine('defines', defines, cap));
  if (references.length > 0) lines.push(formatFileHeaderLine('references', references, cap));
  lines.push('');
  if (body === null) return;
  lines.push('```' + lang, body, '```', '');
}

/**
 * After the per-file sections, append a flat reference list of
 * everything that didn't make it in (relevant files past the budget
 * + peripheral score-< floor files), capped at
 * MAX_REMAINING_FILES_SHOWN.
 */
interface AppendRemainingFilesArgs {
  lines: string[];
  fileGroups: Map<string, FileGroup>;
  sortedFiles: FileEntry[];
  rendered: ReadonlySet<string>;
}

function appendRemainingFiles(args: AppendRemainingFilesArgs): void {
  const { lines, fileGroups, sortedFiles, rendered } = args;
  const remainingRelevant = sortedFiles.filter(([path]) => !rendered.has(path));
  const peripheralFiles = [...fileGroups.entries()]
    .filter(([, group]) => group.score < RELEVANT_FILE_SCORE_FLOOR)
    .sort((a, b) => b[1].score - a[1].score);
  const remainingFiles = [...remainingRelevant, ...peripheralFiles];
  if (remainingFiles.length === 0) return;

  lines.push('### Additional relevant files (not shown)', '');
  for (const [filePath, group] of remainingFiles.slice(0, MAX_REMAINING_FILES_SHOWN)) {
    const symbols = group.nodes.map((n) => `${n.name}:${n.startLine}`).join(', ');
    lines.push(`- ${filePath}: ${symbols}`);
  }
  if (remainingFiles.length > MAX_REMAINING_FILES_SHOWN) {
    lines.push(`- ... and ${remainingFiles.length - MAX_REMAINING_FILES_SHOWN} more files`);
  }
}

interface AppendCompletenessAndBudgetArgs {
  lines: string[];
  cg: Cartograph;
  filesIncluded: number;
  summary: boolean;
}

/**
 * Two trailing footers: a "complete source code is included above —
 * don't re-Read these files" signal so the agent doesn't double-read,
 * and an explore-budget cap so it stops calling `cartograph_explore`
 * once the per-project quota is hit.
 */
function appendCompletenessAndBudget(args: AppendCompletenessAndBudgetArgs): void {
  const { lines, cg, filesIncluded, summary } = args;
  const fileWord = filesIncluded === 1 ? 'file' : 'files';
  lines.push('', '---');
  if (summary) {
    lines.push(
      `> **Summary mode: per-file headers only for ${filesIncluded} ${fileWord}.** Source-code blocks are suppressed; ` +
        `re-call with \`summary: false\` (or pass the call UID as \`since\`) to fetch source.`,
    );
  } else {
    lines.push(
      `> **Complete source code is included above for ${filesIncluded} ${fileWord}.** You do NOT need to re-read these files — the relevant sections are already shown in full. Only use Read/Grep for files listed under "Additional relevant files" if you need more detail.`,
    );
  }

  try {
    const stats = cg.stats.getStats();
    const budget = getExploreBudget(stats.fileCount);
    lines.push(
      '',
      `> **Explore budget: ${budget} calls max for this project (${stats.fileCount.toLocaleString()} files indexed).** Stop exploring and synthesize your answer once you've used ${budget} calls — do NOT make additional explore calls beyond this budget.`,
    );
  } catch {
    // Stats unavailable — skip budget note
  }
}

export const EXPLORE_TOOL = defineTool({
  name: 'cartograph_explore',
  description:
    'Deep multi-call exploration of a topic for "I am new here" surveys. ' +
    'Takes SPECIFIC symbol/file names or short code terms, NOT natural-language sentences. ' +
    'Good: `"readAgentsFromDirectory createClaudeSession chat-manager agents.ts"`; ' +
    'bad: `"how are agent prompts loaded"`. ' +
    'Token control: `summary: true` keeps only the relationship map and per-file `defines:`/`references:` headers; ' +
    '`since: c_xxxxxxxx` pages new rows vs a prior call.',
  schema: exploreSchema,
  handle: handleExplore,
});
