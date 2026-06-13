/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the code knowledge graph.
 */

import type { Subgraph, TraversalOptions } from './types.js';
import type { Edge, EdgeKind, Node } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getOutgoingEdges, getIncomingEdges } from '../db/queries-edges.js';

/**
 * Default traversal options.
 *
 * `maxDepth` is bounded by default — an unbounded depth on a highly connected
 * graph can grow `visited` and the BFS/DFS frontier well beyond `limit` before
 * the limit cuts in. Callers who really want unlimited depth can pass
 * `maxDepth: Infinity` explicitly.
 */
/**
 * Node-count ceiling for an impact traversal. Unlike BFS/DFS (which cap on
 * `limit`), `getImpactRadius` was depth-only, so a hub symbol on a large
 * repo (a logger/util with 10k+ dependents) could materialize a huge
 * fraction of the whole graph into memory — ×50 matches on the MCP impact
 * path. Bounded here; callers wanting more pass an explicit `maxNodes`.
 */
const DEFAULT_IMPACT_MAX_NODES = 2000;

const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: 10,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/**
 * Hard cap on `findPath`'s BFS queue. Even with parent pointers rather
 * than per-entry path clones, a dense graph can still create a very
 * large frontier before either finding a path or exhausting the search.
 */
const FIND_PATH_MAX_QUEUE = 100_000;

/**
 * Result of a single traversal step
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/** Container-kind set hoisted to module scope so getImpactRecursive
 *  doesn't recreate it on every call. */
const CONTAINER_KINDS_FOR_IMPACT: ReadonlySet<Node['kind']> = new Set<Node['kind']>([
  'class',
  'interface',
  'struct',
  'trait',
  'protocol',
  'module',
  'enum',
]);

/** Edge kinds excluded from default traversal. similar_to and def_use are
 *  opt-in: similar_to from embeddings, def_use from intra-procedural data flow. */
const EXCLUDED_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['similar_to', 'def_use']);

/** Edge kinds counted as "calls" + reference-style edges for callers/callees walks. */
const CALL_REF_EDGE_KINDS = ['calls', 'references', 'imports'] as const;

/** Argument bundle for {@link GraphTraverser.expandBfsNeighbors}. */
interface BfsNeighborOpts {
  node: Node;
  depth: number;
  opts: Required<TraversalOptions>;
  visited: Set<string>;
  nodes: Map<string, Node>;
  queue: TraversalStep[];
}

/** Argument bundle for {@link GraphTraverser.dfsRecursive}. */
interface DfsRecOpts {
  node: Node;
  depth: number;
  opts: Required<TraversalOptions>;
  nodes: Map<string, Node>;
  edges: Edge[];
  visited: Set<string>;
}

/** Argument bundle for the symmetric {@link GraphTraverser.getCallersRecursive} +
 *  {@link GraphTraverser.getCalleesRecursive}. */
interface CallWalkOpts {
  nodeId: string;
  maxDepth: number;
  currentDepth: number;
  result: Array<{ node: Node; edge: Edge }>;
  visited: Set<string>;
  /** Edge kinds to walk. Defaults to {@link CALL_REF_EDGE_KINDS}; the
   *  MCP `edgeKind` filter passes a single explicit kind so structural /
   *  type edges (`contains`, `returns`, `type_of`, `extends`, …) are
   *  reachable via callers/callees instead of silently filtered against
   *  a calls-only candidate set (issue #7). */
  edgeKinds: readonly EdgeKind[];
}

/** Shared context for type hierarchy / path frontier functions. */
interface TraversalGraphOpts {
  queries: QueryBuilder;
  nodes: Map<string, Node>;
  edges: Edge[];
  visited: Set<string>;
}

interface PathQueueEntry {
  node: Node;
  edge: Edge | null;
  parentIndex: number;
}

/** BFS frontier state for findPath. */
interface PathFrontier {
  parentIndex: number;
  queue: PathQueueEntry[];
}

