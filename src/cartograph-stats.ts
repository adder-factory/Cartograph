/**
 * Stats / health facade — owns the freshness cache and the cheap
 * derived-signal queries (centrality, churn, complexity metrics,
 * tests↔subjects). Extracted from `Cartograph` so the public-API
 * class no longer carries 8 query wrappers and the freshness cache.
 *
 * Constructed once in the Cartograph constructor and exposed as
 * `cg.stats`. Methods are thin wrappers over `cg.queries` /
 * `cg.internals.graphManager` / `cg.db`, keeping the underlying free functions
 * the source of truth for query logic.
 */

import type { Cartograph } from './index.js';
import type { GraphStats } from './db/types.js';
import type { FileRecord } from './types.js';
import { getStats as qbGetStats } from './db/queries.js';
import { getOutgoingEdges, getIncomingEdges } from './db/queries-edges.js';
import { getFileByPath } from './db/queries-files.js';
import { getFreshnessInfo, type FreshnessInfo } from './freshness.js';

/**
 * TTL (ms) for the freshness check cache. Drift between two calls
 * happening within this window is unobservable in practice; caching
 * avoids the ~10–20 ms `git rev-parse HEAD` shell-out per call when
 * an agent pipelines many tool invocations.
 */
const FRESHNESS_TTL_MS = 5_000;

export class CartographStats {
  private freshnessCache: { at: number; value: FreshnessInfo | null } | null = null;

  constructor(private readonly cg: Cartograph) {}

  /** Get statistics about the knowledge graph. */
  getStats(): GraphStats {
    const stats = qbGetStats(this.cg.queries);
    stats.dbSizeBytes = this.cg.db.getSize();
    return stats;
  }

  /**
   * Get complexity metrics for a node. Thin wrapper around
   * `graphManager.getNodeMetrics` — kept here so callers don't
   * have to thread the graphManager handle through stats sites.
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.cg.internals.graphManager.getNodeMetrics(nodeId);
  }

  /** Centrality score in [0,1] for a node, or null if unknown. */
  getCentrality(nodeId: string): number | null {
    const node = this.cg.queries.getNodeById(nodeId);
    return node?.centrality ?? null;
  }

  /** Churn signal for a file — commit count, LOC, first-seen / last-touched timestamps. */
  getFileChurn(filePath: string): {
    commitCount: number;
    loc: number;
    firstSeenTs: number | null;
    lastTouchedTs: number | null;
  } | null {
    const f = getFileByPath(this.cg.queries, filePath);
    if (!f) return null;
    return {
      commitCount: f.commitCount ?? 0,
      loc: f.loc ?? 0,
      firstSeenTs: f.firstSeenTs ?? null,
      lastTouchedTs: f.lastTouchedTs ?? null,
    };
  }

  /** Get the test files that test `filePath` (incoming `tests` edges). */
  getTestsForFile(filePath: string): FileRecord[] {
    const incoming = getIncomingEdges(this.cg.queries, `file:${filePath}`, ['tests']);
    const paths = incoming
      .map((e) => e.source)
      .filter((id): id is string => id.startsWith('file:'))
      .map((id) => id.slice('file:'.length));
    return paths.map((p) => getFileByPath(this.cg.queries, p)).filter((f): f is FileRecord => f !== null);
  }

  /** Get the subject file(s) of a test file (outgoing `tests` edges). */
  getSubjectsOfTest(testFilePath: string): FileRecord[] {
    const outgoing = getOutgoingEdges(this.cg.queries, `file:${testFilePath}`, ['tests']);
    const paths = outgoing
      .map((e) => e.target)
      .filter((id): id is string => id.startsWith('file:'))
      .map((id) => id.slice('file:'.length));
    return paths.map((p) => getFileByPath(this.cg.queries, p)).filter((f): f is FileRecord => f !== null);
  }

  /**
   * Get the index's freshness state relative to the working tree.
   *
   * Returns `null` if the project has never been indexed (no metadata
   * stamped). Otherwise returns a `FreshnessInfo` with `isStale`,
   * `indexedSha`, `currentSha`, `indexedAt`, `filesChanged`,
   * `breakdown`, `commitsAhead`, and a ready-to-display `banner`
   * string (or null banner when fresh / non-git project).
   *
   * Memoized for FRESHNESS_TTL_MS so pipelined queries don't pay the
   * git shell-out cost repeatedly. Call `invalidateFreshness()`
   * after any operation that changes drift state in this process
   * (indexAll, sync, manual setMetadata).
   */
  getFreshness(): FreshnessInfo | null {
    const now = Date.now();
    if (this.freshnessCache && now - this.freshnessCache.at < FRESHNESS_TTL_MS) {
      return this.freshnessCache.value;
    }
    const value = getFreshnessInfo(this.cg.queries, this.cg.projectRoot);
    this.freshnessCache = { at: now, value };
    return value;
  }

  /** Drop the freshness cache. Call after operations that change drift state. */
  invalidateFreshness(): void {
    this.freshnessCache = null;
  }
}
