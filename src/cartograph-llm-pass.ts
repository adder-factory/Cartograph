/**
 * Background-summarisation pass — the four LLM phases (summary →
 * embed → directory-summary → classify) plus the chat-backend probe
 * that gates them, plus the per-phase progress factory.
 *
 * Extracted from `Cartograph` (`src/index.ts`) so the public-API
 * class doesn't carry the per-domain background helpers as direct
 * members. The functions read / write Cartograph state via the
 * `@internal`-tagged `db`/`queries`/`config`/`projectRoot` fields on
 * the Cartograph instance, and reach the LLM caches + lifecycle state
 * through the `CartographLlmService` sub-facades:
 * `svc.embed.embeddingCache`, `svc.embed.hnswByDim`,
 * `svc.bgCtrl.progress`. (See `src/cartograph-llm-service.ts` for the
 * facade shape — fields used to live on `svc` directly before the
 * LlmConfigManager + EmbedPipeline + BgSummaryController extraction.)
 */

import type { LlmClient } from './llm/client.js';
import type { EmbeddingProvider } from './llm/embedding-client.js';
import type { ResolvedLlm } from './llm/provider.js';
import { summarizeAll } from './llm/summarizer.js';
import { embedAllNodes } from './llm/embeddings.js';
import { rebuildHnswIfStale } from './embeddings/hnsw-build.js';
import { summarizeAllFiles } from './llm/file-summarizer.js';
import { summarizeAllDirectories } from './llm/dir-summarizer.js';
import { classifyAllRoles } from './llm/classifier.js';
import { classifyCommitMessageWithFallback, type CommitIntent } from './llm/commit-intent.js';
import { runStructuralSummariser } from './llm/structural-summarizer.js';
import { runNeighborPropagator } from './llm/neighbor-propagator.js';
import { pruneOrphanSummaries } from './db/queries-summaries.js';
import { pruneOrphanFileSummaries } from './db/queries-file-summaries.js';
import { pruneOrphanDirectorySummaries } from './db/queries-directory-summaries.js';
import { getUnknownCommitShas, recordCommitIntents } from './db/queries-commit-intents.js';
import { getCommitSubjects } from './git-utils.js';
import { logDebug, logWarn, errMsg } from './errors.js';
import type { CartographLlmService } from './cartograph-llm-service.js';

/** Tag each progress callback with its phase so the polling UI sees the heartbeat without per-phase plumbing. */
function makePhaseProgress(
  svc: CartographLlmService,
  phase: 'structural' | 'summarise' | 'embed' | 'neighbor' | 'file' | 'directory' | 'classify',
): (done: number, total: number) => void {
  return (done, total) => {
    svc.bgCtrl.progress = { phase, done, total };
  };
}

/**
 * Probe the configured summarize backend before kicking off the summary pass.
 * `isReachable()` only confirms the backend exists; it can't tell us
 * whether the configured model id actually responds. A mismatched model
 * would otherwise fail every chat call the same way and burn hours
 * across thousands of candidate symbols. Also speed-gates the openai-compat HTTP
 * backend — claude-bridge speed is bounded by the subprocess, not
 * the model, so the speed gate doesn't apply there.
 *
 * Returns true when probing succeeded (or was abort-cancelled, which
 * the caller checks separately). Returns false to bail the whole pass.
 */
export async function probeChatBackend(
  client: LlmClient,
  resolved: ResolvedLlm,
  controller: AbortController,
): Promise<boolean> {
  if (!(await client.isReachable())) {
    logDebug('Background summarisation: summarize backend not reachable', {
      trace: resolved.resolutionTrace,
    });
    return false;
  }

  const probeStart = Date.now();
  try {
    await client.chat([{ role: 'user', content: 'ok' }], { temperature: 0, maxTokens: 1 });
  } catch (err) {
    logWarn('Background summarisation: chat probe failed; skipping pass', {
      trace: resolved.resolutionTrace,
      error: errMsg(err),
    });
    return false;
  }
  if (controller.signal.aborted) return true;

  const probeMs = Date.now() - probeStart;
  const provider = resolved.summarizeLlm?.provider;
  logDebug('Background summarisation: probe ok', { provider, probeMs });
  return true;
}