/** Argument bundle for {@link GraphTraverser.getImpactRecursive} and its two
 *  expand-helpers (container children, dependent predecessors). */
interface ImpactRecOpts {
  nodeId: string;
  maxDepth: number;
  currentDepth: number;
  /** Stop expanding once `nodes.size` reaches this — see {@link DEFAULT_IMPACT_MAX_NODES}. */
  maxNodes: number;
  reachedViaIncomingContains?: boolean;
  nodes: Map<string, Node>;
  edges: Edge[];
  visited: Set<string>;
  edgeKinds: EdgeKind[] | undefined;
}

/**
 * BFS edge-priority comparator: structural edges first (`contains`,
 * then `calls`), reference edges last. Lets the frontier discover
 * internal structure before fanning out to external usages — without
 * this, e.g. component nodes get flooded by template usages before
 * their own methods/properties are visited.
 */
function bfsEdgePriority(e: Edge): number {
  if (e.kind === 'contains') return 0;
  if (e.kind === 'calls') return 1;
  return 2;
}

/** Return the endpoint of an edge that is NOT the given node id —
 *  i.e. the peer in an undirected traversal step. */
function peerOf(edge: Edge, nodeId: string): string {
  const src = edge.source;
  if (src === nodeId) return edge.target;
  return src;
}

// ---------------------------------------------------------------------------
// Module-scope traversal helpers (extracted from GraphTraverser)
// ---------------------------------------------------------------------------

/** Get adjacent edges based on direction. */
interface TraverserGetAdjacentEdgesArgs {
  queries: QueryBuilder;
  nodeId: string;
  direction: 'outgoing' | 'incoming' | 'both';
  edgeKinds?: EdgeKind[];
}

interface FetchEdgesByDirectionArgs {
  queries: QueryBuilder;
  nodeId: string;
  direction: 'outgoing' | 'incoming' | 'both';
  kinds?: EdgeKind[];
}

/** Direction-aware edge fetch. Splitting the two-axis branching out
 *  of `traverserGetAdjacentEdges` (direction × kinds-set) collapses
 *  the original six-branch conditional into one dispatch + one
 *  filter pass. */
function fetchEdgesByDirection({ queries, nodeId, direction, kinds }: FetchEdgesByDirectionArgs): Edge[] {
  if (direction === 'outgoing') return getOutgoingEdges(queries, nodeId, kinds);
  if (direction === 'incoming') return getIncomingEdges(queries, nodeId, kinds);
  return [...getOutgoingEdges(queries, nodeId, kinds), ...getIncomingEdges(queries, nodeId, kinds)];
}

function traverserGetAdjacentEdges(args: TraverserGetAdjacentEdgesArgs): Edge[] {
  const { queries, nodeId, direction, edgeKinds } = args;
  const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;
  // When no explicit filter is set, exclude derived edges like similar_to.
  // This ensures default traversal stays structural and fast. Callers
  // can opt-in to similar_to by explicitly passing it in edgeKinds.
  if (!kinds) {
    return fetchEdgesByDirection({ queries, nodeId, direction }).filter((e) => !EXCLUDED_EDGE_KINDS.has(e.kind));
  }
  return fetchEdgesByDirection({ queries, nodeId, direction, kinds });
}

/**
 * Expand one BFS frontier step: find adjacent edges (priority-sorted
 * so structural `contains`/`calls` edges are explored before
 * reference edges), batch-fetch the unvisited neighbour nodes (one
 * SQL query, not N+1), then enqueue each neighbour that passes the
 * `nodeKinds` filter.
 */
