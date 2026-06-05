/**
 * Biomarker analysis orchestrator.
 *
 * For every indexed function/method node, finds the AST node at its
 * location, computes metrics, evaluates the rule set, and writes
 * findings to `code_health_findings`. Idempotent: re-running clears
 * the previous findings for each touched node.
 *
 * Designed to run as an `IndexHook` after extraction completes. Each
 * file is parsed *once* and the resulting tree is reused for every
 * symbol in that file — re-parsing per symbol exhausts the WASM
 * tree-sitter heap on real codebases (we observed thousands of
 * "memory access out of bounds" crashes before this).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { streamingDispatch } from '../concurrency.js';
import { type QueryBuilder, qbTransaction } from '../db/queries.js';
import {
  appendFindings,
  clearFindingsByKind,
  demoteFullPassRowsToCached,
  promoteFullPassCachedToFullPass,
  replaceFindingsForFile,
  type PassKind,
} from '../db/queries-findings.js';
import { getPriorLocSnapshots, recordLocSnapshots } from '../db/queries-loc-history.js';
import { upsertNodeMetricsBatch } from '../db/queries-metrics.js';
import { getAllFilePaths, getAllFiles } from '../db/queries-files.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { findGodClasses, findFeatureEnvy, findUnusedExports } from '../db/queries-biomarkers-graph.js';
import { loadConfig } from '../config.js';
import { computeIllegalImports } from './layering.js';
import { findLowCoverage } from './low-coverage.js';
import { findDuplicateCode } from './duplicate-code.js';
import type { Language, Node } from '../types.js';
import { logDebug, logWarn } from '../errors.js';
import { getDatabasePath } from '../db/index.js';
import { runRulesInWorkers } from './worker-pool.js';
import { runPerFileBiomarkersInWorkers, shouldUsePerFileWorkers } from './per-file-pool.js';
import type { PerFileResult } from './per-file-worker.js';
import {
  ANALYSABLE_KINDS as SHARED_ANALYSABLE_KINDS,
  ANALYSABLE_MIN_LOC as SHARED_ANALYSABLE_MIN_LOC,
  astBodyNodeRangeMismatch as sharedAstBodyNodeRangeMismatch,
  isSecretsRuleSelfPath as sharedIsSecretsRuleSelfPath,
  sharedDocstringsAcrossConstants as sharedSharedDocstringsAcrossConstants,
} from './per-file-shared.js';
import { isDiagnosticPath } from '../utils.js';
import {
  computeMetrics,
  evaluateRules,
  evaluateStaleDoc,
  evaluateSecretsHandling,
  findNodeInTree,
  parseSource,
} from './engine.js';
import { getLangMap } from './lang-map.js';
import { loadGrammarsForLanguages } from '../extraction/grammars.js';
import { EXTRACTION_LOGIC_VERSION } from '../extraction/extraction-logic-version.js';
import { computeAlgoHash } from '../algo-hash.js';
import type { Finding, CrossFileBiomarkerName } from './types.js';
import { runSequential } from '../utils/async-iteration.js';

export type { BiomarkerName, Finding, Severity } from './types.js';
export {
  computeMetrics,
  evaluateRules,
  codeHealthScore,
  findNodeAt,
  findNodeInTree,
  parseSource,
  _internalForTests,
} from './engine.js';

/** Symbol kinds the engine analyses. Skipped: import/export/variable/etc.
 *  Re-exported from `per-file-shared.ts` for backwards compatibility with
 *  external callers and tests that imported it from here. */
export const ANALYSABLE_KINDS = SHARED_ANALYSABLE_KINDS;

/** Skip absurdly tiny symbols — getters, one-liners aren't biomarker bait.
 *  Re-exported from `per-file-shared.ts` so the worker and in-main paths
 *  share one source of truth (B22 reviewer-caught drift would otherwise
 *  inflate worker-side stats). */
export const ANALYSABLE_MIN_LOC = SHARED_ANALYSABLE_MIN_LOC;
const MIN_LOC = ANALYSABLE_MIN_LOC;

/**
 * project_metadata key holding the per-file biomarker cache. Maps
 * `filePath -> content_hash` for every file successfully analysed in
 * the previous pass.
 *
 * The suffix is derived from two source hashes:
 *   - `biomarkerSourceHash`: sha256 of the three files that own the
 *     biomarker rule + cache contract (this file, `engine.ts`,
 *     `types.ts`). Any substantive edit invalidates the per-file
 *     cache on the next sync.
 *   - `EXTRACTION_LOGIC_VERSION`: source-derived hash of the
 *     extractor's emit-set contract. Coupled here so that an
 *     extractor change which produces new edges / nodes for unchanged
 *     source content also invalidates this cache — without that, the
 *     per-file content_hash short-circuit would keep stale findings
 *     past a resolver improvement (caught 2026-05-11 on
 *     `CURRENT_SCHEMA_VERSION`).
 *
 * Pre-2026-05-11 this was a hand-bumped `v{N}` literal with a
 * checked-in hash manifest the contributor had to update on each
 * substantive change. The new derived form removes both manual steps
 * — edit a spec file → hash changes → cache invalidates → next sync
 * triggers a one-shot full pass. Cross-file rules run only on a full
 * pass (see `runCrossFileBiomarkers`, gated on `!fileFilter`); a
 * partial sync preserves the last full-pass cross-file findings, so
 * this cache governs only the per-file findings.
 *
 * Comment-strip + whitespace-normalise in the hasher means JSDoc /
 * reformat-only edits don't invalidate. Refactor PRs that touch any
 * of the three spec files substantively (rename a public symbol,
 * change a stored metric shape, add/remove a rule) DO invalidate —
 * one full pass on the next sync. The trade-off vs. the old manual
 * scheme: lose the option to mark a refactor as "no-op for caching."
 * The bump-misses the old scheme produced were more painful than
 * occasional spurious re-passes on refactors.
 */
const biomarkerSourceHash = computeAlgoHash('src/biomarkers/index.ts', [
  './index',
  './engine',
  './types',
  './lang-map',
]);
export const BIOMARKER_CACHE_KEY: `biomarker_file_state_${string}_${string}` = `biomarker_file_state_${biomarkerSourceHash}_${EXTRACTION_LOGIC_VERSION}`;

interface AnalysisOptions {
  signal?: AbortSignal;
  /** Limit the analysis to a specific set of file paths (used by sync
   *  to avoid re-analysing the whole project for a one-file change). */
  filePaths?: ReadonlyArray<string> | undefined;
  onProgress?: (done: number, total: number) => void;
}

interface AnalysisResult {
  filesScanned: number;
  symbolsAnalysed: number;
  findingsEmitted: number;
  unsupportedLanguages: number;
  errors: number;
  durationMs: number;
  /** Files skipped because their content_hash matched the cache. */
  filesSkippedByCache?: number;
  /**
   * Symbols skipped by the AST/DB range-mismatch guard (friction #20
   * defensive). When this is non-zero on a fresh pass it indicates
   * either AST-vs-extraction drift OR a recurrence of the engine bug
   * the guard catches — worth surfacing in a follow-up investigation.
   */
  skippedRangeMismatch?: number;
}

// G9 Phase 2C: the serial `runCrossFileRule` (one read + write per
// invocation) was inlined into `runCrossFileBiomarkers` and split
// into `filterDiagnosticFindings` + `persistRuleFindings` so the
// READ phase can run in worker_threads while the WRITE phase stays
// on the host's connection. See `runCrossFileBiomarkers` below.

/**
 * Compose the file-level inputs for `analyseProject`: target list,
 * current vs cached content hashes, and the cache snapshot we'll
 * persist (or not) at the end.
 */
