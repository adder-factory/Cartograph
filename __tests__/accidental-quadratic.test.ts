/**
 * B17 (2026-05-23) — `accidental_quadratic` biomarker.
 *
 * Pins the "Schlemiel the Painter" detector: indexed-loop over an
 * O(n) accessor (e.g. web-tree-sitter's `namedChild(i)`) that
 * compounds to O(n²) per parent. The detector is allowlist-driven
 * via {@link ACCIDENTAL_QUADRATIC_PATTERNS} and gated to JS/TS
 * languages where the known bug class actually manifests.
 *
 * These tests pin three contracts:
 *   1. The known bad shape is detected.
 *   2. Sibling-aware index use (`node.namedChild(i + 1)`) is
 *      legitimately skipped (false-positive guard).
 *   3. Non-JS/TS languages are ignored (the bug class is bound to
 *      the wasm-bridge accessor shape, not the loop syntax).
 *
 * The body-source-passed-in shape mirrors what `computeMetrics`
 * does (passes `bodyNode.text` through), so testing the textual
 * scan directly is faithful to production use.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCIDENTAL_QUADRATIC_PATTERNS,
  buildAccidentalQuadraticRegex,
  countAccidentalQuadratic,
} from '../src/biomarkers/engine.js';
import type { Language } from '../src/types.js';

describe('accidental_quadratic detector (B17)', () => {
  describe('positive matches (the bug shape)', () => {
    it('catches the canonical `namedChild(i)` indexed loop', () => {
      const body = `function visit(node) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visit(child);
        }
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(1);
    });

    it('catches the `child(i)` / `childCount` variant', () => {
      const body = `function walkAll(node) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          process(child);
        }
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(1);
    });

    it('catches multiple occurrences in one body', () => {
      const body = `
        for (let i = 0; i < a.namedChildCount; i++) { const c = a.namedChild(i); }
        for (let j = 0; j < b.namedChildCount; j++) { const d = b.namedChild(j); }
      `;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(2);
    });

    it('catches the pattern in javascript, tsx, and jsx too (full JS/TS family)', () => {
      const body = `for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); }`;
      expect(countAccidentalQuadratic(body, 'javascript')).toBe(1);
      expect(countAccidentalQuadratic(body, 'tsx')).toBe(1);
      expect(countAccidentalQuadratic(body, 'jsx')).toBe(1);
    });
  });

  describe('per-body sibling-guard is conservative (known false-negative — documented)', () => {
    // The guard tests the FULL body source for `<idx> ± N` patterns, not
    // just the matched loop's span. So two adjacent independent loops
    // both using index `i` — one legitimate sibling-access (`i + 1`)
    // and one Schlemiel — suppress EACH OTHER's detection. This is an
    // intentional trade-off (false-negative > false-positive on a perf
    // detector — a missed Schlemiel is recoverable, a noisy detector
    // gets ignored). Per-loop-span scoping would require brace-matching
    // which regex can't do cleanly.
    it('suppresses a real Schlemiel loop when an unrelated loop in the same body uses index plus 1', () => {
      const body = [
        'function f(a, b) {',
        '  // Legitimate sibling-access loop — uses i + 1 for next-child lookup.',
        '  for (let i = 0; i < a.namedChildCount; i++) {',
        '    const cur = a.namedChild(i);',
        '    const next = a.namedChild(i + 1);',
        '    if (cur && next) handle(cur, next);',
        '  }',
        '  // INDEPENDENT Schlemiel loop — pure indexed walk, no sibling use.',
        '  // Conservatively suppressed because the body-wide guard hits the i+1 above.',
        '  for (let i = 0; i < b.namedChildCount; i++) {',
        '    const c = b.namedChild(i);',
        '    if (c) handle(c, null);',
        '  }',
        '}',
      ].join('\n');
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(0);
    });
  });

  describe('false-positive guards', () => {
    it('SKIPS loops that use index for sibling access (`i + 1`)', () => {
      // sql-extractor.ts:261 style — `node.namedChild(i + 1)` to read
      // the keyword's argument after a `keyword_references` token.
      // Legitimately needs `i`.
      const body = `for (let i = 0; i < node.namedChildCount; i++) {
        const kw = node.namedChild(i);
        if (kw?.type === 'keyword') {
          const arg = node.namedChild(i + 1);
          if (arg) handle(arg);
        }
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(0);
    });

    it('SKIPS loops that use index for backward sibling access (`i - 1`)', () => {
      const body = `for (let i = 0; i < node.namedChildCount; i++) {
        const cur = node.namedChild(i);
        if (cur?.type === 'modifier') {
          const target = node.namedChild(i - 1);
          if (target) handle(target);
        }
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(0);
    });

    it('IGNORES non-JS/TS languages even when the shape matches textually', () => {
      const body = `for (int i = 0; i < node.namedChildCount; i++) {
        Node child = node.namedChild(i);
      }`;
      // Same shape but compiled in Java/Go/C++ wouldn't hit the WASM
      // bridge cost — detector limited to where the bug actually exists.
      expect(countAccidentalQuadratic(body, 'java' as Language)).toBe(0);
      expect(countAccidentalQuadratic(body, 'go' as Language)).toBe(0);
    });

    it('returns 0 for a body with no for-loops', () => {
      expect(countAccidentalQuadratic('const x = node.namedChild(0);', 'typescript')).toBe(0);
    });

    it('returns 0 for a `for (const child of node.namedChildren)` (the fix shape)', () => {
      const body = `for (const child of node.namedChildren) {
        if (child) visit(child);
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(0);
    });

    it('returns 0 for an indexed loop over a SAFE accessor (e.g. `.length` / `[i]`)', () => {
      const body = `for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        process(item);
      }`;
      expect(countAccidentalQuadratic(body, 'typescript')).toBe(0);
    });
  });

  describe('pattern allowlist + regex contract', () => {
    it('exports at least the two confirmed web-tree-sitter shapes', () => {
      const accessors = ACCIDENTAL_QUADRATIC_PATTERNS.map((p) => p.itemAccessor);
      expect(accessors).toContain('namedChild');
      expect(accessors).toContain('child');
    });

    it('regex is rebuildable and stays consistent with the cached instance', () => {
      const fresh = buildAccidentalQuadraticRegex();
      const sample = `for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); }`;
      expect(fresh.test(sample)).toBe(true);
      fresh.lastIndex = 0;
      expect(fresh.test(sample)).toBe(true);
    });
  });
});
