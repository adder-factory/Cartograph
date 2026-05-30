/**
 * Unit tests for pure helpers in src/llm/dir-summarizer.ts.
 *
 * Regression coverage for the mid-word truncation issue surfaced by
 * the post-d446d6d MCP walkthrough — stored summaries used to end on
 * "...within project boundar…" because the writer hard-sliced. The
 * fix in 2c891b6 prefers a sentence boundary, then a word boundary,
 * before falling back to a hard slice.
 */

import { describe, it, expect } from 'vitest';
import { truncateAtBoundary, tidyLlmEnding } from '../src/llm/dir-summarizer.js';

describe('truncateAtBoundary', () => {
  it('returns input unchanged when within the cap', () => {
    const text = 'Short summary.';
    expect(truncateAtBoundary(text, 100)).toBe(text);
  });

  it('returns input unchanged when exactly at the cap', () => {
    const text = 'a'.repeat(50);
    expect(truncateAtBoundary(text, 50)).toBe(text);
  });

  it('truncates at the last sentence boundary inside the final ~80 chars', () => {
    const sentence1 = 'The module exposes a typed error hierarchy. ';
    const sentence2 = 'It also provides logging and freshness helpers. ';
    const tail = 'And then it goes on with much more prose that must be cut off cleanly';
    const text = sentence1 + sentence2 + tail;
    const cap = sentence1.length + sentence2.length + 20; // forces truncation in `tail`
    const out = truncateAtBoundary(text, cap);
    // Should end on the second sentence's '.' + ' …'
    expect(out).toBe(sentence1 + sentence2.trimEnd() + ' …');
    expect(out.endsWith(' …')).toBe(true);
  });

  it('falls back to the last word boundary when no sentence boundary is in range', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const cap = 30; // No '.' anywhere — must use last space
    const out = truncateAtBoundary(text, cap);
    expect(out).toMatch(/^[\w ]+ …$/);
    expect(out.length).toBeLessThanOrEqual(cap + 2); // ' …' suffix
    // The cut must land on a whole word — no trailing partial token.
    const body = out.replace(/ …$/, '');
    const lastWord = body.split(' ').pop()!;
    expect(text).toContain(' ' + lastWord + ' ');
  });

  it('hard-cuts only when neither boundary is reachable in the window', () => {
    // Single very long token forces the hard-cut branch.
    const text = 'a'.repeat(100);
    const out = truncateAtBoundary(text, 20);
    expect(out).toBe('a'.repeat(19) + '…');
    expect(out.length).toBe(20);
  });

  it('reproduces the original "within project boundar…" failure cleanly', () => {
    // The cg-e2e3 fixture's stored src/ summary used to end with
    // "...within project boundar…" — proving the prior writer hard-cut
    // mid-word. With the fix, the same input must end on a word, not
    // a partial token.
    const text =
      'The src module provides foundational error handling, logging abstractions, and utility ' +
      'functions for Cartograph core operations. It exports custom error classes that categorize ' +
      'failures across file IO, parsing, database, and search contexts. The module includes a ' +
      'Logger interface for pluggable logging, freshness-tracking utilities to monitor index ' +
      'staleness by comparing git state before and after indexing, and path validation helpers ' +
      'that safely resolve and constrain file paths within project boundaries.';
    const out = truncateAtBoundary(text, 600);
    // Must not end mid-word — the trailing token before " …" must be
    // a complete word that appears in the source text.
    const body = out.replace(/ …$/, '').replace(/…$/, '');
    const lastToken = body.split(/\s+/).pop()!;
    expect(text).toContain(lastToken);
    expect(lastToken).not.toBe('boundar');
  });

  it('keeps terminating punctuation on sentence-boundary cuts', () => {
    const text = 'First sentence ends here. Then another long enough tail that needs cutting.';
    const out = truncateAtBoundary(text, 30);
    // 'First sentence ends here. ' — period must survive, space dropped.
    expect(out).toBe('First sentence ends here. …');
  });
});

describe('tidyLlmEnding', () => {
  it('returns clean sentence-terminated text unchanged (just trims)', () => {
    expect(tidyLlmEnding('  A complete sentence.  ')).toBe('A complete sentence.');
    expect(tidyLlmEnding('Question?')).toBe('Question?');
    expect(tidyLlmEnding('Exclaim!')).toBe('Exclaim!');
    expect(tidyLlmEnding('Already trimmed …')).toBe('Already trimmed …');
  });

  it('trims back to the previous sentence boundary on mid-word truncation', () => {
    // LLM ran out of tokens mid-word ("row-") — must roll back to the
    // last `. ` and drop the partial sentence entirely.
    const cut = 'First sentence is fine. Second sentence cuts off mid row-';
    expect(tidyLlmEnding(cut)).toBe('First sentence is fine.');
  });

  it('preserves the terminator when there is a sentence boundary inside the trailing window', () => {
    const cut = 'A. B. C. D unfinished tail without terminator';
    // Last `. ` is after `C`, so result keeps through `C.` and drops the rest.
    const out = tidyLlmEnding(cut);
    expect(out).toBe('A. B. C.');
  });

  it('strips the trailing partial word and appends an ellipsis when no sentence boundary exists', () => {
    const cut = 'one long phrase without any terminators ever endin';
    const out = tidyLlmEnding(cut);
    // Last whitespace before `endin` is between `ever` and `endin`;
    // we drop `endin` and append ` …`.
    expect(out).toBe('one long phrase without any terminators ever …');
  });

  it('appends an ellipsis to a single-word mid-truncation that has no whitespace at all', () => {
    expect(tidyLlmEnding('singleworduncut')).toBe('singleworduncut…');
  });

  it('returns the empty string for empty / whitespace-only input', () => {
    expect(tidyLlmEnding('')).toBe('');
    expect(tidyLlmEnding('   \t\n  ')).toBe('');
  });
});
