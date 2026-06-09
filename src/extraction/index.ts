/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import type * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { ExtractionError, ExtractionResult } from './types.js';
import type { CartographConfig, Language } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getFilesNeedingReextract } from '../db/queries-files.js';
import { evictParseCacheIfOversized } from '../db/queries-parse-cache.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { deferNodeDerivedIndexes, finalizeDeferredNodeIndexes } from '../db/deferred-index.js';
import { extractFromSource } from './tree-sitter.js';
import { detectLanguage, isLanguageSupported, initGrammars } from './grammars.js';
import { logDebug, logWarn, errMsg } from '../errors.js';
import { validatePathWithinRootReal, stripBom, compact } from '../utils.js';
import { ParseWorkerPool } from './parse-worker-pool.js';
import { runSequential } from '../utils/async-iteration.js';
import {
  type EoIndexCounters,
  eoScanFilesForIndex,
  eoAbortIndexResult,
  eoRunIndexParseAndStorePhase,
  eoRunIndexRetryPhase,
  eoStampPostIndexBaseline,
  eoFinalIndexResult,
  eoStoreExtractionResult,
  eoApplySyncChanges,
  eoApplyExtractionEnvFromConfig,
  eoIndexChangedFiles,
  eoStampFreshness,
  eoCollectGitChanges,
  eoCollectFullScanChanges,
  isMinifiedJsFamily,
} from './extraction-phases.js';
import { getGitChangedFiles, LAST_SYNCED_HEAD_KEY } from './file-scanner.js';
export {
  getGitChangedFiles,
  LAST_SYNCED_HEAD_KEY,
  scanDirectory,
  scanDirectoryAsync,
  shouldIncludeFile,
} from './file-scanner.js';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
export const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

// Per-file parse timeout moved to ParseWorkerPool; see
// `BASE_PARSE_TIMEOUT_MS` and the per-100KB extension there.

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
export const WORKER_RECYCLE_INTERVAL = 250;

/** Hard ceiling (16) on caller-supplied pool size — bounds memory cost in the face of hostile inputs. */
export const POOL_SIZE_MAX = 16;

/**
 * Default size of the parse-worker pool. Each worker holds its own
 * tree-sitter WASM heap (~50-100MB per loaded grammar), so pool size
 * trades memory for parallelism. Sized to `os.cpus().length - 1` — one
 * core reserved for the main thread (DB writes, I/O batching) — and
 * floored at 1, so it auto-scales from a single-core CI runner to a
 * many-core workstation. `POOL_SIZE_MAX` caps memory cost on big
 * machines. Override via `IndexOptions.parseWorkers` (or the
 * `--parse-workers` CLI flag on `admin index`).
 *
 * Note: on small/medium TypeScript corpora the parse+store phase is
 * store-bound (serial main-thread SQLite writes), so workers past ~4
 * are headroom for parse-heavy corpora (huge files, slow grammars)
 * rather than a guaranteed speedup — benchmark before tuning.
 */
export const DEFAULT_PARSE_POOL_SIZE = (() => {
  // os import is at the top of the file; size from hardware concurrency.
  // Math.min is safe with NaN (returns NaN) which we coerce to 1.
  const hc = os === undefined || typeof os.cpus !== 'function' ? 4 : Math.max(1, os.cpus().length);
  // Reserve one core for the main thread; floor at 1 so a single-core
  // box still gets a worker; POOL_SIZE_MAX bounds memory on big-core
  // machines.
  return Math.max(1, Math.min(hc - 1, POOL_SIZE_MAX));
})();

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Per-phase timings for `--profile`. All values are wall-clock
 * milliseconds. Filled opportunistically — phases not run (e.g.
 * resolve when no files changed) report 0. Filled by both
 * `ExtractionOrchestrator.indexAll` (orchestrator-internal phases)
 * and `Cartograph.indexAll` (coordinator phases).
 */
