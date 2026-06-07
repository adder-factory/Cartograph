import type { SearchResult } from '../search/types.js';
import type { Edge, EdgeKind, FindRelevantContextOptions, Node, Subgraph } from '../types.js';
import { findEdgesBetweenNodes, getOutgoingEdges } from '../db/queries-edges.js';
import { logDebug } from '../errors.js';
import { isDiagnosticPath } from '../path-class.js';
import { compact } from '../utils.js';
import type { ContextBuilderState } from './builder-state.js';

/** (nodes, edges, roots) slice of a working subgraph — shared by trim/cap helpers. */
interface SubgraphWorkspace {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
}

/** Args bundle for final subgraph trimming, diversity caps, and edge recovery. */
export interface FinaliseSubgraphArgs {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
  maxNodes: number;
  isTestQuery: boolean;
}

/** Args bundle for type-hierarchy expansion around class/interface roots. */
export interface ExpandTypeHierarchyArgs {
  filteredResults: SearchResult[];
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
  maxNodes: number;
}

/** Mutable accumulator passed across traversal calls. */
export interface TraversalAccumulator {
  nodes: Map<string, Node>;
  edges: Edge[];
  opts: Required<FindRelevantContextOptions>;
}

/** Mutable accumulator passed across hierarchy merges. */
interface HierarchyAccum {
  nodes: Map<string, Node>;
  edges: Edge[];
  counter: { added: number };
  maxHierarchyNodes: number;
}

// ── Per-file diversification + non-production caps ─────────────────────────
/** Cap any one file at this fraction of the total budget. */
const PER_FILE_CAP_FRACTION = 0.2;
/** Floor on the per-file cap so small budgets still surface multiple symbols per file. */
const MIN_PER_FILE_CAP = 5;
/** Test/sample/integration files capped at this fraction so they don't flood. */
const NON_PROD_CAP_FRACTION = 0.15;
/** Floor on the non-prod cap. */
const MIN_NON_PROD_CAP = 3;
/** Sort weight added to entry-point (root) nodes when picking eviction order. */
const ROOT_PRIORITY_BONUS = 10;

/**
 * Per-kind sort weight inside the per-file cap (3 for entry types,
 * 1 for methods/functions, 0 for fields/properties). Defaults to 0
 * for any kind not listed, dropping it to the bottom.
 */
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  class: 3,
  interface: 3,
  struct: 3,
  trait: 3,
  protocol: 3,
  enum: 3,
  method: 1,
  function: 1,
  property: 0,
  field: 0,
  variable: 0,
};

/**
 * Resolve import/export nodes to their actual definitions where possible.
 * Import/export wrappers are useful index artifacts but weak context roots.
 */
export function resolveImportsToDefinitions(st: ContextBuilderState, results: SearchResult[]): SearchResult[] {
  const resolved: SearchResult[] = [];
  const seenIds = new Set<string>();
  for (const result of results) {
    const { node, score } = result;
    if (node.kind !== 'import' && node.kind !== 'export') {
      pushUniqueSearchResult(resolved, seenIds, result);
      continue;
    }
    const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
    const outgoingEdges = getOutgoingEdges(st.queries, node.id, [edgeKind as EdgeKind]);
    let foundDefinition = false;
    for (const edge of outgoingEdges) {
      const targetNode = st.queries.getNodeById(edge.target);
      if (targetNode && pushUniqueSearchResult(resolved, seenIds, { node: targetNode, score })) {
        foundDefinition = true;
        logDebug('Resolved import to definition', {
          import: node.name,
          definition: targetNode.name,
          kind: targetNode.kind,
        });
      }
    }
    if (!foundDefinition) logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
  }
  return resolved;
}

function pushUniqueSearchResult(results: SearchResult[], seenIds: Set<string>, result: SearchResult): boolean {
  if (seenIds.has(result.node.id)) return false;
  seenIds.add(result.node.id);
  results.push(result);
  return true;
}

