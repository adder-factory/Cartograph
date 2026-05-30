/**
 * Unit tests for `astBodyNodeRangeMismatch` — the defensive guard that
 * catches the friction #20 shape (bodyNode resolves to a containing
 * function much larger than the DB symbol's recorded range, leading to
 * inflated cyclomatic). Skip-and-log when the guard fires.
 *
 * The guard requires BOTH bounds to clear:
 *   - astLines > dbLines + 10 (absolute slack)
 *   - astLines > dbLines * 2  (multiplicative slack)
 *
 * Pinning the contract here so a future tweak to either threshold
 * needs explicit test updates rather than slipping past review.
 */
import { describe, it, expect } from 'vitest';
import { astBodyNodeRangeMismatch } from '../src/biomarkers/index.js';

// Helper: convert (dbStartLine, dbEndLine, astStartLine, astEndLine) — all
// 1-indexed for readability — into the function's row inputs (0-indexed
// for the AST side).
function check(dbStartLine: number, dbEndLine: number, astStartLine: number, astEndLine: number): boolean {
  return astBodyNodeRangeMismatch({
    dbStartLine,
    dbEndLine,
    astStartRow: astStartLine - 1,
    astEndRow: astEndLine - 1,
  });
}

describe('astBodyNodeRangeMismatch', () => {
  it('returns false when DB and AST agree exactly', () => {
    expect(check(100, 115, 100, 115)).toBe(false);
  });

  it('returns false when AST is a few lines longer (within slack)', () => {
    // dbLines=15, astLines=18 — difference is 3, well under +10 slack.
    expect(check(100, 114, 100, 117)).toBe(false);
  });

  it('returns false when AST is exactly +10 (boundary not crossed)', () => {
    // dbLines=15, astLines=25 (delta=10). Strict `>` so exactly +10 stays.
    expect(check(100, 114, 100, 124)).toBe(false);
  });

  it('returns false when astLines is +11 but only 1.7× — multiplicative bound saves it', () => {
    // dbLines=15, astLines=26 → +11 (clears absolute) but 26 < 15*2=30,
    // so multiplicative bound fails. Guard does NOT fire.
    expect(check(100, 114, 100, 125)).toBe(false);
  });

  it('fires when astLines clears BOTH +10 AND 2× — friction #20 repro shape', () => {
    // dbLines=15 / astLines=60 (4×). +45 over baseline. Guard fires.
    expect(check(100, 114, 100, 159)).toBe(true);
  });

  it('fires when AST node spans an obviously different region (start drift too)', () => {
    // dbLines=15 / astLines=50 (3.3×). Even with start drift, the size
    // delta alone trips the guard.
    expect(check(245, 259, 200, 249)).toBe(true);
  });

  it('does NOT fire on tiny one-line lambdas with reasonable AST drift', () => {
    // dbLines=1 (a one-line arrow function), astLines=8 — multiplicative
    // bound 1*2=2, astLines=8 clears that, but absolute 1+10=11 > 8 fails.
    // Guard does NOT fire — correct, the small body just has noisy framing.
    expect(check(50, 50, 50, 57)).toBe(false);
  });

  it('returns false on degenerate equal-line input (line counted as 1)', () => {
    // Both DB and AST report a single line. Math.max(1, ...) ensures
    // the delta is 0; nothing to flag.
    expect(check(50, 50, 50, 50)).toBe(false);
  });

  it('handles AST report being smaller than DB (under-range, harmless)', () => {
    // dbLines=20, astLines=10 — bodyNode resolved to a SMALLER region.
    // We'd under-count cyclomatic, not over-count. Guard does NOT fire
    // because both bounds compare astLines to a BIGGER baseline.
    expect(check(100, 119, 105, 114)).toBe(false);
  });

  it('large-but-symmetric: 200-line function with 200-line AST — no fire', () => {
    expect(check(1, 200, 1, 200)).toBe(false);
  });

  it('large-but-asymmetric: 50-line DB, 110-line AST — fires (clears 50+10=60 AND 50*2=100)', () => {
    expect(check(1, 50, 1, 110)).toBe(true);
  });
});
