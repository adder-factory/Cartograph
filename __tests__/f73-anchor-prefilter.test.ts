/**
 * F#73 — anchor pre-filter integration invariants.
 *
 * The Aho-Corasick library has its own correctness tests; this file
 * locks in the two integration-level contracts that aren't covered by
 * the lib:
 *
 *   1. Anchor uniqueness across resolvers — a future PR that declares
 *      a duplicate anchor must fail loudly at build time, not silently
 *      skip the second resolver at scan time.
 *
 *   2. Pre-filter skip semantics — when a resolver declares anchors,
 *      a file whose content doesn't include ANY of them must result in
 *      the resolver being absent from `resolversWithAnchorHit` so the
 *      dispatcher can skip it.
 */
import { describe, it, expect } from 'vitest';
import { getAnchorAutomaton } from '../src/extraction/extraction-phases.js';
import type { FrameworkResolver } from '../src/resolution/types.js';

function makeStubResolver(name: string, anchors: readonly string[] | undefined): FrameworkResolver {
  return {
    name,
    ...(anchors === undefined ? {} : { anchors }),
    detect: () => true,
    resolve: () => null,
  };
}

describe('F#73 anchor pre-filter', () => {
  it('throws on duplicate anchors across resolvers', () => {
    const a = makeStubResolver('alpha', ['shared.thing']);
    const b = makeStubResolver('beta', ['shared.thing']);
    expect(() => getAnchorAutomaton([a, b])).toThrow(/anchor collision.*shared\.thing/);
  });

  it('allows the SAME resolver to declare the same anchor twice (de-facto no-op)', () => {
    // Resolvers shouldn't author duplicates within their own list, but
    // if they do, the assertion's "different owner" guard mustn't fire.
    const r = makeStubResolver('one', ['x', 'x']);
    expect(() => getAnchorAutomaton([r])).not.toThrow();
  });

  it('returns null when no resolver declares anchors', () => {
    const a = makeStubResolver('alpha', undefined);
    const b = makeStubResolver('beta', undefined);
    expect(getAnchorAutomaton([a, b])).toBeNull();
  });

  it('returns null when every resolver declares an EMPTY anchor list', () => {
    // `[]` should skip the resolver from the automaton entirely; if no
    // resolver contributes anchors, the result is null.
    const r = makeStubResolver('one', []);
    expect(getAnchorAutomaton([r])).toBeNull();
  });

  it('skip semantics — a file with no anchor produces zero resolver hits', () => {
    const r1 = makeStubResolver('r1', ['ANCHOR_ONE']);
    const r2 = makeStubResolver('r2', ['ANCHOR_TWO']);
    const filterer = getAnchorAutomaton([r1, r2]);
    expect(filterer).not.toBeNull();
    const text = 'some unrelated source code with neither pattern';
    const hits = new Set<number>();
    for (const m of filterer!.automaton.findAll(text)) {
      hits.add(filterer!.anchorOwners[m.patternIndex]!);
    }
    expect(hits.size).toBe(0);
  });

  it('skip semantics — a file with one anchor lights ONLY its resolver', () => {
    const r1 = makeStubResolver('r1', ['ANCHOR_ONE']);
    const r2 = makeStubResolver('r2', ['ANCHOR_TWO']);
    const filterer = getAnchorAutomaton([r1, r2]);
    expect(filterer).not.toBeNull();
    const text = 'source that contains ANCHOR_ONE but not the other pattern';
    const hits = new Set<number>();
    for (const m of filterer!.automaton.findAll(text)) {
      hits.add(filterer!.anchorOwners[m.patternIndex]!);
    }
    expect(hits.size).toBe(1);
    expect(hits.has(0)).toBe(true); // r1 is index 0
    expect(hits.has(1)).toBe(false); // r2 must be skipped
  });

  it('multi-anchor resolver — ANY anchor lights the whole resolver', () => {
    const multi = makeStubResolver('multi', ['ALPHA', 'BETA', 'GAMMA']);
    const filterer = getAnchorAutomaton([multi]);
    expect(filterer).not.toBeNull();
    const text = 'only GAMMA appears here, none of the other two';
    const hits = new Set<number>();
    for (const m of filterer!.automaton.findAll(text)) {
      hits.add(filterer!.anchorOwners[m.patternIndex]!);
    }
    expect(hits.has(0)).toBe(true);
  });
});
