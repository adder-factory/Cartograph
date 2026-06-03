/**
 * @internal Private helper module for `cartograph_graph` (direction='callees', hops=1).
 *
 * Pre-merge this was the standalone `cartograph_callees` MCP tool. After
 * the 2026-05-11 four-tool merge the public surface is `cartograph_graph`;
 * only the {@link handleCallees} entry point remains exported so the new
 * dispatcher can forward direction='callees' + hops=1 calls verbatim.
 */
import type { ToolResult } from '../tool-types.js';
import { getSymbolRoles } from '../../db/queries-roles.js';
import type Cartograph from '../../index.js';
import type { Edge, Node } from '../../types.js';
import { clamp, numArg } from '../../utils.js';
import {
  CONFIDENCE_RANK,
  formatConfidence,
  formatNodeList,
  formatSiteCount,
  parseMinConfidence,
} from './result-formatters.js';
import { applyDeltaSince, mintCallId, textResult, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, notFoundMessage, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/** Maximum symbols accepted by the `symbols` batch parameter. Mirror
 *  of {@link BATCHED_SYMBOLS_MAX} from `_common-fields.ts`. */
const MAX_SYMBOLS = BATCHED_SYMBOLS_MAX;

/**
 * Group callees per matching source symbol — same rationale as
 * formatGroupedCallers (in callers.ts), in the opposite direction.
 */
interface FormatGroupedCalleesOpts {
  cg: Cartograph;
  symbol: string;
  matches: Node[];
  matchesNote?: string;
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  refIds?: import('./_id-cache.js').RefIdCache;
}

/**
 * Format callees for one symbol source.
 */
interface FormatCalleeLinesArgs {
  node: Node;
  callees: Array<{ node: Node; edge: Edge }>;
  perSourceLimit: number;
  refIds: import('./_id-cache.js').RefIdCache | undefined;
}

/**
 * Build the per-source H3 bullet-list spec used by the multi-match
 * (`formatGroupedCallees`) path. Title `${name} (${kind}) —
 * ${filePath}:${startLine}` at headingLevel 3; rows pre-rendered as
 * `string[]` so the overflow `… (+N more)` line sits inline with the
 * regular bullets (no blank-line gap that a `footers` entry would
 * introduce) — same pattern as the changed-since per-bucket and
 * imports per-kind builders.
 *
 * Empty callees → emptyNote `_No callees._` (italic blockquote line),
 * which the renderer emits as `heading\n_No callees._\n`. Pre-migration
 * had an extra blank between heading and the note; post drops it per
 * the codebase bullet-list convention (heading flush to body) — same
 * alignment as batch 10's appendUncertainTop.
 *
 * Caller (`formatCalleeLines` below) computes the `hasMore` boolean
 * outside the spec since the spec contract is render-only — the
 * overflow signal is per-caller bookkeeping, not user-facing wording.
 */
export function buildCalleesGroupSpec(args: FormatCalleeLinesArgs): MarkdownBulletListSpec<string> {
  const { node, callees, perSourceLimit, refIds } = args;
  const loc = node.startLine ? `:${node.startLine}` : '';
  const shown = callees.slice(0, perSourceLimit);
  const overflow = callees.length - shown.length;
  const bullets = shown.map((c) => {
    const cloc = c.node.startLine ? `:${c.node.startLine}` : '';
    const sites = formatSiteCount(c.edge);
    const conf = formatConfidence(c.edge);
    const idTag = refIds ? ` \`[id: ${refIds.mint(c.node.id)}]\`` : '';
    return `- ${c.node.name} (${c.node.kind}) - ${c.node.filePath}${cloc}${conf}${sites}${idTag}`;
  });
  const rows = overflow > 0 ? [...bullets, `- … (+${overflow} more)`] : bullets;
  return {
    title: `${node.name} (${node.kind}) — ${node.filePath}${loc}`,
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
    emptyNote: '_No callees._',
  };
}

function formatCalleeLines(args: FormatCalleeLinesArgs): { rendered: string; hasMore: boolean } {
  const spec = buildCalleesGroupSpec(args);
  const rendered = renderMarkdownBulletList(spec);
  // Mirror the spec builder's `callees.length - shown.length` form
  // (where shown = callees.slice(0, perSourceLimit)) — equivalent to a
  // direct `callees.length > perSourceLimit` comparison and avoids the
  // intermediate negative value when callees underfills the limit.
  return { rendered, hasMore: args.callees.length > args.perSourceLimit };
}

function formatGroupedCallees(opts: FormatGroupedCalleesOpts): { text: string; hasMore: boolean } {
  const { cg, symbol, matches, matchesNote, limit, edgeKindFilter, minConfidence, refIds } = opts;
  const threshold = minConfidence ? CONFIDENCE_RANK[minConfidence] : 0;
  const perSymbol = matches.map((node) => {
    const raw = edgeKindFilter
      ? cg.internals.traverser.getCallees(node.id).filter((c) => c.edge.kind === edgeKindFilter)
      : cg.internals.traverser.getCallees(node.id);
    return {
      node,
      callees: raw.filter((c) => CONFIDENCE_RANK[c.edge.confidence ?? 'EXTRACTED'] >= threshold),
    };
  });
  const totalCallees = perSymbol.reduce((sum, p) => sum + p.callees.length, 0);
  const perSourceLimit = Math.max(Math.floor(limit / matches.length), 3);
  const lines: string[] = [
    `## Callees of ${symbol} (${matches.length} source definitions, ${totalCallees} callees total)`,
    '',
    `> **Note:** "${symbol}" resolves to multiple symbols. Callees are grouped per source. Up to ${perSourceLimit} callees shown per source — the aggregate may exceed the \`limit\` argument when many sources have many callees.`,
    '',
  ];
  const candidateNote = matchesNote?.replace(/^\n+/, '').trim();
  if (candidateNote) lines.push(candidateNote, '');

  let hasMore = false;
  for (const { node, callees } of perSymbol) {
    const { rendered, hasMore: nodeHasMore } = formatCalleeLines({ node, callees, perSourceLimit, refIds });
    lines.push(rendered);
    if (nodeHasMore) hasMore = true;
  }

  return { text: lines.join('\n'), hasMore };
}

/** Container kinds whose own node has no `calls` edges — only their
 *  methods do. Surface a follow-up hint when every match is one of
 *  these. */
const CONTAINER_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'struct', 'trait', 'protocol']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['method', 'function']);
const METHOD_HINT_SAMPLE = 12;

