import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  cached: null as null | { nodes: unknown[]; edges: unknown[]; errors: unknown[]; unresolvedReferences: unknown[] },
  cacheLookups: [] as unknown[],
};

vi.mock('../src/db/queries-parse-cache.js', () => ({
  evictParseCacheIfOversized: vi.fn(),
  getLatestStructHashForFile: vi.fn(() => null),
  putCachedParse: vi.fn(),
  getCachedParse: vi.fn((args: unknown) => {
    state.cacheLookups.push(args);
    return state.cached;
  }),
}));

vi.mock('../src/extraction/profile.js', () => ({
  profile: vi.fn((_label: string, fn: () => unknown) => fn()),
  profileTagged: vi.fn((args: { fn: () => unknown }) => args.fn()),
  profileAsyncTagged: vi.fn((args: { fn: () => Promise<unknown> }) => args.fn()),
  flushProfileReport: vi.fn(),
  snapshotProfileDelta: vi.fn(() => []),
  mergeProfileEntries: vi.fn(),
}));

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
