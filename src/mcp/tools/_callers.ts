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
import { getSymbolRoles } from '../../db/queries-roles.js';
import type Cartograph from '../../index.js';
import type { Edge, Node } from '../../types.js';
import { clamp, numArg } from '../../utils.js';
import {
  collectCallers,
  collectCallersForSource,
  collectTypeUsers,
  formatGroupedCallers,
  pickCallersNote,
  type CallersAccum,
} from '../../features/graph/callers/index.js';
export {
  CALLERS_CONSTRUCTOR_HINT,
  CALLERS_NO_CALLERS_NOTE,
  buildCallersGroupSpec,
  callSiteLinesFromEdge,
  expandTestFileCallers,
  expandTestFileCallersWithQueries,
} from '../../features/graph/callers/index.js';
export type { BuildCallersGroupSpecArgs } from '../../features/graph/callers/index.js';
import { formatNodeList, parseMinConfidence } from './result-formatters.js';
import {
  applyDeltaSince,
  mintCallId,
  parseFieldsArg,
  textResult,
  validateStringOutcome,
  type CompactFieldName,
} from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, notFoundMessage, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';

/** Maximum symbols accepted by the `symbols` batch parameter. Mirror
 *  of {@link BATCHED_SYMBOLS_MAX} from `_common-fields.ts`, so the
 *  schema-side Zod cap and any defense-in-depth runtime checks share
 *  one source of truth. */
const MAX_SYMBOLS = BATCHED_SYMBOLS_MAX;
export const CALLERS_MAX_SYMBOLS = MAX_SYMBOLS;

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
function formatBatchedMultiMatch(
  args: FormatBatchedSectionArgs,
  matches: Node[],
  matchesNote: string,
): BatchedSectionResult {
  const { ctx, cg, sym, perSymbolLimit, edgeKindFilter, minConfidence } = args;
  const grouped = formatGroupedCallers({
    cg,
    symbol: sym,
    matches,
    ...(matchesNote ? { matchesNote } : {}),
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
    return formatBatchedMultiMatch(args, allMatches.nodes, allMatches.note);
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