/**
 * Phase 2: symbol summaries. Batch size is provider-aware:
 * claude-bridge / anthropic-api pay per-call overhead (subprocess
 * spawn or network roundtrip), so batching 3 cache-MISS symbols cuts
 * wall-clock ~4-5× with negligible quality loss (Haiku follows the
 * JSON-array prompt reliably). openai-compat HTTP processes requests one at a
 * time — batching gives zero speedup but pays quality cost, so stay
 * at 1 there. Override via `summarizeLlm.summaryBatchSize` in config.
 *
 * Followed by orphan-summary GC: rows whose node_id no longer exists
 * accumulate across `--force` re-indexes when symbols get new
 * node_ids (line shift, file move, extraction-version bump). MUST
 * run AFTER `summarizeAll` so the content-hash fallback inside it
 * has had a chance to reclaim renames onto current node_ids. The
 * GC also explicitly deletes orphan embeddings (FK cascade through
 * summaries went away with migration 033 — embeddings now FK
 * directly to nodes, so `pruneOrphanSummaries` issues a peer
 * `DELETE FROM symbol_embeddings WHERE node_id NOT IN nodes` in the
 * same transaction).
 */
/** Bundle threaded through every phase function: the service the
 *  phase mutates (progress + caches), the LLM client + resolved
 *  config it should use, and the abort signal for shutdown. */
interface PhaseContext {
  svc: CartographLlmService;
  client: LlmClient;
  embeddingClient: EmbeddingProvider;
  resolved: ResolvedLlm;
  controller: AbortController;
}

export async function runSummaryPhase(ctx: PhaseContext, chatConcurrency: number): Promise<void> {
  const { svc, client, resolved, controller } = ctx;
  const provider = resolved.summarizeLlm?.provider;
  const providerDefaultBatchSize = provider === 'claude-bridge' || provider === 'anthropic-api' ? 3 : 1;
  const summaryBatchSize = resolved.summarizeLlm?.summaryBatchSize ?? providerDefaultBatchSize;

  svc.bgCtrl.progress = { phase: 'summarise', done: 0, total: 0 };
  const result = await summarizeAll({
    projectRoot: svc.cg.projectRoot,
    queries: svc.cg.queries,
    client,
    modelLabel: resolved.summarizeLlm!.model,
    options: {
      signal: controller.signal,
      concurrency: chatConcurrency,
      summaryBatchSize,
      // Lever C — the background pass honours the configured eager
      // limit; omitting it lets the summarizer apply its default.
      // Conditional spread — `exactOptionalPropertyTypes` rejects an
      // explicit `eagerLimit: undefined`.
      ...(svc.cg.config.llm?.summarizeEagerLimit === undefined
        ? {}
        : { eagerLimit: svc.cg.config.llm.summarizeEagerLimit }),
      onProgress: makePhaseProgress(svc, 'summarise'),
    },
  });
  logDebug('Background summarisation complete', {
    candidates: result.candidates,
    generated: result.generated,
    cacheHits: result.cacheHits,
    errors: result.errors,
    deferred: result.deferred,
    durationMs: result.durationMs,
  });

  if (controller.signal.aborted) return;
  const pruned = pruneOrphanSummaries(svc.cg.queries);
  if (pruned.summariesDeleted > 0 || pruned.embeddingsDeleted > 0) {
    logDebug('Pruned orphan summaries', {
      summariesDeleted: pruned.summariesDeleted,
      embeddingsDeleted: pruned.embeddingsDeleted,
    });
  }
}

/**
 * Phase 1: embed every indexed node so semantic search has data. New
 * vectors invalidate the in-memory similarity matrix so the next
 * query re-loads them.
 *
 * Runs FIRST (before summarise) since post-migration 033 the embed
 * text is sourced from name + signature + docstring directly, with
 * the summary becoming an optional richer-input layered on top.
 * Running embed first lets `cartograph_search(mode='semantic')` go
 * hot in minutes (local nomic-embed) instead of waiting hours for
 * the summary pass to complete.
 */
export async function runEmbedPhase(ctx: PhaseContext): Promise<void> {
  const { svc, controller } = ctx;
  svc.bgCtrl.progress = { phase: 'embed', done: 0, total: 0 };

  await runSymbolEmbedPass(ctx);
  if (controller.signal.aborted) return;

  await runFileGrainEmbedPass(ctx);
  if (controller.signal.aborted) return;

  await runMultiVecEmbedPass(ctx);
  if (controller.signal.aborted) return;

  // Rebuild the per-dim HNSW KNN indexes now that this pass's symbol
  // embeddings have landed. Used to be a blocking index postHook;
  // moved here because HNSW only has work once embeddings exist and
  // embeddings are produced by this same detached pass. The drift
  // gate inside makes it near-free when nothing moved — so the
  // second runEmbedPhase call (post-summary refresh) skips unless
  // >5% of the rowset changed. The hnswByDim cache was already
  // cleared above, so the next semantic query loads the fresh file.
  await rebuildHnswIfStale(svc.cg.db.getDb(), svc.cg.projectRoot);
}

