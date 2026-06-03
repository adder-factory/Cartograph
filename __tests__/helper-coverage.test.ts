import { describe, expect, it } from 'vitest';
import { recommendedTuning, type DetectedHardware } from '../src/installer/hardware-tuning.js';
import { escapeLike } from '../src/mcp/tools/_search-intent.js';

function hw(overrides: Partial<DetectedHardware>): DetectedHardware {
  return {
    cpus: 8,
    totalMemGb: 32,
    platform: 'linux',
    arch: 'x64',
    isAppleSilicon: false,
    ...overrides,
  };
}

function slots(tuning: ReturnType<typeof recommendedTuning>): Record<string, number> {
  return {
    embed: tuning.embed.cartographConcurrency,
    chat: tuning.chat.cartographConcurrency,
    ask: tuning.ask.cartographConcurrency,
    reranker: tuning.reranker.cartographConcurrency,
  };
}

describe('low-coverage helper contracts', () => {
  it('escapes LIKE wildcard and escape characters for intent path filters', () => {
    expect(escapeLike('src/mcp/tools')).toBe('src/mcp/tools');
    expect(escapeLike('src/%_\\')).toBe('src/\\%\\_\\\\');
    expect(escapeLike('100%_done\\now')).toBe('100\\%\\_done\\\\now');
  });

  it('recommends Apple Silicon slots by memory tier', () => {
    expect(
      slots(recommendedTuning(hw({ platform: 'darwin', arch: 'arm64', isAppleSilicon: true, totalMemGb: 64 }))),
    ).toEqual({
      embed: 8,
      chat: 4,
      ask: 2,
      reranker: 4,
    });
    expect(
      slots(recommendedTuning(hw({ platform: 'darwin', arch: 'arm64', isAppleSilicon: true, totalMemGb: 12 }))),
    ).toEqual({
      embed: 4,
      chat: 2,
      ask: 1,
      reranker: 2,
    });
    expect(
      slots(recommendedTuning(hw({ platform: 'darwin', arch: 'arm64', isAppleSilicon: true, totalMemGb: 4 }))),
    ).toEqual({
      embed: 2,
      chat: 1,
      ask: 1,
      reranker: 1,
    });
  });

  it('recommends conservative non-Apple slots from memory and CPU caps', () => {
    expect(slots(recommendedTuning(hw({ totalMemGb: 4, cpus: 12 })))).toEqual({
      embed: 2,
      chat: 1,
      ask: 1,
      reranker: 1,
    });
    expect(slots(recommendedTuning(hw({ totalMemGb: 12, cpus: 12 })))).toEqual({
      embed: 4,
      chat: 2,
      ask: 1,
      reranker: 2,
    });
    expect(slots(recommendedTuning(hw({ totalMemGb: 64, cpus: 16 })))).toEqual({
      embed: 8,
      chat: 4,
      ask: 2,
      reranker: 4,
    });
    expect(slots(recommendedTuning(hw({ totalMemGb: 64, cpus: 2 })))).toEqual({
      embed: 2,
      chat: 2,
      ask: 1,
      reranker: 2,
    });
  });
});
