/**
 * cartograph_walk — bounded BFS over the graph in one call.
 *
 * Replaces 5-10 chained `cartograph_callers` / `cartograph_callees` calls
 * during agent investigations by doing the BFS loop on the server side and
 * returning a single flat list annotated with depth + via-parent.
 *
 * Stage 6 #6.4 of the embedding-features arc.
 *
 * @param direction - Graph orientation: 'callers' | 'callees' | 'impact' | 'both'
 *   'both' is a friendly alias for 'impact' (bidirectional neighborhood query).
 * @param rankBy - Result ordering: 'bfs' (default, first-seen order) | 'centrality'
 *   (sort by PageRank centrality descending, NULL last — surfaces the spine of
 *   hub symbol neighborhoods instead of an arbitrary BFS slice).
 */

import type { Node } from '../../types.js';
import { clamp, isTestPath, numArg } from '../../utils.js';
import { getIncomingEdges, getOutgoingEdges } from '../../db/queries-edges.js';
import { getSymbolRoles } from '../../db/queries-roles.js';
import { textResult, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, symbolNotFound } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import type Cartograph from '../../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HOPS = 2;
const DEFAULT_MAX_NODES = 50;
const MIN_HOPS = 1;
const MAX_HOPS = 5;
const MIN_MAX_NODES = 1;
const MAX_MAX_NODES = 200;
export const WALK_MAX_HOPS = MAX_HOPS;
export const WALK_DEFAULT_MAX_NODES = DEFAULT_MAX_NODES;
export const WALK_MAX_MAX_NODES = MAX_MAX_NODES;

/** Edge kinds excluded from un-filtered BFS (opt-in only). */
const EXCLUDED_WALK_KINDS: ReadonlySet<string> = new Set(['similar_to', 'def_use', 'contains']);

/**
 * Default edge kinds for the `callees` direction when no explicit `edgeKind`
 * is supplied. Mirrors `CALL_REF_EDGE_KINDS` in `src/graph/traversal.ts` so
 * multi-hop BFS uses the same edge set as the one-hop `_callees` path and
 * doesn't surface structural/type edges (`type_of`, `returns`, `extends`,
 * `implements`, `overrides`, `decorates`, `instantiates`, `field_access`) as
 * depth-1 callees. Pass an explicit `edgeKind` to override when structural
 * traversal is intentional (e.g. `direction: 'callees', edgeKind: 'extends'`).
 */
const CALLEES_DEFAULT_EDGE_KINDS: ReadonlySet<string> = new Set(['calls', 'references', 'imports']);

/**
 * Container node kinds whose `contains` edges should be auto-included in
 * downstream walks (`callees` / `impact` / `both`). When the BFS starts on
 * one of these and `edgeKind` is not explicitly set, `contains` is folded
 * into the un-filtered traversal so the caller gets the container's members
 * (methods / fields / nested types) without a separate SQL fallback.
 *
 * Skipped on `direction: 'callers'` because parent-file `contains` edges
 * would flood the result with the symbol's enclosing file/module.
 */
const CONTAINER_KINDS_AUTO_CONTAINS: ReadonlySet<string> = new Set([
  'class',
  'interface',
  'struct',
  'module',
  'trait',
  'protocol',
  'namespace',
]);

/** Internal direction union — 'both' is normalized to 'impact' before this type is used. */
type WalkDirection = 'callers' | 'callees' | 'impact';
/** Public-facing direction including the 'both' alias for 'impact'. */
type WalkDirectionInput = WalkDirection | 'both';
const VALID_DIRECTIONS: ReadonlySet<string> = new Set<WalkDirectionInput>(['callers', 'callees', 'impact', 'both']);

type WalkRankBy = 'bfs' | 'centrality';
const VALID_RANK_BY: ReadonlySet<string> = new Set<WalkRankBy>(['bfs', 'centrality']);

// Every emitted `EdgeKind` from `src/types.ts`. Kept in lockstep with the
// type union — adding an EdgeKind variant without listing it here would
// silently reject a real edge at the user-passable boundary. The default
// traversal still excludes `similar_to` / `def_use` / `contains` (see
// EXCLUDED_WALK_KINDS) — listing them here makes them OPT-IN, not default.
const VALID_EDGE_KINDS = [
  // call + reference edges
  'calls',
  'instantiates',
  'references',
  'type_of',
  'returns',
  // structural inheritance + import
  'extends',
  'implements',
  'overrides',
  'decorates',
  'imports',
  // structural containment / export
  'contains',
  'exports',
  // convention-derived / runtime data access
  'tests',
  'field_access',
  // opt-in (excluded from default un-filtered traversal; pass to opt in)
  'similar_to',
  'def_use',
] as const;
export const WALK_VALID_EDGE_KINDS = VALID_EDGE_KINDS;

