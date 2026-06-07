import type Cartograph from '../../../index.js';
import type { QueryBuilder } from '../../../db/queries.js';
import { getEnclosingTestName } from '../../../db/queries-test-names.js';
import type { Edge, Node } from '../../../types.js';
import { isTestPath } from '../../../utils.js';

/**
 * Collect the call-site lines an edge represents. The edge carries the
 * first site as `edge.line` and any de-duplicated extras in
 * `metadata.extraLines`. Returns a deduped, ascending list.
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
 * Expand one test-file file-node caller into per-call-site rows. Non-test
 * paths pass through unchanged.
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
  const perSiteMeta =
    edge.metadata && typeof edge.metadata === 'object'
      ? Object.fromEntries(Object.entries(edge.metadata).filter(([k]) => k !== 'siteCount' && k !== 'extraLines'))
      : undefined;
  for (const callLine of siteLines) {
    const test = getEnclosingTestName(queries, { filePath: node.filePath, line: callLine });
    const anchorLine = test?.line ?? callLine;
    const synthName = test ? `${node.name}::"${test.description}"` : node.name;
    const perSiteEdge: Edge = {
      ...edge,
      line: callLine,
      ...(perSiteMeta && Object.keys(perSiteMeta).length > 0 ? { metadata: perSiteMeta } : { metadata: undefined }),
    };
    expanded.push({
      node: { ...node, id: `${node.id}#site:${anchorLine}`, startLine: anchorLine, name: synthName },
      edge: perSiteEdge,
    });
  }
  return expanded;
}

function expandTestFileCaller(cg: Cartograph, row: { node: Node; edge: Edge }): Array<{ node: Node; edge: Edge }> {
  return expandTestFileCallerCore(cg.queries, row);
}

export function expandTestFileCallers(
  cg: Cartograph,
  rows: Array<{ node: Node; edge: Edge }>,
): Array<{ node: Node; edge: Edge }> {
  const out: Array<{ node: Node; edge: Edge }> = [];
  for (const r of rows) out.push(...expandTestFileCaller(cg, r));
  return out;
}

export function expandTestFileCallersWithQueries(
  queries: QueryBuilder,
  rows: Array<{ node: Node; edge: Edge }>,
): Array<{ node: Node; edge: Edge }> {
  const out: Array<{ node: Node; edge: Edge }> = [];
  for (const r of rows) out.push(...expandTestFileCallerCore(queries, r));
  return out;
}
