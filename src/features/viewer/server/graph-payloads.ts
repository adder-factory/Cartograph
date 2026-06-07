import { findEdgesBetweenNodes } from '../../../db/queries-edges.js';
import { getNodesByKind } from '../../../db/queries.js';
import type { Edge, EdgeKind, Node, NodeKind } from '../../../types.js';
import {
  DEFAULT_GRAPH_ROOT_CANDIDATES,
  GRAPH_BFS_LIMIT,
  GRAPH_DEPTH,
  GRAPH_LIMIT,
  VIEWER_EXCLUDED_EDGE_KINDS,
} from './constants.js';
import type { RequestContext } from './context.js';
import { clampInt } from './http.js';
import { resolveSymbolToNode, serializeGraphNode } from './node-payloads.js';

type GraphMode = 'focus' | 'core' | 'all';
type ImpactMode = 'callers' | 'callees' | 'both';

interface GraphPayloadOptions {
  readonly mode: GraphMode;
  readonly limit: number | undefined;
}

interface GraphPayloadArgs {
  readonly ctx: RequestContext;
  readonly focus: string | null;
  readonly depth: number;
  readonly opts: GraphPayloadOptions;
}

interface LimitGraphNodesArgs {
  readonly nodes: Map<string, Node>;
  readonly edgesById: Map<string, { source: string; target: string; kind: string }>;
  readonly focusId: string;
  readonly limit: number | undefined;
}

interface CollectedGraph {
  readonly nodes: Map<string, Node>;
  readonly edgesById: Map<string, { source: string; target: string; kind: string }>;
}

interface CollectFocusGraphArgs {
  readonly ctx: RequestContext;
  readonly focusNode: Node;
  readonly depth: number;
}

interface DefaultGraphRootCandidate {
  readonly node: Node;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly score: number;
}

interface PathPayloadArgs {
  ctx: RequestContext;
  fromRaw: string;
  toRaw: string;
  edgeKinds: EdgeKind[];
}

interface CollectImpactGraphArgs {
  readonly ctx: RequestContext;
  readonly focusNode: Node;
  readonly mode: ImpactMode;
  readonly depth: number;
  readonly limit: number;
  readonly edgeKinds: EdgeKind[];
}

interface ImpactPayloadArgs {
  readonly ctx: RequestContext;
  readonly focusRaw: string;
  readonly mode: ImpactMode;
  readonly depth: number;
  readonly limit: number;
  readonly edgeKinds: EdgeKind[];
}

export function graphPayload(args: GraphPayloadArgs): unknown {
  const { ctx, focus, depth, opts } = args;
  if (!focus) {
    const root = chooseDefaultGraphRoot(ctx, opts);
    if (!root) return { mode: opts.mode, limit: opts.limit ?? null, nodes: [], edges: [], focus: null };
    return graphPayload({ ctx, focus: root.id, depth: GRAPH_DEPTH.default, opts });
  }

  const focusNode = resolveSymbolToNode(ctx.queries, focus);
  if (!focusNode) {
    return {
      mode: opts.mode,
      limit: opts.limit ?? null,
      nodes: [],
      edges: [],
      focus: null,
      error: `unknown symbol: ${focus}`,
    };
  }
  const { nodes, edgesById } = collectFocusGraph({ ctx, focusNode, depth });
  const limited = limitGraphNodes({ nodes, edgesById, focusId: focusNode.id, limit: opts.limit });
  return {
    mode: opts.mode,
    limit: opts.limit ?? null,
    focus: focusNode.id,
    nodes: limited.nodes.map((node) => serializeGraphNode(ctx, node)),
    edges: limited.edges,
  };
}

export function parseGraphMode(v: string | null): GraphMode {
  if (v === 'focus' || v === 'core' || v === 'all') return v;
  return 'core';
}

export function parseGraphLimit(v: string | null, mode: GraphMode): number | undefined {
  if (v !== null) return clampInt(v, GRAPH_LIMIT);
  if (mode === 'focus') return 32;
  if (mode === 'core') return GRAPH_LIMIT.default;
  return undefined;
}

