/**
 * Phase 2 of CartographLlmService god_class refactor (design at
 * `project_cartograph_llm_service_refactor_plan.md`).
 *
 * Owns the embedding-side state and methods previously stored on
 * `CartographLlmService`:
 *   - `embeddingCache` — per-process matrix-fetch cache
 *   - `hnswByDim` — per-dim HNSW index cache (lazy-loaded from disk)
 *   - `embeddingFetcher` — adapter binding queries-embeddings free fns
 *   - `embedAll` — embed-only pass over indexed nodes
 *   - `runOptionalEmbedPhase` — embed phase stitched into summarizeAll
 *
 * Public callers reach `embedAll` through `cg.llm.embedAll()` (the
 * delegator on `CartographLlmService` forwards here). Internal
 * free-function callers (`llmSemanticTopK`, `tryLoadHnswForDim`) reach
 * the cache + fetcher fields via `svc.embed.embeddingCache` etc.
 */

import type { Cartograph } from '../index.js';
import { getAllEmbeddings, getEmbeddingsCount } from '../db/queries-embeddings.js';
import { createEmbeddingClient } from './embedding-client.js';
import { embedAllNodes, EmbeddingCache, type EmbeddingFetcher } from './embeddings.js';
import type { HnswIndex } from '../embeddings/hnsw-index.js';
import { logDebug, errMsg } from '../errors.js';
import type { ResolvedLlm } from './provider.js';
import type { LlmConfigManager } from './config-manager.js';

/** Default concurrency for the embed phase when caller doesn't override. */
/** Default concurrency for the embed pipeline — hardware-aware via
 *  `recommendedTuning().embed.cartographConcurrency`. On an
 *  M-series Mac with ≥ 16 GB unified memory this resolves to 8;
 *  conservative on smaller boxes. Users can override per call (CLI
 *  `--concurrency N` / programmatic options.concurrency) or
 *  permanently via `embeddingLlm.concurrency` in their config (which
 *  flows into this default via the precedence in `embedAll` /
 *  `runOptionalEmbedPhase` below). */
import { recommendedTuning } from '../installer/hardware-tuning.js';
const DEFAULT_EMBED_CONCURRENCY = recommendedTuning().embed.cartographConcurrency;

/** Per-phase embed result the orchestrator stitches into the
 *  surrounding summarise response. `failed` + `failureReason`
 *  surface unreachable-backend / thrown-error cases without
 *  bubbling. */
export interface EmbedResultRow {
  candidates: number;
  generated: number;
  errors: number;
  /**
   * Inputs the embed server rejected as too large to process in
   * its configured physical batch size — counted separately from
   * `errors` because they're a server-capability miss, not a
   * pipeline failure. The caller can surface this as an actionable
   * "increase --batch-size" hint.
   */
  skipped: number;
  durationMs: number;
  failed?: boolean;
  failureReason?: string;
}

export class EmbedPipeline {
  /** @internal Read by cartograph-llm-pass.ts (invalidate after embed phase). */
  embeddingCache = new EmbeddingCache();

  /**
   * Per-dim HNSW cache for query-time KNN. Lazy-loaded from disk on
   * first call at each dim; the on-disk index is (re)built by the
   * detached background embed phase (`runEmbedPhase`) and by
   * `buildSimilarToEdges` (subtask 8.4).
   *
   * Stores `null` for "tried, unavailable/stale, don't retry until
   * the next embed-phase invalidation" so we don't repeat the disk +
   * signature checks per query.
   *
   * @internal Read by llmSemanticTopK free function.
   */
  hnswByDim: Map<number, HnswIndex | null> = new Map();

  // Adapter that satisfies the structural EmbeddingFetcher interface
  // by binding the extracted queries-embeddings free functions to
  // this instance's QueryBuilder.
  /** @internal Read by llmSemanticTopK free function. */
  readonly embeddingFetcher: EmbeddingFetcher;

  constructor(
    private readonly cg: Cartograph,
    private readonly config: LlmConfigManager,
  ) {
    this.embeddingFetcher = {
      getAllEmbeddings: (model) => getAllEmbeddings(cg.queries, model),
      getEmbeddingsCount: (model) => getEmbeddingsCount(cg.queries, model),
    };
  }

