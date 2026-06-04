/**
 * Provider resolution.
 *
 * Translates the high-level `config.llm` block into a runtime
 * `LlmEndpointConfig`. Supported providers:
 *
 *   chat (summarizeLlm / askLlm / localLlm):
 *     1. openai-compat — HTTP via the `openai` npm SDK with baseURL
 *                        override (llama-server / Ollama / mlx_lm /
 *                        cloud OpenAI-compat); needs `endpoint`
 *                        (local) or `apiKey` / `OPENAI_API_KEY`
 *                        (cloud); model = backend identifier
 *     2. claude-bridge — `claude` CLI subprocess
 *     3. anthropic-api — Anthropic HTTPS; needs ANTHROPIC_API_KEY
 *     4. (none)        — LLM chat features off
 *
 *   embeddingLlm:
 *     1. openai-compat — HTTP via the `openai` npm SDK with baseURL
 *                        override; needs `endpoint` (local) or
 *                        `apiKey` / `OPENAI_API_KEY` (cloud);
 *                        model = backend identifier
 *     2. (none)        — semantic search degrades to FTS-only
 *
 *   rerankerLlm:
 *     1. openai-compat — HTTP via Cohere-compatible POST /v1/rerank
 *                        (llama-server `--rerank`, Jina, Voyage,
 *                        Cohere); needs `endpoint` (local) or `apiKey`
 *                        (cloud); model = backend identifier
 *     2. (none)        — reranking off; search returns the cosine
 *                        bi-encoder top-K unchanged
 *
 * The in-process pathway (`provider: 'nllc'` / `'local'`) was deleted
 * 2026-05-24c — see auto-memory `project_llm_pivot_to_llama_server`
 * for the rationale.
 *
 * Auto-detection is opt-in: nothing here probes localhost unless the
 * user explicitly asked for it via the installer.
 */

import type { CartographConfig } from '../types.js';
import type { ChatProvider, ChatProviderConfig, EmbeddingProviderConfig, LlmEndpointConfig } from './client.js';
import { findOnPath } from './claude-bridge.js';
import { compact } from '../utils.js';
import { logWarn } from '../errors.js';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from '../installer/default-endpoints.js';

/** Default summarize model when claude-bridge is selected but model is unset. */
export const DEFAULT_CLAUDE_CHAT_MODEL = 'claude-haiku-4-5';
/** Default ask/dead-code model — Sonnet for the higher-stakes calls. */
export const DEFAULT_CLAUDE_ASK_MODEL = 'claude-sonnet-4-6';

export interface ResolvedLlm extends LlmEndpointConfig {
  /** Concrete reason this resolution returned what it did — used for
   *  status output and debug logs. */
  resolutionTrace: string;
}

/**
 * Pull the summarize model id out of a resolved config.
 */
export function getChatModel(resolved: LlmEndpointConfig | null | undefined): string | undefined {
  return resolved?.summarizeLlm?.model;
}

/** The model id used for ask + dead-code calls. Prefers the dedicated
 *  `askLlm.model` (split-provider setup); falls back to `summarizeLlm.askModel`
 *  (single-provider setup with a different model id); falls back to
 *  `summarizeLlm.model` last (no override at all). */
export function getAskModel(resolved: LlmEndpointConfig | null | undefined): string | undefined {
  return resolved?.askLlm?.model ?? resolved?.summarizeLlm?.askModel ?? resolved?.summarizeLlm?.model;
}

/** Same as {@link getChatModel} but for the embedding model id. */
export function getEmbeddingModel(resolved: LlmEndpointConfig | null | undefined): string | undefined {
  return resolved?.embeddingLlm?.model;
}

/** Best-effort endpoint label for status output. Returns the provider name
 *  for non-HTTP backends so status output never shows "undefined". */
export function getDisplayEndpoint(resolved: LlmEndpointConfig | null | undefined): string {
  if (!resolved) return '(unconfigured)';
  if (resolved.summarizeLlm?.provider === 'claude-bridge') return 'claude-bridge (subprocess)';
  if (resolved.summarizeLlm?.provider === 'anthropic-api') return 'anthropic-api (HTTPS)';
  if (resolved.summarizeLlm?.provider === 'openai-compat')
    return `openai-compat (${resolved.summarizeLlm.endpoint ?? 'cloud'}|${resolved.summarizeLlm.model})`;
  return '(unknown)';
}

