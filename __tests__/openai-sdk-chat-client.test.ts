/**
 * `OpenAiSdkChatBackend` — HTTP chat via the official `openai` SDK
 * with `baseURL` override. Tests run against a localhost Bun.serve
 * that mimics OpenAI's `/v1/chat/completions` + `/v1/models` shapes
 * (the same surface llama-server, Ollama, mlx_lm, LM Studio, vLLM
 * all implement).
 *
 * Validates the public API the rest of cartograph calls into:
 *   - construction (endpoint / apiKey requirement, model requirement)
 *   - chat() empty-messages rejection
 *   - message-shape mapping (system / user / assistant)
 *   - temperature, maxTokens, responseSchema forwarding
 *   - usage / duration metadata
 *   - upstream-status-code error wrapping
 *   - abort signal handling
 *   - reachability probe success + failure paths
 */

import { describe, it, expect, afterEach } from 'vitest';
import { OpenAiSdkChatBackend } from '../src/llm/openai-sdk-chat-client.js';
import { LlmEndpointError, type ChatProviderConfig } from '../src/llm/client.js';

interface MockServer {
  url: string;
  receivedRequests: Array<{ path: string; method: string; body: unknown }>;
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
      receivedRequests.push({ path: url.pathname, method: req.method, body });
      return handler(req);
    },
  });
  return { url: `http://localhost:${server.port}`, receivedRequests, stop: () => server.stop() };
}

/** Build a /v1/chat/completions reply in OpenAI shape. */
function chatResp(text: string, opts: { promptTokens?: number; completionTokens?: number } = {}): Response {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Date.now() / 1000,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: opts.promptTokens ?? 10,
      completion_tokens: opts.completionTokens ?? 5,
      total_tokens: (opts.promptTokens ?? 10) + (opts.completionTokens ?? 5),
    },
  });
}

function baseCfg(url: string): ChatProviderConfig {
  return { provider: 'openai-compat', model: 'test-model', endpoint: url };
}

describe('OpenAiSdkChatBackend', () => {
  let server: MockServer | null = null;
  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it('rejects construction without endpoint AND without apiKey', () => {
    expect(() => new OpenAiSdkChatBackend({ provider: 'openai-compat', model: 'm' })).toThrow(LlmEndpointError);
  });

  it('rejects construction without a model', () => {
    expect(
      () => new OpenAiSdkChatBackend({ provider: 'openai-compat', endpoint: 'http://localhost:8080', model: '' }),
    ).toThrow(LlmEndpointError);
  });

  it('accepts apiKey-only configs (cloud OpenAI shape) without endpoint', () => {
    expect(
      () => new OpenAiSdkChatBackend({ provider: 'openai-compat', model: 'gpt-4', apiKey: 'sk-test' }),
    ).not.toThrow();
  });

  it('rejects empty messages array', async () => {
    const client = new OpenAiSdkChatBackend({
      provider: 'openai-compat',
      endpoint: 'http://localhost:1',
      model: 'm',
    });
    await expect(client.chat([])).rejects.toThrow(LlmEndpointError);
  });

  it('rejects when signal already aborted at entry', async () => {
    const client = new OpenAiSdkChatBackend({
      provider: 'openai-compat',
      endpoint: 'http://localhost:1',
      model: 'm',
    });
    const ac = new AbortController();
    ac.abort();
    await expect(client.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })).rejects.toThrow(/aborted/);
  });

  it('round-trips system + user messages and returns assistant content + duration + tokens', async () => {
    server = startMockServer(() => chatResp('hello back', { promptTokens: 7, completionTokens: 2 }));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    const res = await client.chat([
      { role: 'system', content: 'You are cartograph.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(res.text).toBe('hello back');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.promptTokens).toBe(7);
    expect(res.completionTokens).toBe(2);
    const sent = server.receivedRequests.find((r) => r.path === '/v1/chat/completions');
    expect(sent).toBeDefined();
    const body = sent!.body as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are cartograph.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('degrades non-string content (structured parts) to an empty string', async () => {
    // Some compat backends return `content` as an array of content parts
    // rather than a plain string. The old `content ?? ''` only caught
    // null/undefined and would have leaked the array into the `string`
    // field; the schema coerces any non-string to '' so the caller sees
    // an empty (retryable) response instead of a type-confused payload.
    server = startMockServer(() =>
      Response.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    const res = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(res.text).toBe('');
  });

  it('forwards temperature + max_tokens when set', async () => {
    server = startMockServer(() => chatResp('ok'));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 100 });
    const body = server.receivedRequests[0]?.body as { temperature?: number; max_tokens?: number };
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(100);
  });

  it('OMITS temperature + max_tokens when unset (lets backend pick defaults)', async () => {
    server = startMockServer(() => chatResp('ok'));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    await client.chat([{ role: 'user', content: 'hi' }]);
    const body = server.receivedRequests[0]?.body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
  });

  it('maps responseSchema to response_format with json_schema + strict', async () => {
    server = startMockServer(() => chatResp('{"name":"x"}'));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    await client.chat([{ role: 'user', content: 'hi' }], { responseSchema: schema });
    const body = server.receivedRequests[0]?.body as {
      response_format?: { type: string; json_schema?: { name: string; schema: unknown; strict: boolean } };
    };
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.response_format?.json_schema?.schema).toEqual(schema);
  });

  it('handles assistant turn in multi-turn history (assistant role passes through)', async () => {
    server = startMockServer(() => chatResp('ok'));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    await client.chat([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    const body = server.receivedRequests[0]?.body as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('wraps upstream 4xx into LlmEndpointError carrying the status code', async () => {
    server = startMockServer(() => new Response('rate limited', { status: 429 }));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmEndpointError);
      expect((err as LlmEndpointError).status).toBe(429);
    }
  });

  it('wraps upstream 5xx into LlmEndpointError carrying the status code', async () => {
    server = startMockServer(() => new Response('server boom', { status: 503 }));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmEndpointError);
      expect((err as LlmEndpointError).status).toBe(503);
    }
  });

  it('sends Bearer apiKey when configured', async () => {
    let observedAuth: string | undefined;
    server = startMockServer((req) => {
      observedAuth = req.headers.get('authorization') ?? undefined;
      return chatResp('ok');
    });
    const client = new OpenAiSdkChatBackend({
      provider: 'openai-compat',
      endpoint: server.url,
      model: 'm',
      apiKey: 'sk-realkey',
    });
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(observedAuth).toBe('Bearer sk-realkey');
  });

  it('uses the sentinel apiKey for local-backend configs', async () => {
    let observedAuth: string | undefined;
    server = startMockServer((req) => {
      observedAuth = req.headers.get('authorization') ?? undefined;
      return chatResp('ok');
    });
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(observedAuth).toBe('Bearer unused-local-backend');
  });

  it('isReachable returns true on /v1/models success', async () => {
    server = startMockServer(() => Response.json({ data: [{ id: 'test-model', object: 'model' }] }));
    const client = new OpenAiSdkChatBackend(baseCfg(server.url));
    expect(await client.isReachable()).toBe(true);
    expect(client.reachabilityError()).toBeNull();
  });

  it('isReachable returns false + populates reachabilityError on failure', async () => {
    const client = new OpenAiSdkChatBackend({
      provider: 'openai-compat',
      endpoint: 'http://localhost:1', // unbound
      model: 'm',
    });
    expect(await client.isReachable()).toBe(false);
    expect(client.reachabilityError()).toMatch(/not reachable/);
  });
});
