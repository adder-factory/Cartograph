/**
 * Extraction Orchestrator — phase helpers.
 *
 * Carved out of `index.ts` (god-module split, 2026-05-17). Holds the
 * module-scope `eo*` free functions that `ExtractionOrchestrator`'s
 * methods delegate to — the indexAll parse/store/retry phases, the
 * sync change-application phases, and the shared DB-persist helpers.
 *
 * Each `eo*` function takes an `ExtractionOrchestratorState` (immutable
 * deps + the shared cache-hit ref) as its first argument, so they hang
 * off the orchestrator without being class methods — the same
 * explicit-state convention the rest of the extraction core uses.
 *
 * Intentionally NOT in the `EXTRACTION_LOGIC_VERSION` spec set: this
 * file is orchestration (scan → parse → store → counters), not the
 * tree-sitter symbol/edge emit-set. The one caveat is
 * `eoRunFrameworkExtractors`, which DOES emit framework-resolver
 * `Node`s — but that path (and the resolvers in
 * `src/resolution/frameworks/`) has always sat outside the hash; it
 * lived in `index.ts` pre-split, and `index.ts` was never hashed
 * either. So the omission here is a pre-existing gap, not a
 * regression introduced by the god-module split.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
  Node,
  Edge,
  UnresolvedReference,
} from '../types.js';
import { getAllFrameworkResolvers } from '../resolution/frameworks/index.js';
import { qbTransaction } from '../db/queries.js';
import { insertEdges } from '../db/queries-edges.js';
import {
  getAllFiles,
  getFileByPath,
  reconcileFileNodeCounts,
  removeFileFromIndex,
  removeFileFromIndexInTx,
  upsertFile,
} from '../db/queries-files.js';
import { insertUnresolvedRefsBatch } from '../db/queries-unresolved-refs.js';
import { upsertNestedFunctionsForFile } from '../db/queries-nested-functions.js';
import { profile, profileTagged, profileAsyncTagged, flushProfileReport } from './profile.js';
import { streamingDispatch } from '../concurrency.js';
import { SLOW_PARSE_WARN_MS } from './parse-worker-pool.js';
import {
  evictParseCacheIfOversized,
  getCachedParse,
  getLatestStructHashForFile,
  putCachedParse,
} from '../db/queries-parse-cache.js';
import { computeStructHash } from './symbol-body-hash.js';
import { setMetadata } from '../db/queries-metadata.js';
import { whatChanged } from '../change-oracle/index.js';
import { findVanishedFiles } from '../freshness.js';
import { extractFromSource } from './tree-sitter.js';
import { detectLanguage, loadGrammarsForLanguages } from './grammars.js';
import { logDebug, logWarn, errMsg } from '../errors.js';
import {
  validatePathWithinRootReal,
  stripCommentLinesForRetry,
  compact,
  isTestPath,
  stripCommentsForRegex,
} from '../utils.js';
import { buildAhoCorasick, type AhoCorasickAutomaton } from '../utils/aho-corasick.js';
import type { FrameworkResolver } from '../resolution/types.js';
import { getCurrentHeadSha } from '../git-utils.js';
import {
  type ExtractionOrchestrator,
  type ExtractionOrchestratorState,
  type IndexProgress,
  type IndexResult,
  type SyncState,
  type StoreExtractionParams,
  type ParseEnvironment,
  LAST_SYNCED_HEAD_KEY,
  FILE_IO_BATCH_SIZE,
  POOL_SIZE_MAX,
  WORKER_RECYCLE_INTERVAL,
  DEFAULT_PARSE_POOL_SIZE,
  hashContent,
  buildParsePool,
  scanDirectory,
  scanDirectoryAsync,
  type getGitChangedFiles,
} from './index.js';

export interface EoIndexCounters {
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  totalNodes: number;
  totalEdges: number;
  processed: number;
}

/** Build an early-abort IndexResult for use after scan or parse phase. */
export function eoAbortIndexResult(
  startTime: number,
  errors: ExtractionError[],
  counters?: Partial<EoIndexCounters>,
): IndexResult {
  return {
    success: false,
    filesIndexed: counters?.filesIndexed ?? 0,
    filesSkipped: counters?.filesSkipped ?? 0,
    filesErrored: counters?.filesErrored ?? 0,
    nodesCreated: counters?.totalNodes ?? 0,
    edgesCreated: counters?.totalEdges ?? 0,
    errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
    durationMs: Date.now() - startTime,
  };
}

/** Build the final success IndexResult for {@link ExtractionOrchestrator.indexAll}. */
export function eoFinalIndexResult(args: {
  counters: EoIndexCounters;
  errors: ExtractionError[];
  totalMs: number;
  scanMs: number;
  parseStoreMs: number;
  retryMs: number;
}): IndexResult {
  const { counters, errors, totalMs, scanMs, parseStoreMs, retryMs } = args;
  return {
    success: counters.filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
    filesIndexed: counters.filesIndexed,
    filesSkipped: counters.filesSkipped,
    filesErrored: counters.filesErrored,
    nodesCreated: counters.totalNodes,
    edgesCreated: counters.totalEdges,
    errors,
    durationMs: totalMs,
    profile: { scanMs, parseStoreMs, retryMs, extractionMs: totalMs },
  };
}

/** Stamp the freshness metadata (index_timestamp + index_head_sha). */
export function eoStampFreshness(st: ExtractionOrchestratorState): void {
  setMetadata(st.queries, 'index_timestamp', String(Date.now()));
  const sha = getCurrentHeadSha(st.rootDir);
  if (sha) {
    setMetadata(st.queries, 'index_head_sha', sha);
  } else {
    setMetadata(st.queries, 'index_head_sha', '');
  }
}

/** Phase 1 of indexAll — directory scan with progress callbacks. */
export async function eoScanFilesForIndex(
  st: ExtractionOrchestratorState,
  onProgress: ((progress: IndexProgress) => void) | undefined,
): Promise<{ files: string[]; scanMs: number }> {
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });
  const scanStart = Date.now();
  const files = await scanDirectoryAsync(st.rootDir, st.config, (current, file) => {
    onProgress?.({ phase: 'scanning', current, total: 0, currentFile: file });
  });
  return { files, scanMs: Date.now() - scanStart };
}

/** Phase 2 of indexAll — set up worker pool, run the parse + store loop. */
export async function eoRunIndexParseAndStorePhase(
  st: ExtractionOrchestratorState,
  args: {
    files: string[];
    counters: {
      filesIndexed: number;
      filesSkipped: number;
      filesErrored: number;
      totalNodes: number;
      totalEdges: number;
      processed: number;
    };
    errors: ExtractionError[];
    onProgress: ((progress: IndexProgress) => void) | undefined;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
    parseWorkers: number | undefined;
  },
): Promise<ParseEnvironment & { aborted: boolean; parseStoreMs: number }> {
  const total = args.files.length;
  args.onProgress?.({ phase: 'parsing', current: 0, total });
  await new Promise((resolve) => setImmediate(resolve));
  const parseStoreStart = Date.now();
  const env = await eoSetupParseEnvironment(args.files, args.parseWorkers, args.log);
  const aborted = await eoRunParseAndStoreLoop(st, {
    files: args.files,
    total,
    errors: args.errors,
    counters: args.counters,
    onProgress: args.onProgress,
    signal: args.signal,
    requestParse: env.requestParse,
    // Cap at max(pool, batch) so the worker pool always has prefetched
    // work AND file-handle use stays bounded on a many-file index. B12
    // (2026-05-23) removed the prior per-batch `Promise.all` barrier.
    maxInflight: Math.max(env.poolSize, FILE_IO_BATCH_SIZE),
  });
  if (!aborted) {
    args.onProgress?.({ phase: 'parsing', current: total, total });
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Surface slow-file warnings before profile rollup — same log stream
  // as the standard `[Ns] Phase: …` lines, sized so users can see at a
  // glance which files dominated the parse phase wall (B13, 2026-05-23).
  renderSlowFilesSummary(env.getSlowFiles(), args.log);
  // Emit the env-gated profile rollup BEFORE returning, so the report
  // lands in the same log stream as the standard `[Ns] Phase: …` lines
  // and right before "Phase: resolving" starts on the next line.
  flushProfileReport('[ext-profile]');
  return { ...env, aborted, parseStoreMs: Date.now() - parseStoreStart };
}

/** Render an end-of-phase summary of files that crossed
 *  {@link SLOW_PARSE_WARN_MS}. No-op when none. Sorted slowest-first;
 *  caps at 10 rows to keep the log scannable on a corpus with many
 *  slow files (in which case the per-file warnings already fired
 *  during the phase). B13 (2026-05-23).
 *
 *  Exported for unit-testability — the summary's wording is a
 *  user-visible contract worth pinning. */
export function renderSlowFilesSummary(
  slowFiles: ReadonlyArray<import('./parse-worker-pool.js').SlowFileRecord>,
  log: (msg: string) => void,
): void {
  if (slowFiles.length === 0) return;
  const ranked = [...slowFiles].sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));
  const top = ranked.slice(0, 10);
  log(`Slow files (≥${SLOW_PARSE_WARN_MS}ms parse): ${slowFiles.length} total — top ${top.length}:`);
  for (const r of top) {
    const ms = r.elapsedMs == null ? `${r.status}` : `${r.elapsedMs}ms`;
    log(`  ${ms.padStart(10)}  ${r.filePath}`);
  }
  log(`  Add slow generated/fixture files to \`.cartograph/config.json\` "exclude" to skip them.`);
}

