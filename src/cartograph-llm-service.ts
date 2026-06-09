/**
 * LLM facade — slim shell over three sub-facades and a handful of
 * orchestration methods (summarize / embed / classify / ask / search).
 *
 * Constructed once in the Cartograph constructor and exposed as
 * `cg.llm`. Owns nothing directly except the back-references to the
 * three sub-facades and `bgCtrl`:
 *
 *   - `config: LlmConfigManager` — resolved-LLM cache,
 *     resolveLlmConfig / hasLlm / getEffectiveLlmConfig.
 *   - `embed: EmbedPipeline` — embeddingCache / hnswByDim /
 *     embeddingFetcher / embedAll / runOptionalEmbedPhase.
 *   - `bgCtrl: BgSummaryController` — background pass lifecycle
 *     (start / cancel / progress / await), the four LLM phases.
 *
 * History: the class previously bundled all of those fields directly,
 * which fired the god_class biomarker (16 members). The facade-split
 * landed in two phases:
 *   1. Wave 0 — extracted to free functions in this file
 *      (`localChat` → `llmLocalChat`, `semanticTopK` →
 *      `llmSemanticTopK`); pattern `fn(svc, ...args)` matches the
 *      existing free fns (llmFindDeadCode, etc).
 *   2. Wave 2 — extracted LlmConfigManager (`./llm/config-manager.ts`)
 *      and EmbedPipeline (`./llm/embed-pipeline.ts`). The four
 *      pre-extraction public method names (`resolveLlmConfig`,
 *      `hasLlm`, `getEffectiveLlmConfig`, `embedAll`) survive as thin
 *      `@deprecated` delegators so the public API didn't break.
 */

import type { Cartograph } from './index.js';
import type { SearchOptions, SearchResult } from './search/types.js';
import { getEmbeddingForNode } from './db/queries-embeddings.js';
import { searchNodes } from './db/queries-search.js';
import { LlmClient } from './llm/client.js';
import { createEmbeddingClient, type EmbeddingProvider } from './llm/embedding-client.js';
import { summarizeAll as summarizeAllSymbols } from './llm/summarizer.js';
import { classifyAllRoles, type ClassifierResult } from './llm/classifier.js';
import { HnswIndex, computeRowsetSignature } from './embeddings/hnsw-index.js';
import path from 'node:path';
import * as fsp from 'node:fs/promises';
import { askWithCandidates, type AskResult } from './llm/ask.js';
import {
  summarizeChange as summarizeChangeIntent,
  type ChangeIntentOptions,
  type ChangeIntentResult,
} from './llm/change-intent.js';
import { judgeDeadCode, type DeadCodeOptions, type DeadCodeResult } from './llm/dead-code.js';
import { checkNamingConvention, type NamingCheckResult } from './llm/naming.js';
import type { ResolvedLlm } from './llm/provider.js';
import {
  probeChatBackend,
  runSummaryPhase,
  runCommitIntentResiduePhase,
  runEmbedPhase,
  runFileSummaryPhase,
  runDirectorySummaryPhase,
  runClassifyPhase,
  runStructuralPhase,
  runNeighborPropagationPhase,
} from './cartograph-llm-pass.js';
import { logDebug, logWarn } from './errors.js';
import { LlmConfigManager } from './llm/config-manager.js';
import { EmbedPipeline, type EmbedResultRow } from './llm/embed-pipeline.js';

interface AskOptions {
  /** Max retrieved candidates to consider. */
  retrieveK?: number;
  /** Override the default ask model temperature. */
  temperature?: number;
  /** Cap on response tokens. */
  maxTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Route to the higher-stakes ask model when configured. */
  useAskModel?: boolean;
}

/**
 * Cap (3) on FTS results per symbol name in hybrid-search fallback.
 * Keeps a polyglot monorepo's 12 different `Encode` implementations
 * from monopolising the result set when a query nominally matches all
 * of them — the user almost always wants different *kinds* of
 * context, not 12 nearly-identical hits.
 */
const FTS_PER_NAME_CAP = 3;

/**
 * Provider-aware default summary batch size for `summarizeAll`.
 * Cloud providers (claude-bridge, anthropic-api) eat per-request
 * latency, so batch=3 amortises the round-trip cost. The in-process
 * openai-compat backend gets zero speedup from batching but pays the quality
 * cost — keep it at 1.
 */
const HIGH_LATENCY_SUMMARY_BATCH = 3;
const LOW_LATENCY_SUMMARY_BATCH = 1;
const HIGH_LATENCY_PROVIDERS: ReadonlySet<string> = new Set(['claude-bridge', 'anthropic-api']);

function isHighLatencyChatProvider(provider: string | undefined): boolean {
  return provider !== undefined && HIGH_LATENCY_PROVIDERS.has(provider);
}

/**
 * Hard cap on prompt length for `localChat`. 64k chars ≈ 16k tokens
 * at conservative bytes-per-token, which fits a typical local-LLM
 * context window with room for output. Prevents the agent from
 * accidentally feeding e.g. a whole repo dump into the local model.
 */
const LOCAL_CHAT_MAX_PROMPT_CHARS = 64_000;

// searchHybrid sizing — over-fetch from each retrieval source so the
// reciprocal-rank-fusion step has enough overlap to surface high-rank
// candidates that appear in only one of the two streams.
const HYBRID_DEFAULT_LIMIT = 20;
const HYBRID_FETCH_FLOOR = 50;
const HYBRID_FETCH_MULTIPLIER = 3;

function diversifyByName(results: SearchResult[], limit: number): SearchResult[] {
  const perName = new Map<string, number>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= limit) break;
    const n = (perName.get(r.node.name) ?? 0) + 1;
    if (n > FTS_PER_NAME_CAP) continue;
    perName.set(r.node.name, n);
    out.push(r);
  }
  return out;
}

// EmbedResultRow moved to `./llm/embed-pipeline.ts`; re-imported above.

/**
 * Owns the background-summarisation lifecycle fields and methods.
 * Extracted from `CartographLlmService` to reduce its member count.
 * Holds a back-reference to the service for `resolveLlmConfig` access.
 */
class BgSummaryController {
  private abort: AbortController | null = null;
  /** @internal Read by callers checking whether a pass is in flight. */
  promise: Promise<void> | null = null;
  private dirty: boolean = false;
  /** @internal Mutated by cartograph-llm-pass.ts; read by getProgress(). */
  progress: {
    phase: 'structural' | 'summarise' | 'embed' | 'neighbor' | 'file' | 'directory' | 'classify';
    done: number;
    total: number;
  } | null = null;

  constructor(private readonly svc: CartographLlmService) {}

  /** Cancel in-flight background work and reset the lifecycle state. */
  cancel(): void {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    this.promise = null;
    this.dirty = false;
    this.progress = null;
  }

  /**
   * Kick off a summarisation pass in the background. Returns
   * immediately — does NOT block the caller. Subsequent calls while
   * one is already running are no-ops (returns the existing promise).
   */
  start(): Promise<void> {
    if (this.promise) {
      this.dirty = true;
      return this.promise;
    }

    const controller = new AbortController();
    this.abort = controller;
    this.dirty = false;

    const run = async (): Promise<void> => {
      try {
        await this.runPasses(controller);
      } catch (err) {
        logWarn('Background summarisation failed', { error: String(err) });
      } finally {
        this.finalize(controller, pending);
      }
    };

    const pending = run();
    this.promise = pending;
    return pending;
  }