function traverserExpandBfsNeighbors(queries: QueryBuilder, args: BfsNeighborOpts): void {
  const { node, depth, opts, visited, nodes, queue } = args;
  const nodeId = node.id;
  const adjacentEdges = traverserGetAdjacentEdges({
    queries,
    nodeId,
    direction: opts.direction,
    edgeKinds: opts.edgeKinds,
  });
  adjacentEdges.sort((a, b) => bfsEdgePriority(a) - bfsEdgePriority(b));
  const wantIds = adjacentEdges.map((e) => peerOf(e, nodeId)).filter((id) => !visited.has(id));
  const neighborNodes = wantIds.length > 0 ? queries.getNodesByIds(wantIds) : new Map();

  for (const adjEdge of adjacentEdges) {
    const nextNodeId = peerOf(adjEdge, nodeId);
    if (visited.has(nextNodeId)) continue;
    const nextNode = neighborNodes.get(nextNodeId);
    if (!nextNode) continue;
    const kindFilter = opts.nodeKinds;
    const filteredOut = kindFilter !== undefined && kindFilter.length > 0 && !kindFilter.includes(nextNode.kind);
    if (filteredOut) continue;
    nodes.set(nextNode.id, nextNode);
    queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
  }
}

/** Recursive DFS helper. */
function traverserDfsRecursive(queries: QueryBuilder, args: DfsRecOpts): void {
  const { node, depth, opts, nodes, edges, visited } = args;
  const nodeId = node.id;
  if (visited.has(nodeId) || nodes.size >= opts.limit || depth >= opts.maxDepth) return;

  visited.add(nodeId);

  const adjacentEdges = traverserGetAdjacentEdges({
    queries,
    nodeId,
    direction: opts.direction,
    edgeKinds: opts.edgeKinds,
  });
  const wantIds = adjacentEdges.map((e) => peerOf(e, nodeId)).filter((id) => !visited.has(id));
  const neighborNodes = wantIds.length > 0 ? queries.getNodesByIds(wantIds) : new Map();

  for (const edge of adjacentEdges) {
    const nextNodeId = peerOf(edge, nodeId);
    if (visited.has(nextNodeId)) continue;
    const nextNode = neighborNodes.get(nextNodeId);
    if (!nextNode) continue;
    const kindFilter = opts.nodeKinds;
    if (kindFilter !== undefined && kindFilter.length > 0 && !kindFilter.includes(nextNode.kind)) continue;
    nodes.set(nextNode.id, nextNode);
    edges.push(edge);
    traverserDfsRecursive(queries, { node: nextNode, depth: depth + 1, opts, nodes, edges, visited });
  }
}

/**
 * Walk call/reference edges recursively in a single direction.
 *
 * `direction: 'callers'` — follow incoming edges (who calls `nodeId`).
 * `direction: 'callees'` — follow outgoing edges (what `nodeId` calls).
 *
 * Replaces the former `traverserGetCallersRecursive` /
 * `traverserGetCalleesRecursive` pair that differed only in edge direction.
 */
function traverserGetCallWalkRecursive(
  queries: QueryBuilder,
  args: CallWalkOpts,
  direction: 'callers' | 'callees',
): void {
  const { nodeId, maxDepth, currentDepth, result, visited, edgeKinds } = args;
  if (currentDepth >= maxDepth || visited.has(nodeId)) return;
  visited.add(nodeId);

  const kinds = [...edgeKinds];
  const edges =
    direction === 'callers' ? getIncomingEdges(queries, nodeId, kinds) : getOutgoingEdges(queries, nodeId, kinds);
  if (edges.length === 0) return;

  const peer = direction === 'callers' ? 'source' : 'target';
  const peerNodes = queries.getNodesByIds(edges.map((e) => e[peer]));
  for (const edge of edges) {
    const peerNode = peerNodes.get(edge[peer]);
    if (peerNode && !visited.has(peerNode.id)) {
      result.push({ node: peerNode, edge });
      traverserGetCallWalkRecursive(
        queries,
        { nodeId: peerNode.id, maxDepth, currentDepth: currentDepth + 1, result, visited, edgeKinds },
        direction,
      );
    }
  }
}

function traverserGetImpactRecursive(queries: QueryBuilder, args: ImpactRecOpts): void {
  const { nodeId, maxDepth, currentDepth, maxNodes, nodes, visited } = args;
  if (currentDepth >= maxDepth || visited.has(nodeId) || nodes.size >= maxNodes) return;
  visited.add(nodeId);
  traverserExpandImpactContainerChildren(queries, args);
  traverserExpandImpactDependents(queries, args);
}

