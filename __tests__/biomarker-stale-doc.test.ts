/**
 * stale_doc biomarker — Section A #12
 *
 * v1: constant-only — fires when both docstring and signature
 * contain numeric literals AND the sets are disjoint. Conservative
 * by design (info-only severity); the catch-list in the reviewer
 * memo is the ground truth (γ=2 vs =5, 0.4 vs =0.5).
 */
import { describe, it, expect } from 'vitest';
import { evaluateStaleDoc } from '../src/biomarkers/engine.js';
import { sharedDocstringsAcrossConstants } from '../src/biomarkers/index.js';

const C = (docstring, signature) => evaluateStaleDoc({ id: 'n1', docstring, signature });

describe('stale_doc biomarker', () => {
  it('does not fire when docstring is missing', () => {
    expect(C(undefined, '= 5.0')).toBeNull();
  });

  it('does not fire when signature is missing', () => {
    expect(C('Foo', undefined)).toBeNull();
  });

  it('does not fire when docstring contains no numbers', () => {
    expect(C('A constant for the thing', '= 5')).toBeNull();
  });

  it('does not fire when signature contains no numbers', () => {
    expect(C('Bumped to 5 last week', '= "hello"')).toBeNull();
  });

  it('does not fire when doc and sig share a number (5)', () => {
    expect(C('Magic value 5', '= 5')).toBeNull();
  });

  it('treats `5` and `5.0` as equivalent', () => {
    expect(C('Magic value 5', '= 5.0')).toBeNull();
    expect(C('Magic value 5.0', '= 5')).toBeNull();
  });

  it('fires on the reviewer-memo case: docstring "γ=2" with signature "= 5"', () => {
    const f = C('Bump factor — γ=2 in the formula above.', '= 5');
    expect(f).not.toBeNull();
    expect(f?.biomarker).toBe('stale_doc');
    expect(f?.severity).toBe('info');
  });

  it('fires on the reviewer-memo case: docstring "0.4 numbers" with signature "= 0.5"', () => {
    const f = C('Picked 0.4 after the eval gate landed.', '= 0.5');
    expect(f).not.toBeNull();
    expect(f?.severity).toBe('info');
  });

  it('does not match numbers embedded in identifiers (PR_DAMPING / v2)', () => {
    // doc has no STANDALONE numbers — only `v2` and `PR_DAMPING` (which contains nothing numeric)
    expect(C('See v2 of PR_DAMPING for context.', '= 5')).toBeNull();
  });

  it('does not match numbers prefixed by # (issue refs)', () => {
    expect(C('Tracked in issue #123.', '= 5')).toBeNull();
  });

  it("does not match apostrophe-prefixed year refs (McCabe '76)", () => {
    // The cartograph self-index produced this exact false positive
    // before the apostrophe guard landed.
    expect(C("Picked from McCabe '76 and Lanza '82.", '= { info: 50 }')).toBeNull();
  });

  it('does not match 4-digit years (1900–2100)', () => {
    expect(C('Released in 2024 per RFC.', '= 5')).toBeNull();
  });

  it('does not match percentage-suffixed numbers (50%)', () => {
    expect(C('Boosts recall by 50% on the eval suite.', '= 3')).toBeNull();
  });

  it('does not match RFC numbers outside the year range (RFC 3986)', () => {
    expect(C('URI parsing per RFC 3986.', '= 5')).toBeNull();
  });

  it('does not match port numbers (bind to port 8080)', () => {
    expect(C('Bind to port 8080 in dev.', '= 5')).toBeNull();
  });

  it('attaches docNumbers and sigNumbers in detail', () => {
    const f = C('Was 2', '= 5');
    expect(f?.detail).toMatchObject({ docNumbers: expect.arrayContaining(['2']) });
    expect(f?.detail).toMatchObject({ sigNumbers: expect.arrayContaining(['5']) });
  });

  it('fires when doc references multiple stale numbers, none in sig', () => {
    const f = C('Default 100, max 1000', '= 50');
    expect(f).not.toBeNull();
    expect(f?.metric).toBeGreaterThanOrEqual(2);
  });

  // ── friction #67 — illustrative-number filtering ─────────────────────────
  // The 4 FPs that motivated #67 all had docstrings whose only numbers
  // were illustrative (parenthetical approximations, examples, compound-
  // noun modifiers) rather than value claims. Pinning the contract that
  // these stay quiet, while real drift still fires.

  it('does not fire on parenthetical approximations: `(~85 MB)`', () => {
    // EMBED_MEM_GB_PER_INSTANCE shape.
    expect(C('Memory per embedding instance. Covers encoder weights (~85 MB at Q4) and overhead.', '= 0.4')).toBeNull();
  });

  it('does not fire on `e.g.` parentheticals', () => {
    // GB_ROUND_FACTOR shape.
    expect(C('Decimals retained on the GB rounding (e.g., 12.5 GB).', '= 10')).toBeNull();
  });

  it('does not fire on multi-tilde parens with ranges', () => {
    // CHAT_MEM_GB_PER_INSTANCE shape.
    expect(C('Covers model weights (~1.7-2.0 GB), server overhead (~0.5 GB).', '= 2.5')).toBeNull();
  });

  it('does not fire on compound-noun-modifier numbers (`1000-name list`)', () => {
    // MAX_SYMBOLS shape — number as count adjective, not value claim.
    expect(
      C('Hard cap; defends against a runaway loop when the agent passes a 1000-name list by mistake.', '= 20'),
    ).toBeNull();
  });

  it('does not fire on `for example` parentheticals', () => {
    expect(C('Buffer size (for example, 4096 bytes for typical IO).', '= 8192')).toBeNull();
  });

  it('does not fire on `approximately` parentheticals', () => {
    expect(C('Pool members (approximately 2 instances under typical load).', '= 4')).toBeNull();
  });

  it('STILL fires on real value claims in parens that lack approximation signal', () => {
    // (default: 10) is a value claim — no signal token, sig disagrees.
    const f = C('Number of retries (default: 10).', '= 50');
    expect(f).not.toBeNull();
  });

  it('STILL fires on standalone value claims after illustrative parens are stripped', () => {
    // Mixed: an illustrative paren + a real claim outside.
    const f = C('Default value: 10. Range examples (~5 for small projects, ~50 for large).', '= 100');
    expect(f).not.toBeNull();
  });

  // ── ISO-date filtering — date triples (YYYY-MM-DD) are never value claims
  // about the constant they decorate. The cartograph self-index produced
  // FPs on T_LOC and SECRETS_WARNING_FLOOR after session-handoff doc
  // edits added "2026-05-10" to comments.

  it('does not fire when docstring contains an ISO date (2026-05-10)', () => {
    expect(C('Threshold lifted on 2026-05-10. See note above.', '= 100')).toBeNull();
  });

  it('does not fire when docstring contains multiple ISO dates', () => {
    expect(C('Last updated 2026-05-10; was 2025-12-01 before.', '= 100')).toBeNull();
  });

  it('STILL fires when an ISO date AND a real value claim are both present', () => {
    // ISO date stripped, "0.4" remains as a real disagreement.
    const f = C('Bumped to 0.4 on 2026-05-10. Tracked there.', '= 0.5');
    expect(f).not.toBeNull();
  });
});

