import { describe, it, expect } from 'vitest';
import { computePageRank, PR_DAMPING, PR_ITERATIONS } from '../src/centrality/index.js';

function asNodes(ids: string[]) {
  return ids.map((id) => ({ id }));
}

describe('computePageRank', () => {
  it('returns empty result for an empty graph', () => {
    const r = computePageRank([], []);
    expect(r.scores.size).toBe(0);
    expect(r.iterations).toBe(0);
  });

  it('assigns uniform rank to N isolated nodes', () => {
    const r = computePageRank(asNodes(['a', 'b', 'c', 'd']), []);
    expect(r.scores.size).toBe(4);
    // 4 isolated nodes — all dangling — should each end up with 1/N.
    for (const v of r.scores.values()) {
      expect(v).toBeCloseTo(0.25, 6);
    }
  });

  it('rewards being reached (sinks accumulate rank)', () => {
    // a -> b -> c. c has no outgoing, so it accumulates the most.
    const r = computePageRank(asNodes(['a', 'b', 'c']), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    const a = r.scores.get('a')!;
    const b = r.scores.get('b')!;
    const c = r.scores.get('c')!;
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(a);
  });

  it('star: hub ranks above all leaves; leaves are equal', () => {
    const leaves = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'];
    const edges = leaves.map((l) => ({ source: l, target: 'hub' }));
    const r = computePageRank(asNodes([...leaves, 'hub']), edges);
    const hub = r.scores.get('hub')!;
    for (const l of leaves) {
      const lv = r.scores.get(l)!;
      expect(hub).toBeGreaterThan(lv);
    }
    // Leaves are symmetric — should be within 1e-9.
    const first = r.scores.get(leaves[0])!;
    for (const l of leaves.slice(1)) {
      expect(r.scores.get(l)!).toBeCloseTo(first, 9);
    }
  });

  it('cycle: all nodes have approximately equal rank', () => {
    const r = computePageRank(asNodes(['a', 'b', 'c']), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ]);
    const a = r.scores.get('a')!;
    const b = r.scores.get('b')!;
    const c = r.scores.get('c')!;
    // Symmetric → all equal at convergence.
    expect(a).toBeCloseTo(b, 6);
    expect(b).toBeCloseTo(c, 6);
  });

  it('total rank sums to ~1 (mass is conserved)', () => {
    const r = computePageRank(asNodes(['a', 'b', 'c', 'd', 'e']), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'd', target: 'c' },
      { source: 'e', target: 'd' },
      { source: 'a', target: 'e' },
    ]);
    let sum = 0;
    for (const v of r.scores.values()) sum += v;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('preserves mass across two disconnected components', () => {
    const r = computePageRank(asNodes(['a', 'b', 'c', 'd']), [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ]);
    let sum = 0;
    for (const v of r.scores.values()) sum += v;
    expect(sum).toBeCloseTo(1, 6);
    // Within each component, the sink ranks above the source.
    expect(r.scores.get('b')!).toBeGreaterThan(r.scores.get('a')!);
    expect(r.scores.get('d')!).toBeGreaterThan(r.scores.get('c')!);
  });

  it('drops edges referencing unknown nodes', () => {
    // 'ghost' is not in the node set — that edge should be ignored,
    // not crash and not pollute scores.
    const r = computePageRank(asNodes(['a', 'b']), [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'ghost' },
      { source: 'ghost', target: 'b' },
    ]);
    expect(r.scores.size).toBe(2);
    expect(r.scores.get('b')!).toBeGreaterThan(r.scores.get('a')!);
    let sum = 0;
    for (const v of r.scores.values()) sum += v;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('reports iteration count and duration', () => {
    const r = computePageRank(asNodes(['a', 'b']), [{ source: 'a', target: 'b' }]);
    expect(r.iterations).toBe(PR_ITERATIONS);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('damping constant is the textbook 0.85', () => {
    // Sentinel — protects against accidental tuning that would invalidate
    // the spike findings the PR was justified on.
    expect(PR_DAMPING).toBe(0.85);
  });
});
