/**
 * Regression test for the dead-code pre-filter pagination bug.
 *
 * Before: `findGraphCandidates` did one `findOrphanedSymbols(max * 2)`
 * fetch ordered by file_path. On JS/TS repos `__tests__/` sorts before
 * `src/` (`_` < letters), so a small `maxCandidates` could return ZERO
 * candidates after the path-exempt filter ate the whole first page.
 *
 * This file used to use `mock.module('../src/db/queries-roles.js', ...)`
 * at top level to inject a fake orphan stream. That works in isolation
 * but mutates the global module registry for the entire `bun test`
 * process — under `--shard=K/N`, the stub leaked into every later test
 * in the same shard that transitively imports `queries-roles.js` (via
 * `src/llm/dead-code.js` / `src/llm/classifier.js` / etc.) and caused
 * `__tests__/llm-tiers.test.ts` tests 2-17 to hang on
 * `bgCtrl.awaitCompletion()` for ~30 s each (~8.5 min wall per shard).
 *
 * Fix: `findGraphCandidates` now accepts an optional
 * `_findOrphanedSymbolsForTest` arg (see `src/llm/dead-code.ts`); the
 * test passes a closure directly. No module-registry mutation, no
 * cross-file pollution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Node } from '../src/types.js';
import type { QueryBuilder } from '../src/db/queries.js';
import { findGraphCandidates } from '../src/llm/dead-code.js';
import type { FindOrphanedSymbolsOptions } from '../src/db/queries-roles.js';

// Mutable stream the test populates per-case. The injected
// `_findOrphanedSymbolsForTest` closure reads from this.
const orphanStream = { pages: [] as Node[], pageCalls: 0 };

function stubFindOrphanedSymbols(_qb: QueryBuilder, options: FindOrphanedSymbolsOptions = {}): Node[] {
  orphanStream.pageCalls++;
  const { limit = 200, offset = 0 } = options;
  return orphanStream.pages.slice(offset, offset + limit);
}

function fakeNode(name: string, filePath: string): Node {
  return {
    id: `function:${filePath}:${name}`,
    name,
    kind: 'function',
    filePath,
    startLine: 1,
    endLine: 5,
    isExported: false,
  } as Node;
}

const DUMMY_QB = {} as unknown as QueryBuilder;

beforeEach(() => {
  orphanStream.pages = [];
  orphanStream.pageCalls = 0;
});

describe('findGraphCandidates pagination', () => {
  it('skips a fully-exempt first page and returns survivors from later pages', () => {
    // 200 test orphans (all exempt) come first, then 5 real src/ orphans.
    for (let i = 0; i < 200; i++) {
      orphanStream.pages.push(fakeNode(`helper${i}`, `__tests__/file${i}.test.ts`));
    }
    for (let i = 0; i < 5; i++) {
      orphanStream.pages.push(fakeNode(`real${i}`, `src/feature${i}.ts`));
    }

    const got = findGraphCandidates({
      queries: DUMMY_QB,
      max: 5,
      _findOrphanedSymbolsForTest: stubFindOrphanedSymbols,
    });
    expect(got).toHaveLength(5);
    expect(got.every((n) => n.filePath.startsWith('src/'))).toBe(true);
  });

  it('scans a fully-exempt corpus to its end and returns empty (no premature cap)', () => {
    for (let i = 0; i < 5000; i++) {
      orphanStream.pages.push(fakeNode(`helper${i}`, `__tests__/file${i}.test.ts`));
    }

    const got = findGraphCandidates({
      queries: DUMMY_QB,
      max: 10,
      _findOrphanedSymbolsForTest: stubFindOrphanedSymbols,
    });
    expect(got).toEqual([]);
    // The scan must walk PAST the old `max*25`-or-1000 cap — a real
    // repo can carry thousands of exempt orphans before the first
    // `src/` one, and stopping at 1000 reported a false "none" (the r8
    // cartograph_review regression). pageSize is max(10*4, 100) = 100,
    // so a full 5000-orphan sweep is ~51 page calls, then it stops
    // naturally on the empty page — well under FIND_GRAPH_SCAN_LIMIT.
    expect(orphanStream.pageCalls).toBeGreaterThan(10);
    expect(orphanStream.pageCalls).toBeLessThanOrEqual(60);
  });

  it('stops fetching once `max` survivors are found (no over-fetch)', () => {
    for (let i = 0; i < 50; i++) orphanStream.pages.push(fakeNode(`real${i}`, `src/x${i}.ts`));

    const got = findGraphCandidates({
      queries: DUMMY_QB,
      max: 3,
      _findOrphanedSymbolsForTest: stubFindOrphanedSymbols,
    });
    expect(got).toHaveLength(3);
    // Single page is enough — we should only have pulled `pageSize` rows
    // (max(3*4, 100) = 100), capped by the actual orphan count of 50.
    // (pageCalls is the per-call counter; total rows touched = up to
    // pageSize per call, slice naturally caps at the array length.)
    expect(orphanStream.pageCalls).toBe(1);
  });
});
