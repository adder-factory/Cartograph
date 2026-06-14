/**
 * Tests for `truncate` in src/features/file-deps/runtime.ts.
 *
 * Branches:
 *   - value.length <= max            → returned unchanged
 *   - value.length  > max            → sliced to `max - 3` chars + "..."
 *   - max < 3                        → Math.max(0, max - 3) clamps the slice
 *                                      length to 0, so the result is just "..."
 *                                      (and may exceed `max`, by design).
 */

import { describe, it, expect } from 'vitest';
import { truncate } from '../src/features/file-deps/runtime.js';

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns a string whose length equals max unchanged (inclusive boundary)', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates an over-length string to exactly max characters including the ellipsis', () => {
    const out = truncate('hello world', 8);
    expect(out).toBe('hello...');
    expect(out).toHaveLength(8);
  });

  it('clamps the slice to zero when max is smaller than the ellipsis', () => {
    // max - 3 is negative; Math.max(0, …) prevents a negative slice length.
    expect(truncate('hello', 2)).toBe('...');
    expect(truncate('hello', 0)).toBe('...');
  });
});
