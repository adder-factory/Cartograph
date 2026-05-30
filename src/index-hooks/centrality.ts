/**
 * Centrality index hook — runs PageRank over the calls+references
 * subgraph after every indexAll/sync and persists scores to
 * `nodes.centrality`. Cheap; no I/O. See `src/centrality/` for the
 * pure-compute module.
 *
 * Fingerprint-skip: profile against ohmyzsh + github graphql showed
 * centrality dominates postHooks (65-79%) on edge-heavy graphs —
 * but it produces identical scores when the input graph AND the
 * algorithm constants haven't changed since the last run. We hash
 * the algorithm tag (PR_DAMPING / PR_ITERATIONS / PR_EDGE_KINDS)
 * plus node+edge counts plus the latest `nodes.updated_at` into a
 * fingerprint; if it matches the stored value, skip recompute
 * entirely. The fingerprint is stored in
 * `project_metadata.last_centrality_fingerprint`.
 *
 * Quality guarantee: identical fingerprint → identical algorithm,
 * identical PR_EDGE_KINDS subgraph → identical PageRank output (the
 * algorithm is deterministic). Recompute is forced when ANY of:
 * count changes, any node's updated_at changes, any PR_DAMPING /
 * PR_ITERATIONS / PR_EDGE_KINDS constant changes, or the
 * fingerprint key is absent (first run / clearStructural cleanup).
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import { computePageRank, PR_DAMPING, PR_EDGE_KINDS, PR_ITERATIONS } from '../centrality/index.js';
import { computePageRankParallel, shouldUseParallel } from '../centrality/pagerank-parallel.js';
import { getAllNodes } from '../db/queries.js';
import { applyCentralityScores, clearCentrality } from '../db/queries-centrality.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';

const FINGERPRINT_KEY = 'last_centrality_fingerprint';

/**
 * Tag the fingerprint with the algorithm-defining constants so any
 * change to damping / iteration count / edge-kind set invalidates
 * the stored fingerprint automatically — same pattern as
 * `BIOMARKER_CACHE_KEY` riding on `EXTRACTION_LOGIC_VERSION`. Without
 * this, swapping (say) `PR_EDGE_KINDS = ['calls']` would leave the
 * old "calls + references" scores in place on every project whose
 * graph shape happened to match the stored count tuple.
 *
 * Deterministic stringification (sorted PR_EDGE_KINDS) so the tag is
 * stable across runs even if the tuple's literal order is later
 * reordered.
 */
function centralityAlgoTag(): string {
  const kinds = [...PR_EDGE_KINDS].sort((a, b) => Number(a > b) - Number(a < b)).join(',');
  return `algo:d=${PR_DAMPING}|i=${PR_ITERATIONS}|k=${kinds}`;
}

/**
 * Build a cheap, collision-resistant fingerprint of the input
 * graph plus the algorithm constants. Four components:
 *   - algo tag (PR_DAMPING / PR_ITERATIONS / PR_EDGE_KINDS)
 *   - node count
 *   - edge count over PR_EDGE_KINDS
 *   - max(updated_at) over all nodes
 *
 * Re-running indexAll on an unchanged repo: same algo, same counts,
 * same max(updated_at) (every UPDATE bumps it), same fingerprint,
 * skip. Adding/removing/modifying any node bumps max(updated_at) and
 * therefore the fingerprint. Tweaking a PageRank constant flips the
 * algo tag and forces a recompute. False-equality is essentially
 * impossible unless the user externally rolls back updated_at.
 */
function computeFingerprint(ctx: IndexHookContext): string {
  // PR_EDGE_KINDS is a non-empty const tuple by definition (the
  // PageRank input subgraph would be empty otherwise) so the
  // generated SQL `WHERE kind IN (?, ?, ...)` is always well-formed.
  const db = ctx.db.getDb();
  const nodeRow = db
    .prepare('SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as max_updated FROM nodes')
    .get() as { count: number; max_updated: number };
  const edgePlaceholders = PR_EDGE_KINDS.map(() => '?').join(',');
  const edgeRow = db
    .prepare(`SELECT COUNT(*) as count FROM edges WHERE kind IN (${edgePlaceholders})`)
    .get(...PR_EDGE_KINDS) as { count: number };
  return `${centralityAlgoTag()}:${nodeRow.count}:${edgeRow.count}:${nodeRow.max_updated}`;
}

async function recompute(ctx: IndexHookContext): Promise<void> {
  if (ctx.config.enableCentrality === false) return;
  try {
    const fingerprint = computeFingerprint(ctx);
    const stored = getMetadata(ctx.queries, FINGERPRINT_KEY);
    if (stored === fingerprint) {
      // Graph unchanged since last centrality run; scores already
      // match. The two cheap COUNT/MAX queries above are ~2-5ms even
      // on 10K-edge graphs vs. 250-450ms for full PageRank, so this
      // skip is a 50-200× speedup on the rerun case (CI rebuilds,
      // repeated `cartograph index` invocations on a clean tree,
      // tests that index then immediately sync).
      logDebug('centrality hook: graph unchanged (fingerprint match), skipping recompute');
      return;
    }
    const nodes = getAllNodes(ctx.queries);
    if (nodes.length === 0) return;
    const edgeRows = ctx.db
      .getDb()
      .prepare(`SELECT source, target FROM edges WHERE kind IN (${PR_EDGE_KINDS.map(() => '?').join(',')})`)
      .all(...PR_EDGE_KINDS) as Array<{ source: string; target: string }>;
    // B10 (2026-05-24) — route to worker_threads PageRank when the
    // graph is large enough that the worker-spawn overhead is
    // dominated by the saved compute (default threshold 50K edges).
    // Bit-for-bit parity isn't guaranteed (float drift in danglingSum
    // accumulation order), but scores match to ~12 decimal places and
    // the centrality_test parity test pins the tolerance.
    const result = shouldUseParallel(edgeRows.length)
      ? await computePageRankParallel(nodes, edgeRows)
      : computePageRank(nodes, edgeRows);
    clearCentrality(ctx.queries);
    applyCentralityScores(ctx.queries, result.scores);
    // Store the fingerprint we computed BEFORE the apply step.
    // `applyCentralityScores` UPDATEs nodes.centrality but neither
    // the SQL (`UPDATE nodes SET centrality = ? WHERE id = ?`) nor
    // the schema's `nodes_au` trigger touches `updated_at`, so the
    // input-side fingerprint we just used is still valid for the
    // post-apply state. Storing it directly avoids a redundant
    // COUNT/MAX query.
    setMetadata(ctx.queries, FINGERPRINT_KEY, fingerprint);
  } catch (err) {
    logDebug(`centrality hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'centrality',
  async afterIndexAll(ctx) {
    await recompute(ctx);
  },
  async afterSync(ctx) {
    await recompute(ctx);
  },
};