/**
 * Phase 3 of indexAll — re-run files that died with a worker-level error.
 * Returns 0 ms when no retry was needed.
 */
export async function eoRunIndexRetryPhaseIfNeeded(
  st: ExtractionOrchestratorState,
  args: {
    errors: ExtractionError[];
    counters: { filesIndexed: number; filesErrored: number; totalNodes: number; totalEdges: number };
    env: ParseEnvironment;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  },
): Promise<number> {
  const retryableErrors = args.errors.filter(
    (e) =>
      e.code === 'parse_error' &&
      e.filePath &&
      (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds')),
  );
  if (retryableErrors.length === 0 || !args.env.hasWorker) return 0;
  const retryStart = Date.now();
  await eoRunRetryPasses(st, {
    retryableErrors,
    errors: args.errors,
    counters: args.counters,
    requestParse: args.env.requestParse,
    recycleWorker: args.env.recycleWorker,
    signal: args.signal,
    log: args.log,
  });
  return Date.now() - retryStart;
}

/**
 * Apply git changes (or full-scan fallback) to the sync state.
 * Consolidates the `if (gitChanges) ... else ...` branch in
 * {@link ExtractionOrchestrator.sync} into one call.
 */
export function eoApplySyncChanges(
  st: ExtractionOrchestratorState,
  gitChanges: ReturnType<typeof getGitChangedFiles> extends { changes: infer C } | null ? C | null : never,
  state: SyncState,
): void {
  if (gitChanges) {
    eoApplySyncedGitChanges(st, gitChanges, state);
  } else {
    eoApplySyncedFullScan(st, state);
  }
}

/**
 * Run the retry phase and apply counter updates back to the main counters object.
 * Wraps {@link eoRunIndexRetryPhaseIfNeeded} to keep the caller's counter
 * management to a single line.
 */
export async function eoRunIndexRetryPhase(
  st: ExtractionOrchestratorState,
  args: {
    counters: EoIndexCounters;
    errors: ExtractionError[];
    env: ParseEnvironment;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  },
): Promise<number> {
  const retryCounters = {
    filesIndexed: args.counters.filesIndexed,
    filesErrored: args.counters.filesErrored,
    totalNodes: args.counters.totalNodes,
    totalEdges: args.counters.totalEdges,
  };
  const retryMs = await eoRunIndexRetryPhaseIfNeeded(st, {
    errors: args.errors,
    counters: retryCounters,
    env: args.env,
    signal: args.signal,
    log: args.log,
  });
  args.counters.filesIndexed = retryCounters.filesIndexed;
  args.counters.filesErrored = retryCounters.filesErrored;
  args.counters.totalNodes = retryCounters.totalNodes;
  args.counters.totalEdges = retryCounters.totalEdges;
  return retryMs;
}

/**
 * F#12 slice 1/3: export per-extraction tuning knobs from the project
 * config into `process.env` so the parse workers (which inherit env at
 * spawn time) and in-process extractions see the configured values.
 * Exports `largeFunctionThreshold` (slice 1) + `nestedPromotionThreshold`
 * (slice 3) — extend here when future per-file extraction toggles land.
 *
 * Idempotent — calling twice with the same config is a no-op. Must
 * fire BEFORE `eoSetupParseEnvironment` (worker spawn) so the workers'
 * inherited env carries the right values.
 */
export function eoApplyExtractionEnvFromConfig(st: ExtractionOrchestratorState): void {
  const threshold = st.config.largeFunctionThreshold ?? 500;
  process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] =
    threshold === Number.POSITIVE_INFINITY ? 'Infinity' : String(threshold);
  const promotionThreshold = st.config.nestedPromotionThreshold ?? 5;
  process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'] =
    promotionThreshold === Number.POSITIVE_INFINITY ? 'Infinity' : String(promotionThreshold);
}

/** Stamp HEAD + freshness metadata at the end of a full index pass. */
export function eoStampPostIndexBaseline(st: ExtractionOrchestratorState): void {
  const headAfterIndex = getCurrentHeadSha(st.rootDir);
  if (headAfterIndex) {
    setMetadata(st.queries, LAST_SYNCED_HEAD_KEY, headAfterIndex);
  }
  eoStampFreshness(st);
}

/**
 * Set up the parse environment: detect needed languages, decide worker vs
 * in-process, build the pool. Does NOT need ExtractionOrchestratorState —
 * it only uses the file list and pool-size args.
 */
export async function eoSetupParseEnvironment(
  files: string[],
  parseWorkers: number | undefined,
  log: (msg: string) => void,
): Promise<ParseEnvironment> {
  const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
  if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
    neededLanguages.push('cpp');
  }

  const parseWorkerPath = path.join(import.meta.dirname, 'parse-worker.js');
  const useWorker = await fsp
    .access(parseWorkerPath)
    .then(() => true)
    .catch(() => false);
  let WorkerClass: typeof import('node:worker_threads').Worker | null = null;
  if (useWorker) {
    const { Worker } = await import('node:worker_threads');
    WorkerClass = Worker;
  } else {
    await loadGrammarsForLanguages(neededLanguages);
  }

  const POOL_SIZE = WorkerClass ? Math.max(1, Math.min(POOL_SIZE_MAX, parseWorkers ?? DEFAULT_PARSE_POOL_SIZE)) : 0;
  const pool = WorkerClass
    ? buildParsePool({
        WorkerClass,
        parseWorkerPath,
        poolSize: POOL_SIZE,
        neededLanguages,
        recycleInterval: WORKER_RECYCLE_INTERVAL,
        log,
      })
    : null;

  const requestParse = async (filePath: string, content: string): Promise<ExtractionResult> => {
    if (!pool) return extractFromSource(filePath, content, detectLanguage(filePath, content));
    return pool.requestParse(filePath, content);
  };
  const recycleWorker = async (): Promise<void> => {
    if (pool) await pool.recycleAll();
  };
  return {
    pool,
    requestParse,
    recycleWorker,
    hasWorker: WorkerClass !== null,
    poolSize: POOL_SIZE,
    getSlowFiles: () => (pool ? pool.getSlowFiles() : []),
  };
}

/** Read a file with symlink-aware path validation. */
export async function eoReadFileWithValidation(
  st: ExtractionOrchestratorState,
  filePath: string,
): Promise<{ filePath: string; content: string | null; stats: fs.Stats | null; error: Error | null }> {
  try {
    const fullPath = validatePathWithinRootReal(st.rootDir, filePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in batch reader', { filePath });
      return { filePath, content: null, stats: null, error: new Error('Path traversal blocked') };
    }
    const content = await fsp.readFile(fullPath, 'utf-8');
    const stats = await fsp.stat(fullPath);
    return { filePath, content, stats, error: null };
  } catch (err) {
    return { filePath, content: null, stats: null, error: err as Error };
  }
}

