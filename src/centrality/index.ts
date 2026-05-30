/**
 * Centrality computation
 *
 * Computes PageRank over the `calls` + `references` subgraph and
 * persists each node's score on the `nodes.centrality` column. Pure
 * compute — no I/O — so the caller owns reading edges, writing scores,
 * and deciding when to re-run.
 *
 * PageRank is the right shape for "what is structurally important?"
 * because it rewards being reached (weighted by the importance of who
 * reaches you), not just raw in-degree. A method called once from a
 * central interface ranks above a method called many times from a
 * leaf script.
 *
 * Edges of kind `contains` are deliberately excluded — they encode
 * lexical containment (file → class → method), which would dominate
 * the rank and hide actual reference flow.
 *
 * Side benefit observed in spike data: PageRank accidentally surfaces
 * resolver false-positives. Generic short names (`trim`, `run`) that
 * the resolver over-merges across files accumulate edges from many
 * sources and float to the top alongside genuine hubs. Useful as a
 * diagnostic; not a goal of this module.
 */

/** Damping factor — fraction of rank propagated through edges each step. */
export const PR_DAMPING = 0.85;

/**
 * Iteration count. PageRank converges geometrically; 40 iterations puts
 * us well below 1e-6 residual on graphs we've seen, with no per-graph
 * tuning needed.
 */
export const PR_ITERATIONS = 40;

/** Edge kinds that contribute to centrality. */
export const PR_EDGE_KINDS = ['calls', 'references'] as const;

interface CentralityResult {
  /** nodeId → PageRank score in (0, 1). Sums to ~1.0 across all nodes. */
  scores: Map<string, number>;
  /** Iterations actually run (currently always PR_ITERATIONS — kept for forward compat). */
  iterations: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

interface NodeRef {
  id: string;
}

interface EdgeRef {
  source: string;
  target: string;
}

/**
 * Compute PageRank scores for the supplied nodes/edges.
 *
 * @param nodes  All graph nodes (only `id` is read).
 * @param edges  Edges that contribute to centrality. Caller is
 *               responsible for filtering to `PR_EDGE_KINDS`.
 *
 * Edges referencing unknown node ids are silently dropped — the
 * underlying graph has FK cascades, so dangling references can only
 * occur mid-write and are not our problem to fix here.
 */
/**
 * Build the in-edge list and out-degree array used by the PageRank
 * inner loop. Edges that reference unknown node ids are silently
 * dropped — the underlying graph has FK cascades.
 */
function buildPageRankAdjacency(nodes: NodeRef[], edges: EdgeRef[]): { inEdges: number[][]; outDeg: Int32Array } {
  const N = nodes.length;
  const idx = new Map<string, number>();
  for (let i = 0; i < N; i++) idx.set(nodes[i]!.id, i);
  const inEdges: number[][] = Array.from({ length: N }, () => []);
  const outDeg = new Int32Array(N);
  for (const e of edges) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s === undefined || t === undefined) continue;
    inEdges[t]!.push(s);
    outDeg[s]! += 1;
  }
  return { inEdges, outDeg };
}

/** Bundle for `pageRankStep` — keeps the helper's arity below 4. */
interface PageRankStepCtx {
  pr: Float64Array;
  inEdges: number[][];
  outDeg: Int32Array;
  baseline: number;
}

/** One PageRank iteration step: compute next-rank vector from current. */
function pageRankStep(ctx: PageRankStepCtx): Float64Array {
  const { pr, inEdges, outDeg, baseline } = ctx;
  const N = pr.length;
  const next = new Float64Array(N).fill(baseline);

  // Distribute the rank of dangling nodes (no outgoing edges) uniformly.
  // Without this the total rank decays each iteration.
  let danglingSum = 0;
  for (let i = 0; i < N; i++) {
    if (outDeg[i] === 0) danglingSum += pr[i]!;
  }
  const danglingShare = (PR_DAMPING * danglingSum) / N;
  for (let i = 0; i < N; i++) next[i]! += danglingShare;

  for (let t = 0; t < N; t++) {
    const sources = inEdges[t]!;
    let s = 0;
    for (let k = 0; k < sources.length; k++) {
      const src = sources[k]!;
      s += pr[src]! / outDeg[src]!;
    }
    next[t]! += PR_DAMPING * s;
  }
  return next;
}

export function computePageRank(nodes: NodeRef[], edges: EdgeRef[]): CentralityResult {
  const start = Date.now();
  const N = nodes.length;
  const scores = new Map<string, number>();
  if (N === 0) return { scores, iterations: 0, durationMs: Date.now() - start };

  // Index nodes for tight numeric loops. Float64Array gives ~3× speedup
  // over Array(N).fill on million-edge graphs and costs nothing on
  // smaller ones.
  const { inEdges, outDeg } = buildPageRankAdjacency(nodes, edges);

  let pr: Float64Array = new Float64Array(N).fill(1 / N);
  const baseline = (1 - PR_DAMPING) / N;
  for (let it = 0; it < PR_ITERATIONS; it++) {
    pr = pageRankStep({ pr, inEdges, outDeg, baseline });
  }

  for (let i = 0; i < N; i++) scores.set(nodes[i]!.id, pr[i]!);
  return { scores, iterations: PR_ITERATIONS, durationMs: Date.now() - start };
}
