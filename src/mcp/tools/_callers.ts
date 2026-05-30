/**
 * @internal Private helper module for `cartograph_graph` (direction='callers', hops=1).
 *
 * Pre-merge this was the standalone `cartograph_callers` MCP tool. After
 * the 2026-05-11 four-tool merge it's reachable only via `cartograph_graph`'s
 * dispatcher in `graph.ts`. The TOOL export is gone; only the {@link handleCallers}
 * entry point remains so the public tool can forward direction='callers' +
 * hops=1 calls verbatim.
 */
import type { ToolResult } from '../tool-types.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getSymbolRoles } from '../../db/queries-roles.js';
import type Cartograph from '../../index.js';
import type { QueryBuilder } from '../../db/queries.js';
import type { Edge, Node } from '../../types.js';
import { getEnclosingTestName } from '../../db/queries-test-names.js';
import { clamp, isTestPath, numArg } from '../../utils.js';
import {
  CONFIDENCE_RANK,
  filterByConfidence,
  formatConfidence,
  formatNodeList,
  formatSiteCount,
  parseMinConfidence,
} from './result-formatters.js';
import {
  applyDeltaSince,
  mintCallId,
  parseFieldsArg,
  textResult,
  TYPE_LIKE_KINDS,
  TYPE_USAGE_EDGE_KINDS,
  validateStringOutcome,
  type CompactFieldName,
} from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, notFoundMessage, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/**
 * Default "no callers" italic note — emitted by
 * {@link buildCallersGroupSpec} when a per-source section has no
 * incoming edges and the source is NOT a constructor (constructors
 * route through {@link CALLERS_CONSTRUCTOR_HINT} instead). Exported
 * so the wording-lint can pin it without re-stating the string.
 */
export const CALLERS_NO_CALLERS_NOTE = '_No callers._';

/**
 * Constructor-specific empty-callers hint. Constructors are invoked
 * via `new ClassName(...)`, which graph-edges as `instantiates` on
 * the parent class — not as a `call` edge on the constructor method
 * itself. Without this hint the agent reads "_No callers._" and gives
 * up; with it they get a one-step pointer to the right query.
 */
export const CALLERS_CONSTRUCTOR_HINT =
  '> Note: constructors are invoked via `new ClassName(...)`, which graph-edges as `instantiates` on the parent class. To find construction sites, run cartograph_callers on the enclosing class instead of "constructor".';

/** Maximum symbols accepted by the `symbols` batch parameter. Mirror
 *  of {@link BATCHED_SYMBOLS_MAX} from `_common-fields.ts`, so the
 *  schema-side Zod cap and any defense-in-depth runtime checks share
 *  one source of truth. */
const MAX_SYMBOLS = BATCHED_SYMBOLS_MAX;
export const CALLERS_MAX_SYMBOLS = MAX_SYMBOLS;

// TYPE_LIKE_KINDS / TYPE_USAGE_EDGE_KINDS live in shared.ts as the
// single source of truth for both this file and node.ts. Keep the
// local Set form too because the type-usage merge in
// `appendTypeUsersForNode` does an O(1) `has()` check rather than
// a list scan when iterating ALL incoming edges of a popular type.
const TYPE_USAGE_EDGE_KIND_SET: ReadonlySet<string> = new Set<string>(TYPE_USAGE_EDGE_KINDS);

/**
 * Per-source: combine the regular call-edge callers with the
 * type-usage incoming edges (when the source is a type-like kind).
 * Without the type-usage merge, multi-match queries on a class name
 * like `callers of Dup` (where `Dup` is defined in two files and a
 * caller does `new Dup()` against the imported one) would render
 * "_No callers._" even though `instantiates` edges exist correctly
 * in the graph — `traverser.getCallers` filters to call-edge kinds
 * only, so the data was hidden by the formatter, not absent.
 *
 * Each row carries an `edge` so the formatter can render a site
 * count via {@link formatSiteCount}. Returns deduped sources (a
 * caller that both calls a method on the type AND instantiates it
 * appears once, with the call-edge winning).
 */