/**
 * Embed every indexed symbol node. Invalidates the in-memory embedding
 * cache + HNSW index when new vectors are written. Embed is single-pass
 * per call (no autoregressive loop), so the backend burns through
 * concurrent requests fast; default concurrency 8 gives good throughput
 * against the openai-compat HTTP path (4 sequences acquire/release smoothly).
 */
async function runSymbolEmbedPass(ctx: PhaseContext): Promise<void> {
  const { svc, embeddingClient, resolved } = ctx;
  const eResult = await embedAllNodes({
    queries: svc.cg.queries,
    client: embeddingClient,
    embeddingModel: resolved.embeddingLlm!.model,
    options: {
      signal: ctx.controller.signal,
      concurrency: 8,
      onProgress: makePhaseProgress(svc, 'embed'),
    },
  });
  logDebug('Background embedding complete', {
    candidates: eResult.candidates,
    generated: eResult.generated,
    errors: eResult.errors,
    skipped: eResult.skipped,
    durationMs: eResult.durationMs,
  });
  if (eResult.skipped > 0) {
    logWarn(
      `Embedder: ${eResult.skipped} input${eResult.skipped === 1 ? '' : 's'} too large for the server's configured batch size — skipped. ` +
        "Increase the embed server's --batch-size (or equivalent) if you want these covered.",
    );
  }
  if (eResult.generated > 0) {
    svc.embed.embeddingCache.invalidate();
    svc.embed.hnswByDim.clear();
  }
}

/**
 * File-grain pass — aggregate top-K symbol summaries per file and embed
 * each as `grain='file'`. Cheap and idempotent: the per-file staleness
 * check skips files whose combinedHash matches the existing row, so the
 * SECOND embed phase (after summaries land) is the one that does the
 * real work. The first pass may run with signature-only fallbacks when
 * no summaries exist yet — still useful for file-level retrieval.
 */
async function runFileGrainEmbedPass(ctx: PhaseContext): Promise<void> {
  const { svc, embeddingClient, resolved } = ctx;
  const { embedFilesAggregated } = await import('./embeddings/file-grain.js');
  const fResult = await embedFilesAggregated({
    qb: svc.cg.queries,
    client: embeddingClient,
    embeddingModel: resolved.embeddingLlm!.model,
    signal: ctx.controller.signal,
    onProgress: makePhaseProgress(svc, 'embed'),
  });
  logDebug('Background file-grain embedding complete', {
    candidates: fResult.candidates,
    generated: fResult.generated,
    cacheHits: fResult.cacheHits,
    errors: fResult.errors,
    durationMs: fResult.durationMs,
  });
  if (fResult.generated > 0) {
    svc.embed.embeddingCache.invalidate();
    svc.embed.hnswByDim.clear();
  }
}

/**
 * Multi-vec pass (Stage 5 #C). Symbols >= LARGE_SYMBOL_LOC_THRESHOLD get
 * one embedding per body chunk (200 LOC windows with 50-LOC overlap).
 * Persists to symbol_chunk_embeddings + the vec_chunk_* mirror;
 * findSimilarViaVec merges them with main symbol_embeddings hits via
 * per-nodeId max-similarity at query time.
 */
async function runMultiVecEmbedPass(ctx: PhaseContext): Promise<void> {
  const { svc, embeddingClient, resolved } = ctx;
  const { embedLongSymbols } = await import('./embeddings/multi-vec.js');
  const mvResult = await embedLongSymbols({
    qb: svc.cg.queries,
    client: embeddingClient,
    embeddingModel: resolved.embeddingLlm!.model,
    projectRoot: svc.cg.projectRoot,
    signal: ctx.controller.signal,
    onProgress: makePhaseProgress(svc, 'embed'),
  });
  logDebug('Background multi-vec chunk embedding complete', {
    candidates: mvResult.candidates,
    chunked: mvResult.chunked,
    chunksWritten: mvResult.chunksWritten,
    bodyMisses: mvResult.bodyMisses,
    errors: mvResult.errors,
    durationMs: mvResult.durationMs,
  });
  if (mvResult.chunksWritten > 0) {
    // New chunk vectors → invalidate any caches that would surface
    // stale similarity results.
    svc.embed.embeddingCache.invalidate();
    svc.embed.hnswByDim.clear();
  }
}