  /**
   * Drive the four LLM phases in order, honouring the abort signal
   * between each.
   *
   * Phase ordering — embed BEFORE summarise — is deliberate.
   * Pre-migration 033, embed had to wait for summarise because the
   * embed text was sourced from the summary. After decoupling, embed
   * sources name + signature + docstring directly, so it has no
   * dependency on summarise. Running embed first gets
   * `cartograph_search(mode='semantic')` hot in minutes (local
   * nomic-embed is ~3 min on a 7K-node repo) instead of hours
   * (Qwen3-Coder summary pass at ~2-4s/node).
   *
   * Cost: nodes that gain a summary AFTER their embedding ran will
   * have an embed text that didn't include the summary. The
   * `getEmbeddableNodes` staleness check is keyed on
   * files.content_hash, not summary presence, so the embedding
   * doesn't auto-refresh when a summary is later added. A future
   * `summary_hash_at_embed` column on symbol_embeddings can close
   * this — tracked as a follow-up.
   */
  private async runPasses(controller: AbortController): Promise<void> {
    const resolved = await this.svc.config.resolveLlmConfig();
    if (!resolved || controller.signal.aborted) return;

    // claude-bridge: subprocess startup overhead → 4 in flight.
    // openai-compat / anthropic-api: not subprocess-bound → 8.
    const chatConcurrency = resolved.summarizeLlm?.provider === 'claude-bridge' ? 4 : 8;
    const hasChat = Boolean(resolved.summarizeLlm);
    const client = new LlmClient(resolved);
    const embeddingClient = createEmbeddingClient(resolved.embeddingLlm ?? null);

    if (hasChat && !(await probeChatBackend(client, resolved, controller))) return;
    if (controller.signal.aborted) return;

    const phaseCtx = { svc: this.svc, client, embeddingClient, resolved, controller };
    await this.runEmbedGroup(phaseCtx, hasChat, chatConcurrency);
  }

  /** Runs the ordered sequence of LLM phases (structural → embed → chat → classify). */
  private async runEmbedGroup(
    phaseCtx: Parameters<typeof runStructuralPhase>[0],
    hasChat: boolean,
    chatConcurrency: number,
  ): Promise<void> {
    const { resolved, controller } = phaseCtx;
    const hasEmbedding = Boolean(resolved.embeddingLlm);
    // Phase 0: structural — deterministic synthetic summaries for
    // routes/forwarders/getters/factories/re-exports the LLM phase
    // would skip. No LLM, no chat backend; runs even when `hasChat`
    // is false. Cheap (O(candidates) + a few SQL scans), so always-on.
    if (!controller.signal.aborted) await runStructuralPhase(phaseCtx);
    // Phase 1: initial embed — semantic search becomes hot here. Builds
    // embed text from name + signature + docstring (no summary yet).
    if (hasEmbedding && !controller.signal.aborted) await runEmbedPhase(phaseCtx);
    // Phase 1.5: neighbor propagation — borrow summaries from
    // embedding-cosine neighbors of the same kind. Free coverage for
    // unsummarised nodes whose top-1 neighbor crossed the threshold.
    // Requires embeddings to exist; skipped when phase 1 is no-op.
    if (hasEmbedding && !controller.signal.aborted) await runNeighborPropagationPhase(phaseCtx);
    await this.runChatGroup({ phaseCtx, hasChat, hasEmbedding, chatConcurrency });
  }

  /** Runs the chat-dependent phases (summarise → refresh embed → file → directory → classify). */
  private async runChatGroup(args: {
    phaseCtx: Parameters<typeof runStructuralPhase>[0];
    hasChat: boolean;
    hasEmbedding: boolean;
    chatConcurrency: number;
  }): Promise<void> {
    const { phaseCtx, hasChat, hasEmbedding, chatConcurrency } = args;
    const { controller } = phaseCtx;
    // Phase 2: summarise — slow LLM pass; runs in background while
    // semantic search is already serving.
    if (hasChat && !controller.signal.aborted) await runSummaryPhase(phaseCtx, chatConcurrency);
    // Phase 3: refresh embed — picks up exactly the nodes whose
    // summary changed during phase 2 (`getEmbeddableNodes` predicate
    // detects `summary_hash_at_embed` drift). No-op for nodes that
    // didn't gain or change a summary.
    if (hasEmbedding && !controller.signal.aborted) await runEmbedPhase(phaseCtx);
    if (hasChat && !controller.signal.aborted) await runFileSummaryPhase(phaseCtx);
    if (hasChat && !controller.signal.aborted) await runDirectorySummaryPhase(phaseCtx);
    if (hasChat && !controller.signal.aborted) await runClassifyPhase(phaseCtx, chatConcurrency);
    // Phase 5: LLM-reclassify the commit-intent `unknown` residue the
    // heuristic cochange hook couldn't label. Cheap — the residue is
    // small and each call is a one-token classification.
    if (hasChat && !controller.signal.aborted) await runCommitIntentResiduePhase(phaseCtx);
  }

  /** Reset bg-summary state and re-fire if `dirty` was set during the pass. */
  private finalize(controller: AbortController, pending: Promise<void>): void {
    if (this.abort === controller) {
      this.abort = null;
    }
    if (this.promise !== pending) return;
    this.promise = null;
    this.progress = null;
    if (this.dirty && !controller.signal.aborted) {
      this.dirty = false;
      void this.start();
    }
  }

  /** Live progress for the running background pass. Returns `null` when idle. */
  getProgress(): {
    phase: 'structural' | 'summarise' | 'embed' | 'neighbor' | 'file' | 'directory' | 'classify';
    done: number;
    total: number;
  } | null {
    return this.progress;
  }

  /** Wait for any background summarisation to finish. */
  async awaitCompletion(): Promise<void> {
    if (this.promise) await this.promise;
  }
}

/** Return type of {@link CartographLlmService.summarizeAll}. */
interface SummarizeAllResult {
  candidates: number;
  generated: number;
  cacheHits: number;
  errors: number;
  /** Lever C — candidates left for the demand-driven priority queue
   *  because the eager-limit was reached. 0 when the pass ran uncapped
   *  or finished within budget. */
  deferred: number;
  durationMs: number;
  embed?: EmbedResultRow | null;
}

export class CartographLlmService {
  /**
   * Config + provider-resolution facade (Phase 1 of the god_class
   * decomposition). Public callers can reach `cg.llm.config.X()`
   * directly; the three legacy delegators below preserve the old
   * `cg.llm.X()` shape.
   */
  readonly config: LlmConfigManager;

  /**
   * Embedding pipeline facade (Phase 2 of the god_class
   * decomposition). Owns the embedding cache, HNSW per-dim cache,
   * embedding-fetcher adapter, and the embed-only / embed-after-
   * summarise pipelines. The free functions in this file reach
   * cache state via `svc.embed.embeddingCache` / `svc.embed.hnswByDim`.
   */
  readonly embed: EmbedPipeline;

  /** Background-summarisation lifecycle controller. */
  readonly bgCtrl: BgSummaryController;

