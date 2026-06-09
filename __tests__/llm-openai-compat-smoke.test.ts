import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { OpenAiSdkChatBackend } from '../src/llm/openai-sdk-chat-client.js';
import { OpenAiSdkEmbeddingClient } from '../src/llm/openai-sdk-embedding-client.js';
import { OpenAiSdkRerankerClient } from '../src/llm/openai-sdk-reranker-client.js';

const LOOPBACK_HOST = 'localhost';
const BACKEND_TIMEOUT_MS = 5_000;
const CHAT_MAX_TOKENS = 32;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const UNIX_MS_PER_SECOND = 1_000;
const FAKE_PROMPT_TOKENS = 8;
const FAKE_COMPLETION_TOKENS = 4;
const FAKE_TOTAL_TOKENS = FAKE_PROMPT_TOKENS + FAKE_COMPLETION_TOKENS;
const VECTOR_BIAS = 0.5;
const MATCH_SCORE = 0.9;
const OTHER_SCORE = 0.4;

interface BackendState {
  models: number;
  chat: number;
  embeddings: number;
  rerank: number;
  lastChatBody: Record<string, unknown> | null;
}

interface FakeBackend {
  endpoint: string;
  state: BackendState;
  close: () => Promise<void>;
}

const backends: FakeBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

describe('OpenAI-compatible LLM backend smoke', () => {
  it('drives chat, embedding, reachability, and rerank clients through HTTP', async () => {
    const backend = await startFakeOpenAiCompatBackend();
    backends.push(backend);

    const chat = new OpenAiSdkChatBackend({
      provider: 'openai-compat',
      endpoint: backend.endpoint,
      model: 'chat-smoke',
      timeoutMs: BACKEND_TIMEOUT_MS,
    });
    const embeddings = new OpenAiSdkEmbeddingClient({
      provider: 'openai-compat',
      endpoint: backend.endpoint,
      model: 'embed-smoke',
      timeoutMs: BACKEND_TIMEOUT_MS,
    });
    const reranker = new OpenAiSdkRerankerClient({
      provider: 'openai-compat',
      endpoint: backend.endpoint,
      model: 'rerank-smoke',
      timeoutMs: BACKEND_TIMEOUT_MS,
    });

    await expect(chat.isReachable()).resolves.toBe(true);
    await expect(embeddings.isReachable()).resolves.toBe(true);
    await expect(reranker.isReachable()).resolves.toBe(true);

    const chatResult = await chat.chat(
      [
        { role: 'system', content: 'Reply with a tiny JSON object.' },
        { role: 'user', content: 'Smoke test Cartograph LLM backend routing.' },
      ],
      {
        maxTokens: CHAT_MAX_TOKENS,
        responseSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, source: { type: 'string' } },
          required: ['ok', 'source'],
          additionalProperties: false,
        },
      },
    );
    expect(JSON.parse(chatResult.text)).toEqual({ ok: true, source: 'fake-openai-compat' });
    expect(backend.state.lastChatBody?.['response_format']).toMatchObject({ type: 'json_schema' });

    const vectors = await embeddings.embed(['alpha', 'beta']);
    expect(vectors).toHaveLength(2);
    expect([...vectors[0]!]).toEqual(embeddingFor('alpha', 0));
    expect([...vectors[1]!]).toEqual(embeddingFor('beta', 1));

    const scores = await reranker.rerank('alpha', ['alpha document', 'other']);
    expect(scores).toEqual([MATCH_SCORE, OTHER_SCORE]);

    expect(backend.state.models).toBeGreaterThanOrEqual(2);
    expect(backend.state.chat).toBe(1);
    expect(backend.state.embeddings).toBe(1);
    expect(backend.state.rerank).toBeGreaterThanOrEqual(2);
  });
});

async function startFakeOpenAiCompatBackend(): Promise<FakeBackend> {
  const state: BackendState = {
    models: 0,
    chat: 0,
    embeddings: 0,
    rerank: 0,
    lastChatBody: null,
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    try {
      if (method === 'GET' && url === '/v1/models') {
        state.models++;
        sendJson(res, HTTP_OK, {
          object: 'list',
          data: [
            { id: 'chat-smoke', object: 'model' },
            { id: 'embed-smoke', object: 'model' },
            { id: 'rerank-smoke', object: 'model' },
          ],
        });
        return;
      }

      if (method === 'POST' && url === '/v1/chat/completions') {
        state.chat++;
        state.lastChatBody = await readJsonBody(req);
        sendJson(res, HTTP_OK, {
          id: 'chatcmpl-smoke',
          object: 'chat.completion',
          created: Math.floor(Date.now() / UNIX_MS_PER_SECOND),
          model: 'chat-smoke',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"ok":true,"source":"fake-openai-compat"}' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: FAKE_PROMPT_TOKENS,
            completion_tokens: FAKE_COMPLETION_TOKENS,
            total_tokens: FAKE_TOTAL_TOKENS,
          },
        });
        return;
      }

      if (method === 'POST' && url === '/v1/embeddings') {
        state.embeddings++;
        const body = await readJsonBody(req);
        const inputs = Array.isArray(body['input']) ? body['input'] : [body['input']];
        sendJson(res, HTTP_OK, {
          object: 'list',
          model: 'embed-smoke',
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: embeddingFor(String(input), index),
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        });
        return;
      }

      if (method === 'POST' && url === '/v1/rerank') {
        state.rerank++;
        const body = await readJsonBody(req);
        const documents = Array.isArray(body['documents']) ? body['documents'] : [];
        sendJson(res, HTTP_OK, {
          model: 'rerank-smoke',
          results: documents.map((doc, index) => ({
            index,
            relevance_score: String(doc).includes('alpha') ? MATCH_SCORE : OTHER_SCORE,
          })),
        });
        return;
      }

      sendJson(res, HTTP_NOT_FOUND, { error: { message: `No route for ${method} ${url}` } });
    } catch (err) {
      sendJson(res, HTTP_INTERNAL_SERVER_ERROR, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake backend did not bind a TCP port');

  return {
    endpoint: `http://${LOOPBACK_HOST}:${address.port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function embeddingFor(input: string, index: number): number[] {
  return [input.length, index, input.includes('a') ? 1 : 0, VECTOR_BIAS];
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
