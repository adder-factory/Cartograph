/**
 * Embedding pipeline + hybrid search + cross-language matching.
 *
 * Uses vi.spyOn on LlmClient.prototype and FakeEmbeddingProvider
 * instead of the openai-compat HTTP fake server (deleted 2026-05-15).
 * The FakeEmbeddingProvider returns deterministic vectors derived from
 * the input text so we can assert ordering by hand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSummaryCoverage } from '../src/db/queries-summaries.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { llmFindSimilar } from '../src/cartograph-llm-service.js';
import { searchNodes } from '../src/db/queries-search.js';
import {
  vectorToBytes,
  bytesToVector,
  cosineNormalised,
  reciprocalRankFusion,
  topKByCosine,
  topKByCosineMatrix,
  EmbeddingCache,
} from '../src/llm/embeddings.js';
import { LlmClient } from '../src/llm/client.js';
import * as embeddingClientModule from '../src/llm/embedding-client.js';
import { defaultChatHandler } from './helpers/fake-chat-client.js';
import { FakeEmbeddingProvider } from './helpers/fake-embedding-provider.js';

const EMBED_DIM = 8;

function l2(v: Float32Array): Float32Array {
  let s = 0;
  for (const value of v) s += value * value;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

describe('embedding helpers', () => {
  it('vectorToBytes round-trips through bytesToVector', () => {
    const v = l2(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const b = vectorToBytes(v);
    const v2 = bytesToVector(b);
    for (let i = 0; i < v.length; i++) {
      expect(v2[i]).toBeCloseTo(v[i]!, 6);
    }
  });

  it('cosineNormalised gives 1.0 for the same vector', () => {
    const v = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    expect(cosineNormalised(v, v)).toBeCloseTo(1, 6);
  });

  it('cosineNormalised gives 0 for orthogonal vectors', () => {
    const a = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const b = l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]));
    expect(cosineNormalised(a, b)).toBeCloseTo(0, 6);
  });

  it('topKByCosine returns the highest-scoring node ids', () => {
    const query = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const candidates = [
      { nodeId: 'a', embedding: vectorToBytes(l2(Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0]))) },
      { nodeId: 'b', embedding: vectorToBytes(l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]))) },
      { nodeId: 'c', embedding: vectorToBytes(l2(Float32Array.from([0.5, 0.5, 0, 0, 0, 0, 0, 0]))) },
    ];
    const hits = topKByCosine(query, candidates, 2);
    expect(hits.map((h) => h.nodeId)).toEqual(['a', 'c']);
  });

  it('RRF favors items appearing high in both rankings', () => {
    const fts = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const sem = [{ id: 'y' }, { id: 'z' }, { id: 'x' }];
    const fused = reciprocalRankFusion([fts, sem]);
    // y appears at rank 2 in fts (1/62) + rank 1 in sem (1/61) = highest
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(sorted[0]).toBe('y');
  });

  it('topKByCosineMatrix matches topKByCosine on the same data', () => {
    const query = l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const vecs = [
      { id: 'a', v: l2(Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0])) },
      { id: 'b', v: l2(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0])) },
      { id: 'c', v: l2(Float32Array.from([0.5, 0.5, 0, 0, 0, 0, 0, 0])) },
    ];
    const candidates = vecs.map((e) => ({ nodeId: e.id, embedding: vectorToBytes(e.v) }));
    const matrix = new Float32Array(vecs.length * EMBED_DIM);
    const ids = vecs.map((e) => e.id);
    for (let i = 0; i < vecs.length; i++) matrix.set(vecs[i]!.v, i * EMBED_DIM);

    const a = topKByCosine(query, candidates, 3).map((h) => h.nodeId);
    const b = topKByCosineMatrix({ query, matrix, ids, dim: EMBED_DIM, k: 3 }).map((h) => h.nodeId);
    expect(b).toEqual(a);
  });

  it('EmbeddingCache returns the same result on hit and miss; invalidate forces refetch', () => {
    let fetchCalls = 0;
    const v = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return [{ nodeId: 'a', embedding: v }];
      },
    };

    const cache = new EmbeddingCache();
    const r1 = cache.get(fetcher, 'm');
    const r2 = cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);
    expect(r1).toBe(r2);
    expect(r1.ids).toEqual(['a']);
    expect(r1.dim).toBe(EMBED_DIM);

    cache.invalidate();
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(2);

    // Switching models also forces a refetch.
    cache.get(fetcher, 'other-model');
    expect(fetchCalls).toBe(3);
  });

  it('EmbeddingCache skips rows whose dimension does not match the first row', () => {
    const v3 = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    // Different shape: 4-dim vector. Should be skipped.
    const v4 = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
    const fetcher = {
      getAllEmbeddings: (_model: string) => [
        { nodeId: 'good', embedding: v3 },
        { nodeId: 'bad', embedding: v4 },
        { nodeId: 'good2', embedding: v3 },
      ],
    };
    const cache = new EmbeddingCache();
    const r = cache.get(fetcher, 'm');
    expect(r.ids).toEqual(['good', 'good2']);
    expect(r.matrix.length).toBe(2 * EMBED_DIM);
    expect(r.dim).toBe(EMBED_DIM);
  });

  it('EmbeddingCache returns an empty result without calling the fetcher again on hit', () => {
    let fetchCalls = 0;
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return [];
      },
    };
    const cache = new EmbeddingCache();
    const r = cache.get(fetcher, 'm');
    expect(r.ids).toEqual([]);
    expect(r.dim).toBe(0);
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);
  });

  it('EmbeddingCache notices new rows via getEmbeddingsCount without explicit invalidate', () => {
    const v = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    const store: Array<{ nodeId: string; embedding: Buffer }> = [];
    let fetchCalls = 0;
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return store.slice();
      },
      getEmbeddingsCount: (_model: string) => store.length,
    };

    const cache = new EmbeddingCache();
    const r1 = cache.get(fetcher, 'm');
    expect(r1.ids).toEqual([]);
    expect(fetchCalls).toBe(1);

    // Hit while still empty — count unchanged, no refetch.
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);

    // Out-of-band write lands in the table.
    store.push({ nodeId: 'a', embedding: v });
    const r2 = cache.get(fetcher, 'm');
    expect(r2.ids).toEqual(['a']);
    expect(fetchCalls).toBe(2);

    // Hit again — count matches, no refetch.
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(2);
  });

  it('EmbeddingCache falls back to legacy hit-on-model-match when fetcher omits getEmbeddingsCount', () => {
    const v = vectorToBytes(l2(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])));
    let fetchCalls = 0;
    const fetcher = {
      getAllEmbeddings: (_model: string) => {
        fetchCalls++;
        return [{ nodeId: 'a', embedding: v }];
      },
    };
    const cache = new EmbeddingCache();
    cache.get(fetcher, 'm');
    cache.get(fetcher, 'm');
    expect(fetchCalls).toBe(1);
  });
});

describe('Cartograph hybrid search & similar', () => {
  let tempDir: string;
  let fakeEmbed: FakeEmbeddingProvider;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-emb-'));
    fakeEmbed = new FakeEmbeddingProvider();

    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
    vi.spyOn(embeddingClientModule, 'createEmbeddingClient').mockReturnValue(fakeEmbed);

    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      `export function authenticateUser(name: string): string {
  const token = 'secret';
  const claim = 'session';
  return name + token + claim;
}

export function lookupAccount(id: string): { id: string } {
  const cache = new Map<string, { id: string }>();
  cache.set(id, { id });
  return { id };
}

export class TokenStore {
  private bag: Map<string, string> = new Map();
  put(k: string, v: string): void { this.bag.set(k, v); }
  get(k: string): string | undefined { return this.bag.get(k); }
  size(): number { return this.bag.size; }
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'helper.py'),
      `def authenticate_user(name):
    token = 'secret'
    claim = 'session'
    return name + token + claim
`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('standalone summarizeAll() also embeds (tooling-gap #11 regression)', async () => {
    // Pre-fix bug: cg.llm.summarizeAll() only summarised, never embedded.
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      // No background pass, so nothing embedded yet.
      expect(fakeEmbed.embedCalls).toBe(0);

      const result = await cg.llm.summarizeAll();

      // Summaries fired AND embeddings fired in the same call.
      const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
      expect(chatSpy.mock.calls.length).toBeGreaterThan(0);
      expect(fakeEmbed.embedCalls).toBeGreaterThan(0);
      // The new embed result is reported on the return value.
      expect(result.embed).not.toBeNull();
      expect(result.embed!.generated).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('cg.llm.embed.embedAll() runs the embed-only path', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();
      const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
      const beforeChat = chatSpy.mock.calls.length;
      const beforeEmbed = fakeEmbed.embedCalls;

      const result = await cg.llm.embed.embedAll();

      // Idempotent — already embedded, so no new vectors.
      expect(result.generated).toBe(0);
      // No chat fire — pure embed path.
      expect(chatSpy.mock.calls.length).toBe(beforeChat);
      // Embed call count unchanged for the same reason (cache hit).
      expect(fakeEmbed.embedCalls).toBe(beforeEmbed);
    } finally {
      cg.close();
    }
  });

  it('searchHybrid falls back to FTS when no embedding model is configured', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll({ summarize: false });
      const results = await cg.llm.searchHybrid('authenticate', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // No embeddings in DB → no embed calls fired
      expect(fakeEmbed.embedCalls).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('background pass produces summaries AND embeddings end-to-end', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const cov = getSummaryCoverage(cg.queries);
      expect(cov.summarised).toBeGreaterThan(0);
      const chatSpy = LlmClient.prototype.chat as unknown as { mock: { calls: unknown[][] } };
      expect(chatSpy.mock.calls.length).toBeGreaterThan(0);
      expect(fakeEmbed.embedCalls).toBeGreaterThan(0);

      // Re-running summarize is a cache hit.
      const callsAfterFirst = chatSpy.mock.calls.length + fakeEmbed.embedCalls;
      await cg.llm.summarizeAll();
      // chat shouldn't fire again; embed pass not invoked here directly.
      expect(chatSpy.mock.calls.length + fakeEmbed.embedCalls).toBe(callsAfterFirst);
    } finally {
      cg.close();
    }
  });

  it('searchHybrid returns FTS+semantic blended results once embeddings exist', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const results = await cg.llm.searchHybrid('authenticateUser', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // Hybrid path embedded the query (one extra embed call beyond
      // the bulk-summary embeddings).
      expect(fakeEmbed.embedCalls).toBeGreaterThan(1);
    } finally {
      cg.close();
    }
  });

  it('searchHybrid diversifies the RRF-fused branch when same-name floods leak through', async () => {
    fs.mkdirSync(path.join(tempDir, 'codecs'), { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(tempDir, `codecs/codec${i}.ts`),
        `export function Encode(s: string): string { return s + '${i}'; }\n`,
      );
    }
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const ftsBaseline = searchNodes(cg.queries, 'Encode', { limit: 50 });
      const ftsEncodeCount = ftsBaseline.filter((r) => r.node.name === 'Encode').length;
      expect(ftsEncodeCount).toBeGreaterThanOrEqual(6);

      const results = await cg.llm.searchHybrid('Encode authenticate', { limit: 12 });
      expect(results.length).toBeGreaterThan(0);
      const counts = new Map<string, number>();
      for (const r of results) counts.set(r.node.name, (counts.get(r.node.name) ?? 0) + 1);
      const maxPerName = Math.max(...counts.values());
      expect(maxPerName).toBeLessThanOrEqual(3);
      const nonEncode = results.filter((r) => r.node.name !== 'Encode');
      expect(nonEncode.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('findSimilar returns related symbols and respects differentLanguage', async () => {
    const cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    try {
      await cg.indexAll();
      await cg.llm.bgCtrl.awaitCompletion();

      const ts = searchNodes(cg.queries, 'authenticateUser', { limit: 1 })[0];
      expect(ts).toBeDefined();

      const similar = await llmFindSimilar(cg.llm, ts!.node.id, { limit: 3 });
      // Should exclude the source itself
      expect(similar.find((r) => r.node.id === ts!.node.id)).toBeUndefined();

      // Cross-language filter should only return non-TS hits (or empty)
      const xLang = await llmFindSimilar(cg.llm, ts!.node.id, { limit: 3, differentLanguage: true });
      for (const r of xLang) {
        expect(r.node.language).not.toBe(ts!.node.language);
      }
    } finally {
      cg.close();
    }
  });
});
