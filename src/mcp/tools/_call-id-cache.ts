/**
 * @internal — call-id cache for delta-mode tabular tools (#16).
 *
 * Tools that support `since=<call-id>` (currently
 * `cartograph_search` / `cartograph_grep` / `cartograph_explore`) stamp
 * each rendered result with a `c_xxxxxxxx` UID and stash the rendered
 * result's row keys against that UID. A follow-up call passing
 * `since=<uid>` filters out rows whose key is in the cached prior set
 * — the agent only sees what changed since the previous query.
 *
 * Shape choice: short hash deterministic on `(toolName, sortedRowKeys)`.
 * Re-running the SAME query thus rebinds the SAME UID, so an explicit
 * `since=<self>` reliably reports zero deltas (which is correct: nothing
 * changed). Different tools or different result sets produce distinct UIDs.
 *
 * Lifetime: MCP-server-lifetime, capped LRU. After eviction the prior
 * UID becomes unresolvable — handlers fall back to returning full
 * results + a warning footer rather than erroring (cross-restart use
 * isn't a goal of this token-saving shortcut, mirroring `_id-cache.ts`).
 */

import * as crypto from 'crypto';

const MAX_ENTRIES = 256;
const SHORT_LEN = 8;
const PREFIX = 'c_';

export class CallIdCache {
  /** uid → frozen row-key set. LRU via Map insertion order. */
  private readonly forward: Map<string, ReadonlySet<string>> = new Map();

  /**
   * Mint (or look up) the UID for a (toolName, rowKeys) pair. Same
   * inputs always resolve to the same UID within process lifetime
   * — the short hash is deterministic. Repeated mints bump LRU
   * position so frequently-rerun queries survive longer.
   */
  mint(toolName: string, rowKeys: ReadonlyArray<string>): string {
    // Sort for hash stability — call sites may vary order across
    // re-rendered queries (filter pass, re-rank). Sorted hash means
    // same set of rows always produces same UID.
    const sorted = [...rowKeys].sort();
    const material = `${toolName}\n${sorted.join('\n')}`;
    const uid = PREFIX + crypto.createHash('sha256').update(material).digest('hex').slice(0, SHORT_LEN);
    if (this.forward.has(uid)) {
      // Bump LRU: re-insert at end.
      const existing = this.forward.get(uid)!;
      this.forward.delete(uid);
      this.forward.set(uid, existing);
      return uid;
    }
    while (this.forward.size >= MAX_ENTRIES) {
      const oldest = this.forward.keys().next().value;
      // Explicit `=== undefined` (not truthy) — see NodeLruCache.set.
      if (oldest === undefined) break;
      this.forward.delete(oldest);
    }
    this.forward.set(uid, new Set(sorted));
    return uid;
  }

  /**
   * Resolve a UID back to its row-key set (or null when unknown /
   * evicted). Bumps LRU position on a successful lookup so actively-
   * read chain entries survive as long as actively-written ones —
   * without this, a long delta chain would slide its earliest UIDs
   * out of cache while still being passed as `since` arguments.
   */
  resolve(uid: string): ReadonlySet<string> | null {
    const hit = this.forward.get(uid);
    if (!hit) return null;
    this.forward.delete(uid);
    this.forward.set(uid, hit);
    return hit;
  }

  /**
   * Detect whether a string looks like a UID this cache mints.
   * Strict character-class check: hex only, prefix-and-length only.
   * Defends `since` against control chars / markdown injection landing
   * in the warning footer when the value cache-misses.
   */
  static isUid(s: string): boolean {
    return typeof s === 'string' && /^c_[0-9a-f]{8}$/.test(s);
  }

  /** Visible for tests + cleanup paths. */
  clear(): void {
    this.forward.clear();
  }
}
