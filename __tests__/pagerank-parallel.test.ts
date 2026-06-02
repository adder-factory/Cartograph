/**
 * B10 (2026-05-24) — parallel PageRank parity + invariance tests.
 *
 * The serial path (`computePageRank` in `src/centrality/index.ts`) is
 * the reference; the parallel path (`computePageRankParallel` in
 * `src/centrality/pagerank-parallel.ts`) must produce the same
 * scores within a small float tolerance (Float64 addition isn't
 * associative — sub-LSB drift is expected in the danglingSum
 * accumulation order, but per-target sums use the same source order
 * as serial, so divergence stays under 1e-9).
 *
 * Also pins the routing predicate (`shouldUseParallel`) so the
 * parallel path doesn't accidentally fire on small graphs where the
 * worker-spawn overhead dominates.
 */
import { describe, it, expect } from 'vitest';
import { computePageRank } from '../src/centrality/index.js';
import {
  computePageRankParallel,
  shouldUseParallel,
  DEFAULT_PARALLEL_EDGE_THRESHOLD,
} from '../src/centrality/pagerank-parallel.js';

interface NodeRef {
  id: string;
}
interface EdgeRef {
  source: string;
  target: string;
}

function nextLcgValue(seed: number): { seed: number; value: number } {
  const nextSeed = (seed * 1664525 + 1013904223) >>> 0;
  return { seed: nextSeed, value: nextSeed / 0x100000000 };
}

/** Generate a synthetic graph with `nodeCount` nodes and ~`edgeCount`
 *  edges using a deterministic LCG seed so tests are reproducible. */
function buildSyntheticGraph(nodeCount: number, edgeCount: number, seed = 42): { nodes: NodeRef[]; edges: EdgeRef[] } {
  const nodes: NodeRef[] = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` }));
  const edges: EdgeRef[] = [];
  let rng = seed;
  for (let i = 0; i < edgeCount; i++) {
    const sourceRoll = nextLcgValue(rng);
    rng = sourceRoll.seed;
    const targetRoll = nextLcgValue(rng);
    rng = targetRoll.seed;
    const s = Math.floor(sourceRoll.value * nodeCount);
    const t = Math.floor(targetRoll.value * nodeCount);
    if (s !== t) edges.push({ source: `n${s}`, target: `n${t}` });
  }
  return { nodes, edges };
}

/** Compare two score Maps with a tolerance — log the max diff so a
 *  parity failure is easy to triage. */
function expectScoresClose(a: Map<string, number>, b: Map<string, number>, tol = 1e-9): void {
  expect(a.size).toBe(b.size);
  let maxDiff = 0;
  let worstKey = '';
  for (const [k, v] of a) {
    const other = b.get(k);
    expect(other).toBeDefined();
    const diff = Math.abs(v - (other ?? 0));
    if (diff > maxDiff) {
      maxDiff = diff;
      worstKey = k;
    }
  }
  expect({ maxDiff, worstKey, tolerance: tol }).toMatchObject({ maxDiff: expect.any(Number) });
  expect(maxDiff).toBeLessThan(tol);
}

describe('shouldUseParallel routing predicate', () => {
  it('returns false below the default edge threshold', () => {
    expect(shouldUseParallel(0)).toBe(false);
    expect(shouldUseParallel(100)).toBe(false);
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD - 1)).toBe(false);
  });

  it('returns true at and above the default threshold', () => {
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD)).toBe(true);
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD * 10)).toBe(true);
  });

  it('respects CARTOGRAPH_PAGERANK_SERIAL=1 override', () => {
    const saved = process.env['CARTOGRAPH_PAGERANK_SERIAL'];
    process.env['CARTOGRAPH_PAGERANK_SERIAL'] = '1';
    try {
      expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD * 100)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['CARTOGRAPH_PAGERANK_SERIAL'];
      else process.env['CARTOGRAPH_PAGERANK_SERIAL'] = saved;
    }
  });
});

describe('computePageRankParallel — parity with serial', () => {
  it('matches serial output on a tiny graph (5 nodes / 10 edges)', async () => {
    const { nodes, edges } = buildSyntheticGraph(5, 10);
    const serial = computePageRank(nodes, edges);
    const parallel = await computePageRankParallel(nodes, edges);
    expect(parallel.iterations).toBe(serial.iterations);
    expectScoresClose(serial.scores, parallel.scores);
  });

  it('matches serial output on a 500-node / 2K-edge graph', async () => {
    const { nodes, edges } = buildSyntheticGraph(500, 2000);
    const serial = computePageRank(nodes, edges);
    const parallel = await computePageRankParallel(nodes, edges);
    expectScoresClose(serial.scores, parallel.scores);
  }, 15_000);

  it('matches serial output on a 5K-node / 60K-edge graph (exercises the parallel code path directly, below the routing threshold)', async () => {
    const { nodes, edges } = buildSyntheticGraph(5000, 60_000);
    const serial = computePageRank(nodes, edges);
    const parallel = await computePageRankParallel(nodes, edges);
    expectScoresClose(serial.scores, parallel.scores);
  }, 30_000);

  it('returns empty result on an empty graph', async () => {
    const result = await computePageRankParallel([], []);
    expect(result.scores.size).toBe(0);
    expect(result.iterations).toBe(0);
  });

  it('handles edges referencing unknown nodes (silently drops them, matches serial)', async () => {
    const nodes: NodeRef[] = [{ id: 'a' }, { id: 'b' }];
    const edges: EdgeRef[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'nonexistent' }, // silently dropped
      { source: 'also-nonexistent', target: 'b' },
    ];
    const serial = computePageRank(nodes, edges);
    const parallel = await computePageRankParallel(nodes, edges);
    expectScoresClose(serial.scores, parallel.scores);
  });
});