interface ContainerHintArgs {
  cg: Cartograph;
  symbol: string;
  matches: ReturnType<typeof findAllSymbols>;
}

/** When `cartograph_callees` finds zero callees AND every matched
 *  symbol is a container, return a hint message naming the container's
 *  callable children — so the agent's next call lands on a method
 *  instead of bouncing again. Returns null when no hint applies (the
 *  caller falls through to the standard "No callees found" message).
 *  Pulled out of {@link handleCallees} so the no-result branch isn't
 *  carrying a 4-deep `for/for/if` walker. */
function buildContainerMethodHint(args: ContainerHintArgs): string | null {
  const { cg, symbol, matches } = args;
  // Self-defend against empty match sets even though the caller's
  // `allCallees.length === 0` branch is only reached when matches were
  // already non-empty — keeps the `matches.nodes[0]!` below safe in
  // isolation if a future caller skips that guard.
  if (matches.nodes.length === 0) return null;
  if (!matches.nodes.every((n) => CONTAINER_KINDS.has(n.kind))) return null;
  const methodNames = collectCallableChildNames(cg, matches.nodes);
  if (methodNames.size === 0) return null;
  const sample = Array.from(methodNames).slice(0, METHOD_HINT_SAMPLE);
  const overflow = methodNames.size - sample.length;
  const more = overflow > 0 ? `, … (+${overflow} more)` : '';
  return (
    `"${symbol}" is a ${matches.nodes[0]!.kind} — callees live on its methods, not the container itself. ` +
    `Try \`cartograph_graph({start: '<methodName>', direction: 'callees'})\`. ` +
    `Methods on ${symbol}: ${sample.join(', ')}${more}.${matches.note}`
  );
}

function collectCallableChildNames(cg: Cartograph, containers: ReadonlyArray<Node>): Set<string> {
  const out = new Set<string>();
  for (const node of containers) {
    for (const child of cg.internals.traverser.getChildren(node.id)) {
      if (CALLABLE_KINDS.has(child.kind)) out.add(child.name);
    }
  }
  return out;
}

interface HandleCalleesSingleMatchArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  allMatches: ReturnType<typeof findAllSymbols>;
  edgeKindFilter: string | undefined;
  confidenceThreshold: number;
  limit: number;
  refIds: ToolCtx['refIds'];
  /** Stage 6 #6.1 — terse one-line-per-row output. */
  compact?: boolean;
  /** Stage 6 #6.2 — delta-mode call-id cache + `since=c_xxxx`. */
  callIds?: ToolCtx['callIds'];
  sinceArg?: unknown;
  /** Stage 6 #6.3 — restrict compact rows to a subset of fields. */
  fields?: ReadonlyArray<'name' | 'kind' | 'path' | 'line' | 'id' | 'role'>;
  /** When true, look up `nodes.role` for each shown callee and inline
   *  it on the rendered row. Saves a `cartograph_role` round-trip per
   *  callee on chained graph queries. */
  includeRoles?: boolean;
}

type FieldName = 'name' | 'kind' | 'path' | 'line' | 'id' | 'role';
const CALLEES_ALLOWED_FIELDS: ReadonlySet<string> = new Set(['name', 'kind', 'path', 'line', 'id', 'role']);

function parseCalleesFieldsArg(arg: unknown): ReadonlyArray<FieldName> | null {
  if (!Array.isArray(arg) || arg.length === 0) return null;
  const out: FieldName[] = [];
  for (const v of arg) {
    if (typeof v === 'string' && CALLEES_ALLOWED_FIELDS.has(v)) out.push(v as FieldName);
  }
  return out.length > 0 ? out : null;
}