interface IndexProfile {
  /** File-system scan / glob filtering. */
  scanMs?: number;
  /** Parse + extract + store loop (interleaved per file). */
  parseStoreMs?: number;
  /** Retry pass for WASM-corruption recoveries. */
  retryMs?: number;
  /** Orchestrator total (scanMs + parseStoreMs + retryMs + overhead). */
  extractionMs?: number;
  /** Resolution pass (cross-file name matching → edges). */
  resolveMs?: number;
  /** Post-index hooks: centrality, churn, issue-history, config-refs, sql-refs, cochange. */
  postHooksMs?: number;
  /**
   * Per-hook breakdown of `postHooksMs`. Hook name → wall-clock ms.
   * Populated alongside `postHooksMs` when `profile:true`. Useful for
   * pinpointing which sub-hook dominates the post-index spend.
   */
  postHooksByHook?: Record<string, number>;
  /** SQLite WAL checkpoint + planner stats refresh. */
  maintenanceMs?: number;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
  /** Set when `--profile` (`profile: true`) is requested. */
  profile?: IndexProfile;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
  /**
   * True when sync exited early because another process holds the
   * index file-lock. The caller should distinguish this from a real
   * "no changes" sync — the index may still be stale.
   */
  lockContention?: boolean;
}

/**
 * Mutable run-state threaded through `sync`'s helpers. `filesToIndex`
 * is the queue of paths to extract; `changedFilePaths` is the
 * caller-visible record of what moved this pass; the count fields
 * accumulate into the returned SyncResult.
 */
export interface SyncState {
  filesToIndex: string[];
  changedFilePaths: string[];
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
}

/**
 * Empty `ExtractionResult` shell, used when a file is rejected before
 * extraction (path traversal blocked, oversize, unsupported language)
 * so the caller still gets a fully-typed object back.
 */
function emptyExtractionResult(errors: ExtractionError[] = []): ExtractionResult {
  return { nodes: [], edges: [], unresolvedReferences: [], errors, durationMs: 0 };
}

/** Argument bundle for `storeExtractionResult`. */
export interface StoreExtractionParams {
  filePath: string;
  content: string;
  language: Language;
  stats: fs.Stats;
  result: ExtractionResult;
}

/**
 * Calculate SHA256 hash of file contents.
 *
 * A leading UTF-8 BOM is stripped before hashing so files round-tripped
 * through editors that disagree about BOM handling (VSCode strips by
 * default; some Windows editors preserve it) hash identically and don't
 * appear "modified" on every sync.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(stripBom(content)).digest('hex');
}

/**
 * Check if a path matches any glob pattern (simplified)
 */
/**
 * Returned by `eoSetupParseEnvironment` — pool handle (null when no
 * worker available), the parse-request thunk, the worker-recycle
 * thunk, and a flag the retry pass uses to short-circuit when a
 * worker isn't available to retry into.
 */
export interface ParseEnvironment {
  pool: ParseWorkerPool | null;
  requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
  recycleWorker: () => Promise<void>;
  hasWorker: boolean;
  /** Effective pool size after clamps + caller overrides. 0 when no
   *  worker is available (the in-process fallback path). Consumed by
   *  `eoRunParseAndStoreLoop` to size its inflight cap so the pool
   *  always has prefetched work and never starves. */
  poolSize: number;
  /** Snapshot accessor for files that crossed `SLOW_PARSE_WARN_MS`.
   *  Returns `[]` in the in-process fallback path (no pool). Consumed
   *  by the indexAll log printer to render an end-of-phase summary
   *  table — B13 (2026-05-23). */
  getSlowFiles: () => ReadonlyArray<import('./parse-worker-pool.js').SlowFileRecord>;
}

interface BuildParsePoolArgs {
  WorkerClass: typeof import('node:worker_threads').Worker;
  parseWorkerPath: string;
  poolSize: number;
  neededLanguages: Language[];
  recycleInterval: number;
  log: (msg: string) => void;
}

/** Construct the parse-worker pool. Pulled out of {@link
 *  eoSetupParseEnvironment} so the conditional doesn't roll up a
 *  complex_conditional finding. */
export function buildParsePool(args: BuildParsePoolArgs): ParseWorkerPool {
  return new ParseWorkerPool({
    WorkerClass: args.WorkerClass,
    parseWorkerPath: args.parseWorkerPath,
    poolSize: args.poolSize,
    neededLanguages: args.neededLanguages,
    recycleInterval: args.recycleInterval,
    log: args.log,
    logWarn,
  });
}

/**
 * Immutable dependencies + mutable cache-hit ref threaded through all
 * module-scope `eo*` helpers. The `cacheHits` object is a shared mutable
 * ref so helpers can increment the counter without returning it — the class
 * instance reads `this.cacheHitsRef.count` directly.
 */
export interface ExtractionOrchestratorState {
  rootDir: string;
  config: CartographConfig;
  queries: QueryBuilder;
  /** Shared mutable counter — same object as `ExtractionOrchestrator.cacheHitsRef`. */
  cacheHits: { count: number };
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private readonly st: ExtractionOrchestratorState;