function chooseDefaultGraphRoot(ctx: RequestContext, opts: GraphPayloadOptions): Node | null {
  const kinds: NodeKind[] = ['function', 'method', 'class'];
  const all: Node[] = [];
  for (const k of kinds) all.push(...getNodesByKind(ctx.queries, k));
  if (all.length === 0) return null;

  const candidates = [...all]
    .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0) || a.name.localeCompare(b.name))
    .slice(0, DEFAULT_GRAPH_ROOT_CANDIDATES);
  let best: DefaultGraphRootCandidate | null = null;
  for (const node of candidates) {
    const collected = collectFocusGraph({ ctx, focusNode: node, depth: GRAPH_DEPTH.default });
    const limited = limitGraphNodes({
      nodes: collected.nodes,
      edgesById: collected.edgesById,
      focusId: node.id,
      limit: opts.limit,
    });
    const edgeCount = limited.edges.length;
    const nodeCount = limited.nodes.length;
    const score = edgeCount * 10 + nodeCount + (node.centrality ?? 0);
    if (!best || score > best.score) best = { node, nodeCount, edgeCount, score };
  }
  return best?.node ?? candidates[0] ?? null;
}

function collectFocusGraph(args: CollectFocusGraphArgs): CollectedGraph {
  const { ctx, focusNode, depth } = args;
  const sub = ctx.traverser.traverseBFS(focusNode.id, {
    maxDepth: depth,
    direction: 'outgoing',
    limit: GRAPH_BFS_LIMIT,
  });
  const incoming = ctx.traverser.traverseBFS(focusNode.id, {
    maxDepth: depth,
    direction: 'incoming',
    limit: GRAPH_BFS_LIMIT,
  });
  const nodes = new Map<string, Node>();
  for (const [id, n] of sub.nodes) nodes.set(id, n);
  for (const [id, n] of incoming.nodes) nodes.set(id, n);
  const edgesById = new Map<string, { source: string; target: string; kind: string }>();
  const nodeIds = [...nodes.keys()];
  const internalEdges = findEdgesBetweenNodes(ctx.queries, nodeIds).filter(
    (e) => !VIEWER_EXCLUDED_EDGE_KINDS.has(e.kind),
  );
  for (const e of internalEdges) {
    edgesById.set(`${e.source}__${e.target}__${e.kind}`, { source: e.source, target: e.target, kind: e.kind });
  }
  return { nodes, edgesById };
}

function limitGraphNodes(args: LimitGraphNodesArgs): {
  nodes: Node[];
  edges: Array<{ source: string; target: string; kind: string }>;
} {
  const { nodes, edgesById, focusId, limit } = args;
  const allNodes = [...nodes.values()];
  const allEdges = [...edgesById.values()];
  if (!limit || allNodes.length <= limit) return { nodes: allNodes, edges: allEdges };

  const keep = new Set<string>();
  const frontier: string[] = [];
  const adjacency = new Map<string, string[]>();
  for (const edge of allEdges) {
    const a = adjacency.get(edge.source) ?? [];
    a.push(edge.target);
    adjacency.set(edge.source, a);
    const b = adjacency.get(edge.target) ?? [];
    b.push(edge.source);
    adjacency.set(edge.target, b);
  }
  const add = (id: string): boolean => {
    if (keep.size >= limit || !nodes.has(id) || keep.has(id)) return false;
    keep.add(id);
    frontier.push(id);
    return true;
  };

  add(focusId);
  for (let i = 0; i < frontier.length && keep.size < limit; i++) {
    const id = frontier[i]!;
    const neighbors = (adjacency.get(id) ?? [])
      .filter((candidate) => !keep.has(candidate))
      .sort(
        (a, b) =>
          (nodes.get(b)?.centrality ?? 0) - (nodes.get(a)?.centrality ?? 0) ||
          (nodes.get(a)?.name ?? '').localeCompare(nodes.get(b)?.name ?? ''),
      );
    for (const neighbor of neighbors) {
      if (keep.size >= limit) break;
      add(neighbor);
    }
  }

  const limitedNodes = [...keep].map((id) => nodes.get(id)).filter((node): node is Node => Boolean(node));
  const limitedEdges = allEdges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
  return { nodes: limitedNodes, edges: limitedEdges };
}

export function parseImpactMode(v: string | null): ImpactMode {
  if (v === 'callers' || v === 'callees' || v === 'both') return v;
  return 'both';
}

