import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as queriesEmbeddings from '../src/db/queries-embeddings.js';
import * as queriesSearch from '../src/db/queries-search.js';
import * as vecHelpers from '../src/db/vec-helpers.js';
import * as embeddingClient from '../src/llm/embedding-client.js';
import * as rerankerClient from '../src/llm/reranker-client.js';
import type { Node, SearchResult } from '../src/types.js';
import type { ResolvedLlm } from '../src/llm/provider.js';

const state = {
  ftsResults: [] as SearchResult[],
  embedVectors: [] as Float32Array[],
  embedReachable: true,
  vecHits: [] as Array<{ nodeId: string; distance: number }>,
  nodeEmbedding: null as Buffer | null,
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

vi.spyOn(queriesSearch, 'searchNodes').mockImplementation((() => state.ftsResults) as never);

vi.spyOn(embeddingClient, 'createEmbeddingClient').mockImplementation((() => ({
  isConfigured: true,
  isReachable: vi.fn(async () => state.embedReachable),
  reachabilityError: vi.fn(() => null),
  listModels: vi.fn(async () => []),
  embed: vi.fn(async () => state.embedVectors),
})) as never);

vi.spyOn(queriesEmbeddings, 'getEmbeddingForNode').mockImplementation((() => state.nodeEmbedding) as never);
vi.spyOn(vecHelpers, 'findSimilarViaVec').mockImplementation((() => state.vecHits) as never);
vi.spyOn(rerankerClient.RerankerClient.prototype, 'rerank').mockImplementation((async () => {
  if (state.rerankerThrows) throw state.rerankerThrows;
  return state.rerankerScores;
}) as never);

const { CartographLlmService, llmFindImplementations, llmFindSimilar } = await import(
  '../src/cartograph-llm-service.js'
);

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

function vectorBuffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
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
    state.embedReachable = true;
    state.vecHits = [];
    state.nodeEmbedding = null;
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

describe('CartographLlmService semantic helper functions', () => {
  beforeEach(() => {
    state.ftsResults = [];
    state.embedVectors = [];
    state.embedReachable = true;
    state.vecHits = [];
    state.nodeEmbedding = null;
    state.nodes.clear();
    state.rerankerRows = [];
    state.rerankerScores = [];
    state.rerankerThrows = null;
    vi.clearAllMocks();
  });

  it('finds implementations through embedding + vec lookup and applies language filtering', async () => {
    state.embedVectors = [new Float32Array([1, 0])];
    state.vecHits = [
      { nodeId: 'impl:ts', distance: 0.1 },
      { nodeId: 'impl:py', distance: 0.2 },
      { nodeId: 'impl:missing', distance: 0.3 },
    ];
    state.nodes.set('impl:ts', node('impl:ts', 'parseThing', 'src/parser.ts'));
    state.nodes.set('impl:py', {
      ...node('impl:py', 'parseThing', 'parser.py'),
      language: 'python',
    });
    const svc = service(resolved());

    const out = await llmFindImplementations(svc, 'parse thing', { limit: 2, languageFilter: 'typescript' });

    expect(out.map((r) => r.node.id)).toEqual(['impl:ts']);
    expect(out[0]!.score).toBeCloseTo(0.9);
  });

  it('returns an empty implementation list without embedding config, reachability, or query vector', async () => {
    await expect(llmFindImplementations(service(resolved({ embeddingLlm: undefined })), 'anything')).resolves.toEqual(
      [],
    );

    state.embedReachable = false;
    await expect(llmFindImplementations(service(resolved()), 'anything')).resolves.toEqual([]);

    state.embedReachable = true;
    state.embedVectors = [];
    await expect(llmFindImplementations(service(resolved()), 'anything')).resolves.toEqual([]);
  });

  it('finds similar symbols from a source node embedding and filters by language relationship', async () => {
    state.nodeEmbedding = vectorBuffer([1, 0]);
    state.vecHits = [
      { nodeId: 'source', distance: 0.01 },
      { nodeId: 'same-lang', distance: 0.2 },
      { nodeId: 'other-lang', distance: 0.3 },
      { nodeId: 'missing', distance: 0.4 },
    ];
    state.nodes.set('source', node('source', 'sourceNode', 'src/source.ts'));
    state.nodes.set('same-lang', node('same-lang', 'sameLanguage', 'src/same.ts'));
    state.nodes.set('other-lang', {
      ...node('other-lang', 'otherLanguage', 'src/other.py'),
      language: 'python',
    });
    const svc = service(resolved());

    const sameLanguage = await llmFindSimilar(svc, 'source', { sameLanguage: true, limit: 5 });
    const differentLanguage = await llmFindSimilar(svc, 'source', { differentLanguage: true, limit: 5 });

    expect(sameLanguage.map((r) => r.node.id)).toEqual(['same-lang']);
    expect(differentLanguage.map((r) => r.node.id)).toEqual(['other-lang']);
    expect(differentLanguage[0]!.score).toBeCloseTo(0.7);
  });

  it('returns an empty similar list when prerequisites are missing', async () => {
    const svc = service(resolved());

    await expect(llmFindSimilar(service(resolved({ embeddingLlm: undefined })), 'source')).resolves.toEqual([]);
    await expect(llmFindSimilar(svc, 'missing-node')).resolves.toEqual([]);

    state.nodes.set('source', node('source', 'sourceNode', 'src/source.ts'));
    state.nodeEmbedding = null;
    await expect(llmFindSimilar(svc, 'source')).resolves.toEqual([]);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