  constructor(
    /** @internal Read by cartograph-llm-pass.ts to reach queries/projectRoot. */
    readonly cg: Cartograph,
  ) {
    this.config = new LlmConfigManager(cg);
    this.embed = new EmbedPipeline(cg, this.config);
    this.bgCtrl = new BgSummaryController(this);
  }

  /**
   * @deprecated Prefer `cg.llm.config.resolveLlmConfig()`. Thin
   * delegator preserved for backward compatibility with existing
   * call-sites; new code should reach the config facade directly.
   */
  async resolveLlmConfig(forceReload = false): Promise<ResolvedLlm | null> {
    return this.config.resolveLlmConfig(forceReload);
  }

  /**
   * Run a full symbol-summarisation pass over the indexed nodes via the
   * configured (or auto-detected) local LLM endpoint. Cached per node
   * by content_hash, so repeated calls only generate new/changed
   * summaries — first run is the slow one.
   *
   * Throws if no LLM is reachable. Use {@link hasLlm} (sync, config
   * only) or await {@link getEffectiveLlmConfig} (async, includes
   * auto-detect) before calling.
   */
  async summarizeAll(
    options: {
      onProgress?: (done: number, total: number) => void;
      signal?: AbortSignal;
      concurrency?: number;
      summaryBatchSize?: number;
      /** Lever C — eager-summary cap. When omitted, falls back to
       *  `config.llm.summarizeEagerLimit` so an explicit `admin summarize`
       *  and the background pass reach the same end state. Pass `Infinity`
       *  (e.g. `admin summarize --all`) for a full uncapped pass. */
      eagerLimit?: number;
    } = {},
  ): Promise<SummarizeAllResult> {
    const { resolved, client, summaryBatchSize } = await llmPrepareSummarizeClient(this, options.summaryBatchSize);
    // Default the eager-limit from config when the caller didn't set one.
    const eagerLimit = options.eagerLimit ?? this.cg.config.llm?.summarizeEagerLimit;
    const summaryResult = await summarizeAllSymbols({
      projectRoot: this.cg.projectRoot,
      queries: this.cg.queries,
      client,
      modelLabel: resolved.summarizeLlm.model,
      // Conditional spread — `exactOptionalPropertyTypes` rejects an
      // explicit `eagerLimit: undefined`.
      options: { ...options, summaryBatchSize, ...(eagerLimit === undefined ? {} : { eagerLimit }) },
    });
    const embedResult =
      resolved.embeddingLlm && !options.signal?.aborted
        ? await this.embed.runOptionalEmbedPhase(resolved, options)
        : null;
    // FRICTION-43 parity: populate the file-summary tier so `admin summarize`
    // produces the same end state as `admin sync` (which runs runFileSummaryPhase
    // as part of runChatGroup). Cheap when no file content changed.
    if (!options.signal?.aborted) {
      const { summarizeAllFiles } = await import('./llm/file-summarizer.js');
      const { pruneOrphanFileSummaries } = await import('./db/queries-file-summaries.js');
      await summarizeAllFiles({
        projectRoot: this.cg.projectRoot,
        queries: this.cg.queries,
        client,
        modelLabel: resolved.summarizeLlm.model,
        options: {
          concurrency: 1,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      });
      if (!options.signal?.aborted) pruneOrphanFileSummaries(this.cg.queries);
    }
    // FRICTION-43: `admin summarize` (and any other caller of
    // `summarizeAll`) used to skip the directory-summary phase that
    // `admin sync` runs as part of `runChatGroup`. That left
    // `directory_summaries` stale after content edits — operators
    // running `summarize` to refresh prose got surprised when
    // `cartograph_files({format: 'module'})` still served old paragraphs. Run it here so
    // both surfaces produce the same end state. Cheap when no
    // directories changed (content-hash short-circuits the LLM call).
    if (!options.signal?.aborted) {
      const { summarizeAllDirectories } = await import('./llm/dir-summarizer.js');
      const { pruneOrphanDirectorySummaries } = await import('./db/queries-directory-summaries.js');
      await summarizeAllDirectories({
        projectRoot: this.cg.projectRoot,
        queries: this.cg.queries,
        client,
        modelLabel: resolved.summarizeLlm.model,
        options: {
          concurrency: 1,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      });
      if (!options.signal?.aborted) pruneOrphanDirectorySummaries(this.cg.queries);
    }
    return { ...summaryResult, embed: embedResult };
  }

  /**
   * Embed every indexed symbol that doesn't yet have an embedding for
   * the configured embedding model. Covers all nodes with kind NOT IN
   * ('file', 'import', 'export') — not just those with LLM-generated
   * summaries. Used by `cartograph embed` (CLI) for the embed-only
   * path — no chat / summarise work.
   *
   * @deprecated Prefer `cg.llm.embed.embedAll()`. Thin delegator
   * preserved for backward compatibility.
   */
  async embedAll(
    options: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ candidates: number; generated: number; errors: number; skipped: number; durationMs: number }> {
    return this.embed.embedAll(options);
  }

  /**
   * Run the role-classification phase over symbols with a non-empty
   * description (summary if present, else docstring — the cascade)
   * that don't yet have a role from the active model. Used by
   * `cartograph classify` (CLI) for the classify-only path — no chat
   * summarise work, no embed work, just the classifier pass.
   *
   * Idempotent. Throws if no summarize provider is configured or reachable.
   */
  async classifyAll(
    options: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<ClassifierResult> {
    const resolved = await this.config.resolveLlmConfig();
    if (!resolved?.summarizeLlm) {
      throw new Error('No summarize provider configured. Run `cartograph llm setup` or set config.llm.summarizeLlm.');
    }
    const client = new LlmClient(resolved);
    if (!(await client.isReachable())) {
      throw new Error(`Summarize backend not reachable (${resolved.resolutionTrace}).`);
    }
    return classifyAllRoles({
      queries: this.cg.queries,
      client,
      modelLabel: resolved.summarizeLlm.model,
      options: {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    });
  }

  /**
   * @deprecated Prefer `cg.llm.config.hasLlm()`. Thin delegator
   * preserved for backward compatibility.
   */
  hasLlm(): boolean {
    return this.config.hasLlm();
  }

  /**
   * @deprecated Prefer `cg.llm.config.getEffectiveLlmConfig()`. Thin
   * delegator preserved for backward compatibility.
   */
  async getEffectiveLlmConfig(): Promise<ResolvedLlm | null> {
    return this.config.getEffectiveLlmConfig();
  }

  // Background summarisation is fully managed by bgCtrl (BgSummaryController).
  // Public API: cg.llm.bgCtrl.start() / .cancel() / .awaitCompletion() / .getProgress() / .promise

  /**
   * Natural-language Q&A over the codebase. Hybrid-retrieves the
   * top-K most relevant symbols, builds a context prompt, and asks
   * the configured/auto-detected ask model.
   *
   * Throws if no LLM is reachable. Use {@link getEffectiveLlmConfig}
   * to check before calling for a graceful UX.
   */
  async ask(question: string, options: AskOptions = {}): Promise<AskResult> {
    const resolved = await this.config.resolveLlmConfig();
    if (!resolved?.summarizeLlm) {
      throw new Error(
        'No ask provider configured for cartograph_ask. Run `cartograph llm setup` or set config.llm.summarizeLlm.',
      );
    }
    const client = new LlmClient(resolved);
    if (!(await client.isReachable())) {
      throw new Error(`Ask backend not reachable (${resolved.resolutionTrace}).`);
    }

    const k = options.retrieveK ?? 12;
    const { results: candidates, rerankOutcome } = await this.searchHybridWithOutcome(question, { limit: k });

    const result = await askWithCandidates({
      projectRoot: this.cg.projectRoot,
      question,
      candidates,
      queries: this.cg.queries,
      client,
      options: { ...options, useAskModel: true },
    });
    return { ...result, rerankOutcome };
  }

  /**
   * Hybrid search: blends FTS5 lexical results with cosine semantic
   * results via Reciprocal Rank Fusion. Falls back to FTS-only when
   * no embedding model is configured/auto-detected.
   */
  async searchHybrid(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const { results } = await this.searchHybridWithOutcome(query, options);
    return results;
  }

  /**
   * Like {@link searchHybrid} but also returns the {@link RerankOutcome}
   * from the cross-encoder pass. Used by {@link ask} to surface reranker
   * observability in the retrieval footer.
   */
  async searchHybridWithOutcome(
    query: string,
    options?: SearchOptions,
  ): Promise<{ results: SearchResult[]; rerankOutcome: RerankOutcome }> {
    const limit = options?.limit ?? HYBRID_DEFAULT_LIMIT;
    const fetchLimit = Math.max(HYBRID_FETCH_FLOOR, limit * HYBRID_FETCH_MULTIPLIER);
    const ftsResults = searchNodes(this.cg.queries, query, { ...options, limit: fetchLimit });

    const resolved = await this.config.resolveLlmConfig();
    if (!resolved?.embeddingLlm) {
      return {
        results: diversifyByName(ftsResults, limit),
        rerankOutcome: { kind: 'skipped-no-config' },
      };
    }

    const client = createEmbeddingClient(resolved.embeddingLlm);
    return searchHybridBlendWithEmbeddings({
      svc: this,
      query,
      ftsResults,
      client,
      embeddingsCfg: resolved.embeddingLlm,
      resolved,
      limit,
      fetchLimit,
    });
  }
}

// ===========================================================================
// Free-standing CartographLlmService utility functions (extracted to reduce
// god_class member count). Pattern: fn(svc, ...args).
// ===========================================================================

/**
 * One-shot chat against the configured local backend, no retrieval,
 * no grounding, no special prompt template. The agent-facing surface
 * (`cartograph_ask({mode: 'local_chat'})`) routes here so bulk prose subtasks (file
 * summarization, draft prose, paraphrase verification) can run on the
 * user's local LLM instead of paying Anthropic-token cost.
 *
 * NOT for: hard reasoning, anything user-visible verbatim, work where
 * wrong-but-confident output is worse than no output. The tool
 * description spells this out for the agent picker; this function
 * just enforces hard limits (prompt length cap, reachability) and
 * forwards.
 *
 * Throws if no summarize provider is configured, the prompt exceeds
 * the length cap, or the backend isn't reachable.
 */
export async function llmLocalChat(
  svc: CartographLlmService,
  args: {
    prompt: string;
    system?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<{ text: string; durationMs: number; model: string }> {
  if (args.prompt.length > LOCAL_CHAT_MAX_PROMPT_CHARS) {
    throw new Error(
      `prompt exceeds ${LOCAL_CHAT_MAX_PROMPT_CHARS}-char cap (got ${args.prompt.length}). ` +
        `local_chat is for bulk prose subtasks; for larger inputs, slice the work and call multiple times.`,
    );
  }
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.summarizeLlm) {
    throw new Error('No summarize provider configured. Run `cartograph llm setup` or set config.llm.summarizeLlm.');
  }
  const client = new LlmClient(resolved);
  if (!(await client.isReachable())) {
    throw new Error(`Local backend not reachable (${resolved.resolutionTrace}).`);
  }
  const messages = [
    ...(args.system ? [{ role: 'system' as const, content: args.system }] : []),
    { role: 'user' as const, content: args.prompt },
  ];
  // Route through the local-chat carve-out when configured. The
  // useLocalChat flag is a no-op when localChat is unset, so legacy
  // single-provider configs (chat-only) keep working unchanged.
  const result = await client.chat(messages, {
    useLocalChat: true,
    ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  // Report the model that ACTUALLY served the call so the response
  // trailer ("local-chat: model • Nms") reflects routing. When
  // localChat override is configured, that's the model that ran.
  const servingModel = resolved.localLlm?.model ?? resolved.summarizeLlm.model;
  return { text: result.text, durationMs: result.durationMs, model: servingModel };
}

interface SemanticTopKArgs {
  svc: CartographLlmService;
  queryVec: Float32Array;
  model: string;
  k: number;
}

/**
 * Lazy-load the HNSW index for one embedding dim from disk. Returns
 * null when:
 *   - the optional USearch dep is missing,
 *   - no `hnsw_meta` row exists for this dim (the embed phase hasn't built one yet),
 *   - the on-disk file is missing (out-of-band delete or fresh project),
 *   - the meta signature doesn't match the live rowset (stale; the next embed phase rebuilds).
 *
 * The result is cached on `svc.embed.hnswByDim` (including null misses) so
 * subsequent queries skip the disk + signature checks. The cache is
 * cleared by the embed phase via `svc.embed.hnswByDim.clear()`.
 */
async function tryLoadHnswForDim(svc: CartographLlmService, dim: number): Promise<HnswIndex | null> {
  if (svc.embed.hnswByDim.has(dim)) return svc.embed.hnswByDim.get(dim) ?? null;

  const db = svc.cg.db.getDb();
  let meta: { row_count: number; max_rowid: number; file_path: string } | undefined;
  try {
    meta = db.prepare(`SELECT row_count, max_rowid, file_path FROM hnsw_meta WHERE dim = ?`).get(dim) as
      | { row_count: number; max_rowid: number; file_path: string }
      | undefined;
  } catch (err) {
    // Swallow ONLY the "table missing" shape — fresh installs without
    // migration 042 OR test stub DBs that bypass migrations land here,
    // and the caller's vec0 fallback is correct in both cases. Re-throw
    // anything else (SQLITE_CORRUPT, SQLITE_IOERR, etc.) so genuine DB
    // failures aren't masked.
    if (err instanceof Error && err.message.includes('no such table')) {
      svc.embed.hnswByDim.set(dim, null);
      return null;
    }
    throw err;
  }
  if (!meta) {
    svc.embed.hnswByDim.set(dim, null);
    return null;
  }
  const sig = computeRowsetSignature(db, dim);
  if (sig.rowCount !== meta.row_count || sig.maxRowid !== meta.max_rowid) {
    svc.embed.hnswByDim.set(dim, null);
    return null;
  }
  const filePath = path.isAbsolute(meta.file_path) ? meta.file_path : path.join(svc.cg.projectRoot, meta.file_path);
  const fileExists = await fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (!fileExists) {
    svc.embed.hnswByDim.set(dim, null);
    return null;
  }
  const idx = await HnswIndex.create(dim);
  if (!idx) {
    svc.embed.hnswByDim.set(dim, null);
    return null;
  }
  if (!idx.load(filePath, db)) {
    svc.embed.hnswByDim.set(dim, null);
    return null;
  }
  svc.embed.hnswByDim.set(dim, idx);
  return idx;
}

/** Cosine-similarity floor below which the symbol-grain top hit
 *  is treated as low-confidence, triggering a merge with file-grain
 *  hits to widen recall. The number is borrowed from
 *  `DEFAULT_SIMILAR_MIN_SCORE` (the similar_to edge-emission floor)
 *  but lives behind its own name because retrieval-quality tuning
 *  and edge-emission tuning are independent concerns. */
const FILE_FALLBACK_SCORE_THRESHOLD = 0.6;
/** When file-grain hits get merged in, multiply their score by this
 *  factor so a confident symbol match still ranks above a weakly-
 *  similar file match at the same raw cosine. */
const FILE_GRAIN_SCORE_WEIGHT = 0.85;

/**
 * Partition KNN hits by node grain (symbol vs file). Single SQL hit
 * to look up `nodes.kind` for every result; cheap relative to the
 * vector lookup cost and avoids reshaping the HNSW index per grain.
 */
function partitionHitsByGrain(
  svc: CartographLlmService,
  hits: Array<{ nodeId: string; distance: number }>,
): { symbol: typeof hits; file: typeof hits } {
  if (hits.length === 0) return { symbol: [], file: [] };
  const ids = hits.map((h) => h.nodeId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = svc.cg.db
    .getDb()
    .prepare(`SELECT id, kind FROM nodes WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; kind: string }>;
  const kindById = new Map(rows.map((r) => [r.id, r.kind]));
  const symbol: typeof hits = [];
  const file: typeof hits = [];
  for (const h of hits) {
    if (kindById.get(h.nodeId) === 'file') file.push(h);
    else symbol.push(h);
  }
  return { symbol, file };
}

/**
 * Symbol-first / file-fallback merge. When the symbol-grain result
 * is plentiful (≥k hits) AND high-confidence (top score ≥ threshold),
 * return symbol-only — preserves prior behaviour for typical
 * name/concept queries. Otherwise weight the file-grain hits down
 * by {@link FILE_GRAIN_SCORE_WEIGHT}, merge with symbol hits, sort
 * by score, and take the top K. Keeps the existing
 * `(nodeId, score)` callsite shape so downstream consumers see
 * file-kind nodes in the result and can filter by kind themselves.
 */
function mergeMultiGrainHits(
  svc: CartographLlmService,
  rawHits: Array<{ nodeId: string; distance: number }>,
  k: number,
): Array<{ nodeId: string; score: number }> {
  const { symbol, file } = partitionHitsByGrain(svc, rawHits);
  const topSymbolScore = symbol[0] ? 1 - symbol[0].distance : 0;
  const symbolIsConfident = symbol.length >= k && topSymbolScore >= FILE_FALLBACK_SCORE_THRESHOLD;
  if (symbolIsConfident) {
    return symbol.slice(0, k).map((h) => ({ nodeId: h.nodeId, score: 1 - h.distance }));
  }
  const merged: Array<{ nodeId: string; score: number }> = [
    ...symbol.map((h) => ({ nodeId: h.nodeId, score: 1 - h.distance })),
    ...file.map((h) => ({ nodeId: h.nodeId, score: (1 - h.distance) * FILE_GRAIN_SCORE_WEIGHT })),
  ];
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, k);
}

/**
 * Top-K cosine semantic search shared between `llmFindImplementations`,
 * `llmFindSimilar`, and `searchHybrid`. Routing order:
 *   1. pgvector on PostgreSQL when the optional extension is available.
 *   2. HNSW (when an up-to-date on-disk index for this dim exists)
 *      with symbol-first / file-fallback grain merging.
 *   3. vec0 brute force (when sqlite-vec is loaded).
 *   4. in-memory `EmbeddingCache` brute-force scan.
 *
 * The HNSW path over-fetches by 3x to give the grain merge enough
 * material to pick from; the cap at 100 keeps the SQL kind-lookup
 * cheap even at large k.
 */
/** HNSW over-fetch sizing — request more candidates than `k` so the
 *  multi-grain merge has room to dedup chunk-level hits without dropping
 *  ranks. `OVERFETCH_MULTIPLIER` sets the proportional headroom; the
 *  `+ OVERFETCH_PAD` term keeps small-k queries from over-tightening
 *  (e.g. k=2 → 6 candidates instead of 6 vs 2*3=6). The result is
 *  capped by `OVERFETCH_CAP` so very large k (or k≈index size) doesn't
 *  blow the HNSW efSearch budget. */
const OVERFETCH_MULTIPLIER = 3;
const OVERFETCH_PAD = 5;
const OVERFETCH_CAP = 100;

export async function llmSemanticTopK(args: SemanticTopKArgs): Promise<Array<{ nodeId: string; score: number }>> {
  const { svc, queryVec, model, k } = args;
  const pgvector = await tryPgvectorSemanticTopK(args);
  if (pgvector.length > 0) return pgvector;

  const hnsw = await tryHnswSemanticTopK(args);
  if (hnsw.length > 0) return hnsw;

  const vec = await tryVecSemanticTopK(args);
  if (vec.length > 0) return vec;

  const cached = svc.embed.embeddingCache.get(svc.embed.embeddingFetcher, model);
  if (cached.ids.length === 0) return [];
  const { topKByCosineMatrix } = await import('./llm/embeddings.js');
  return topKByCosineMatrix({ query: queryVec, matrix: cached.matrix, ids: cached.ids, dim: cached.dim, k });
}

async function tryPgvectorSemanticTopK({
  svc,
  queryVec,
  model,
  k,
}: SemanticTopKArgs): Promise<Array<{ nodeId: string; score: number }>> {
  if (!usesPostgresBackend(svc)) return [];
  const { findSimilarViaPgvector } = await import('./db/pgvector-helpers.js');
  const rawHits = findSimilarViaPgvector({
    db: svc.cg.db.getDb(),
    queryVec,
    model,
    k: semanticOverfetchK(k),
    grain: 'all',
  });
  return mergeRawSemanticHits(svc, rawHits, k);
}

async function tryHnswSemanticTopK({
  svc,
  queryVec,
  model,
  k,
}: SemanticTopKArgs): Promise<Array<{ nodeId: string; score: number }>> {
  const hnsw = await tryLoadHnswForDim(svc, queryVec.length);
  if (!hnsw) return [];
  return mergeRawSemanticHits(svc, hnsw.query(queryVec, semanticOverfetchK(k), model), k);
}

async function tryVecSemanticTopK({
  svc,
  queryVec,
  model,
  k,
}: SemanticTopKArgs): Promise<Array<{ nodeId: string; score: number }>> {
  if (!svc.cg.db.hasVecExtension()) return [];
  const { findSimilarViaVec } = await import('./db/vec-helpers.js');
  const hits = findSimilarViaVec({ db: svc.cg.db.getDb(), vecLoaded: true, queryVec, model, k });
  return hits.map((h) => ({ nodeId: h.nodeId, score: 1 - h.distance }));
}

function mergeRawSemanticHits(
  svc: CartographLlmService,
  rawHits: Array<{ nodeId: string; distance: number }>,
  k: number,
): Array<{ nodeId: string; score: number }> {
  return rawHits.length === 0 ? [] : mergeMultiGrainHits(svc, rawHits, k);
}

function semanticOverfetchK(k: number): number {
  return Math.min(Math.max(k * OVERFETCH_MULTIPLIER, k + OVERFETCH_PAD), OVERFETCH_CAP);
}

function usesPostgresBackend(svc: CartographLlmService): boolean {
  return typeof svc.cg.db.getBackend === 'function' && svc.cg.db.getBackend() === 'postgres';
}

/**
 * Resolve + validate the chat provider and compute the effective summary
 * batch size. Extracted from {@link CartographLlmService.summarizeAll} to
 * keep that method under the large_method line threshold.
 */
async function llmPrepareSummarizeClient(
  svc: CartographLlmService,
  callerBatchSize: number | undefined,
): Promise<{
  resolved: ResolvedLlm & { summarizeLlm: NonNullable<ResolvedLlm['summarizeLlm']> };
  client: LlmClient;
  summaryBatchSize: number;
}> {
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.summarizeLlm) {
    throw new Error('No summarize provider configured. Run `cartograph llm setup` or set config.llm.summarizeLlm.');
  }
  const client = new LlmClient(resolved);
  if (!(await client.isReachable())) {
    throw new Error(`Summarize backend not reachable (${resolved.resolutionTrace}).`);
  }
  const providerDefault = isHighLatencyChatProvider(resolved.summarizeLlm.provider)
    ? HIGH_LATENCY_SUMMARY_BATCH
    : LOW_LATENCY_SUMMARY_BATCH;
  const summaryBatchSize = callerBatchSize ?? resolved.summarizeLlm.summaryBatchSize ?? providerDefault;
  return {
    resolved: resolved as ResolvedLlm & { summarizeLlm: NonNullable<ResolvedLlm['summarizeLlm']> },
    client,
    summaryBatchSize,
  };
}

interface MaybeRerankArgs {
  svc: CartographLlmService;
  query: string;
  resolved: ResolvedLlm;
  hits: Array<{ nodeId: string; score: number }>;
  signal?: AbortSignal;
}

/**
 * Outcome of a {@link maybeRerankSemantic} call. Surfaced in
 * {@link AskResult} so the retrieval footer can show whether the
 * reranker fired, was skipped, or failed — giving the user an
 * actionable signal instead of a silent cosine-ordering fallback.
 */
export type RerankOutcome =
  | { kind: 'fired'; durationMs: number; rerankedCount: number; skippedCount: number }
  | { kind: 'skipped-no-config' }
  | { kind: 'skipped-no-hits' }
  | { kind: 'skipped-no-text' }
  | { kind: 'failed'; error: string; durationMs: number };

/**
 * Build the candidate text fed to the cross-encoder. Same shape as
 * the embedder's input (name + signature + docstring + summary) so
 * the reranker reads what it was trained on for code-search rerank.
 */
function buildRerankerCandidateText(row: {
  name: string;
  signature: string | null;
  docstring: string | null;
  summary: string | null;
}): string {
  const parts = [row.name, row.signature?.trim(), row.docstring?.trim(), row.summary?.trim()].filter(
    (s): s is string => !!s && s.length > 0,
  );
  return parts.join('\n');
}

/**
 * Score the semantic hits' candidate texts against `query` via the
 * configured cross-encoder reranker. Reorders by reranker score
 * (descending).
 *
 * Always returns a {@link RerankResult} carrying both the hits (reordered
 * on the happy path, otherwise unchanged) and a {@link RerankOutcome}
 * `kind` so the caller can surface what happened: `'fired'`, or one of
 * the skip kinds (`'skipped-no-config'` / `'skipped-no-hits'` /
 * `'skipped-no-text'`) when the reranker was bypassed, or `'failed'`
 * when the reranker call threw. Failure modes (rerankerLlm unset, dep
 * missing, model unreachable, signal aborted) all degrade to the
 * unmodified hits — the user-visible difference is the outcome tag.
 *
 * The replacement scores are sigmoid-of-logit in [0, 1] — comparable
 * within one query, but not across queries — and the downstream RRF
 * fusion uses rank position only, so the score replacement is safe.
 */
interface RerankResult {
  hits: Array<{ nodeId: string; score: number }>;
  rerank: RerankOutcome;
}

async function maybeRerankSemantic(args: MaybeRerankArgs): Promise<RerankResult> {
  const { svc, query, resolved, hits, signal } = args;
  if (!resolved.rerankerLlm) return { hits, rerank: { kind: 'skipped-no-config' } };
  if (hits.length === 0) return { hits, rerank: { kind: 'skipped-no-hits' } };

  const { RerankerClient } = await import('./llm/reranker-client.js');
  const reranker = new RerankerClient(resolved.rerankerLlm);

  const ids = hits.map((h) => h.nodeId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = svc.cg.db
    .getDb()
    .prepare(
      `SELECT n.id, n.name, n.signature, n.docstring, ss.summary
         FROM nodes n
         LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
        WHERE n.id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    name: string;
    signature: string | null;
    docstring: string | null;
    summary: string | null;
  }>;
  const textById = new Map(rows.map((r) => [r.id, buildRerankerCandidateText(r)]));

  // Skip-rerank for hits with empty candidate text (no name +
  // signature + docstring + summary). Passing '' to the cross-
  // encoder produces a meaningless score that would shift the hit's
  // rank unpredictably; better to keep the original cosine ordering
  // for that subset.
  const rerankable: number[] = [];
  const rerankableTexts: string[] = [];
  hits.forEach((h, i) => {
    const t = textById.get(h.nodeId);
    if (t && t.length > 0) {
      rerankable.push(i);
      rerankableTexts.push(t);
    }
  });
  if (rerankableTexts.length === 0) return { hits, rerank: { kind: 'skipped-no-text' } };

  const skippedCount = hits.length - rerankable.length;
  const t0 = Date.now();
  let scores: number[];
  try {
    const opts = signal ? { signal } : {};
    scores = await reranker.rerank(query, rerankableTexts, opts);
  } catch (err) {
    const durationMs = Date.now() - t0;
    logDebug('Reranker: rerank failed, keeping original hit order', { error: String(err) });
    return { hits, rerank: { kind: 'failed', error: String(err), durationMs } };
  }
  const durationMs = Date.now() - t0;

  // Splice the reranker scores back into a full result list in the
  // original hit order, then sort by score descending. Hits without
  // candidate text keep their original cosine score so they sort
  // naturally against the reranked entries.
  const out = hits.map((h) => ({ ...h }));
  rerankable.forEach((idx, j) => {
    const score = scores[j] ?? 0;
    out[idx] = { nodeId: out[idx]!.nodeId, score };
  });
  out.sort((a, b) => b.score - a.score);
  return {
    hits: out,
    rerank: { kind: 'fired', durationMs, rerankedCount: rerankable.length, skippedCount },
  };
}

interface MaybeExpandArgs {
  svc: CartographLlmService;
  query: string;
  client: EmbeddingProvider;
  embeddingsCfg: NonNullable<ResolvedLlm['embeddingLlm']>;
  resolved: ResolvedLlm;
  initialHits: Array<{ nodeId: string; score: number }>;
  k: number;
  /** Aborts the chat + embed calls when the parent search is torn
   *  down (MCP request timeout, user cancel). */
  signal?: AbortSignal;
}

/**
 * Run the query-expansion pipeline: ask the chat LLM for paraphrases,
 * embed each, run them through {@link llmSemanticTopK}, and max-pool
 * the candidate scores across the original + expansions. Returns the
 * unmodified `initialHits` on any failure (LLM unreachable, no
 * paraphrases, embed error). Sorted by score descending, capped at k.
 *
 * No `isReachable()` round-trip on the hot path — `expandQuery` does
 * the reachability check inside the cache-miss branch, so cached
 * paraphrases are served at zero network cost.
 */
async function maybeExpandAndMaxPool(args: MaybeExpandArgs): Promise<Array<{ nodeId: string; score: number }>> {
  const { svc, query, client, embeddingsCfg, resolved, initialHits, k, signal } = args;
  let llmClient: LlmClient;
  try {
    llmClient = new LlmClient(resolved);
  } catch {
    return initialHits;
  }

  const { expandQuery } = await import('./llm/query-expansion.js');
  const chatModel = resolved.summarizeLlm?.model ?? '';
  const paraphrases = await expandQuery({
    llmClient,
    text: query,
    model: chatModel,
    n: QUERY_EXPANSION_PARAPHRASE_COUNT,
    useLocalChat: true,
    ...(signal ? { signal } : {}),
  });
  if (paraphrases.length === 0) return initialHits;

  let expandedVecs: Float32Array[];
  try {
    const opts = signal ? { signal } : {};
    expandedVecs = await client.embed(paraphrases, opts);
  } catch (err) {
    logDebug('Query expansion: embed of paraphrases failed', { error: String(err) });
    return initialHits;
  }

  const expandedHits = await Promise.all(
    expandedVecs.map((vec) => llmSemanticTopK({ svc, queryVec: vec, model: embeddingsCfg.model, k })),
  );

  // Max-pool: per nodeId, keep the highest score across [original, ...expansions].
  const pooled = new Map<string, number>();
  for (const list of [initialHits, ...expandedHits]) {
    for (const h of list) {
      const cur = pooled.get(h.nodeId) ?? 0;
      if (h.score > cur) pooled.set(h.nodeId, h.score);
    }
  }
  return [...pooled.entries()]
    .map(([nodeId, score]) => ({ nodeId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

interface SearchHybridBlendArgs {
  svc: CartographLlmService;
  query: string;
  ftsResults: SearchResult[];
  client: EmbeddingProvider;
  embeddingsCfg: NonNullable<ResolvedLlm['embeddingLlm']>;
  /** Full resolved config — needed to spin up an `LlmClient` for the
   *  query-expansion path (#6). Optional only for legacy callers /
   *  tests that pre-date Stage 3; new callers should always supply. */
  resolved?: ResolvedLlm;
  /** Aborts in-flight chat + embed calls when the parent search
   *  is torn down. Optional for the same legacy reason as `resolved`. */
  signal?: AbortSignal;
  limit: number;
  fetchLimit: number;
}

/** Top-1 cosine score below 0.5 marks a semantic-search result as
 *  low-confidence and triggers LLM-driven query expansion. Set lower
 *  than the 0.6 file-fallback gate (see FILE_FALLBACK_SCORE_THRESHOLD)
 *  because expansion is a more expensive intervention — only fires
 *  when the symbol AND file-grain hits are both weak. */
const QUERY_EXPANSION_SCORE_THRESHOLD = 0.5;
/** Number of paraphrases to request when expansion fires. */
const QUERY_EXPANSION_PARAPHRASE_COUNT = 3;

/**
 * Embed the query, fetch semantic hits (with low-confidence query
 * expansion via local LLM when warranted, plus an optional cross-
 * encoder rerank pass when `resolved.rerankerLlm` is set), and blend
 * with FTS results via reciprocal-rank fusion. Falls back to FTS-only
 * at any failure point. Pulled out of
 * {@link CartographLlmService.searchHybrid} so the async embed + fuse
 * logic doesn't nest under the embedding-availability branch.
 */
interface BlendWithEmbeddingsResult {
  results: SearchResult[];
  rerankOutcome: RerankOutcome;
}

interface EmbedQueryResult {
  queryVec: Float32Array | null;
  fallback: BlendWithEmbeddingsResult | null;
}

async function searchHybridBlendWithEmbeddings(args: SearchHybridBlendArgs): Promise<BlendWithEmbeddingsResult> {
  const { svc, query, ftsResults, client, embeddingsCfg, resolved, signal, limit, fetchLimit } = args;
  const noRerankerOutcome: RerankOutcome = resolved?.rerankerLlm
    ? { kind: 'skipped-no-hits' }
    : { kind: 'skipped-no-config' };

  const embedded = await embedHybridQuery({ client, query, ftsResults, limit, noRerankerOutcome });
  if (embedded.fallback) return embedded.fallback;
  const queryVec = embedded.queryVec!;

  let semanticHits = await llmSemanticTopK({ svc, queryVec, model: embeddingsCfg.model, k: fetchLimit });
  if (semanticHits.length === 0) {
    return { results: diversifyByName(ftsResults, limit), rerankOutcome: noRerankerOutcome };
  }

  semanticHits = await expandSemanticHitsIfNeeded({
    svc,
    query,
    client,
    embeddingsCfg,
    resolved,
    semanticHits,
    fetchLimit,
    signal,
  });
  const reranked = await rerankSemanticHitsIfConfigured({
    svc,
    query,
    resolved,
    semanticHits,
    signal,
    noRerankerOutcome,
  });

  const fused = await fuseHybridSearchRanks(ftsResults, reranked.semanticHits);
  const fusedResults = buildFusedSearchResults(svc, ftsResults, fused);
  return { results: diversifyByName(fusedResults, limit), rerankOutcome: reranked.rerankOutcome };
}

interface EmbedHybridQueryArgs {
  client: EmbeddingProvider;
  query: string;
  ftsResults: SearchResult[];
  limit: number;
  noRerankerOutcome: RerankOutcome;
}

async function embedHybridQuery(args: EmbedHybridQueryArgs): Promise<EmbedQueryResult> {
  const { client, query, ftsResults, limit, noRerankerOutcome } = args;
  try {
    const vecs = await client.embed([query]);
    if (vecs.length === 0 || !vecs[0]) {
      return {
        queryVec: null,
        fallback: { results: diversifyByName(ftsResults, limit), rerankOutcome: noRerankerOutcome },
      };
    }
    return { queryVec: vecs[0], fallback: null };
  } catch (err) {
    logDebug('Hybrid search: query embed failed, falling back to FTS', { error: String(err) });
    return {
      queryVec: null,
      fallback: { results: diversifyByName(ftsResults, limit), rerankOutcome: noRerankerOutcome },
    };
  }
}

interface ExpandSemanticHitsArgs {
  svc: CartographLlmService;
  query: string;
  client: EmbeddingProvider;
  embeddingsCfg: NonNullable<ResolvedLlm['embeddingLlm']>;
  resolved: ResolvedLlm | undefined;
  semanticHits: Array<{ nodeId: string; score: number }>;
  fetchLimit: number;
  signal: AbortSignal | undefined;
}

async function expandSemanticHitsIfNeeded(
  args: ExpandSemanticHitsArgs,
): Promise<Array<{ nodeId: string; score: number }>> {
  const { svc, query, client, embeddingsCfg, resolved, semanticHits, fetchLimit, signal } = args;
  const topScore = semanticHits[0]?.score ?? 0;
  if (topScore >= QUERY_EXPANSION_SCORE_THRESHOLD || !resolved?.summarizeLlm) return semanticHits;
  return maybeExpandAndMaxPool({
    svc,
    query,
    client,
    embeddingsCfg,
    resolved,
    initialHits: semanticHits,
    k: fetchLimit,
    ...(signal ? { signal } : {}),
  });
}

interface RerankSemanticHitsArgs {
  svc: CartographLlmService;
  query: string;
  resolved: ResolvedLlm | undefined;
  semanticHits: Array<{ nodeId: string; score: number }>;
  signal: AbortSignal | undefined;
  noRerankerOutcome: RerankOutcome;
}

async function rerankSemanticHitsIfConfigured(
  args: RerankSemanticHitsArgs,
): Promise<{ semanticHits: Array<{ nodeId: string; score: number }>; rerankOutcome: RerankOutcome }> {
  const { svc, query, resolved, semanticHits, signal, noRerankerOutcome } = args;
  if (!resolved?.rerankerLlm) return { semanticHits, rerankOutcome: noRerankerOutcome };
  const rerankResult = await maybeRerankSemantic({
    svc,
    query,
    resolved,
    hits: semanticHits,
    ...(signal ? { signal } : {}),
  });
  return { semanticHits: rerankResult.hits, rerankOutcome: rerankResult.rerank };
}

function buildFusedSearchResults(
  svc: CartographLlmService,
  ftsResults: SearchResult[],
  fused: Map<string, number>,
): SearchResult[] {
  const known = new Map<string, SearchResult>();
  for (const r of ftsResults) known.set(r.node.id, r);
  const orderedIds = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const fusedResults: SearchResult[] = [];
  for (const id of orderedIds) {
    let result = known.get(id);
    if (!result) {
      const node = svc.cg.queries.getNodeById(id);
      if (!node) continue;
      result = { node, score: fused.get(id) ?? 0 };
    }
    fusedResults.push(result);
  }
  return fusedResults;
}

async function fuseHybridSearchRanks(
  ftsResults: SearchResult[],
  semanticHits: Array<{ nodeId: string }>,
): Promise<Map<string, number>> {
  const { reciprocalRankFusion } = await import('./llm/embeddings.js');
  const ftsRanked = ftsResults.map((r) => ({ id: r.node.id }));
  const semRanked = semanticHits.map((h) => ({ id: h.nodeId }));
  return reciprocalRankFusion([ftsRanked, semRanked]);
}

/**
 * Judge potentially-dead symbols. Pre-filters by graph signal
 * (zero incoming calls + not exported) and asks the LLM to weigh
 * in on entry points the static graph misses.
 */
export async function llmFindDeadCode(
  svc: CartographLlmService,
  options: DeadCodeOptions = {},
): Promise<DeadCodeResult> {
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.summarizeLlm) {
    throw new Error('No summarize provider configured for dead-code judge.');
  }
  const client = new LlmClient(resolved);
  if (!(await client.isReachable())) {
    throw new Error(`Summarize backend not reachable (${resolved.resolutionTrace}).`);
  }
  return judgeDeadCode(svc.cg.queries, client, options);
}

/**
 * Check whether a newly added symbol's name follows the conventions
 * already established in the codebase for the same kind.
 */
export async function llmCheckNamingDrift(
  svc: CartographLlmService,
  symbol: { name: string; kind: string; filePath: string },
): Promise<NamingCheckResult> {
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.summarizeLlm) {
    throw new Error('No summarize provider configured for naming-drift check.');
  }
  const client = new LlmClient(resolved);
  return checkNamingConvention({ queries: svc.cg.queries, client, newSymbol: symbol });
}

/**
 * One-shot "what did this change do" intent generator.
 */
export async function llmSummarizeChange(
  svc: CartographLlmService,
  args: {
    name: string;
    kind: string;
    beforeBody: string;
    afterBody: string;
    options?: ChangeIntentOptions;
  },
): Promise<ChangeIntentResult> {
  const { name, kind, beforeBody, afterBody, options = {} } = args;
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.summarizeLlm) {
    throw new Error('No summarize provider configured for summarizeChange.');
  }
  const client = new LlmClient(resolved);
  if (!(await client.isReachable())) {
    throw new Error(`Summarize backend not reachable (${resolved.resolutionTrace}).`);
  }
  return summarizeChangeIntent({ client, name, kind, beforeBody, afterBody, options });
}

/**
 * Find symbols semantically similar to a free-text concept query.
 */
export async function llmFindImplementations(
  svc: CartographLlmService,
  text: string,
  options: { limit?: number; languageFilter?: string } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.embeddingLlm) return [];

  const client = createEmbeddingClient(resolved.embeddingLlm);
  const reachable = await client.isReachable();
  if (!reachable) return [];
  const vecs = await client.embed([text]);
  const queryVec = vecs[0];
  if (!queryVec) return [];

  const semanticHits = await llmSemanticTopK({
    svc,
    queryVec,
    model: resolved.embeddingLlm.model,
    k: limit * 2,
  });
  const out: SearchResult[] = [];
  for (const hit of semanticHits) {
    if (out.length >= limit) break;
    const node = svc.cg.queries.getNodeById(hit.nodeId);
    if (!node) continue;
    if (options.languageFilter && node.language !== options.languageFilter) continue;
    out.push({ node, score: hit.score });
  }
  return out;
}

/**
 * Find symbols whose meaning is similar to a given node, via embedding cosine.
 */
export async function llmFindSimilar(
  svc: CartographLlmService,
  nodeId: string,
  options: { limit?: number; sameLanguage?: boolean; differentLanguage?: boolean } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const resolved = await svc.config.resolveLlmConfig();
  if (!resolved?.embeddingLlm) return [];

  const sourceNode = svc.cg.queries.getNodeById(nodeId);
  if (!sourceNode) return [];

  const sourceBuf = getEmbeddingForNode(svc.cg.queries, nodeId, resolved.embeddingLlm.model);
  if (!sourceBuf) return [];
  const { bytesToVector } = await import('./llm/embeddings.js');
  const sourceVec = bytesToVector(sourceBuf);

  const semanticHits = await llmSemanticTopK({
    svc,
    queryVec: sourceVec,
    model: resolved.embeddingLlm.model,
    k: limit + 1,
  });
  const hits = semanticHits.filter((h) => h.nodeId !== nodeId);

  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (out.length >= limit) break;
    const node = svc.cg.queries.getNodeById(hit.nodeId);
    if (!node) continue;
    if (options.sameLanguage && node.language !== sourceNode.language) continue;
    if (options.differentLanguage && node.language === sourceNode.language) continue;
    out.push({ node, score: hit.score });
  }
  return out;
}