/** Read + parse + store the file list as a streaming flow. Returns true
 *  when aborted.
 *
 *  B12 (2026-05-23) — the prior shape was a hard batch barrier:
 *  `for (let i=0; i<files.length; i+=FILE_IO_BATCH_SIZE) { ...
 *  Promise.all(batch) }`. That meant one pathological file in a batch
 *  (`reallyLargeFile.ts` at 410s wall on microsoft/TypeScript) blocked
 *  the next batch from starting AND held the other 9 batch members'
 *  promises unresolved, leaving 5 of the 6 parse workers idle for the
 *  duration. Profile data showed 87.5% of `parseWorker:typescript`
 *  outer wall (~2,900 sec out of 3,321 sec) was barrier-wait, not work.
 *
 *  The streaming dispatcher keeps `maxInflight` files in motion at all
 *  times. A slow file occupies exactly one pool worker; the other
 *  workers keep draining the iteration. Bounded so we don't blow file
 *  handles on a 39K-file corpus.
 */
export async function eoRunParseAndStoreLoop(
  st: ExtractionOrchestratorState,
  args: {
    files: string[];
    total: number;
    errors: ExtractionError[];
    counters: {
      filesIndexed: number;
      filesSkipped: number;
      filesErrored: number;
      totalNodes: number;
      totalEdges: number;
      processed: number;
    };
    onProgress: ((progress: IndexProgress) => void) | undefined;
    signal: AbortSignal | undefined;
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
    /** Hard cap on concurrent file read+parse pipelines. Sized at the
     *  call site to `max(poolSize, FILE_IO_BATCH_SIZE)` so the worker
     *  pool always has prefetched work waiting AND file-handle use
     *  stays bounded on a many-file index. */
    maxInflight: number;
  },
): Promise<boolean> {
  const { files, total, errors, counters, onProgress, signal, requestParse, maxInflight } = args;
  const { aborted } = await streamingDispatch({
    items: files,
    maxInflight,
    signal,
    work: async (filePath) => {
      const { content, stats, error } = await eoReadFileWithValidation(st, filePath);
      if (signal?.aborted) return;
      await eoProcessOneFile(st, {
        filePath,
        content,
        stats,
        error,
        total,
        errors,
        counters,
        onProgress,
        requestParse,
      });
    },
  });
  return aborted;
}

/**
 * Average-line-length threshold above which a JS-family file is judged
 * minified. Measured 2026-05-26 on JetBrains/Exposed's vendored Dokka
 * scripts: the minified ones (`main.js`, `prism.js`,
 * `sourceset_dependencies.js`) sit at 566 / 1130 / 15379 chars per
 * line; real hand-formatted JS in the same projects sits at 25-40.
 * 200 is the conservative threshold — comfortably above any
 * reasonable hand-formatted code, comfortably below the lowest
 * minified file we measured. See {@link isMinifiedJsFamily}.
 */
const MINIFIED_AVG_LINE_LEN = 200;

/**
 * Languages whose ecosystem ships minified / bundled outputs (vendored
 * docs scripts, `*.min.js`, single-line bundlers) that the include-glob
 * may otherwise admit. Other languages either don't have a minification
 * convention or have grammar-level safeguards.
 */
const MINIFIABLE_LANGUAGES: ReadonlySet<string> = new Set(['javascript', 'typescript', 'jsx', 'tsx']);

/**
 * F#49 (2026-05-26): content-based minification detector. Returns true
 * when a JS-family file's average line length exceeds
 * {@link MINIFIED_AVG_LINE_LEN}, which reliably catches:
 *   - `.min.js` (no `.min` suffix required — content tells)
 *   - bundler outputs (`webpack.bundle.js`, Vite's prod single-file)
 *   - vendored docs scripts (Dokka's `main.js`, `prism.js`)
 *
 * Cheap — one O(n) newline count over content already in memory. No
 * regex, no I/O.
 *
 * Exported so {@link indexFileWithContent} (small-batch sync path)
 * applies the same filter as the bulk indexAll path — without it, a
 * newly-dropped minified JS file would slip through on incremental
 * sync but be filtered on full reindex. Reviewer-caught (R1, info
 * tier) — closing the consistency gap.
 */
export function isMinifiedJsFamily(language: string, content: string): boolean {
  if (!MINIFIABLE_LANGUAGES.has(language)) return false;
  // Avoid the divide-by-zero on empty content; also a zero-length file
  // can't be minified.
  if (content.length === 0) return false;
  // Count `\n` directly — avoids the allocation of `content.split('\n')`
  // and is monomorphic in V8.
  let newlines = 0;
  for (const char of content) {
    if (char === '\n') newlines++;
  }
  // +1 because N newlines split content into N+1 lines.
  const avgLineLen = content.length / (newlines + 1);
  return avgLineLen > MINIFIED_AVG_LINE_LEN;
}

/** Process one file: classify and update counters + errors in place. */
export async function eoProcessOneFile(
  st: ExtractionOrchestratorState,
  args: {
    filePath: string;
    content: string | null;
    stats: fs.Stats | null;
    error: Error | null;
    total: number;
    errors: ExtractionError[];
    counters: {
      filesIndexed: number;
      filesSkipped: number;
      filesErrored: number;
      totalNodes: number;
      totalEdges: number;
      processed: number;
    };
    onProgress: ((progress: IndexProgress) => void) | undefined;
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
  },
): Promise<void> {
  const { filePath, content, stats, error, total, errors, counters, onProgress, requestParse } = args;
  if (error || content === null || stats === null) {
    counters.processed++;
    counters.filesErrored++;
    errors.push({ message: `Failed to read file: ${errMsg(error)}`, filePath, severity: 'error', code: 'read_error' });
    return;
  }

  if (stats.size > st.config.maxFileSize) {
    counters.processed++;
    counters.filesSkipped++;
    errors.push({
      message: `File exceeds max size (${stats.size} > ${st.config.maxFileSize})`,
      filePath,
      severity: 'warning',
      code: 'size_exceeded',
    });
    onProgress?.({ phase: 'parsing', current: counters.processed, total });
    return;
  }

  onProgress?.({ phase: 'parsing', current: counters.processed, total, currentFile: filePath });

  const language = detectLanguage(filePath, content);
  // F#49 (2026-05-26): skip minified / bundled JS-family files. Some
  // vendored docs scripts (Dokka's main.js, prism.js) and any *.min.js
  // not caught by the exclude glob otherwise produce hundreds of
  // synthesized function nodes per file (156/file on exposed) — pure
  // noise in the graph. Content-based heuristic: average line length
  // over 200 chars indicates minification (real hand-formatted JS sits
  // at 25-40 chars; the lowest minified file in the wild we measured
  // was ~566). JS-family only because other languages don't carry the
  // minified-bundle convention.
  if (isMinifiedJsFamily(language, content)) {
    counters.processed++;
    counters.filesSkipped++;
    errors.push({
      message: `Skipped likely-minified ${language} file (avg line length > 200 chars)`,
      filePath,
      severity: 'warning',
      code: 'minified_skip',
    });
    onProgress?.({ phase: 'parsing', current: counters.processed, total });
    return;
  }
  const result = await eoRunParseOrCached(st, { filePath, content, language, errors, counters, requestParse });
  if (!result) return;

  counters.processed++;

  if (!eoTryStoreResult(st, { filePath, content, language, stats, result, errors, counters })) return;

  accumulateExtractionResult(filePath, result, { errors, counters });
}

/** Parse from cache or worker pool; write successful parses through to cache. */
export async function eoRunParseOrCached(
  st: ExtractionOrchestratorState,
  args: {
    filePath: string;
    content: string;
    language: Language;
    errors: ExtractionError[];
    counters: { processed: number; filesErrored: number };
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
  },
): Promise<ExtractionResult | null> {
  const { filePath, content, language, errors, counters, requestParse } = args;
  const contentHash = profile('hashContent', () => hashContent(content));
  const cached = profile('cacheLookup', () => getCachedParse({ qb: st.queries, contentHash, language, filePath }));
  if (cached) {
    st.cacheHits.count++;
    return cached;
  }
  let result: ExtractionResult;
  try {
    result = await profileAsyncTagged({
      label: 'parseWorker',
      suffix: language,
      detail: filePath,
      fn: () => requestParse(filePath, content),
    });
  } catch (parseErr) {
    counters.processed++;
    counters.filesErrored++;
    errors.push({ message: errMsg(parseErr), filePath, severity: 'error', code: 'parse_error' });
    return null;
  }
  // NOTE on order: the parse_cache write happens INSIDE
  // `eoPersistFileExtraction`, AFTER the format-only fast path has
  // queried `getLatestStructHashForFile` for the prior shape. Writing
  // the new struct_hash here would clobber the prior value before the
  // decision query runs, and `formatOnly` would always report `true`
  // on the trailing self-match (a real semantic edit gets misclassified
  // as format-only). The store path now handles both the persist AND
  // the cache write — single source of truth on the ordering.
  return result;
}

