/**
 * Aho-Corasick multi-pattern string matcher (F#73, 2026-05-28).
 *
 * In-tree implementation (no npm dependency, per user direction). Built
 * for the framework-resolver dispatch use case in
 * `eoRunFrameworkExtractors`: each resolver has one or more fixed
 * "anchor" substrings that MUST appear for any of its regex patterns
 * to match. Running ONE Aho-Corasick scan over the file content yields
 * the set of anchors present, which lets the dispatcher skip resolvers
 * whose anchors are absent.
 *
 * ## Why Aho-Corasick over N `.indexOf()` calls
 *
 * For N anchors and text of length M, the naive "loop over each
 * anchor, run indexOf" is O(N × M). Aho-Corasick is O(M + N + Z)
 * where Z is the number of matches: one preprocessed automaton, one
 * left-to-right pass over the text. On a real codebase with ~30
 * declared anchors and 1 MB worth of file content, the naive approach
 * is ~30 M character comparisons per file; the automaton does ~1 M.
 *
 * ## When to use this vs a regex
 *
 * Use the automaton when:
 *   - You want to detect the PRESENCE of one or more fixed
 *     substrings in text (anchor-presence check, no captures).
 *   - You have many patterns (N > ~5) — below that, plain
 *     `text.includes('foo') || text.includes('bar')` is competitive.
 *
 * Use a regex when:
 *   - The pattern has wildcards, character classes, anchors, captures,
 *     or quantifiers.
 *   - You want positional captures (use the automaton to FIND the
 *     anchor, then the regex on the local window).
 *
 * ## Match overlap semantics
 *
 * If two patterns share a suffix/prefix structure (e.g. `Bun.serve`
 * and `serve(`), the matcher returns BOTH at their respective
 * positions. No filtering / longest-only behaviour — the failure-link
 * walk includes every output ancestor of the current node so the
 * caller sees every match. Callers that want only the longest
 * match-at-position can post-process.
 *
 * ## Empty patterns and edge cases
 *
 * Empty patterns are rejected at build time (`buildAhoCorasick`
 * throws). Duplicate patterns are deduplicated by their first
 * occurrence — the returned matches reference the first index of
 * each unique pattern in the input list.
 *
 * ## Wire size
 *
 * The automaton stores children as `Map<number, AhoCorasickNode>`
 * keyed by UTF-16 code unit. For typical framework anchors (printable
 * ASCII, < 64 code units of pattern total) the automaton is a few
 * dozen nodes; memory overhead is trivial.
 */

interface AhoCorasickNode {
  children: Map<number, AhoCorasickNode>;
  /** Failure link — the longest proper suffix of the path to this
   *  node that's also a prefix of some pattern. Set during the BFS
   *  build phase; never null after construction (root failure-links
   *  to itself). */
  fail: AhoCorasickNode;
  /** Pattern indices whose match ENDS at this node. */
  outputs: number[];
}

export interface AhoCorasickMatch {
  /** Index into the original `patterns` array passed to `buildAhoCorasick`. */
  patternIndex: number;
  /** 0-indexed offset in the text where the match STARTS. */
  start: number;
  /** Length of the matched pattern in UTF-16 code units. */
  length: number;
}

export interface AhoCorasickAutomaton {
  /** Run the automaton over `text`, returning every match. Time
   *  complexity is O(text.length + matches). */
  findAll(text: string): AhoCorasickMatch[];
  /** Optimised "any match?" probe — returns true at the first match
   *  and short-circuits. Use when you only need a yes/no answer
   *  (the framework-dispatch pre-filter use case). */
  hasAny(text: string): boolean;
}

function createNode(rootForFail?: AhoCorasickNode): AhoCorasickNode {
  const node: AhoCorasickNode = {
    children: new Map(),
    // Placeholder; replaced during the BFS build. For the root, we
    // patch this to point at itself once the node exists.
    fail: undefined as unknown as AhoCorasickNode,
    outputs: [],
  };
  if (rootForFail) node.fail = rootForFail;
  return node;
}

/**
 * Phase 1 — build the trie under `root`. Track each pattern's terminal
 * node and append its index (deduplicated by string identity: duplicate
 * patterns map to the index of their FIRST occurrence).
 */