function buildAnalysisInputs(
  queries: QueryBuilder,
  options: AnalysisOptions,
): {
  fileFilter: Set<string> | null;
  targetFiles: string[];
  currentHashes: Map<string, string>;
  cachedHashes: Record<string, string>;
  nextCache: Record<string, string>;
} {
  const fileFilter = options.filePaths ? new Set(options.filePaths) : null;
  const allFiles = getAllFilePaths(queries);
  const targetFiles = fileFilter ? allFiles.filter((f) => fileFilter.has(f)) : allFiles;

  const currentHashes = new Map<string, string>();
  for (const f of getAllFiles(queries)) {
    currentHashes.set(f.path, f.contentHash);
  }
  const cachedHashes = loadBiomarkerCache(queries);
  // Start from the existing cache so files we skip this pass retain
  // their cached hash; pruning happens during persist.
  const nextCache: Record<string, string> = { ...cachedHashes };
  return { fileFilter, targetFiles, currentHashes, cachedHashes, nextCache };
}

interface FileLoopArgs {
  ctx: AnalysisContext;
  targetFiles: string[];
  currentHashes: Map<string, string>;
  stats: AnalysisStats;
  options: AnalysisOptions;
}

/** Run the per-file analysis loop, mutating `stats` in place. Routes
 *  through one of three dispatch paths:
 *
 *  1. **Serial fallback** — tiny inputs (< 32 files) or forced via
 *     `BIOMARKER_PERFILE_SERIAL=1`. Plain `for` loop, no concurrency
 *     setup cost.
 *  2. **Worker pool (B22, 2026-05-24)** — files >= 1000 (see
 *     `PER_FILE_WORKER_THRESHOLD` in `per-file-pool.ts`) AND
 *     `CARTOGRAPH_BIOMARKER_PERFILE_WORKERS != 0`. Fans compute out
 *     across `os.cpus()-1` worker_threads (capped 8), each with its
 *     own bun:sqlite read handle. True CPU parallelism (the prior
 *     two paths serialize on the JS event loop). Main thread persists
 *     since SQLite writes serialize at the engine level anyway.
 *  3. **streamingDispatch (B11)** — default for the medium range
 *     (32-999 files). Keeps up to `BIOMARKER_PERFILE_INFLIGHT` files
 *     in flight via the streamingDispatch primitive, overlapping
 *     file I/O windows across files. Sync compute still serializes
 *     on the event loop, but I/O waits stack on top of the next
 *     file's compute. Modest win, near-zero risk.
 */
async function runFileLoop(args: FileLoopArgs): Promise<void> {
  const { ctx, targetFiles, currentHashes, stats, options } = args;
  const total = targetFiles.length;
  if (process.env['BIOMARKER_PERFILE_SERIAL'] === '1' || targetFiles.length < 32) {
    // Tiny inputs OR forced-serial: don't pay the streamingDispatch
    // setup. Below ~32 files, the per-file work is short enough that
    // even I/O-bound overlap doesn't help.
    await runSequential(targetFiles, async (relPath) => {
      if (options.signal?.aborted) return false;
      const currentHash = currentHashes.get(relPath);
      await analyseSingleFile({ ctx, relPath, currentHash, stats });
      options.onProgress?.(stats.filesScanned, total);
      return true;
    });
    return;
  }
  // B22 (2026-05-24) — when the batch is big enough to amortize
  // worker-spawn overhead (~250ms × N workers for bun:sqlite + grammar
  // preload), fan compute out across `os.cpus()-1` worker_threads.
  // Each worker opens its own bun:sqlite read handle (WAL mode), runs
  // parse + walk + rule eval against a slice, and returns serializable
  // per-file results. The main thread persists — SQLite writes
  // serialize at the engine level anyway.
  if (shouldUsePerFileWorkers(targetFiles.length)) {
    await runFileLoopInWorkers(args);
    return;
  }
  await streamingDispatch({
    items: targetFiles,
    maxInflight: BIOMARKER_PERFILE_INFLIGHT,
    signal: options.signal,
    work: async (relPath) => {
      const currentHash = currentHashes.get(relPath);
      await analyseSingleFile({ ctx, relPath, currentHash, stats });
      options.onProgress?.(stats.filesScanned, total);
    },
  });
}

/** B22 worker-pool branch of `runFileLoop`. Filters diagnostic paths
 *  and cache hits on the main thread (cheap, no compute) before
 *  dispatching the compute-bound remainder to workers. Aggregates the
 *  workers' serializable per-file results back into `stats` and
 *  persists via the existing `replaceFindingsForFile` /
 *  `persistLocSnapshots` / `persistNodeMetrics` functions.
 *
 *  Persistence stays on the main thread (single DB handle) — SQLite
 *  serializes writes at the engine level so parallelizing them would
 *  just queue at the write lock. */
async function runFileLoopInWorkers(args: FileLoopArgs): Promise<void> {
  const { ctx, targetFiles, currentHashes, stats, options } = args;
  const total = targetFiles.length;
  // Pre-filter: handle diagnostic paths + cache hits inline so workers
  // only see files that need real compute. Mirrors the early-return
  // branches at the top of `analyseSingleFile`.
  const filesToCompute: Array<{ relPath: string; currentHash: string | null }> = [];
  for (const relPath of targetFiles) {
    if (options.signal?.aborted) return;
    const currentHash = currentHashes.get(relPath);
    if (isDiagnosticPath(relPath)) {
      replaceFindingsForFile({ qb: ctx.queries, filePath: relPath, findingsByNode: new Map(), passKind: ctx.passKind });
      if (currentHash) ctx.nextCache[relPath] = currentHash;
      stats.filesScanned++;
      options.onProgress?.(stats.filesScanned, total);
      continue;
    }
    if (currentHash && ctx.cachedHashes[relPath] === currentHash) {
      stats.filesSkippedByCache++;
      stats.filesScanned++;
      options.onProgress?.(stats.filesScanned, total);
      continue;
    }
    filesToCompute.push({ relPath, currentHash: currentHash ?? null });
  }
  if (filesToCompute.length === 0) return;

  const results = await runPerFileBiomarkersInWorkers({
    dbPath: getDatabasePath(ctx.projectRoot),
    projectRoot: ctx.projectRoot,
    files: filesToCompute,
    nowMs: ctx.nowMs,
  });

  // Persist on the main thread. The existing helpers expect Maps —
  // structuredClone through postMessage preserves Map shape so no
  // conversion needed.
  for (const result of results) {
    if (options.signal?.aborted) return;
    aggregatePerFileResult(ctx, result, stats);
    stats.filesScanned++;
    options.onProgress?.(stats.filesScanned, total);
  }
}

/** Apply one worker result: stats aggregation + persistence. Mirrors
 *  the persist tail of `analyseSingleFile`. Non-'computed' outcomes
 *  just bump stats; 'computed' outcomes additionally write findings,
 *  loc snapshots, and node metrics. */
