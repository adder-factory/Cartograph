/**
 * LLM client (chat-only)
 *
 * Dispatches `chat()` to one of three backends based on `provider`:
 *   - `openai-compat` → HTTP via the `openai` npm SDK with `baseURL`
 *                        override (llama-server / Ollama / mlx_lm /
 *                        LM Studio / vLLM / LocalAI / cloud OpenAI-compat).
 *                        See `openai-sdk-chat-client.ts`. Default since
 *                        2026-05-24c.
 *   - `claude-bridge` → spawn `claude` CLI subprocess
 *   - `anthropic-api` → Anthropic HTTPS via `@anthropic-ai/sdk`
 *
 * Embedding is routed via `createEmbeddingClient()` in
 * `./embedding-client.ts` — only `OpenAiSdkEmbeddingClient` after the
 * in-process mini-nllc pathway was deleted 2026-05-24c.
 */

/**
 * Error thrown by `LlmClient` and `LocalEmbeddingClient` for any
 * configuration or network failure the user can act on. The optional
 * `status` field carries the upstream HTTP status when relevant
 * (so callers can switch on 429 / 5xx without re-parsing the message).
 *
 * Defined here (not in `http.ts`) so it can be imported without pulling
 * in the now-removed HTTP helper module.
 */
export class LlmEndpointError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmEndpointError';
  }
}

/**
 * Resolved runtime LLM configuration. The split between `chat` and
 * `embeddings` lets us run, e.g., Claude (subprocess) for chat and
 * a separate openai-compat HTTP backend for embeddings simultaneously
 * — see `LlmEndpointConfig` below for the per-tier slots.
 */
/** Chat backend tag.
 *  - `'openai-compat'` — HTTP to any backend exposing OpenAI's
 *    `/v1/chat/completions` endpoint. Same surface as the embedding
 *    HTTP client (`OpenAiSdkEmbeddingClient`), routed via the
 *    official `openai` npm SDK with `baseURL` override. Verified
 *    shapes: llama-cpp `llama-server`, Ollama, Apple MLX `mlx_lm.server`,
 *    LM Studio, vLLM, LocalAI, plus any cloud OpenAI-compatible
 *    provider. Structured output (`ChatOptions.responseSchema`)
 *    maps to OpenAI's `response_format: {type: 'json_schema', ...}`
 *    on backends that support it (llama-server, Ollama 0.5+, vLLM,
 *    OpenAI itself).
 *  - `'claude-bridge'` — spawn the `claude` CLI subprocess.
 *  - `'anthropic-api'` — Anthropic HTTPS via `@anthropic-ai/sdk`. */
export type ChatProvider = 'claude-bridge' | 'anthropic-api' | 'openai-compat';

/** Embedding backend tag. Only `'openai-compat'` after the in-process
 *  mini-nllc pathway was deleted 2026-05-24c (step 4c of the migration —
 *  see auto-memory `project_llm_pivot_to_llama_server`).
 *
 *  HTTP to any backend exposing OpenAI's `/v1/embeddings` endpoint —
 *  verified shapes: llama-cpp `llama-server`, Ollama, Apple MLX
 *  `mlx_lm.server`, LM Studio, vLLM, LocalAI, plus any cloud
 *  OpenAI-compatible provider (OpenAI itself, together.ai,
 *  fireworks.ai, groq). Cartograph routes through the official `openai`
 *  npm SDK with `baseURL` override, so backend-specific quirks (retry
 *  policy, error shapes, streaming chunk handling) come for free.
 *
 *  Exported as a single-member union for type-symmetry with
 *  `ChatProvider` (which still has multiple shapes). Single source of
 *  truth — callers import the type instead of re-spelling the literal. */
export type EmbeddingProvider = 'openai-compat';

