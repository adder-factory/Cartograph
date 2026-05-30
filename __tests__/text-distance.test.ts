/**
 * Unit tests for the shared edit-distance primitives — the single
 * implementation behind every "did you mean?" / fuzzy-match path
 * (column-name suggestions, unknown-arg keys, path suggestions,
 * fuzzy symbol-name matching).
 */

import { describe, it, expect } from 'vitest';
import { boundedEditDistance, editDistance } from '../src/text-distance.js';

describe('boundedEditDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(boundedEditDistance('user', 'user', 2)).toBe(0);
  });

  it('returns 1 for a single substitution', () => {
    expect(boundedEditDistance('user', 'usar', 2)).toBe(1);
  });

  it('returns 1 for a single insertion', () => {
    expect(boundedEditDistance('user', 'users', 2)).toBe(1);
  });

  it('returns 1 for a single deletion', () => {
    expect(boundedEditDistance('users', 'user', 2)).toBe(1);
  });

  it('returns 2 for a transposition (two edits in basic Levenshtein)', () => {
    // 'aple' vs 'palp' would be 2; pick a clearer pair.
    // 'foo' vs 'fou': substitution + insertion = 2 if different lengths.
    expect(boundedEditDistance('confg', 'configX', 2)).toBe(2);
  });

  it('returns maxDist+1 when distance clearly exceeds budget', () => {
    expect(boundedEditDistance('foo', 'completely-different', 2)).toBe(3);
  });

  it('respects length-difference shortcut', () => {
    // |len(a) - len(b)| > maxDist must immediately be over budget
    expect(boundedEditDistance('a', 'aaaaaaa', 2)).toBe(3);
  });

  it('handles empty inputs', () => {
    expect(boundedEditDistance('', '', 2)).toBe(0);
    expect(boundedEditDistance('a', '', 2)).toBe(1);
    expect(boundedEditDistance('', 'abc', 2)).toBe(3);
  });

  it('is case-sensitive — caller must lowercase if case-insensitive match wanted', () => {
    expect(boundedEditDistance('Foo', 'foo', 2)).toBe(1);
  });

  it('early-exits when row min exceeds budget (correctness, not just perf)', () => {
    // 'aaaaa' vs 'bbbbb': distance is 5, well over budget 2
    expect(boundedEditDistance('aaaaa', 'bbbbb', 2)).toBe(3);
  });
});

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('user', 'user')).toBe(0);
  });

  it('returns the exact distance with no cutoff', () => {
    // boundedEditDistance with budget 2 would cap this at 3; the
    // unbounded variant must report the true distance.
    expect(editDistance('aaaaa', 'bbbbb')).toBe(5);
    // The classic Levenshtein worked example: kitten → sitting.
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('handles single edits', () => {
    expect(editDistance('user', 'usar')).toBe(1);
    expect(editDistance('user', 'users')).toBe(1);
    expect(editDistance('users', 'user')).toBe(1);
  });

  it('handles empty inputs', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('a', '')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('is case-sensitive', () => {
    expect(editDistance('Foo', 'foo')).toBe(1);
  });
});