function aggregatePerFileResult(ctx: AnalysisContext, result: PerFileResult, stats: AnalysisStats): void {
  // Merge stats deltas. `filesScanned` is bumped by the caller
  // (one per result, regardless of outcome) so it's NOT included
  // in the worker's statsDelta.
  stats.symbolsAnalysed += result.statsDelta.symbolsAnalysed;
  stats.findingsEmitted += result.statsDelta.findingsEmitted;
  stats.unsupportedLanguages += result.statsDelta.unsupportedLanguages;
  stats.errors += result.statsDelta.errors;
  stats.skippedRangeMismatch += result.statsDelta.skippedRangeMismatch;

  // Cache update happens on ALL outcomes that produced a current
  // hash — matches `loadAnalysableSource`'s behaviour where even
  // 'no-analysable' and 'unsupported-language' files get their hash
  // cached so the next pass short-circuits cheaply.
  if (result.currentHash) {
    if (result.outcome === 'no-analysable' || result.outcome === 'unsupported-language') {
      ctx.nextCache[result.relPath] = result.currentHash;
      return;
    }
  }

  if (result.outcome !== 'computed') return;

  // For computed files: persist findings, loc snapshots, metrics.
  // Persistence errors increment stats.errors via the existing helpers.
  persistAnalysisResults({
    ctx,
    relPath: result.relPath,
    currentHash: result.currentHash ?? undefined,
    findingsByNode: result.findingsByNode ?? new Map(),
    stats,
  });
  if (result.locByNode) persistLocSnapshots(ctx, result.relPath, result.locByNode);
  if (result.metricsByNode) persistNodeMetrics(ctx, result.relPath, result.metricsByNode);
}

/** Concurrency cap for the per-file biomarker analysis stream.
 *  Each in-flight slot holds a read-file + parse + walk + persist
 *  pipeline; sync parts serialize on the event loop, so the win is
 *  bounded to the I/O overlap. 8 is empirically the sweet spot on
 *  M-series — high enough to keep the disk queue saturated, low
 *  enough that the DB-write batching doesn't get pathological. */
const BIOMARKER_PERFILE_INFLIGHT = 8;

/** Build the public AnalysisResult from accumulated stats + elapsed time. */
function buildAnalysisResult(stats: AnalysisStats, durationMs: number): AnalysisResult {
  return {
    filesScanned: stats.filesScanned,
    symbolsAnalysed: stats.symbolsAnalysed,
    findingsEmitted: stats.findingsEmitted,
    unsupportedLanguages: stats.unsupportedLanguages,
    errors: stats.errors,
    durationMs,
    filesSkippedByCache: stats.filesSkippedByCache,
    skippedRangeMismatch: stats.skippedRangeMismatch,
  };
}

export async function analyseProject(
  queries: QueryBuilder,
  projectRoot: string,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const t0 = Date.now();
  const { fileFilter, targetFiles, currentHashes, cachedHashes, nextCache } = buildAnalysisInputs(queries, options);

  await preloadBiomarkerGrammars(queries, targetFiles);

  const stats: AnalysisStats = {
    filesScanned: 0,
    symbolsAnalysed: 0,
    findingsEmitted: 0,
    unsupportedLanguages: 0,
    errors: 0,
    crossFileErrors: 0,
    filesSkippedByCache: 0,
    skippedRangeMismatch: 0,
  };
  // Surface-reason tag stamped on every row this pass writes. A full
  // pass (no fileFilter) writes 'full-pass'; an edit-triggered partial
  // sync writes 'partial-rescan' so the ranked-mode response can tell
  // the agent "this finding emerged from your edit, not from the last
  // full-project enumeration." See `pass_kind` doc in schema.sql.
  const passKind: PassKind = fileFilter ? 'partial-rescan' : 'full-pass';

  // BEFORE a full pass starts, demote every existing row to 'cached'.
  // Rows the pass subsequently rewrites flip back to 'full-pass';
  // rows that the per-file content-hash cache short-circuits stay at
  // 'cached' — the file's source didn't change, so the finding is
  // believed accurate but wasn't re-evaluated this pass.
  if (!fileFilter) {
    demoteFullPassRowsToCached(queries);
  }

  const ctx: AnalysisContext = {
    queries,
    projectRoot,
    cachedHashes,
    nextCache,
    nowMs: Date.now(),
    passKind,
  };

  await runFileLoop({ ctx, targetFiles, currentHashes, stats, options });

  // Persist on full pass only — partial syncs (fileFilter set) would
  // corrupt the cache by dropping unanalysed entries.
  if (!fileFilter) {
    persistBiomarkerCache(queries, nextCache, currentHashes);
    // After a full pass, files that hit the content-hash cache were
    // *checked* and confirmed valid — they should carry `'full-pass'`
    // the same as actively re-evaluated files. Without this promotion,
    // `mode:stats` shows `full-pass: N` for cross-file findings but
    // `mode:ranked` shows `cached` for per-file findings, even though
    // both sets were validated by the same full-project scan (G3 fix).
    promoteFullPassCachedToFullPass(queries);
  }
  // Cross-file rules depend on full project edge context (unused_export
  // needs ALL ref edges, god_class needs all member edges, feature_envy
  // needs the complete call graph). Running them on a partial-rescan
  // (one or a few files changed) produces massive false-positive storms:
  // a 1-file rescan sees only a subset of ref edges, so every exported
  // symbol in the scanned file appears unused. Preserve the last full-pass
  // result for cross-file biomarkers instead of recomputing incorrectly.
  // They are re-evaluated on the next full project pass (no fileFilter).
  if (!fileFilter) {
    await runCrossFileBiomarkers({ queries, stats, projectRoot, passKind });
    // Stamp the moment the cross-file pass completed for this index
    // generation. `areBiomarkersPending` reads this against
    // `index_timestamp` to distinguish a genuinely 0/0/0 project from
    // one where the post-hook simply hasn't run yet (G10.7). Only set
    // on the full-pass path — a partial-rescan skips cross-file rules
    // (see the `!fileFilter` guard above) so its completion would
    // misrepresent the cross-file state of the index.
    setMetadata(queries, 'biomarker_cross_file_pass_at', String(Date.now()));
    // Persist the cross-file rule-error count for this full pass so the
    // CI floor gate can fail-closed: a non-zero value means a rule
    // crashed / a worker timed out and its preserved findings are stale,
    // so an apparently-clean `code_health_findings` table can't be
    // trusted. Read by `scripts/check-biomarkers.mjs` (key must match).
    setMetadata(queries, 'biomarker_cross_file_errors', String(stats.crossFileErrors));
  }

  return buildAnalysisResult(stats, Date.now() - t0);
}

/**
 * Mutable run-totals threaded through `analyseSingleFile` and the
 * cross-file rules. Bundling them in a struct keeps the per-file
 * helper signature manageable and means the loop can read final
 * totals from a single object after the pass.
 */
interface AnalysisStats {
  filesScanned: number;
  symbolsAnalysed: number;
  findingsEmitted: number;
  unsupportedLanguages: number;
  errors: number;
  /**
   * Cross-file rule errors/timeouts ONLY (subset of {@link errors}).
   * Tracked separately because the cross-file rules are deterministic
   * pure reads over committed tables — a healthy full pass produces 0,
   * so a non-zero count is a hard signal that a rule crashed or a worker
   * timed out and its findings (which `reconcileCrossFileRuleResult`
   * preserves rather than refreshes) are stale. Persisted to the
   * `biomarker_cross_file_errors` metadata key and gated in CI
   * (`scripts/check-biomarkers.mjs`) so the 0-err/0-warn floor can't be
   * read as clean when a rule silently failed to run.
   */
  crossFileErrors: number;
  filesSkippedByCache: number;
  /**
   * Symbols skipped because the AST node returned by `findNodeInTree`
   * spans a region significantly larger than the DB node's recorded
   * line range. Defensive guard against the friction #20 shape:
   * inflated cyclomatic written for a small symbol because bodyNode
   * resolved to a containing function much bigger than what extraction
   * stored. Skip-and-log is honest — we'd rather drop a metric than
   * persist a wrong one.
   */
  skippedRangeMismatch: number;
}