// ── shared-docstring dedup — ollama bug-hunt FP-2 ───────────────────────────
// When 2+ constants in the same file carry the identical docstring, it's
// almost certainly an inherited file-block prose comment (Go extractor
// attaches `/* file-doc */` to every const in a `const ( ... )` block).
// Such docs are NOT value-specific; skipping them at the per-file pass
// suppresses an entire class of stale_doc noise.

describe('sharedDocstringsAcrossConstants', () => {
  it('returns empty when no constants share a docstring', () => {
    const shared = sharedDocstringsAcrossConstants([
      { docstring: 'doc for A' },
      { docstring: 'doc for B' },
      { docstring: undefined },
    ]);
    expect(shared.size).toBe(0);
  });

  it('flags docstrings that appear on 2 or more constants', () => {
    const fileBlockDoc = '/* this file holds the foo constants */';
    const shared = sharedDocstringsAcrossConstants([
      { docstring: fileBlockDoc },
      { docstring: fileBlockDoc },
      { docstring: fileBlockDoc },
      { docstring: 'unique to D' },
    ]);
    expect(shared.has(fileBlockDoc)).toBe(true);
    expect(shared.has('unique to D')).toBe(false);
  });

  it('ignores null / undefined / empty docstrings', () => {
    const shared = sharedDocstringsAcrossConstants([
      { docstring: undefined },
      { docstring: null },
      { docstring: '' },
      { docstring: '' },
    ]);
    // Falsy docstrings are skipped at the counting step (`if (!c.docstring) continue`),
    // so an empty / null / undefined doc never makes it into the shared set.
    // stale_doc itself requires a non-empty docstring, so this is doubly safe.
    expect(shared.size).toBe(0);
  });

  it('treats identical-but-trimmed docstrings as distinct (no normalization)', () => {
    // Deliberate: matching is exact-string, so a doc with trailing
    // whitespace is treated separately. This matches the extractor's
    // stable output where docstrings for sibling constants come from
    // the SAME source comment, byte-for-byte.
    const shared = sharedDocstringsAcrossConstants([{ docstring: 'doc' }, { docstring: 'doc ' }]);
    expect(shared.size).toBe(0);
  });
});
