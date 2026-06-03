import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as parseCacheQueries from '../src/db/queries-parse-cache.js';
import * as profileModule from '../src/extraction/profile.js';

const state = {
  cached: null as null | { nodes: unknown[]; edges: unknown[]; errors: unknown[]; unresolvedReferences: unknown[] },
  cacheLookups: [] as unknown[],
};

vi.spyOn(parseCacheQueries, 'evictParseCacheIfOversized').mockImplementation((() => {}) as never);
vi.spyOn(parseCacheQueries, 'getLatestStructHashForFile').mockImplementation((() => null) as never);
vi.spyOn(parseCacheQueries, 'putCachedParse').mockImplementation((() => {}) as never);
vi.spyOn(parseCacheQueries, 'getCachedParse').mockImplementation(((args: unknown) => {
  state.cacheLookups.push(args);
  return state.cached;
}) as never);

vi.spyOn(profileModule, 'profile').mockImplementation(((_label: string, fn: () => unknown) => fn()) as never);
vi.spyOn(profileModule, 'profileTagged').mockImplementation(((args: { fn: () => unknown }) => args.fn()) as never);
vi.spyOn(profileModule, 'profileAsyncTagged').mockImplementation(((args: { fn: () => Promise<unknown> }) =>
  args.fn()) as never);
vi.spyOn(profileModule, 'flushProfileReport').mockImplementation((() => {}) as never);
vi.spyOn(profileModule, 'snapshotProfileDelta').mockImplementation((() => []) as never);
vi.spyOn(profileModule, 'mergeProfileEntries').mockImplementation((() => {}) as never);

const { eoRunParseOrCached } = await import('../src/extraction/extraction-phases.js');

function stateForCache() {
  return {
    queries: {},
    cacheHits: { count: 0 },
  } as never;
}

beforeEach(() => {
  state.cached = null;
  state.cacheLookups = [];
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('eoRunParseOrCached', () => {
  it('returns cached parse results and increments cache-hit accounting', async () => {
    const st = stateForCache();
    state.cached = { nodes: [{ id: 'n1' }], edges: [], errors: [], unresolvedReferences: [] };
    const errors: unknown[] = [];
    const counters = { processed: 0, filesErrored: 0 };

    const result = await eoRunParseOrCached(st, {
      filePath: 'src/a.ts',
      content: 'export const a = 1;',
      language: 'typescript',
      errors,
      counters,
      requestParse: async () => {
        throw new Error('cache hit should not parse');
      },
    });

    expect(result).toBe(state.cached);
    expect(st.cacheHits.count).toBe(1);
    expect(errors).toEqual([]);
    expect(counters).toEqual({ processed: 0, filesErrored: 0 });
    expect(state.cacheLookups).toHaveLength(1);
  });

  it('records parse errors and returns null when the parser throws', async () => {
    const errors: Array<{ message: string; filePath?: string; severity: string; code: string }> = [];
    const counters = { processed: 0, filesErrored: 0 };

    const result = await eoRunParseOrCached(stateForCache(), {
      filePath: 'src/broken.ts',
      content: 'broken',
      language: 'typescript',
      errors,
      counters,
      requestParse: async () => {
        throw new Error('parser exploded');
      },
    });

    expect(result).toBeNull();
    expect(counters).toEqual({ processed: 1, filesErrored: 1 });
    expect(errors).toEqual([
      { message: 'parser exploded', filePath: 'src/broken.ts', severity: 'error', code: 'parse_error' },
    ]);
  });

  it('returns fresh parser results when no cache entry exists', async () => {
    const fresh = { nodes: [], edges: [], errors: [], unresolvedReferences: [] };

    await expect(
      eoRunParseOrCached(stateForCache(), {
        filePath: 'src/fresh.ts',
        content: 'export const fresh = 1;',
        language: 'typescript',
        errors: [],
        counters: { processed: 0, filesErrored: 0 },
        requestParse: async () => fresh,
      }),
    ).resolves.toBe(fresh);
  });
});