/** Arguments for {@link astBodyNodeRangeMismatch}. */
export interface AstRangeMismatchArgs {
  dbStartLine: number;
  dbEndLine: number;
  /** 0-indexed tree-sitter start row. */
  astStartRow: number;
  /** 0-indexed tree-sitter end row. */
  astEndRow: number;
}

/**
 * Defensive guard: does the AST bodyNode span a region wildly larger
 * than what the DB recorded for this symbol? Returns true when the
 * AST node's end-line exceeds the DB end-line by more than `slack`
 * (10) lines AND the AST span is more than 2× the DB span.
 *
 * Both bounds matter:
 * - Pure `+10` slack would catch large genuine functions whose AST
 *   range legitimately differs from extraction by a handful of lines
 *   (decorators, JSDoc placement, trailing comments).
 * - Pure `2×` would catch tiny one-line lambdas where any noise
 *   trips the multiplier.
 *
 * The friction #20 repro had dbLines=15 / astLines≈60+ — clears both
 * bounds easily. Routine cases with ±3 line drift clear neither.
 *
 * Exported for unit-testing without DB plumbing.
 *
 * @internal
 */
export function astBodyNodeRangeMismatch(args: AstRangeMismatchArgs): boolean {
  // Delegate to the shared implementation in `per-file-shared.ts` so
  // the in-main and worker paths can't drift. Exported here for the
  // existing unit tests that import from this module.
  return sharedAstBodyNodeRangeMismatch(args);
}

/** Read-mostly inputs to `analyseSingleFile`; only `nextCache` is mutated. */
interface AnalysisContext {
  queries: QueryBuilder;
  projectRoot: string;
  cachedHashes: Record<string, string>;
  nextCache: Record<string, string>;
  /**
   * Wall-clock for this analyseProject pass. Captured once at pass
   * start so every per-file snapshot stamps the same `indexed_ts`,
   * which is what the recently_grew time-window comparison expects.
   */
  nowMs: number;
  /**
   * Surface-reason tag for every row this pass writes. 'full-pass' on
   * an unfiltered run, 'partial-rescan' when triggered by a per-edit
   * sync. Threaded through `persistAnalysisResults` and the cross-file
   * orchestrator so each insert is correctly stamped.
   */
  passKind: PassKind;
}

/**
 * Per-file content-hash cache. Skip files whose source hasn't
 * changed since the last successful analysis — their findings in
 * `code_health_findings` from the prior run are still valid. The
 * cache is a JSON blob in `project_metadata`; load + save is one
 * DB round-trip each. Profile against the cartograph self-index
 * showed biomarkers was 45% of postHooks; a no-change rerun now
 * skips O(filesScanned) work and runs 2-5ms instead of ~480ms.
 */
function loadBiomarkerCache(queries: QueryBuilder): Record<string, string> {
  try {
    const blob = getMetadata(queries, BIOMARKER_CACHE_KEY);
    if (blob) return JSON.parse(blob) as Record<string, string>;
  } catch (err) {
    logDebug('Biomarkers: cache read failed (treating as cold)', { err: String(err) });
  }
  return {};
}

/**
 * Whether the persisted biomarker cache is empty (no per-file hashes
 * recorded under the current cache key). The afterSync hook reads this
 * to decide whether to omit the `filePaths` filter and run a one-shot
 * full pass — the next pass repopulates the cache, so this returns
 * `true` exactly once after a cache version bump (or on a fresh
 * project) and then `false` until the next bump.
 *
 * NOT a "staleness" check — it only flags absence. Per-file staleness
 * is handled inside `analyseSingleFile` via the content-hash compare.
 */
export function isBiomarkerCacheCold(queries: QueryBuilder): boolean {
  const cache = loadBiomarkerCache(queries);
  return Object.keys(cache).length === 0;
}

/**
 * Extraction runs in worker threads but biomarker analysis runs in
 * the main process. Preload grammars for the languages we'll see in
 * the first 200 files — otherwise `getParser()` returns null and the
 * engine silently produces base metrics with no findings.
 */
async function preloadBiomarkerGrammars(queries: QueryBuilder, targetFiles: ReadonlyArray<string>): Promise<void> {
  const supportedLanguages = new Set<Language>();
  for (const file of targetFiles.slice(0, 200)) {
    const nodes = queries.getNodesByFile(file);
    if (nodes.length > 0) supportedLanguages.add(nodes[0]!.language);
  }
  if (supportedLanguages.size === 0) return;
  try {
    await loadGrammarsForLanguages([...supportedLanguages]);
  } catch (err) {
    logDebug('Biomarkers: grammar preload failed', { err: String(err) });
  }
}

interface SingleFileArgs {
  ctx: AnalysisContext;
  relPath: string;
  currentHash: string | undefined;
  stats: AnalysisStats;
}

/**
 * Analyse one file: cache check → read → enumerate analysable nodes
 * → parse once → run rules per symbol → persist. All the state
 * mutations happen on the passed-in `stats` and `ctx.nextCache` so
 * the caller can read final totals after the loop. Errors at every
 * step short-circuit the file (incrementing `filesScanned` so the
 * progress callback stays accurate).
 */
async function analyseSingleFile(args: SingleFileArgs): Promise<void> {
  const { ctx, relPath, currentHash, stats } = args;
  // Diagnostic / one-off scripts (scripts/, bench/, examples/, demos/)
  // are written as flat top-level functions because that's the most
  // readable shape for an ad-hoc tool. Skip them — production-code
  // health bars don't apply, and findings here would just inflate the
  // ranked-mode output without informing the user about real risk.
  if (isDiagnosticPath(relPath)) {
    replaceFindingsForFile({ qb: ctx.queries, filePath: relPath, findingsByNode: new Map(), passKind: ctx.passKind });
    if (currentHash) ctx.nextCache[relPath] = currentHash;
    stats.filesScanned++;
    return;
  }
  if (currentHash && ctx.cachedHashes[relPath] === currentHash) {
    stats.filesSkippedByCache++;
    stats.filesScanned++;
    return;
  }

  const prep = await loadAnalysableSource({ ctx, relPath, currentHash, stats });
  if (!prep) return;
  const tree = parseAnalysableSource({ src: prep.src, language: prep.language, relPath, stats });
  if (!tree) return;

  const priorByNode = getPriorLocSnapshots(
    ctx.queries,
    prep.analysable.map((n) => n.id),
    ctx.nowMs,
  );
  const { findingsByNode, locByNode, metricsByNode } = evaluateAnalysableNodes({
    tree,
    analysable: prep.analysable,
    language: prep.language,
    stats,
    priorByNode,
    nowMs: ctx.nowMs,
  });
  evaluateConstantStaleDocs({ allNodes: prep.allNodes, findingsByNode, stats });
  evaluateFileSecretsHandling({ allNodes: prep.allNodes, relPath, src: prep.src, findingsByNode, stats });
  persistAnalysisResults({ ctx, relPath, currentHash, findingsByNode, stats });
  persistLocSnapshots(ctx, relPath, locByNode);
  persistNodeMetrics(ctx, relPath, metricsByNode);
  stats.filesScanned++;
}

/** Persist loc-history snapshots for every analysed node; soft-fails on insert errors. */
function persistLocSnapshots(ctx: AnalysisContext, relPath: string, locByNode: Map<string, number>): void {
  if (locByNode.size === 0) return;
  const rows = [...locByNode.entries()].map(([nodeId, loc]) => ({ nodeId, ts: ctx.nowMs, loc }));
  try {
    recordLocSnapshots(ctx.queries, rows);
  } catch (err) {
    logDebug('Biomarkers: loc-history persist failed', { file: relPath, err: String(err) });
  }
}

