/**
 * OpenAI-compatible HTTP chat backend built on the official `openai`
 * npm SDK with `baseURL` override. Sibling to
 * `OpenAiSdkEmbeddingClient` — same construction pattern, same error
 * shape, same reachability-probe-with-scanner behaviour.
 *
 * Talks to any backend exposing OpenAI's `POST /v1/chat/completions`:
 *   - llama-cpp's `llama-server` (`http://localhost:8080`)
 *   - Ollama (`http://localhost:11434`)
 *   - Apple MLX's `mlx_lm.server` (`http://localhost:8000`)
 *   - LM Studio, vLLM, LocalAI, llamafile — same pattern
 *   - OpenAI itself + cloud OpenAI-compat (together.ai, fireworks.ai,
 *     groq) — set `apiKey`, omit `endpoint` for OpenAI.
 *
 * Migration arc 2026-05-24c step 4: replaces the in-process
 * `LocalChatBackend` (Bun.ffi + libcgshim) for callers that opt into
 * `provider: 'openai-compat'`. See `project_llm_pivot_to_llama_server.md`
 * in the auto-memory for the full rationale.
 *
 * Structured output (`ChatOptions.responseSchema`) maps to OpenAI's
 * `response_format: { type: 'json_schema', json_schema: { name,
 * schema, strict } }`. llama-server, Ollama 0.5+, vLLM, and OpenAI
 * itself honour this as a HARD constraint (decoder-level grammar);
 * older backends that don't recognise the field downgrade to a
 * soft-prompt instruction appended to the system message.
 *
 * Conversation history: the entire `messages` array goes to the
 * backend on every call. HTTP servers handle KV-cache reuse for
 * repeat-prefix prompts transparently via their continuous-batching
 * scheduler — no client-side session state required (mirrors how
 * cloud OpenAI works).
 */

import OpenAI from 'openai';
import { z } from 'zod';
import type {
  ChatBackend,
  ChatMessage,
  ChatOptions,
  ChatProviderConfig,
  ChatResult,
  ResponseJsonSchema,
} from './client.js';
import { LlmEndpointError } from './client.js';
import { scanForLlmBackends } from '../installer/scan-backends.js';
import { buildReachabilityError } from './reachability-helpers.js';
import { logWarn } from '../errors.js';
import {
  assertOpenAiCompatEndpointOrApiKey,
  createOpenAiCompatSdkClient,
  openAiApiErrorToEndpointError,
  probeOpenAiCompatModels,
  resolveOpenAiCompatTimeout,
} from './openai-compat-http.js';

/** Default per-request timeout. Chat completions can run several
 *  seconds on a local model + long-context prompts; 5 minutes gives
 *  comfortable headroom. Override via `cfg.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 300_000;

function mapMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === 'system') return { role: 'system', content: m.content };
  if (m.role === 'user') return { role: 'user', content: m.content };
  return { role: 'assistant', content: m.content };
}

function mapMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(mapMessage);
}

/**
 * Build the OpenAI `response_format` object for a `responseSchema`
 * request. Uses the `json_schema` shape (decoder-level grammar) with
 * `strict: true`. The name is a stable identifier — backends use it
 * only for log lines / error messages, not for routing — so a single
 * literal is fine.
 */
function buildResponseFormat(
  schema: ResponseJsonSchema,
): NonNullable<OpenAI.Chat.ChatCompletionCreateParams['response_format']> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'cartograph_response',
      schema,
      strict: true,
    },
  };
}

/**
 * HTTP chat client with the same public surface as the deprecated
 * in-process `LocalChatBackend`. Routed via the `client.ts` factory
 * when `cfg.provider === 'openai-compat'`.
 */
export class OpenAiSdkChatBackend implements ChatBackend {
  private readonly cfg: ChatProviderConfig;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private lastReachabilityError: string | null = null;

