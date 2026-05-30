/**
 * F#73 — Aho-Corasick automaton correctness tests.
 *
 * Pins the four contracts that the framework-dispatch pre-filter
 * depends on:
 *   1. Every match is found, regardless of pattern length / position.
 *   2. Overlapping patterns each report at their own start.
 *   3. `hasAny` short-circuits correctly (single match returns true).
 *   4. Edge cases: duplicate patterns dedup, empty patterns rejected.
 */
import { describe, it, expect } from 'vitest';
import { buildAhoCorasick } from '../src/utils/aho-corasick.js';

describe('Aho-Corasick (F#73)', () => {
  it('finds every occurrence of every pattern in a multi-match text', () => {
    const patterns = ['Bun.serve', 'cobra.Command', '@RequestMapping'];
    const text = `
      import { Bun } from 'bun';
      Bun.serve({ port: 3000 });
      // also @RequestMapping("/api") inside a JSDoc
      @RequestMapping("/users")
      cobra.Command{ Use: "list" }
      cobra.Command{ Use: "create" }
    `;
    const automaton = buildAhoCorasick(patterns);
    const matches = automaton.findAll(text);
    const byIndex = new Map<number, number>();
    for (const m of matches) byIndex.set(m.patternIndex, (byIndex.get(m.patternIndex) ?? 0) + 1);
    expect(byIndex.get(0)).toBe(1); // Bun.serve once
    expect(byIndex.get(1)).toBe(2); // cobra.Command twice
    expect(byIndex.get(2)).toBe(2); // @RequestMapping twice (JSDoc + real)
  });

  it('reports the correct start offset and length for each match', () => {
    const text = 'prefix Bun.serve suffix Bun.serve more';
    const automaton = buildAhoCorasick(['Bun.serve']);
    const matches = automaton.findAll(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ patternIndex: 0, start: 7, length: 9 });
    expect(matches[1]).toEqual({ patternIndex: 0, start: 24, length: 9 });
  });

  it('handles overlapping patterns where one is a suffix of another', () => {
    // 'serve' is a suffix of 'Bun.serve'. Both must report at their
    // own start positions.
    const patterns = ['Bun.serve', 'serve'];
    const text = 'Bun.serve(x)';
    const automaton = buildAhoCorasick(patterns);
    const matches = automaton.findAll(text);
    // Both should fire: 'Bun.serve' at offset 0, 'serve' at offset 4.
    const byIndex = matches.map((m) => ({ idx: m.patternIndex, start: m.start }));
    expect(byIndex).toEqual(
      expect.arrayContaining([
        { idx: 0, start: 0 },
        { idx: 1, start: 4 },
      ]),
    );
  });

  it('handles patterns that share prefixes correctly', () => {
    // 'app.get' and 'app.post' share 'app.' prefix.
    const patterns = ['app.get', 'app.post', 'app.delete'];
    const text = 'app.get(...) app.post(...) app.delete(...) app.get(...)';
    const automaton = buildAhoCorasick(patterns);
    const matches = automaton.findAll(text);
    expect(matches).toHaveLength(4);
    const indices = matches.map((m) => m.patternIndex);
    expect(indices).toEqual([0, 1, 2, 0]);
  });

  it('hasAny short-circuits on the first match', () => {
    const automaton = buildAhoCorasick(['Bun.serve', 'cobra.Command']);
    expect(automaton.hasAny('the file mentions Bun.serve here')).toBe(true);
    expect(automaton.hasAny('plain text with neither pattern')).toBe(false);
    // Empty text → no match.
    expect(automaton.hasAny('')).toBe(false);
  });

  it('returns no matches when no pattern occurs', () => {
    const automaton = buildAhoCorasick(['xxxx', 'yyyy']);
    expect(automaton.findAll('the quick brown fox')).toEqual([]);
  });

  it('dedups duplicate patterns to the first occurrence', () => {
    // Two identical patterns: both `findAll` matches should point at
    // index 0 (the first occurrence), not at index 1.
    const automaton = buildAhoCorasick(['foo', 'foo']);
    const matches = automaton.findAll('foofoo');
    expect(matches).toHaveLength(2);
    expect(matches[0]!.patternIndex).toBe(0);
    expect(matches[1]!.patternIndex).toBe(0);
  });

  it('rejects empty patterns at build time', () => {
    expect(() => buildAhoCorasick(['foo', ''])).toThrow(/empty patterns/);
  });

  it('handles a single-character pattern', () => {
    const automaton = buildAhoCorasick(['@']);
    const matches = automaton.findAll('@a@b@c');
    expect(matches.map((m) => m.start)).toEqual([0, 2, 4]);
  });

  it('matches at the very start and very end of the text', () => {
    const automaton = buildAhoCorasick(['hello']);
    expect(automaton.findAll('hello world')).toEqual([{ patternIndex: 0, start: 0, length: 5 }]);
    expect(automaton.findAll('world hello')).toEqual([{ patternIndex: 0, start: 6, length: 5 }]);
  });
});