/** Persist per-node metrics (cyclo/nesting/etc.) in one batch upsert; soft-fails. */
function persistNodeMetrics(
  ctx: AnalysisContext,
  relPath: string,
  metricsByNode: Map<
    string,
    {
      loc: number;
      cyclomatic: number;
      maxNesting: number;
      maxConditionalOperands: number;
      paramCount: number;
      magicNumberCount: number;
      hardcodedUrlCount: number;
    }
  >,
): void {
  if (metricsByNode.size === 0) return;
  const rows = [...metricsByNode.entries()].map(([nodeId, m]) => ({
    nodeId,
    loc: m.loc,
    cyclomatic: m.cyclomatic,
    maxNesting: m.maxNesting,
    maxConditionalOperands: m.maxConditionalOperands,
    paramCount: m.paramCount,
    magicNumberCount: m.magicNumberCount,
    hardcodedUrlCount: m.hardcodedUrlCount,
    updatedTs: ctx.nowMs,
  }));
  try {
    upsertNodeMetricsBatch(ctx.queries, rows);
  } catch (err) {
    logDebug('Biomarkers: node_metrics persist failed', { file: relPath, err: String(err) });
  }
}

/**
 * Read the file + filter to analysable symbols + check language
 * support. Returns null (and increments `filesScanned`) when the file
 * should be skipped — unreadable, no analysable symbols, or
 * unsupported language. Hash is cached for the no-symbols and
 * unsupported-language paths so the next pass short-circuits cheaply.
 */
async function loadAnalysableSource(
  args: SingleFileArgs,
): Promise<{ src: string; allNodes: Node[]; analysable: Node[]; language: Language } | null> {
  const { ctx, relPath, currentHash, stats } = args;
  let src: string;
  try {
    src = await fs.promises.readFile(path.join(ctx.projectRoot, relPath), 'utf-8');
  } catch (err) {
    logDebug('Biomarkers: file unreadable', { path: relPath, err: String(err) });
    stats.filesScanned++;
    return null;
  }
  // B33 (2026-05-24) — fetch nodes for this file ONCE. The per-file
  // pipeline previously called `getNodesByFile(relPath)` three times
  // (analysable filter / constant stale-doc / file secrets-handling).
  // On a 39K-file corpus × 3 queries = 117K DB roundtrips; the worker
  // pool (B22) multiplied this by N workers all hitting the same
  // sqlite WAL. Caller derives `analysable` + downstream filters from
  // this single list.
  const allNodes = ctx.queries.getNodesByFile(relPath);
  const analysable = allNodes.filter((n) => ANALYSABLE_KINDS.has(n.kind));
  if (analysable.length === 0) {
    if (currentHash) ctx.nextCache[relPath] = currentHash;
    stats.filesScanned++;
    return null;
  }
  const language = analysable[0]!.language;
  if (!getLangMap(language)) {
    stats.unsupportedLanguages++;
    if (currentHash) ctx.nextCache[relPath] = currentHash;
    stats.filesScanned++;
    return null;
  }
  return { src, allNodes, analysable, language };
}

/**
 * Parse the file ONCE and reuse the tree across every symbol —
 * re-parsing per symbol exhausted the WASM tree-sitter heap on big
 * C/C++ files and crashed with "memory access out of bounds".
 * Returns null on parse failure or when the parser returns no tree
 * (silently — the langMap-missing case is handled earlier).
 */
interface ParseSourceArgs {
  src: string;
  language: Language;
  relPath: string;
  stats: AnalysisStats;
}

function parseAnalysableSource(args: ParseSourceArgs): ReturnType<typeof parseSource> | null {
  const { src, language, relPath, stats } = args;
  try {
    const tree = parseSource(src, language);
    if (!tree) {
      stats.filesScanned++;
      return null;
    }
    return tree;
  } catch (err) {
    stats.errors++;
    logDebug('Biomarkers: parse failed', { path: relPath, err: String(err) });
    stats.filesScanned++;
    return null;
  }
}

/**
 * Per-symbol rule evaluation — attribute findings back to their
 * indexed node id. Symbols smaller than `MIN_LOC` are skipped (most
 * thresholds are meaningless on a 5-line function). Errors are
 * counted and logged but never thrown — one bad symbol shouldn't
 * abort the whole file's analysis.
 */
interface EvaluateAnalysableArgs {
  tree: NonNullable<ReturnType<typeof parseSource>>;
  analysable: Node[];
  language: Language;
  stats: AnalysisStats;
  priorByNode: ReadonlyMap<string, { loc: number; ts: number }>;
  nowMs: number;
}

interface SymbolAccumulators {
  findingsByNode: Map<string, Finding[]>;
  locByNode: Map<string, number>;
  metricsByNode: Map<string, ReturnType<typeof computeMetrics>>;
}

/**
 * Evaluate one symbol: find its AST node, guard against range mismatch,
 * compute metrics, run rules, and accumulate into the maps. Mutates
 * `stats` and the accumulator maps in place; skips silently when the AST
 * node is missing or the range-mismatch guard fires. Errors during rule
 * evaluation are caught + counted, never thrown.
 *
 * @internal
 */
interface EvaluateSingleSymbolArgs {
  n: Node;
  tree: NonNullable<ReturnType<typeof parseSource>>;
  language: Language;
  priorByNode: ReadonlyMap<string, { loc: number; ts: number }>;
  nowMs: number;
  stats: AnalysisStats;
  acc: SymbolAccumulators;
}

function evaluateSingleSymbol(args: EvaluateSingleSymbolArgs): void {
  const { n, tree, language, priorByNode, nowMs, stats, acc } = args;
  try {
    const astNode = findNodeInTree(tree, n.startLine, n.startColumn);
    if (!astNode) return;
    // Guard against the friction #20 shape: bodyNode resolves to a
    // containing function much bigger than the symbol stored in the
    // DB. Without this, the DFS over-counts and we persist an
    // inflated cyclomatic that survives across syncs via the
    // file-level hash cache. Skip-and-log is honest.
    if (
      astBodyNodeRangeMismatch({
        dbStartLine: n.startLine,
        dbEndLine: n.endLine,
        astStartRow: astNode.startPosition.row,
        astEndRow: astNode.endPosition.row,
      })
    ) {
      stats.skippedRangeMismatch++;
      logDebug('Biomarkers: AST bodyNode range mismatch — skipping symbol', {
        nodeId: n.id,
        name: n.name,
        dbStart: n.startLine,
        dbEnd: n.endLine,
        astStart: astNode.startPosition.row + 1,
        astEnd: astNode.endPosition.row + 1,
      });
      return;
    }
    const metrics = computeMetrics({ bodyNode: astNode, language, startLine: n.startLine, endLine: n.endLine });
    acc.locByNode.set(n.id, metrics.loc);
    acc.metricsByNode.set(n.id, metrics);
    const findings = evaluateRules({ nodeId: n.id, language, metrics, prior: priorByNode.get(n.id), nowMs });
    if (findings.length > 0) {
      acc.findingsByNode.set(n.id, findings);
      stats.findingsEmitted += findings.length;
    }
    stats.symbolsAnalysed++;
  } catch (err) {
    stats.errors++;
    logDebug('Biomarkers: rule evaluation failed', { node: n.id, err: String(err) });
  }
}

function evaluateAnalysableNodes(args: EvaluateAnalysableArgs): SymbolAccumulators {
  const { tree, analysable, language, stats, priorByNode, nowMs } = args;
  const acc: SymbolAccumulators = {
    findingsByNode: new Map(),
    locByNode: new Map(),
    metricsByNode: new Map(),
  };
  for (const n of analysable) {
    if (n.endLine - n.startLine + 1 < MIN_LOC) continue;
    evaluateSingleSymbol({ n, tree, language, priorByNode, nowMs, stats, acc });
  }
  return acc;
}

