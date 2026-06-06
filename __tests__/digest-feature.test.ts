import { describe, expect, it } from 'vitest';
import { buildDigestMcpArgs } from '../src/features/digest/runtime.js';

describe('digest feature runtime', () => {
  it('builds the MCP payload', () => {
    expect(buildDigestMcpArgs()).toEqual({});
  });
});
