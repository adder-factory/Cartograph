import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, SearchResult } from '../src/types.js';
import type { ResolvedLlm } from '../src/llm/provider.js';

const state = {
  ftsResults: [] as SearchResult[],
  embedVectors: [] as Float32Array[],
  vecHits: [] as Array<{ nodeId: string; distance: number }>,
  nodes: new Map<string, Node>(),
  rerankerRows: [] as Array<{
    id: string;
    name: string;
    signature: string | null;
    docstring: string | null;
    summary: string | null;
  }>,
  rerankerScores: [] as number[],
  rerankerThrows: null as Error | null,
};

vi.mock('../src/db/queries-search.js', () => ({
  searchNodes: vi.fn(() => state.ftsResults),
}));

vi.mock('../src/llm/embedding-client.js', () => ({
  createEmbeddingClient: vi.fn(() => ({
    isConfigured: true,
    isReachable: vi.fn(async () => true),
    reachabilityError: vi.fn(() => null),
    listModels: vi.fn(async () => []),
    embed: vi.fn(async () => state.embedVectors),
  })),
}));

vi.mock('../src/db/vec-helpers.js', () => ({
  vecTableNameForDim: (dim: number) => `vec_symbols_${dim}`,
  vecChunkTableNameForDim: (dim: number) => `vec_chunks_${dim}`,
  bootstrapVecTables: vi.fn(),
  ensureChunkVecTable: vi.fn(),
  ensureVecTable: vi.fn(),
  mirrorEmbeddingToVec: vi.fn(),
  mirrorChunkEmbeddingToVec: vi.fn(),
  clearVecTables: vi.fn(),
  compactVecTables: vi.fn(),
  findSimilarViaVec: vi.fn(() => state.vecHits),
}));

vi.mock('../src/llm/reranker-client.js', () => ({
  RerankerClient: class {
    async rerank(): Promise<number[]> {
      if (state.rerankerThrows) throw state.rerankerThrows;
      return state.rerankerScores;
    }
  },
}));

const { CartographLlmService } = await import('../src/cartograph-llm-service.js');

function node(id: string, name: string, filePath = `${id}.ts`): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
  };
}

function result(id: string, name: string, filePath?: string, score = 1): SearchResult {
  const n = node(id, name, filePath);
  state.nodes.set(id, n);
  return { node: n, score };
}

function resolved(overrides: Partial<ResolvedLlm> = {}): ResolvedLlm {
  return {
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint: 'http://localhost:8080',
      model: 'embed-model',
    },
    resolutionTrace: 'test',
    ...overrides,
  } as ResolvedLlm;
}

function service(config: ResolvedLlm | null): CartographLlmService {
  const db = {
    hasVecExtension: () => true,
    getDb: () => ({
      prepare(sql: string) {
        return {
          get() {
            if (sql.includes('FROM hnsw_meta')) throw new Error('no such table: hnsw_meta');
            return undefined;
          },
          all() {
            if (sql.includes('FROM nodes n')) return state.rerankerRows;
            return [];
          },
        };
      },
    }),
  };
  const svc = new CartographLlmService({
    config: { llm: {} },
    projectRoot: '/tmp/cartograph-llm-service-search',
    db,
    queries: {
      getNodeById: (id: string) => state.nodes.get(id) ?? null,
    },
  } as never);
  vi.spyOn(svc.config, 'resolveLlmConfig').mockResolvedValue(config);
  return svc;
}

describe('CartographLlmService searchHybridWithOutcome', () => {
  beforeEach(() => {
    state.ftsResults = [];
    state.embedVectors = [];
    state.vecHits = [];
    state.nodes.clear();
    state.rerankerRows = [];
    state.rerankerScores = [];
    state.rerankerThrows = null;
    vi.clearAllMocks();
  });

  it('falls back to diversified FTS results when no embedding config resolves', async () => {
    state.ftsResults = [
      result('a1', 'same'),
      result('a2', 'same'),
      result('a3', 'same'),
      result('a4', 'same'),
      result('b1', 'other'),
    ];
    const svc = service(resolved({ embeddingLlm: undefined }));

    const out = await svc.searchHybridWithOutcome('same', { limit: 10 });

    expect(out.rerankOutcome).toEqual({ kind: 'skipped-no-config' });
    expect(out.results.map((r) => r.node.id)).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('returns FTS with the reranker no-hit outcome when query embedding returns no vector', async () => {
    state.ftsResults = [result('fts:1', 'fetchUser')];
    state.embedVectors = [];
    const svc = service(
      resolved({
        rerankerLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8083',
          model: 'rerank-model',
        },
      }),
    );

    const out = await svc.searchHybridWithOutcome('fetch user', { limit: 5 });

    expect(out.rerankOutcome).toEqual({ kind: 'skipped-no-hits' });
    expect(out.results.map((r) => r.node.id)).toEqual(['fts:1']);
  });

  it('fuses FTS and semantic vec hits and fetches semantic-only nodes by id', async () => {
    state.ftsResults = [result('fts:1', 'lexicalHit')];
    state.embedVectors = [new Float32Array([1, 0])];
    state.vecHits = [{ nodeId: 'sem:1', distance: 0.1 }];
    state.nodes.set('sem:1', node('sem:1', 'semanticHit'));
    const svc = service(resolved());

    const out = await svc.searchHybridWithOutcome('semantic hit', { limit: 5 });

    expect(out.rerankOutcome).toEqual({ kind: 'skipped-no-config' });
    expect(out.results.map((r) => r.node.id)).toEqual(['fts:1', 'sem:1']);
  });

  it('skips reranking when semantic hits have no candidate text', async () => {
    state.embedVectors = [new Float32Array([1, 0])];
    state.vecHits = [{ nodeId: 'empty:1', distance: 0.1 }];
    state.nodes.set('empty:1', node('empty:1', 'fallbackNode'));
    state.rerankerRows = [{ id: 'empty:1', name: '', signature: null, docstring: null, summary: null }];
    const svc = service(
      resolved({
        rerankerLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8083',
          model: 'rerank-model',
        },
      }),
    );

    const out = await svc.searchHybridWithOutcome('anything', { limit: 5 });

    expect(out.rerankOutcome).toEqual({ kind: 'skipped-no-text' });
    expect(out.results.map((r) => r.node.id)).toEqual(['empty:1']);
  });

  it('reports fired reranking and preserves the reranked semantic order', async () => {
    state.embedVectors = [new Float32Array([1, 0])];
    state.vecHits = [
      { nodeId: 'sem:a', distance: 0.1 },
      { nodeId: 'sem:b', distance: 0.2 },
    ];
    state.nodes.set('sem:a', node('sem:a', 'alpha'));
    state.nodes.set('sem:b', node('sem:b', 'beta'));
    state.rerankerRows = [
      { id: 'sem:a', name: 'alpha', signature: null, docstring: null, summary: null },
      { id: 'sem:b', name: 'beta', signature: null, docstring: null, summary: null },
    ];
    state.rerankerScores = [0.2, 0.95];
    const svc = service(
      resolved({
        rerankerLlm: {
          provider: 'openai-compat',
          endpoint: 'http://localhost:8083',
          model: 'rerank-model',
        },
      }),
    );

    const out = await svc.searchHybridWithOutcome('rank it', { limit: 5 });

    expect(out.rerankOutcome.kind).toBe('fired');
    expect(out.results.map((r) => r.node.id)).toEqual(['sem:b', 'sem:a']);
  });
});