  constructor(cfg: ChatProviderConfig) {
    this.cfg = cfg;
    // `endpoint` is REQUIRED for local-backend configs; cloud OpenAI
    // users can omit it (SDK defaults to api.openai.com) but they
    // must set `apiKey`. Either an endpoint OR an apiKey must be set.
    assertOpenAiCompatEndpointOrApiKey(cfg, 'chat', 'summarizeLlm/askLlm/localLlm config');
    if (!cfg.model || cfg.model.length === 0) {
      throw new LlmEndpointError('openai-compat chat requires `model` to be set in the config block.');
    }
    this.timeoutMs = resolveOpenAiCompatTimeout(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.client = createOpenAiCompatSdkClient(cfg, this.timeoutMs);
  }

  /**
   * One-shot chat completion. `_useAskModel` is accepted for ChatBackend
   * conformance but ignored — askLlm vs summarizeLlm routing happens
   * one level up in `LlmClient`, which constructs separate
   * `OpenAiSdkChatBackend` instances per tier (each carrying its own
   * `cfg.model`).
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}, _useAskModel = false): Promise<ChatResult> {
    if (messages.length === 0) throw new LlmEndpointError('chat: empty messages array');
    if (options.signal?.aborted) throw new LlmEndpointError('chat aborted');

    const params = buildChatCompletionParams(this.cfg.model, messages, options);

    const t0 = Date.now();
    try {
      const res = await this.client.chat.completions.create(params, options.signal ? { signal: options.signal } : {});
      return buildChatResult(res, Date.now() - t0);
    } catch (err) {
      if (err instanceof OpenAI.APIError) throw toChatEndpointError(err);
      if (err instanceof LlmEndpointError) throw err;
      throw err;
    }
  }

  /**
   * Lightweight reachability probe — uses the SDK's `models.list()`
   * which hits `GET /v1/models`. Symmetric with the embedding
   * client's probe so doctor + isReachable callers see consistent
   * behaviour.
   *
   * On failure, scans for OTHER OpenAI-compat backends running on
   * common ports and folds their URLs into the error message so
   * users know which alternatives are already available without
   * having to re-Google.
   */
  async isReachable(): Promise<boolean> {
    try {
      // Awaiting list() performs the request and parses the body — that alone confirms 2xx + reachability.
      await probeOpenAiCompatModels(this.client, this.timeoutMs);
      this.lastReachabilityError = null;
      return true;
    } catch (err) {
      const baseMsg = err instanceof Error ? err.message : String(err);
      const alternatives = await scanForLlmBackends();
      const endpointLabel = this.cfg.endpoint ?? '(OpenAI default)';
      this.lastReachabilityError = buildReachabilityError({
        endpointLabel,
        baseMsg,
        alternatives,
        configField: "the chat config's `endpoint`",
        installHint: '`brew install llama.cpp` then `llama-server -m <chat-GGUF> --port 8080`',
      });
      logWarn('OpenAiSdkChatBackend: endpoint not reachable', {
        baseURL: this.cfg.endpoint ?? '(default)',
        error: baseMsg,
        detectedAlternatives: alternatives.length,
      });
      return false;
    }
  }

  reachabilityError(): string | null {
    return this.lastReachabilityError;
  }
}

function buildChatCompletionParams(
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages: mapMessages(messages),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.responseSchema ? { response_format: buildResponseFormat(options.responseSchema) } : {}),
  };
}

/** Assistant `content` is `string | null` per the SDK type, but a compat
 *  backend can return structured content parts (an array/object). Coerce
 *  any non-string to `null` so a malformed body degrades to an empty
 *  response (upstream retry/fallback) instead of a type-confused payload. */
const ChatContentSchema = z.string().nullish();

function buildChatResult(res: OpenAI.Chat.ChatCompletion, durationMs: number): ChatResult {
  const rawContent = res.choices[0]?.message?.content;
  const parsedContent = ChatContentSchema.safeParse(rawContent);
  const text = (parsedContent.success ? parsedContent.data : null) ?? '';
  const out: ChatResult = { text, durationMs };
  if (typeof res.usage?.prompt_tokens === 'number') out.promptTokens = res.usage.prompt_tokens;
  if (typeof res.usage?.completion_tokens === 'number') out.completionTokens = res.usage.completion_tokens;
  return out;
}

function toChatEndpointError(err: Error & { status?: unknown }): LlmEndpointError {
  return openAiApiErrorToEndpointError('chat', err);
}
