/**
 * Unit tests for the innermost-enclosing-scope picker. Documents the
 * span-ASC-plus-containment-check invariant after a reviewer flagged
 * the inline copies of this logic as potentially buggy. Spoiler: not
 * a bug — but the test cases are useful regardless to lock the
 * invariant down.
 */
import { describe, it, expect } from 'vitest';
import { sortScopesBySpan, findEnclosingNode, type ScopeNode } from '../src/index-hooks/enclosing.js';

function pick(nodes: ScopeNode[], line: number): string | null {
  return findEnclosingNode(sortScopesBySpan(nodes), line);
}

describe('findEnclosingNode', () => {
  it('returns null when no scope contains the line', () => {
    expect(
      pick(
        [
          { id: 'f1', start: 1, end: 10 },
          { id: 'f2', start: 20, end: 30 },
        ],
        15,
      ),
    ).toBeNull();
  });

  it('returns the only matching scope when scopes are adjacent', () => {
    const scopes: ScopeNode[] = [
      { id: 'f1', start: 1, end: 10 },
      { id: 'f2', start: 20, end: 30 },
    ];
    expect(pick(scopes, 5)).toBe('f1');
    expect(pick(scopes, 25)).toBe('f2');
  });

  it('picks the innermost scope on simple nesting (class > method)', () => {
    expect(
      pick(
        [
          { id: 'A', start: 10, end: 100 },
          { id: 'm1', start: 20, end: 30 },
        ],
        25,
      ),
    ).toBe('m1');
  });

  it('picks the outer scope when only it contains the line', () => {
    expect(
      pick(
        [
          { id: 'A', start: 10, end: 100 },
          { id: 'm1', start: 20, end: 30 },
        ],
        50,
      ),
    ).toBe('A');
  });

  it('picks the innermost scope on deep nesting (3 levels)', () => {
    expect(
      pick(
        [
          { id: 'outer', start: 1, end: 100 },
          { id: 'middle', start: 10, end: 50 },
          { id: 'inner', start: 20, end: 30 },
        ],
        25,
      ),
    ).toBe('inner');
    expect(
      pick(
        [
          { id: 'outer', start: 1, end: 100 },
          { id: 'middle', start: 10, end: 50 },
          { id: 'inner', start: 20, end: 30 },
        ],
        35,
      ),
    ).toBe('middle');
    expect(
      pick(
        [
          { id: 'outer', start: 1, end: 100 },
          { id: 'middle', start: 10, end: 50 },
          { id: 'inner', start: 20, end: 30 },
        ],
        75,
      ),
    ).toBe('outer');
  });

  it('REGRESSION: an unrelated tiny function does NOT win over the real enclosing scope', () => {
    // Reviewer's hypothesised bug case: a top-level function with a
    // smaller span than the enclosing class. Sort puts it first, but
    // the containment check filters it out — outer class wins
    // correctly. This test pins the invariant down.
    expect(
      pick(
        [
          { id: 'class_A', start: 1, end: 100 }, // span 99
          { id: 'method_m', start: 20, end: 30 }, // span 10 (in A)
          { id: 'unrelated_f', start: 200, end: 205 }, // span 5 (not in A)
        ],
        60,
      ),
    ).toBe('class_A');
  });

  it('handles ties on span length deterministically (first by stable sort)', () => {
    // When two scopes have identical spans and both contain the line,
    // either is acceptable as "innermost." In practice nested scopes
    // can't tie (parent strictly contains child by ≥1 line). But two
    // sibling adjacent scopes can tie — only one will contain the line.
    const result = pick(
      [
        { id: 'a', start: 1, end: 10 },
        { id: 'b', start: 11, end: 20 },
      ],
      5,
    );
    expect(result).toBe('a');
  });
});