/**
 * For container nodes (class / interface / struct / module / enum /
 * trait / protocol), descend into their `contains` children so
 * callers of contained methods appear in the impact set.
 */
function traverserExpandImpactContainerChildren(queries: QueryBuilder, args: ImpactRecOpts): void {
  const { nodeId, maxDepth, currentDepth, reachedViaIncomingContains, nodes, edges, visited, edgeKinds } = args;
  if (edgeKinds !== undefined && !edgeKinds.includes('contains')) return;
  if (reachedViaIncomingContains) return;
  const focalNode = queries.getNodeById(nodeId);
  if (!focalNode || !CONTAINER_KINDS_FOR_IMPACT.has(focalNode.kind)) return;
  const containsEdges = getOutgoingEdges(queries, nodeId, ['contains']);
  if (containsEdges.length === 0) return;
  const children = queries.getNodesByIds(containsEdges.map((e) => e.target));
  for (const edge of containsEdges) {
    if (nodes.size >= args.maxNodes) break;
    const childNode = children.get(edge.target);
    if (!childNode || visited.has(childNode.id)) continue;
    nodes.set(childNode.id, childNode);
    edges.push(edge);
    traverserGetImpactRecursive(queries, {
      nodeId: childNode.id,
      maxDepth,
      currentDepth,
      maxNodes: args.maxNodes,
      nodes,
      edges,
      visited,
      edgeKinds,
    });
  }
}

/** Walk all incoming edges (things that depend on this node) one level out. */
function traverserExpandImpactDependents(queries: QueryBuilder, args: ImpactRecOpts): void {
  const { nodeId, maxDepth, currentDepth, nodes, edges, visited, edgeKinds } = args;
  const incomingEdges = getIncomingEdges(queries, nodeId, edgeKinds);
  if (incomingEdges.length === 0) return;
  const sources = queries.getNodesByIds(incomingEdges.map((e) => e.source));
  for (const edge of incomingEdges) {
    if (nodes.size >= args.maxNodes) break;
    const sourceNode = sources.get(edge.source);
    if (!sourceNode || nodes.has(sourceNode.id)) continue;
    nodes.set(sourceNode.id, sourceNode);
    edges.push(edge);
    traverserGetImpactRecursive(queries, {
      nodeId: sourceNode.id,
      maxDepth,
      currentDepth: currentDepth + 1,
      maxNodes: args.maxNodes,
      reachedViaIncomingContains: edge.kind === 'contains',
      nodes,
      edges,
      visited,
      edgeKinds,
    });
  }
}

/**
 * Walk `extends`/`implements` edges recursively in a single direction.
 *
 * `direction: 'ancestors'` — follow outgoing edges (parent classes/interfaces).
 * `direction: 'descendants'` — follow incoming edges (subclasses/implementors).
 *
 * Replaces the former `traverserGetTypeAncestors` /
 * `traverserGetTypeDescendants` pair that differed only in edge direction.
 */
function traverserGetTypeRelativesRecursive(
  opts: TraversalGraphOpts,
  nodeId: string,
  direction: 'ancestors' | 'descendants',
): void {
  const { queries, nodes, edges, visited } = opts;
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const hierarchyEdges =
    direction === 'ancestors'
      ? getOutgoingEdges(queries, nodeId, ['extends', 'implements'])
      : getIncomingEdges(queries, nodeId, ['extends', 'implements']);
  if (hierarchyEdges.length === 0) return;

  const peer = direction === 'ancestors' ? 'target' : 'source';
  const relativeNodes = queries.getNodesByIds(hierarchyEdges.map((e) => e[peer]));
  for (const edge of hierarchyEdges) {
    const relativeNode = relativeNodes.get(edge[peer]);
    if (relativeNode && !nodes.has(relativeNode.id)) {
      nodes.set(relativeNode.id, relativeNode);
      edges.push(edge);
      traverserGetTypeRelativesRecursive(opts, relativeNode.id, direction);
    }
  }
}

