/**
 * Betweenness index hook — runs sampled Brandes betweenness over the
 * calls+references subgraph (same input as PageRank, different
 * structural signal) after every indexAll/sync, persists scores to
 * `nodes.betweenness`. Opt-in via `config.enableBetweenness` (default
 * false) because the compute is meaningfully more expensive than
 * PageRank — single-threaded would chew tens of seconds on TS-scale.
 *
 * Mirrors {@link ./centrality.ts}'s shape: fingerprint-skip via
 * `project_metadata.last_betweenness_fingerprint`, hashing (a) the
 * algo-version (sha256 of the betweenness spec set — invalidated
 * automatically on a Brandes / sampling / scale-up edit) plus (b) the
 * sampler parameters (K, seed, normalize), plus (c) the input graph
 * scale (node count, edge count over PR_EDGE_KINDS, max(nodes.updated_at)).
 *
 * Why the fingerprint includes K + seed + normalize even though they
 * default to constants: a future config knob (e.g., `betweennessK`)
 * lets users tune sample size; without folding it into the fingerprint
 * the stored scores would silently stay at K=200 after the user
 * bumped to K=500.
 *
 * Routing: `runBetweennessPass` decides serial vs parallel based on
 * edge count + K via {@link ./../centrality/betweenness-parallel.ts:shouldUseParallel}.
 * Both paths produce scores agreeing to ~1e-9 (`betweenness-parallel.test.ts`
 * parity pin).
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import { BETWEENNESS_ALGO_VERSION, DEFAULT_K, DEFAULT_SEED } from '../centrality/betweenness.js';
import { PR_EDGE_KINDS } from '../centrality/index.js';
import { runBetweennessPass } from '../centrality/betweenness-pass.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';

const FINGERPRINT_KEY = 'last_betweenness_fingerprint';

/**
 * Tag the fingerprint with the algo SHA + sampler parameters so any
 * spec change OR knob change invalidates the stored fingerprint
 * automatically.
 */
function betweennessAlgoTag(k: number, seed: number, normalize: boolean): string {
  return `algo:${BETWEENNESS_ALGO_VERSION}|k=${k}|seed=${seed}|norm=${normalize ? 1 : 0}`;
}

/**
 * Build a cheap, collision-resistant fingerprint:
 *   - algo+sampler tag
 *   - node count
 *   - edge count over PR_EDGE_KINDS (same subgraph)
 *   - max(nodes.updated_at)
 *
 * Mirrors centrality.ts's shape. False-equality is essentially
 * impossible unless the user externally rolls back updated_at.
 */
interface FingerprintArgs {
  ctx: IndexHookContext;
  k: number;
  seed: number;
  normalize: boolean;
}

function computeFingerprint(args: FingerprintArgs): string {
  const { ctx, k, seed, normalize } = args;
  const db = ctx.db.getDb();
  const nodeRow = db
    .prepare('SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as max_updated FROM nodes')
    .get() as { count: number; max_updated: number };
  const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
  const edgeRow = db
    .prepare(`SELECT COUNT(*) as count FROM edges WHERE kind IN (${edgePlaceholders})`)
    .get(...PR_EDGE_KINDS) as { count: number };
  return `${betweennessAlgoTag(k, seed, normalize)}:${nodeRow.count}:${edgeRow.count}:${nodeRow.max_updated}`;
}

async function recompute(ctx: IndexHookContext): Promise<void> {
  if (ctx.config.enableBetweenness !== true) return; // opt-in
  try {
    const k = DEFAULT_K;
    const seed = DEFAULT_SEED;
    const normalize = true;
    const fingerprint = computeFingerprint({ ctx, k, seed, normalize });
    const stored = getMetadata(ctx.queries, FINGERPRINT_KEY);
    if (stored === fingerprint) {
      logDebug('betweenness hook: graph + sampler unchanged (fingerprint match), skipping recompute');
      return;
    }
    const result = await runBetweennessPass(ctx.queries, { k, seed, normalize });
    if (result.nodesScored === 0) return;
    setMetadata(ctx.queries, FINGERPRINT_KEY, fingerprint);
    logDebug(
      `betweenness hook: ${result.nodesScored} nodes scored, ${result.edgeCount} edges, ` +
        `K=${result.sampleCount}, ${result.parallel ? 'parallel' : 'serial'} path, ${result.durationMs}ms`,
    );
  } catch (err) {
    logDebug(`betweenness hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'betweenness',
  async afterIndexAll(ctx) {
    await recompute(ctx);
  },
  async afterSync(ctx) {
    await recompute(ctx);
  },
};
