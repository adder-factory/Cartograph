/**
 * Stable content-hash for a sorted summary-group cache key.
 *
 * Both file-grain ({@link import('./file-summarizer.js')}) and
 * directory-grain ({@link import('./dir-summarizer.js')}) summarisers
 * cache by `(group_items + anchor) → output prose`. They previously
 * had a byte-identical hash helper each — folded here so a future
 * tweak (e.g. domain separator, additional anchor metadata) updates
 * one place instead of drifting between two.
 *
 * Output is a sha256 truncated to 32 hex chars — plenty of bits to
 * fit the cache without bloating the row key.
 */

import * as crypto from 'node:crypto';

/** Minimum shape every summarisable item shares (file-grain symbols and dir-grain entries both satisfy this). */
export interface HashableSummaryItem {
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
}

/**
 * Sort `items` by `(kind, name)` so a row-order shuffle on the
 * upstream query doesn't invalidate the cache, then hash the sorted
 * `(kind, name, summary)` triples together with the anchor text.
 * Anchor text gets a domain separator so it can't collide with a
 * real summary row that happens to look like one.
 */
export function hashSummaryGroupContent(items: ReadonlyArray<HashableSummaryItem>, anchorText: string): string {
  const h = crypto.createHash('sha256');
  const sorted = [...items].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  for (const it of sorted) {
    h.update(it.kind);
    h.update('\0');
    h.update(it.name);
    h.update('\0');
    h.update(it.summary);
    h.update('\n');
  }
  h.update('\x01ANCHOR\x01');
  h.update(anchorText);
  return h.digest('hex').slice(0, 32);
}
