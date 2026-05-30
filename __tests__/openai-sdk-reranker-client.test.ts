/**
 * `OpenAiSdkRerankerClient` — HTTP reranker via the Cohere-compatible
 * `POST /v1/rerank` shape. Tests run against a localhost Bun.serve
 * mock (the same surface llama-server `--rerank` + Cohere + Jina +
 * Voyage all implement).
 *
 * Validates:
 *   - construction validation (endpoint / apiKey requirement, model,
 *     provider check)
 *   - rerank() empty short-circuit + aborted-signal handling
 *   - request body shape (model + query + documents array)
 *   - response re-ordering (backend returns sorted; client returns
 *     input-order)
 *   - upstream-status error wrapping with status code
 *   - non-Cohere response shapes rejected
 *   - apiKey forwarded as Bearer header
 *   - isReachable success + failure paths
 */

import { describe, it, expect, afterEach } from 'vitest';
import { OpenAiSdkRerankerClient } from '../src/llm/openai-sdk-reranker-client.js';
import { LlmEndpointError } from '../src/llm/client.js';
import type { RerankerProviderConfig } from '../src/llm/reranker-client.js';

interface MockServer {
  url: string;
  receivedRequests: Array<{ path: string; method: string; body: unknown; authHeader?: string }>;
  stop(): void;
}

function startMockServer(handler: (req: Request) => Response | Promise<Response>): MockServer {
  const receivedRequests: MockServer['receivedRequests'] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      let body: unknown = null;
      if (req.method === 'POST') {
        try {
          body = await req.clone().json();
        } catch {
          body = await req.clone().text();
        }
      }
      receivedRequests.push({
        path: url.pathname,
        method: req.method,
        body,
        authHeader: req.headers.get('authorization') ?? undefined,
      });
      return handler(req);
    },
  });
  return { url: `http://localhost:${server.port}`, receivedRequests, stop: () => server.stop() };
}

/** Cohere-compat response shape — `results` typically sorted by
 *  score descending, with explicit `index` referring back to the
 *  request's `documents` array. */
function rerankResp(scoresInInputOrder: number[], sortDescending = true): Response {
  const entries = scoresInInputOrder.map((relevance_score, index) => ({ index, relevance_score }));
  if (sortDescending) entries.sort((a, b) => b.relevance_score - a.relevance_score);
  return Response.json({ model: 'test-model', results: entries });
}

function baseCfg(url: string): RerankerProviderConfig {
  return { provider: 'openai-compat', model: 'test-model', endpoint: url };
}