export interface ChatProviderConfig {
  provider: ChatProvider;
  model: string;
  /** Optional model override for ask/dead-code (defaults to `model`). */
  askModel?: string;
  /** Legacy field retained for back-compat with older configs that
   *  set a numeric-string here to tune the in-process nllc pool size.
   *  Ignored by all current providers — the HTTP backend's own
   *  scheduler controls parallelism. */
  endpoints?: string[];
  /** For `provider: 'openai-compat'`: base URL of the HTTP backend
   *  WITHOUT the `/v1` suffix (the SDK appends it). Examples:
   *    - llama-server: `http://localhost:8080`
   *    - Ollama: `http://localhost:11434`
   *    - mlx_lm: `http://localhost:8000`
   *    - cloud: omit (defaults to `https://api.openai.com`).
   *  Each tier (`summarizeLlm` / `askLlm` / `localLlm`) carries its
   *  own `endpoint`, so they can independently point at different
   *  backends. Two common patterns:
   *    (a) Different backends per tier — embeddings on llama-server
   *        :8080 + chat on Ollama :11434 (mix-and-match).
   *    (b) Same backend family, different models on different ports —
   *        llama-cpp's `llama-server` is one-model-per-process, so
   *        running three llama-server instances (e.g. `-m embed.gguf
   *        --port 8080`, `-m chat.gguf --port 8081`, `-m reranker.gguf
   *        --port 8082`) lets all three tiers share the same engine
   *        + GPU memory with different model weights. Ollama auto-loads
   *        models on demand from one port, which is simpler but pays a
   *        load cost on cold model switches.
   *  Ignored for `'claude-bridge'` / `'anthropic-api'`. */
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Path to the `claude` binary (claude-bridge only). */
  claudeBin?: string;
  /** Optional override for summary batch size. When unset the host
   *  picks 3 for claude-bridge / anthropic-api (per-call overhead amortises)
   *  and 1 for openai-compat. Set explicitly to opt in/out per provider. */
  summaryBatchSize?: number;
  /** User override for cartograph-side concurrent in-flight chat
   *  requests this tier drives (summarizer / classifier / dead-code
   *  judge). When unset, cartograph uses the hardware-aware
   *  recommendation from `recommendedTuning()` per tier (chat / ask /
   *  reranker — see `src/installer/hardware-tuning.ts`). Match this
   *  to your `llama-server --parallel N` for that tier's port to
   *  fully saturate every backend slot without piling extra requests
   *  up at the client. */
  concurrency?: number;
}

export interface EmbeddingProviderConfig {
  /**
   * Embedding backend. Only `'openai-compat'` after 2026-05-24c.
   *
   * HTTP via the `openai` npm SDK with `baseURL` override. Works
   * against llama-cpp `llama-server`, Ollama, Apple MLX
   * `mlx_lm.server`, LM Studio, vLLM, LocalAI, OpenAI itself, and
   * any other OpenAI-compatible provider. `endpoint` is the base URL
   * (the SDK appends `/v1/embeddings`); `model` is whatever
   * identifier the backend expects (e.g. file path for llama-server,
   * short name for Ollama, OpenAI model id for cloud).
   */
  provider: EmbeddingProvider;
  /** Legacy field retained for back-compat with older configs. Ignored
   *  by the HTTP path — the backend's own scheduler controls parallelism. */
  endpoints?: string[];
  /** REQUIRED for local backends. Base URL of the HTTP backend WITHOUT
   *  the `/v1` suffix (the SDK appends it). Examples:
   *    - llama-server: `http://localhost:8080`
   *    - Ollama: `http://localhost:11434`
   *    - mlx_lm: `http://localhost:8000`
   *    - cloud: omit (defaults to `https://api.openai.com`) */
  endpoint?: string;
  /** For `provider: 'openai-compat'`: optional Bearer token. Required
   *  by cloud OpenAI-compat providers (OpenAI, together.ai, etc.);
   *  optional for most local backends. The OpenAI SDK requires SOME
   *  value to construct, so when unset we pass a literal
   *  `'unused-local-backend'` sentinel — local backends ignore the
   *  `Authorization` header so the sentinel is invisible. */
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** User override for cartograph-side concurrent in-flight requests
   *  this tier drives. When unset, cartograph uses the hardware-aware
   *  recommendation from `recommendedTuning().embed.cartographConcurrency`
   *  (see `src/installer/hardware-tuning.ts`). Match this to your
   *  `llama-server --parallel N` to fully saturate every backend slot
   *  without piling extra requests up at the client. Override per
   *  tier — embed needs more than chat under the same `--parallel`. */
  concurrency?: number;
}