/** Persist a successful parse to the DB. Returns false when storing throws. */
export function eoTryStoreResult(
  st: ExtractionOrchestratorState,
  args: {
    filePath: string;
    content: string;
    language: Language;
    stats: fs.Stats;
    result: ExtractionResult;
    errors: ExtractionError[];
    counters: { filesErrored: number };
  },
): boolean {
  const { filePath, content, language, stats, result, errors, counters } = args;
  if (result.nodes.length === 0 && result.errors.length > 0) return true;
  try {
    profileTagged({
      label: 'store',
      suffix: language,
      detail: filePath,
      fn: () => eoStoreExtractionResult(st, { filePath, content, language, stats, result }),
    });
    return true;
  } catch (storeErr) {
    counters.filesErrored++;
    // A storage failure is NOT a parse failure — the file parsed fine,
    // the DB write threw (typically `database is locked` under
    // cross-process contention with the MCP server / background
    // summarizer). Tag it distinctly so the error breakdown doesn't
    // mislabel lock contention as "files failed to parse".
    errors.push({
      message: `Failed to store extraction result: ${errMsg(storeErr)}`,
      filePath,
      severity: 'error',
      code: 'store_error',
    });
    return false;
  }
}

/** Two-pass retry for files that failed due to WASM memory corruption. */
export async function eoRunRetryPasses(
  st: ExtractionOrchestratorState,
  args: {
    retryableErrors: ExtractionError[];
    errors: ExtractionError[];
    counters: { filesIndexed: number; filesErrored: number; totalNodes: number; totalEdges: number };
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
    recycleWorker: () => Promise<void>;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  },
): Promise<void> {
  const { retryableErrors, errors, counters, requestParse, recycleWorker, signal, log } = args;
  log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);
  const stillFailing = await eoRetryFreshHeap(st, {
    candidates: retryableErrors,
    errors,
    counters,
    requestParse,
    recycleWorker,
    signal,
    log,
  });
  if (stillFailing.length > 0) {
    log(`${stillFailing.length} files still failing — retrying with comments stripped...`);
    await eoRetryStripped(st, {
      candidates: stillFailing,
      errors,
      counters,
      requestParse,
      recycleWorker,
      signal,
      log,
    });
  }
}