export function parseEdgeKinds(params: URLSearchParams): EdgeKind[] {
  const raw = [...params.getAll('edgeKind'), ...params.getAll('edgeKinds')]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(raw)] as EdgeKind[];
}

function serializeGraphEdge(edge: Pick<Edge, 'source' | 'target' | 'kind'>): {
  source: string;
  target: string;
  kind: string;
} {
  return { source: edge.source, target: edge.target, kind: edge.kind };
}

export function pathPayload({ ctx, fromRaw, toRaw, edgeKinds }: PathPayloadArgs): unknown {
  const from = resolveSymbolToNode(ctx.queries, fromRaw);
  if (!from) return { found: false, error: `unknown symbol: ${fromRaw}`, from: null, to: null, nodes: [], edges: [] };
  const to = resolveSymbolToNode(ctx.queries, toRaw);
  if (!to) {
    return {
      found: false,
      error: `unknown symbol: ${toRaw}`,
      from: serializeGraphNode(ctx, from),
      to: null,
      nodes: [serializeGraphNode(ctx, from)],
      edges: [],
    };
  }

  const path = ctx.traverser.findPath(from.id, to.id, edgeKinds);
  if (!path) {
    return {
      found: false,
      from: serializeGraphNode(ctx, from),
      to: serializeGraphNode(ctx, to),
      nodes: [serializeGraphNode(ctx, from), serializeGraphNode(ctx, to)],
      edges: [],
    };
  }
  const edges = path
    .map((hop) => hop.edge)
    .filter((edge): edge is Edge => Boolean(edge))
    .map(serializeGraphEdge);
  return {
    found: true,
    from: serializeGraphNode(ctx, from),
    to: serializeGraphNode(ctx, to),
    hopCount: Math.max(0, path.length - 1),
    edgeKinds,
    nodes: path.map((hop) => serializeGraphNode(ctx, hop.node)),
    edges,
  };
}

function collectImpactGraph(args: CollectImpactGraphArgs): CollectedGraph {
  const { ctx, focusNode, mode, depth, limit, edgeKinds } = args;
  const nodes = new Map<string, Node>();
  nodes.set(focusNode.id, focusNode);
  for (const direction of impactDirections(mode)) {
    const subgraph = ctx.traverser.traverseBFS(focusNode.id, {
      direction,
      maxDepth: depth,
      limit,
      edgeKinds,
    });
    for (const [id, node] of subgraph.nodes) nodes.set(id, node);
  }

  const nodeIds = [...nodes.keys()];
  const kindFilter = edgeKinds.length > 0 ? new Set(edgeKinds) : null;
  const internalEdges = findEdgesBetweenNodes(ctx.queries, nodeIds).filter((edge) => {
    if (kindFilter) return kindFilter.has(edge.kind);
    return !VIEWER_EXCLUDED_EDGE_KINDS.has(edge.kind);
  });
  const edgesById = new Map<string, { source: string; target: string; kind: string }>();
  for (const edge of internalEdges)
    edgesById.set(`${edge.source}__${edge.target}__${edge.kind}`, serializeGraphEdge(edge));
  return { nodes, edgesById };
}

function impactDirections(mode: ImpactMode): Array<'incoming' | 'outgoing'> {
  if (mode === 'callers') return ['incoming'];
  if (mode === 'callees') return ['outgoing'];
  return ['incoming', 'outgoing'];
}

export function impactPayload(args: ImpactPayloadArgs): unknown {
  const { ctx, focusRaw, mode, depth, limit, edgeKinds } = args;
  const focus = resolveSymbolToNode(ctx.queries, focusRaw);
  if (!focus) return { error: `unknown symbol: ${focusRaw}`, focus: null, mode, depth, nodes: [], edges: [] };
  const collected = collectImpactGraph({ ctx, focusNode: focus, mode, depth, limit, edgeKinds });
  const limited = limitGraphNodes({
    nodes: collected.nodes,
    edgesById: collected.edgesById,
    focusId: focus.id,
    limit,
  });
  return {
    focus: serializeGraphNode(ctx, focus),
    mode,
    depth,
    limit,
    edgeKinds,
    nodes: limited.nodes.map((node) => serializeGraphNode(ctx, node)),
    edges: limited.edges,
  };
}