export interface LlmEndpointConfig {
  /** Resolved provider for cartograph's own indexing-time calls. The
   *  user-facing config field is `summarizeLlm`. */
  summarizeLlm?: ChatProviderConfig | null;
  /** Optional separate provider for user-driven discussion calls —
   *  `cartograph_ask` (MCP tool) + the web viewer's Ask-AI panel +
   *  the `cartograph_dead_code` LLM judge. User-facing field: `askLlm`. */
  askLlm?: ChatProviderConfig | null;
  /** Optional separate provider for `cartograph_local_chat` — the
   *  local-tier sibling delegated to for routine subtasks. User-facing
   *  field: `localLlm`. */
  localLlm?: ChatProviderConfig | null;
  /** Resolved embedding provider. User-facing field: `embeddingLlm`. */
  embeddingLlm?: EmbeddingProviderConfig | null;
  /** Optional cross-encoder reranker. Off by default (`null`); when
   *  set, `searchHybrid` reranks the semantic top-K. */
  rerankerLlm?: import('./reranker-client.js').RerankerProviderConfig | null;
}

/**
 * Pass-through normaliser for the split `{summarizeLlm, embeddingLlm}`
 * config shape. Exported for callers (e.g. `index.ts`) that need to
 * round-trip a config from on-disk JSON into the canonical runtime shape.
 */
export function normalizeEndpointConfig(c: LlmEndpointConfig): {
  summarizeLlm: ChatProviderConfig | null;
  askLlm: ChatProviderConfig | null;
  localLlm: ChatProviderConfig | null;
  embeddingLlm: EmbeddingProviderConfig | null;
  rerankerLlm: import('./reranker-client.js').RerankerProviderConfig | null;
} {
  return {
    summarizeLlm: c.summarizeLlm ?? null,
    askLlm: c.askLlm ?? null,
    localLlm: c.localLlm ?? null,
    embeddingLlm: c.embeddingLlm ?? null,
    rerankerLlm: c.rerankerLlm ?? null,
  };
}

/** Char prefix of an LLM reply included in batch-parse-failure log
 *  entries (120 chars — short enough to read in a single line).
 *  Shared across `classifier`, `dead-code`, and `summarizer` so the
 *  log shape stays uniform. */