// ---------------------------------------------------------------------------
// BFS row type
// ---------------------------------------------------------------------------

interface WalkRow {
  node: Node;
  depth: number;
  viaName: string;
  viaId: string;
}

// ---------------------------------------------------------------------------
// Direction-aware neighbor fetch
// ---------------------------------------------------------------------------

/**
 * Fetch one-hop neighbor node IDs from the graph, respecting direction and
 * optional edge-kind filter.
 *
 * - callers: incoming edges → source IDs
 * - callees: outgoing edges → target IDs
 * - impact: both directions (incoming + outgoing), broader set
 */
interface FetchNeighborArgs {
  cg: Cartograph;
  nodeId: string;
  direction: WalkDirection;
  edgeKindFilter: string | undefined;
  /** When true, do NOT exclude `contains` from un-filtered traversal —
   *  fold container members (methods / fields / nested types) into the
   *  outgoing/bidirectional frontier. Set by the handler when the start
   *  node is a container kind and no explicit `edgeKind` was passed.
   *  Ignored when `edgeKindFilter` is set or `direction === 'callers'`. */
  includeContains: boolean;
}

function fetchNeighborIds(args: FetchNeighborArgs): string[] {
  const { cg, nodeId, direction, edgeKindFilter, includeContains } = args;
  const queries = cg.queries;
  // Build the per-call exclusion set: drop `contains` from EXCLUDED only when
  // the caller has opted in. The skip is direction-aware below — `callers`
  // never opts in (would flood with parent-file edges).
  const excluded: ReadonlySet<string> =
    includeContains && direction !== 'callers'
      ? new Set([...EXCLUDED_WALK_KINDS].filter((k) => k !== 'contains'))
      : EXCLUDED_WALK_KINDS;

  if (direction === 'callers') {
    const kinds = edgeKindFilter ? [edgeKindFilter as import('../../types.js').EdgeKind] : undefined;
    const edges = getIncomingEdges(queries, nodeId, kinds);
    const filtered = edgeKindFilter ? edges : edges.filter((e) => !excluded.has(e.kind));
    return filtered.map((e) => e.source);
  }

  if (direction === 'callees') {
    const kinds = edgeKindFilter ? [edgeKindFilter as import('../../types.js').EdgeKind] : undefined;
    const edges = getOutgoingEdges(queries, nodeId, kinds);
    if (edgeKindFilter) return edges.map((e) => e.target);
    // No explicit edgeKind: apply the same call/ref/import allow-list the
    // one-hop _callees path uses — keeps structural edges (type_of, returns,
    // extends, implements, overrides, decorates, instantiates, field_access)
    // from surfacing as depth-1 callees in multi-hop BFS (BFS/one-hop parity,
    // FRICTION-B8). `contains` is folded in when the caller opted in for a
    // container start, so `direction:'callees'` on a class still lists its
    // members (the documented container auto-contains behavior).
    const allowed: ReadonlySet<string> = includeContains
      ? new Set([...CALLEES_DEFAULT_EDGE_KINDS, 'contains'])
      : CALLEES_DEFAULT_EDGE_KINDS;
    return edges.filter((e) => allowed.has(e.kind)).map((e) => e.target);
  }

  // impact: incoming + outgoing (excluding structural noise)
  const inEdges = getIncomingEdges(queries, nodeId);
  const outEdges = getOutgoingEdges(queries, nodeId);
  const allEdges = [...inEdges, ...outEdges].filter((e) => !excluded.has(e.kind));
  const edgesFiltered = edgeKindFilter ? allEdges.filter((e) => e.kind === edgeKindFilter) : allEdges;
  return edgesFiltered.map((e) => (e.source === nodeId ? e.target : e.source));
}

// ---------------------------------------------------------------------------
// BFS core
// ---------------------------------------------------------------------------