/**
 * Phase 3a: roll up symbol summaries into one paragraph per FILE —
 * the tier between symbol and directory summaries. Cheap once symbol
 * summaries exist (only files whose symbol content changed regenerate).
 * Followed by orphan-file-summary GC, matching the symbol-summary
 * pattern; runs AFTER the file summarizer to avoid racing its writes
 * for newly-summarised files.
 */
export async function runFileSummaryPhase(ctx: PhaseContext): Promise<void> {
  const { svc, client, resolved, controller } = ctx;
  svc.bgCtrl.progress = { phase: 'file', done: 0, total: 0 };
  const fResult = await summarizeAllFiles({
    projectRoot: svc.cg.projectRoot,
    queries: svc.cg.queries,
    client,
    modelLabel: resolved.summarizeLlm!.model,
    options: {
      signal: controller.signal,
      concurrency: 1,
      onProgress: makePhaseProgress(svc, 'file'),
    },
  });
  logDebug('Background file summarisation complete', {
    candidates: fResult.candidates,
    generated: fResult.generated,
    cacheHits: fResult.cacheHits,
    skipped: fResult.skipped,
    errors: fResult.errors,
    durationMs: fResult.durationMs,
  });

  if (controller.signal.aborted) return;
  const filePruned = pruneOrphanFileSummaries(svc.cg.queries);
  if (filePruned.fileSummariesDeleted > 0) {
    logDebug('Pruned orphan file summaries', filePruned);
  }
}

/**
 * Phase 3: roll up symbol summaries into one paragraph per directory.
 * Cheap once symbol summaries exist (only directories whose content
 * changed regenerate). Followed by orphan-directory-summary GC,
 * matching the symbol-summary pattern (live dirs derive from
 * `files.path`); runs AFTER the dir summarizer to avoid racing its
 * writes for newly-summarised dirs.
 */
export async function runDirectorySummaryPhase(ctx: PhaseContext): Promise<void> {
  const { svc, client, resolved, controller } = ctx;
  svc.bgCtrl.progress = { phase: 'directory', done: 0, total: 0 };
  const dResult = await summarizeAllDirectories({
    projectRoot: svc.cg.projectRoot,
    queries: svc.cg.queries,
    client,
    modelLabel: resolved.summarizeLlm!.model,
    options: {
      signal: controller.signal,
      concurrency: 1,
      onProgress: makePhaseProgress(svc, 'directory'),
    },
  });
  logDebug('Background directory summarisation complete', {
    candidates: dResult.candidates,
    generated: dResult.generated,
    cacheHits: dResult.cacheHits,
    errors: dResult.errors,
    durationMs: dResult.durationMs,
  });

  if (controller.signal.aborted) return;
  const dirPruned = pruneOrphanDirectorySummaries(svc.cg.queries);
  if (dirPruned.directorySummariesDeleted > 0) {
    logDebug('Pruned orphan directory summaries', dirPruned);
  }
}

/** Arguments for {@link runDeterministicPhase} — bundles the three
 *  per-phase variant fields so the call site stays below the
 *  long_parameter_list threshold. */
interface DeterministicPhaseArgs<R extends object> {
  phase: 'structural' | 'neighbor';
  runner: (args: Parameters<typeof runStructuralSummariser>[0]) => Promise<R>;
  logMessage: string;
}

/**
 * Run a deterministic (no-LLM) summary phase: stamp the progress tag,
 * invoke the phase's runner with the standard project/queries/options
 * bundle, then debug-log the result. Shared by the structural-synthesis
 * and neighbor-propagation phases, which differ only in their progress
 * tag, runner function, and log message.
 */
async function runDeterministicPhase<R extends object>(
  ctx: PhaseContext,
  args: DeterministicPhaseArgs<R>,
): Promise<void> {
  const { phase, runner, logMessage } = args;
  const { svc, controller } = ctx;
  svc.bgCtrl.progress = { phase, done: 0, total: 0 };
  const result = await runner({
    projectRoot: svc.cg.projectRoot,
    queries: svc.cg.queries,
    options: {
      signal: controller.signal,
      onProgress: makePhaseProgress(svc, phase),
    },
  });
  // Debug-log every field of the phase result (the two runners return
  // different result shapes — both are flat objects of metrics).
  logDebug(logMessage, result as Record<string, unknown>);
}