/**
 * Resolve the runtime LLM config from on-disk config. Returns `null`
 * if LLM features are explicitly disabled or no usable provider can be
 * assembled. Runs at most one filesystem `findOnPath` and never makes
 * a network call.
 */
export async function resolveLlmProviders(config: CartographConfig): Promise<ResolvedLlm | null> {
  const llm = config.llm;

  // Master switch. Treat undefined as "not configured".
  if (llm == null) return null;
  if (llm.enabled === false) return null;

  const summarizeLlmCfg = await resolveChat(llm);
  const askLlmCfg = await resolveAskChat(llm);
  const localLlmCfg = await resolveLocalChat(llm);
  const embeddingLlmCfg = resolveEmbeddings(llm);
  const rerankerLlmCfg = resolveReranker(llm);

  if (!summarizeLlmCfg && !embeddingLlmCfg) return null;

  return {
    summarizeLlm: summarizeLlmCfg?.cfg ?? null,
    askLlm: askLlmCfg?.cfg ?? null,
    localLlm: localLlmCfg?.cfg ?? null,
    embeddingLlm: embeddingLlmCfg?.cfg ?? null,
    rerankerLlm: rerankerLlmCfg?.cfg ?? null,
    resolutionTrace: [
      summarizeLlmCfg?.trace,
      askLlmCfg?.trace,
      localLlmCfg?.trace,
      embeddingLlmCfg?.trace,
      rerankerLlmCfg?.trace,
    ]
      .filter(Boolean)
      .join('; '),
  };
}

/**
 * Resolve the optional reranker config block. Pass-through resolver
 * — there's no env-var override or legacy field for the reranker.
 * Returns `null` when the user hasn't opted in.
 */
function resolveReranker(
  llm: NonNullable<CartographConfig['llm']>,
): Resolved<import('./reranker-client.js').RerankerProviderConfig> | null {
  const cfg = llm.rerankerLlm;
  if (!cfg) return null;
  // openai-compat needs the same endpoint-OR-apiKey shape the chat +
  // embedding sides validate at resolution time, so misconfiguration
  // surfaces in the resolver trace rather than on first rerank call.
  if (cfg.provider === 'openai-compat') {
    if (!cfg.endpoint && !cfg.apiKey) {
      logWarn(
        `resolveLlmProviders: rerankerLlm.provider="openai-compat" requires either \`endpoint\` (local backend URL, e.g. ${LLAMA_SERVER_DEFAULT_ENDPOINT} for llama-server with --rerank) or \`apiKey\` (cloud Cohere / Jina / Voyage). Neither set; reranker disabled.`,
      );
      return null;
    }
    if (!cfg.model) {
      logWarn('resolveLlmProviders: rerankerLlm.provider="openai-compat" requires `model`; reranker disabled.');
      return null;
    }
    return { cfg, trace: `rerankerLlm:openai-compat(${cfg.endpoint ?? 'cloud'}|${cfg.model})` };
  }
  return { cfg, trace: `rerankerLlm:${cfg.model ?? '(default)'}` };
}

interface Resolved<T> {
  cfg: T;
  trace: string;
}

/** Resolve claude-bridge chat configuration. */
async function resolveChatClaudeBridge(c: {
  provider: ChatProvider;
  model?: string;
  askModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  claudeBin?: string;
  summaryBatchSize?: number;
}): Promise<Resolved<ChatProviderConfig> | null> {
  const bin = c.claudeBin ?? (await findOnPath('claude'));
  if (!bin) return null;
  return {
    cfg: compact({
      provider: 'claude-bridge',
      model: c.model ?? DEFAULT_CLAUDE_CHAT_MODEL,
      askModel: c.askModel ?? DEFAULT_CLAUDE_ASK_MODEL,
      claudeBin: bin,
      timeoutMs: c.timeoutMs,
      summaryBatchSize: c.summaryBatchSize,
    }),
    trace: `chat=claude-bridge(${bin})`,
  };
}