  constructor(rootDir: string, config: CartographConfig, queries: QueryBuilder) {
    this.st = { rootDir, config, queries, cacheHits: { count: 0 } };
  }

  /** Reset the per-pass parse-cache hit counter. */
  resetParseCacheHits(): void {
    this.st.cacheHits.count = 0;
  }

  /** Read the per-pass parse-cache hit counter. */
  getParseCacheHits(): number {
    return this.st.cacheHits.count;
  }

  private async finishSuccessfulIndexAll(args: {
    st: ExtractionOrchestratorState;
    counters: EoIndexCounters;
    errors: ExtractionError[];
    env: ParseEnvironment;
    signal: AbortSignal | undefined;
    log: (msg: string) => void;
  }): Promise<number> {
    const { st, counters, errors, env, signal, log } = args;
    const retryMs = await eoRunIndexRetryPhase(st, { counters, errors, env, signal, log });
    if (env.pool) await env.pool.terminate('Indexing complete');
    eoStampPostIndexBaseline(st);

    // LRU eviction once per pass so the cache table can't grow
    // without bound on long-lived projects. Cheap when under the
    // cap (one COUNT(*) probe). When over, drops the oldest 25%.
    const evicted = evictParseCacheIfOversized(st.queries);
    if (st.cacheHits.count > 0 || evicted > 0) {
      logDebug('parse_cache: pass summary', { hits: st.cacheHits.count, evicted });
    }
    return retryMs;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    args: {
      onProgress?: (progress: IndexProgress) => void;
      signal?: AbortSignal;
      verbose?: boolean;
      parseWorkers?: number;
    } = {},
  ): Promise<IndexResult> {
    const { onProgress, signal, verbose, parseWorkers } = args;
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const log = verbose
      ? (msg: string) => {
          process.stdout.write(`[worker] ${msg}\n`);
        }
      : (_msg: string) => {};

    this.resetParseCacheHits();
    const st = this.st;
    // F#12 slice 1: export per-extraction env vars from config BEFORE
    // the worker pool spawns inside eoRunIndexParseAndStorePhase, so
    // workers inherit the right values.
    eoApplyExtractionEnvFromConfig(st);
    const { files, scanMs } = await eoScanFilesForIndex(st, onProgress);
    if (signal?.aborted) return eoAbortIndexResult(startTime, []);

    const counters: EoIndexCounters = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      totalNodes: 0,
      totalEdges: 0,
      processed: 0,
    };
    // Defer per-row FTS5 / R*Tree trigger maintenance for the bulk
    // store. A full indexAll repopulates `nodes` wholesale, so the
    // derived indexes are rebuilt once at the end (see deferred-index.ts)
    // instead of row-by-row — measured ~70% of node-store wall-clock.
    // finalize runs from a `finally` so the triggers are always restored.
    const deferredIndex = deferNodeDerivedIndexes(st.queries.db);
    let aborted = false;
    let parseStoreMs = 0;
    let retryMs = 0;
    try {
      const env = await eoRunIndexParseAndStorePhase(st, {
        files,
        counters,
        errors,
        onProgress,
        signal,
        log,
        parseWorkers,
      });
      parseStoreMs = env.parseStoreMs;
      const { pool } = env;
      if (env.aborted) {
        aborted = true;
        if (pool) await pool.terminate('Aborted');
      } else {
        retryMs = await this.finishSuccessfulIndexAll({ st, counters, errors, env, signal, log });
      }
    } finally {
      finalizeDeferredNodeIndexes(st.queries.db, deferredIndex);
    }