  /**
   * Embed every indexed symbol that doesn't yet have an embedding for
   * the configured embedding model. Covers all nodes with kind NOT IN
   * ('file', 'import', 'export') — not just those with LLM-generated
   * summaries. Used by `cartograph embed` (CLI) for the embed-only
   * path — no chat / summarise work.
   *
   * Does NOT rebuild the on-disk HNSW index — that runs in the
   * detached background embed phase (`runEmbedPhase`). After a bare
   * `cartograph embed`, semantic search uses the vec0 / brute-force
   * fallback until the next index/sync triggers a background pass.
   *
   * Throws if no embedding provider is configured or reachable.
   */
  async embedAll(
    options: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ candidates: number; generated: number; errors: number; skipped: number; durationMs: number }> {
    const resolved = await this.config.resolveLlmConfig();
    if (!resolved?.embeddingLlm) {
      throw new Error('No embedding provider configured. Run `cartograph llm setup` or set config.llm.embeddingLlm.');
    }
    const client = createEmbeddingClient(resolved.embeddingLlm);
    const reachable = await client.isReachable();
    if (!reachable) {
      const cause = client.reachabilityError();
      const causeNote = cause ? ` Cause: ${cause}.` : '';
      throw new Error(`Embedding backend not reachable (${resolved.resolutionTrace}).${causeNote}`);
    }
    // Precedence: explicit caller flag > config-file override
    // (`embeddingLlm.concurrency`) > hardware-aware default.
    const cfgConcurrency = (resolved.embeddingLlm as { concurrency?: number }).concurrency;
    const result = await embedAllNodes({
      queries: this.cg.queries,
      client,
      embeddingModel: resolved.embeddingLlm.model,
      options: {
        signal: options.signal,
        concurrency: options.concurrency ?? cfgConcurrency ?? DEFAULT_EMBED_CONCURRENCY,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    });
    if (result.generated > 0) {
      this.embeddingCache.invalidate();
      this.hnswByDim.clear();
    }
    return {
      candidates: result.candidates,
      generated: result.generated,
      errors: result.errors,
      skipped: result.skipped,
      durationMs: result.durationMs,
    };
  }

  /**
   * Run the embed-after-summarise phase: probe reachability, embed
   * if reachable, fall back to a recorded failure-shape entry on
   * unreachable / thrown error. Pulled out of `summarizeAll`
   * so the if-reachable / else-try-catch chain doesn't sit 4-deep
   * under the outer method body.
   */
  async runOptionalEmbedPhase(
    resolved: ResolvedLlm,
    options: { signal?: AbortSignal; concurrency?: number },
  ): Promise<EmbedResultRow> {
    const embedT0 = Date.now();
    const embeddingClient = createEmbeddingClient(resolved.embeddingLlm ?? null);
    if (!(await embeddingClient.isReachable())) {
      return {
        candidates: 0,
        generated: 0,
        errors: 1,
        skipped: 0,
        durationMs: Date.now() - embedT0,
        failed: true,
        failureReason: 'embedding backend not reachable',
      };
    }
    try {
      const cfgConcurrency = (resolved.embeddingLlm as { concurrency?: number } | null)?.concurrency;
      const e = await embedAllNodes({
        queries: this.cg.queries,
        client: embeddingClient,
        embeddingModel: resolved.embeddingLlm!.model,
        options: {
          signal: options.signal,
          concurrency: options.concurrency ?? cfgConcurrency ?? DEFAULT_EMBED_CONCURRENCY,
        },
      });
      if (e.generated > 0) {
        this.embeddingCache.invalidate();
        this.hnswByDim.clear();
      }
      return {
        candidates: e.candidates,
        generated: e.generated,
        errors: e.errors,
        skipped: e.skipped,
        durationMs: e.durationMs,
      };
    } catch (err) {
      const reason = errMsg(err);
      logDebug('summarizeAll embed phase failed', { error: reason });
      return {
        candidates: 0,
        generated: 0,
        errors: 1,
        skipped: 0,
        durationMs: Date.now() - embedT0,
        failed: true,
        failureReason: reason,
      };
    }
  }
}
