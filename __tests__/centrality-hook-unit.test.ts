import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexHookContext } from '../src/index-hooks/registry.js';

const state = {
  metadata: new Map<string, string>(),
  nodes: [] as Array<{ id: string }>,
  edges: [] as Array<{ source: string; target: string }>,
  shouldParallel: false,
  throwFingerprint: false,
  calls: [] as Array<{ name: string; value?: unknown }>,
};

vi.mock('../src/centrality/index.js', () => ({
  PR_DAMPING: 0.85,
  PR_ITERATIONS: 20,
  PR_EDGE_KINDS: ['calls', 'references'],
  computePageRank: vi.fn((_nodes: unknown[], _edges: unknown[]) => {
    state.calls.push({ name: 'computePageRank' });
    return { scores: new Map([['n1', 0.5]]) };
  }),
}));

vi.mock('../src/centrality/pagerank-parallel.js', () => ({
  shouldUseParallel: vi.fn(() => state.shouldParallel),
  computePageRankParallel: vi.fn(async () => {
    state.calls.push({ name: 'computePageRankParallel' });
    return { scores: new Map([['n1', 0.75]]) };
  }),
}));

vi.mock('../src/db/queries.js', () => ({
  getAllNodes: vi.fn(() => state.nodes),
}));

vi.mock('../src/db/queries-centrality.js', () => ({
  clearCentrality: vi.fn(() => state.calls.push({ name: 'clearCentrality' })),
  applyCentralityScores: vi.fn((_queries: unknown, scores: unknown) =>
    state.calls.push({ name: 'applyCentralityScores', value: scores }),
  ),
}));

vi.mock('../src/db/queries-metadata.js', () => ({
  getMetadata: vi.fn((_queries: unknown, key: string) => state.metadata.get(key) ?? null),
  setMetadata: vi.fn((_queries: unknown, key: string, value: string) => {
    state.calls.push({ name: 'setMetadata', value: { key, value } });
    state.metadata.set(key, value);
  }),
}));

vi.mock('../src/errors.js', () => ({
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  logDebug: vi.fn((message: string) => state.calls.push({ name: 'logDebug', value: message })),
}));

const { HOOK } = await import('../src/index-hooks/centrality.js');

function ctx(config: Record<string, unknown> = {}): IndexHookContext {
  return {
    config,
    queries: {},
    db: {
      getDb: () => ({
        prepare: (sql: string) => {
          if (state.throwFingerprint) throw new Error('db unavailable');
          if (sql.includes('MAX(updated_at)')) {
            return { get: () => ({ count: state.nodes.length, max_updated: 123 }) };
          }
          if (sql.includes('COUNT(*) as count FROM edges')) {
            return { get: () => ({ count: state.edges.length }) };
          }
          return { all: () => state.edges };
        },
      }),
    },
  } as IndexHookContext;
}

beforeEach(() => {
  state.metadata.clear();
  state.nodes = [{ id: 'n1' }, { id: 'n2' }];
  state.edges = [{ source: 'n1', target: 'n2' }];
  state.shouldParallel = false;
  state.throwFingerprint = false;
  state.calls = [];
  vi.clearAllMocks();
});

describe('centrality hook', () => {
  it('does nothing when centrality is disabled or there are no nodes', async () => {
    await HOOK.afterIndexAll(ctx({ enableCentrality: false }));
    expect(state.calls).toEqual([]);

    state.nodes = [];
    await HOOK.afterSync(ctx());
    expect(state.calls).toEqual([]);
  });

  it('skips recompute when the stored fingerprint matches', async () => {
    state.metadata.set('last_centrality_fingerprint', 'algo:d=0.85|i=20|k=calls,references:2:1:123');

    await HOOK.afterIndexAll(ctx());

    expect(state.calls).toEqual([
      { name: 'logDebug', value: 'centrality hook: graph unchanged (fingerprint match), skipping recompute' },
    ]);
  });

  it('computes serial PageRank, clears stale scores, applies scores, and stamps the fingerprint', async () => {
    await HOOK.afterIndexAll(ctx());

    expect(state.calls.map((call) => call.name)).toEqual([
      'computePageRank',
      'clearCentrality',
      'applyCentralityScores',
      'setMetadata',
    ]);
    expect(state.metadata.get('last_centrality_fingerprint')).toBe('algo:d=0.85|i=20|k=calls,references:2:1:123');
  });

  it('uses the parallel PageRank path when the graph is large enough', async () => {
    state.shouldParallel = true;

    await HOOK.afterSync(ctx());

    expect(state.calls.map((call) => call.name)).toContain('computePageRankParallel');
    expect(state.calls.map((call) => call.name)).not.toContain('computePageRank');
  });

  it('logs and swallows fingerprint/query failures', async () => {
    state.throwFingerprint = true;

    await HOOK.afterIndexAll(ctx());

    expect(state.calls).toEqual([{ name: 'logDebug', value: 'centrality hook failed: db unavailable' }]);
  });
});
