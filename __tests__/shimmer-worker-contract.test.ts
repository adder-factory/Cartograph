import { describe, expect, it } from 'vitest';
import {
  parseShimmerWorkerData,
  parseShimmerWorkerMessage,
  parseShimmerWorkerReply,
} from '../src/ui/shimmer-worker-contract.js';

describe('shimmer worker IPC contract', () => {
  it('parses valid worker startup data', () => {
    expect(parseShimmerWorkerData({ startTime: 123 }).startTime).toBe(123);
  });

  it('rejects worker startup data without a finite start time', () => {
    expect(() => parseShimmerWorkerData({ startTime: Number.NaN })).toThrow(/startTime/);
    expect(() => parseShimmerWorkerData({})).toThrow(/startTime/);
  });

  it('parses every parent-to-worker message variant', () => {
    expect(
      parseShimmerWorkerMessage({
        type: 'update',
        phase: 'parsing',
        phaseName: 'Parsing code',
        percent: 42,
        count: 0,
      }),
    ).toEqual({
      type: 'update',
      phase: 'parsing',
      phaseName: 'Parsing code',
      percent: 42,
      count: 0,
    });
    expect(parseShimmerWorkerMessage({ type: 'finish-phase' }).type).toBe('finish-phase');
    expect(parseShimmerWorkerMessage({ type: 'stop' }).type).toBe('stop');
  });

  it('rejects malformed update messages instead of trusting partial payloads', () => {
    expect(() =>
      parseShimmerWorkerMessage({
        type: 'update',
        phase: 'parsing',
        phaseName: 'Parsing code',
        percent: 42,
      }),
    ).toThrow(/count/);
  });

  it('parses only known worker replies', () => {
    expect(parseShimmerWorkerReply({ type: 'stopped' }).type).toBe('stopped');
    expect(() => parseShimmerWorkerReply({ type: 'done' })).toThrow(/type/);
  });
});
