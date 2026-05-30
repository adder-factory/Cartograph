/**
 * Unit tests for `chooseCentralityDecimals` — the adaptive precision
 * picker for the `mode='ranked'` findings table. Closes friction #65:
 * before this fix, all rows rendered centrality at a fixed 4 dp, so a
 * cluster of long-tail leaves at e.g. 0.000123 / 0.000124 / 0.000125
 * all printed as `0.0001` and the displayed sort order looked
 * arbitrary even though it was correct at the SQL level.
 */
import { describe, it, expect } from 'vitest';
import { chooseCentralityDecimals, formatIndexedAt } from '../src/mcp/tools/biomarkers.js';

describe('chooseCentralityDecimals', () => {
  it('returns the minimum (4) on an empty list', () => {
    expect(chooseCentralityDecimals([])).toBe(4);
  });

  it('returns the minimum on a single row (no adjacency to collide with)', () => {
    expect(chooseCentralityDecimals([{ centrality: 0.000123 }])).toBe(4);
  });

  it('keeps 4 dp when adjacent rows already render distinctly there', () => {
    const rows = [{ centrality: 0.5 }, { centrality: 0.4 }, { centrality: 0.3 }];
    expect(chooseCentralityDecimals(rows)).toBe(4);
  });

  it('bumps to 5 dp when adjacent rows tie at 4 dp but separate at 5', () => {
    // 0.00012, 0.00013, 0.00014 — all render `0.0001` at 4 dp.
    const rows = [{ centrality: 0.00012 }, { centrality: 0.00013 }, { centrality: 0.00014 }];
    expect(chooseCentralityDecimals(rows)).toBe(5);
  });

  it('bumps to 6 dp when 5 still ties', () => {
    const rows = [{ centrality: 0.000012 }, { centrality: 0.000013 }, { centrality: 0.000014 }];
    expect(chooseCentralityDecimals(rows)).toBe(6);
  });

  it('caps at MAX (8) when centralities are truly equal', () => {
    // Equal-centrality rows: SQL falls back to metric DESC. The column
    // is accurately reporting equality at any precision.
    const rows = [{ centrality: 0.0001 }, { centrality: 0.0001 }, { centrality: 0.0001 }];
    expect(chooseCentralityDecimals(rows)).toBe(8);
  });

  it('NULL rows break adjacency (collision check resets)', () => {
    // [0.0001, NULL, 0.0001] — the NULL is rendered as `—` so the two
    // 0.0001 rows are NOT visually adjacent, no collision, MIN is fine.
    const rows = [{ centrality: 0.0001 }, { centrality: null }, { centrality: 0.0001 }];
    expect(chooseCentralityDecimals(rows)).toBe(4);
  });

  it('a collision before a NULL is not rescued by the trailing NULL', () => {
    // The two equal non-null rows at the head force MAX; the trailing
    // NULL doesn't undo the collision detected before it. Pinning this
    // so a future "skip NULL-bracketed sub-runs" optimisation doesn't
    // accidentally absolve a pre-NULL collision.
    const rows = [{ centrality: 0.0001 }, { centrality: 0.0001 }, { centrality: null }];
    expect(chooseCentralityDecimals(rows)).toBe(8);
  });

  it('all-NULL rows return the minimum (no comparable values)', () => {
    const rows = [{ centrality: null }, { centrality: null }, { centrality: null }];
    expect(chooseCentralityDecimals(rows)).toBe(4);
  });

  it('Q03 emulation case: large_method top 5 with clustered centralities (#65 repro)', () => {
    // Real numbers captured from a structural friction-watch run.
    // All five rows displayed `0.0001` at 4 dp — order looked arbitrary.
    // Pinning a representative cluster: chosen so adjacent ties at 4 dp
    // resolve at 5 dp.
    const rows = [
      { centrality: 0.000113 },
      { centrality: 0.000122 },
      { centrality: 0.000131 },
      { centrality: 0.000148 },
      { centrality: 0.000159 },
    ];
    expect(chooseCentralityDecimals(rows)).toBe(5);
  });
});

describe('formatIndexedAt', () => {
  // Friction (2026-05-15 round 7): the biomarkers clean-project message
  // interpolated the raw `index_timestamp` metadata (epoch-ms string),
  // so it rendered `(last indexed 1778878461471)` — unreadable, and
  // inconsistent with cartograph_status which shows an ISO date.
  it('renders an epoch-ms string as an ISO date', () => {
    expect(formatIndexedAt('1778878461471')).toBe('2026-05-15T20:54:21.471Z');
  });

  it('falls back to the raw value when it is not a finite number', () => {
    expect(formatIndexedAt('not-a-timestamp')).toBe('not-a-timestamp');
  });
});
