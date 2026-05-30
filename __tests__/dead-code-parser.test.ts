/**
 * Unit tests for parseBatchJudges in src/llm/dead-code.ts.
 *
 * The dead-code judge moved to grammar-constrained structured output
 * (queue item 9, 2026-05-17): the model is handed `BATCH_JUDGE_SCHEMA`
 * as `ChatOptions.responseSchema`, so on the hard-constrained backends
 * (nllc GBNF / anthropic-api forced tool-use) the reply is a valid
 * `{"results":[…]}` document by construction. The old prose-tolerant
 * `parseJudgeResponse` / `extractFirstJsonObject` machinery was retired.
 * `parseBatchJudges` is a thin guard — it whitelists the verdict,
 * clamps the confidence, caps the reason, and degrades to an empty map
 * (the caller fills `uncertain`) on a malformed soft-backend reply.
 */

import { describe, it, expect } from 'vitest';
import { parseBatchJudges, truncateReason } from '../src/llm/dead-code.js';

describe('parseBatchJudges', () => {
  it('parses a clean results document into a position→verdict map', () => {
    const m = parseBatchJudges('{"results":[{"i":0,"verdict":"dead","confidence":0.9,"reason":"no callers"}]}', 1);
    expect(m.get(0)).toEqual({ verdict: 'dead', confidence: 0.9, reason: 'no callers' });
  });

  it('maps every entry by its own index', () => {
    const m = parseBatchJudges(
      '{"results":[{"i":0,"verdict":"dead","confidence":0.8,"reason":"a"},' +
        '{"i":1,"verdict":"live","confidence":0.7,"reason":"b"}]}',
      2,
    );
    expect(m.get(0)?.verdict).toBe('dead');
    expect(m.get(1)?.verdict).toBe('live');
  });

  it('clamps confidence to [0, 1]', () => {
    expect(
      parseBatchJudges('{"results":[{"i":0,"verdict":"dead","confidence":1.5,"reason":"x"}]}', 1).get(0)?.confidence,
    ).toBe(1);
    expect(
      parseBatchJudges('{"results":[{"i":0,"verdict":"dead","confidence":-0.2,"reason":"x"}]}', 1).get(0)?.confidence,
    ).toBe(0);
  });

  it('coerces an unknown verdict value to uncertain', () => {
    expect(
      parseBatchJudges('{"results":[{"i":0,"verdict":"maybe","confidence":0.5,"reason":"x"}]}', 1).get(0)?.verdict,
    ).toBe('uncertain');
  });

  it('truncates a very long reason string', () => {
    const longReason = 'x'.repeat(500);
    const m = parseBatchJudges(`{"results":[{"i":0,"verdict":"dead","confidence":0.5,"reason":"${longReason}"}]}`, 1);
    // Cap is 280 + a 1-char ellipsis; a single unbroken token is hard-sliced.
    expect(m.get(0)!.reason.length).toBeLessThanOrEqual(281);
    expect(m.get(0)!.reason.endsWith('…')).toBe(true);
  });

  it('drops an entry whose index is out of range', () => {
    expect(parseBatchJudges('{"results":[{"i":7,"verdict":"dead","confidence":0.5,"reason":"x"}]}', 2).size).toBe(0);
  });

  it('returns an empty map for malformed JSON or a missing results array', () => {
    expect(parseBatchJudges('I cannot determine whether this is dead code.', 3).size).toBe(0);
    expect(parseBatchJudges('{"verdict": "dead", confidence: 0.5}', 3).size).toBe(0); // unquoted key
    expect(parseBatchJudges('{"results":"nope"}', 3).size).toBe(0);
    expect(parseBatchJudges('[{"i":0,"verdict":"dead","confidence":0.5,"reason":"x"}]', 1).size).toBe(0); // bare array, not object-rooted
  });
});

describe('truncateReason', () => {
  it('leaves a reason within the cap untouched', () => {
    expect(truncateReason('no callers, not a framework hook')).toBe('no callers, not a framework hook');
  });

  it('trims on a word boundary, never mid-word', () => {
    // A realistic over-cap rationale built from whole words.
    const reason = (
      'not reachable through any dynamic dispatch or framework hook ' + 'and not part of the public API surface '
    )
      .repeat(4)
      .trim();
    const out = truncateReason(reason);
    expect(out.length).toBeLessThanOrEqual(281);
    expect(out.endsWith('…')).toBe(true);
    // The character before the ellipsis is a whole word — not a slice
    // through one. Reconstruct the head and confirm it is a prefix of
    // the original at a space boundary.
    const head = out.slice(0, -1);
    expect(reason.startsWith(head)).toBe(true);
    expect(reason[head.length]).toBe(' '); // cut landed on whitespace
  });

  it('does not produce the mid-word truncation from the audit repro', () => {
    // The pre-fix bug sliced "...used internally by other parts of the
    // codebase" to "...the codebas". The word-boundary trim must never
    // leave a partial trailing word. This reason is long enough (>280
    // chars) to actually trip the cap.
    const reason =
      'The function lineHasBuildContextHint is used within the project, ' +
      'as indicated by its presence in the static reference graph. It is not marked ' +
      'as exported, but it is likely used internally by other parts of the codebase, ' +
      'and removing it would probably break something somewhere down the line too.';
    const out = truncateReason(reason);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/codebas…$/); // not sliced mid-word
    const head = out.slice(0, -1);
    expect(reason.startsWith(head)).toBe(true);
    expect(reason[head.length]).toBe(' ');
  });
});