/** Resolve anthropic-api chat configuration. */
async function resolveChatAnthropicApi(c: {
  provider: ChatProvider;
  model?: string;
  askModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  claudeBin?: string;
  summaryBatchSize?: number;
}): Promise<Resolved<ChatProviderConfig> | null> {
  const apiKey = c.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  return {
    cfg: compact({
      provider: 'anthropic-api',
      model: c.model ?? DEFAULT_CLAUDE_CHAT_MODEL,
      askModel: c.askModel ?? DEFAULT_CLAUDE_ASK_MODEL,
      apiKey,
      timeoutMs: c.timeoutMs,
      summaryBatchSize: c.summaryBatchSize,
    }),
    trace: 'chat=anthropic-api',
  };
}

function resolveOpenAiCompatApiKey(
  configuredApiKey: string | undefined,
  endpoint: string | undefined,
): string | undefined {
  return configuredApiKey ?? (endpoint ? undefined : process.env['OPENAI_API_KEY']);
}

/** Resolve openai-compat HTTP chat configuration. Requires `model`
 *  AND either `endpoint` (for local backends) OR `apiKey` /
 *  `OPENAI_API_KEY` (for cloud OpenAI / together.ai / fireworks.ai).
 *  The backend client itself re-validates these on construction; we
 *  drop early here so the trace line surfaces the misconfiguration in
 *  the resolver report instead of failing on first call. */
async function resolveChatOpenAiCompat(c: {
  model?: string;
  askModel?: string;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  summaryBatchSize?: number;
}): Promise<Resolved<ChatProviderConfig> | null> {
  if (!c.model) {
    logWarn('resolveLlmProviders: summarizeLlm.provider="openai-compat" requires `model`; chat disabled.');
    return null;
  }
  const apiKey = resolveOpenAiCompatApiKey(c.apiKey, c.endpoint);
  if (!c.endpoint && !apiKey) {
    logWarn(
      `resolveLlmProviders: summarizeLlm.provider="openai-compat" requires either \`endpoint\` (local backend URL, e.g. ${LLAMA_SERVER_DEFAULT_ENDPOINT} for llama-server), \`apiKey\`, or OPENAI_API_KEY (cloud OpenAI-compat). None set; chat disabled.`,
    );
    return null;
  }
  return {
    cfg: compact({
      provider: 'openai-compat',
      model: c.model,
      askModel: c.askModel,
      endpoint: c.endpoint,
      apiKey,
      timeoutMs: c.timeoutMs,
      summaryBatchSize: c.summaryBatchSize,
    }),
    trace: `chat=openai-compat(${c.endpoint ?? 'cloud'}|${c.model})`,
  };
}

async function resolveChat(llm: NonNullable<CartographConfig['llm']>): Promise<Resolved<ChatProviderConfig> | null> {
  if (llm.summarizeLlm) {
    const c = llm.summarizeLlm;
    switch (c.provider) {
      case 'claude-bridge':
        return resolveChatClaudeBridge(c);
      case 'anthropic-api':
        return resolveChatAnthropicApi(c);
      case 'openai-compat':
        return resolveChatOpenAiCompat(c);
      default: {
        const p = (c as { provider: string }).provider;
        logWarn(
          `resolveLlmProviders: unsupported chat provider "${p}" in summarizeLlm — supported: openai-compat (HTTP), claude-bridge, anthropic-api`,
        );
        return null;
      }
    }
  }
  return null;
}

/** Resolve claude-bridge ask-chat configuration. */
async function resolveAskChatClaudeBridge(c: {
  provider: ChatProvider;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  claudeBin?: string;
}): Promise<Resolved<ChatProviderConfig> | null> {
  const bin = c.claudeBin ?? (await findOnPath('claude'));
  if (!bin) return null;
  return {
    cfg: compact({
      provider: 'claude-bridge',
      model: c.model ?? DEFAULT_CLAUDE_ASK_MODEL,
      claudeBin: bin,
      timeoutMs: c.timeoutMs,
    }),
    trace: `askChat=claude-bridge(${bin})`,
  };
}

/** Resolve anthropic-api ask-chat configuration. */
async function resolveAskChatAnthropicApi(c: {
  provider: ChatProvider;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  claudeBin?: string;
}): Promise<Resolved<ChatProviderConfig> | null> {
  const apiKey = c.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  return {
    cfg: compact({
      provider: 'anthropic-api',
      model: c.model ?? DEFAULT_CLAUDE_ASK_MODEL,
      apiKey,
      timeoutMs: c.timeoutMs,
    }),
    trace: 'askChat=anthropic-api',
  };
}

