import { describe, it, expect } from 'vitest';
import { computeBetweenness } from '../src/centrality/betweenness.js';

function asNodes(ids: string[]) {
  return ids.map((id) => ({ id }));
}

describe('computeBetweenness — Brandes single-source correctness', () => {
  it('returns empty result for an empty graph', () => {
    const r = computeBetweenness([], []);
    expect(r.scores.size).toBe(0);
    expect(r.sampleCount).toBe(0);
  });

  it('returns zeros for N <= 2 (no intermediate node can exist)', () => {
    const r1 = computeBetweenness(asNodes(['a']), []);
    expect(r1.scores.get('a')).toBe(0);
    const r2 = computeBetweenness(asNodes(['a', 'b']), [{ source: 'a', target: 'b' }]);
    expect(r2.scores.get('a')).toBe(0);
    expect(r2.scores.get('b')).toBe(0);
  });

  it('path graph a→b→c: the middle node carries all betweenness', () => {
    // Only one s-t pair has an intermediate (a→c via b). Exact
    // betweenness with normalization (N-1)(N-2)=2: b = 1/2.
    const r = computeBetweenness(asNodes(['a', 'b', 'c']), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    expect(r.scores.get('a')).toBe(0);
    expect(r.scores.get('c')).toBe(0);
    expect(r.scores.get('b')).toBeCloseTo(0.5, 9);
  });

  it('barbell graph: bridge node ranks above everything else', () => {
    // Canonical Brandes test case. Two K3 cliques {a,b,c} and {d,e,f}
    // joined by directed pairs of bridge edges through node x. Each
    // clique node points to the others bidirectionally; x is the
    // only path between the cliques.
    const nodes = asNodes(['a', 'b', 'c', 'x', 'd', 'e', 'f']);
    const clique1Edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'a', target: 'c' },
      { source: 'c', target: 'a' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'b' },
    ];
    const clique2Edges = [
      { source: 'd', target: 'e' },
      { source: 'e', target: 'd' },
      { source: 'd', target: 'f' },
      { source: 'f', target: 'd' },
      { source: 'e', target: 'f' },
      { source: 'f', target: 'e' },
    ];
    const bridgeEdges = [
      { source: 'a', target: 'x' },
      { source: 'x', target: 'a' },
      { source: 'd', target: 'x' },
      { source: 'x', target: 'd' },
    ];
    const r = computeBetweenness(nodes, [...clique1Edges, ...clique2Edges, ...bridgeEdges], { normalize: false });
    const x = r.scores.get('x')!;
    for (const v of ['b', 'c', 'e', 'f']) {
      // Bridge node strictly dominates non-bridge clique members.
      expect(x).toBeGreaterThan(r.scores.get(v)!);
    }
  });

  it('star: hub of 9 leaves carries all betweenness; leaves all 0', () => {
    // Directed star with bidirectional spokes: every cross-leaf path
    // passes through the hub.
    const leaves = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'];
    const nodes = asNodes([...leaves, 'hub']);
    const edges = [];
    for (const l of leaves) {
      edges.push({ source: l, target: 'hub' });
      edges.push({ source: 'hub', target: l });
    }
    const r = computeBetweenness(nodes, edges, { normalize: false });
    const hub = r.scores.get('hub')!;
    expect(hub).toBeGreaterThan(0);
    for (const l of leaves) {
      expect(r.scores.get(l)).toBe(0);
    }
  });

  it('records a deterministic sampleCount equal to N for exact mode', () => {
    const r = computeBetweenness(asNodes(['a', 'b', 'c', 'd']), [{ source: 'a', target: 'b' }], { k: 0 });
    expect(r.sampleCount).toBe(4);
  });
});

describe('computeBetweenness — sampling determinism', () => {
  function chainGraph(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges = ids.slice(0, -1).map((src, i) => ({ source: src, target: ids[i + 1]! }));
    return { nodes: asNodes(ids), edges };
  }

  it('same seed produces byte-identical scores', () => {
    const { nodes, edges } = chainGraph(40);
    const a = computeBetweenness(nodes, edges, { k: 10, seed: 42 });
    const b = computeBetweenness(nodes, edges, { k: 10, seed: 42 });
    expect(a.sampleCount).toBe(10);
    expect(b.sampleCount).toBe(10);
    for (const [id, va] of a.scores) {
      expect(b.scores.get(id)).toBe(va);
    }
  });

  it('different seeds CAN produce different scores (jitter is real)', () => {
    const { nodes, edges } = chainGraph(40);
    const a = computeBetweenness(nodes, edges, { k: 5, seed: 1 });
    const b = computeBetweenness(nodes, edges, { k: 5, seed: 2 });
    // At least one node should differ — if not, the sampler is
    // ignoring the seed entirely.
    let anyDiff = false;
    for (const [id, va] of a.scores) {
      if (b.scores.get(id) !== va) {
        anyDiff = true;
        break;
      }
    }
    expect(anyDiff).toBe(true);
  });

  it('K >= N collapses to exact mode (no scale-up)', () => {
    const { nodes, edges } = chainGraph(8);
    const sampled = computeBetweenness(nodes, edges, { k: 100, seed: 7 });
    const exact = computeBetweenness(nodes, edges, { k: 0 });
    expect(sampled.sampleCount).toBe(8);
    expect(exact.sampleCount).toBe(8);
    for (const [id, ve] of exact.scores) {
      expect(sampled.scores.get(id)).toBeCloseTo(ve, 9);
    }
  });
});

describe('computeBetweenness — robustness', () => {
  it('drops edges referencing unknown ids without throwing', () => {
    const r = computeBetweenness(asNodes(['a', 'b']), [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'ghost' },
      { source: 'phantom', target: 'b' },
    ]);
    expect(r.scores.size).toBe(2);
    expect(r.scores.get('a')).toBe(0);
    expect(r.scores.get('b')).toBe(0);
  });

  it('handles self-loops without inflating the source node', () => {
    // A self-loop a→a shouldn't add betweenness to anything — there's
    // no path TO a that wouldn't start there.
    const r = computeBetweenness(asNodes(['a', 'b', 'c']), [
      { source: 'a', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    expect(r.scores.get('b')).toBeCloseTo(0.5, 9);
  });
});
