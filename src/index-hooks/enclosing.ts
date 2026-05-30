/**
 * Innermost-enclosing-scope picker for line-based ref-attribution.
 *
 * Used by config-refs / sql-refs / build-context-refs hooks to attribute
 * each per-line read site to its enclosing function/method/class. Pure
 * — extracted from three near-identical inline copies that all had the
 * same shape (sort by span ASC, then for-loop the first containing node).
 *
 * Why span-ASC + first-containing-match works: in a properly-nested
 * AST, every chain of containing scopes goes outermost → innermost
 * with strictly DECREASING spans. Among the set of nodes that contain
 * a given line, the smallest span is always the innermost. Nodes that
 * don't contain the line are filtered by the containment check, so
 * their span ordering doesn't matter — even if an unrelated tiny
 * function elsewhere in the file sorts ahead of a real outer scope,
 * its containment check fails and the outer scope wins.
 *
 * (The reviewer flagged this as a bug in an earlier review — turned
 * out to be a non-issue once the containment check is considered. The
 * extraction here adds a unit test that documents the invariant so
 * future readers don't re-litigate it.)
 */

export interface ScopeNode {
  id: string;
  start: number;
  end: number;
}

/**
 * Sort `nodes` by span ascending and return them in a form ready for
 * `findEnclosingNode` lookups. Idempotent on already-sorted input.
 * Cached per file by the caller; sort is paid once.
 */
export function sortScopesBySpan(nodes: readonly ScopeNode[]): ScopeNode[] {
  return [...nodes].sort((a, b) => a.end - a.start - (b.end - b.start));
}

/**
 * Return the innermost enclosing scope's id for `line`, or null when
 * no scope contains the line. Expects `nodes` to be sorted by span
 * ascending (call `sortScopesBySpan` once and re-use across lines).
 */
export function findEnclosingNode(nodes: readonly ScopeNode[], line: number): string | null {
  for (const n of nodes) {
    if (n.start <= line && line <= n.end) return n.id;
  }
  return null;
}