/** Expand BFS frontier from `nodeId` in findPath: batch-resolve unvisited
 *  targets and queue successor parent links. */
interface TraverserExpandPathFrontierArgs {
  opts: TraversalGraphOpts;
  nodeId: string;
  frontier: PathFrontier;
  edgeKinds: EdgeKind[];
}

function traverserExpandPathFrontier(args: TraverserExpandPathFrontierArgs): void {
  const { opts, nodeId, frontier, edgeKinds } = args;
  const { queries, visited } = opts;
  const { parentIndex, queue } = frontier;
  const outgoingEdges = getOutgoingEdges(queries, nodeId, edgeKinds.length > 0 ? edgeKinds : undefined);
  if (outgoingEdges.length === 0) return;

  const wantIds = outgoingEdges.map((e) => e.target).filter((id) => !visited.has(id));
  const nextNodes = wantIds.length > 0 ? queries.getNodesByIds(wantIds) : new Map();

  for (const edge of outgoingEdges) {
    if (visited.has(edge.target)) continue;
    const nextNode = nextNodes.get(edge.target);
    if (!nextNode) continue;
    queue.push({ node: nextNode, edge, parentIndex });
  }
}

function reconstructPath(queue: PathQueueEntry[], index: number): Array<{ node: Node; edge: Edge | null }> {
  const reversed: Array<{ node: Node; edge: Edge | null }> = [];
  for (let i = index; i >= 0; i = queue[i]!.parentIndex) {
    const entry = queue[i]!;
    reversed.push({ node: entry.node, edge: entry.edge });
  }
  return reversed.reverse();
}

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

/**
 * Graph traverser for BFS and DFS traversal
 */
