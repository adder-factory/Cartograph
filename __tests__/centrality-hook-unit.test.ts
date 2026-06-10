import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as centrality from '../src/centrality/index.js';
import * as pagerankParallel from '../src/centrality/pagerank-parallel.js';
import * as nodeQueries from '../src/db/queries.js';
import * as centralityQueries from '../src/db/queries-centrality.js';
import * as metadataQueries from '../src/db/queries-metadata.js';
import * as errorModule from '../src/errors.js';
import type { IndexHookContext } from '../src/index-hooks/registry.js';

const state = {
  metadata: new Map<string, string>(),
  nodes: [] as Array<{ id: string }>,
  edges: [] as Array<{ source: string; target: string }>,
  shouldParallel: false,
  throwFingerprint: false,
  calls: [] as Array<{ name: string; value?: unknown }>,
};

vi.spyOn(centrality, 'computePageRank').mockImplementation(((_nodes: unknown[], _edges: unknown[]) => {
  state.calls.push({ name: 'computePageRank' });
  return { scores: new Map([['n1', 0.5]]) };
}) as never);

vi.spyOn(pagerankParallel, 'shouldUseParallel').mockImplementation((() => state.shouldParallel) as never);
vi.spyOn(pagerankParallel, 'computePageRankParallel').mockImplementation((async () => {
  state.calls.push({ name: 'computePageRankParallel' });
  return { scores: new Map([['n1', 0.75]]) };
}) as never);

vi.spyOn(nodeQueries, 'getAllNodeIds').mockImplementation((() => state.nodes) as never);

vi.spyOn(centralityQueries, 'reapplyCentralityScores').mockImplementation(((_queries: unknown, scores: unknown) =>
  state.calls.push({ name: 'reapplyCentralityScores', value: scores })) as never);

vi.spyOn(metadataQueries, 'getMetadata').mockImplementation(
  ((_queries: unknown, key: string) => state.metadata.get(key) ?? null) as never,
);
vi.spyOn(metadataQueries, 'setMetadata').mockImplementation(((_queries: unknown, key: string, value: string) => {
  state.calls.push({ name: 'setMetadata', value: { key, value } });
  state.metadata.set(key, value);
}) as never);

vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) =>
  state.calls.push({ name: 'logDebug', value: message })) as never);
vi.spyOn(errorModule, 'logWarn').mockImplementation(((message: string) =>
  state.calls.push({ name: 'logWarn', value: message })) as never);

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

afterAll(() => {
  vi.restoreAllMocks();
});

function expectedFingerprint(nodeCount = 2, edgeCount = 1, maxUpdated = 123): string {
  const kinds = [...centrality.PR_EDGE_KINDS].sort((a, b) => Number(a > b) - Number(a < b)).join(',');
  return `algo:d=${centrality.PR_DAMPING}|i=${centrality.PR_ITERATIONS}|k=${kinds}:${nodeCount}:${edgeCount}:${maxUpdated}`;
}

describe('centrality hook', () => {
  it('does nothing when centrality is disabled or there are no nodes', async () => {
    await HOOK.afterIndexAll(ctx({ enableCentrality: false }));
    expect(state.calls).toEqual([]);

    state.nodes = [];
    await HOOK.afterSync(ctx());
    expect(state.calls).toEqual([]);
  });

  it('skips recompute when the stored fingerprint matches', async () => {
    state.metadata.set('last_centrality_fingerprint', expectedFingerprint());

    await HOOK.afterIndexAll(ctx());

    expect(state.calls).toEqual([
      { name: 'logDebug', value: 'centrality hook: graph unchanged (fingerprint match), skipping recompute' },
    ]);
  });

  it('computes serial PageRank, atomically reapplies scores, and stamps the fingerprint', async () => {
    await HOOK.afterIndexAll(ctx());

    expect(state.calls.map((call) => call.name)).toEqual(['computePageRank', 'reapplyCentralityScores', 'setMetadata']);
    expect(state.metadata.get('last_centrality_fingerprint')).toBe(expectedFingerprint());
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

    expect(state.calls).toEqual([{ name: 'logWarn', value: 'centrality hook failed: db unavailable' }]);
  });
});
