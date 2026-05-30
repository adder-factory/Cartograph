/**
 * Parity test for `computeBetweennessParallel`: scores must match the
 * serial `computeBetweenness` output within Float64 ULP-level drift
 * (~1e-9) on the same inputs, including the same seeded source
 * sampling. Mirrors `pagerank-parallel.test.ts`'s pin.
 *
 * Why the drift bound is not bit-exact: the host's reduce step adds
 * worker cb vectors element-wise across workers, and Float64 addition
 * isn't associative — so the reduce order matters at the ULP level.
 * In practice the disagreement is below 1e-12 on graphs we've seen;
 * 1e-9 is the safety margin the parity test pins.
 */

import { describe, it, expect } from 'vitest';
import { computeBetweenness } from '../src/centrality/betweenness.js';
import {
  computeBetweennessParallel,
  shouldUseParallel,
  DEFAULT_PARALLEL_EDGE_THRESHOLD,
  DEFAULT_PARALLEL_K_THRESHOLD,
} from '../src/centrality/betweenness-parallel.js';

function ringGraph(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const nodes = ids.map((id) => ({ id }));
  const edges = ids.map((src, i) => ({ source: src, target: ids[(i + 1) % n]! }));
  return { nodes, edges };
}

function gridGraph(rows: number, cols: number) {
  const ids: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) ids.push(`n${r}_${c}`);
  }
  const nodes = ids.map((id) => ({ id }));
  const edges: Array<{ source: string; target: string }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const me = `n${r}_${c}`;
      if (c + 1 < cols) edges.push({ source: me, target: `n${r}_${c + 1}` });
      if (r + 1 < rows) edges.push({ source: me, target: `n${r + 1}_${c}` });
    }
  }
  return { nodes, edges };
}

describe('computeBetweennessParallel — parity with the serial path', () => {
  it('ring N=40, K=10 seeded: parallel matches serial to ~1e-9', async () => {
    const { nodes, edges } = ringGraph(40);
    const serial = computeBetweenness(nodes, edges, { k: 10, seed: 17, normalize: false });
    const parallel = await computeBetweennessParallel(nodes, edges, { k: 10, seed: 17, normalize: false });
    expect(parallel.sampleCount).toBe(serial.sampleCount);
    for (const [id, sv] of serial.scores) {
      const pv = parallel.scores.get(id)!;
      expect(Math.abs(pv - sv)).toBeLessThan(1e-9);
    }
  });

  it('grid 8x6, exact mode (K >= N): parallel matches serial to ~1e-9', async () => {
    const { nodes, edges } = gridGraph(8, 6);
    const serial = computeBetweenness(nodes, edges, { k: 0, normalize: false });
    const parallel = await computeBetweennessParallel(nodes, edges, { k: 0, normalize: false });
    expect(parallel.sampleCount).toBe(serial.sampleCount);
    for (const [id, sv] of serial.scores) {
      const pv = parallel.scores.get(id)!;
      expect(Math.abs(pv - sv)).toBeLessThan(1e-9);
    }
  });

  it('empty / tiny graphs: parallel mirrors serial early-return shape', async () => {
    const empty = await computeBetweennessParallel([], []);
    expect(empty.scores.size).toBe(0);
    expect(empty.sampleCount).toBe(0);
    const tiny = await computeBetweennessParallel([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }]);
    expect(tiny.scores.get('a')).toBe(0);
    expect(tiny.scores.get('b')).toBe(0);
    expect(tiny.sampleCount).toBe(0);
  });
});

describe('shouldUseParallel — routing gate', () => {
  it('routes to serial when edge count is below the threshold', () => {
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD - 1, 200)).toBe(false);
  });

  it('routes to parallel at/above the edge threshold + K threshold', () => {
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD, DEFAULT_PARALLEL_K_THRESHOLD)).toBe(true);
  });

  it('routes to serial when K is small even on a big graph', () => {
    expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD * 10, DEFAULT_PARALLEL_K_THRESHOLD - 1)).toBe(false);
  });

  it('honors CARTOGRAPH_BETWEENNESS_SERIAL=1 escape hatch', () => {
    const prev = process.env['CARTOGRAPH_BETWEENNESS_SERIAL'];
    process.env['CARTOGRAPH_BETWEENNESS_SERIAL'] = '1';
    try {
      expect(shouldUseParallel(DEFAULT_PARALLEL_EDGE_THRESHOLD * 10, 1000)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['CARTOGRAPH_BETWEENNESS_SERIAL'];
      else process.env['CARTOGRAPH_BETWEENNESS_SERIAL'] = prev;
    }
  });
});
