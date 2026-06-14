/**
 * Tests for `unquote` in src/review/diff-parser.ts.
 *
 * Git quotes diff paths containing special characters in C-style with
 * surrounding double quotes (e.g. `"path with spaces.ts"`). `unquote`
 * reverses that via JSON.parse, with a slice(1, -1) fallback when the
 * quoted form isn't valid JSON. Branches: falsy passthrough, unquoted
 * passthrough, JSON-decoded escapes, and the malformed-quote fallback.
 */

import { describe, it, expect } from 'vitest';
import { unquote } from '../src/review/diff-parser.js';

describe('unquote', () => {
  it('passes through null and empty (falsy) unchanged', () => {
    expect(unquote(null)).toBeNull();
    expect(unquote('')).toBe('');
  });

  it('passes through an unquoted path unchanged', () => {
    expect(unquote('src/app.ts')).toBe('src/app.ts');
  });

  it('strips surrounding quotes from a simple quoted path', () => {
    expect(unquote('"path with spaces.ts"')).toBe('path with spaces.ts');
  });

  it('decodes C-style escape sequences via JSON.parse', () => {
    // Input is the 9-char string  "a\tb.ts"  → JSON.parse yields a real tab.
    expect(unquote('"a\\tb.ts"')).toBe('a\tb.ts');
  });

  it('falls back to a raw quote-strip when the quoted form is not valid JSON', () => {
    // `"a"b"` starts and ends with a quote but is invalid JSON → slice(1, -1).
    expect(unquote('"a"b"')).toBe('a"b');
  });
});