/**
 * Per-file constant pass: stale_doc heuristic on every constant node
 * with both a docstring and a signature. Findings are merged into
 * the existing per-node map so the same persist call handles them.
 * Errors short-circuit the constant (counted) instead of aborting
 * the file's persist.
 */
interface ConstantStaleDocArgs {
  /** B33 (2026-05-24) — pre-fetched node list for this file (avoids
   *  re-querying `getNodesByFile`). Filtered in-memory for kind ===
   *  'constant'. */
  allNodes: ReadonlyArray<Node>;
  findingsByNode: Map<string, Finding[]>;
  stats: AnalysisStats;
}

/**
 * Per-file secrets-handling pass (Stage 7 #1 integration). Scans
 * every analysable symbol's name + signature + docstring + body
 * (sliced from `src` by line range) via {@link detectSecretsHandling};
 * emits a `secrets_handling` finding when score >= 0.3.
 *
 * Body inspection catches literal AWS access keys, hardcoded JWTs,
 * `process.env.SECRET_*` reads, and other in-body signals that the
 * name/signature heuristics alone miss.
 */
interface SecretsHandlingArgs {
  /** B33 (2026-05-24) — pre-fetched node list for this file. Filtered
   *  in-memory for ANALYSABLE_KINDS. */
  allNodes: ReadonlyArray<Node>;
  relPath: string;
  /** File source as a single string — sliced per node via 1-based
   *  startLine/endLine. */
  src: string;
  findingsByNode: Map<string, Finding[]>;
  stats: AnalysisStats;
}

/**
 * Slice the file source for a node's body using its 1-based
 * startLine/endLine range. Returns '' on degenerate ranges so the
 * detector still sees an empty body input rather than failing.
 */
function sliceNodeBody(src: string, startLine: number, endLine: number): string {
  if (!src || endLine < startLine) return '';
  const lines = src.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  if (start >= end) return '';
  return lines.slice(start, end).join('\n');
}

/**
 * Self-implementation carve-out. The secrets_handling rule's own
 * source files contain the rule's keyword patterns (`api_key`,
 * `password`, `AKIA…`, etc.) by necessity, which causes the rule
 * to flag its own body as a secrets-handling symbol. This is the
 * standard exemption every secret-scanner ships — you cannot write
 * a secret scanner whose tool flags itself.
 *
 * Industry-norm citation: trufflehog, gitleaks, and detect-secrets
 * all skip their own pattern-definition files via similar
 * carve-outs (file allowlists or path-based exemptions).
 */
// SECRETS_RULE_SELF_PATHS lives in `./per-file-shared.ts` so the
// worker path and this in-main path can't drift. The local helper
// just delegates to the shared `isSecretsRuleSelfPath`.

function isSecretsRuleImpl(relPath: string): boolean {
  return sharedIsSecretsRuleSelfPath(relPath);
}

function evaluateFileSecretsHandling(args: SecretsHandlingArgs): void {
  const { allNodes, relPath, src, findingsByNode, stats } = args;
  if (isSecretsRuleImpl(relPath)) return;
  // B33 — filter the pre-fetched node list in-memory (no DB query).
  const nodes = allNodes.filter((n) => ANALYSABLE_KINDS.has(n.kind));
  for (const n of nodes) {
    try {
      const body = sliceNodeBody(src, n.startLine, n.endLine);
      const finding = evaluateSecretsHandling({
        id: n.id,
        name: n.name,
        signature: n.signature ?? null,
        docstring: n.docstring ?? null,
        summary: null, // summaries land via the LLM pipeline; biomarker pass runs earlier
        body, // Stage 7 #1 body inspection — catches literal AWS keys,
        // hardcoded tokens, env-secret reads, etc.
      });
      if (!finding) continue;
      const existing = findingsByNode.get(n.id);
      if (existing) existing.push(finding);
      else findingsByNode.set(n.id, [finding]);
      stats.findingsEmitted++;
    } catch (err) {
      stats.errors++;
      logDebug('Biomarkers: secrets_handling evaluation failed', { node: n.id, err: String(err) });
    }
  }
}

/**
 * Build the set of docstrings that appear on 2+ constants in the same
 * file. These are presumed to be inherited file-block prose comments
 * (the Go extractor attaches the file-level block comment to every
 * const in a `const ( ... )` block) rather than constant-specific
 * value claims, and stale_doc should skip them.
 *
 * Solo docstrings (count === 1) are kept — they're presumed value-
 * specific and remain subject to the regular drift check.
 *
 * Exported for testability — the dedup pass is the entire fix for
 * ollama bug-hunt FP-2; inlining it would lose direct test coverage
 * for the threshold rule.
 */
export function sharedDocstringsAcrossConstants(constants: ReadonlyArray<{ docstring?: string | null }>): Set<string> {
  // Delegate to the shared implementation in `per-file-shared.ts` so
  // the in-main and worker paths can't drift. Exported here for the
  // existing tests that import from this module.
  return sharedSharedDocstringsAcrossConstants(constants);
}

function evaluateConstantStaleDocs(args: ConstantStaleDocArgs): void {
  const { allNodes, findingsByNode, stats } = args;
  // B33 — filter the pre-fetched node list in-memory (no DB query).
  const constants = allNodes.filter((n) => n.kind === 'constant');
  const sharedDocstrings = sharedDocstringsAcrossConstants(constants);
  for (const c of constants) {
    try {
      if (c.docstring && sharedDocstrings.has(c.docstring)) continue;
      const finding = evaluateStaleDoc({ id: c.id, docstring: c.docstring, signature: c.signature });
      if (!finding) continue;
      const existing = findingsByNode.get(c.id);
      if (existing) existing.push(finding);
      else findingsByNode.set(c.id, [finding]);
      stats.findingsEmitted++;
    } catch (err) {
      stats.errors++;
      logDebug('Biomarkers: stale_doc evaluation failed', { node: c.id, err: String(err) });
    }
  }
}

/**
 * Replace this file's findings (always — a now-clean file needs its
 * stale rows dropped) and update the cache hash on persistence
 * success. A failed write retries next pass instead of pretending
 * the file is clean.
 */
interface PersistResultsArgs {
  ctx: AnalysisContext;
  relPath: string;
  currentHash: string | undefined;
  findingsByNode: Map<string, Finding[]>;
  stats: AnalysisStats;
}

function persistAnalysisResults(args: PersistResultsArgs): void {
  const { ctx, relPath, currentHash, findingsByNode, stats } = args;
  try {
    replaceFindingsForFile({ qb: ctx.queries, filePath: relPath, findingsByNode, passKind: ctx.passKind });
    if (currentHash) ctx.nextCache[relPath] = currentHash;
  } catch (err) {
    stats.errors++;
    logWarn('Biomarkers: persistence failed', { file: relPath, err: String(err) });
  }
}

/**
 * Persist the per-file cache for the next run. Prune entries for
 * files no longer in the index so the cache doesn't grow unboundedly
 * across a long-lived project.
 */
function persistBiomarkerCache(
  queries: QueryBuilder,
  nextCache: Record<string, string>,
  currentHashes: Map<string, string>,
): void {
  for (const cachedPath of Object.keys(nextCache)) {
    if (!currentHashes.has(cachedPath)) delete nextCache[cachedPath];
  }
  try {
    setMetadata(queries, BIOMARKER_CACHE_KEY, JSON.stringify(nextCache));
  } catch (err) {
    logDebug('Biomarkers: cache write failed', { err: String(err) });
  }
}

