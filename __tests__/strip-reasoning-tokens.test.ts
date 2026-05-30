/**
 * Regression tests for `stripReasoningTokens` — strips `<think>` blocks
 * leaked from extended-thinking LLMs out of summary text and chat
 * answers before they get persisted or rendered.
 *
 * Triggered by cartograph_ask returning citation summaries that contained
 * raw `<think>` markers from a local model that emits reasoning inline.
 */

import { describe, it, expect } from 'vitest';
import { stripReasoningTokens } from '../src/utils.js';

describe('stripReasoningTokens', () => {
  it('removes a single closed think block', () => {
    expect(stripReasoningTokens('<think>plan...</think>actual answer')).toBe('actual answer');
  });

  it('removes multiple think blocks', () => {
    const input = '<think>a</think>one<think>b</think>two';
    expect(stripReasoningTokens(input)).toBe('onetwo');
  });

  it('handles multi-line think content', () => {
    const input = `<think>
line 1
line 2
</think>visible`;
    expect(stripReasoningTokens(input)).toBe('visible');
  });

  it('handles `<thinking>` variant', () => {
    expect(stripReasoningTokens('<thinking>x</thinking>y')).toBe('y');
  });

  it('drops an unclosed trailing opener (truncated stream)', () => {
    expect(stripReasoningTokens('answer<think>truncated')).toBe('answer');
  });

  it('drops a stray closer with no opener', () => {
    expect(stripReasoningTokens('orphan</think>tail')).toBe('orphantail');
  });

  it('passes empty / null-ish input through', () => {
    expect(stripReasoningTokens('')).toBe('');
  });

  it('passes clean text through unchanged', () => {
    expect(stripReasoningTokens('clean answer')).toBe('clean answer');
  });

  it('collapses leading blank lines created by the strip', () => {
    expect(stripReasoningTokens('<think>x</think>\n\nanswer')).toBe('answer');
  });

  it('is case-insensitive on the tag', () => {
    expect(stripReasoningTokens('<Think>x</THINK>y')).toBe('y');
  });

  it('tolerates whitespace inside the tag', () => {
    expect(stripReasoningTokens('< think >x</ think >y')).toBe('y');
  });

  it('preserves angle brackets that are not think tags', () => {
    expect(stripReasoningTokens('a < b && b > c — generic <T> stays')).toBe('a < b && b > c — generic <T> stays');
  });

  it('strips attribute-bearing think tags', () => {
    expect(stripReasoningTokens('<think type="chain-of-thought">x</think>visible')).toBe('visible');
  });

  it('strips attribute-bearing thinking tags', () => {
    expect(stripReasoningTokens('<thinking step="1">x</thinking>y')).toBe('y');
  });

  it('strips an attribute-bearing trailing unclosed opener', () => {
    expect(stripReasoningTokens('answer<think type="x">truncated')).toBe('answer');
  });

  it('preserves a backtick-wrapped literal mention (e.g. summary of the stripper itself)', () => {
    expect(stripReasoningTokens('Removes `<think>` tags from text')).toBe('Removes `<think>` tags from text');
  });

  it('preserves a backtick-wrapped attribute-bearing literal mention', () => {
    expect(stripReasoningTokens('Strips `<think type="cot">` blocks')).toBe('Strips `<think type="cot">` blocks');
  });
});
