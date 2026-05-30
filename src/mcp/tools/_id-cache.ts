/**
 * @internal — short-id cache for tabular tool results (#15).
 *
 * Tools that emit row lists (callers / callees / search / etc.)
 * stamp each row with a short `n_xxxxxxxx` UID. Subsequent calls
 * to symbol-resolving tools accept `id=<uid>` as an alias for
 * `symbol=<full name>` — saves the agent from re-passing 30+
 * character qualified names across multi-step investigations.
 *
 * Lifetime: the cache lives as long as the ToolHandler instance
 * (MCP server lifetime). When the MCP server restarts, any IDs
 * the agent recorded become unresolvable — that's acceptable
 * because cross-restart use isn't a goal of this token-saving
 * shortcut.
 *
 * Bounded LRU: caps at 4096 entries. A long-running session that
 * surfaces 10K+ symbols would naturally evict the oldest. Re-running
 * the same query rebinds the same `n_xxxxxxxx` (the short hash is
 * deterministic on `node.id`) so eviction-then-reassignment isn't a
 * silent miss.
 */

import * as crypto from 'node:crypto';

const MAX_ENTRIES = 4096;
const SHORT_LEN = 8;
const PREFIX = 'n_';

export class RefIdCache {
  /** uid → nodeId. LRU via Map insertion order. */
  private readonly forward: Map<string, string> = new Map();
  /** nodeId → uid (so re-rendering a node returns the same UID). */
  private readonly reverse: Map<string, string> = new Map();

  /**
   * Allocate (or look up the existing) short UID for a node id.
   * Same nodeId always resolves to the same UID within process
   * lifetime — the short hash is deterministic.
   */
  mint(nodeId: string): string {
    const cached = this.reverse.get(nodeId);
    if (cached) {
      // Bump LRU: re-insert at end of forward map.
      if (this.forward.has(cached)) {
        this.forward.delete(cached);
        this.forward.set(cached, nodeId);
      }
      return cached;
    }
    const uid = PREFIX + crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, SHORT_LEN);
    while (this.forward.size >= MAX_ENTRIES) {
      const oldest = this.forward.keys().next().value;
      // Explicit `=== undefined` (not truthy) — see NodeLruCache.set.
      if (oldest === undefined) break;
      const oldestNodeId = this.forward.get(oldest);
      this.forward.delete(oldest);
      if (oldestNodeId) this.reverse.delete(oldestNodeId);
    }
    this.forward.set(uid, nodeId);
    this.reverse.set(nodeId, uid);
    return uid;
  }

  /** Resolve a UID back to its node id (or null when unknown / evicted). */
  resolve(uid: string): string | null {
    return this.forward.get(uid) ?? null;
  }

  /** Detect whether a string looks like a short UID this cache mints. */
  static isUid(s: string): boolean {
    return typeof s === 'string' && s.startsWith(PREFIX) && s.length === PREFIX.length + SHORT_LEN;
  }

  /** Visible for tests + cleanup paths. */
  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }
}