/**
 * Cross-file biomarkers depend on global graph state, so they re-run
 * on every pass — full indexAll AND partial sync. `replaceFindingsForFile`
 * preserves their rows on per-file replace; this pass then clears and
 * recomputes each kind atomically against the current graph. Skipping
 * partial syncs (the prior gating) left findings stale until the next
 * full reindex.
 *
 * Six rules (registered declaratively in `CROSS_FILE_RULES` below):
 * - `unused_export` — exported symbols with no incoming refs.
 * - `god_class` — class-like nodes with too many member children
 *   (thresholds from Lanza/Marinescu + CodeScene's published WMC
 *   ranges; conservative end to avoid spamming a fresh codebase).
 * - `feature_envy` — methods calling into other files ≥5× and ≥2×
 *   more than into their own file (5× floor skips tiny helpers; 2×
 *   ratio is a robust threshold from the literature).
 * - `illegal_import` — user-defined architectural layering violations
 *   (opt-in via `CartographConfig.layers`).
 * - `low_coverage` — high-centrality symbols with insufficient test
 *   coverage (silent until an lcov report is ingested).
 * - `duplicate_code` — exact (Type-1) code clones, symbols sharing a
 *   byte-identical `body_hash`.
 */
// god_class WMC thresholds (Lanza/Marinescu + CodeScene bands), shifted
// up from the textbook (15/25/40) because this codebase's facade
// pattern (Cartograph, QueryBuilder, CartographLlmService) and language
// extractors are intentionally cohesive — the member count IS the
// public surface. info=15 keeps the look-at-me signal; warning=40
// only fires past the facade-pattern ceiling; error=60 is the
// "definitely too big" tier.
const T_GOD_INFO = 15;
const T_GOD_WARN = 40;
const T_GOD_ERR = 60;
// feature_envy ATFD/LAA/FDP thresholds (Lanza & Marinescu textbook
// values from "Object-Oriented Metrics in Practice"). Detection
// fires when ALL three hold: ATFD > FE_ATFD_MIN AND FDP <= FE_FDP_MAX
// AND LAA < FE_LAA_MAX.
/** ATFD — distinct foreign field accesses required (FEW threshold). */
const FE_ATFD_MIN = 5;
/** FDP — max distinct foreign data providers; small = focused envy. */
const FE_FDP_MAX = 2;
/** LAA — own-class accesses / total. Below this = envy. */
const FE_LAA_MAX = 1 / 3;
/** ATFD count above which the finding escalates from info to warning. */
const FE_ESCALATE_TO_WARNING = 12;

/** Map a god_class member count to a severity tier. */
function godClassSeverity(memberCount: number): 'info' | 'warning' | 'error' {
  if (memberCount >= T_GOD_ERR) return 'error';
  if (memberCount >= T_GOD_WARN) return 'warning';
  return 'info';
}

/**
 * Declarative registry of cross-file biomarker rules. Each entry maps a
 * `CrossFileBiomarkerName` to a `produce` callback that returns the full
 * Finding[] for that kind. Adding a new cross-file rule requires only a
 * new entry here — no second edit-site.
 *
 * `produce` receives `queries` and `projectRoot`; the callback is
 * responsible for any config loading it needs (see `illegal_import`).
 */
interface CrossFileRuleSpec {
  kind: CrossFileBiomarkerName;
  produce: (queries: QueryBuilder, projectRoot: string) => Finding[];
}

export const CROSS_FILE_RULES: ReadonlyArray<CrossFileRuleSpec> = [
  {
    // Emits at info severity because the underlying query has known
    // false-positive classes the graph layer can't yet distinguish
    // (dynamic imports via `await import(...)` strings, runtime
    // metadata lookups that never form an AST reference). Aliased
    // named imports (`import { X as Y }`) are correctly resolved as
    // of `emitNamedImportRefsFromFile` (tree-sitter-decls.ts) +
    // `pickMatchingImport` (import-resolver.ts) — empirically zero
    // remaining FPs on the in-tree corpus. Findings stay info-severity
    // for the residual classes; promote per-rule if a project surfaces
    // a genuine spike of false positives.
    kind: 'unused_export',
    produce: (queries) =>
      findUnusedExports(queries).map((sym) => ({
        nodeId: sym.id,
        biomarker: 'unused_export' as const,
        severity: 'info' as const,
        metric: 0,
        detail: { kind: sym.kind, name: sym.name },
      })),
  },
  {
    // Member-count band → severity via godClassSeverity.
    kind: 'god_class',
    produce: (queries) =>
      findGodClasses(queries, T_GOD_INFO).map((c) => ({
        nodeId: c.id,
        biomarker: 'god_class' as const,
        severity: godClassSeverity(c.memberCount),
        metric: c.memberCount,
        detail: { name: c.name },
      })),
  },
  {
    // ATFD/LAA/FDP based — see the SQL doc on `findFeatureEnvy` for
    // definitions. The reported `metric` is ATFD (distinct foreign field
    // count) so worst-first ranking surfaces methods with the broadest
    // data envy.
    kind: 'feature_envy',
    produce: (queries) =>
      findFeatureEnvy({
        qb: queries,
        minATFD: FE_ATFD_MIN,
        maxFDP: FE_FDP_MAX,
        maxLAA: FE_LAA_MAX,
      }).map((m) => ({
        nodeId: m.id,
        biomarker: 'feature_envy' as const,
        severity: m.atfd >= FE_ESCALATE_TO_WARNING ? 'warning' : 'info',
        metric: m.atfd,
        detail: {
          name: m.name,
          atfd: m.atfd,
          fdp: m.fdp,
          laa: Math.round(m.laa * 1000) / 1000,
          ownAccesses: m.ownAccesses,
          foreignAccesses: m.foreignAccesses,
        },
      })),
  },
  {
    // User-defined layering rule. Reads `layers` / `layerExceptions`
    // from project config; emits no findings when neither is set so
    // projects opt in by editing config.
    kind: 'illegal_import',
    produce: (queries, projectRoot) => {
      const config = loadConfig(projectRoot);
      return computeIllegalImports({
        queries,
        projectRoot,
        layers: config.layers,
        exceptions: config.layerExceptions,
      });
    },
  },
  {
    // High-centrality + low-coverage symbols. Silent when no lcov has
    // been ingested, so projects without coverage data never see a
    // wall of false alarms. Severity is warning by default and
    // escalates to error when centrality + uncovered-ness are both
    // extreme — see thresholds in `low-coverage.ts`.
    kind: 'low_coverage',
    produce: (queries) => findLowCoverage(queries),
  },
  {
    // Code clones — Tier 1 exact (byte-identical body_hash, `warning`)
    // and Tier 2 near (identical normalised token stream, `info`).
    // Min-size floors + production-only + a config allowlist keep it
    // signal-rich. See `duplicate-code.ts`.
    kind: 'duplicate_code',
    produce: (queries, projectRoot) => findDuplicateCode(queries, projectRoot),
  },
];

interface RunCrossFileBiomarkersArgs {
  queries: QueryBuilder;
  stats: AnalysisStats;
  projectRoot: string;
  passKind: PassKind;
}

/**
 * Filter findings whose owning node lives under a diagnostic /
 * one-off script path. Mirrors the per-file pass's
 * `isDiagnosticPath` skip so cross-file rules don't surface, e.g.,
 * `unused_export` on a `scripts/` helper that the per-file pass
 * deliberately ignored.
 */