/**
 * Phase 0: deterministic structural summaries. Synthesises summaries
 * for routes, 1-line forwarders, getters/setters, factories, and
 * re-exports — symbols the LLM pass would skip (body too short) yet
 * carry meaningful behaviour expressible from the call graph alone.
 * No LLM calls; no summarize backend required. Runs FIRST so subsequent
 * phases (embed, summarise, classify) can read these synthetic rows
 * via `getSymbolDescriptions` like any other summary.
 *
 * Idempotent: re-running a clean DB regenerates only nodes whose body
 * hash drifted; existing non-structural (LLM/agent) summaries are
 * preserved.
 */
export function runStructuralPhase(ctx: PhaseContext): Promise<void> {
  return runDeterministicPhase(ctx, {
    phase: 'structural',
    runner: runStructuralSummariser,
    logMessage: 'Structural summarisation complete',
  });
}

/**
 * Phase 1.5: embedding-neighbor propagation. For each unsummarised
 * node with an embedding, find its top-1 neighbor; if cosine ≥ 0.85
 * AND the neighbor has a summary AND same kind, copy that summary
 * onto the candidate with `model='neighbor:v1'` and the candidate's
 * own content_hash. Cheap reuse of the embedding work the previous
 * phase just did. Skipped when no embeddings exist yet.
 */
export function runNeighborPropagationPhase(ctx: PhaseContext): Promise<void> {
  return runDeterministicPhase(ctx, {
    phase: 'neighbor',
    runner: runNeighborPropagator,
    logMessage: 'Neighbor propagation complete',
  });
}

/**
 * Phase 4: role classification. One short call per symbol that
 * assigns a coarse label (api_endpoint, business_logic, …).
 */
export async function runClassifyPhase(ctx: PhaseContext, chatConcurrency: number): Promise<void> {
  const { svc, client, resolved, controller } = ctx;
  svc.bgCtrl.progress = { phase: 'classify', done: 0, total: 0 };

  const cResult = await classifyAllRoles({
    queries: svc.cg.queries,
    client,
    modelLabel: resolved.summarizeLlm!.model,
    options: {
      signal: controller.signal,
      concurrency: chatConcurrency,
      onProgress: makePhaseProgress(svc, 'classify'),
    },
  });
  logDebug('Background role classification complete', {
    candidates: cResult.candidates,
    classified: cResult.classified,
    errors: cResult.errors,
    durationMs: cResult.durationMs,
  });
}

/** Concurrent commit-intent LLM calls for the residue pass. The
 *  residue is small (the heuristic resolves the large majority of
 *  commits), and each call is one short classification. */
const COMMIT_INTENT_RESIDUE_CONCURRENCY = 8;

/**
 * Re-classify the commit-intent `unknown` residue with the LLM.
 *
 * The cochange index hook records commit intents heuristically
 * (synchronous, no model) — conventional-commit prefixes + subject
 * keyword cues. The residue it leaves `unknown` is the prefix-less,
 * keyword-less commits; an LLM reading the subject line still places
 * a measured ~63% of them. This background phase picks up that
 * residue with the chat model.
 *
 * Re-processes the full accumulated `unknown` set each pass — at
 * temperature 0 a still-unknown verdict is stable, so this re-does a
 * little work on the stubborn tail; acceptable for a small residue.
 *
 * Intentionally progress-silent (does not touch `bgCtrl.progress`) —
 * the residue is small and the phase brief; the UI keeps the prior
 * phase's tag rather than minting a one-off `residue` progress kind.
 */
export async function runCommitIntentResiduePhase(ctx: PhaseContext): Promise<void> {
  const { svc, client, controller } = ctx;
  const shas = getUnknownCommitShas(svc.cg.queries);
  if (shas.length === 0) return;
  const subjects = getCommitSubjects(svc.cg.projectRoot, shas);
  const updates: Array<{ sha: string; intent: CommitIntent; score: number }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < shas.length) {
      if (controller.signal.aborted) return;
      const sha = shas[next++]!;
      const subject = subjects.get(sha);
      if (!subject) continue;
      // classifyCommitMessageWithFallback re-runs the (cheap) heuristic
      // then the LLM; it catches its own chat failures and degrades.
      const r = await classifyCommitMessageWithFallback(subject, client);
      if (r.intent !== 'unknown') updates.push({ sha, intent: r.intent, score: r.score });
    }
  };
  await Promise.all(Array.from({ length: COMMIT_INTENT_RESIDUE_CONCURRENCY }, () => worker()));
  if (updates.length > 0 && !controller.signal.aborted) {
    recordCommitIntents(svc.cg.queries, updates);
  }
  logDebug('Commit-intent LLM residue pass complete', {
    residue: shas.length,
    reclassified: updates.length,
  });
}
