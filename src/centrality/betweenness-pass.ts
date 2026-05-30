/**
 * Betweenness-pass orchestration — reads the calls + references
 * subgraph from SQLite, runs sampled Brandes via the serial
 * {@link computeBetweenness} or the worker-pool
 * {@link computeBetweennessParallel} (routed by
 * {@link shouldUseParallel} based on edge count + K), persists each
 * score to `nodes.betweenness` via {@link applyBetweennessScores}.
 * The returned {@link BetweennessPassResult} reports which path ran
 * via `parallel: boolean`.
 *
 * Wired into Group C of the post-hook plan as `BETWEENNESS_HOOK`
 * (see `src/index-hooks/betweenness.ts`) — opt-in via
 * `config.enableBetweenness` (default false) since the compute
 * is meaningfully more expensive than PageRank even with the
 * worker pool. Auto-self-heals via `BETWEENNESS_ALGO_VERSION`
 * folded into `last_betweenness_fingerprint`; a substantive edit
 * to the algo set re-fires the pass on the next sync.
 */

import type { QueryBuilder } from '../db/queries.js';
import { getAllNodes } from '../db/queries.js';
import { applyBetweennessScores } from '../db/queries-centrality.js';
import { PR_EDGE_KINDS } from './index.js';
import {
  computeBetweenness,
  DEFAULT_K,
  type BetweennessOpts,
  type BetweennessResult,
  type BetweennessEdgeRef,
} from './betweenness.js';
import { computeBetweennessParallel, shouldUseParallel } from './betweenness-parallel.js';

export interface BetweennessPassResult extends BetweennessResult {
  /** Number of nodes scored (= row count touched by the UPDATE). */
  readonly nodesScored: number;
  /** Number of edges considered (sum over PR_EDGE_KINDS). */
  readonly edgeCount: number;
  /** Whether the worker pool was used (true) or the serial path (false). */
  readonly parallel: boolean;
}

/**
 * Read graph → compute → persist. Reuses {@link PR_EDGE_KINDS} so the
 * input subgraph matches PageRank's exactly — same definition of
 * "structural relevance" feeds both centralities. The two scores then
 * disagree most strongly on bridge nodes (high betweenness, low
 * PageRank) and accumulator nodes (high PageRank, low betweenness),
 * which is the agent-useful disagreement we want to surface.
 *
 * Returns the raw {@link BetweennessResult} plus the input scale
 * (node + edge counts) so callers can log a meaningful summary line
 * without rerunning the same COUNT queries.
 */
export async function runBetweennessPass(qb: QueryBuilder, opts?: BetweennessOpts): Promise<BetweennessPassResult> {
  const nodes = getAllNodes(qb);
  if (nodes.length === 0) {
    return {
      scores: new Map(),
      sampleCount: 0,
      durationMs: 0,
      nodesScored: 0,
      edgeCount: 0,
      parallel: false,
    };
  }
  // PR_EDGE_KINDS is a non-empty const tuple — the IN-list is
  // guaranteed well-formed. Same shape as the centrality hook's
  // edge-fetch query, so a future refactor that swaps in a typed
  // query would cover both call sites uniformly.
  const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
  const edgeRows = qb.db
    .prepare(`SELECT source, target FROM edges WHERE kind IN (${edgePlaceholders})`)
    .all(...PR_EDGE_KINDS) as BetweennessEdgeRef[];
  const effectiveK = opts?.k ?? DEFAULT_K;
  const parallel = shouldUseParallel(edgeRows.length, effectiveK);
  const result = parallel
    ? await computeBetweennessParallel(nodes, edgeRows, opts)
    : computeBetweenness(nodes, edgeRows, opts);
  applyBetweennessScores(qb, result.scores);
  return { ...result, nodesScored: result.scores.size, edgeCount: edgeRows.length, parallel };
}