export const BATCH_PARSE_FAILURE_LOG_CHARS = 120;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Provider-agnostic structured-output request — a JSON-schema object.
 * MUST be object-rooted (`{type:'object', ...}`): the Anthropic
 * tool-use path requires an object-rooted `input_schema`, so a caller
 * wanting an array wraps it (`{properties:{results:{type:'array',…}}}`).
 *
 * Each backend honours it as far as its transport allows:
 *   - `openai-compat` → OpenAI `response_format: {type:'json_schema',
 *                       strict:true}`. HARD constraint on llama-server,
 *                       Ollama 0.5+, vLLM, and cloud OpenAI; silently
 *                       ignored by older backends that don't recognise
 *                       the field.
 *   - `anthropic-api` → a forced single-tool call whose `input_schema`
 *                       is this schema — also a HARD constraint.
 *   - `claude-bridge` → appended to the prompt as a SOFT instruction
 *                       (the `claude` CLI one-shot can't be constrained).
 *
 * Typed loosely (`Record<string, unknown>`) so call sites stay free
 * of any backend-specific schema type; each backend serialises it
 * however its transport requires.
 */
export type ResponseJsonSchema = Record<string, unknown>;

export interface ChatOptions {
  /** Sampling temperature; 0 for deterministic single-line outputs. */
  temperature?: number;
  /** Cap output tokens. Tight default since most callers want short replies. */
  maxTokens?: number;
  /**
   * Cancel the in-flight call when the signal aborts. Backends honor it:
   * openai-compat passes it to the `openai` npm SDK (cancels the in-flight
   * HTTP request); claude-bridge SIGTERMs the subprocess (then SIGKILLs
   * after a short grace); anthropic-api passes it to the SDK. Without
   * this, a `cg.close()` mid-pass had to wait for every in-flight
   * worker's current call to finish — see test-5 cancellation overshoot.
   */
  signal?: AbortSignal;
  /**
   * Request structured output matching this JSON schema. openai-compat
   * and anthropic-api hard-constrain to it (decoder-level grammar or
   * forced tool-use); claude-bridge soft-prompts it. See
   * {@link ResponseJsonSchema}. When set, the reply text is the JSON
   * document (no prose / fences) for the hard-constrained backends;
   * callers `JSON.parse` it directly.
   */
  responseSchema?: ResponseJsonSchema;
}

export interface ChatResult {
  text: string;
  /** Round-trip wall time in ms (includes network + inference). */
  durationMs: number;
  /** Raw token counts the server reported, when available. */
  promptTokens?: number;
  completionTokens?: number;
}

/** Lazy backend bundle — mirrors the `backends` field shape on LlmClient. */
interface LlmClientBackends {
  summarizeLlm: ChatBackend | null;
  askLlm: ChatBackend | null;
  localLlm: ChatBackend | null;
}

/**
 * Resolve (and lazily instantiate) the summarize LLM backend. Mutates `backends.summarizeLlm`
 * on first call; subsequent calls return the cached instance.
 */
async function llmClientGetSummarizeLlmBackend(
  backends: LlmClientBackends,
  summarizeLlmCfg: ChatProviderConfig | null,
): Promise<ChatBackend> {
  if (backends.summarizeLlm) return backends.summarizeLlm;
  if (!summarizeLlmCfg) throw new LlmEndpointError('summarizeLlm provider not configured');
  backends.summarizeLlm = await llmClientInstantiateBackend(summarizeLlmCfg);
  return backends.summarizeLlm;
}

/**
 * Resolve (and lazily instantiate) the ask LLM backend. Mutates
 * `backends.askLlm` on first call; subsequent calls return the cached instance.
 */
async function llmClientGetAskLlmBackend(
  backends: LlmClientBackends,
  askLlmCfg: ChatProviderConfig | null,
): Promise<ChatBackend> {
  if (backends.askLlm) return backends.askLlm;
  if (!askLlmCfg) throw new LlmEndpointError('askLlm provider not configured');
  backends.askLlm = await llmClientInstantiateBackend(askLlmCfg);
  return backends.askLlm;
}

/**
 * Resolve (and lazily instantiate) the local LLM backend. Mirrors
 * the askLlm helper. Used by `cartograph_local_chat` when the user
 * has split bulk-prose off the main summarization backend.
 */
async function llmClientGetLocalLlmBackend(
  backends: LlmClientBackends,
  localLlmCfg: ChatProviderConfig | null,
): Promise<ChatBackend> {
  if (backends.localLlm) return backends.localLlm;
  if (!localLlmCfg) throw new LlmEndpointError('localLlm provider not configured');
  backends.localLlm = await llmClientInstantiateBackend(localLlmCfg);
  return backends.localLlm;
}

/** Lazy-load and return the correct ChatBackend for the given provider config. */
async function llmClientInstantiateBackend(cfg: ChatProviderConfig): Promise<ChatBackend> {
  switch (cfg.provider) {
    case 'claude-bridge': {
      const { ClaudeBridgeChatBackend } = await import('./claude-bridge.js');
      return new ClaudeBridgeChatBackend(cfg);
    }
    case 'anthropic-api': {
      const { AnthropicApiChatBackend } = await import('./anthropic-api.js');
      return new AnthropicApiChatBackend(cfg);
    }
    case 'openai-compat': {
      const { OpenAiSdkChatBackend } = await import('./openai-sdk-chat-client.js');
      return new OpenAiSdkChatBackend(cfg);
    }
    default: {
      const p = cfg.provider;
      throw new LlmEndpointError(
        `unsupported chat provider "${p}" — supported: openai-compat (HTTP), claude-bridge, anthropic-api`,
      );
    }
  }
}

/**
 * Probe the LLM backends (summarizeLlm and optional separate askLlm).
 * Returns false if either backend reports unreachable, or on any error.
 */
async function llmClientProbeBackends(
  backends: LlmClientBackends,
  summarizeLlmCfg: ChatProviderConfig,
  askLlmCfg: ChatProviderConfig | null,
): Promise<boolean> {
  try {
    const summarizeOk = await (await llmClientGetSummarizeLlmBackend(backends, summarizeLlmCfg)).isReachable();
    if (!summarizeOk) return false;
    if (askLlmCfg) {
      const askOk = await (await llmClientGetAskLlmBackend(backends, askLlmCfg)).isReachable();
      if (!askOk) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Polymorphic chat client. Dispatches `chat()` to one of three backends
 * based on `provider`:
 *
 *   - `openai-compat` → HTTP via the `openai` npm SDK with `baseURL`
 *                        override (`OpenAiSdkChatBackend`). Default.
 *   - `claude-bridge` → spawn `claude` CLI subprocess
 *   - `anthropic-api` → Anthropic HTTPS via `@anthropic-ai/sdk`
 *
 * Embedding is routed via {@link ./embedding-client.createEmbeddingClient}
 * — only `OpenAiSdkEmbeddingClient` (HTTP via the `openai` npm SDK)
 * after the in-process mini-nllc pathway was deleted 2026-05-24c.
 * Separate class so chat-only callers don't carry embedding state.
 */
export class LlmClient {
  private readonly summarizeLlmCfg: ChatProviderConfig | null;
  private readonly askLlmCfg: ChatProviderConfig | null;
  private readonly localLlmCfg: ChatProviderConfig | null;
  /** Lazily-loaded backend impls — grouped to reduce field count. */
  private readonly backends: LlmClientBackends = { summarizeLlm: null, askLlm: null, localLlm: null };

  constructor(config: LlmEndpointConfig) {
    const norm = normalizeEndpointConfig(config);
    this.summarizeLlmCfg = norm.summarizeLlm;
    this.askLlmCfg = norm.askLlm;
    this.localLlmCfg = norm.localLlm;
  }

  /**
   * One-shot chat completion. Returns the assistant's text and metadata.
   * Throws {@link LlmEndpointError} on backend failure.
   *
   * `useAskModel` lets callers route to the higher-stakes model (e.g.
   * Sonnet for `ask`) when the chat config defines a separate `askModel`.
   */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions & { useAskModel?: boolean; useLocalChat?: boolean } = {},
  ): Promise<ChatResult> {
    const useAsk = options.useAskModel ?? false;
    const useLocal = options.useLocalChat ?? false;
    // When the caller asked for the local LLM path AND a separate
    // localLlm provider was configured, route to that backend. This
    // is the bulk-prose carve-out (paraphrase verification, draft
    // prose, file summarisation) used by `cartograph_local_chat`. When
    // localLlm is unset, falls through to the main summarizeLlm backend
    // (legacy single-provider behaviour).
    if (useLocal && this.localLlmCfg) {
      const backend = await llmClientGetLocalLlmBackend(this.backends, this.localLlmCfg);
      return backend.chat(messages, options, false);
    }
    // When the caller asked for the ask path AND a separate askLlm
    // provider was configured, route to that backend.
    if (useAsk && this.askLlmCfg) {
      const backend = await llmClientGetAskLlmBackend(this.backends, this.askLlmCfg);
      return backend.chat(messages, options, false);
    }
    if (!this.summarizeLlmCfg) throw new LlmEndpointError('summarizeLlm provider not configured');
    const backend = await llmClientGetSummarizeLlmBackend(this.backends, this.summarizeLlmCfg);
    return backend.chat(messages, options, useAsk);
  }

  /** Whether a separate `localLlm` backend is configured. Read by
   *  `cartograph_local_chat` and the status display so callers can
   *  surface the routing without inspecting `summarizeLlmCfg` directly. */
  hasLocalLlmOverride(): boolean {
    return this.localLlmCfg !== null;
  }

  /**
   * Probe the configured summarizeLlm backend and (when separately
   * configured) the askLlm backend. Returns false when either is
   * unreachable or when no chat provider is configured.
   */
  async isReachable(): Promise<boolean> {
    if (!this.summarizeLlmCfg) return false;
    return llmClientProbeBackends(this.backends, this.summarizeLlmCfg, this.askLlmCfg);
  }

  /**
   * Always returns `[]` on this surface — caller-side enumeration
   * isn't useful here. `openai-compat` exposes `/v1/models` (visible
   * via `OpenAiSdkChatBackend.isReachable`'s scanner output + the
   * `cartograph doctor` reachability check); `claude-bridge` /
   * `anthropic-api` don't.
   */
  async listModels(): Promise<string[]> {
    return [];
  }
}

/** Internal chat-backend contract. Each provider implements this. */
export interface ChatBackend {
  chat(messages: ChatMessage[], options: ChatOptions, useAskModel: boolean): Promise<ChatResult>;
  isReachable(): Promise<boolean>;
}
