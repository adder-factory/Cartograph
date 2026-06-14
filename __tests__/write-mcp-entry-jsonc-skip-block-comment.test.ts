/**
 * Tests for `skipBlockComment` in src/installer/targets/write-mcp-entry-jsonc.ts.
 *
 * The JSONC scanner calls this with `start` pointing just past an opening
 * "/*". It returns the index immediately after the closing "*​/", or the
 * end of the text when the comment is never closed. The two failure modes
 * worth pinning are: (1) it must not run past the buffer end on an
 * unterminated comment, and (2) it must not crash when the final character
 * is a lone "*" (so text[i + 1] reads past the end).
 */

import { describe, it, expect } from 'vitest';
import { skipBlockComment } from '../src/installer/targets/write-mcp-entry-jsonc.js';

describe('skipBlockComment', () => {
  it('returns the index immediately after the closing */', () => {
    const text = '/* note */rest';
    // start = 2 → just past the opening "/*".
    const end = skipBlockComment(text, 2);
    expect(end).toBe(text.indexOf('rest'));
    expect(text.slice(end)).toBe('rest');
  });

  it('handles a comment that closes immediately at the start position', () => {
    expect(skipBlockComment('*/', 0)).toBe(2);
  });

  it('matches the closing slash after consecutive stars (**/)', () => {
    // Must not treat the first "*" of "**" as the closer.
    expect(skipBlockComment('**/', 0)).toBe(3);
  });

  it('returns text length for an unterminated comment without overrunning', () => {
    const text = '/* never closes';
    expect(skipBlockComment(text, 2)).toBe(text.length);
  });

  it('does not crash when the final character is a lone star', () => {
    // text[i + 1] reads undefined at the end — undefined !== "/", so the loop
    // exits cleanly at the buffer end.
    const text = '/* dangling *';
    expect(skipBlockComment(text, 2)).toBe(text.length);
  });
});
