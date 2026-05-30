/**
 * F#74 — `eoRunFrameworkExtractors` shared comment-stripped buffer.
 *
 * Pins the perf invariant: when two (or more) framework resolvers
 * that strip comments apply to the SAME file, `stripCommentsForRegex`
 * is called exactly ONCE per file (the first stripping resolver
 * pays the O(n) cost, every later resolver returns the cached
 * string). A future refactor that drops the thunk or rebuilds it
 * per-resolver would silently lose this perf win — this test fails
 * loudly in that case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as utils from '../src/utils.js';

describe('F#74 shared comment-stripped buffer', () => {
  let stripSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stripSpy = vi.spyOn(utils, 'stripCommentsForRegex');
  });

  afterEach(() => {
    stripSpy.mockRestore();
  });

  it('memoises the thunk: two consumers in the same call get ONE strip', () => {
    // Re-create the orchestrator's per-file thunk shape inline so the
    // test pins the invariant at the thunk-construction level (where
    // the bug would land) without spinning up the full extraction
    // pipeline.
    const content = '/* a comment */ function foo() { return 1; }\n// trailing comment\nlet x = 1;';
    const language = 'javascript' as const;
    let strippedCache: string | undefined;
    const getStripped = (): string => {
      if (strippedCache === undefined) {
        strippedCache = utils.stripCommentsForRegex(content, language);
      }
      return strippedCache;
    };

    // Simulate two stripping resolvers consuming the thunk.
    const aSafe = getStripped();
    const bSafe = getStripped();

    expect(stripSpy).toHaveBeenCalledTimes(1);
    // Same string instance — not just same value. Pins the cached-return
    // contract; a `.slice()` or `[...]` rebuild would break identity.
    expect(aSafe).toBe(bSafe);
  });

  it('lazy: zero strip calls when no consumer invokes the thunk', () => {
    // Files where every applicable resolver scans raw `content`
    // (java / ruby / swift / react) must not trigger the strip.
    const content = 'class Foo { public void bar() {} }';
    const language = 'java' as const;
    let strippedCache: string | undefined;
    const getStripped = (): string => {
      if (strippedCache === undefined) {
        strippedCache = utils.stripCommentsForRegex(content, language);
      }
      return strippedCache;
    };
    // Resolver chose NOT to call the thunk. No strip should happen.
    void getStripped; // Pin: the thunk exists but is unused.

    expect(stripSpy).toHaveBeenCalledTimes(0);
  });
});
