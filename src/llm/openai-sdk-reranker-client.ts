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
 * contract. Some backends return probabilities in [0, 1]; llama.cpp
 * reranker GGUFs can return raw logits. Callers get normalized [0, 1]
 * scores either way.
 */

import { z } from 'zod';
import { LlmEndpointError } from './client.js';
import { logWarn } from '../errors.js';
import { backendLabel, scanForLlmBackends, type DetectedBackendKind } from '../installer/scan-backends.js';
import type { RerankerProviderConfig } from './reranker-client.js';
import { isContextWindowError, isInputTooLargeError } from './retry-policy.js';
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

/** Envelope of the Cohere-compat `/v1/rerank` response. `results` is
 *  validated as an array but its entries stay `unknown` here — each one
 *  is individually validated and range-checked in
 *  `scoresFromRerankResponse`, so a single malformed entry is dropped
 *  rather than failing the whole batch. (Entry validation stays
 *  hand-rolled rather than a zod schema: the wire field name `index` is
 *  a very common token, and emitting it as a schema property created a
 *  spurious cross-file name-match — `RegExp` `match.index` resolving to
 *  it — that tripped an unrelated `feature_envy` finding.) */
const RerankResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

interface RerankAbort {
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RerankFailureContext {
  readonly err: unknown;
  readonly query: string;
  readonly candidates: string[];
  readonly opts: { signal?: AbortSignal };
}

function throwIfRerankAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('rerank aborted');
}

function createRerankAbort(signal: AbortSignal | undefined, timeoutMs: number): RerankAbort {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  return { controller, timer };
}

async function assertRerankResponseOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  throw new LlmEndpointError(
    `rerank endpoint returned ${res.status}: ${text.slice(0, 200) || res.statusText}`,
    res.status,
  );
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
    throwIfRerankAborted(opts.signal);

    const abort = createRerankAbort(opts.signal, this.timeoutMs);
    try {
      return await this.fetchRerankScores(query, candidates, abort.controller.signal);
    } catch (err) {
      return await this.handleRerankFailure({ err, query, candidates, opts });
    } finally {
      clearTimeout(abort.timer);
    }
  }

  private async fetchRerankScores(
    query: string,
    candidates: readonly string[],
    signal: AbortSignal,
  ): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({
        model: this.cfg.model,
        query,
        documents: candidates,
      }),
      signal,
    });
    await assertRerankResponseOk(res);
    // A non-object body, or one whose `results` is absent/not an array,
    // is treated as a missing-shape ERROR (not an empty result set): a
    // reachable rerank endpoint that omits `results` is misconfigured,
    // and silently returning all-zero scores would hide that.
    const parsed = RerankResponseSchema.safeParse(await res.json());
    if (!parsed.success || !Array.isArray(parsed.data.results)) {
      throw new LlmEndpointError(
        `rerank endpoint returned a body without a \`results\` array. ` +
          'Backend may not implement the Cohere-compatible /v1/rerank shape.',
      );
    }
    return scoresFromRerankResponse(parsed.data.results, candidates.length);
  }

  private requestHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  private async handleRerankFailure({ err, query, candidates, opts }: RerankFailureContext): Promise<number[]> {
    if (isContextWindowError(err) || isInputTooLargeError(err)) {
      return this.retryOversizedRerank({ err, query, candidates, opts });
    }
    if (err instanceof LlmEndpointError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new Error('rerank aborted');
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmEndpointError(`rerank endpoint request failed: ${msg}`);
  }

  private async retryOversizedRerank({ err, query, candidates, opts }: RerankFailureContext): Promise<number[]> {
    if (candidates.length <= 1) {
      logWarn('Reranker: single candidate exceeded backend context/batch limit', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [0];
    }
    const mid = Math.ceil(candidates.length / 2);
    const left = await this.rerank(query, candidates.slice(0, mid), opts);
    if (opts.signal?.aborted) throw new Error('rerank aborted');
    const right = await this.rerank(query, candidates.slice(mid), opts);
    return [...left, ...right];
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

function scoresFromRerankResponse(results: readonly unknown[], candidateCount: number): number[] {
  // Fill scores in input order — backends may sort by score descending.
  const scores = new Array<number>(candidateCount).fill(0);
  const validEntries = results.filter((entry): entry is RerankResultEntry => isValidRerankEntry(entry, candidateCount));
  const normalized = normalizeRerankScores(validEntries.map((entry) => entry.relevance_score));
  for (let i = 0; i < validEntries.length; i++) {
    const entry = validEntries[i]!;
    scores[entry.index] = normalized[i] ?? 0;
  }
  return scores;
}

/** Validate one rerank result entry's structure and its index range
 *  (contextual — bounded by the request's candidate count). A malformed
 *  entry is dropped so the batch keeps its good ones. */
function isValidRerankEntry(entry: unknown, candidateCount: number): entry is RerankResultEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const { index, relevance_score } = entry as { index?: unknown; relevance_score?: unknown };
  return (
    typeof index === 'number' &&
    index >= 0 &&
    index < candidateCount &&
    typeof relevance_score === 'number' &&
    Number.isFinite(relevance_score)
  );
}

function normalizeRerankScores(rawScores: readonly number[]): number[] {
  if (rawScores.length === 0) return [];
  const alreadyNormalized = rawScores.every((score) => score >= 0 && score <= 1);
  if (alreadyNormalized) return [...rawScores];
  const min = Math.min(...rawScores);
  const max = Math.max(...rawScores);
  if (max === min) return rawScores.map(() => 1);
  return rawScores.map((score) => (score - min) / (max - min));
}
