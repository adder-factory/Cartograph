/**
 * HTTP reranker client speaking the Cohere-compatible `POST /v1/rerank`
 * shape that llama-cpp's `llama-server` (with a reranker GGUF +
 * `--rerank` flag) + Jina Reranker API + Voyage AI + Cohere itself
 * all implement. Migration arc 2026-05-24c step 4b: replaces the
 * in-process `MiniNllcRankingContext` for callers that opt into
 * `provider: 'openai-compat'` on their `rerankerLlm` block.
 *
 * Why plain `fetch` instead of the `openai` SDK: the official OpenAI
 * SDK doesn't ship a `client.reranks.create()` method because OpenAI
 * itself doesn't expose `/v1/rerank` yet. The Cohere shape is the
 * de-facto standard everyone else copies. Using `fetch` keeps the
 * surface small and avoids forcing the SDK's request shape onto an
 * endpoint it doesn't know about.
 *
 * Request shape (sent to `${endpoint}/v1/rerank`):
 *
 *   {
 *     "model": "bge-reranker-v2-m3",
 *     "query": "how do I X?",
 *     "documents": ["doc1", "doc2", ...],
 *     "top_n": N           // optional; backends default to all
 *   }
 *
 * Response shape:
 *
 *   {
 *     "model": "...",
 *     "results": [
 *       { "index": 0, "relevance_score": 0.95 },
 *       { "index": 1, "relevance_score": 0.42 }
 *     ],
 *     "usage": { ... }     // ignored
 *   }
 *
 * The `results` array is NOT guaranteed to be in input order — it's
 * typically sorted by score descending. We re-order by `index` before
 * returning so callers see scores aligned with their input `candidates`
 * array, matching the in-process `MiniNllcRankingContext.rankAll`
 * contract.
 */

import { LlmEndpointError } from './client.js';
import { logWarn } from '../errors.js';
import { backendLabel, scanForLlmBackends, type DetectedBackendKind } from '../installer/scan-backends.js';
import type { RerankerProviderConfig } from './reranker-client.js';
import {
  assertOpenAiCompatEndpointOrApiKey,
  normaliseOpenAiCompatFetchBaseUrl,
  resolveOpenAiCompatTimeout,
} from './openai-compat-http.js';

/** Default per-request timeout. Rerank is typically sub-second on a
 *  local backend; 60s gives headroom for cold-start model loads on
 *  the server side. Override via `cfg.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Cohere's public rerank API base. Used as the fallback when no
 *  `endpoint` is set on the rerankerLlm config (cloud Cohere is the
 *  canonical no-endpoint provider). */
const COHERE_DEFAULT_ENDPOINT = 'https://api.cohere.ai';

/** Per-tier `isReachable()` failure-message builder. Distinct from
 *  the shared `buildReachabilityError` because reranker requires
 *  the Cohere-compat `/v1/rerank` shape — Ollama + mlx_lm are
 *  detected but informational only (they don't implement it), so
 *  the suggestion text differs from the embed / chat tiers. */
function buildRerankerReachabilityError(
  endpointLabel: string,
  baseMsg: string,
  alternatives: ReadonlyArray<{ kind: DetectedBackendKind; endpoint: string }>,
): string {
  const rerankSuggestion = '(llama-server with --rerank, Jina, Voyage, or Cohere)';
  if (alternatives.length === 0) {
    return (
      `${endpointLabel} /v1/rerank not reachable (${baseMsg}). ` +
      `Reranking needs a backend that implements Cohere-compat /v1/rerank ` +
      `${rerankSuggestion}. Ollama + mlx_lm do not today.`
    );
  }
  const plural = alternatives.length === 1 ? '' : 's';
  const list = alternatives.map((d) => `${backendLabel(d.kind)} at ${d.endpoint}`).join(', ');
  return (
    `${endpointLabel} /v1/rerank not reachable (${baseMsg}). Detected ${alternatives.length} ` +
    `other backend${plural}: ${list}. Reranking needs a backend that implements ` +
    `Cohere-compat /v1/rerank ${rerankSuggestion}.`
  );
}