function buildTrie(root: AhoCorasickNode, patterns: readonly string[]): void {
  const firstIndexByPattern = new Map<string, number>();
  for (let i = 0; i < patterns.length; i++) {
    const pat = patterns[i]!;
    const existing = firstIndexByPattern.get(pat);
    const patternIdx = existing ?? i;
    if (existing === undefined) firstIndexByPattern.set(pat, i);

    let node = root;
    for (let j = 0; j < pat.length; ) {
      const codePoint = pat.codePointAt(j)!;
      let next = node.children.get(codePoint);
      if (!next) {
        next = createNode(root);
        node.children.set(codePoint, next);
      }
      node = next;
      // Advance by UTF-16 code units (1 for BMP, 2 for astral).
      j += codePoint > 0xffff ? 2 : 1;
    }
    // Avoid emitting duplicate output indices for repeated patterns.
    if (!node.outputs.includes(patternIdx)) node.outputs.push(patternIdx);
  }
}

/**
 * Phase 2 — BFS over the trie to compute failure links + propagate
 * outputs. For each depth-1 child of root, the fail link is root. For
 * deeper nodes, follow the parent's fail-chain until a child with the
 * same code is found (or fall back to root). Each node accumulates its
 * fail-target's outputs so the matcher can emit them inline without
 * walking the fail-chain at scan time.
 */
function linkFailures(root: AhoCorasickNode): void {
  const queue: AhoCorasickNode[] = [];
  for (const child of root.children.values()) {
    child.fail = root;
    queue.push(child);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const [code, child] of node.children) {
      let f = node.fail;
      while (f !== root && !f.children.has(code)) {
        f = f.fail;
      }
      // f either has a `code` child (use it) or is root. If root has
      // a `code` child different from `child` itself, that's the
      // failure target; otherwise fail to root.
      const candidate = f.children.get(code);
      child.fail = candidate && candidate !== child ? candidate : root;
      for (const outputIdx of child.fail.outputs) {
        if (!child.outputs.includes(outputIdx)) child.outputs.push(outputIdx);
      }
      queue.push(child);
    }
  }
}

/**
 * Follow failure links from `node` until a node with a `code` child is
 * found, or the walk lands back at root. Returns the node from which
 * the caller should read `children.get(code)` to advance. Allocation-
 * free hot path shared by `findAll` and `hasAny`.
 */
function walkFailLinks(root: AhoCorasickNode, node: AhoCorasickNode, code: number): AhoCorasickNode {
  let n = node;
  while (n !== root && !n.children.has(code)) {
    n = n.fail;
  }
  return n;
}

/**
 * Build an Aho-Corasick automaton from a list of fixed-string patterns.
 * Empty patterns are rejected. Duplicate patterns map to the index of
 * their FIRST occurrence in the input list.
 */
export function buildAhoCorasick(patterns: readonly string[]): AhoCorasickAutomaton {
  if (patterns.some((p) => p.length === 0)) {
    throw new Error('buildAhoCorasick: empty patterns are not allowed');
  }

  const root = createNode();
  root.fail = root; // Root failure-links to itself.

  buildTrie(root, patterns);
  linkFailures(root);

  return {
    findAll(text: string): AhoCorasickMatch[] {
      const matches: AhoCorasickMatch[] = [];
      let node = root;
      // Track both code-unit offset (for tree-sitter compat) and code-point index.
      for (let codeUnitPos = 0; codeUnitPos < text.length; ) {
        const codePoint = text.codePointAt(codeUnitPos)!;
        // Follow fail links until we find a node with the matching child,
        // or land back at root. Uses code-point key instead of UTF-16 code unit.
        node = walkFailLinks(root, node, codePoint);
        const next = node.children.get(codePoint);
        if (next) {
          node = next;
          // Emit every pattern whose match ends here.
          for (const outputIdx of node.outputs) {
            const pattern = patterns[outputIdx]!;
            // Pattern length is in code units (JavaScript's .length).
            const patternLen = pattern.length;
            // Match start in code units: current position - pattern length + 1.
            const matchStart = codeUnitPos - patternLen + 1;
            matches.push({
              patternIndex: outputIdx,
              start: matchStart,
              length: patternLen,
            });
          }
        }
        // Advance by UTF-16 code units (1 for BMP, 2 for astral).
        codeUnitPos += codePoint > 0xffff ? 2 : 1;
      }
      return matches;
    },
    hasAny(text: string): boolean {
      let node = root;
      for (let codeUnitPos = 0; codeUnitPos < text.length; ) {
        const codePoint = text.codePointAt(codeUnitPos)!;
        node = walkFailLinks(root, node, codePoint);
        const next = node.children.get(codePoint);
        if (next) {
          node = next;
          if (node.outputs.length > 0) return true;
        }
        // Advance by UTF-16 code units (1 for BMP, 2 for astral).
        codeUnitPos += codePoint > 0xffff ? 2 : 1;
      }
      return false;
    },
  };
}