/** Phase 2 of `findRelevantContext`: BFS traversal from each entry point. */
export function expandViaTraversal(
  st: ContextBuilderState,
  entryPoints: SearchResult[],
  acc: TraversalAccumulator,
): void {
  for (const result of entryPoints) {
    const traversalResult = st.traverser.traverseBFS(result.node.id, traversalOptions(acc.opts, entryPoints.length));
    for (const [id, node] of traversalResult.nodes) {
      if (!acc.nodes.has(id)) acc.nodes.set(id, node);
    }
    for (const edge of traversalResult.edges) {
      pushUniqueEdge(acc.edges, edge);
    }
  }
}

function traversalOptions(opts: Required<FindRelevantContextOptions>, entryPointCount: number) {
  return compact({
    maxDepth: opts.traversalDepth,
    edgeKinds: nonEmptyArrayOrUndefined(opts.edgeKinds),
    nodeKinds: nonEmptyArrayOrUndefined(opts.nodeKinds),
    direction: 'both' as const,
    limit: Math.ceil(opts.maxNodes / Math.max(1, entryPointCount)),
  });
}

function nonEmptyArrayOrUndefined<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function pushUniqueEdge(edges: Edge[], edge: Edge): void {
  const exists = edges.some((e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind);
  if (!exists) edges.push(edge);
}

/**
 * Pass 1+2 type-hierarchy expansion for class/interface entry points.
 * Bounded by `maxNodes/4` to avoid drowning the rest of the budget.
 */
export function expandTypeHierarchy(st: ContextBuilderState, args: ExpandTypeHierarchyArgs): void {
  const { filteredResults, nodes, edges, roots, maxNodes } = args;
  const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
  const acc: HierarchyAccum = { nodes, edges, counter: { added: 0 }, maxHierarchyNodes: Math.ceil(maxNodes / 4) };
  for (const result of filteredResults) {
    if (acc.counter.added >= acc.maxHierarchyNodes) break;
    if (!typeHierarchyKinds.has(result.node.kind)) continue;
    mergeHierarchyInto(st.traverser.getTypeHierarchy(result.node.id), acc);
  }
  if (acc.counter.added === 0) return;
  const pass2Candidates = [...nodes.values()].filter((n) => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id));
  for (const candidate of pass2Candidates) {
    if (acc.counter.added >= acc.maxHierarchyNodes) break;
    mergeHierarchyInto(st.traverser.getTypeHierarchy(candidate.id), acc);
  }
}

/**
 * Merge one type-hierarchy result into the running accumulator, capped by
 * `acc.maxHierarchyNodes`. `acc.counter.added` is shared mutable state so
 * the cap survives across hierarchies.
 */