interface RerankResultEntry {
  readonly index: number;
  readonly relevance_score: number;
}

interface RerankResponse {
  readonly results?: ReadonlyArray<RerankResultEntry>;
}

export class OpenAiSdkRerankerClient {
  private readonly cfg: RerankerProviderConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private lastReachabilityError: string | null = null;

  constructor(cfg: RerankerProviderConfig) {
    if (cfg.provider !== 'openai-compat') {
      throw new LlmEndpointError(`OpenAiSdkRerankerClient requires provider='openai-compat', got '${cfg.provider}'`);
    }
    assertOpenAiCompatEndpointOrApiKey(cfg, 'reranker', 'rerankerLlm config');
    if (!cfg.model || cfg.model.length === 0) {
      throw new LlmEndpointError('openai-compat reranker requires `model` to be set in rerankerLlm config.');
    }
    this.cfg = cfg;
    this.baseUrl = cfg.endpoint ? normaliseOpenAiCompatFetchBaseUrl(cfg.endpoint) : COHERE_DEFAULT_ENDPOINT;
    this.timeoutMs = resolveOpenAiCompatTimeout(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  /**
   * Score N candidates against `query`. Returns one score per input
   * in input order (the backend may return them sorted; we re-index).
   * Throws {@link LlmEndpointError} on any HTTP failure with the
   * upstream status code attached when available.
   */
  async rerank(query: string, candidates: string[], opts: { signal?: AbortSignal } = {}): Promise<number[]> {
    if (candidates.length === 0) return [];
    if (opts.signal?.aborted) throw new Error('rerank aborted');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Chain external abort onto our internal controller.
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw new Error('rerank aborted');
      }
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;

    try {
      const res = await fetch(`${this.baseUrl}/v1/rerank`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.cfg.model,
          query,
          documents: candidates,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmEndpointError(
          `rerank endpoint returned ${res.status}: ${text.slice(0, 200) || res.statusText}`,
          res.status,
        );
      }
      const body = (await res.json()) as RerankResponse;
      return scoresFromRerankResponse(body, candidates.length);
    } catch (err) {
      if (err instanceof LlmEndpointError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('rerank aborted');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmEndpointError(`rerank endpoint request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probe reachability by sending a 1-candidate dummy rerank request.
   * Many backends don't expose `/v1/rerank` on `GET` — only `POST`.
   * On failure, fold detected alternative backends into
   * `lastReachabilityError` so doctor + diagnostics can guide the
   * user. (NB: only llama-server + Cohere-shape backends respond to
   * `/v1/rerank`; Ollama + mlx_lm don't, so detecting them as
   * alternatives is informational only.)
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.rerank('probe', ['probe']);
      this.lastReachabilityError = null;
      return true;
    } catch (err) {
      const baseMsg = err instanceof Error ? err.message : String(err);
      const alternatives = await scanForLlmBackends();
      const endpointLabel = this.cfg.endpoint ?? '(cloud)';
      this.lastReachabilityError = buildRerankerReachabilityError(endpointLabel, baseMsg, alternatives);
      logWarn('OpenAiSdkRerankerClient: endpoint not reachable', {
        baseURL: this.baseUrl,
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

function scoresFromRerankResponse(body: RerankResponse, candidateCount: number): number[] {
  if (!Array.isArray(body.results)) {
    throw new LlmEndpointError(
      `rerank endpoint returned a body without a \`results\` array. ` +
        'Backend may not implement the Cohere-compatible /v1/rerank shape.',
    );
  }
  // Fill scores in input order — backends may sort by score descending.
  const scores = new Array<number>(candidateCount).fill(0);
  for (const entry of body.results) {
    if (isValidRerankEntry(entry, candidateCount)) scores[entry.index] = entry.relevance_score;
  }
  return scores;
}

function isValidRerankEntry(entry: RerankResultEntry | undefined, candidateCount: number): entry is RerankResultEntry {
  return (
    typeof entry?.index === 'number' &&
    entry.index >= 0 &&
    entry.index < candidateCount &&
    typeof entry.relevance_score === 'number'
  );
}