/** First retry pass — fresh-heap retry without modifying source. */
export async function eoRetryFreshHeap(
  st: ExtractionOrchestratorState,
  args: {
    candidates: ExtractionError[];
    errors: ExtractionError[];
    counters: { filesIndexed: number; filesErrored: number; totalNodes: number; totalEdges: number };
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
    recycleWorker: () => Promise<void>;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  },
): Promise<ExtractionError[]> {
  const { candidates, errors, counters, requestParse, recycleWorker, signal, log } = args;
  const stillFailing: ExtractionError[] = [];
  for (const errEntry of candidates) {
    const filePath = errEntry.filePath!;
    if (signal?.aborted) break;
    await recycleWorker();
    const fullPath = validatePathWithinRootReal(st.rootDir, filePath);
    if (!fullPath) continue;

    let content: string;
    try {
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    let result: ExtractionResult;
    try {
      result = await requestParse(filePath, content);
    } catch {
      stillFailing.push(errEntry);
      continue;
    }
    if (result.nodes.length > 0 || result.errors.length === 0) {
      const language = detectLanguage(filePath, content);
      const stats = await fsp.stat(fullPath);
      eoStoreExtractionResult(st, { filePath, content, language, stats, result });
      eoApplyRetrySuccess(errEntry, result, { errors, counters });
      log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
    }
  }
  return stillFailing;
}

/** Second retry pass — strip comment-only lines and re-parse on a fresh heap. */
export async function eoRetryStripped(
  st: ExtractionOrchestratorState,
  args: {
    candidates: ExtractionError[];
    errors: ExtractionError[];
    counters: { filesIndexed: number; filesErrored: number; totalNodes: number; totalEdges: number };
    requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
    recycleWorker: () => Promise<void>;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  },
): Promise<void> {
  const { candidates, errors, counters, requestParse, recycleWorker, signal, log } = args;
  for (const errEntry of candidates) {
    const filePath = errEntry.filePath!;
    if (signal?.aborted) break;
    await recycleWorker();
    const fullPath = validatePathWithinRootReal(st.rootDir, filePath);
    if (!fullPath) continue;

    let fullContent: string;
    try {
      fullContent = await fsp.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }
    const language = detectLanguage(filePath, fullContent);
    const stripped = stripCommentLinesForRetry(fullContent, language);

    let result: ExtractionResult;
    try {
      result = await requestParse(filePath, stripped);
    } catch {
      continue;
    }

    if (result.nodes.length > 0 || result.errors.length === 0) {
      const stats = await fsp.stat(fullPath);
      eoStoreExtractionResult(st, { filePath, content: fullContent, language, stats, result });
      eoApplyRetrySuccess(errEntry, result, { errors, counters });
      log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
    }
  }
}

/** Common bookkeeping when a retry attempt succeeds. */
interface RetrySuccessAccumulator {
  errors: ExtractionError[];
  counters: { filesIndexed: number; filesErrored: number; totalNodes: number; totalEdges: number };
}
function eoApplyRetrySuccess(errEntry: ExtractionError, result: ExtractionResult, acc: RetrySuccessAccumulator): void {
  const idx = acc.errors.indexOf(errEntry);
  if (idx >= 0) acc.errors.splice(idx, 1);
  acc.counters.filesErrored--;
  acc.counters.filesIndexed++;
  acc.counters.totalNodes += result.nodes.length;
  acc.counters.totalEdges += result.edges.length;
}

/**
 * Store extraction result in database (delete → insert nodes → insert
 * edges → upsert file).
 *
 * Closes friction tracker #52/#55. There used to be a content-hash
 * "early return" here when the stored hash matched the current hash,
 * intended as a no-op shortcut. It produced phantom edges in two
 * scenarios:
 *
 *   1. Cartograph itself upgraded (extractor logic changed) but the
 *      target file's content didn't. The skip preserved buggy edges
 *      from the prior extractor.
 *   2. A prior sync persisted edges from an intermediate file state,
 *      and the file then reverted. The skip preserved the
 *      intermediate-state edges instead of re-running on the reverted
 *      content.
 *
 * The skip is now removed. Performance impact is bounded: `sync` still
 * filters at source via `eoQueueIfChanged`, so repeated syncs of an
 * unchanged file never reach this function. The skip only ever fired
 * on `indexAll` re-runs and retry paths — both rare. The cost of
 * removing it on those paths is one extra `deleteFile` + insert per
 * already-indexed file, which is microseconds.
 */
export function eoStoreExtractionResult(st: ExtractionOrchestratorState, p: StoreExtractionParams): void {
  const { filePath, content, language, stats, result } = p;
  const contentHash = profile('hashContent', () => hashContent(content));
  const existingFile = profile('getFileByPath', () => getFileByPath(st.queries, filePath));

  const frameworkOutput = profile('frameworkExtractors', () => eoRunFrameworkExtractors(filePath, content, language));
  if (frameworkOutput.nodes.length > 0) {
    result.nodes.push(...frameworkOutput.nodes);
  }
  if (frameworkOutput.references.length > 0) {
    result.unresolvedReferences.push(...frameworkOutput.references);
  }

  const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

  profile('persistFileExtraction', () =>
    eoPersistFileExtraction(st, {
      filePath,
      contentHash,
      language,
      stats,
      result,
      validNodes,
      existingFile,
    }),
  );
}

/** Run every framework resolver's `extractNodes` hook, gated by language.
 *  When a resolver declares `languages`, we skip files whose language
 *  isn't in the set — prevents the Vapor `.get(...)` regex from firing
 *  on a TS test file's `.prepare(...).get('a.ts')` SQLite call (the
 *  receiver in the regex isn't qualified, so any `.get('...')`
 *  matches). Resolvers without a declared `languages` field still run
 *  on every file (legacy backward-compat for filename-heuristic
 *  resolvers like Laravel/Rails). */
/**
 * F#73 — cached combined Aho-Corasick automaton over every resolver's
 * declared anchor strings, built once on the first `eoRunFrameworkExtractors`
 * invocation. The automaton is keyed by resolver index in the
 * registered-resolvers list; a per-file `findAll` pass produces the
 * set of resolver indices whose anchors appeared, letting the
 * dispatcher skip resolvers entirely when none of their anchors are
 * present. Resolvers without a declared `anchors` field bypass the
 * pre-filter (legacy "always run" behaviour preserved).
 */
let cachedAnchorAutomaton: AhoCorasickAutomaton | null = null;
let cachedAnchorOwners: number[] = [];
let cachedAnchorResolverList: readonly FrameworkResolver[] = [];

function buildAnchorIndex(resolvers: readonly FrameworkResolver[]): {
  flatAnchors: string[];
  owners: number[];
} {
  const flatAnchors: string[] = [];
  const owners: number[] = [];
  const seenAnchors = new Map<string, string>();
  for (let i = 0; i < resolvers.length; i++) {
    const resolver = resolvers[i]!;
    const anchors = resolver.anchors;
    if (!anchors || anchors.length === 0) continue;
    for (const anchor of anchors) {
      assertUniqueFrameworkAnchor(anchor, resolver.name, seenAnchors);
      flatAnchors.push(anchor);
      owners.push(i);
    }
  }
  return { flatAnchors, owners };
}

function assertUniqueFrameworkAnchor(anchor: string, ownerName: string, seenAnchors: Map<string, string>): void {
  const priorOwner = seenAnchors.get(anchor);
  if (priorOwner !== undefined && priorOwner !== ownerName) {
    throw new Error(
      `Framework-resolver anchor collision: ${JSON.stringify(anchor)} declared by both ` +
        `'${priorOwner}' and '${ownerName}'. Anchors must be unique across resolvers — see the ` +
        `FrameworkResolver.anchors JSDoc for the reasoning.`,
    );
  }
  seenAnchors.set(anchor, ownerName);
}

/** @internal Exposed for `__tests__/f73-anchor-prefilter.test.ts`; not
 *  part of the package's public API. The implementation is internal
 *  to the framework-resolver dispatcher. */
export function getAnchorAutomaton(resolvers: readonly FrameworkResolver[]): {
  automaton: AhoCorasickAutomaton;
  anchorOwners: readonly number[];
} | null {
  // Rebuild when the resolver list reference changes. In production
  // the list is a module-level constant so this fires once.
  if (resolvers !== cachedAnchorResolverList) {
    // The pre-filter assumes each anchor string belongs to exactly
    // one resolver. If two resolvers declared the same anchor,
    // `buildAhoCorasick` would dedup the pattern to the first
    // occurrence's index, and `owners[m.patternIndex]` would only
    // ever resolve to that first resolver — the second resolver
    // would be silently dropped from `resolversWithAnchorHit` and
    // wrongly skipped on files where only the shared anchor
    // appears. The constraint isn't violated by the four resolvers
    // currently declaring anchors (Bun.serve / Route:: / @XxxMapping
    // / [Http... + .MapXxx are all distinct), but assert it
    // explicitly so a future PR that adds a colliding anchor fails
    // loudly at build time rather than silently misfiring at scan
    // time.
    const { flatAnchors, owners } = buildAnchorIndex(resolvers);
    cachedAnchorResolverList = resolvers;
    cachedAnchorOwners = owners;
    cachedAnchorAutomaton = flatAnchors.length > 0 ? buildAhoCorasick(flatAnchors) : null;
  }
  if (!cachedAnchorAutomaton) return null;
  return { automaton: cachedAnchorAutomaton, anchorOwners: cachedAnchorOwners };
}

function collectResolversWithAnchorHit(
  filterer: { automaton: AhoCorasickAutomaton; anchorOwners: readonly number[] } | null,
  content: string,
): Set<number> | null {
  if (!filterer) return null;
  const hits = new Set<number>();
  for (const m of filterer.automaton.findAll(content)) {
    hits.add(filterer.anchorOwners[m.patternIndex]!);
  }
  return hits;
}

function resolverMatchesFile(
  resolver: FrameworkResolver,
  resolverIdx: number,
  language: Language,
  resolversWithAnchorHit: Set<number> | null,
): boolean {
  if (resolver.languages && !resolver.languages.includes(language)) return false;
  return !(
    resolver.anchors &&
    resolver.anchors.length > 0 &&
    resolversWithAnchorHit &&
    !resolversWithAnchorHit.has(resolverIdx)
  );
}

function runFrameworkResolver(args: {
  resolver: FrameworkResolver;
  filePath: string;
  content: string;
  language: Language;
  getStripped: () => string;
  byId: Map<string, Node>;
  references: UnresolvedReference[];
}): void {
  const { resolver, filePath, content, language, getStripped, byId, references } = args;
  if (resolver.extract) {
    try {
      const extra = resolver.extract(filePath, content);
      mergeUniqueFrameworkNodes(byId, extra.nodes, language);
      references.push(...extra.references);
    } catch (err) {
      logDebug('Framework extract failed', {
        framework: resolver.name,
        filePath,
        error: String(err),
      });
    }
    return;
  }
  if (!resolver.extractNodes) return;
  try {
    const extra = resolver.extractNodes(filePath, content, getStripped);
    mergeUniqueFrameworkNodes(byId, extra, language);
  } catch (err) {
    logDebug('Framework extractNodes failed', {
      framework: resolver.name,
      filePath,
      error: String(err),
    });
  }
}

function eoRunFrameworkExtractors(
  filePath: string,
  content: string,
  language: Language,
): { nodes: Node[]; references: UnresolvedReference[] } {
  const byId = new Map<string, Node>();
  const references: UnresolvedReference[] = [];
  // F#74 — memoised per-file comment-stripped buffer shared across
  // resolvers. The thunk is lazy: when no applicable resolver calls
  // it (Java / Ruby / Swift / React scan raw `content`), the
  // O(n) `stripCommentsForRegex` cost is skipped entirely. The
  // first call computes + caches; subsequent calls return the cached
  // string. The orchestrator strips with the file's actual language,
  // which is equivalent to the prior in-resolver hardcoded strings
  // (JS-family languages share the BLOCK_COMMENT_LANGUAGES + LINE_COMMENT
  // configuration, so the file's `language` produces identical output
  // to `'javascript'` for TS / JSX / TSX files).
  let strippedCache: string | undefined;
  const getStripped = (): string => {
    strippedCache ??= stripCommentsForRegex(content, language);
    return strippedCache;
  };
  // F#73 — single Aho-Corasick scan over the file content. The set
  // contains every resolver index whose declared anchors fired at
  // least once. A resolver with declared anchors that is NOT in the
  // set has no possible match and gets skipped without running its
  // regex pass. Resolvers without declared anchors are absent from
  // `cachedAnchorOwners` and stay in the legacy "always run" path.
  const resolvers = getAllFrameworkResolvers();
  const resolversWithAnchorHit = collectResolversWithAnchorHit(getAnchorAutomaton(resolvers), content);
  for (let resolverIdx = 0; resolverIdx < resolvers.length; resolverIdx++) {
    const resolver = resolvers[resolverIdx]!;
    if (!resolverMatchesFile(resolver, resolverIdx, language, resolversWithAnchorHit)) continue;
    // F#62 — `extract` (richer) wins over `extractNodes` (legacy) when
    // both are defined. The orchestrator does not call both for the
    // same file; resolvers that want refs implement `extract`, those
    // that only emit nodes keep `extractNodes`. Backward-compat:
    // every existing resolver still uses the original path.
    runFrameworkResolver({ resolver, filePath, content, language, getStripped, byId, references });
  }
  return { nodes: [...byId.values()], references };
}

/**
 * Merge framework-resolver-supplied nodes into a per-id map,
 * forcing `language` to match the file (so language filters work
 * downstream) and dropping duplicates. Two resolvers can claim the
 * same registration (gin's generic `\.GET(...)` and echo's
 * `e\.GET(...)` both fire when the var is named `e`); first-write
 * wins instead of relying on duplicate-key INSERTs to dedup.
 */
function mergeUniqueFrameworkNodes(byId: Map<string, Node>, extra: ReadonlyArray<Node>, language: Language): void {
  for (const node of extra) {
    if (!byId.has(node.id)) byId.set(node.id, { ...node, language });
  }
}

/**
 * Persist the valid edges for a file, skipping edges whose source or
 * target were dropped during validation.
 */
function eoPersistValidEdges(
  queries: ExtractionOrchestratorState['queries'],
  edges: readonly Edge[],
  insertedIds: Set<string>,
): void {
  if (edges.length === 0) return;
  const validEdges = edges.filter((e) => insertedIds.has(e.source) && insertedIds.has(e.target));
  if (validEdges.length > 0) insertEdges(queries, validEdges);
}

/** Context bundle for eoPersistUnresolvedRefs. */
interface EoPersistRefsCtx {
  queries: ExtractionOrchestratorState['queries'];
  refs: readonly UnresolvedReference[];
  insertedIds: Set<string>;
  filePath: string;
  language: Language;
}

/**
 * Enrich and persist unresolved references, filling in missing
 * filePath/language from the enclosing file context.
 */
function eoPersistUnresolvedRefs(ctx: EoPersistRefsCtx): void {
  const { queries, refs, insertedIds, filePath, language } = ctx;
  if (refs.length === 0) return;
  const refsWithContext = refs
    .filter((ref) => insertedIds.has(ref.fromNodeId))
    .map((ref) => ({
      ...ref,
      filePath: ref.filePath ?? filePath,
      language: ref.language ?? language,
    }));
  if (refsWithContext.length > 0) insertUnresolvedRefsBatch(queries, refsWithContext);
}

interface EoPersistFileExtractionArgs {
  filePath: string;
  contentHash: string;
  language: Language;
  stats: fs.Stats;
  result: ExtractionResult;
  validNodes: Node[];
  existingFile: FileRecord | null;
}

/**
 * G7 format-only fast path decision. When the prior struct_hash
 * matches the freshly-computed one for this `(file_path, language)`,
 * the file's node set is structurally identical to what's already
 * persisted — only line ranges, columns, body_hash, signature
 * whitespace and similar shifted. Stable node ids (migration 066)
 * mean we can SKIP the cascade-evict and let UPDATE refresh
 * positions + body_hash IN PLACE, preserving every edge /
 * role_assignment / centrality / code_health_finding /
 * node_loc_history row keyed off these ids.
 *
 * For the non-fast-path branch (no existingFile, struct_hash
 * differs, or no prior hash recorded) the caller falls through to
 * the original evict-then-insert sequence so a real semantic edit
 * still discards stale edges / unresolved_refs from the old shape.
 */
function eoFormatOnlyDecision(
  st: ExtractionOrchestratorState,
  args: EoPersistFileExtractionArgs,
): { formatOnly: boolean; newStructHash: string } {
  const newStructHash = computeStructHash(args.validNodes);
  const priorStructHash = args.existingFile
    ? getLatestStructHashForFile(st.queries, args.filePath, args.language)
    : null;
  const formatOnly = args.existingFile != null && priorStructHash != null && priorStructHash === newStructHash;
  return { formatOnly, newStructHash };
}

/** Compose the FileRecord row for `upsertFile` from extraction inputs. */
function eoBuildFileRecord(args: EoPersistFileExtractionArgs): FileRecord {
  return compact({
    path: args.filePath,
    contentHash: args.contentHash,
    language: args.language,
    size: args.stats.size,
    // floor: stats.mtimeMs is a fractional float; files.modified_at
    // is INTEGER (STRICT). Sub-millisecond precision is meaningless
    // on disk-mtime anyway.
    modifiedAt: Math.floor(args.stats.mtimeMs),
    indexedAt: Date.now(),
    nodeCount: args.result.nodes.length,
    errors: args.result.errors.length > 0 ? args.result.errors : undefined,
    isTest: isTestPath(args.filePath),
  });
}

/**
 * Persist `validNodes`, branching on the G7 format-only fast path.
 *
 * Fast path (UPDATE, no cascade-evict): stable node ids + struct_hash
 * + body_hash match means every node already exists in the DB. Plain
 * UPDATE statements (not INSERT OR REPLACE) fire only AFTER UPDATE
 * triggers — `nodes_fts` delete+re-insert + `nodes_rtree` REPLACE —
 * which keep the side tables in sync without colliding with AFTER
 * INSERT triggers on the same row (R*Tree virtual table mishandles
 * dual-trigger fan-out under bun:sqlite). Edges, role_assignments,
 * code_health_findings, centrality, and the node_loc_history rows
 * referencing these ids stay intact.
 */
function eoPersistValidNodes(st: ExtractionOrchestratorState, validNodes: Node[], formatOnly: boolean): void {
  if (validNodes.length === 0) return;
  if (formatOnly) {
    for (const node of validNodes) st.queries.updateNode(node);
  } else {
    st.queries.insertNodes(validNodes);
  }
}

function eoPersistNestedFunctionManifest(
  st: ExtractionOrchestratorState,
  p: EoPersistFileExtractionArgs,
  insertedIds: ReadonlySet<string>,
): void {
  const manifest = p.result.nestedFunctionManifest ?? [];
  const valid = manifest.filter((row) => insertedIds.has(row.parentNodeId));
  upsertNestedFunctionsForFile(st.queries, p.filePath, valid);
}

/** Atomically persist the extraction result for one file in a transaction. */
function eoPersistFileExtraction(st: ExtractionOrchestratorState, p: EoPersistFileExtractionArgs): void {
  profile('persist:txnTotal', () =>
    qbTransaction(st.queries, () => {
      const { formatOnly, newStructHash } = profile('persist:formatOnlyDecision', () => eoFormatOnlyDecision(st, p));

      if (p.existingFile && !formatOnly) {
        // Evict the prior extraction (reconstruct cross-file
        // unresolved_refs, then cascade-delete) inside this transaction,
        // so the evict + re-insert below is one atomic replace. The
        // ref reconstruction keeps edges from unmodified files alive
        // through Pass B's re-resolve — see removeFileFromIndexInTx.
        profile('persist:removeFromIndex', () => removeFileFromIndexInTx(st.queries, p.filePath));
      }
      // upsertFile FIRST: unresolved_refs.file_path now has a FK to
      // files(path) (migration 055). The previous order wrote refs
      // before the file row, which silently worked under SQLite's
      // pre-FK loose semantics but trips the constraint as soon as
      // the FK lands. Same transaction, same atomicity guarantee.
      profile('persist:upsertFile', () => upsertFile(st.queries, eoBuildFileRecord(p)));

      profile('persist:nodes', () => eoPersistValidNodes(st, p.validNodes, formatOnly));
      const insertedIds = new Set(p.validNodes.map((n) => n.id));
      if (!formatOnly) {
        // On the non-fast-path branch every edge / ref was just cascade-
        // deleted by removeFileFromIndexInTx, so re-emit them. On the
        // format-only fast path edges are already there (stable ids),
        // re-emitting would be a no-op against `idx_edges_unique` but
        // adds churn — skip it. Unresolved refs likewise: the prior
        // re-extract's row stayed put.
        profile('persist:edges', () => eoPersistValidEdges(st.queries, p.result.edges, insertedIds));
        profile('persist:unresolvedRefs', () =>
          eoPersistUnresolvedRefs({
            queries: st.queries,
            refs: p.result.unresolvedReferences,
            insertedIds,
            filePath: p.filePath,
            language: p.language,
          }),
        );
      }

      // F#12 slice 2 — refresh the nested-function manifest. Delete-by-
      // file then insert-all is the right grain on BOTH branches: on
      // the format-only fast path positions shifted (which is exactly
      // what the deep-view AST walker reads), and on the non-fast-path
      // the cascade-evict already cleared the rows via FK to nodes.
      // Filtering by `insertedIds.has(row.parentNodeId)` guards against
      // a parent-node validation drop between extract and persist.
      profile('persist:nestedFnManifest', () => eoPersistNestedFunctionManifest(st, p, insertedIds));

      // Persist the parse_cache entry LAST — after the format-only
      // decision read the prior value via `getLatestStructHashForFile`.
      // (Pre-2026-05-21: the write lived in `eoRunParseOrCached` and
      // ran BEFORE the decision query, so a real semantic edit got
      // misclassified as format-only by reading back its own just-
      // written hash.) See the corresponding NOTE in `eoRunParseOrCached`.
      if (p.result.nodes.length > 0 || p.result.errors.length === 0) {
        profile('persist:putCachedParse', () =>
          putCachedParse({
            qb: st.queries,
            contentHash: p.contentHash,
            language: p.language,
            filePath: p.filePath,
            result: p.result,
            structHash: newStructHash,
          }),
        );
      }
    }),
  );
}

/** Git fast path: apply changed/deleted/added into SyncState. */
function eoApplySyncedGitChanges(
  st: ExtractionOrchestratorState,
  gitChanges: { added: string[]; modified: string[]; deleted: string[] },
  state: SyncState,
): void {
  state.filesChecked = gitChanges.modified.length + gitChanges.added.length + gitChanges.deleted.length;

  for (const filePath of gitChanges.deleted) {
    if (getFileByPath(st.queries, filePath)) {
      removeFileFromIndex(st.queries, filePath);
      state.filesRemoved++;
    }
  }

  for (const filePath of gitChanges.modified) {
    eoQueueIfChanged({ st, state, filePath, tracked: getFileByPath(st.queries, filePath) });
  }

  for (const filePath of gitChanges.added) {
    if (!validatePathWithinRootReal(st.rootDir, filePath)) {
      logWarn('Path traversal blocked during sync', { filePath });
      continue;
    }
    state.filesToIndex.push(filePath);
    state.changedFilePaths.push(filePath);
    state.filesAdded++;
  }

  // Disk reconcile — `git status` only ever reports files git tracks, so
  // an UNTRACKED file that was created and then deleted (a scratch file,
  // a build artifact) leaves no porcelain trace, and any file deleted
  // while the file watcher was not running is likewise invisible to the
  // fast path. Such files linger as ghost nodes + embeddings forever,
  // contaminating similarity / retrieval and making `find by:content`'s
  // "index in sync — true negative" claim false. `eoApplySyncedFullScan`
  // catches them via its directory walk; give the git path the same
  // guarantee by stat-ing the already-known indexed set directly.
  //
  // `eoFindVanishedFiles` delegates to `findVanishedFiles` (freshness.ts),
  // the same primitive `ChangeOracle.vanished` wraps — the cross-tool
  // invariant test pins their equivalence. The Oracle call below for the
  // heal+contentDrift union does NOT consume vanished (it'd require
  // reordering the reap pass for a marginal one-walk saving on a clean
  // tree); the two passes share the primitive but not the call.
  eoReapVanishedFiles(st, state);

  // Node-count integrity sweep — a `files` row whose stored `node_count`
  // disagrees with the actual `nodes` it owns (an orphan left by an
  // interrupted re-extract) is invisible to a content-hash sync: disk
  // content never moved, so the diff never re-queues it. Flag every such
  // row `needs_reextract = 1` so the heal-flag union below re-extracts it
  // and `upsertFile`s a correct count. Cheap — one correlated-count UPDATE.
  reconcileFileNodeCounts(st.queries);

  // Heal + content-drift union — git's fast-path only iterates files
  // git reports as changed. Two classes of file slip past it:
  //   - EXTRACTION_LOGIC_VERSION-healed (needs_reextract=1, disk
  //     unchanged) — git can't see them, heal would silently no-op
  //     forever in any git-tracked project (`admin sync` reporting "0
  //     files" while `cartograph_status` keeps recommending a sync).
  //   - Content-drifted (on-disk SHA != indexed content_hash while
  //     git stays quiet) — the watcher missed an edit, an auto-formatter
  //     rewrote the file after indexing, or a partial sync left the
  //     row stale. Status used to recommend `admin sync` for these and
  //     sync was a no-op until #7 unioned them in.
  // ChangeOracle exposes both facets through the same typed snapshot,
  // so this union is one call and stays commensurable with everything
  // else that consults the same facets (`cartograph_status` drift line,
  // `cartograph_affected` cross-ref hint, the structural invariant test
  // in `__tests__/change-oracle.test.ts`).
  const oracle = whatChanged(st.rootDir, st.queries, { facets: new Set(['healFlagged', 'contentDrift']) });
  const seen = new Set<string>([...gitChanges.modified, ...gitChanges.added, ...gitChanges.deleted]);
  for (const filePath of oracle.healFlagged) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    state.filesChecked++;
    eoQueueIfChanged({ st, state, filePath, tracked: getFileByPath(st.queries, filePath) });
  }
  for (const filePath of oracle.contentDrift) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    state.filesChecked++;
    eoQueueIfChanged({ st, state, filePath, tracked: getFileByPath(st.queries, filePath) });
  }
}