/**
 * Resolve the ask-path provider from the optional `askLlm` block.
 * Returns null when not configured — the LlmClient then falls back
 * to routing ask calls through the summarize backend.
 */
async function resolveAskChat(llm: NonNullable<CartographConfig['llm']>): Promise<Resolved<ChatProviderConfig> | null> {
  if (!llm.askLlm) return null;
  const c = llm.askLlm;
  switch (c.provider) {
    case 'claude-bridge':
      return resolveAskChatClaudeBridge(c);
    case 'anthropic-api':
      return resolveAskChatAnthropicApi(c);
    case 'openai-compat': {
      const r = await resolveChatOpenAiCompat(c);
      if (!r) return null;
      return { cfg: r.cfg, trace: r.trace.replace(/^chat=/, 'askLlm=') };
    }
    default: {
      const p = (c as { provider: string }).provider;
      logWarn(
        `resolveLlmProviders: unsupported chat provider "${p}" in askLlm — supported: openai-compat (HTTP), claude-bridge, anthropic-api`,
      );
      return null;
    }
  }
}

/**
 * Resolve the local-chat carve-out provider from the optional `localLlm`
 * block. When unset, cartograph_local_chat routes through the main
 * summarize backend.
 */
async function resolveLocalChat(
  llm: NonNullable<CartographConfig['llm']>,
): Promise<Resolved<ChatProviderConfig> | null> {
  if (!llm.localLlm) return null;
  const c = llm.localLlm;
  let r: Resolved<ChatProviderConfig> | null = null;
  switch (c.provider) {
    case 'claude-bridge':
      r = await resolveAskChatClaudeBridge(c);
      break;
    case 'anthropic-api':
      r = await resolveAskChatAnthropicApi(c);
      break;
    case 'openai-compat':
      r = await resolveChatOpenAiCompat(c);
      break;
    default: {
      const p = (c as { provider: string }).provider;
      logWarn(
        `resolveLlmProviders: unsupported chat provider "${p}" in localLlm — supported: openai-compat (HTTP), claude-bridge, anthropic-api`,
      );
      return null;
    }
  }
  if (!r) return null;
  return { cfg: r.cfg, trace: 'localLlm=' + r.trace.replace(/^askChat=|^chat=/, '') };
}

function resolveEmbeddings(llm: NonNullable<CartographConfig['llm']>): Resolved<EmbeddingProviderConfig> | null {
  if (!llm.embeddingLlm) return null;
  const e = llm.embeddingLlm;
  if (e.provider === 'openai-compat') {
    // HTTP via the openai npm SDK — backend determined by `endpoint`
    // (llama-server / Ollama / mlx_lm / cloud OpenAI-compat).
    // `model` is REQUIRED; `endpoint` is required for local backends
    // (omit only when using cloud OpenAI's default base URL with an
    // apiKey or OPENAI_API_KEY).
    if (!e.model) return null;
    const endpoint = (e as { endpoint?: string }).endpoint;
    const apiKey = resolveOpenAiCompatApiKey((e as { apiKey?: string }).apiKey, endpoint);
    if (!endpoint && !apiKey) {
      logWarn(
        `resolveLlmProviders: embeddingLlm.provider="openai-compat" requires either \`endpoint\` (local backend URL, e.g. ${LLAMA_SERVER_DEFAULT_ENDPOINT} for llama-server), \`apiKey\`, or OPENAI_API_KEY (cloud OpenAI-compat). None set; embedding disabled.`,
      );
      return null;
    }
    return {
      cfg: compact({
        provider: 'openai-compat',
        model: e.model,
        ...(endpoint ? { endpoint } : {}),
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: e.timeoutMs,
      }) as EmbeddingProviderConfig,
      trace: `embeddingLlm=openai-compat(${endpoint ?? 'cloud-default'}, model=${e.model})`,
    };
  }
  // Genuinely unknown provider string (typo / pre-deletion 'local' value).
  const p = (e as { provider: string }).provider;
  logWarn(
    `resolveLlmProviders: unsupported embedding provider "${p}" — only "openai-compat" is supported (in-process 'local' was removed 2026-05-24c). Set embeddingLlm.provider to "openai-compat", embeddingLlm.endpoint to your backend URL (e.g. ${LLAMA_SERVER_DEFAULT_ENDPOINT} for llama-server), and embeddingLlm.model to the model identifier.`,
  );
  return null;
}