function mergeHierarchyInto(hierarchy: { nodes: Map<string, Node>; edges: Edge[] }, acc: HierarchyAccum): void {
  for (const [id, node] of hierarchy.nodes) {
    if (!acc.nodes.has(id) && acc.counter.added < acc.maxHierarchyNodes) {
      acc.nodes.set(id, node);
      acc.counter.added++;
    }
  }
  for (const edge of hierarchy.edges) {
    if (!acc.nodes.has(edge.source) || !acc.nodes.has(edge.target)) continue;
    const exists = acc.edges.some((e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind);
    if (!exists) acc.edges.push(edge);
  }
}

/** Phase 3 of `findRelevantContext`: trim + diversity caps + edge recovery. */
export function finaliseSubgraph(st: ContextBuilderState, args: FinaliseSubgraphArgs): Subgraph {
  const { nodes, edges, roots, maxNodes } = args;
  const trimmed = trimToMaxNodes({ nodes, edges, roots }, maxNodes);
  const finalNodes = trimmed.nodes;
  let finalEdges = trimmed.edges;
  applyPerFileDiversityCap(finalNodes, roots, maxNodes);
  applyNonProductionCap(finalNodes, roots, args);
  finalEdges = finalEdges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
  finalEdges = recoverEdgesBetween(st, finalNodes, finalEdges);
  return { nodes: finalNodes, edges: finalEdges, roots };
}

/**
 * When the working subgraph exceeds `maxNodes`, build a priority set of
 * entry points + their direct neighbours and keep those first; backfill
 * the remaining budget with arbitrary other nodes.
 */
function trimToMaxNodes(ws: SubgraphWorkspace, maxNodes: number): { nodes: Map<string, Node>; edges: Edge[] } {
  const { nodes, edges, roots } = ws;
  if (nodes.size <= maxNodes) return { nodes, edges };
  const priorityIds = expandPriorityFromRoots(roots, edges);
  const finalNodes = pickTopNodes(nodes, priorityIds, maxNodes);
  const finalEdges = edges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
  return { nodes: finalNodes, edges: finalEdges };
}

/**
 * One-hop expansion of root ids along all edges (both directions). Used by
 * `trimToMaxNodes` to keep edge endpoints together when culling.
 */
function expandPriorityFromRoots(roots: readonly string[], edges: readonly Edge[]): Set<string> {
  const priorityIds = new Set(roots);
  for (const edge of edges) {
    if (priorityIds.has(edge.source)) priorityIds.add(edge.target);
    if (priorityIds.has(edge.target)) priorityIds.add(edge.source);
  }
  return priorityIds;
}

/** Keep priority ids first, then fill up to `maxNodes` from the rest. */
function pickTopNodes(nodes: Map<string, Node>, priorityIds: Set<string>, maxNodes: number): Map<string, Node> {
  const finalNodes = new Map<string, Node>();
  for (const id of priorityIds) {
    const node = nodes.get(id);
    if (node && finalNodes.size < maxNodes) finalNodes.set(id, node);
  }
  for (const [id, node] of nodes) {
    if (finalNodes.size >= maxNodes) break;
    if (!finalNodes.has(id)) finalNodes.set(id, node);
  }
  return finalNodes;
}

/**
 * Cap any one file at ~20% of the budget to prevent a single file
 * from dominating via BFS that follows `contains` up to a parent class.
 */
function applyPerFileDiversityCap(finalNodes: Map<string, Node>, roots: string[], maxNodes: number): void {
  const maxPerFile = Math.max(MIN_PER_FILE_CAP, Math.ceil(maxNodes * PER_FILE_CAP_FRACTION));
  const fileCounts = new Map<string, string[]>();
  for (const [id, node] of finalNodes) {
    const ids = fileCounts.get(node.filePath) || [];
    ids.push(id);
    fileCounts.set(node.filePath, ids);
  }
  const rootSet = new Set(roots);
  for (const [, nodeIds] of fileCounts) {
    if (nodeIds.length <= maxPerFile) continue;
    nodeIds.sort((a, b) => {
      const aRoot = rootSet.has(a) ? ROOT_PRIORITY_BONUS : 0;
      const bRoot = rootSet.has(b) ? ROOT_PRIORITY_BONUS : 0;
      const aKind = KIND_PRIORITY[finalNodes.get(a)!.kind] ?? 0;
      const bKind = KIND_PRIORITY[finalNodes.get(b)!.kind] ?? 0;
      return bRoot + bKind - (aRoot + aKind);
    });
    for (const id of nodeIds.slice(maxPerFile)) finalNodes.delete(id);
  }
}

/** Limit test/sample/integration/example files to ~15% of the budget. */
function applyNonProductionCap(finalNodes: Map<string, Node>, roots: string[], args: FinaliseSubgraphArgs): void {
  if (args.isTestQuery) return;
  const maxNonProd = Math.max(MIN_NON_PROD_CAP, Math.ceil(args.maxNodes * NON_PROD_CAP_FRACTION));
  const nonProdIds: string[] = [];
  for (const [id, node] of finalNodes) {
    if (isDiagnosticPath(node.filePath)) nonProdIds.push(id);
  }
  if (nonProdIds.length <= maxNonProd) return;
  for (const id of nonProdIds.slice(maxNonProd)) {
    finalNodes.delete(id);
    const rootIdx = roots.indexOf(id);
    if (rootIdx !== -1) roots.splice(rootIdx, 1);
  }
}

/** After all eviction passes, recover structurally-relevant edges between surviving nodes. */
function recoverEdgesBetween(st: ContextBuilderState, finalNodes: Map<string, Node>, finalEdges: Edge[]): Edge[] {
  const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
  const recoveredEdges = findEdgesBetweenNodes(st.queries, [...finalNodes.keys()], recoveryKinds);
  const existingEdgeKeys = new Set(finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`));
  for (const edge of recoveredEdges) {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!existingEdgeKeys.has(key)) {
      finalEdges.push(edge);
      existingEdgeKeys.add(key);
    }
  }
  return finalEdges;
}