/**
 * Indexed file paths whose disk file no longer exists.
 *
 * `git status` never reports an untracked file that was created then
 * removed, nor any file deleted while the watcher was down — so both
 * the sync git fast-path and `getChangedFiles`' git fast-path need to
 * stat the already-known indexed set directly to find such ghosts.
 * The index already holds the candidate list, so one `existsSync` per
 * row suffices — no directory walk.
 *
 * Delegates to {@link findVanishedFiles} in `freshness.ts` so the
 * "what counts as vanished" rule has ONE definition across the
 * extraction path (`eoReapVanishedFiles`, `eoCollectGitChanges`) AND
 * the typed entry point exposed to MCP tools
 * (`ChangeOracle.vanished`). The cross-tool invariant test in
 * `__tests__/change-oracle.test.ts` pins their equivalence — a
 * divergent fork here would surface there.
 */
function eoFindVanishedFiles(st: ExtractionOrchestratorState): string[] {
  return findVanishedFiles(st.rootDir, getAllFiles(st.queries));
}

/**
 * Reap indexed files whose path no longer exists on disk.
 *
 * The git fast path ({@link eoApplySyncedGitChanges}) reaps only what
 * `git status` reports as deleted; {@link eoFindVanishedFiles} catches
 * the rest. Runs after the git-reported deletions, so already-reaped
 * rows are gone from `getAllFiles` and never double-deleted.
 */
