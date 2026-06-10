/**
 * @internal Private helper module for `cartograph_graph` (direction='impact'|'both').
 *
 * Pre-merge this was the standalone `cartograph_impact` MCP tool. After the
 * 2026-05-11 four-tool merge the public surface is `cartograph_graph`; only
 * the {@link handleImpact} entry point remains exported. Used by `graph.ts`
 * when the agent asks for impact-style transitive blast radius (per-file
 * concentration rollup + per-source breakdown) instead of a flat BFS.
 */
import type { ToolResult } from '../tool-types.js';
import type { Subgraph } from '../../graph/types.js';
import type { Edge, EdgeKind, Node } from '../../types.js';
import { clamp, isTestPath, numArg } from '../../utils.js';
import { textResult, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { CONFIDENCE_RANK, parseMinConfidence } from './result-formatters.js';
import { findAllSymbols, isUnresolvedUid, staleUidMessage, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/**
 * Drop test-file targets from an impact subgraph. Mirrors the
 * `_walk.ts` BFS-side filter (FRICTION-8) on the impact code path so
 * `direction: 'impact'` from a production symbol doesn't surface
 * test-file consumers by default either. Roots are always kept so a
 * test-file start (the inverse case) doesn't self-prune; but the
 * caller-level default already short-circuits the inverse case by
 * forcing `includeTests: true` before this runs.
 *
 * Drops edges referencing pruned nodes for consistency (the rollup /
 * per-file detail formatters key off `nodes`, but downstream
 * stale-files-note and confidence filter consume edges too — keeping
 * the subgraph internally consistent avoids surprises).
 */
function filterImpactByTestFiles(impact: Subgraph, rootIds: ReadonlySet<string>): Subgraph {
  const survivingNodes = new Map<string, Node>();
  for (const [id, n] of impact.nodes) {
    if (rootIds.has(id) || !isTestPath(n.filePath)) {
      survivingNodes.set(id, n);
    }
  }
  // Fast path: nothing pruned — return input.
  if (survivingNodes.size === impact.nodes.size) return impact;
  const survivingEdges = impact.edges.filter((e) => survivingNodes.has(e.source) && survivingNodes.has(e.target));
  return {
    nodes: survivingNodes,
    edges: survivingEdges,
    roots: impact.roots,
  };
}

/**
 * Drop edges below `threshold` from an impact subgraph, then drop
 * nodes that became unreachable from `rootId` along the surviving
 * edges. BFS from the root keeps the impact tree consistent — a
 * symbol reached only via a low-confidence edge shouldn't appear in
 * the post-filter "Affected" listing.
 *
 * Threshold 0 (no filter) returns the input untouched without copying.
 */
function filterImpactByConfidence(impact: Subgraph, rootId: string, threshold: number): Subgraph {
  if (threshold <= 0) return impact;
  const survivingEdges = impact.edges.filter((e) => CONFIDENCE_RANK[e.confidence ?? 'EXTRACTED'] >= threshold);
  const reachable = new Set<string>([rootId]);
  // BFS along surviving edges — both forward and backward, since
  // getImpactRadius returns a bidirectional neighborhood.
  const adj = new Map<string, string[]>();
  // get-or-create + push (NOT spread-and-reassign): a spread copies the
  // node's whole accumulated neighbour array per edge, which is O(degree²)
  // and explodes on hub nodes (10–20k incoming edges) at scale.
  const pushNeighbor = (from: string, to: string): void => {
    let list = adj.get(from);
    if (!list) adj.set(from, (list = []));
    list.push(to);
  };
  for (const e of survivingEdges) {
    pushNeighbor(e.source, e.target);
    pushNeighbor(e.target, e.source);
  }
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  const filteredNodes = new Map<string, Node>();
  for (const [id, n] of impact.nodes) {
    if (reachable.has(id)) filteredNodes.set(id, n);
  }
  return {
    nodes: filteredNodes,
    edges: survivingEdges,
    roots: impact.roots,
  };
}

/**
 * Max impact traversal depth (5). Matches the `hops` cap documented by
 * the `cartograph_graph` schema, the playbook, and the CLI `--hops`
 * help — `direction: impact` forwards `hops → depth`, so the impact
 * clamp must agree with the BFS cap or `--hops` silently means
 * something different on the two paths (audit-4 #3).
 */
const IMPACT_MAX_DEPTH = 5;

/** Per-file row cap (25) for the "Concentration by file" rollup. The
 *  tool can easily return 200+ symbols at depth ≥ 3 on central types
 *  — capping at 25 keeps a typical hot type (50-100 affected nodes)
 *  scannable while still surfacing the worst offenders. */
const IMPACT_PER_FILE_CAP = 25;

/** Affected-node count (50) above which the impact response is
 *  treated as a "wide blast" — switches the formatting from per-file
 *  detail to a higher-level rollup. */
const IMPACT_WIDE_BLAST_THRESHOLD = 50;

/** Hard cap (20) on files that receive full per-file detail listings.
 *  Without this, depth=10 on a hub type in a 1000+ file project would
 *  emit per-file detail for hundreds of files
 *  and truncate the MCP response. The rollup keeps a longer overview;
 *  only the detail dump is bounded here. */
const IMPACT_DETAIL_FILES_CAP = 20;

/** Per-source file cap (5) for multi-source name resolution. When a
 *  name resolves to multiple sources (e.g. 6 different `Encode`
 *  methods), the merged "Concentration by file" rollup loses
 *  attribution — the per-source rollup attaches it back, capped tight
 *  so a 6-source name doesn't multiply the rollup section by 6×. */
const IMPACT_PER_SOURCE_FILES_CAP = 5;

/**
 * Insert a section right after the first markdown title (`## ...`) in
 * `body`. Used to prepend the per-source breakdown without disturbing
 * the rest of the formatted impact output.
 */
function injectAfterTitle(body: string, section: string): string {
  const lines = body.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('## '));
  if (titleIdx < 0) return section + '\n' + body;
  // Insert after the title line (and its trailing blank line, if any).
  const hasBlankAfterTitle = lines[titleIdx + 1] === '';
  const insertAt = hasBlankAfterTitle ? titleIdx + 2 : titleIdx + 1;
  lines.splice(insertAt, 0, section);
  return lines.join('\n');
}

/** One row of the "Source symbols" H3 bullet-list, sorted by impact
 *  size (descending). Sources with larger `nodes` maps surface first
 *  so the most-impactful symbol is at the top of the section. */
interface ImpactSourceRow {
  node: Node;
  nodes: Map<string, Node>;
}

/**
 * Build the "Source symbols" H3 bullet-list spec — the size-attribution
 * section of the per-source impact breakdown. One bullet per matched
 * source symbol with its file:line location + node kind + reachable
 * symbol count.
 *
 * Caller (`formatPerSourceImpact`) is only reached when multiple
 * source matches exist (the multi-source branch), so empty `rows` is
 * unreachable; `emptyState: ''` is the never-rendered empty string.
 */
export function buildImpactSourceSymbolsSpec(
  sources: ReadonlyArray<ImpactSourceRow>,
): MarkdownBulletListSpec<ImpactSourceRow> {
  return {
    title: 'Source symbols',
    headingLevel: 3,
    rows: sources,
    formatRow: ({ node, nodes }) => {
      const loc = node.startLine ? `:${node.startLine}` : '';
      return `- \`${node.filePath}${loc}\` (${node.kind}) → ${nodes.size} symbols`;
    },
    emptyState: '',
  };
}

/**
 * Per-source breakdown for ambiguous names (multi-source impact).
 * Renders "### Source symbols" (size attribution) plus "### Concentration
 * by file per source" (file-attribution) so the per-file rollup that
 * follows in formatImpact is interpretable.
 */
function formatPerSourceImpact(perSource: Array<{ node: Node; nodes: Map<string, Node> }>): string {
  const sorted = [...perSource].sort((a, b) => b.nodes.size - a.nodes.size);

  const lines: string[] = [renderMarkdownBulletList(buildImpactSourceSymbolsSpec(sorted))];

  // "### Concentration by file per source" stays hand-built — its
  // body uses `**file:**` bold-prefix sub-headers per source. The
  // KeyValueCard spec now exists (see {@link MarkdownKeyValueCardSpec}),
  // but each per-source block is a SEPARATE KV card under a shared
  // H3 (a multi-card-list shape that the current spec doesn't model
  // — one card per source under one umbrella heading). Queued for a
  // future batch; the natural migration path is either a nested
  // CardListSpec-of-KeyValueCardSpec or accepting the shared H3 as
  // hand-built chrome while migrating each per-source block.
  lines.push(
    '### Concentration by file per source',
    '',
    '> The merged "Concentration by file" further down sums these per-source rollups; same files may appear in both views.',
    '',
  );
  for (const { node, nodes } of sorted) {
    const loc = node.startLine ? `:${node.startLine}` : '';
    const byFile = new Map<string, number>();
    for (const n of nodes.values()) {
      byFile.set(n.filePath, (byFile.get(n.filePath) ?? 0) + 1);
    }
    const rollup = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
    const shown = rollup.slice(0, IMPACT_PER_SOURCE_FILES_CAP);

    lines.push(`**\`${node.filePath}${loc}\`:**`);
    for (const [file, count] of shown) {
      lines.push(`- \`${file}\` — ${count}`);
    }
    const elided = rollup.length - shown.length;
    if (elided > 0) {
      lines.push(`- … and ${elided} more files`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Bundled args for {@link formatImpact}. */
interface FormatImpactArgs {
  /** The symbol whose impact is being formatted. */
  readonly symbol: string;
  /** The impact subgraph (affected nodes + edges). */
  readonly impact: Subgraph;
  /** Effective traversal depth — surfaced in the header. */
  readonly depth: number;
  /** Whether the impact aggregates more than one source match.
   *  Defaults to `false`. */
  readonly multiSource?: boolean;
}

function formatImpact(args: FormatImpactArgs): string {
  const { symbol, impact, depth, multiSource = false } = args;
  const nodeCount = impact.nodes.size;
  const lines: string[] = [
    // Surface the effective traversal depth so a `hops` clamp (audit-4
    // #3) is visible — mirrors the BFS walk header's `hops=N` (#4).
    `## Impact: "${symbol}" (depth ${depth}) affects ${nodeCount} symbols`,
    '',
  ];

  // High-blast-radius warning. Above this size the result stops being
  // a "what should I worry about" answer and becomes a flood — the
  // agent likely wants to narrow the question (lower depth, or a
  // narrower symbol).
  if (nodeCount > IMPACT_WIDE_BLAST_THRESHOLD) {
    lines.push(
      `> ⚠ Wide blast radius (${nodeCount} symbols). Consider narrowing: lower \`hops\` (try 1), or pick a more specific symbol. The per-file rollup below shows where impact concentrates.`,
      '',
    );
  }

  // Group by file.
  const byFile = new Map<string, Node[]>();
  for (const node of impact.nodes.values()) {
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  const rollup = Array.from(byFile.entries())
    .map(([file, nodes]) => ({ file, count: nodes.length }))
    .sort((a, b) => b.count - a.count);

  appendImpactRollup(lines, rollup, nodeCount);
  appendImpactPerFileDetail({ lines, byFile, rollup, multiSource });
  return lines.join('\n');
}

/** Top-N file-count rollup cap for the "Concentration by file"
 *  bullet-list rendered by {@link buildImpactConcentrationSpec} +
 *  {@link appendImpactRollup}. */
const IMPACT_CONCENTRATION_ROLLUP_TOP = 10;

/**
 * Build the "Concentration by file" H3 bullet-list spec. Rows are
 * pre-rendered `- \`file\` — N` bullets plus an optional
 * `- … and N more files` overflow row at {@link IMPACT_CONCENTRATION_ROLLUP_TOP}
 * (10) — identity formatRow, same pattern as changed-since /
 * imports / grep per-file overflow rendering.
 *
 * Caller (`appendImpactRollup`) guards on `showRollup` (suppressed
 * for tiny single-file results) BEFORE invoking the builder, so the
 * spec's `emptyState: ''` is the never-rendered empty string.
 */
export function buildImpactConcentrationSpec(
  rollup: ReadonlyArray<{ file: string; count: number }>,
): MarkdownBulletListSpec<string> {
  const shown = rollup.slice(0, IMPACT_CONCENTRATION_ROLLUP_TOP);
  const overflow = rollup.length - shown.length;
  const bullets = shown.map(({ file, count }) => `- \`${file}\` — ${count}`);
  const rows = overflow > 0 ? [...bullets, `- … and ${overflow} more files`] : bullets;
  return {
    title: 'Concentration by file',
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
  };
}

/**
 * Render the "Concentration by file" rollup. Lets the agent see concentration
 * (e.g. "57 in queries.ts, 12 elsewhere") before scrolling into the details.
 * Suppressed for tiny single-file results unless the blast radius is wide.
 */
function appendImpactRollup(lines: string[], rollup: { file: string; count: number }[], nodeCount: number): void {
  const showRollup = rollup.length > 1 || nodeCount > IMPACT_WIDE_BLAST_THRESHOLD;
  if (!showRollup) return;
  lines.push(renderMarkdownBulletList(buildImpactConcentrationSpec(rollup)));
}

/**
 * Render the per-file detail section. Sort within each file by descending
 * centrality so structurally important symbols come first; cap nodes per file
 * and total files so a god-class or hub-type doesn't blow the budget.
 */
interface AppendImpactPerFileDetailArgs {
  lines: string[];
  byFile: Map<string, Node[]>;
  rollup: { file: string; count: number }[];
  multiSource: boolean;
}

function appendImpactPerFileDetail(args: AppendImpactPerFileDetailArgs): void {
  const { lines, byFile, rollup, multiSource } = args;
  const detailFiles = rollup.slice(0, IMPACT_DETAIL_FILES_CAP);
  const elidedFiles = rollup.length - detailFiles.length;
  if (multiSource && detailFiles.length > 0) {
    lines.push(
      '> Per-file symbols below merge across all sources. See "Concentration by file per source" above for source attribution.',
      '',
    );
  }
  for (const { file } of detailFiles) {
    const nodes = byFile.get(file)!;
    nodes.sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0));
    const shown = nodes.slice(0, IMPACT_PER_FILE_CAP);
    const overflow = nodes.length - shown.length;
    lines.push(`**${file}:**`);
    const nodeList = shown.map((n) => `${n.name}:${n.startLine}`).join(', ');
    const tail = overflow > 0 ? `, … (+${overflow} more)` : '';
    lines.push(nodeList + tail, '');
  }
  if (elidedFiles > 0) {
    const elidedSymbols = rollup.slice(IMPACT_DETAIL_FILES_CAP).reduce((sum, r) => sum + r.count, 0);
    lines.push(
      `> Detail elided for ${elidedFiles} more file${elidedFiles === 1 ? '' : 's'} (${elidedSymbols} symbol${elidedSymbols === 1 ? '' : 's'}). Lower \`hops\` or pick a more specific symbol to see them.`,
      '',
    );
  }
}

/**
 * Aggregate impact across all matching symbols. Track per-source impact node
 * maps so the caller can both (a) break down total counts per definition and
 * (b) emit a per-source file-rollup that preserves attribution the merged
 * rollup cannot.
 */
interface AggregateImpactAcrossMatchesArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  matches: Node[];
  depth: number;
  confidenceThreshold: number;
  /** When false, drop test-file targets from each per-source impact
   *  subgraph and from the merged result. Mirrors the BFS-side filter
   *  in `_walk.ts`. The handler computes the effective value (default
   *  false for prod-symbol starts; forced true when the start lives
   *  in a test file). */
  includeTests: boolean;
  /** Explicit edge-kind filter forwarded from `cartograph_graph`. Omitted
   *  preserves the legacy all-impact-edges traversal. */
  edgeKind: EdgeKind | undefined;
}

function aggregateImpactAcrossMatches(args: AggregateImpactAcrossMatchesArgs): {
  mergedNodes: Map<string, Node>;
  mergedEdges: Edge[];
  perSource: Array<{ node: Node; nodes: Map<string, Node> }>;
} {
  const { cg, matches, depth, confidenceThreshold, includeTests, edgeKind } = args;
  const mergedNodes = new Map<string, Node>();
  const mergedEdges: Edge[] = [];
  const seenEdges = new Set<string>();
  const perSource: Array<{ node: Node; nodes: Map<string, Node> }> = [];

  for (const node of matches) {
    const impact = cg.internals.traverser.getImpactRadius(
      node.id,
      depth,
      edgeKind === undefined ? undefined : [edgeKind],
    );
    const confidenceFiltered = filterImpactByConfidence(impact, node.id, confidenceThreshold);
    // Apply the test-file filter AFTER the confidence pass so the
    // root is preserved in both stages (filterImpactByConfidence keeps
    // the root via its BFS-from-root reachability check; the
    // test-filter receives a `rootIds` set that includes the root).
    const filtered = includeTests
      ? confidenceFiltered
      : filterImpactByTestFiles(confidenceFiltered, new Set([node.id]));
    perSource.push({ node, nodes: filtered.nodes });
    for (const [id, n] of filtered.nodes) mergedNodes.set(id, n);
    for (const e of filtered.edges) {
      const key = `${e.source}->${e.target}:${e.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      mergedEdges.push(e);
    }
  }
  return { mergedNodes, mergedEdges, perSource };
}

interface BuildImpactResponseArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  allMatches: ReturnType<typeof findAllSymbols>;
  depth: number;
  confidenceThreshold: number;
  /** Effective test-file filter for this call. Defaults are resolved
   *  in {@link handleImpact} (false for prod starts, true when ANY
   *  match lives in a test file — the inverse "what does my test
   *  impact" case stays usable). Explicit caller `includeTests` wins. */
  includeTests: boolean;
  /** Explicit edge-kind filter forwarded from `cartograph_graph`. */
  edgeKind: EdgeKind | undefined;
  /** Render a terse pipe-delimited impact summary instead of markdown detail. */
  compact: boolean;
}

/** Aggregate, format, and wrap the impact result. Extracted from {@link handleImpact}. */
function buildImpactResponse(args: BuildImpactResponseArgs): ToolResult {
  const { cg, symbol, allMatches, depth, confidenceThreshold, includeTests, edgeKind, compact } = args;
  // #8 confidence filter: drop edges below threshold AND prune nodes that
  // become unreachable from the root along surviving edges.
  // FRICTION-8 (impact path): also drop test-file targets unless the
  // caller opted in or the start lives in a test file.
  const { mergedNodes, mergedEdges, perSource } = aggregateImpactAcrossMatches({
    cg,
    matches: allMatches.nodes,
    depth,
    confidenceThreshold,
    includeTests,
    edgeKind,
  });
  const mergedImpact = { nodes: mergedNodes, edges: mergedEdges, roots: allMatches.nodes.map((n) => n.id) };
  if (compact) {
    return renderToolResponse({
      body: formatImpactCompact({ symbol, impact: mergedImpact, depth }) + allMatches.note,
      freshness: { cg, nodes: [...mergedNodes.values()] },
    });
  }
  const multiSource = perSource.length > 1;
  const base = formatImpact({ symbol, impact: mergedImpact, depth, multiSource });
  const withPerSource = multiSource ? injectAfterTitle(base, formatPerSourceImpact(perSource)) : base;
  return renderToolResponse({
    body: withPerSource + allMatches.note,
    freshness: { cg, nodes: [...mergedNodes.values()] },
  });
}

function formatImpactCompact(args: FormatImpactArgs): string {
  const { symbol, impact, depth } = args;
  const byFile = new Map<string, number>();
  for (const node of impact.nodes.values()) {
    byFile.set(node.filePath, (byFile.get(node.filePath) ?? 0) + 1);
  }
  const fileRows = [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  const nodeRows = [...impact.nodes.values()]
    .sort(
      (a, b) =>
        (b.centrality ?? 0) - (a.centrality ?? 0) || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine,
    )
    .slice(0, 20);
  const lines = [
    `impact|${symbol}|depth=${depth}|nodes=${impact.nodes.size}|edges=${impact.edges.length}|files=${byFile.size}`,
  ];
  for (const [file, count] of fileRows) lines.push(`file|${file}|count=${count}`);
  for (const node of nodeRows) {
    lines.push(`node|${node.name}|${node.kind}|${node.filePath}:${node.startLine}`);
  }
  return lines.join('\n');
}

export async function handleImpact(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = validateStringOutcome({ value: args['symbol'], name: 'symbol' });
  if (typeof symbol !== 'string') return symbol;

  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  // Clamp impact traversal depth to 5 — matching the documented `hops`
  // cap stated by the `cartograph_graph` schema, the playbook, and the
  // CLI `--hops` help (audit-4 #3). Pre-fix the cap was 10, so
  // `--hops 99 -d impact` ran at depth 10 and quietly violated the
  // stated contract.
  const depth = clamp(numArg(args['depth'], 1), 1, IMPACT_MAX_DEPTH);
  const minConfidenceParsed = parseMinConfidence(args['minConfidence']);
  if (minConfidenceParsed !== null && typeof minConfidenceParsed !== 'string') return minConfidenceParsed;
  const confidenceThreshold = minConfidenceParsed ? CONFIDENCE_RANK[minConfidenceParsed] : 0;

  const allMatches = findAllSymbols(cg, symbol, ctx.refIds);
  if (allMatches.nodes.length === 0) {
    // A `n_` UID the current process can't resolve is a cache miss,
    // not a genuine absence — emit a UID-specific message without the
    // misleading "true negative" freshness footer (audit-4 #1).
    if (isUnresolvedUid(symbol, ctx.refIds)) {
      return err(staleUidMessage(symbol));
    }
    return ok(textResult(symbolNotFound(cg, symbol)));
  }

  // FRICTION-8 mirrored on the impact path. Default: when the start
  // lives in production code AND the caller did NOT pass
  // `includeTests`, drop test-file targets from the result + per-file
  // rollup. Override: explicit `includeTests: true` restores the old
  // behaviour. Inverse: when ANY matched start node lives in a test
  // file, default to `includeTests: true` so "what does my test
  // impact" stays usable.
  const includeTestsRaw = args['includeTests'];
  let includeTests: boolean;
  if (includeTestsRaw === true) {
    includeTests = true;
  } else if (includeTestsRaw === false) {
    includeTests = false;
  } else {
    // Undefined / unrecognised — pick default from start-node paths.
    includeTests = allMatches.nodes.some((n) => isTestPath(n.filePath));
  }

  const edgeKind = typeof args['edgeKind'] === 'string' ? (args['edgeKind'] as EdgeKind) : undefined;

  return ok(
    buildImpactResponse({
      cg,
      symbol,
      allMatches,
      depth,
      confidenceThreshold,
      includeTests,
      edgeKind,
      compact: args['compact'] === true || args['lowTokens'] === true,
    }),
  );
}

// IMPACT_TOOL export removed in the 2026-05-11 four-tool merge. The public
// surface is now `cartograph_graph({direction: 'impact'})`; this module is
// reached only via that tool's dispatcher in `graph.ts`.
