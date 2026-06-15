import { describe, expect, it } from 'vitest';
import { summariesActionSuffix } from '../src/features/status/rollups.js';

const OPTS = { summaryBreakdown: false, surface: 'cli' as const };

describe('summariesActionSuffix — status summaries call-to-action (issue #25)', () => {
  it('emits a positive "eager pass complete" signal when done but coverage plateaus below 100%', () => {
    const suffix = summariesActionSuffix({
      state: 'full',
      pending: 0,
      coverage: { summarised: 90, total: 100 },
      opts: OPTS,
    });
    expect(suffix).toContain('eager summary pass complete');
    expect(suffix).toContain('10 short / already-documented symbols');
    // crucially NOT the "pending; run … to complete" call-to-action
    expect(suffix).not.toContain('pending');
  });

  it('singularises the remainder count', () => {
    const suffix = summariesActionSuffix({
      state: 'full',
      pending: 0,
      coverage: { summarised: 99, total: 100 },
      opts: OPTS,
    });
    expect(suffix).toContain('1 short / already-documented symbol ');
  });

  it('emits no suffix at 100% coverage', () => {
    expect(
      summariesActionSuffix({ state: 'full', pending: 0, coverage: { summarised: 100, total: 100 }, opts: OPTS }),
    ).toBe('');
  });

  it('still shows the pending call-to-action while partial', () => {
    const suffix = summariesActionSuffix({
      state: 'partial',
      pending: 42,
      coverage: { summarised: 50, total: 100 },
      opts: OPTS,
    });
    expect(suffix).toContain('42 pending');
    expect(suffix).not.toContain('eager summary pass complete');
  });
});
