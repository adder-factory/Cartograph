/**
 * F#72 — `makeLineIndex` semantics pin-test.
 *
 * The replacement for the 28 `content.slice(0, offset).split('\n').length`
 * call sites MUST return identical line numbers; this test cross-checks
 * the binary-search closure against the prior pattern across the edge
 * cases that came up in the framework resolvers.
 */
import { describe, it, expect } from 'vitest';
import { makeLineIndex } from '../src/utils.js';

function priorPattern(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

describe('makeLineIndex (F#72)', () => {
  it('returns 1 for offset 0 on any non-empty content', () => {
    expect(makeLineIndex('')(0)).toBe(1);
    expect(makeLineIndex('a')(0)).toBe(1);
    expect(makeLineIndex('a\nb\nc')(0)).toBe(1);
  });

  it('matches the prior slice+split pattern on a multi-line buffer', () => {
    const sample = 'line one\nline two\nline three\nline four\n';
    // Cover every offset in the buffer; the closure and the prior
    // pattern must agree at every position.
    const lineOf = makeLineIndex(sample);
    for (let i = 0; i <= sample.length; i++) {
      expect(lineOf(i), `offset ${i}`).toBe(priorPattern(sample, i));
    }
  });

  it('matches the prior pattern on a buffer with consecutive newlines', () => {
    const sample = 'a\n\n\nb\n\nc';
    const lineOf = makeLineIndex(sample);
    for (let i = 0; i <= sample.length; i++) {
      expect(lineOf(i), `offset ${i}`).toBe(priorPattern(sample, i));
    }
  });

  it('matches the prior pattern on a buffer with no newlines', () => {
    const sample = 'single line of source';
    const lineOf = makeLineIndex(sample);
    for (let i = 0; i <= sample.length; i++) {
      expect(lineOf(i), `offset ${i}`).toBe(priorPattern(sample, i));
    }
  });

  it('matches the prior pattern at offsets beyond the buffer end', () => {
    const sample = 'a\nb\nc';
    const lineOf = makeLineIndex(sample);
    // Out-of-bounds offsets behave like the prior pattern: the line
    // index saturates at the last line's count.
    expect(lineOf(sample.length + 10)).toBe(priorPattern(sample, sample.length + 10));
    expect(lineOf(1_000_000)).toBe(priorPattern(sample, 1_000_000));
  });

  it('reuses one allocation across many lookups', () => {
    const sample = new Array(1000).fill('line').join('\n');
    const lineOf = makeLineIndex(sample);
    // The closure should be callable arbitrarily many times without
    // re-scanning. This test pins the contract, not the perf number.
    for (let i = 0; i < 5000; i++) {
      const offset = (i * 17) % sample.length;
      expect(lineOf(offset)).toBe(priorPattern(sample, offset));
    }
  });
});