function eoReapVanishedFiles(st: ExtractionOrchestratorState, state: SyncState): void {
  for (const filePath of eoFindVanishedFiles(st)) {
    removeFileFromIndex(st.queries, filePath);
    state.filesRemoved++;
  }
}

/** Result of one full directory scan diffed against the indexed set. */
interface FullScanSnapshot {
  /** Every source path currently on disk. */
  currentFiles: Set<string>;
  /** Indexed file records keyed by path. */
  trackedMap: Map<string, FileRecord>;
  /** Indexed paths no longer present on disk. */
  removed: string[];
}

/**
 * Scan the tree once and diff it against the indexed set.
 *
 * Both non-git paths — sync apply ({@link eoApplySyncedFullScan}) and
 * change detection ({@link eoCollectFullScanChanges}) — need the exact
 * same scan + tracked-map + removed-set computation; sharing it here
 * keeps the "what's on disk vs what's indexed" rule in one place.
 */
function eoSnapshotFullScan(st: ExtractionOrchestratorState): FullScanSnapshot {
  const currentFiles = new Set(scanDirectory(st.rootDir, st.config));
  const trackedMap = new Map<string, FileRecord>();
  const removed: string[] = [];
  for (const f of getAllFiles(st.queries)) {
    trackedMap.set(f.path, f);
    if (!currentFiles.has(f.path)) removed.push(f.path);
  }
  return { currentFiles, trackedMap, removed };
}

/** Fallback for non-git projects: full directory scan + hash compare. */
function eoApplySyncedFullScan(st: ExtractionOrchestratorState, state: SyncState): void {
  const { currentFiles, trackedMap, removed } = eoSnapshotFullScan(st);
  state.filesChecked = currentFiles.size;

  for (const filePath of removed) {
    removeFileFromIndex(st.queries, filePath);
    state.filesRemoved++;
  }

  for (const filePath of currentFiles) {
    eoQueueIfChanged({ st, state, filePath, tracked: trackedMap.get(filePath) });
  }
}

interface EoQueueIfChangedArgs {
  st: ExtractionOrchestratorState;
  state: SyncState;
  filePath: string;
  tracked: FileRecord | null | undefined;
}