/**
 * Run bounded BFS from `startId`, returning rows in BFS order (depth + first-
 * seen order). The start node is excluded from the output — the caller already
 * knows it.
 *
 * `excludeTests`: when true, neighbor nodes whose `filePath` matches
 * `isTestPath` are dropped from BOTH the result and the frontier expansion.
 * Caller must already have decided to disable the filter when the START
 * itself is in a test file (the "what does my test exercise" inverse case);
 * this layer only sees the resolved boolean.
 */
interface BfsArgs {
  cg: Cartograph;
  startId: string;
  startName: string;
  direction: WalkDirection;
  hops: number;
  maxNodes: number;
  edgeKindFilter: string | undefined;
  includeContains: boolean;
  excludeTests: boolean;
}

function runBfs(args: BfsArgs): WalkRow[] {
  const { cg, startId, startName, direction, hops, maxNodes, edgeKindFilter, includeContains, excludeTests } = args;

  interface QueueEntry {
    nodeId: string;
    depth: number;
    viaName: string;
    viaId: string;
  }

  // visited maps nodeId → { depth, viaName, viaId }
  const visited = new Map<string, { depth: number; viaName: string; viaId: string }>();
  visited.set(startId, { depth: 0, viaName: '', viaId: '' });

  const queue: QueueEntry[] = [{ nodeId: startId, depth: 0, viaName: startName, viaId: startId }];
  const rows: WalkRow[] = [];

  while (queue.length > 0 && rows.length < maxNodes) {
    const current = queue.shift()!;
    const { nodeId, depth, viaName, viaId } = current;

    if (depth >= hops) continue;

    const neighborIds = fetchNeighborIds({ cg, nodeId, direction, edgeKindFilter, includeContains });
    // Batch-fetch neighbor nodes to avoid N+1 lookups
    const uniqueNewIds = [...new Set(neighborIds)].filter((id) => !visited.has(id));
    const neighborNodes = uniqueNewIds.length > 0 ? cg.queries.getNodesByIds(uniqueNewIds) : new Map<string, Node>();

    for (const nextId of neighborIds) {
      if (visited.has(nextId)) continue;
      const nextNode = neighborNodes.get(nextId);
      if (!nextNode) continue;
      // Test-file noise filter: BFS from production code into test-file
      // consumers is structural noise for "what does X transitively call"
      // queries. Marking the node visited (without pushing a row or
      // queue entry) blocks rediscovery via other paths and avoids
      // walking deeper through a test file's helpers.
      if (excludeTests && isTestPath(nextNode.filePath)) {
        visited.set(nextId, { depth: depth + 1, viaName, viaId });
        continue;
      }

      visited.set(nextId, { depth: depth + 1, viaName, viaId });
      rows.push({ node: nextNode, depth: depth + 1, viaName, viaId });

      if (rows.length >= maxNodes) break;

      queue.push({
        nodeId: nextId,
        depth: depth + 1,
        viaName: nextNode.name,
        viaId: nextId,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format the BFS result as a compact pipe-delimited list (default) or
 * markdown bullets.
 *
 * Compact row format:
 *   name|kind|path:line|depth=N|via=parent_name|id:n_xxxxxxxx
 *
 * Header:
 *   Walk from <start> direction=<dir> hops=<n> (M nodes)
 *   Walk from <start> direction=<dir> hops=<n> rankBy=centrality (M nodes)
 */
interface FormatWalkArgs {
  rows: WalkRow[];
  startName: string;
  direction: WalkDirection;
  hops: number;
  compact: boolean;
  rankBy: WalkRankBy;
  /** Per-node role lookup. When passed, each row gets a `role:<value>`
   *  column appended (compact) or `, role:<value>` after the kind
   *  (markdown). Nodes absent from the map render no role column. */
  roles?: Map<string, string>;
}

function formatWalkResult(args: FormatWalkArgs): string {
  const { rows, startName, direction, hops, compact, rankBy, roles } = args;
  const rankByPart = rankBy === 'centrality' ? ' rankBy=centrality' : '';
  const header = `Walk from ${startName} direction=${direction} hops=${hops}${rankByPart} (${rows.length} nodes)`;

  // Tip when centrality data is sparse
  let centralityTip = '';
  if (rankBy === 'centrality' && rows.length > 0) {
    const nullCount = rows.filter((r) => r.node.centrality == null).length;
    if (nullCount >= Math.ceil(rows.length / 2)) {
      centralityTip = `\n> Note: ${nullCount} of ${rows.length} rows have no centrality computed yet — run a fresh \`cartograph admin index\` for the centrality hook to fire.`;
    }
  }

  if (rows.length === 0) {
    return `${header}\n(no neighbors found)`;
  }

  const lines: string[] = [header, ''];

  if (compact) {
    for (const { node, depth, viaName } of rows) {
      const loc = node.startLine ? `:${node.startLine}` : '';
      const via = viaName ? `|via=${viaName}` : '';
      const role = roles?.get(node.id);
      const roleCol = role ? `|role:${role}` : '';
      lines.push(`${node.name}|${node.kind}|${node.filePath}${loc}|depth=${depth}${via}${roleCol}|id:${node.id}`);
    }
  } else {
    for (const { node, depth, viaName } of rows) {
      const loc = node.startLine ? `:${node.startLine}` : '';
      const via = viaName ? ` via ${viaName}` : '';
      const role = roles?.get(node.id);
      const roleTag = role ? `, role:${role}` : '';
      lines.push(
        `- **${node.name}** (${node.kind}${roleTag}) — \`${node.filePath}${loc}\` depth=${depth}${via} \`id:${node.id}\``,
      );
    }
  }

  return lines.join('\n') + centralityTip;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Validated, normalised inputs extracted from the raw MCP args record. */
interface WalkArgs {
  startRaw: string;
  direction: WalkDirection;
  rankBy: WalkRankBy;
  edgeKindFilter: string | undefined;
  hops: number;
  maxNodes: number;
  compact: boolean;
  includeRoles: boolean;
  /** When false (default on multi-hop BFS), drop test-file targets from
   *  the BFS expansion and from the result set — keeps "what does X
   *  transitively call" answers focused on the runtime call tree
   *  instead of leaking into test-file consumers of intermediate
   *  callees. When the START itself is a test-file symbol, the
   *  handler overrides this to true (the inverse "what does my test
   *  exercise" case stays usable). */
  includeTests: boolean;
  cg: Cartograph;
}

/**
 * Validate and normalise the raw MCP args record into a typed {@link WalkArgs}
 * bundle. Returns a {@link ToolOutcome} `err` arm on the first
 * validation failure so the caller can return early with a single guard.
 */
function parseWalkArgs(args: Record<string, unknown>, ctx: ToolCtx): WalkArgs | ToolOutcome {
  // --- validate start ---
  const startRaw = validateStringOutcome({ value: args['start'], name: 'start' });
  if (typeof startRaw !== 'string') return startRaw;

  // --- validate direction ---
  const directionRaw = args['direction'];
  if (!directionRaw || !VALID_DIRECTIONS.has(directionRaw as string)) {
    return err(`direction must be one of: ${[...VALID_DIRECTIONS].join(', ')}; got ${JSON.stringify(directionRaw)}.`);
  }
  // Normalize 'both' alias to internal 'impact' direction
  const direction: WalkDirection = (directionRaw as string) === 'both' ? 'impact' : (directionRaw as WalkDirection);

  // --- validate rankBy ---
  const rankByRaw = args['rankBy'];
  if (rankByRaw !== undefined && rankByRaw !== null) {
    if (!VALID_RANK_BY.has(rankByRaw as string)) {
      return err(`rankBy must be one of: ${[...VALID_RANK_BY].join(', ')}; got ${JSON.stringify(rankByRaw)}.`);
    }
  }
  const rankBy: WalkRankBy = (rankByRaw as WalkRankBy | undefined) ?? 'bfs';

  // --- validate edgeKind ---
  const edgeKindRaw = args['edgeKind'];
  if (edgeKindRaw !== undefined && edgeKindRaw !== null) {
    if (!VALID_EDGE_KINDS.includes(edgeKindRaw as (typeof VALID_EDGE_KINDS)[number])) {
      return err(`edgeKind must be one of: ${VALID_EDGE_KINDS.join(', ')}; got ${JSON.stringify(edgeKindRaw)}.`);
    }
  }
  const edgeKindFilter = edgeKindRaw as string | undefined;

  // --- clamp numeric args ---
  const hops = clamp(numArg(args['hops'], DEFAULT_HOPS), MIN_HOPS, MAX_HOPS);
  const maxNodes = clamp(numArg(args['maxNodes'], DEFAULT_MAX_NODES), MIN_MAX_NODES, MAX_MAX_NODES);

  const compact = args['compact'] !== false; // default true
  const includeRoles = args['includeRoles'] === true;
  // includeTests defaults to false on the BFS path (`hops > 1` route).
  // The dispatcher in graph.ts may pre-set the flag for the one-hop
  // back-compat path; respect it when explicit, otherwise default false.
  const includeTests = args['includeTests'] === true;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);

  return { startRaw, direction, rankBy, edgeKindFilter, hops, maxNodes, compact, includeRoles, includeTests, cg };
}

// ---------------------------------------------------------------------------
// Centrality sort
// ---------------------------------------------------------------------------

/**
 * Sort BFS rows by node centrality descending (NULL last), then truncate to
 * `maxNodes`. JS sort is stable (TC39 since ES2019), so BFS order is
 * preserved as the tie-breaker among equal centrality values.
 */
function sortByCentrality(rows: WalkRow[], maxNodes: number): WalkRow[] {
  return rows
    .sort((a, b) => {
      const ca = a.node.centrality ?? null;
      const cb = b.node.centrality ?? null;
      if (ca === null && cb === null) return 0;
      if (ca === null) return 1; // nulls sort last
      if (cb === null) return -1;
      return cb - ca; // descending
    })
    .slice(0, maxNodes);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleWalk(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const parsed = parseWalkArgs(args, ctx);
  if ('ok' in parsed) return parsed; // ToolOutcome err arm — return early

  const { startRaw, direction, rankBy, edgeKindFilter, hops, maxNodes, compact, includeRoles, includeTests, cg } =
    parsed;

  // --- resolve start symbol ---
  const allMatches = findAllSymbols(cg, startRaw, ctx.refIds);
  if (allMatches.nodes.length === 0) {
    return ok(textResult(symbolNotFound(cg, startRaw)));
  }

  // Use the first match (highest centrality, non-fixture preferred by findAllSymbols)
  const startNode = allMatches.nodes[0]!;
  const startName = startNode.name;

  // Auto-include `contains` edges when the start node is a container kind and
  // the caller did NOT pin `edgeKind`. Skip on `direction: 'callers'` because
  // parent-file `contains` edges would flood the result with the symbol's
  // enclosing file/module instead of useful members. Lets `walk(start: SomeClass,
  // direction: 'callees')` list the class's methods/fields without a SQL fallback.
  const includeContains =
    edgeKindFilter === undefined && direction !== 'callers' && CONTAINER_KINDS_AUTO_CONTAINS.has(startNode.kind);

  // Test-file BFS noise filter. Default: drop test-file targets from
  // the expansion. Inverse case: when the START is itself a test-file
  // symbol, the agent is asking "what does my test exercise" — keep
  // test-file traversal on so the walker can reach test helpers /
  // setup files. `includeTests: true` from the caller forces it on
  // regardless.
  const excludeTests = !includeTests && !isTestPath(startNode.filePath);

  // --- run BFS ---
  // When rankBy='centrality', over-fetch the full budget first so the complete
  // untruncated frontier is available for sorting, then re-truncate after sort.
  const bfsMaxNodes = rankBy === 'centrality' ? MAX_MAX_NODES : maxNodes;
  let rows = runBfs({
    cg,
    startId: startNode.id,
    startName,
    direction,
    hops,
    maxNodes: bfsMaxNodes,
    edgeKindFilter,
    includeContains,
    excludeTests,
  });

  if (rankBy === 'centrality') {
    rows = sortByCentrality(rows, maxNodes);
  }

  const roles = includeRoles
    ? getSymbolRoles(
        cg.queries,
        rows.map((r) => r.node.id),
      )
    : undefined;
  const formatted = formatWalkResult({
    rows,
    startName,
    direction,
    hops,
    compact,
    rankBy,
    ...(roles ? { roles } : {}),
  });

  // Cap hint — the chokepoint appends it AFTER truncating the body, so a
  // wide walk listing can't push the hint off the budget.
  const hasMore = rows.length >= maxNodes;
  return ok(
    renderToolResponse({
      body: formatted + allMatches.note,
      footers: [
        hasMore
          ? `> Result capped at maxNodes=${maxNodes}. Pass a higher \`maxNodes\` or lower \`hops\` to see more.`
          : undefined,
      ],
      freshness: { cg, nodes: rows.map((r) => r.node) },
    }),
  );
}

// WALK_TOOL export removed in the 2026-05-11 four-tool merge. The public
// surface is now `cartograph_graph` (which dispatches BFS when `hops > 1`);
// this module is reached only via that tool's dispatcher in `graph.ts`.
