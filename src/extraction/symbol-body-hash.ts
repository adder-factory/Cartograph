/**
 * Per-symbol body slice + content hash. Shared by:
 *
 *  - the tree-sitter extractor's `createNode` (writes `nodes.body_hash`,
 *    migration 048)
 *  - the summarizer's `summaryReadBodyLines` + `contentHashFor` (writes
 *    `symbol_summaries.content_hash`)
 *
 * Both sides must use the SAME slice + the SAME hash function so
 * `getStaleArtifactsCount` can compare summary.content_hash to
 * nodes.body_hash and get a meaningful stale signal. Staleness-redesign
 * Phase 2 / friction F4 follow-on.
 *
 * The body slice is LINE-BASED (full lines from startLine..endLine
 * inclusive) — NOT byte-range-based — to match the summarizer's
 * historical slice. tree-sitter's `node.text` is column-precise byte
 * range; using it directly would diverge from the summarizer for any
 * symbol that starts mid-line (arrow-function assigned to const,
 * indented class method, etc.) and the hashes would mismatch
 * systematically. Reviewer-caught regression 2026-05-10.
 *
 * `MAX_BODY_CHARS` cap matches what the summarizer sends to the LLM;
 * including the cap in the hash means a body that grew past the cap
 * but kept its first 4000 chars identical still hashes the same —
 * which is what we want (no spurious stale signal from the truncation
 * marker alone).
 */

import * as crypto from 'crypto';

/** Body-text size cap (chars). Mirrors summarizer.ts's old constant. */
export const MAX_BODY_CHARS = 4000;

/**
 * Extract the symbol body from pre-split source lines, apply the
 * MAX_BODY_CHARS cap with a `// ... (truncated)` marker. Pass 1-indexed
 * start/end lines (end inclusive). Empty/missing lines array returns
 * an empty string (caller-friendly fallback for unreadable files).
 */
export function sliceSymbolBody(lines: string[] | null | undefined, startLine: number, endLine: number): string {
  if (!lines) return '';
  const slice = lines.slice(Math.max(0, startLine - 1), endLine);
  const joined = slice.join('\n');
  if (joined.length <= MAX_BODY_CHARS) return joined;
  return joined.slice(0, MAX_BODY_CHARS) + '\n// ... (truncated)';
}

/** Field separator for `computeStructHash` triples. Tab keeps the
 *  triple human-readable in debug logs and is unlikely to appear in
 *  the source-derived kind / qualifiedName / signature inputs. */
const STRUCT_FIELD_SEP = '\t';
/** Record separator for `computeStructHash`. Newline matches the
 *  triple-as-line convention. */
const STRUCT_RECORD_SEP = '\n';

/**
 * Per-symbol content hash — sha256(signature + '\0' + body), 32-hex
 * prefix. The signature null-terminator disambiguates the boundary
 * where the body starts; the 32-char prefix is a 128-bit truncation,
 * collision odds against O(10^9) symbols ~10^-20.
 */
export function symbolBodyHash(signature: string | null | undefined, body: string): string {
  const h = crypto.createHash('sha256');
  h.update(signature ?? '');
  h.update('\0');
  h.update(body);
  return h.digest('hex').slice(0, 32);
}

/**
 * Per-file structural + content fingerprint over the produced node
 * set — sha256 of the sorted
 * `[kind, qualifiedName, signature, bodyHash]` quadruples, 32-hex
 * prefix. Two files with identical struct_hash have the same set of
 * symbols (same kinds, same fully-qualified names, same signatures)
 * AND each symbol's body_hash matches — i.e., every symbol is
 * byte-identical in its body slice.
 *
 * **Body inclusion matters for correctness.** Without it, a content
 * edit that doesn't shift signatures (`return 'world'` →
 * `return 'modified'`) would hash-match the pre-edit shape, and the
 * format-only fast path in `eoPersistFileExtraction` would skip the
 * cascade-evict that real semantic changes require to drop stale
 * cross-file edges, embeddings, and biomarkers.
 *
 * Used by the format-only fast path: a cached struct_hash match
 * across content_hash variants is the trigger to do an UPDATE in
 * place (no cascade evict), since every node id AND every body_hash
 * is stable across the line-shift.
 *
 * Sorted before hashing so re-ordering top-level declarations (a
 * refactor that moves declarations around without changing what's
 * declared) is detected as "same shape" too — same-shape-different-
 * order produces identical nodes/edges, so the fast path is correct
 * either way.
 */
export function computeStructHash(
  nodes: ReadonlyArray<{
    kind: string;
    qualifiedName?: string;
    name: string;
    signature?: string | null;
    bodyHash?: string;
  }>,
): string {
  const quads = nodes.map(
    (n) =>
      `${n.kind}${STRUCT_FIELD_SEP}${n.qualifiedName ?? n.name}${STRUCT_FIELD_SEP}${n.signature ?? ''}${STRUCT_FIELD_SEP}${n.bodyHash ?? ''}`,
  );
  quads.sort();
  const h = crypto.createHash('sha256');
  for (const q of quads) {
    h.update(q);
    h.update(STRUCT_RECORD_SEP);
  }
  return h.digest('hex').slice(0, 32);
}
