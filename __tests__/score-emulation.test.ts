/**
 * Regression tests for the emulation scorer (#30 methodology).
 * The CLI shape is exercised end-to-end by a smoke run in
 * docs/EMULATION-METHODOLOGY.md § 6; these tests pin the scoring
 * formulas so a future tweak doesn't silently change the
 * correctness contract.
 */

import { describe, it, expect } from 'vitest';
import { _testHooks } from '../scripts/score-emulation.js';

const { scoreSetExact, scoreSetSubset, scoreTopK } = _testHooks;

describe('emulation scorer', () => {
  it('scoreSetExact: matching sets → 1, mismatch → 0', () => {
    expect(scoreSetExact(['a', 'b'], ['a', 'b']).f1).toBe(1);
    expect(scoreSetExact(['a', 'b', 'c'], ['a', 'b']).f1).toBe(0);
    expect(scoreSetExact(['a'], ['a', 'b']).f1).toBe(0);
  });

  it('scoreSetSubset: precision/recall/f1 on subset overlap', () => {
    // 3 returned, 2 of which are in the 4-item expected set.
    const s = scoreSetSubset(['a', 'b', 'x'], ['a', 'b', 'c', 'd']);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 4);
    expect(s.f1).toBeCloseTo((2 * (2 / 3) * (2 / 4)) / (2 / 3 + 2 / 4));
  });

  it('scoreSetSubset: deduplicates returned before computing precision (#30 reviewer)', () => {
    // Tool returned `a` 3 times + `b` once. Without dedup, denominator
    // is 4 → precision = 2/4 = 0.5. With dedup, denominator is 2 →
    // precision = 2/2 = 1.0. Repeated outputs aren't a precision
    // penalty (e.g. grep emitting two lines per file).
    const s = scoreSetSubset(['a', 'a', 'a', 'b'], ['a', 'b', 'c']);
    expect(s.precision).toBe(1);
    expect(s.recall).toBeCloseTo(2 / 3);
  });

  it('scoreSetSubset: empty returned + empty expected → perfect', () => {
    const s = scoreSetSubset([], []);
    expect(s.f1).toBe(1);
  });

  it('scoreSetSubset: empty returned + non-empty expected → recall 0', () => {
    const s = scoreSetSubset([], ['a']);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it('scoreTopK: Precision@K with the expected set as unordered relevance', () => {
    // top-2 of returned hits 1 of 3 expected → P@2 = 0.5
    const s = scoreTopK(['x', 'a', 'b', 'c'], ['a', 'b', 'c'], 2);
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(1 / 3);
  });

  it('scoreTopK: returned shorter than K still counts against K denominator', () => {
    // returned has 1 hit; K=5 means denominator is 5 not 1.
    const s = scoreTopK(['a'], ['a', 'b'], 5);
    expect(s.precision).toBeCloseTo(1 / 5);
  });

  it('scoreTopK: deduplicates the top-K slice (no double credit for repeated hits)', () => {
    // top-3 slice = ['a','a','b']. Without dedup, 3 hits → precision = 3/3.
    // With dedup (post-reviewer), unique slice = {'a','b'} → 2 unique hits
    // → precision = 2/3 (still divided by k=3 per Precision@K convention).
    const s = scoreTopK(['a', 'a', 'b', 'c'], ['a', 'b'], 3);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(1);
  });
});