describe('OpenAiSdkRerankerClient', () => {
  let server: MockServer | null = null;
  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it('rejects non-openai-compat provider in constructor', () => {
    // Intentionally-bad input: `'local'` is a removed provider value
    // (deleted 2026-05-24c step 4c). The type assertion is necessary
    // because `RerankerProviderConfig.provider` is now the literal
    // type `'openai-compat'` — stock tsc would flag the bare `'local'`
    // as a type error; the cast preserves the runtime-rejection test
    // intent through any future strictness regression.
    expect(
      () =>
        new OpenAiSdkRerankerClient({
          provider: 'local',
          model: '/x.gguf',
        } as unknown as RerankerProviderConfig),
    ).toThrow(LlmEndpointError);
  });

  it('rejects construction without endpoint AND without apiKey', () => {
    expect(() => new OpenAiSdkRerankerClient({ provider: 'openai-compat', model: 'm' })).toThrow(LlmEndpointError);
  });

  it('rejects construction without a model', () => {
    expect(
      () => new OpenAiSdkRerankerClient({ provider: 'openai-compat', endpoint: 'http://localhost:1', model: '' }),
    ).toThrow(LlmEndpointError);
  });

  it('accepts apiKey-only configs (cloud Cohere/Jina shape) without endpoint', () => {
    expect(
      () => new OpenAiSdkRerankerClient({ provider: 'openai-compat', model: 'rerank-english-v3.0', apiKey: 'co-test' }),
    ).not.toThrow();
  });

  it('returns empty array when candidates is empty (no HTTP call)', async () => {
    const client = new OpenAiSdkRerankerClient(baseCfg('http://localhost:1'));
    const out = await client.rerank('q', []);
    expect(out).toEqual([]);
  });

  it('rejects when signal already aborted at entry', async () => {
    const client = new OpenAiSdkRerankerClient(baseCfg('http://localhost:1'));
    const ac = new AbortController();
    ac.abort();
    await expect(client.rerank('q', ['a'], { signal: ac.signal })).rejects.toThrow(/aborted/);
  });

  it('sends Cohere-shape request body to /v1/rerank', async () => {
    server = startMockServer(() => rerankResp([0.9, 0.5]));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    await client.rerank('how do I X?', ['doc-a', 'doc-b']);
    const sent = server.receivedRequests.find((r) => r.path === '/v1/rerank');
    expect(sent).toBeDefined();
    expect(sent!.method).toBe('POST');
    const body = sent!.body as { model: string; query: string; documents: string[] };
    expect(body.model).toBe('test-model');
    expect(body.query).toBe('how do I X?');
    expect(body.documents).toEqual(['doc-a', 'doc-b']);
  });

  it('returns scores in INPUT order even when backend sorts descending', async () => {
    // doc-a has score 0.2, doc-b has 0.9. Backend sorts; client re-orders.
    server = startMockServer(() => rerankResp([0.2, 0.9])); // input order [0.2, 0.9]
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    const scores = await client.rerank('q', ['doc-a', 'doc-b']);
    expect(scores).toEqual([0.2, 0.9]);
  });

  it('fills missing indices with 0 (e.g. backend skipped some)', async () => {
    server = startMockServer(() =>
      Response.json({
        model: 'test-model',
        results: [{ index: 1, relevance_score: 0.7 }], // only doc 1 returned
      }),
    );
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    const scores = await client.rerank('q', ['doc-a', 'doc-b']);
    expect(scores).toEqual([0, 0.7]);
  });

  it('wraps upstream 4xx into LlmEndpointError carrying status', async () => {
    server = startMockServer(() => new Response('bad request', { status: 400 }));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    try {
      await client.rerank('q', ['a']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmEndpointError);
      expect((err as LlmEndpointError).status).toBe(400);
    }
  });

  it('wraps upstream 5xx into LlmEndpointError carrying status', async () => {
    server = startMockServer(() => new Response('server boom', { status: 503 }));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    try {
      await client.rerank('q', ['a']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmEndpointError);
      expect((err as LlmEndpointError).status).toBe(503);
    }
  });

  it('rejects backend body without a `results` array', async () => {
    server = startMockServer(() => Response.json({ error: 'no rerank model loaded' }));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    await expect(client.rerank('q', ['a'])).rejects.toThrow(/Cohere-compatible/);
  });

  it('sends Bearer apiKey when configured', async () => {
    server = startMockServer(() => rerankResp([0.5]));
    const client = new OpenAiSdkRerankerClient({
      provider: 'openai-compat',
      endpoint: server.url,
      model: 'm',
      apiKey: 'co-realkey',
    });
    await client.rerank('q', ['a']);
    expect(server.receivedRequests[0]?.authHeader).toBe('Bearer co-realkey');
  });

  it('omits Authorization header for local-backend configs (no apiKey)', async () => {
    server = startMockServer(() => rerankResp([0.5]));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    await client.rerank('q', ['a']);
    expect(server.receivedRequests[0]?.authHeader).toBeUndefined();
  });

  it('isReachable returns true on successful /v1/rerank probe', async () => {
    server = startMockServer(() => rerankResp([0.5]));
    const client = new OpenAiSdkRerankerClient(baseCfg(server.url));
    expect(await client.isReachable()).toBe(true);
    expect(client.reachabilityError()).toBeNull();
  });

  it('isReachable returns false + populates reachabilityError on failure', async () => {
    const client = new OpenAiSdkRerankerClient({
      provider: 'openai-compat',
      endpoint: 'http://localhost:1', // unbound
      model: 'm',
    });
    expect(await client.isReachable()).toBe(false);
    expect(client.reachabilityError()).toMatch(/not reachable/);
  });

  it('normalises trailing `/v1` from endpoint (does not double-append)', async () => {
    server = startMockServer(() => rerankResp([0.5]));
    const client = new OpenAiSdkRerankerClient({
      provider: 'openai-compat',
      endpoint: `${server.url}/v1`,
      model: 'm',
    });
    await client.rerank('q', ['a']);
    const paths = server.receivedRequests.map((r) => r.path);
    expect(paths).toContain('/v1/rerank');
    expect(paths.find((p) => p === '/v1/v1/rerank')).toBeUndefined();
  });
});