export class GraphTraverser {
  private readonly queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  /**
   * Traverse the graph using breadth-first search
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);
    if (!startNode) return { nodes: new Map(), edges: [], roots: [] };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];
    if (opts.includeStart) nodes.set(startNode.id, startNode);

    let queueIndex = 0;
    while (queueIndex < queue.length && nodes.size < opts.limit) {
      const { node, edge, depth } = queue[queueIndex++]!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (edge) edges.push(edge);
      if (depth >= opts.maxDepth) continue;
      traverserExpandBfsNeighbors(this.queries, { node, depth, opts, visited, nodes, queue });
    }
    return { nodes, edges, roots: [startId] };
  }

  /**
   * Traverse the graph using depth-first search
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);
    if (!startNode) return { nodes: new Map(), edges: [], roots: [] };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    if (opts.includeStart) nodes.set(startNode.id, startNode);
    traverserDfsRecursive(this.queries, { node: startNode, depth: 0, opts, nodes, edges, visited });
    return { nodes, edges, roots: [startId] };
  }

  /**
   * Shared call-walk driver for {@link getCallers} / {@link getCallees}
   * — they differ only in direction. `edgeKinds` defaults to the
   * calls/references/imports set; pass an explicit kind (e.g.
   * `['contains']`, `['extends']`) to walk a structural / type edge
   * instead — this is how the MCP `edgeKind` filter reaches edge kinds
   * outside the call set (issue #7).
   */
  private walkCallEdges(args: {
    nodeId: string;
    maxDepth: number;
    edgeKinds: readonly EdgeKind[];
    direction: 'callers' | 'callees';
  }): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    traverserGetCallWalkRecursive(
      this.queries,
      {
        nodeId: args.nodeId,
        maxDepth: args.maxDepth,
        currentDepth: 0,
        result,
        visited: new Set(),
        edgeKinds: args.edgeKinds,
      },
      args.direction,
    );
    return result;
  }

  /** Find all callers of a function/method. See {@link walkCallEdges}
   *  for the `edgeKinds` override. */
  getCallers(
    nodeId: string,
    maxDepth: number = 1,
    edgeKinds: readonly EdgeKind[] = CALL_REF_EDGE_KINDS,
  ): Array<{ node: Node; edge: Edge }> {
    return this.walkCallEdges({ nodeId, maxDepth, edgeKinds, direction: 'callers' });
  }

  /** Find all functions/methods called by a function. See
   *  {@link walkCallEdges} for the `edgeKinds` override. */
  getCallees(
    nodeId: string,
    maxDepth: number = 1,
    edgeKinds: readonly EdgeKind[] = CALL_REF_EDGE_KINDS,
  ): Array<{ node: Node; edge: Edge }> {
    return this.walkCallEdges({ nodeId, maxDepth, edgeKinds, direction: 'callees' });
  }

  /**
   * Get the call graph for a function (both callers and callees)
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) return { nodes: new Map(), edges: [], roots: [] };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    nodes.set(focalNode.id, focalNode);
    for (const { node, edge } of this.getCallers(nodeId, depth)) {
      nodes.set(node.id, node);
      edges.push(edge);
    }
    for (const { node, edge } of this.getCallees(nodeId, depth)) {
      nodes.set(node.id, node);
      edges.push(edge);
    }
    return { nodes, edges, roots: [nodeId] };
  }

  /**
   * Get the type hierarchy for a class/interface
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) return { nodes: new Map(), edges: [], roots: [] };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    nodes.set(focalNode.id, focalNode);
    const opts: TraversalGraphOpts = { queries: this.queries, nodes, edges, visited };
    traverserGetTypeRelativesRecursive(opts, nodeId, 'ancestors');
    traverserGetTypeRelativesRecursive(opts, nodeId, 'descendants');
    return { nodes, edges, roots: [nodeId] };
  }

  /**
   * Find all usages of a symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const incomingEdges = getIncomingEdges(this.queries, nodeId);
    if (incomingEdges.length === 0) return result;
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));
    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode) result.push({ node: sourceNode, edge });
    }
    return result;
  }

  /**
   * Calculate the impact radius of a node.
   * Returns all nodes that could be affected by changes to this node.
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3, edgeKinds?: EdgeKind[]): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) return { nodes: new Map(), edges: [], roots: [] };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    nodes.set(focalNode.id, focalNode);
    traverserGetImpactRecursive(this.queries, {
      nodeId,
      maxDepth,
      currentDepth: 0,
      maxNodes: DEFAULT_IMPACT_MAX_NODES,
      nodes,
      edges,
      visited,
      edgeKinds,
    });
    return { nodes, edges, roots: [nodeId] };
  }

  /**
   * Find the shortest path between two nodes
   */
  findPath(fromId: string, toId: string, edgeKinds: EdgeKind[] = []): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);
    if (!fromNode || !toNode) return null;

    const visited = new Set<string>();
    const queue: PathQueueEntry[] = [{ node: fromNode, edge: null, parentIndex: -1 }];
    const opts: TraversalGraphOpts = { queries: this.queries, nodes: new Map(), edges: [], visited };

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      if (queue.length > FIND_PATH_MAX_QUEUE) return null;
      const entry = queue[queueIndex]!;
      const nodeId = entry.node.id;
      if (nodeId === toId) return reconstructPath(queue, queueIndex);
      queueIndex++;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      traverserExpandPathFrontier({ opts, nodeId, frontier: { parentIndex: queueIndex - 1, queue }, edgeKinds });
    }
    return null;
  }

  /**
   * Get the containment hierarchy for a node (ancestors)
   */
  getAncestors(nodeId: string): Node[] {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const containingEdges = getIncomingEdges(this.queries, currentId, ['contains']);
      const firstEdge = containingEdges[0];
      if (!firstEdge) break;
      const parentNode = this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }
    return ancestors;
  }

  /**
   * Get immediate children of a node
   */
  getChildren(nodeId: string): Node[] {
    const containsEdges = getOutgoingEdges(this.queries, nodeId, ['contains']);
    if (containsEdges.length === 0) return [];
    const childNodes = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}
