import { describe, expect, it } from 'vitest';
import {
  parseBetweennessWorkerInit,
  parseBetweennessWorkerReply,
} from '../src/centrality/betweenness-worker-contract.js';

function sharedInt32(values: number[]): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(values.length * Int32Array.BYTES_PER_ELEMENT);
  new Int32Array(buffer).set(values);
  return buffer;
}

describe('betweenness worker IPC contract', () => {
  it('parses a valid worker init payload', () => {
    const parsed = parseBetweennessWorkerInit({
      N: 3,
      outOffsetsBuf: sharedInt32([0, 1, 2, 2]),
      outFlatBuf: sharedInt32([1, 2]),
      sourceIndices: [0, 2],
    });

    expect(parsed.N).toBe(3);
    expect(parsed.outOffsetsBuf).toBeInstanceOf(SharedArrayBuffer);
    expect(parsed.outFlatBuf).toBeInstanceOf(SharedArrayBuffer);
    expect(parsed.sourceIndices).toEqual([0, 2]);
  });

  it('rejects malformed worker init payloads with a pathful error', () => {
    expect(() =>
      parseBetweennessWorkerInit({
        N: 3,
        outOffsetsBuf: sharedInt32([0, 1, 2, 2]),
        outFlatBuf: sharedInt32([1, 2]),
        sourceIndices: [0, 1.5],
      }),
    ).toThrow(/invalid betweenness worker init: sourceIndices\.1:/);
  });

  it('rejects malformed worker replies before the orchestrator reads buffers', () => {
    expect(() => parseBetweennessWorkerReply({ ok: true, durationMs: 1 })).toThrow(
      /invalid betweenness worker reply: cbBuf:/,
    );
  });
});
