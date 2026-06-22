import { describe, expect, it } from 'vitest';
import {
  parsePageRankStepMessage,
  parsePageRankWorkerInit,
  parsePageRankWorkerReply,
} from '../src/centrality/pagerank-worker-contract.js';

function sharedBuffer(byteLength: number): SharedArrayBuffer {
  return new SharedArrayBuffer(byteLength);
}

function validInit(overrides: Record<string, unknown> = {}): unknown {
  const n = 3;
  return {
    targets: Int32Array.from([0, 2]),
    N: n,
    damping: 0.85,
    prBuf: sharedBuffer(n * Float64Array.BYTES_PER_ELEMENT),
    nextBuf: sharedBuffer(n * Float64Array.BYTES_PER_ELEMENT),
    outDegBuf: sharedBuffer(n * Int32Array.BYTES_PER_ELEMENT),
    inEdgesFlatBuf: sharedBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
    inEdgesOffsetsBuf: sharedBuffer((n + 1) * Int32Array.BYTES_PER_ELEMENT),
    ...overrides,
  };
}

describe('pagerank worker IPC contract', () => {
  it('parses a valid worker init payload', () => {
    const parsed = parsePageRankWorkerInit(validInit());

    expect(parsed.targets).toBeInstanceOf(Int32Array);
    expect(parsed.N).toBe(3);
    expect(parsed.damping).toBe(0.85);
  });

  it('rejects target indices outside the N-sized rank vector', () => {
    expect(() => parsePageRankWorkerInit(validInit({ targets: Int32Array.from([0, 3]) }))).toThrow(
      /invalid pagerank worker init: targets\.1:/,
    );
  });

  it('rejects shared buffers whose byte length cannot back the declared N', () => {
    expect(() => parsePageRankWorkerInit(validInit({ prBuf: sharedBuffer(Float64Array.BYTES_PER_ELEMENT) }))).toThrow(
      /invalid pagerank worker init: prBuf:/,
    );
  });

  it('parses only step messages with a numeric base-plus-dangling term', () => {
    expect(parsePageRankStepMessage({ type: 'step', basePlusDangling: 0.01 })).toEqual({
      type: 'step',
      basePlusDangling: 0.01,
    });
    expect(() => parsePageRankStepMessage({ type: 'step' })).toThrow(
      /invalid pagerank step message: basePlusDangling:/,
    );
  });

  it('rejects malformed worker replies before the orchestrator counts completion', () => {
    expect(() => parsePageRankWorkerReply({ type: 'done', extra: true })).toThrow(
      /invalid pagerank worker reply: <root>:/,
    );
  });
});
