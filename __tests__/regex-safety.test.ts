/**
 * Regression coverage for the RE2-backed `compileSafeRegex` /
 * `isSafeRegex` helpers in `src/regex.ts`. The motivating concern is
 * ReDoS: a hostile pattern against JS RegExp can spin the CPU for
 * minutes on input that's just a few KB. RE2's linear-time guarantee
 * makes the same input resolve in milliseconds.
 *
 * Failure modes guarded:
 *   - The "catastrophic backtracking" pattern `(a+)+` against a long
 *     pesky string runs in bounded time
 *   - Lookahead, lookbehind, and backreferences throw at construction
 *     (they require backtracking and RE2 rejects them by design)
 *   - Standard patterns still work (test/exec/source/flags/lastIndex)
 *   - `isSafeRegex` correctly rejects oversize + unsupported patterns
 */
import { describe, it, expect } from 'vitest';
import { compileSafeRegex, isSafeRegex } from '../src/regex.js';

describe('compileSafeRegex — RE2 safety guarantees', () => {
  it('resolves catastrophic-backtracking patterns in bounded time', () => {
    // The anchored `^(a+)+$` against a string of many `a`s followed by
    // a non-match character is the canonical ReDoS shape: a backtracking
    // engine explores every possible way to split the `a`s before
    // declaring failure (exponential in `a` count). JS RegExp hangs for
    // seconds at 40+ chars; RE2 returns in milliseconds in linear time.
    const evil = compileSafeRegex('^(a+)+$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const t0 = Date.now();
    const result = evil.test(input);
    const elapsed = Date.now() - t0;
    expect(result).toBe(false); // Anchored to start+end, the `!` blocks the match
    expect(elapsed).toBeLessThan(100); // RE2 budget — JS RegExp would hang for 10+ seconds
  });

  // The next three tests only assert that construction THROWS — not the
  // specific message text. RE2's C++ error strings are implementation-
  // internal and can shift across re2-wasm versions; the meaningful
  // guarantee is "this pattern can't compile under RE2", which a bare
  // .toThrow() locks without coupling to the message wording.
  it('rejects lookahead at construction', () => {
    expect(() => compileSafeRegex('(?=foo)bar', 'u')).toThrow();
  });

  it('rejects lookbehind at construction', () => {
    expect(() => compileSafeRegex('(?<=foo)bar', 'u')).toThrow();
  });

  it('rejects backreferences at construction', () => {
    expect(() => compileSafeRegex(String.raw`(\w)\1`, 'u')).toThrow();
  });

  it('preserves source + flags on the compiled instance', () => {
    const r = compileSafeRegex('foo', 'gi');
    expect(r.source).toBe('foo');
    // The helper appends `u` if absent — verify the contract.
    expect(r.flags).toContain('g');
    expect(r.flags).toContain('i');
    expect(r.flags).toContain('u');
  });

  it('supports lastIndex-driven g-flag iteration like RegExp', () => {
    const r = compileSafeRegex('foo', 'gu');
    const matches: number[] = [];
    let m: RegExpExecArray | null;
    r.lastIndex = 0;
    while ((m = r.exec('foo bar foo baz foo')) !== null) {
      matches.push(m.index);
      if (m.index === r.lastIndex) r.lastIndex++; // guard zero-width
    }
    expect(matches).toEqual([0, 8, 16]);
  });

  it('passes through standard cartograph_find shapes (anchors, classes, word boundaries)', () => {
    expect(compileSafeRegex('^export ', 'gu').test('export const x = 1;')).toBe(true);
    expect(compileSafeRegex(String.raw`\bclass\s+(\w+)`, 'gu').test('class FooBar {}')).toBe(true);
    expect(compileSafeRegex(String.raw`async\s+function`, 'gu').test('async function foo() {}')).toBe(true);
  });
});

describe('isSafeRegex — validity gate for `customPatterns` config', () => {
  it('accepts standard patterns', () => {
    expect(isSafeRegex('foo')).toBe(true);
    expect(isSafeRegex(String.raw`\bclass\s+(\w+)`)).toBe(true);
    expect(isSafeRegex('a|b|c')).toBe(true);
  });

  it('rejects oversize patterns (>500 chars)', () => {
    expect(isSafeRegex('a'.repeat(501))).toBe(false);
  });

  it('accepts the ReDoS pattern itself (linear-time means it is safe)', () => {
    // A core G16 lesson: the heuristic `isSafeRegex` predecessor rejected
    // `(a+)+` because JS RegExp would catastrophically backtrack on it.
    // Under RE2 the same pattern is fine — execution is linear-time
    // regardless of shape. Locking the change in behaviour here.
    expect(isSafeRegex('(a+)+')).toBe(true);
  });

  it('rejects RE2-unsupported features', () => {
    expect(isSafeRegex('(?=foo)bar')).toBe(false); // lookahead
    expect(isSafeRegex('(?<=foo)bar')).toBe(false); // lookbehind
    expect(isSafeRegex(String.raw`(\w)\1`)).toBe(false); // backreference
  });

  it('rejects malformed patterns', () => {
    expect(isSafeRegex('[unclosed')).toBe(false);
    expect(isSafeRegex('(')).toBe(false);
  });
});
