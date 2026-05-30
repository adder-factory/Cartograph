import { describe, it, expect } from 'vitest';
import { stripPreamble, buildSummaryUserPrompt } from '../src/llm/summarizer.js';
import type { Node } from '../src/types.js';

/**
 * stripPreamble — post-filter for smaller models that occasionally
 * regress to the textbook "This function ..." docstring style despite
 * the prompt. The fix is mechanical: strip the preamble, capitalise
 * the next word, leave the rest alone.
 */

describe('stripPreamble', () => {
  it('strips "This function" preamble and capitalises the next verb', () => {
    expect(stripPreamble('This function appends server config to lines.')).toBe('Appends server config to lines.');
  });

  it('strips "This method" preamble', () => {
    expect(stripPreamble('This method initialises a database connection.')).toBe('Initialises a database connection.');
  });

  it('strips "This class" preamble', () => {
    expect(stripPreamble('This class wraps a SQLite connection.')).toBe('Wraps a SQLite connection.');
  });

  it('strips "This interface" preamble', () => {
    expect(stripPreamble('This interface describes a node shape.')).toBe('Describes a node shape.');
  });

  it('strips "This snippet" / "This code" / "This module" / "This component"', () => {
    expect(stripPreamble('This snippet computes a hash.')).toBe('Computes a hash.');
    expect(stripPreamble('This code returns null.')).toBe('Returns null.');
    expect(stripPreamble('This module exports helpers.')).toBe('Exports helpers.');
    expect(stripPreamble('This component renders a button.')).toBe('Renders a button.');
  });

  it('is case-insensitive on the keyword (not on the rest)', () => {
    expect(stripPreamble('this Function does X.')).toBe('Does X.');
    expect(stripPreamble('THIS FUNCTION  computes Y.')).toBe('Computes Y.');
  });

  it('tolerates leading whitespace', () => {
    expect(stripPreamble('   This function returns Z.')).toBe('Returns Z.');
  });

  it('no-op on already-compliant action-verb summaries', () => {
    expect(stripPreamble('Computes a SHA256 hash.')).toBe('Computes a SHA256 hash.');
    expect(stripPreamble('Reads a file with validation.')).toBe('Reads a file with validation.');
  });

  it('no-op when "This" is not a preamble (mid-sentence)', () => {
    expect(stripPreamble('Decodes this function from a buffer.')).toBe('Decodes this function from a buffer.');
  });

  it('no-op when "This" is not followed by a recognised kind keyword', () => {
    // We deliberately don't strip generic "This ..." since that often is
    // a legitimate sentence subject.
    expect(stripPreamble('This file is auto-generated.')).toBe('This file is auto-generated.');
  });

  it('handles empty / whitespace input', () => {
    expect(stripPreamble('')).toBe('');
    expect(stripPreamble('   ')).toBe('   ');
  });

  // ── Granite-1b tic patterns (2026-05-11 held-out eval) ──

  it('strips "Summary: " prompt-label echo', () => {
    expect(stripPreamble('Summary: Caches embeddings.')).toBe('Caches embeddings.');
  });

  it('strips "The function" preamble (matches the "This X" family)', () => {
    expect(stripPreamble('The function generates alternative phrasings.')).toBe('Generates alternative phrasings.');
  });

  it('strips a bare kind-word opener ("Interface defines …", "Class caches …")', () => {
    expect(stripPreamble('Interface defines port and pid.')).toBe('Defines port and pid.');
    expect(stripPreamble('Class caches LRU entries.')).toBe('Caches LRU entries.');
  });

  it('rewrites "Initiates a X constructor with …" → "Constructs X with …"', () => {
    expect(stripPreamble('Initiates a ParseError constructor with message and cause.')).toBe(
      'Constructs ParseError with message and cause.',
    );
  });

  it('strips "Initiates a/an " stem and keeps the noun', () => {
    expect(stripPreamble('Initiates a Response with optional fields.')).toBe('Response with optional fields.');
    expect(stripPreamble('Initiates an HTTP server that handles requests.')).toBe('HTTP server that handles requests.');
  });

  it('strips "That " sentence-continuation opener', () => {
    expect(stripPreamble('That handles HTTP requests for chat.')).toBe('Handles HTTP requests for chat.');
  });

  it('strips "To <verb>" infinitive opener', () => {
    expect(stripPreamble('To process candidate batches, handling local classification.')).toBe(
      'Process candidate batches, handling local classification.',
    );
  });

  it('does NOT strip "To " when followed by an uppercase noun (place name etc.)', () => {
    expect(stripPreamble('To Anthropic API, sends chat messages.')).toBe('To Anthropic API, sends chat messages.');
  });
});

/**
 * buildSummaryUserPrompt — the variable half of the single-symbol
 * summary prompt (the constant half lives in SUMMARY_SYSTEM_PROMPT).
 * Keeping it minimal is what lets the nllc backend reuse the
 * system-prompt KV-cache prefix across calls (lever A).
 */
describe('buildSummaryUserPrompt', () => {
  const node = (kind: string): Node => ({ kind, name: 'x' }) as Node;

  it('tags the symbol kind so the model picks the right framing', () => {
    expect(buildSummaryUserPrompt(node('function'), 'return 1;')).toContain('Summarise this function:');
    expect(buildSummaryUserPrompt(node('interface'), 'a: number;')).toContain('Summarise this interface:');
  });

  it('fences the body and carries no constant instruction text', () => {
    const out = buildSummaryUserPrompt(node('method'), 'doStuff();');
    expect(out).toContain('```\ndoStuff();\n```');
    // The constant preamble belongs in the system prompt, not here —
    // anything constant defeats the shared-prefix reuse.
    expect(out).not.toMatch(/senior code reviewer/i);
  });
});