interface CollectCallersForSourceArgs {
  cg: Cartograph;
  source: Node;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

function collectCallersForSource(args: CollectCallersForSourceArgs): Array<{ node: Node; edge: Edge }> {
  const { cg, source, edgeKindFilter, minConfidence } = args;
  const callRows = edgeKindFilter
    ? cg.internals.traverser.getCallers(source.id).filter((c) => c.edge.kind === edgeKindFilter)
    : cg.internals.traverser.getCallers(source.id);

  if (!TYPE_LIKE_KINDS.has(source.kind)) return filterByConfidence(callRows, minConfidence);

  const seen = new Set<string>(callRows.map((r) => r.node.id));
  const merged = [...callRows];
  // Push the kind filter into SQL — saves walking structural
  // (`contains`) edges in JS on a popular type.
  for (const e of getIncomingEdges(cg.queries, source.id, TYPE_USAGE_EDGE_KINDS)) {
    if (edgeKindFilter && e.kind !== edgeKindFilter) continue;
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    const node = cg.queries.getNodeById(e.source);
    if (node) merged.push({ node, edge: e });
  }
  return filterByConfidence(merged, minConfidence);
}

/**
 * Collect the call-site lines an edge represents. The edge carries
 * the first site as `edge.line` and any de-duplicated extras in
 * `metadata.extraLines`. Returns a deduped, ascending list. Used by
 * {@link expandTestFileCaller} to fan out one row per site when the
 * caller node is a test-file file-row. Also reused by
 * `cartograph_tests_for` to scope a test file's `it/describe` blocks
 * to those that actually exercise the queried symbol.
 */
export function callSiteLinesFromEdge(edge: Edge): number[] {
  const lines = new Set<number>();
  if (typeof edge.line === 'number' && edge.line > 0) lines.add(edge.line);
  const meta = edge.metadata as { extraLines?: number[] } | undefined;
  if (meta?.extraLines) {
    for (const ln of meta.extraLines) {
      if (typeof ln === 'number' && ln > 0) lines.add(ln);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Expand one test-file file-node caller into per-call-site rows.
 *
 * Friction-D fix (2026-05-14): the renderer was anchoring test-file
 * callers at line 1 of the file (`startLine = 1` for the file row),
 * forcing the agent to follow up with `at_range` to find the actual
 * `it/describe` block. When the caller is a `kind = file` node AND
 * the file is a test path, fan the row out using the edge's
 * `siteCount + extraLines` metadata and anchor each site on the
 * enclosing `it/describe(...)` descriptor mined into `test_names`.
 *
 * Strategy per site:
 *   1. `getEnclosingTestName` returns the descriptor with the largest
 *      `line` value that's still ≤ the call-site line — the innermost
 *      test case in practice. Synthesise a node with that line +
 *      `<file>::"description"` as the row label.
 *   2. If no descriptor is above the line (call sits before the first
 *      `it/describe` — module-scope setup, top-level import, etc.),
 *      anchor on the call-site line itself rather than line 1.
 *
 * Returns the original `(node, edge)` row when the file isn't a test
 * path so non-test paths are unaffected (changing those would be
 * invasive). Returns a single row at the edge line for test files with
 * no test_names entries (`test_names` may be empty for a freshly
 * indexed project before the index hook runs).
 */
/**
 * Core expansion logic: takes `QueryBuilder` directly so it can be
 * reused by both the `Cartograph`-bearing MCP tool path (via
 * `expandTestFileCallers`) and the `QueryBuilder`-only review path
 * (via `expandTestFileCallersWithQueries`).
 */
function expandTestFileCallerCore(
  queries: QueryBuilder,
  row: { node: Node; edge: Edge },
): Array<{ node: Node; edge: Edge }> {
  const { node, edge } = row;
  if (node.kind !== 'file' || !isTestPath(node.filePath)) return [row];

  const siteLines = callSiteLinesFromEdge(edge);
  if (siteLines.length === 0) return [row];

  const expanded: Array<{ node: Node; edge: Edge }> = [];
  // Strip siteCount/extraLines on per-site rows so `formatSiteCount`
  // doesn't append the now-redundant "(3 call sites: 60, 74, 85)"
  // tail — we've already fanned the rows out, one per site.
  const perSiteMeta =
    edge.metadata && typeof edge.metadata === 'object'
      ? Object.fromEntries(Object.entries(edge.metadata).filter(([k]) => k !== 'siteCount' && k !== 'extraLines'))
      : undefined;
  for (const callLine of siteLines) {
    const test = getEnclosingTestName(queries, { filePath: node.filePath, line: callLine });
    // Two cases:
    //   - test_names hit: anchor at the descriptor's line, name shows the description.
    //   - no hit:         anchor at the call-site line, keep the file name.
    // Either way avoid line 1 and avoid forcing a follow-up at_range.
    const anchorLine = test?.line ?? callLine;
    const synthName = test ? `${node.name}::"${test.description}"` : node.name;
    const perSiteEdge: Edge = {
      ...edge,
      line: callLine,
      ...(perSiteMeta && Object.keys(perSiteMeta).length > 0 ? { metadata: perSiteMeta } : { metadata: undefined }),
    };
    expanded.push({
      // Synthesise a fresh row per site so the formatter renders one
      // bullet per call. Distinct synthetic ids prevent the dedup set
      // upstream from collapsing them.
      node: { ...node, id: `${node.id}#site:${anchorLine}`, startLine: anchorLine, name: synthName },
      edge: perSiteEdge,
    });
  }
  return expanded;
}

/** Thin wrapper kept for call sites that already have a `Cartograph`. */
function expandTestFileCaller(cg: Cartograph, row: { node: Node; edge: Edge }): Array<{ node: Node; edge: Edge }> {
  return expandTestFileCallerCore(cg.queries, row);
}

/**
 * Apply {@link expandTestFileCallerCore} to every row in a list. Preserves
 * order; non-test-file rows pass through unchanged.
 *
 * Exported so `node.ts` can reuse the same fan-out logic for its inline
 * callers section (FRICTION-5 fix, 2026-05-15) — previously those callers
 * were anchored at line 1 of the test file rather than the enclosing
 * `it/describe` block.
 */
export function expandTestFileCallers(
  cg: Cartograph,
  rows: Array<{ node: Node; edge: Edge }>,
): Array<{ node: Node; edge: Edge }> {
  const out: Array<{ node: Node; edge: Edge }> = [];
  for (const r of rows) out.push(...expandTestFileCaller(cg, r));
  return out;
}

/**
 * Same as {@link expandTestFileCallers} but takes a {@link QueryBuilder}
 * directly — for callers in `src/review/` that don't have the full
 * `Cartograph` instance (FRICTION-5 fix, 2026-05-15).
 */
export function expandTestFileCallersWithQueries(
  queries: QueryBuilder,
  rows: Array<{ node: Node; edge: Edge }>,
): Array<{ node: Node; edge: Edge }> {
  const out: Array<{ node: Node; edge: Edge }> = [];
  for (const r of rows) out.push(...expandTestFileCallerCore(queries, r));
  return out;
}

/**
 * Group callers per matching source symbol when a name resolves to
 * multiple definitions. Avoids the cross-contamination problem where
 * a `JSON-encoder.Encode` caller appears in the same flat list as
 * `tokenizer.Encode` callers (different methods, different concerns).
 *
 * Per-source caller collection goes through
 * {@link collectCallersForSource} so type-like sources (class /
 * interface / etc.) surface their `instantiates` / `extends` /
 * `implements` / `type_of` / `returns` users alongside plain call
 * predecessors — matching the single-match path's behavior.
 */
interface FormatGroupedCallersOpts {
  cg: Cartograph;
  symbol: string;
  matches: Node[];
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  refIds?: import('./_id-cache.js').RefIdCache;
}

/**
 * Build the per-source H3 bullet-list spec used by the multi-match
 * (`formatGroupedCallers`) path. Mirror of {@link buildCalleesGroupSpec}
 * in `_callees.ts` (same shape, opposite direction). Title is
 * `${name} (${kind}) — ${filePath}:${startLine}` at headingLevel 3.
 *
 * Rows are pre-rendered bullet strings + optional `- … (+N more)`
 * overflow row at the tail, identity-passthrough formatRow — same
 * pattern as changed-since per-bucket / imports per-kind / grep
 * per-file / callees per-source.
 *
 * Empty callers path branches on source kind:
 *  - method + name 'constructor' → {@link CALLERS_CONSTRUCTOR_HINT}
 *    (one-step pointer to the right query, since constructors graph
 *    as `instantiates` on the parent class, not `call` on the method).
 *  - anything else → {@link CALLERS_NO_CALLERS_NOTE}.
 * Both flow through `emptyNote` so the renderer emits `heading\nnote\n`.
 *
 * Caller (`formatGroupedCallers` below) computes `hasMore` outside
 * the spec since the spec contract is render-only.
 */
export interface BuildCallersGroupSpecArgs {
  node: Node;
  callers: ReadonlyArray<{ node: Node; edge: Edge }>;
  perSourceLimit: number;
  refIds: import('./_id-cache.js').RefIdCache | undefined;
}

export function buildCallersGroupSpec(args: BuildCallersGroupSpecArgs): MarkdownBulletListSpec<string> {
  const { node, callers, perSourceLimit, refIds } = args;
  const loc = node.startLine ? `:${node.startLine}` : '';
  const shown = callers.slice(0, perSourceLimit);
  const overflow = callers.length - shown.length;
  const bullets = shown.map((c) => {
    const cloc = c.node.startLine ? `:${c.node.startLine}` : '';
    const sites = formatSiteCount(c.edge);
    const conf = formatConfidence(c.edge);
    const idTag = refIds ? ` \`[id: ${refIds.mint(c.node.id)}]\`` : '';
    return `- ${c.node.name} (${c.node.kind}) - ${c.node.filePath}${cloc}${conf}${sites}${idTag}`;
  });
  const rows = overflow > 0 ? [...bullets, `- … (+${overflow} more)`] : bullets;
  const isConstructor = node.kind === 'method' && node.name === 'constructor';
  return {
    title: `${node.name} (${node.kind}) — ${node.filePath}${loc}`,
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
    emptyNote: isConstructor ? CALLERS_CONSTRUCTOR_HINT : CALLERS_NO_CALLERS_NOTE,
  };
}

function formatGroupedCallers(opts: FormatGroupedCallersOpts): { text: string; hasMore: boolean } {
  const { cg, symbol, matches, limit, edgeKindFilter, minConfidence, refIds } = opts;
  const perSymbol = matches.map((node) => ({
    node,
    // Expand test-file file-row callers into per-call-site rows so the
    // grouped view doesn't anchor every row at `__tests__/foo.test.ts:1`
    // (Friction-D, 2026-05-14).
    callers: expandTestFileCallers(cg, collectCallersForSource({ cg, source: node, edgeKindFilter, minConfidence })),
  }));
  const totalCallers = perSymbol.reduce((sum, p) => sum + p.callers.length, 0);
  // Per-source budget: divide the limit, with a floor so each source
  // gets at least 3 visible callers when there are many matches.
  const perSourceLimit = Math.max(Math.floor(limit / matches.length), 3);
  const lines: string[] = [
    `## Callers of ${symbol} (${matches.length} source definitions, ${totalCallers} callers total)`,
    '',
    `> **Note:** "${symbol}" resolves to multiple symbols. Callers are grouped per source so you can tell which definition each caller targets. Up to ${perSourceLimit} callers shown per source — the aggregate may exceed the \`limit\` argument when many sources have many callers.`,
    '',
  ];
  let hasMore = false;
  for (const { node, callers } of perSymbol) {
    lines.push(renderMarkdownBulletList(buildCallersGroupSpec({ node, callers, perSourceLimit, refIds })));
    if (callers.length > perSourceLimit) hasMore = true;
  }
  return { text: lines.join('\n'), hasMore };
}

/**
 * Batched path: run `findAllSymbols` for each symbol in `symbols`,
 * collect callers per-symbol (via `formatGroupedCallers` reuse),
 * and emit grouped sections separated by `---`.
 *
 * Per-symbol limit: divide `limit` across symbols with a floor of 3.
 * Stale-files note covers the union of all returned nodes.
 * Call-id covers the union of all caller-node keys.
 * Per-symbol work is delegated to {@link formatBatchedSection}.
 */
interface HandleCallersBatchedArgs {
  ctx: ToolCtx;
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbols: string[];
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  compact: boolean;
  fields?: ReadonlyArray<CompactFieldName>;
  includeRoles: boolean;
  sinceArg: unknown;
}

async function handleCallersBatched(batchArgs: HandleCallersBatchedArgs): Promise<ToolResult> {
  const { ctx, cg, symbols, limit, edgeKindFilter, minConfidence, compact, fields, includeRoles, sinceArg } = batchArgs;
  // Per-symbol budget: divide limit with a floor of 3.
  const perSymbolLimit = Math.max(Math.floor(limit / symbols.length), 3);
  const sections: string[] = [];
  const allCallerNodes: Node[] = [];
  let anyHasMore = false;

  for (const sym of symbols) {
    const section = formatBatchedSection({
      ctx,
      cg,
      sym,
      perSymbolLimit,
      edgeKindFilter,
      minConfidence,
      compact,
      ...(fields ? { fields } : {}),
      includeRoles,
    });
    sections.push(section.sectionText);
    allCallerNodes.push(...section.callerNodes);
    if (section.hasMore) anyHasMore = true;
  }

  const header = `# Callers — ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} queried\n`;
  const body = header + sections.join('\n\n---\n\n');

  const { delta: _delta, result: deltaResult } = buildDeltaResult(ctx, allCallerNodes, sinceArg);
  // The delta-summary header rides in the BODY (truncatable); the
  // call-id marker is a footer placed AFTER truncation by the
  // chokepoint, so a wide caller listing can't bury the UID.
  const { header: deltaHeader, marker } = splitCallIdFooter(deltaResult.newCallId, deltaResult.sinceMeta);
  return renderToolResponse({
    body: deltaHeader + body,
    footers: [anyHasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined, marker],
    freshness: { cg, nodes: allCallerNodes },
  });
}

/** Bundle returned by `parseHandleCallersArgs` on the happy path. */
interface ParsedCallersArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

/**
 * Validate / coerce the raw MCP args into the shape `handleCallers`
 * needs, returning either a parsed-args bag or a {@link ToolOutcome}
 * `err` arm.
 */
function parseHandleCallersArgs(ctx: ToolCtx, args: Record<string, unknown>): ParsedCallersArgs | ToolOutcome {
  const symbol = validateStringOutcome({ value: args['symbol'], name: 'symbol' });
  if (typeof symbol !== 'string') return symbol;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const limit = clamp(numArg(args['limit'], 20), 1, 100);
  const edgeKindFilter = args['edgeKind'] as string | undefined;
  const minConfidenceParsed = parseMinConfidence(args['minConfidence']);
  if (minConfidenceParsed !== null && typeof minConfidenceParsed !== 'string') return minConfidenceParsed;
  return { cg, symbol, limit, edgeKindFilter, minConfidence: minConfidenceParsed };
}

/**
 * Validate and coerce the `symbols` batch argument from raw MCP args.
 * Returns the validated string list or a {@link ToolOutcome} `err`
 * arm on bad input.
 */
function parseSymbolsBatchArg(symbolsArg: unknown): string[] | ToolOutcome {
  if (!Array.isArray(symbolsArg)) return err('`symbols` must be an array.');
  if (symbolsArg.length === 0) return err('`symbols` must be a non-empty array of strings.');
  const list: string[] = [];
  for (const item of symbolsArg) {
    if (typeof item !== 'string' || item.length === 0) return err('`symbols` entries must be non-empty strings.');
    list.push(item);
  }
  if (list.length > MAX_SYMBOLS) return err(`\`symbols\` accepts at most ${MAX_SYMBOLS} entries; got ${list.length}.`);
  return list;
}

/** Accumulator returned by applyDeltaSince + mintCallId together. */
interface DeltaResult {
  newCallId: string;
  sinceMeta: { newCount: number; totalBefore: number; sinceUid: string; sinceMissing: boolean } | undefined;
}

/**
 * Apply the delta-since filter and mint a fresh call-id in one step.
 * Avoids repeating the 8-line applyDeltaSince + mintCallId + sinceMeta
 * pattern in both handleCallers and handleCallersBatched.
 */
function buildDeltaResult(
  ctx: ToolCtx,
  allNodes: Node[],
  sinceArg: unknown,
): { delta: ReturnType<typeof applyDeltaSince<Node>>; result: DeltaResult } {
  const callerKey = (n: Node) => n.id;
  const delta = applyDeltaSince({
    callIds: ctx.callIds,
    sinceArg,
    rows: allNodes,
    rowKey: callerKey,
  });
  const newCallId = mintCallId({
    callIds: ctx.callIds,
    toolName: 'cartograph_graph:callers',
    currentKeys: allNodes.map(callerKey),
    priorKeys: delta.priorKeys,
  });
  const sinceMeta =
    delta.sinceUid === null
      ? undefined
      : {
          newCount: delta.rows.length,
          totalBefore: delta.totalBefore,
          sinceUid: delta.sinceUid,
          sinceMissing: delta.sinceMissing,
        };
  return { delta, result: { newCallId, sinceMeta } };
}

/** Args for formatBatchedSection — bundles the per-symbol formatting options. */
interface FormatBatchedSectionArgs {
  ctx: ToolCtx;
  cg: ReturnType<ToolCtx['getCartograph']>;
  sym: string;
  perSymbolLimit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  compact: boolean;
  fields?: ReadonlyArray<CompactFieldName>;
  includeRoles: boolean;
}

/** Return value of formatBatchedSection. */
interface BatchedSectionResult {
  sectionText: string;
  callerNodes: Node[];
  hasMore: boolean;
}

/** @internal Render the multi-match branch for one batched symbol. */
function formatBatchedMultiMatch(args: FormatBatchedSectionArgs, matches: Node[]): BatchedSectionResult {
  const { ctx, cg, sym, perSymbolLimit, edgeKindFilter, minConfidence } = args;
  const grouped = formatGroupedCallers({
    cg,
    symbol: sym,
    matches,
    limit: perSymbolLimit,
    edgeKindFilter,
    minConfidence,
    refIds: ctx.refIds,
  });
  const callerNodes: Node[] = [];
  for (const m of matches) {
    const rows = collectCallersForSource({ cg, source: m, edgeKindFilter, minConfidence });
    callerNodes.push(...rows.map((r) => r.node));
  }
  return {
    sectionText: `### ${sym}\n\n${grouped.text}`,
    callerNodes,
    hasMore: grouped.hasMore,
  };
}

/**
 * Build the optional `formatNodeList` projection fields (compact /
 * fields / roles). `exactOptionalPropertyTypes` rejects an explicit
 * `undefined`, so each is spread only when truthy. Consolidates a
 * 3-ternary block copy-pasted at every `formatNodeList` call site here.
 */
function nodeListProjection(o: {
  compact?: boolean | undefined;
  fields?: ReadonlyArray<'name' | 'kind' | 'path' | 'line' | 'id' | 'role'> | undefined;
  roles?: Map<string, string> | undefined;
}): {
  compact?: true;
  fields?: ReadonlyArray<'name' | 'kind' | 'path' | 'line' | 'id' | 'role'>;
  roles?: Map<string, string>;
} {
  return {
    ...(o.compact ? { compact: true } : {}),
    ...(o.fields ? { fields: o.fields } : {}),
    ...(o.roles ? { roles: o.roles } : {}),
  };
}

/** @internal Render the single-match branch (the one common case) for a batched symbol. */
function formatBatchedSingleMatch(args: FormatBatchedSectionArgs, matches: Node[]): BatchedSectionResult {
  const { ctx, cg, sym, perSymbolLimit, edgeKindFilter, minConfidence, compact, fields, includeRoles } = args;
  const callers = collectCallers({ cg, matchNodes: matches, edgeKindFilter, minConfidence });
  const typeUsers = collectTypeUsers({
    cg,
    matchNodes: matches,
    edgeKindFilter,
    alreadySeen: callers.seen,
    minConfidence,
  });

  if (callers.nodes.length === 0 && typeUsers.length === 0) {
    const filterNote = edgeKindFilter ? ` with edgeKind=${edgeKindFilter}` : '';
    const constructorNote =
      matches[0]?.kind === 'method' && matches[0]?.name === 'constructor'
        ? '\n\n> Note: constructors are invoked via `new ClassName(...)`, which graph-edges as `instantiates` on the parent class. To find construction sites, run cartograph_callers on the enclosing class instead of "constructor".'
        : '';
    return {
      sectionText: `### ${sym}\n\n_No callers found${filterNote}._${constructorNote}`,
      callerNodes: [],
      hasMore: false,
    };
  }

  const shownCallers = callers.nodes.slice(0, perSymbolLimit);
  const remaining = Math.max(perSymbolLimit - callers.nodes.length, 5);
  const shownTypeUsers = typeUsers.slice(0, remaining);
  const hasMore = callers.nodes.length + typeUsers.length > shownCallers.length + shownTypeUsers.length;

  const roles = includeRoles
    ? getSymbolRoles(
        cg.queries,
        [...shownCallers, ...shownTypeUsers].map((n) => n.id),
      )
    : undefined;

  const sectionParts: string[] = [`### ${sym}`, ''];
  if (shownCallers.length > 0) {
    sectionParts.push(
      formatNodeList({
        nodes: shownCallers,
        title: `Callers of ${sym}`,
        edges: callers.edges,
        refIds: ctx.refIds,
        ...nodeListProjection({ compact, fields, roles }),
      }),
    );
  }
  if (shownTypeUsers.length > 0) {
    sectionParts.push(
      formatNodeList({
        nodes: shownTypeUsers,
        title: `Type users of ${sym}`,
        refIds: ctx.refIds,
        ...nodeListProjection({ compact, fields, roles }),
      }),
    );
  }
  const note = pickCallersNote({
    symbol: sym,
    typeUserCount: typeUsers.length,
    callerCount: callers.nodes.length,
    ...(edgeKindFilter ? { edgeKindFilter } : {}),
  });
  if (note) sectionParts.push(note);

  return {
    sectionText: sectionParts.join('\n'),
    callerNodes: [...callers.nodes, ...typeUsers],
    hasMore,
  };
}

/**
 * Process a single symbol within the batched callers loop. Dispatches
 * to the not-found / multi-match / single-match branches.
 */
function formatBatchedSection(args: FormatBatchedSectionArgs): BatchedSectionResult {
  const allMatches = findAllSymbols(args.cg, args.sym, args.ctx.refIds);
  if (allMatches.nodes.length === 0) {
    return {
      sectionText: `### ${args.sym}\n\n_${notFoundMessage(args.cg, args.sym)}_`,
      callerNodes: [],
      hasMore: false,
    };
  }
  if (allMatches.nodes.length > 1) {
    return formatBatchedMultiMatch(args, allMatches.nodes);
  }
  return formatBatchedSingleMatch(args, allMatches.nodes);
}

/**
 * Try the batched (`symbols` array) route. Returns a {@link ToolOutcome}
 * to forward when batched, or null when the caller should fall through
 * to the single-symbol path.
 */
async function tryHandleCallersBatchedRoute(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome | null> {
  const symbolsArg = args['symbols'];
  if (symbolsArg === undefined) return null;
  if (args['symbol'] !== undefined) return err('Cannot specify both `symbol` and `symbols`');
  const list = parseSymbolsBatchArg(symbolsArg);
  if ('ok' in list) return list;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const limit = clamp(numArg(args['limit'], 20), 1, 100);
  const edgeKindFilter = args['edgeKind'] as string | undefined;
  const minConfidenceParsed = parseMinConfidence(args['minConfidence']);
  if (minConfidenceParsed !== null && typeof minConfidenceParsed !== 'string') return minConfidenceParsed;
  const fields = parseFieldsArg(args['fields']);
  return ok(
    await handleCallersBatched({
      ctx,
      cg,
      symbols: list,
      limit,
      edgeKindFilter,
      minConfidence: minConfidenceParsed,
      compact: args['compact'] === true,
      ...(fields ? { fields } : {}),
      includeRoles: args['includeRoles'] === true,
      sinceArg: args['since'],
    }),
  );
}

interface RenderNoCallersResultArgs {
  cg: Cartograph;
  symbol: string;
  edgeKindFilter: string | undefined;
  allMatches: { nodes: Node[]; note: string };
}

/**
 * Compose the "no callers found" response, including the type-filter
 * note + the constructor-specific hint that points users at the
 * enclosing class. Factored out of {@link handleCallers} so the
 * primary tool body stays under the `large_method` threshold.
 */
function renderNoCallersResult(args: RenderNoCallersResultArgs): ToolOutcome {
  const { cg, symbol, edgeKindFilter, allMatches } = args;
  const filterNote = edgeKindFilter ? ` with edgeKind=${edgeKindFilter}` : '';
  const constructorNote =
    allMatches.nodes.length === 1 &&
    allMatches.nodes[0]!.kind === 'method' &&
    allMatches.nodes[0]!.name === 'constructor'
      ? '\n\n> Note: constructors are invoked via `new ClassName(...)`, which graph-edges as `instantiates` on the parent class. To find construction sites, run cartograph_callers on the enclosing class instead of "constructor".'
      : '';
  return ok(
    renderToolResponse({
      body: '',
      empty: {
        message: `No callers found for "${symbol}"${filterNote}${allMatches.note}${constructorNote}`,
        freshness: { cg },
      },
    }),
  );
}

export async function handleCallers(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const batched = await tryHandleCallersBatchedRoute(ctx, args);
  if (batched) return batched;

  const parsed = parseHandleCallersArgs(ctx, args);
  if ('ok' in parsed) return parsed;
  const { cg, symbol, limit, edgeKindFilter, minConfidence } = parsed;

  const allMatches = findAllSymbols(cg, symbol, ctx.refIds);
  if (allMatches.nodes.length === 0) {
    return ok(textResult(symbolNotFound(cg, symbol)));
  }

  // Multi-match: group per-symbol so the agent can tell which `Encode`
  // each caller actually calls (vs a merged flat list where the JSON-
  // encoder's callers appear next to the tokenizer's).
  if (allMatches.nodes.length > 1) {
    const grouped = formatGroupedCallers({
      cg,
      symbol,
      matches: allMatches.nodes,
      limit,
      edgeKindFilter,
      minConfidence,
      refIds: ctx.refIds,
    });
    return ok(
      renderToolResponse({
        body: grouped.text,
        footers: [grouped.hasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined],
      }),
    );
  }

  const callers = collectCallers({ cg, matchNodes: allMatches.nodes, edgeKindFilter, minConfidence });
  const typeUsers = collectTypeUsers({
    cg,
    matchNodes: allMatches.nodes,
    edgeKindFilter,
    alreadySeen: callers.seen,
    minConfidence,
  });

  if (callers.nodes.length === 0 && typeUsers.length === 0) {
    return renderNoCallersResult({ cg, symbol, edgeKindFilter, allMatches });
  }

  const compact = args['compact'] === true;
  const fields = parseFieldsArg(args['fields']);
  const includeRoles = args['includeRoles'] === true;

  // Stage 6 #6.2 — delta-mode `since=c_xxxx` filters out caller nodes
  // already seen by the agent's prior call. Mint a fresh call-id from
  // the unfiltered key set so the chain can keep going.
  const { delta: callersDelta, result: deltaResult } = buildDeltaResult(ctx, callers.nodes, args['since']);
  const filteredCallers: CallersAccum = {
    nodes: callersDelta.rows,
    edges: callers.edges,
    seen: callers.seen,
  };

  const rendered = formatCallersResponse({
    cg,
    symbol,
    callers: filteredCallers,
    typeUsers,
    matchesNote: allMatches.note,
    limit,
    refIds: ctx.refIds,
    ...(compact ? { compact: true } : {}),
    ...(fields ? { fields } : {}),
    ...(includeRoles ? { includeRoles: true } : {}),
    ...(edgeKindFilter ? { edgeKindFilter } : {}),
  });
  // Delta-summary header rides in the body (pre-truncation); the
  // call-id marker is a footer placed after truncation + the cap hint.
  const { header: deltaHeader, marker } = splitCallIdFooter(deltaResult.newCallId, deltaResult.sinceMeta);
  return ok(
    renderToolResponse({
      body: deltaHeader + rendered.body,
      footers: [rendered.hasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined, marker],
      freshness: { cg, nodes: rendered.shownNodes },
    }),
  );
}

interface CallersAccum {
  nodes: Node[];
  edges: Map<string, Edge>;
  seen: Set<string>;
}

/**
 * Walk every match's `calls`-edge predecessors and accumulate them
 * into a deduped list. The same source can appear via multiple
 * matches (e.g. when a name resolves to overloads); keep only the
 * first edge per caller node.
 */
interface CollectCallersArgs {
  cg: Cartograph;
  matchNodes: Node[];
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

function collectCallers(args: CollectCallersArgs): CallersAccum {
  const { cg, matchNodes, edgeKindFilter, minConfidence } = args;
  const seen = new Set<string>();
  const rawRows: Array<{ node: Node; edge: Edge }> = [];
  const threshold = minConfidence ? CONFIDENCE_RANK[minConfidence] : 0;
  for (const node of matchNodes) {
    for (const c of cg.internals.traverser.getCallers(node.id)) {
      if (edgeKindFilter && c.edge.kind !== edgeKindFilter) continue;
      if (CONFIDENCE_RANK[c.edge.confidence ?? 'EXTRACTED'] < threshold) continue;
      if (seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      rawRows.push({ node: c.node, edge: c.edge });
    }
  }
  // Expand test-file file-row callers into per-call-site rows (FRICTION-D,
  // 2026-05-14). `seen` deliberately stays keyed by ORIGINAL node ids so
  // the downstream `collectTypeUsers` pass still dedupes against the
  // unexpanded caller set — typeUsers don't go through this expansion.
  const expandedRows = expandTestFileCallers(cg, rawRows);
  const nodes: Node[] = [];
  const edges = new Map<string, Edge>();
  for (const r of expandedRows) {
    nodes.push(r.node);
    edges.set(r.node.id, r.edge);
  }
  return { nodes, edges, seen };
}

/**
 * When the match set contains a type-like node, also collect its
 * type-usage incoming edges so a query like `callers of Model`
 * surfaces parameter / return / field / instantiation users — not
 * just plain `calls` predecessors. Skips sources already in
 * `alreadySeen` to avoid double-counting a function that both calls
 * a method and references a type.
 */
interface CollectTypeUsersArgs {
  cg: Cartograph;
  matchNodes: Node[];
  edgeKindFilter: string | undefined;
  alreadySeen: Set<string>;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

function collectTypeUsers(args: CollectTypeUsersArgs): Node[] {
  const { cg, matchNodes, edgeKindFilter, alreadySeen, minConfidence } = args;
  const typeNodes = matchNodes.filter((n) => TYPE_LIKE_KINDS.has(n.kind));
  if (typeNodes.length === 0) return [];

  const ctx: TypeUserCollectCtx = {
    cg,
    edgeKindFilter,
    threshold: minConfidence ? CONFIDENCE_RANK[minConfidence] : 0,
    alreadySeen,
    seenTypeUsers: new Set<string>(),
    typeUsers: [],
  };
  for (const n of typeNodes) {
    appendTypeUsersForNode(ctx, n.id);
  }
  return ctx.typeUsers;
}

/** Bundle of accumulators for {@link appendTypeUsersForNode} — keeps the param list short. */
interface TypeUserCollectCtx {
  cg: CollectTypeUsersArgs['cg'];
  edgeKindFilter: CollectTypeUsersArgs['edgeKindFilter'];
  threshold: number;
  alreadySeen: CollectTypeUsersArgs['alreadySeen'];
  seenTypeUsers: Set<string>;
  typeUsers: Node[];
}

/**
 * Append users of one type-node to the running accumulator, applying the
 * type-usage edge-kind whitelist, the optional `edgeKindFilter`, the
 * confidence threshold, and the dedup sets in one pass.
 */
function appendTypeUsersForNode(ctx: TypeUserCollectCtx, nodeId: string): void {
  const { cg, edgeKindFilter, threshold, alreadySeen, seenTypeUsers, typeUsers } = ctx;
  for (const e of getIncomingEdges(cg.queries, nodeId)) {
    if (!TYPE_USAGE_EDGE_KIND_SET.has(e.kind)) continue;
    if (edgeKindFilter && e.kind !== edgeKindFilter) continue;
    if (CONFIDENCE_RANK[e.confidence ?? 'EXTRACTED'] < threshold) continue;
    if (seenTypeUsers.has(e.source)) continue;
    if (alreadySeen.has(e.source)) continue;
    seenTypeUsers.add(e.source);
    const src = cg.queries.getNodeById(e.source);
    if (src) typeUsers.push(src);
  }
}

/**
 * Format the final markdown response: the callers section followed
 * by a type-users section (with at least 5 reserved slots so the
 * type surface isn't completely hidden when the budget is filled by
 * callers), an explanatory note when type-usage results are mixed in
 * or stand alone, a stale-files appendix, and — when the raw match
 * total exceeded the slice surfaced — a `Result capped` tail from
 * {@link appendMoreHint} so the agent knows re-running with a higher
 * `limit` could surface more.
 */
interface FormatCallersResponseOpts {
  cg: Cartograph;
  symbol: string;
  callers: CallersAccum;
  typeUsers: Node[];
  matchesNote: string;
  limit: number;
  refIds?: import('./_id-cache.js').RefIdCache;
  /** Stage 6 #6.1 — emit one terse line per node instead of markdown bullets. */
  compact?: boolean;
  /** Stage 6 #6.3 — restrict compact rows to a subset of fields. */
  fields?: ReadonlyArray<CompactFieldName>;
  /** When true, look up `nodes.role` for each shown caller / type-user
   *  and inline it in the rendered row. Saves a `cartograph_role`
   *  round-trip per caller on chained graph queries. */
  includeRoles?: boolean;
  /** When set, the type-users note names only this edge kind rather
   *  than listing all five usage kinds. */
  edgeKindFilter?: string;
}

/**
 * Human-readable verb for a type-usage edge kind, used in the
 * type-users note when a caller passed an explicit `edgeKind` filter.
 */
const TYPE_USAGE_VERB: Record<string, string> = {
  instantiates: 'instantiate',
  type_of: 'use as a type',
  returns: 'return',
  extends: 'extend',
  implements: 'implement',
};

/** Inputs for {@link pickCallersNote}. */
interface CallersNoteArgs {
  symbol: string;
  typeUserCount: number;
  callerCount: number;
  edgeKindFilter?: string;
}

/** Render the type/callable disambiguation note for the callers
 *  response. Three branches: type-only, mixed, or none.
 *  When an explicit `edgeKindFilter` is active the note names only
 *  that edge kind instead of the full five-kind list. */
function pickCallersNote(args: CallersNoteArgs): string {
  const { symbol, typeUserCount, callerCount, edgeKindFilter } = args;
  if (typeUserCount === 0) return '';
  if (callerCount === 0) {
    const verb = edgeKindFilter ? TYPE_USAGE_VERB[edgeKindFilter] : undefined;
    const usageDesc = verb ? `*${verb}* it.` : `*use* it (parameter / return / field / instantiation / inheritance).`;
    return `\n\n> **Note:** \`${symbol}\` is a type, not a callable. Showing symbols that ${usageDesc}`;
  }
  return `\n\n> **Note:** \`${symbol}\` resolves to both callable and type-like definitions; both surfaces shown.`;
}

/**
 * Structured callers body — the raw markdown plus the cross-cutting
 * signals the P5 chokepoint needs (`hasMore` for the cap footer,
 * `shownNodes` for the stale-files freshness probe). Tail assembly
 * (truncate / footers / freshness) is owned by `renderToolResponse`.
 */
interface CallersResponseBody {
  body: string;
  hasMore: boolean;
  shownNodes: Node[];
}

function formatCallersResponse(opts: FormatCallersResponseOpts): CallersResponseBody {
  const { cg, symbol, callers, typeUsers, matchesNote, limit, refIds } = opts;
  const sections: string[] = [];
  const allShown: Node[] = [];

  // Pre-compute the "shown" slices so the role bulk-lookup can cover
  // both sections in one SQL `IN(...)`. Skip when includeRoles is off.
  const shownCallers = callers.nodes.slice(0, limit);
  const shownTypeUsers = typeUsers.length > 0 ? typeUsers.slice(0, Math.max(limit - callers.nodes.length, 5)) : [];
  const roles = opts.includeRoles
    ? getSymbolRoles(
        cg.queries,
        [...shownCallers, ...shownTypeUsers].map((n) => n.id),
      )
    : undefined;

  if (shownCallers.length > 0) {
    allShown.push(...shownCallers);
    sections.push(
      formatNodeList({
        nodes: shownCallers,
        title: `Callers of ${symbol}`,
        edges: callers.edges,
        refIds,
        ...nodeListProjection({ compact: opts.compact, fields: opts.fields, roles }),
      }),
    );
  }

  if (shownTypeUsers.length > 0) {
    allShown.push(...shownTypeUsers);
    sections.push(
      formatNodeList({
        nodes: shownTypeUsers,
        title: `Type users of ${symbol}`,
        refIds,
        ...nodeListProjection({ compact: opts.compact, fields: opts.fields, roles }),
      }),
    );
  }

  const note = pickCallersNote({
    symbol,
    typeUserCount: typeUsers.length,
    callerCount: callers.nodes.length,
    ...(opts.edgeKindFilter ? { edgeKindFilter: opts.edgeKindFilter } : {}),
  });

  // Cap detection: did either section have more raw rows than the
  // slice surfaced? Both sections compute their own per-section cap
  // off `limit`, so the easiest ground truth is "raw total exceeded
  // shown total".
  const rawTotal = callers.nodes.length + typeUsers.length;
  const hasMore = rawTotal > allShown.length;

  // Tail assembly (truncate / cap footer / stale-files note) is owned
  // by `renderToolResponse` in the handler — return the raw body plus
  // the signals it needs.
  return {
    body: sections.join('\n\n') + note + matchesNote,
    hasMore,
    shownNodes: allShown,
  };
}

// CALLERS_TOOL export removed in the 2026-05-11 four-tool merge. The
// public surface is now `cartograph_graph({direction: 'callers'})`; this
// module is reached only via that tool's dispatcher in `graph.ts`.
