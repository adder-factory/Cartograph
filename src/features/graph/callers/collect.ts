import type Cartograph from '../../../index.js';
import { getIncomingEdges } from '../../../db/queries-edges.js';
import { CONFIDENCE_RANK, filterByConfidence } from '../../../graph/edge-confidence.js';
import { TYPE_LIKE_KINDS, TYPE_USAGE_EDGE_KINDS } from '../../../graph/type-usage.js';
import type { Edge, EdgeKind, Node } from '../../../types.js';
import { expandTestFileCallers } from './test-file-callers.js';

const TYPE_USAGE_EDGE_KIND_SET: ReadonlySet<string> = new Set<string>(TYPE_USAGE_EDGE_KINDS);

/**
 * Fetch a node's callers, honoring an explicit `edgeKind` at the FETCH
 * layer so structural / type edges (`contains`, `returns`, `type_of`,
 * `extends`, …) are reachable on ANY source kind — not just the
 * type-like sources the TYPE_USAGE path below already covered (issue
 * #7). An unknown kind yields no edges (the schema constrains it).
 */
function callersFor(
  cg: Cartograph,
  nodeId: string,
  edgeKindFilter: string | undefined,
): Array<{ node: Node; edge: Edge }> {
  return edgeKindFilter
    ? cg.internals.traverser.getCallers(nodeId, 1, [edgeKindFilter as EdgeKind])
    : cg.internals.traverser.getCallers(nodeId);
}

export interface CallersAccum {
  nodes: Node[];
  edges: Map<string, Edge>;
  seen: Set<string>;
}

interface CollectCallersForSourceArgs {
  cg: Cartograph;
  source: Node;
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

function makeResolvedFileImportEdge(source: Node, target: Node, line: number | undefined): Edge {
  const edge: Edge = {
    source: source.id,
    target: target.id,
    kind: 'imports',
    confidence: 'EXTRACTED',
    metadata: { resolvedFileImport: true },
  };
  if (line !== undefined) edge.line = line;
  return edge;
}

function appendResolvedFileImportCallers(args: {
  cg: Cartograph;
  source: Node;
  edgeKindFilter: string | undefined;
  seen: Set<string>;
  rows: Array<{ node: Node; edge: Edge }>;
}): void {
  const { cg, source, edgeKindFilter, seen, rows } = args;
  if (source.kind !== 'file') return;
  if (edgeKindFilter !== undefined && edgeKindFilter !== 'imports') return;

  for (const dep of cg.internals.graphManager.getResolvedFileImportDependents(source.filePath)) {
    const depFileNode = cg.queries.getNodesByFile(dep.filePath).find((n) => n.kind === 'file');
    if (!depFileNode || seen.has(depFileNode.id)) continue;
    seen.add(depFileNode.id);
    rows.push({ node: depFileNode, edge: makeResolvedFileImportEdge(depFileNode, source, dep.line) });
  }
}

/**
 * Per-source: combine regular call-edge callers with type-usage incoming
 * edges when the source is a type-like kind.
 */
export function collectCallersForSource(args: CollectCallersForSourceArgs): Array<{ node: Node; edge: Edge }> {
  const { cg, source, edgeKindFilter, minConfidence } = args;
  const callRows = callersFor(cg, source.id, edgeKindFilter);

  const seen = new Set<string>(callRows.map((r) => r.node.id));
  const merged = [...callRows];
  appendResolvedFileImportCallers({ cg, source, edgeKindFilter, seen, rows: merged });

  if (!TYPE_LIKE_KINDS.has(source.kind)) return filterByConfidence(merged, minConfidence);

  for (const e of getIncomingEdges(cg.queries, source.id, TYPE_USAGE_EDGE_KINDS)) {
    if (edgeKindFilter && e.kind !== edgeKindFilter) continue;
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    const node = cg.queries.getNodeById(e.source);
    if (node) merged.push({ node, edge: e });
  }
  return filterByConfidence(merged, minConfidence);
}

interface CollectCallersArgs {
  cg: Cartograph;
  matchNodes: Node[];
  edgeKindFilter: string | undefined;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

/**
 * Walk every match's call-edge predecessors and accumulate them into a
 * deduped list. Test-file file rows are expanded to per-call-site rows.
 */
export function collectCallers(args: CollectCallersArgs): CallersAccum {
  const { cg, matchNodes, edgeKindFilter, minConfidence } = args;
  const seen = new Set<string>();
  const rawRows: Array<{ node: Node; edge: Edge }> = [];
  const threshold = minConfidence ? CONFIDENCE_RANK[minConfidence] : 0;
  for (const node of matchNodes) {
    for (const c of callersFor(cg, node.id, edgeKindFilter)) {
      if (CONFIDENCE_RANK[c.edge.confidence ?? 'EXTRACTED'] < threshold) continue;
      if (seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      rawRows.push({ node: c.node, edge: c.edge });
    }
    appendResolvedFileImportCallers({ cg, source: node, edgeKindFilter, seen, rows: rawRows });
  }
  const expandedRows = expandTestFileCallers(cg, rawRows);
  const nodes: Node[] = [];
  const edges = new Map<string, Edge>();
  for (const r of expandedRows) {
    nodes.push(r.node);
    edges.set(r.node.id, r.edge);
  }
  return { nodes, edges, seen };
}

interface CollectTypeUsersArgs {
  cg: Cartograph;
  matchNodes: Node[];
  edgeKindFilter: string | undefined;
  alreadySeen: Set<string>;
  minConfidence: NonNullable<Edge['confidence']> | null;
}

export function collectTypeUsers(args: CollectTypeUsersArgs): Node[] {
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

interface TypeUserCollectCtx {
  cg: CollectTypeUsersArgs['cg'];
  edgeKindFilter: CollectTypeUsersArgs['edgeKindFilter'];
  threshold: number;
  alreadySeen: CollectTypeUsersArgs['alreadySeen'];
  seenTypeUsers: Set<string>;
  typeUsers: Node[];
}

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
