/**
 * cartograph_graph — impact "Wide blast radius" hops-advice normalisation.
 *
 * Friction #18 (audit group 1 #7): the impact handler's wide-blast-radius
 * warning advises "lower `hops` (try 1)" even when the effective traversal
 * depth is already 1 — a no-op suggestion that misleads the agent into a
 * non-fix. `graph.ts` post-processes the impact output to strip that clause
 * when the depth is already minimal. These tests pin both the pure rewriter
 * and the depth resolver.
 */
import { describe, it, expect } from 'vitest';
import { normaliseImpactHopsAdvice, effectiveImpactDepth } from '../src/mcp/tools/graph.js';

const WIDE_WARNING =
  '> ⚠ Wide blast radius (51 symbols). Consider narrowing: lower `hops` (try 1), ' +
  'or pick a more specific symbol. The per-file rollup below shows where impact concentrates.';

describe('normaliseImpactHopsAdvice', () => {
  it('strips the "lower hops" clause when the effective depth is already 1', () => {
    const out = normaliseImpactHopsAdvice(WIDE_WARNING, 1);
    expect(out).not.toMatch(/lower `hops`/);
    // The remaining sentence is still grammatical.
    expect(out).toMatch(/Consider narrowing: pick a more specific symbol\./);
    expect(out).toMatch(/Wide blast radius \(51 symbols\)/);
  });

  it('keeps the "lower hops" advice verbatim at depth > 1', () => {
    expect(normaliseImpactHopsAdvice(WIDE_WARNING, 2)).toBe(WIDE_WARNING);
    expect(normaliseImpactHopsAdvice(WIDE_WARNING, 5)).toBe(WIDE_WARNING);
  });

  it('is a no-op on text without the impact warning', () => {
    const other = '## Impact: "Foo" affects 3 symbols\n\n### Concentration by file';
    expect(normaliseImpactHopsAdvice(other, 1)).toBe(other);
  });
});

describe('effectiveImpactDepth', () => {
  it('defaults to 1 when no hops arg is supplied (mirrors _impact.ts and the hops schema default)', () => {
    expect(effectiveImpactDepth({})).toBe(1);
    expect(effectiveImpactDepth({ direction: 'impact', start: 'X' })).toBe(1);
  });

  it('uses an explicit hops value as the depth', () => {
    expect(effectiveImpactDepth({ hops: 1 })).toBe(1);
    expect(effectiveImpactDepth({ hops: 3 })).toBe(3);
  });

  it('coerces a numeric-string hops value', () => {
    expect(effectiveImpactDepth({ hops: '1' })).toBe(1);
  });
});