/** Single-symbol path: flat list with container-method hint on zero callees. */
function handleCalleesSingleMatch(args: HandleCalleesSingleMatchArgs): ToolResult {
  const {
    cg,
    symbol,
    allMatches,
    edgeKindFilter,
    confidenceThreshold,
    limit,
    refIds,
    compact,
    callIds,
    sinceArg,
    includeRoles,
  } = args;
  const { allCallees, calleeEdges } = collectFlatCallees({
    cg,
    matches: allMatches.nodes,
    edgeKindFilter,
    confidenceThreshold,
  });
  if (allCallees.length === 0) {
    const containerHint = buildContainerMethodHint({ cg, symbol, matches: allMatches });
    return renderToolResponse({
      body: '',
      empty: {
        message: containerHint ?? `No callees found for "${symbol}"${allMatches.note}`,
        freshness: { cg },
      },
    });
  }

  // Stage 6 #6.2 — delta-mode `since=c_xxxx`. Filter applied to the
  // full result; `shown`/`hasMore` are computed off the filtered list.
  const rowKey = (n: Node) => n.id;
  const delta = callIds
    ? applyDeltaSince({ callIds, sinceArg, rows: allCallees, rowKey })
    : {
        rows: allCallees,
        priorKeys: null as ReadonlySet<string> | null,
        totalBefore: 0,
        sinceUid: null,
        sinceMissing: false,
      };
  const filtered = delta.rows;
  const shown = filtered.slice(0, limit);
  const hasMore = filtered.length > shown.length;
  const roles = includeRoles
    ? getSymbolRoles(
        cg.queries,
        shown.map((n) => n.id),
      )
    : undefined;
  const formatted =
    formatNodeList({
      nodes: shown,
      title: `Callees of ${symbol}`,
      edges: calleeEdges,
      refIds,
      ...(compact ? { compact: true } : {}),
      ...(args.fields ? { fields: args.fields } : {}),
      ...(roles ? { roles } : {}),
    }) + allMatches.note;
  const capFooter = hasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined;
  // Without delta-mode there is no call-id marker; the chokepoint
  // still owns truncation + the cap footer + the stale-files note.
  if (!callIds) {
    return renderToolResponse({
      body: formatted,
      footers: [capFooter],
      freshness: { cg, nodes: shown },
    });
  }
  const newCallId = mintCallId({
    callIds,
    toolName: 'cartograph_graph:callees',
    currentKeys: allCallees.map(rowKey),
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
  // Delta-summary header rides in the body (pre-truncation); the
  // call-id marker is a footer placed after truncation + the cap hint.
  const { header: deltaHeader, marker } = splitCallIdFooter(newCallId, sinceMeta);
  return renderToolResponse({
    body: deltaHeader + formatted,
    footers: [capFooter, marker],
    freshness: { cg, nodes: shown },
  });
}

/**
 * Batched path: run `findAllSymbols` for each symbol in `symbols`,
 * collect callees per-symbol, and emit grouped sections separated by `---`.
 *
 * Per-symbol limit: divide `limit` across symbols with a floor of 3.
 * Stale-files note covers the union of all returned nodes.
 * Call-id covers the union of all callee-node keys.
 */
interface HandleCalleesBatchedArgs {
  ctx: ToolCtx;
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbols: string[];
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  confidenceThreshold: number;
  compact?: boolean;
  fields?: ReadonlyArray<FieldName>;
  includeRoles?: boolean;
  sinceArg: unknown;
}

interface BuildBatchedSymbolSectionArgs {
  ctx: ToolCtx;
  cg: ReturnType<ToolCtx['getCartograph']>;
  sym: string;
  perSymbolLimit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  confidenceThreshold: number;
  compact: boolean;
  fields: ReadonlyArray<FieldName> | undefined;
  includeRoles: boolean;
}

interface BuildBatchedSymbolSectionResult {
  section: string;
  collectedNodes: Node[];
  hasMore: boolean;
}

/** Build the markdown section + collect callee nodes for one symbol in a batch. */
function buildBatchedSymbolSection(args: BuildBatchedSymbolSectionArgs): BuildBatchedSymbolSectionResult {
  const { ctx, cg, sym } = args;
  const allMatches = findAllSymbols(cg, sym, ctx.refIds);
  if (allMatches.nodes.length === 0) {
    return { section: `### ${sym}\n\n_${notFoundMessage(cg, sym)}_`, collectedNodes: [], hasMore: false };
  }

  if (allMatches.nodes.length > 1) {
    return buildMultiMatchBatchedSymbolSection(args, allMatches.nodes, allMatches.note);
  }

  return buildSingleMatchBatchedSymbolSection(args, allMatches);
}

function buildMultiMatchBatchedSymbolSection(
  args: BuildBatchedSymbolSectionArgs,
  matches: ReadonlyArray<Node>,
  matchesNote: string,
): BuildBatchedSymbolSectionResult {
  const { ctx, cg, sym, perSymbolLimit, edgeKindFilter, minConfidence } = args;
  const grouped = formatGroupedCallees({
    cg,
    symbol: sym,
    matches: [...matches],
    ...(matchesNote ? { matchesNote } : {}),
    limit: perSymbolLimit,
    edgeKindFilter,
    minConfidence,
    refIds: ctx.refIds,
  });
  return {
    section: `### ${sym}\n\n${grouped.text}`,
    collectedNodes: collectBatchedMultiMatchNodes(cg, matches, edgeKindFilter),
    hasMore: grouped.hasMore,
  };
}

function collectBatchedMultiMatchNodes(
  cg: ReturnType<ToolCtx['getCartograph']>,
  matches: ReadonlyArray<Node>,
  edgeKindFilter: string | undefined,
): Node[] {
  const nodes: Node[] = [];
  for (const m of matches) {
    const raw = edgeKindFilter
      ? cg.internals.traverser.getCallees(m.id).filter((c) => c.edge.kind === edgeKindFilter)
      : cg.internals.traverser.getCallees(m.id);
    nodes.push(...raw.map((c) => c.node));
  }
  return nodes;
}

function buildSingleMatchBatchedSymbolSection(
  args: BuildBatchedSymbolSectionArgs,
  allMatches: ReturnType<typeof findAllSymbols>,
): BuildBatchedSymbolSectionResult {
  const { ctx, cg, sym, perSymbolLimit, edgeKindFilter, confidenceThreshold, compact, fields, includeRoles } = args;
  const { allCallees, calleeEdges } = collectFlatCallees({
    cg,
    matches: allMatches.nodes,
    edgeKindFilter,
    confidenceThreshold,
  });

  if (allCallees.length === 0) {
    const containerHint = buildContainerMethodHint({ cg, symbol: sym, matches: allMatches });
    const emptyMessage = containerHint ?? `No callees found for "${sym}".`;
    return {
      section: `### ${sym}\n\n_${emptyMessage}_`,
      collectedNodes: [],
      hasMore: false,
    };
  }

  const shown = allCallees.slice(0, perSymbolLimit);
  const overflow = allCallees.length - shown.length;
  const sectionRoles = includeRoles
    ? getSymbolRoles(
        cg.queries,
        shown.map((n) => n.id),
      )
    : undefined;
  const sectionParts: string[] = [`### ${sym}`, ''];
  if (compact) {
    sectionParts.push(
      formatNodeList({
        nodes: shown,
        title: `Callees of ${sym}`,
        edges: calleeEdges,
        refIds: ctx.refIds,
        compact: true,
        ...(fields ? { fields } : {}),
        ...(sectionRoles ? { roles: sectionRoles } : {}),
      }),
    );
  } else {
    sectionParts.push(
      formatNodeList({
        nodes: shown,
        title: `Callees of ${sym}`,
        edges: calleeEdges,
        refIds: ctx.refIds,
        ...(sectionRoles ? { roles: sectionRoles } : {}),
      }),
    );
  }
  if (overflow > 0) sectionParts.push(`\n_… (+${overflow} more)_`);
  return { section: sectionParts.join('\n'), collectedNodes: allCallees, hasMore: overflow > 0 };
}

function handleCalleesBatched(args: HandleCalleesBatchedArgs): ToolResult {
  const {
    ctx,
    cg,
    symbols,
    limit,
    edgeKindFilter,
    minConfidence,
    confidenceThreshold,
    compact,
    fields,
    includeRoles,
    sinceArg,
  } = args;
  const perSymbolLimit = Math.max(Math.floor(limit / symbols.length), 3);
  const sections: string[] = [];
  const allCalleeNodes: Node[] = [];
  let anyHasMore = false;

  for (const sym of symbols) {
    const { section, collectedNodes, hasMore } = buildBatchedSymbolSection({
      ctx,
      cg,
      sym,
      perSymbolLimit,
      edgeKindFilter,
      minConfidence,
      confidenceThreshold,
      compact: compact ?? false,
      fields,
      includeRoles: includeRoles ?? false,
    });
    sections.push(section);
    allCalleeNodes.push(...collectedNodes);
    if (hasMore) anyHasMore = true;
  }

  const header = `# Callees — ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} queried\n`;
  const body = header + sections.join('\n\n---\n\n');

  const rowKey = (n: Node) => n.id;
  const delta = applyDeltaSince({
    callIds: ctx.callIds,
    sinceArg,
    rows: allCalleeNodes,
    rowKey,
  });
  const newCallId = mintCallId({
    callIds: ctx.callIds,
    toolName: 'cartograph_graph:callees',
    currentKeys: allCalleeNodes.map(rowKey),
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

  // Delta-summary header rides in the body (pre-truncation); the
  // call-id marker is a footer placed after truncation + the cap hint.
  const { header: deltaHeader, marker } = splitCallIdFooter(newCallId, sinceMeta);
  return renderToolResponse({
    body: deltaHeader + body,
    footers: [anyHasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined, marker],
    freshness: { cg, nodes: allCalleeNodes },
  });
}

/** Shared parsed arguments used by both the single-symbol and batched paths. */
interface ParsedCalleesArgs {
  limit: number;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
  confidenceThreshold: number;
  compact: boolean;
  fieldsArg: ReadonlyArray<FieldName> | null;
  includeRoles: boolean;
}

/**
 * Parse and validate common callees arguments shared between the single-symbol
 * and batched paths. Returns a {@link ToolOutcome} `err` arm on validation
 * failure or a {@link ParsedCalleesArgs} bundle on success.
 */
function parseCalleesArgs(args: Record<string, unknown>): ParsedCalleesArgs | ToolOutcome {
  const limit = clamp(numArg(args['limit'], 20), 1, 100);
  const edgeKindFilter = args['edgeKind'] as string | undefined;
  const minConfidenceParsed = parseMinConfidence(args['minConfidence']);
  if (minConfidenceParsed !== null && typeof minConfidenceParsed !== 'string') return minConfidenceParsed;
  const minConfidence = minConfidenceParsed;
  const confidenceThreshold = minConfidence ? CONFIDENCE_RANK[minConfidence] : 0;
  const compact = args['compact'] === true;
  const fieldsArg = parseCalleesFieldsArg(args['fields']);
  const includeRoles = args['includeRoles'] === true;
  return { limit, edgeKindFilter, minConfidence, confidenceThreshold, compact, fieldsArg, includeRoles };
}

/**
 * Validate the `symbols` array argument. Returns a {@link ToolOutcome}
 * `err` arm on invalid input, or the validated string list on success.
 */
function validateSymbolsList(symbolsArg: unknown[]): string[] | ToolOutcome {
  if (symbolsArg.length === 0) return err('`symbols` must be a non-empty array of strings.');
  const list: string[] = [];
  for (const item of symbolsArg) {
    if (typeof item !== 'string' || item.length === 0) return err('`symbols` entries must be non-empty strings.');
    list.push(item);
  }
  if (list.length > MAX_SYMBOLS) return err(`\`symbols\` accepts at most ${MAX_SYMBOLS} entries; got ${list.length}.`);
  return list;
}

/**
 * Batched (`symbols` array) arm of {@link handleCallees}. Validates the list,
 * parses shared args, then renders the multi-symbol callees report. Returns a
 * {@link ToolOutcome} `err` arm on validation failure. Behaviour is identical to
 * the inline block it replaces.
 */
function handleCalleesBatchedPath(ctx: ToolCtx, args: Record<string, unknown>, symbolsArg: unknown[]): ToolOutcome {
  const listOrError = validateSymbolsList(symbolsArg);
  if (!Array.isArray(listOrError)) return listOrError;
  const parsed = parseCalleesArgs(args);
  if ('ok' in parsed) return parsed;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  return ok(
    handleCalleesBatched({
      ctx,
      cg,
      symbols: listOrError,
      limit: parsed.limit,
      edgeKindFilter: parsed.edgeKindFilter,
      minConfidence: parsed.minConfidence,
      confidenceThreshold: parsed.confidenceThreshold,
      compact: parsed.compact,
      ...(parsed.fieldsArg ? { fields: parsed.fieldsArg } : {}),
      ...(parsed.includeRoles ? { includeRoles: true } : {}),
      sinceArg: args['since'],
    }),
  );
}

export async function handleCallees(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Batched path: `symbols` array takes priority over single `symbol`.
  const symbolsArg = args['symbols'];
  const symbolArg = args['symbol'];
  if (Array.isArray(symbolsArg) && symbolArg !== undefined) {
    return err('Cannot specify both `symbol` and `symbols`');
  }
  if (Array.isArray(symbolsArg)) {
    return handleCalleesBatchedPath(ctx, args, symbolsArg);
  }

  const symbol = validateStringOutcome({ value: args['symbol'], name: 'symbol' });
  if (typeof symbol !== 'string') return symbol;

  const parsed = parseCalleesArgs(args);
  if ('ok' in parsed) return parsed;
  const { limit, edgeKindFilter, minConfidence, confidenceThreshold, compact, fieldsArg, includeRoles } = parsed;

  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const allMatches = findAllSymbols(cg, symbol, ctx.refIds);
  if (allMatches.nodes.length === 0) return ok(textResult(symbolNotFound(cg, symbol)));

  // Group when the name aggregates across multiple definitions
  // (e.g. several `Encode` methods in different packages). See
  // formatGroupedCallers for rationale.
  if (allMatches.nodes.length > 1) {
    const grouped = formatGroupedCallees({
      cg,
      symbol,
      matches: allMatches.nodes,
      ...(allMatches.note ? { matchesNote: allMatches.note } : {}),
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

  return ok(
    handleCalleesSingleMatch({
      cg,
      symbol,
      allMatches,
      edgeKindFilter,
      confidenceThreshold,
      limit,
      refIds: ctx.refIds,
      callIds: ctx.callIds,
      sinceArg: args['since'],
      ...(compact ? { compact: true } : {}),
      ...(fieldsArg ? { fields: fieldsArg } : {}),
      ...(includeRoles ? { includeRoles: true } : {}),
    }),
  );
}

/**
 * Walk every match's outgoing call edges, dedup callees, and apply the
 * edge-kind / min-confidence filters in one pass. Returns the deduped node
 * list plus the per-target edge map (for confidence tag rendering).
 */
interface CollectFlatCalleesArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  matches: Node[];
  edgeKindFilter: string | undefined;
  confidenceThreshold: number;
}

function collectFlatCallees(args: CollectFlatCalleesArgs): { allCallees: Node[]; calleeEdges: Map<string, Edge> } {
  const { cg, matches, edgeKindFilter, confidenceThreshold } = args;
  const seen = new Set<string>();
  const allCallees: Node[] = [];
  const calleeEdges = new Map<string, Edge>();
  for (const node of matches) {
    for (const c of cg.internals.traverser.getCallees(node.id)) {
      if (edgeKindFilter && c.edge.kind !== edgeKindFilter) continue;
      if (CONFIDENCE_RANK[c.edge.confidence ?? 'EXTRACTED'] < confidenceThreshold) continue;
      if (seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      allCallees.push(c.node);
      calleeEdges.set(c.node.id, c.edge);
    }
  }
  return { allCallees, calleeEdges };
}

// CALLEES_TOOL export removed in the 2026-05-11 four-tool merge. The
// public surface is now `cartograph_graph({direction: 'callees'})`; this
// module is reached only via that tool's dispatcher in `graph.ts`.
