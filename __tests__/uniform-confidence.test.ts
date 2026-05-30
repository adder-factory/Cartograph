/**
 * `formatNodeList` — uniform-confidence consolidation. When every
 * row carries the same non-default confidence (INFERRED or
 * AMBIGUOUS), hoist the marker into the header instead of
 * repeating ` *(INFERRED)*` per row. Saves ~12 chars × N rows on
 * the common-case caller/callee/impact output.
 *
 * Token-savings optimization shipped during the cartograph-vs-grep
 * gap analysis follow-up.
 */
import { describe, it, expect } from 'vitest';
import { formatNodeList, detectUniformConfidence } from '../src/mcp/tools/result-formatters.js';
import type { Node, Edge } from '../src/types.js';

function makeNode(id: string, name: string): Node {
  return {
    id,
    name,
    kind: 'function',
    filePath: `src/${name}.ts`,
    startLine: 10,
    endLine: 20,
    isExported: true,
    language: 'typescript',
  };
}

function makeEdge(targetId: string, confidence: Edge['confidence']): Edge {
  return {
    source: 'src',
    target: targetId,
    kind: 'calls',
    line: 10,
    confidence,
  };
}

describe('uniform-confidence consolidation', () => {
  it('hoists "all INFERRED" to header when every row is INFERRED', () => {
    const nodes = [makeNode('a', 'foo'), makeNode('b', 'bar'), makeNode('c', 'baz')];
    const edges = new Map<string, Edge>([
      ['a', makeEdge('a', 'INFERRED')],
      ['b', makeEdge('b', 'INFERRED')],
      ['c', makeEdge('c', 'INFERRED')],
    ]);
    const out = formatNodeList({ nodes, title: 'Callers of x', edges });
    expect(out).toMatch(/Callers of x \(3 found\) — all \*INFERRED\*/);
    // Per-row markers gone.
    expect(out).not.toMatch(/\*\(INFERRED\)\*/);
  });

  it('keeps per-row markers when confidence is mixed', () => {
    const nodes = [makeNode('a', 'foo'), makeNode('b', 'bar')];
    const edges = new Map<string, Edge>([
      ['a', makeEdge('a', 'INFERRED')],
      ['b', makeEdge('b', 'AMBIGUOUS')],
    ]);
    const out = formatNodeList({ nodes, title: 'Callers of x', edges });
    // Header doesn't claim uniformity.
    expect(out).not.toMatch(/all \*INFERRED\*|all \*AMBIGUOUS\*/);
    // Per-row markers present.
    expect(out).toMatch(/\*\(INFERRED\)\*/);
    expect(out).toMatch(/\*\(AMBIGUOUS\)\*/);
  });

  it('does not hoist when any row is EXTRACTED (the implicit default)', () => {
    const nodes = [makeNode('a', 'foo'), makeNode('b', 'bar')];
    const edges = new Map<string, Edge>([
      ['a', makeEdge('a', 'EXTRACTED')],
      ['b', makeEdge('b', 'INFERRED')],
    ]);
    const out = formatNodeList({ nodes, title: 'Callers of x', edges });
    // EXTRACTED + INFERRED is mixed; only the INFERRED row gets a marker.
    expect(out).not.toMatch(/all \*/);
    expect(out).toMatch(/\*\(INFERRED\)\*/);
  });

  it('does not hoist on single-row results (no consolidation benefit)', () => {
    const nodes = [makeNode('a', 'foo')];
    const edges = new Map<string, Edge>([['a', makeEdge('a', 'INFERRED')]]);
    const out = formatNodeList({ nodes, title: 'Callers of x', edges });
    // For 1 row the per-row marker is the cleaner shape.
    expect(out).not.toMatch(/all \*INFERRED\*/);
    expect(out).toMatch(/\*\(INFERRED\)\*/);
  });

  it('detectUniformConfidence direct API: returns the shared label or null', () => {
    expect(
      detectUniformConfidence(
        ['a', 'b'],
        new Map([
          ['a', makeEdge('a', 'INFERRED')],
          ['b', makeEdge('b', 'INFERRED')],
        ]),
      ),
    ).toBe('INFERRED');
    expect(
      detectUniformConfidence(
        ['a', 'b'],
        new Map([
          ['a', makeEdge('a', 'INFERRED')],
          ['b', makeEdge('b', 'AMBIGUOUS')],
        ]),
      ),
    ).toBe(null);
    expect(detectUniformConfidence([], undefined)).toBe(null);
  });
});