/** Validate → read → hash → compare; queue file when added or hash drifted. */
function eoQueueIfChanged(args: EoQueueIfChangedArgs): void {
  const { st, state, filePath, tracked } = args;
  const fullPath = validatePathWithinRootReal(st.rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked during sync', { filePath });
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch (error) {
    logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
    return;
  }
  const contentHash = hashContent(content);
  if (!tracked) {
    state.filesToIndex.push(filePath);
    state.changedFilePaths.push(filePath);
    state.filesAdded++;
  } else if (tracked.contentHash !== contentHash || tracked.needsReextract) {
    // EXTRACTION_LOGIC_VERSION heal sets needsReextract on every file
    // even when content_hash still matches disk — re-extract on the flag.
    state.filesToIndex.push(filePath);
    state.changedFilePaths.push(filePath);
    state.filesModified++;
  }
}

/**
 * Files-to-index count above which `eoIndexChangedFiles` routes the
 * re-extract through the parse-worker pool instead of the serial
 * in-process loop. The pool spawns N worker threads and loads grammars
 * into each — fixed overhead (~1-2s) that only amortizes on a large
 * batch. The dominant large-batch case is the `EXTRACTION_LOGIC_VERSION`
 * self-heal, which re-flags every tracked file; an ordinary commit
 * touches far fewer files and stays on the cheaper serial path.
 */
const BULK_REEXTRACT_THRESHOLD = 200;

/** Args bundle for {@link eoIndexChangedFiles}. */
export interface EoIndexChangedFilesArgs {
  orch: ExtractionOrchestrator;
  st: ExtractionOrchestratorState;
  state: SyncState;
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Index the files queued by a sync. Small batches run the serial
 * in-process loop (low fixed cost); large batches — chiefly the
 * `EXTRACTION_LOGIC_VERSION` heal, which re-flags every file — route
 * through the same parse-worker pool `indexAll` uses, which overlaps
 * parsing (worker threads) with the main-thread store (~1.45× on a
 * 392-file TypeScript corpus; the parse+store phase is store-bound,
 * so the win is the overlap, not raw parse parallelism). Receives the
 * orchestrator instance to call `indexFile` (public method) on the
 * serial path.
 */
export async function eoIndexChangedFiles(args: EoIndexChangedFilesArgs): Promise<void> {
  const { orch, st, state, onProgress } = args;
  if (state.filesToIndex.length === 0) return;

  if (state.filesToIndex.length >= BULK_REEXTRACT_THRESHOLD) {
    await eoBulkReextractViaPool(st, state, onProgress);
    return;
  }

  const neededLanguages = [...new Set(state.filesToIndex.map((f) => detectLanguage(f)))];
  if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
    neededLanguages.push('cpp');
  }
  await loadGrammarsForLanguages(neededLanguages);

  const total = state.filesToIndex.length;
  for (let i = 0; i < state.filesToIndex.length; i++) {
    const filePath = state.filesToIndex[i]!;
    onProgress?.({ phase: 'parsing', current: i + 1, total, currentFile: filePath });
    const result = await orch.indexFile(filePath);
    state.nodesUpdated += result.nodes.length;
  }
}

/**
 * Bulk re-extract a large queued set through the parse-worker pool —
 * the same parallel read → parse → store path `indexAll` runs. Reuses
 * `eoSetupParseEnvironment` (worker spawn + grammar load) and
 * `eoRunParseAndStoreLoop` (per-file txn-atomic store via
 * `eoStoreExtractionResult`, identical to the serial path). The pool is
 * always terminated, even on throw. Per-file parse results land in the
 * shared `parse_cache`, so a one-shot LRU eviction keeps it bounded.
 */
async function eoBulkReextractViaPool(
  st: ExtractionOrchestratorState,
  state: SyncState,
  onProgress: ((progress: IndexProgress) => void) | undefined,
): Promise<void> {
  const files = state.filesToIndex;
  const total = files.length;
  const errors: ExtractionError[] = [];
  const counters: EoIndexCounters = {
    filesIndexed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    totalNodes: 0,
    totalEdges: 0,
    processed: 0,
  };
  // parseWorkers undefined → DEFAULT_PARSE_POOL_SIZE; no verbose log sink.
  const env = await eoSetupParseEnvironment(files, undefined, () => {});
  try {
    await eoRunParseAndStoreLoop(st, {
      files,
      total,
      errors,
      counters,
      onProgress,
      signal: undefined,
      requestParse: env.requestParse,
      // Same shape as the indexAll caller — keep the pool fed without
      // batch-bound idle time. B12 fix (2026-05-23).
      maxInflight: Math.max(env.poolSize, FILE_IO_BATCH_SIZE),
    });
    // Surface the slow-file summary on the bulk re-extract path too,
    // so a sync that re-touches a pathological file gets the same
    // visibility as a fresh indexAll. Route through logWarn so the
    // user sees it (the silent `() => {}` verbose log sink above
    // would swallow it). B13 (2026-05-23).
    renderSlowFilesSummary(env.getSlowFiles(), (msg) => logWarn(msg));
  } finally {
    if (env.pool) await env.pool.terminate('Sync re-extract complete');
  }
  state.nodesUpdated += counters.totalNodes;
  evictParseCacheIfOversized(st.queries);
}

/** Git fast path for getChangedFiles: read+hash only flagged paths. */
export function eoCollectGitChanges(
  st: ExtractionOrchestratorState,
  gitChanges: { added: string[]; modified: string[]; deleted: string[] },
): { added: string[]; modified: string[]; removed: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const filePath of gitChanges.deleted) {
    if (getFileByPath(st.queries, filePath)) {
      removed.push(filePath);
    }
  }

  // Disk reconcile — mirror eoReapVanishedFiles on the detection side.
  // `git status` never reports an untracked-then-deleted file nor any
  // file removed while the watcher was down, so without this union
  // `getChangedFiles` (and `cartograph status` downstream) under-reports
  // deleted files even though `sync` already reaps them. (Backlog H1.)
  const seenRemoved = new Set(removed);
  for (const filePath of eoFindVanishedFiles(st)) {
    if (!seenRemoved.has(filePath)) removed.push(filePath);
  }

  for (const filePath of gitChanges.modified) {
    const kind = eoClassifyFileChange(st, filePath, getFileByPath(st.queries, filePath));
    if (kind === 'added') added.push(filePath);
    else if (kind === 'modified') modified.push(filePath);
  }

  for (const filePath of gitChanges.added) {
    if (!validatePathWithinRootReal(st.rootDir, filePath)) {
      logWarn('Path traversal blocked while detecting changes', { filePath });
      continue;
    }
    added.push(filePath);
  }

  return { added, modified, removed };
}

/** Fallback for non-git projects: scan the tree, hash everything. */
export function eoCollectFullScanChanges(st: ExtractionOrchestratorState): {
  added: string[];
  modified: string[];
  removed: string[];
} {
  const { currentFiles, trackedMap, removed } = eoSnapshotFullScan(st);

  const added: string[] = [];
  const modified: string[] = [];

  for (const filePath of currentFiles) {
    const kind = eoClassifyFileChange(st, filePath, trackedMap.get(filePath));
    if (kind === 'added') added.push(filePath);
    else if (kind === 'modified') modified.push(filePath);
  }

  return { added, modified, removed };
}

/** Validate → read → hash → classify as 'added' / 'modified' / null. */
function eoClassifyFileChange(
  st: ExtractionOrchestratorState,
  filePath: string,
  tracked: FileRecord | null | undefined,
): 'added' | 'modified' | null {
  const fullPath = validatePathWithinRootReal(st.rootDir, filePath);
  if (!fullPath) {
    logWarn('Path traversal blocked while detecting changes', { filePath });
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch (error) {
    logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
    return null;
  }
  const contentHash = hashContent(content);
  if (!tracked) return 'added';
  if (tracked.contentHash !== contentHash || tracked.needsReextract) return 'modified';
  return null;
}

/** Accumulator bundle threaded into `accumulateExtractionResult`. */
interface ExtractionAccumulator {
  errors: ExtractionError[];
  counters: {
    filesIndexed: number;
    filesErrored: number;
    filesSkipped: number;
    totalNodes: number;
    totalEdges: number;
  };
}

/**
 * Fold a per-file extraction result into the running counters + errors:
 * append per-row errors (back-filling missing filePath) and bump the
 * indexed/errored/skipped counters depending on shape.
 */
function accumulateExtractionResult(filePath: string, result: ExtractionResult, acc: ExtractionAccumulator): void {
  const { errors, counters } = acc;
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      if (!err.filePath) err.filePath = filePath;
    }
    errors.push(...result.errors);
  }

  if (result.nodes.length > 0) {
    counters.filesIndexed++;
    counters.totalNodes += result.nodes.length;
    counters.totalEdges += result.edges.length;
  } else if (result.errors.some((e) => e.severity === 'error')) {
    counters.filesErrored++;
  } else {
    counters.filesSkipped++;
  }
}