    if (aborted) return eoAbortIndexResult(startTime, errors, counters);
    return eoFinalIndexResult({ counters, errors, totalMs: Date.now() - startTime, scanMs, parseStoreMs, retryMs });
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    await runSequential(filePaths, async (filePath) => {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
      return true;
    });

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    // Symlink-aware validation: a regular-looking path that resolves
    // outside the root via symlink (or `..` segments) is rejected here
    // so neither the read below nor the DB write below it can leak
    // off-tree content.
    const fullPath = validatePathWithinRootReal(this.st.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Path traversal blocked: ${relativePath}`,
            filePath: relativePath,
            severity: 'error',
            code: 'path_traversal',
          },
        ],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${errMsg(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult> {
    // Symlink-aware traversal check before the path lands in the DB.
    // The content was already read upstream via the parallel batch
    // reader; this is the chokepoint that decides whether a symlink-
    // pointing-outside-root path is allowed to be persisted.
    const fullPath = validatePathWithinRootReal(this.st.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return emptyExtractionResult([
        { message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' },
      ]);
    }

    // Check file size
    if (stats.size > this.st.config.maxFileSize) {
      return emptyExtractionResult([
        {
          message: `File exceeds max size (${stats.size} > ${this.st.config.maxFileSize})`,
          filePath: relativePath,
          severity: 'warning',
          code: 'size_exceeded',
        },
      ]);
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return emptyExtractionResult();
    }

    // F#49 (2026-05-26): apply the same minification skip the indexAll
    // path uses (see `eoProcessOneFile` in extraction-phases.ts). Without
    // this, a newly-added minified JS file landing through the
    // small-batch sync path would slip through here even though a full
    // reindex would filter it. Reviewer-caught coverage gap.
    if (isMinifiedJsFamily(language, content)) {
      return emptyExtractionResult([
        {
          message: `Skipped likely-minified ${language} file (avg line length > 200 chars)`,
          filePath: relativePath,
          severity: 'warning',
          code: 'minified_skip',
        },
      ]);
    }

    // Extract from source
    const result = extractFromSource(relativePath, content, language);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      eoStoreExtractionResult(this.st, { filePath: relativePath, content, language, stats, result });
    }

    return result;
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars();
    const startTime = Date.now();
    onProgress?.({ phase: 'scanning', current: 0, total: 0 });

    const state: SyncState = {
      filesToIndex: [],
      changedFilePaths: [],
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: 0,
    };

    const lastSyncedHead = getMetadata(this.st.queries, LAST_SYNCED_HEAD_KEY);
    const gitResult = getGitChangedFiles(this.st.rootDir, this.st.config, lastSyncedHead);
    const currentHead = gitResult?.currentHead ?? null;
    // When the last-synced HEAD is unreachable we drop to the filesystem
    // fallback, which uses on-disk hashes and is correct regardless of git.
    const gitChanges = gitResult && !gitResult.needsFullReindex ? gitResult.changes : null;

    const st = this.st;
    // F#12 slice 1: same env-var export as the indexAll path so any
    // bulk re-extract spawned via `eoIndexChangedFiles` inherits the
    // configured threshold.
    eoApplyExtractionEnvFromConfig(st);
    eoApplySyncChanges(st, gitChanges, state);
    await eoIndexChangedFiles({ orch: this, st, state, ...(onProgress ? { onProgress } : {}) });

    // Persist current HEAD so the next sync can detect HEAD-moving git
    // operations (merge, pull, checkout, rebase, reset, post-commit) even
    // when they leave the working tree clean.
    if (currentHead) setMetadata(st.queries, LAST_SYNCED_HEAD_KEY, currentHead);
    eoStampFreshness(st);

    return compact({
      filesChecked: state.filesChecked,
      filesAdded: state.filesAdded,
      filesModified: state.filesModified,
      filesRemoved: state.filesRemoved,
      nodesUpdated: state.nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: state.changedFilePaths.length > 0 ? state.changedFilePaths : undefined,
    });
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const st = this.st;
    const lastSyncedHead = getMetadata(st.queries, LAST_SYNCED_HEAD_KEY);
    const gitResult = getGitChangedFiles(st.rootDir, st.config, lastSyncedHead);
    // Unreachable last-synced HEAD → drop to the filesystem fallback, which
    // is correct regardless of git history state.
    const gitChanges = gitResult && !gitResult.needsFullReindex ? gitResult.changes : null;

    const changes = gitChanges ? eoCollectGitChanges(st, gitChanges) : eoCollectFullScanChanges(st);
    // Heal-flag union (only meaningful on the git fast-path; the full-scan
    // path already reads needs_reextract via eoClassifyFileChange). The
    // EXTRACTION_LOGIC_VERSION self-heal sets the flag on every file when
    // the extractor's emit-set changes — git reports those files as
    // unchanged because disk content didn't move, so without this union
    // the heal silently no-ops in any git-tracked project.
    if (gitChanges) {
      const flagged = getFilesNeedingReextract(st.queries);
      if (flagged.length > 0) {
        const seen = new Set<string>([...changes.added, ...changes.modified, ...changes.removed]);
        for (const path of flagged) {
          if (!seen.has(path)) changes.modified.push(path);
        }
      }
    }
    return changes;
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter.js';
export {
  detectLanguage,
  isLanguageSupported,
  isGrammarLoaded,
  getSupportedLanguages,
  initGrammars,
  loadGrammarsForLanguages,
  loadAllGrammars,
} from './grammars.js';