function filterDiagnosticFindings(queries: QueryBuilder, raw: Finding[]): Finding[] {
  if (raw.length === 0) return raw;
  const nodeMap = queries.getNodesByIds(raw.map((f) => f.nodeId));
  return raw.filter((f) => {
    const n = nodeMap.get(f.nodeId);
    return !n || !isDiagnosticPath(n.filePath);
  });
}

/**
 * Persist one rule's findings: filter diagnostic paths, then
 * clear-then-append in a single transaction so the rule's row set
 * converges to exactly the freshly-produced findings.
 */
function persistRuleFindings(args: {
  queries: QueryBuilder;
  kind: CrossFileBiomarkerName;
  raw: Finding[];
  passKind: PassKind;
}): number {
  const findings = filterDiagnosticFindings(args.queries, args.raw);
  qbTransaction(args.queries, () => {
    clearFindingsByKind(args.queries, args.kind);
    appendFindings(args.queries, findings, args.passKind);
  });
  return findings.length;
}

/**
 * Outcome of running one cross-file rule, before persistence.
 * `ok: true` carries the freshly-produced findings; `ok: false` carries
 * the error string (a worker error/timeout, or a serial-path throw).
 */
export type CrossFileRuleOutcome = { ok: true; raw: Finding[] } | { ok: false; error: string };

/**
 * Reconcile one cross-file rule's run into `code_health_findings`. The
 * single persistence-decision shared by the serial and worker paths.
 *
 * On SUCCESS — clear-then-append so the rule's row set converges to
 * exactly the freshly-produced findings (see {@link persistRuleFindings}).
 *
 * On ERROR / timeout — PRESERVE the prior pass's rows; do NOT clear.
 * A transient failure (the worker's 60s per-rule timeout, a crash, or a
 * rule throwing) must not be indistinguishable from "the rule
 * legitimately produced nothing": clearing here would silently wipe real
 * findings — including `duplicate_code` exact-clone WARNINGS and
 * `god_class` / `low_coverage` ERRORS — and let a code-health gate that
 * reads `code_health_findings` see a clean table. Stale-but-present beats
 * silently-zero: a later successful pass reconciles to current truth, and
 * FK CASCADE reaps any preserved row whose owning node was since deleted.
 * The worker path adds a per-rule timeout the serial path lacks
 * (`worker-pool.ts`), so the heaviest rule (`duplicate_code`) on a large
 * repo is the most likely to trip this — exactly where a dropped warning
 * would hurt most. (This reverses the pre-2026-05-29 clear-on-error
 * behaviour, which prioritised "don't let stale findings linger" over the
 * far costlier silent false-negative.) The error is logged at WARN so a
 * recurring worker failure is visible, not buried at debug level.
 */
export function reconcileCrossFileRuleResult(args: {
  queries: QueryBuilder;
  kind: CrossFileBiomarkerName;
  passKind: PassKind;
  outcome: CrossFileRuleOutcome;
  source: 'serial' | 'worker';
}): { findingsEmitted: number; errored: boolean } {
  const { queries, kind, passKind, outcome, source } = args;
  if (!outcome.ok) {
    logWarn(`Biomarkers: cross-file rule '${kind}' failed (${source}); keeping prior findings`, {
      err: outcome.error,
    });
    return { findingsEmitted: 0, errored: true };
  }
  return { findingsEmitted: persistRuleFindings({ queries, kind, raw: outcome.raw, passKind }), errored: false };
}

/**
 * Threshold (total node count) above which the worker pool wins on
 * wall-clock. Below it the per-rule work is too small to amortise
 * the ~50–200 ms × 6-workers spawn cost, and serial is faster.
 *
 * The crossover number from `bench/sync-parallel-hooks.mts`:
 *   - 200 files (~200 trivial nodes): serial 4 ms / parallel 51 ms
 *     (workers 12× slower).
 *   - 1500 files (~1500 trivial nodes): serial 18 ms / parallel
 *     65 ms (workers 3.6× slower).
 *   - cartograph repo (~14 000 nodes, real complexity): serial
 *     480 ms / parallel 78 ms (workers 6.15× faster).
 * 10 000 sits in the gap where rule-cost-per-node starts mattering
 * more than spawn overhead on realistic codebases; keep tuning if a
 * bench against another real-world corpus shifts the crossover.
 */
const BIOMARKER_WORKER_NODE_THRESHOLD = 10_000;

/**
 * Count of rows in `nodes`. Used as a cheap proxy for "is this
 * project big enough that worker-pool spawn cost is worth paying."
 * Single `SELECT COUNT(*)` — sub-ms on any indexed project.
 */
function countAllNodesInProject(queries: QueryBuilder): number {
  const row = queries.db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n?: number } | null;
  return row?.n ?? 0;
}

/**
 * Run the 6 cross-file rules SERIALLY on the host connection — the
 * pre-G9-Phase-2C path. Reachable as the small-project fast path
 * (see {@link BIOMARKER_WORKER_NODE_THRESHOLD}) AND behind the
 * `CARTOGRAPH_BIOMARKER_SERIAL=1` env var so
 * `bench/sync-parallel-hooks.mts` can A/B-time both modes against
 * the same corpus without checking out a different commit.
 */
function runCrossFileBiomarkersSerial(args: RunCrossFileBiomarkersArgs): void {
  const { queries, stats, projectRoot, passKind } = args;
  for (const rule of CROSS_FILE_RULES) {
    let outcome: CrossFileRuleOutcome;
    try {
      outcome = { ok: true, raw: rule.produce(queries, projectRoot) };
    } catch (err) {
      outcome = { ok: false, error: String(err) };
    }
    const { findingsEmitted, errored } = reconcileCrossFileRuleResult({
      queries,
      kind: rule.kind,
      passKind,
      outcome,
      source: 'serial',
    });
    stats.findingsEmitted += findingsEmitted;
    if (errored) {
      stats.errors += 1;
      stats.crossFileErrors += 1;
    }
  }
}

async function runCrossFileBiomarkers(args: RunCrossFileBiomarkersArgs): Promise<void> {
  // Bench / A-B-test escape hatch — see runCrossFileBiomarkersSerial.
  if (process.env['CARTOGRAPH_BIOMARKER_SERIAL'] === '1') {
    runCrossFileBiomarkersSerial(args);
    return;
  }

  // Small-project fast path — see BIOMARKER_WORKER_NODE_THRESHOLD.
  // Spawning 6 worker_threads to run rules whose total work is a
  // few ms is a net loss; route to the serial path instead.
  if (countAllNodesInProject(args.queries) < BIOMARKER_WORKER_NODE_THRESHOLD) {
    runCrossFileBiomarkersSerial(args);
    return;
  }

  const { queries, stats, projectRoot, passKind } = args;
  const dbPath = getDatabasePath(projectRoot);
  const ruleKinds = CROSS_FILE_RULES.map((r) => r.kind);

  // G9 Phase 2C — the READ phase (produce → Finding[]) runs in
  // worker_threads (one per rule, each on its own read-only
  // bun:sqlite handle so the host's connection isn't blocked).
  // The WRITE phase (clearFindingsByKind + appendFindings) stays
  // on the host connection because SQLite serialises writes at
  // the engine level — parallelising writes would just queue at
  // the write lock with no gain.
  const results = await runRulesInWorkers({ dbPath, projectRoot, ruleKinds });
  for (const result of results) {
    const { findingsEmitted, errored } = reconcileCrossFileRuleResult({
      queries,
      kind: result.ruleKind,
      passKind,
      outcome: result.error === undefined ? { ok: true, raw: result.findings } : { ok: false, error: result.error },
      source: 'worker',
    });
    stats.findingsEmitted += findingsEmitted;
    if (errored) {
      stats.errors += 1;
      stats.crossFileErrors += 1;
    }
  }
}
