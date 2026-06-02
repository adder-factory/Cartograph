/**
 * MCP tool numeric-arg sanitization regression tests.
 *
 * Pre-fix, every `Number(args.x) || N` and `(args.x as number) || N`
 * across the MCP handlers silently substituted the default when the
 * caller passed `0`. That made `dead_code` burn 50 LLM calls when the
 * caller asked for `maxCandidates: 0`, and `pending_summaries` return
 * 20 items for `limit: 0`. Sweep replaced those with `numArg`.
 *
 * Also covers the NaN-safe `clamp` so non-numeric tool args don't
 * propagate NaN into downstream queries.
 */

import { describe, it, expect } from 'vitest';
import { clamp, numArg } from '../src/utils.js';

describe('numArg', () => {
  it('preserves an explicit zero rather than substituting the fallback', () => {
    // The whole point of this helper. `Number(0) || 50` returns 50
    // — that's the bug the entire MCP-arg sweep is fixing.
    expect(numArg(0, 50)).toBe(0);
  });

  it('falls back when the value is missing or non-numeric', () => {
    expect(numArg(undefined, 50)).toBe(50);
    expect(numArg(null, 50)).toBe(50);
    expect(numArg('abc', 50)).toBe(50);
    expect(numArg({}, 50)).toBe(50);
    // Quirk: JS coerces `[]` to 0 via `Number([])`. We accept that
    // — MCP JSON callers don't normally send arrays for numeric args,
    // and tightening to fallback would risk breaking valid `0` values.
    expect(numArg([], 50)).toBe(0);
  });

  it('coerces numeric strings the way Number does', () => {
    expect(numArg('5', 50)).toBe(5);
    expect(numArg('0', 50)).toBe(0);
    expect(numArg('-3', 50)).toBe(-3);
  });

  it('treats NaN and infinities as the missing case', () => {
    expect(numArg(Number.NaN, 7)).toBe(7);
    expect(numArg(Infinity, 7)).toBe(7);
    expect(numArg(-Infinity, 7)).toBe(7);
  });

  it('preserves negative finite numbers (caller is responsible for clamping)', () => {
    expect(numArg(-5, 2)).toBe(-5);
  });
});

describe('clamp NaN-safety', () => {
  it('returns min when value is NaN', () => {
    expect(clamp(Number.NaN, 1, 10)).toBe(1);
  });

  it('returns min when value is Infinity (non-finite)', () => {
    // Sweep choice: any non-finite input collapses to min. Keeps
    // downstream queries from receiving Infinity disguised as a row
    // limit.
    expect(clamp(Infinity, 1, 10)).toBe(1);
    expect(clamp(-Infinity, 1, 10)).toBe(1);
  });

  it('still clamps finite values normally', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(15, 1, 10)).toBe(10);
    expect(clamp(-5, 1, 10)).toBe(1);
  });
});

describe('clamp + numArg compose for tool arg sanitization', () => {
  it('recovers maxCandidates=0 to the clamp floor instead of the default', () => {
    // The dead-code regression: `Number(0) || 50` was 50; now we get
    // numArg(0, 50) = 0 → clamp(0, 1, 500) = 1. Still issues 1 LLM
    // call, but a 50× cost win versus the old behaviour.
    expect(clamp(numArg(0, 50), 1, 500)).toBe(1);
  });

  it('keeps a numeric default for missing args', () => {
    expect(clamp(numArg(undefined, 50), 1, 500)).toBe(50);
  });

  it('handles non-numeric strings without leaking NaN', () => {
    // Pre-fix: clamp(NaN, 1, 200) === NaN, which then propagated into
    // SQL prepared-statement params and queries returned weird counts.
    expect(clamp(numArg('"; DROP TABLE nodes;', 20), 1, 200)).toBe(20);
  });

  it('handleSearch parity: limit=0 clamps to 1, not the legacy default of 10', () => {
    // Reviewer caught a missed sweep site at handleSearch (tools.ts).
    // This pins the pattern so a future regression on `Number(x) || N`
    // would be caught.
    expect(clamp(numArg(0, 10), 1, 100)).toBe(1);
    expect(clamp(numArg(undefined, 10), 1, 100)).toBe(10);
  });
});
