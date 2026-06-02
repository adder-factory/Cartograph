import type { EvalResult } from './types.js';

export const PASS_THRESHOLD = 0.5;

/**
 * Cheap byte-size estimate of an arbitrary value. Used by the
 * scorers to populate `EvalResult.payloadBytes` (#B5). Falls back
 * to `String(value).length` when stringify throws (cyclic refs,
 * BigInt) so the eval never blocks on a fixture quirk.
 */
function payloadSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export function scoreSearchNodes(
  caseId: string,
  expectedSymbols: string[],
  results: Array<{ node: { name: string }; score: number }>,
  latencyMs: number,
): EvalResult {
  const expectedLower = expectedSymbols.map((s) => s.toLowerCase());
  const resultNames = results.map((r) => r.node.name.toLowerCase());

  const found: string[] = [];
  const missed: string[] = [];
  // BEST rank across all found expected symbols (not "first one in
  // the expected-array iteration order"). Standard MRR is the
  // reciprocal of the rank of the highest-ranked relevant result —
  // for `expectedSymbols=['B','A']` with 'A' at rank 1 and 'B' at
  // rank 5 the MRR is 1.0, not 0.2.
  let bestRank = 0;
  for (let i = 0; i < expectedLower.length; i++) {
    const idx = resultNames.indexOf(expectedLower[i]);
    if (idx === -1) {
      missed.push(expectedSymbols[i]);
    } else {
      found.push(expectedSymbols[i]);
      const rank = idx + 1;
      if (bestRank === 0 || rank < bestRank) bestRank = rank;
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const mrr = bestRank > 0 ? 1 / bestRank : 0;

  return {
    caseId,
    pass: recall >= PASS_THRESHOLD,
    recall,
    mrr,
    foundSymbols: found,
    missedSymbols: missed,
    latencyMs,
    payloadBytes: payloadSize(results),
  };
}

/**
 * Score a semantic-search case (B9). Same shape as scoreSearchNodes
 * (both are ranked symbol-name matches), but accepts a `skipped`
 * marker for cases that can't run because the project lacks an
 * embedding model or the source symbol has no embedding row.
 *
 * Skipped cases set `pass=true` because the gap is environmental,
 * not a regression — running the eval against a project without
 * embeddings shouldn't fail the gate. The skipped marker is surfaced
 * in the runner output + persisted on the report so re-comparing
 * after `cartograph embed` shows the same case suddenly producing
 * real recall numbers.
 */
export function scoreSemanticSearch(
  caseId: string,
  expectedSymbols: string[],
  results: Array<{ node: { name: string }; score: number }>,
  latencyMs: number,
  skipped?: 'no-embeddings' | 'no-source-embedding',
): EvalResult {
  if (skipped) {
    return {
      caseId,
      pass: true,
      recall: 0,
      mrr: 0,
      foundSymbols: [],
      missedSymbols: expectedSymbols,
      latencyMs,
      payloadBytes: 0,
      skipped,
    };
  }
  // Same scorer shape as searchNodes — semantic results have the
  // same {node, score} structure even though the ranking pipeline
  // is completely different.
  return scoreSearchNodes(caseId, expectedSymbols, results, latencyMs);
}

export function scoreFindRelevantContext(
  caseId: string,
  expectedSymbols: string[],
  subgraph: { nodes: Map<string, { name: string }>; edges: unknown[]; roots: string[] },
  latencyMs: number,
): EvalResult {
  const nodeNames = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    nodeNames.add(node.name.toLowerCase());
  }

  const found: string[] = [];
  const missed: string[] = [];

  for (const sym of expectedSymbols) {
    if (nodeNames.has(sym.toLowerCase())) {
      found.push(sym);
    } else {
      missed.push(sym);
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;

  return {
    caseId,
    pass: recall >= PASS_THRESHOLD,
    recall,
    mrr: 0,
    foundSymbols: found,
    missedSymbols: missed,
    nodeCount,
    edgeCount,
    edgeDensity,
    latencyMs,
    // Subgraph payload approximated as nodes + edges + roots arrays
    // — Map gets unwrapped so JSON-stringify produces a meaningful
    // byte count instead of `{}`.
    payloadBytes: payloadSize({
      nodes: [...subgraph.nodes.values()],
      edges: subgraph.edges,
      roots: subgraph.roots,
    }),
  };
}
