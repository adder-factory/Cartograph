/**
 * `OpenAiSdkEmbeddingClient` — HTTP embedding via the official `openai`
 * SDK with `baseURL` override. Tests run against a localhost Bun.serve
 * that mimics OpenAI's `/v1/embeddings` + `/v1/models` shapes (the same
 * surface llama-server, Ollama, mlx_lm, LM Studio, vLLM all implement).
 *
 * Validates the public API the rest of cartograph calls into:
 *   - construction (endpoint / apiKey requirement)
 *   - embed() empty short-circuit, batching, transfer integrity
 *   - error surfacing with upstream status codes
 *   - reachability probe
 *   - listModels() with /v1/models + fallback
 *   - abort signal handling
 */

import { describe, it, expect, afterEach } from 'vitest';
import { OpenAiSdkEmbeddingClient } from '../src/llm/openai-sdk-embedding-client.js';
import { LlmEndpointError } from '../src/llm/client.js';

interface MockServer {
  url: string;
  receivedRequests: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }>;
  stop(): void;
}

/** Spin up a localhost HTTP server that records every request and
 *  replies per the test's handler. Returns the server URL + the
 *  request log. Uses Bun.serve (the project's runtime). */
function startMockServer(handler: (req: Request) => Response | Promise<Response>): MockServer {
  const receivedRequests: MockServer['receivedRequests'] = [];
  const server = Bun.serve({
    port: 0, // OS-assigned
    async fetch(req: Request) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      let body: unknown = null;
      if (req.method === 'POST') {
        try {
          body = await req.clone().json();
        } catch {
          body = await req.clone().text();
        }
      }
      receivedRequests.push({ path: url.pathname, method: req.method, body, headers });
      return handler(req);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    receivedRequests,
    stop: () => server.stop(),
  };
}

/** Helper — build a /v1/embeddings reply in OpenAI shape. */
function embedResp(vectors: number[][]): Response {
  return Response.json({
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', embedding, index })),
    model: 'test-model',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
}

describe('OpenAiSdkEmbeddingClient', () => {
  let server: MockServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it('rejects construction without endpoint AND without apiKey', () => {
    expect(() => new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm' })).toThrow(LlmEndpointError);
  });

  it('accepts construction with only an apiKey (cloud OpenAI usage)', () => {
    // No endpoint → SDK defaults to api.openai.com. Just verifying
    // the constructor doesn't throw — we don't make any real calls.
    expect(
      () =>
        new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'text-embedding-3-small', apiKey: 'sk-x' }),
    ).not.toThrow();
  });

  it('accepts construction with only an endpoint (local backend, no auth)', () => {
    expect(
      () => new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: 'http://localhost:8080' }),
    ).not.toThrow();
  });

  it('isConfigured=false when model is empty', () => {
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: '',
      endpoint: 'http://localhost:8080',
    });
    expect(c.isConfigured).toBe(false);
  });

  it('embed([]) short-circuits to [] without hitting the network', async () => {
    server = startMockServer(() => new Response('SHOULD NOT BE CALLED', { status: 500 }));
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    expect(await c.embed([])).toEqual([]);
    expect(server.receivedRequests).toHaveLength(0);
  });

  it('embeds N inputs in one POST /v1/embeddings call when N fits in one batch', async () => {
    server = startMockServer((_req) =>
      embedResp([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]),
    );
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'nomic-embed-text',
      endpoint: server.url,
    });
    const out = await c.embed(['hello', 'world']);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0]!)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)));
    expect(Array.from(out[1]!)).toEqual([0.4, 0.5, 0.6].map((n) => Math.fround(n)));
    // One HTTP request, batched payload, the SDK posts to /v1/embeddings.
    expect(server.receivedRequests).toHaveLength(1);
    expect(server.receivedRequests[0]!.path).toBe('/v1/embeddings');
    expect(server.receivedRequests[0]!.method).toBe('POST');
    const reqBody = server.receivedRequests[0]!.body as { model: string; input: string[] };
    expect(reqBody.model).toBe('nomic-embed-text');
    expect(reqBody.input).toEqual(['hello', 'world']);
  });

  it('appends /v1 when endpoint omits it', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: server.url, // no /v1 suffix
    });
    await c.embed(['x']);
    expect(server.receivedRequests[0]!.path).toBe('/v1/embeddings');
  });

  it('does NOT double-append /v1 when endpoint already ends in /v1', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: `${server.url}/v1`,
    });
    await c.embed(['x']);
    expect(server.receivedRequests[0]!.path).toBe('/v1/embeddings'); // not /v1/v1/embeddings
  });

  it('trims trailing slash from endpoint', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: `${server.url}/`,
    });
    await c.embed(['x']);
    expect(server.receivedRequests[0]!.path).toBe('/v1/embeddings');
  });

  it('sends Bearer auth header when apiKey is configured', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: server.url,
      apiKey: 'sk-test-secret',
    });
    await c.embed(['x']);
    expect(server.receivedRequests[0]!.headers['authorization']).toBe('Bearer sk-test-secret');
  });

  it('still sends a Bearer header with a sentinel value when apiKey is unset (SDK requires SOME value)', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: server.url,
    });
    await c.embed(['x']);
    // The SDK won't let us call without ANY apiKey, so we set a
    // sentinel. Local backends ignore it; this just documents the
    // contract.
    expect(server.receivedRequests[0]!.headers['authorization']).toBe('Bearer unused-local-backend');
  });

  it('wraps non-2xx into LlmEndpointError with status code', async () => {
    server = startMockServer(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error' } }), { status: 429 }),
    );
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    await expect(c.embed(['x'])).rejects.toThrow(LlmEndpointError);
    await expect(c.embed(['x'])).rejects.toMatchObject({ status: 429 });
  });

  it('throws when response length mismatches input length (server contract violation)', async () => {
    server = startMockServer(
      () => embedResp([[0.1]]), // 1 vector for 2 inputs
    );
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    await expect(c.embed(['a', 'b'])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it('isReachable() returns true on /v1/models success', async () => {
    server = startMockServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'm', object: 'model' }] });
      }
      return new Response('not found', { status: 404 });
    });
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    expect(await c.isReachable()).toBe(true);
    expect(c.reachabilityError()).toBeNull();
  });

  it('isReachable() returns false when endpoint is unreachable', async () => {
    // No server running on this port.
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: 'm',
      endpoint: 'http://localhost:1',
      timeoutMs: 500,
    });
    expect(await c.isReachable()).toBe(false);
    expect(c.reachabilityError()).toBeTruthy();
  });

  it('isReachable() returns false when model is empty (matches null-stub semantics)', async () => {
    const c = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      model: '',
      endpoint: 'http://localhost:8080',
    });
    expect(await c.isReachable()).toBe(false);
    expect(c.reachabilityError()).toMatch(/not configured/);
  });

  it('listModels() returns the /v1/models ids when available', async () => {
    server = startMockServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [
            { id: 'model-a', object: 'model' },
            { id: 'model-b', object: 'model' },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'model-a', endpoint: server.url });
    const models = await c.listModels();
    expect(models).toContain('model-a');
    expect(models).toContain('model-b');
  });

  it('listModels() falls back to the configured model when /v1/models 404s', async () => {
    server = startMockServer(() => new Response('not implemented', { status: 404 }));
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'my-only-model', endpoint: server.url });
    expect(await c.listModels()).toEqual(['my-only-model']);
  });

  it('truncates inputs longer than MAX_INPUT_CHARS before sending', async () => {
    server = startMockServer(() => embedResp([[0]]));
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    const huge = 'x'.repeat(20_000);
    await c.embed([huge]);
    const body = server.receivedRequests[0]!.body as { input: string[] };
    expect(body.input[0]!.length).toBeLessThanOrEqual(8000);
  });

  it('preserves input order across HTTP batches when N > HTTP_BATCH_SIZE', async () => {
    // Server returns each input echoed as a one-element vector whose value is the input parsed as a number.
    server = startMockServer(async (req) => {
      const body = (await req.json()) as { input: string[] };
      return embedResp(body.input.map((s) => [Number.parseFloat(s)]));
    });
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    // 100 items → 2 batches of 64 + 36 with HTTP_BATCH_SIZE=64.
    const inputs = Array.from({ length: 100 }, (_, i) => String(i));
    const out = await c.embed(inputs);
    expect(out).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(out[i]![0]).toBe(i);
    }
    expect(server.receivedRequests).toHaveLength(2);
    expect((server.receivedRequests[0]!.body as { input: string[] }).input.length).toBe(64);
    expect((server.receivedRequests[1]!.body as { input: string[] }).input.length).toBe(36);
  });

  it('rejects pre-aborted signal without making a request', async () => {
    server = startMockServer(() => new Response('SHOULD NOT BE CALLED', { status: 500 }));
    const c = new OpenAiSdkEmbeddingClient({ provider: 'openai-compat', model: 'm', endpoint: server.url });
    const controller = new AbortController();
    controller.abort();
    await expect(c.embed(['x'], { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(server.receivedRequests).toHaveLength(0);
  });
});
