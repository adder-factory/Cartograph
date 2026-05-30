/**
 * Cross-encoder reranker — HTTP via Cohere-compatible
 * `POST /v1/rerank`. Supported by llama-cpp's `llama-server`
 * (`--rerank` flag) + Jina Reranker API + Voyage AI + Cohere itself.
 *
 * Where the embedder turns one text into one vector, the reranker
 * scores `(query, candidate)` pairs as a relevance ranking — the
 * cross-encoder reads both texts jointly so it picks up subtle signal
 * that a bi-encoder misses.
 *
 * Scores are in `[0, 1]` (whatever the upstream `/v1/rerank` response
 * carries — typically already normalised). Callers that blend
 * reranker scores with cosine similarity should rank-normalise
 * (e.g. via reciprocal-rank fusion) rather than treating these as
 * probabilities across queries.
 *
 * Wired into the search path only when `config.rerankerLlm` is set.
 * Default config value is `null` so existing installs see no change.
 *
 * Failure modes:
 *   - endpoint unreachable → `isReachable()` returns false;
 *     `rerank()` throws `LlmEndpointError`.
 *   - backend doesn't expose `/v1/rerank` (Ollama, mlx_lm today) →
 *     `isReachable()` returns false; pick a backend that supports
 *     reranking (llama-server with `--rerank`, Jina, Voyage, Cohere)
 *     or leave `rerankerLlm` unset.
 *
 * The in-process `'local'` pathway (mini-nllc + libcgshim +
 * MiniNllcRankingContext) was deleted 2026-05-24c (step 4c of the
 * migration — see `project_llm_pivot_to_llama_server` in
 * auto-memory).
 *
 * Lazy-loads the HTTP client on the first call.
 */

import { LlmEndpointError } from './client.js';

/** Reranker config shape. Only `'openai-compat'` after the in-process
 *  `'local'` pathway was deleted 2026-05-24c (step 4c).
 *
 *  HTTP via Cohere-compatible `POST /v1/rerank`. Supported by
 *  llama-cpp's `llama-server` (running with a reranker GGUF +
 *  `--rerank` flag) + Jina Reranker API + Voyage AI + Cohere itself.
 *  Ollama and mlx_lm don't expose `/v1/rerank` today, so those
 *  backends report `isReachable() === false` until the endpoint
 *  surfaces upstream — point `endpoint` at a llama-server with
 *  `--rerank` instead, or leave `rerankerLlm` unset to skip
 *  reranking entirely. */
export interface RerankerProviderConfig {
  provider: 'openai-compat';
  /** Model identifier the backend serves (e.g. the basename of the
   *  GGUF for llama-server, or a Cohere model name). */
  model?: string;
  /** Base URL of the HTTP backend WITHOUT the `/v1` suffix
   *  (e.g. `http://localhost:8080` for llama-server). */
  endpoint?: string;
  /** Optional Bearer token. Required by cloud rerank providers
   *  (Cohere / Jina / Voyage); ignored by local llama-server. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Defaults to 60 000.
   *  Reranker calls are typically sub-second locally. */
  timeoutMs?: number;
  /** Retained for back-compat with older configs that set it for the
   *  removed in-process backend; ignored by the HTTP path. */
  dtype?: string;
  /** Manual override for cartograph-side concurrent in-flight rerank
   *  requests. When unset, cartograph uses the hardware-aware
   *  recommendation from `recommendedTuning().reranker.cartographConcurrency`. */
  concurrency?: number;
}

/**
 * Cross-encoder reranker for retrieval. Scores `(query, candidate)`
 * pairs and returns one relevance score per candidate, in input
 * order. Higher score = more relevant.
 *
 * Scores are in `[0, 1]` — same contract as the pre-deletion
 * in-process backend. Callers that want to blend reranker scores
 * with cosine similarity should rank-normalise (e.g. via reciprocal-
 * rank fusion) rather than treating these as probabilities across
 * queries.
 */
export class RerankerClient {
  private readonly cfg: RerankerProviderConfig | null;
  private readonly model: string | null;
  private httpImpl: import('./openai-sdk-reranker-client.js').OpenAiSdkRerankerClient | null = null;

  constructor(cfg: RerankerProviderConfig | null) {
    this.cfg = cfg;
    this.model = cfg?.model ?? null;
  }

  /** True when a config block was passed (i.e. the operator has opted
   *  into reranking). */
  get isConfigured(): boolean {
    return this.cfg !== null && typeof this.model === 'string' && this.model.length > 0;
  }

  /**
   * Score one candidate text against `query`. Convenience wrapper
   * around {@link rerank}. Throws {@link LlmEndpointError} when not
   * configured.
   */
  async scoreOne(query: string, candidate: string, opts: { signal?: AbortSignal } = {}): Promise<number> {
    const [score] = await this.rerank(query, [candidate], opts);
    return score ?? NaN;
  }

  /**
   * Score N candidates against `query`. Returns one score per input
   * in the same order. Throws {@link LlmEndpointError} when no model
   * is configured or when the HTTP backend request fails.
   */
  async rerank(query: string, candidates: string[], opts: { signal?: AbortSignal } = {}): Promise<number[]> {
    if (!this.isConfigured || !this.model || !this.cfg) {
      throw new LlmEndpointError('rerankerLlm provider not configured');
    }
    if (candidates.length === 0) return [];
    if (opts.signal?.aborted) throw new Error('rerank aborted');
    return (await this.getHttpImpl()).rerank(query, candidates, opts);
  }

  /** True when the configured backend's `/v1/rerank` endpoint
   *  responds to a 1-doc probe request. */
  async isReachable(): Promise<boolean> {
    if (!this.isConfigured || !this.model || !this.cfg) return false;
    try {
      return await (await this.getHttpImpl()).isReachable();
    } catch {
      return false;
    }
  }

  /** Returns the configured model identifier. */
  async listModels(): Promise<string[]> {
    return this.model ? [this.model] : [];
  }

  private async getHttpImpl(): Promise<import('./openai-sdk-reranker-client.js').OpenAiSdkRerankerClient> {
    if (this.httpImpl) return this.httpImpl;
    if (!this.cfg) {
      throw new LlmEndpointError('rerankerLlm provider not configured');
    }
    const { OpenAiSdkRerankerClient } = await import('./openai-sdk-reranker-client.js');
    this.httpImpl = new OpenAiSdkRerankerClient(this.cfg);
    return this.httpImpl;
  }
}
