/**
 * Cartograph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'node:path';
import type { CartographConfig } from './types.js';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from './default-config.js';
import { DatabaseConnection, getDatabasePath, dbRunMaintenance } from './db/index.js';
import { QueryBuilder, clearAll, clearStructural, getStats } from './db/queries.js';
import {
  getUnresolvedReferencesByFiles,
  getUnresolvedReferencesByDefiningFiles,
  getUnresolvedReferencesCount,
} from './db/queries-unresolved-refs.js';
import { loadConfig, saveConfig } from './config.js';
import { pinDerivedPostgresSchema } from './config/pin-postgres-schema.js';
import { isInitialized, createDirectory, removeDirectory, validateDirectory } from './directory.js';
import {
  ExtractionOrchestrator,
  type IndexProgress,
  type IndexResult,
  type SyncResult,
  initGrammars,
} from './extraction/index.js';
import { type ReferenceResolver, createResolver } from './resolution/index.js';
import { DEGENERATE_EDGE_UREF_FLOOR } from './resolution/types.js';
import { applyExtractionLogicVersionHeal } from './extraction/extraction-logic-version.js';
import { GraphTraverser, GraphQueryManager } from './graph/index.js';
import { type ContextBuilder, createContextBuilder } from './context/index.js';
import { Mutex, FileLock } from './utils.js';
import { CartographWatcher } from './cartograph-watcher.js';
import { CartographLlmService } from './cartograph-llm-service.js';
import { CartographStats } from './cartograph-stats.js';
import { logWarn, errMsg } from './errors.js';
import {
  runAfterIndexAll as runIndexHooksAfterIndexAll,
  runAfterSync as runIndexHooksAfterSync,
  type IndexHookContext,
  type IndexHookOutcome,
} from './index-hooks/registry.js';
import { HookWorkerClient } from './index-hooks/hook-worker-client.js';
import { FULL_PLAYBOOK } from './mcp/server-instructions.js';

// Re-export types for consumers
export * from './types.js';
export { getDatabasePath } from './db/index.js';
export { getConfigPath } from './config.js';
export {
  getCartographDir,
  isInitialized,
  findNearestCartographRoot,
  CARTOGRAPH_DIR,
} from './directory.js';
export type { IndexProgress, IndexResult, SyncResult } from './extraction/index.js';
export {
  detectLanguage,
  isLanguageSupported,
  isGrammarLoaded,
  getSupportedLanguages,
  initGrammars,
  loadGrammarsForLanguages,
  loadAllGrammars,
} from './extraction/index.js';
export type { ResolutionResult } from './resolution/index.js';
export {
  CartographError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors.js';
export type { Logger } from './errors.js';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils.js';
export { FileWatcher } from './sync/index.js';
export type { WatchOptions, WatcherStats } from './sync/index.js';
export type { FreshnessInfo } from './freshness.js';
// NOTE: MCPServer is intentionally NOT re-exported here. This facade is the
// kernel; re-exporting the MCP server created a runtime import cycle
// (index → mcp/index → index) that eagerly pulled the entire ~150-module
// tool surface into every CLI/library consumer of the core. Import it from
// the `cartograph/mcp` subpath instead.

/**
 * Options for initializing a new Cartograph project
 */
export interface InitOptions {
  /** Custom configuration overrides */
  config?: Partial<CartographConfig>;

  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing Cartograph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;

  /**
   * When the on-disk DB schema is older than the binary's
   * `CURRENT_SCHEMA_VERSION`, run forward migrations to bring it up.
   *
   * Default: `false`. Read-style entry points (search / callers /
   * grep / etc.) fail-loud with guidance instead of silently
   * migrating, because a silent migration locks out any
   * already-running cartograph process bound to the older schema
   * (typically a long-lived MCP server). Write-style entry points
   * that are explicitly the user's "fix the index" path
   * (`admin sync` / `admin index` / `admin migrate` / `summarize` /
   * `embed` / `classify` / `coverage --mode load`) opt in with
   * `autoMigrate: true`.
   *
   * Newer-than-binary DBs (`db.version > CURRENT_SCHEMA_VERSION`)
   * always fail regardless of this flag — running them through the
   * old code is the silent-corruption path the schema guard was
   * added for (B4).
   */
  autoMigrate?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: ((progress: IndexProgress) => void) | undefined;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;

  /**
   * After indexing/syncing, kick off LLM symbol summarisation in the
   * background if a local LLM is configured or auto-detectable.
   * Defaults to true. Set false in scripts / git hooks where the
   * caller doesn't want a long-running side effect.
   */
  summarize?: boolean;

  /**
   * Collect per-phase timings (`IndexProfile`) on the result. Cheap —
   * a handful of `Date.now()` reads — but defaults off so callers
   * that don't care don't see a `profile` field on every result.
   */
  profile?: boolean;

  /**
   * Override the parse-worker pool size. Defaults to
   * `max(1, min(os.cpus().length - 1, 16))` (see `DEFAULT_PARSE_POOL_SIZE`
   * in extraction/index.ts). Each worker holds its own tree-sitter WASM
   * heap (~50-100MB per loaded grammar), so larger pools trade
   * memory for parallelism. Set lower on memory-constrained CI
   * runners; set higher on big monorepos with many CPU cores.
   */
  parseWorkers?: number;

  /**
   * Transiently override `config.maxFileSize` for this index/sync call.
   * This is not persisted to `.cartograph/config.json`; CLI callers use it
   * for one-off large-file runs without changing project policy.
   */
  maxFileSize?: number;

  /**
   * Skip every derived-signal pass that isn't required for semantic
   * search: reference resolution, all post-index hooks (centrality,
   * biomarkers, churn, co-change, sql/config-refs, build-context,
   * tests-edges, etc.), and the LLM summarize/classify phases. The
   * embed phase still runs.
   *
   * Use case: operators who only want `cartograph_search({mode:'semantic'})`
   * + `cartograph_ask` and don't need any of the structural enrichment.
   * Drops indexing wall-clock by 70-90% on large repos.
   *
   * Defaults to false. The post-extraction pipeline is the canonical
   * "deep enrichment" path; embed-only is the fast-lane carve-out.
   */
  embedOnly?: boolean;

  /**
   * `--force` full re-index: clear the structural index (nodes/edges,
   * LLM caches preserved) before re-extracting. The clear runs INSIDE
   * the index file-lock — so if the lock can't be acquired (a concurrent
   * indexer, e.g. the MCP server's sync), `indexAll` returns
   * `success: false` with the EXISTING index left intact, rather than
   * wiping it with no rebuild. Callers must pass this flag instead of
   * calling `clearStructural()` before `indexAll` (the pre-lock clear was
   * the cause of "per-symbol biomarker counts fluctuate across reindexes"
   * — an interrupted/contended `--force` left a 0/partial index).
   */
  clearStructural?: boolean;
}

// ---------------------------------------------------------------------------
// Internal bundles — reduce god_class member count without breaking callers.
// ---------------------------------------------------------------------------

/**
 * Graph-processing subsystems that are accessed by external consumers
 * (MCP tools, tests, bin/cartograph) via `cg.internals.*`.
 *
 * @internal
 */
export interface CartographInternals {
  orchestrator: ExtractionOrchestrator;
  resolver: ReferenceResolver;
  graphManager: GraphQueryManager;
  traverser: GraphTraverser;
  contextBuilder: ContextBuilder;
  /**
   * Off-thread runner for the derived-signal hook phase. Lives in
   * `internals` (not a top-level `CartographCore` field) to keep the
   * core class's member count under the god_class threshold.
   */
  hookWorker: HookWorkerClient;
}

/** Paired in-process mutex + cross-process file lock. @internal */
interface IndexLock {
  mutex: Mutex;
  file: FileLock;
}

// ---------------------------------------------------------------------------
// Module-scope free functions (were private methods on Cartograph)
// ---------------------------------------------------------------------------

/**
 * Body that runs under both the in-process mutex and the cross-process
 * file lock. Acquires the file lock, runs the extractor, resolve,
 * post-index hooks, DB maintenance, shapes the profile output, and
 * overrides the orchestrator's `durationMs` with end-to-end wall-clock.
 *
 * When `options.embedOnly === true` the resolve and post-index-hooks
 * phases are SKIPPED — only extraction, the schema-version self-heal,
 * and DB maintenance run. The embed pass itself is owned by the
 * caller (e.g. `cg.llm.embedAll()` after this returns).
 */
async function cgRunIndexUnderLock(
  cg: Cartograph,
  options: IndexOptions,
  coordinatorStart: number,
): Promise<IndexResult> {
  try {
    cg.lock.file.acquire();
  } catch {
    return {
      success: false,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [
        { message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const },
      ],
      durationMs: 0,
    };
  }
  try {
    // `--force` clear runs HERE — under the file lock — not in the CLI
    // before indexAll. If the lock acquire above failed we never reach
    // this, so a contended `--force` leaves the existing index intact
    // instead of wiping it with no rebuild (the biomarker-fluctuation
    // root cause). clearStructural preserves LLM caches.
    if (options.clearStructural) cg.clearStructural();
    // Friction #66 self-heal: when the extractor's emit-set version
    // has bumped, force a full re-extraction once. Cheap when the
    // version matches (single metadata read).
    applyExtractionLogicVersionHeal(cg.queries);
    const result = await cg.internals.orchestrator.indexAll({
      ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.verbose !== undefined && { verbose: options.verbose }),
      ...(options.parseWorkers !== undefined && { parseWorkers: options.parseWorkers }),
    });
    // embedOnly: skip every derived-signal pass that isn't needed
    // for semantic search. Resolution + postHooks add edge-kinds
    // and metrics the embed pass doesn't consult. The embed pass
    // itself is owned by `runEmbedGroup` (LLM service); when
    // `summarize: false` here AND embedOnly is set, the caller is
    // expected to invoke `cg.llm.embedAll()` separately or rely on
    // `cg.llm.startBackgroundSummarization` with embed-only flow.
    const resolveMs = options.embedOnly ? 0 : await cgRunResolveReferencesPhase(cg, result, options);
    const { postHooksMs, postHooksByHook } = options.embedOnly
      ? { postHooksMs: 0, postHooksByHook: undefined }
      : await cgRunPostIndexHooksPhase(cg, result, options);
    const maintenanceMs = cgRunMaintenancePhase(cg, result);
    cgShapeIndexProfile(result, options, { resolveMs, postHooksMs, maintenanceMs, postHooksByHook });
    // F#50 (2026-05-26): refresh result counts to reflect post-hook DB
    // state. Extraction-phase counts only see structurally-extracted
    // edges; the resolve phase + post-hook passes (go-implements,
    // tests-edges, value-ref-edges, etc.) add many more. Reporting the
    // pre-hook number to the CLI undercounted edges by 2-3x on real
    // corpora. Cheap — a single 4-COUNT statement runs in microseconds.
    cgRefreshIndexResultCounts(cg, result);
    result.durationMs = Date.now() - coordinatorStart;
    return result;
  } finally {
    cg.lock.file.release();
  }
}

/** Resolve references; no-op when nothing was indexed. */
async function cgRunResolveReferencesPhase(
  cg: Cartograph,
  result: IndexResult,
  options: IndexOptions,
): Promise<number> {
  if (!(result.success && result.filesIndexed > 0)) return 0;
  const unresolvedCount = getUnresolvedReferencesCount(cg.queries);
  options.onProgress?.({ phase: 'resolving', current: 0, total: unresolvedCount });
  const resolveStart = Date.now();
  await cg.internals.resolver.resolveAndPersistBatched((current, total) => {
    options.onProgress?.({ phase: 'resolving', current, total });
  });
  return Date.now() - resolveStart;
}

/**
 * Run a derived-signal hook phase OFF the main event loop.
 *
 * The hooks include CPU-bound *synchronous* passes — `centrality`
 * (PageRank over the whole edge graph) and `biomarkers` (file re-parse
 * + clone detection). Run inline they freeze the event loop, hanging
 * an MCP server mid-tool-call (and the `setTimeout`-based hook /
 * auto-sync timeouts cannot even fire). {@link HookWorkerClient} runs
 * the phase on its own thread with its own DB connection — WAL keeps
 * the main thread's reads (tool calls) live throughout.
 *
 * Falls back to the in-process path ONLY when the worker cannot be
 * spawned at all (`runPhase` returns `null`) — no worse than the
 * pre-worker behaviour. A mid-phase worker crash/timeout does NOT fall
 * back (that would re-freeze the main thread); it returns a synthetic
 * error outcome and the derived signals refresh on the next sync.
 */
async function cgRunHookPhase(
  cg: Cartograph,
  phase: 'sync' | 'indexAll',
  syncResult?: SyncResult,
): Promise<IndexHookOutcome[]> {
  const common = {
    projectRoot: cg.projectRoot,
    dbPath: getDatabasePath(cg.projectRoot),
    config: cg.config,
  };
  if (phase === 'sync') {
    if (syncResult === undefined) {
      throw new Error('sync hook phase requires a SyncResult');
    }
    const viaWorker = await cg.internals.hookWorker.runPhase({ ...common, phase: 'sync', syncResult });
    if (viaWorker !== null) return viaWorker;
    return runIndexHooksAfterSync(cg.buildHookContext(), syncResult);
  }
  const viaWorker = await cg.internals.hookWorker.runPhase({ ...common, phase: 'indexAll' });
  if (viaWorker !== null) return viaWorker;
  return runIndexHooksAfterIndexAll(cg.buildHookContext());
}

/**
 * Run registered post-indexAll hooks. Best-effort: hook errors are
 * caught and logged inside the runner. Per-hook durations captured
 * only when `--profile` is set.
 */
async function cgRunPostIndexHooksPhase(
  cg: Cartograph,
  result: IndexResult,
  options: IndexOptions,
): Promise<{ postHooksMs: number; postHooksByHook: Record<string, number> | undefined }> {
  if (!result.success) return { postHooksMs: 0, postHooksByHook: undefined };
  const hooksStart = Date.now();
  const outcomes = await cgRunHookPhase(cg, 'indexAll');
  const postHooksMs = Date.now() - hooksStart;
  // Fold failed/timed-out hook outcomes into result.errors so a degraded
  // index (e.g. biomarkers, centrality, and tests-edges all failed) is
  // visible to CLI and MCP callers instead of only stderr logWarn lines
  // an MCP-driven index never surfaces. success stays true (post-index
  // hooks are best-effort) — the errors just make the degradation
  // observable.
  for (const o of outcomes) {
    if (o.error) {
      result.errors.push({
        message: `post-index hook '${o.name}' failed: ${o.error.message}`,
        severity: 'warning',
        code: 'post_index_hook_failed',
      });
    }
  }
  if (!options.profile) return { postHooksMs, postHooksByHook: undefined };
  const postHooksByHook: Record<string, number> = {};
  for (const o of outcomes) postHooksByHook[o.name] = o.durationMs;
  return { postHooksMs, postHooksByHook };
}

/**
 * F#50 (2026-05-26): refresh `nodesCreated` + `edgesCreated` on the
 * IndexResult to reflect post-hook DB state. The orchestrator's
 * extraction-phase counts only see structurally-extracted edges; the
 * resolve phase (every `unresolved_refs` row that lands as an edge) and
 * post-hook passes (go-implements, tests-edges, value-ref-edges, etc.)
 * add a substantial fraction of the final edge graph. Reporting the
 * pre-hook number was misleading — agents would see "2904 edges" then
 * find 8528 in the DB on the next query.
 *
 * The full `getStats()` call runs four queries (one compound COUNT
 * plus three GROUP BY scans we don't consume here). The marginal cost
 * at index-end is microseconds — the same scans run on every
 * `cartograph_status` / `cartograph_digest` call without complaint. A
 * dedicated `getCounts` helper would be cleaner but isn't worth the
 * registry churn given the cost.
 */
function cgRefreshIndexResultCounts(cg: Cartograph, result: IndexResult): void {
  if (!(result.success && result.filesIndexed > 0)) return;
  const stats = getStats(cg.queries);
  result.nodesCreated = stats.nodeCount;
  result.edgesCreated = stats.edgeCount;
}

/** Refresh planner stats + checkpoint the WAL after bulk writes. */
function cgRunMaintenancePhase(cg: Cartograph, result: IndexResult): number {
  if (!(result.success && result.filesIndexed > 0)) return 0;
  const maintStart = Date.now();
  dbRunMaintenance(cg.db);
  return Date.now() - maintStart;
}

function cgAssertMaxFileSize(maxFileSize: number, fieldName: string): void {
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > MAX_INDEX_FILE_SIZE) {
    throw new Error(`${fieldName} must be between 1 byte and ${MAX_INDEX_FILE_SIZE_LABEL} (got ${maxFileSize})`);
  }
}

function cgApplyTransientIndexConfig(cg: CartographCore, options: IndexOptions): () => void {
  const maxFileSize = options.maxFileSize;
  if (maxFileSize === undefined) return () => {};
  cgAssertMaxFileSize(maxFileSize, 'IndexOptions.maxFileSize');
  const previousMaxFileSize = cg.config.maxFileSize;
  cg.config.maxFileSize = maxFileSize;
  return () => {
    cg.config.maxFileSize = previousMaxFileSize;
  };
}

/**
 * Mutate `result.profile` with the post-index timings when the caller
 * asked for `--profile`; otherwise strip the profile field entirely.
 */
function cgShapeIndexProfile(
  result: IndexResult,
  options: IndexOptions,
  times: {
    resolveMs: number;
    postHooksMs: number;
    maintenanceMs: number;
    postHooksByHook: Record<string, number> | undefined;
  },
): void {
  if (options.profile && result.profile) {
    result.profile.resolveMs = times.resolveMs;
    result.profile.postHooksMs = times.postHooksMs;
    result.profile.maintenanceMs = times.maintenanceMs;
    if (times.postHooksByHook) result.profile.postHooksByHook = times.postHooksByHook;
  } else if (!options.profile) {
    delete result.profile;
  }
}

const CARTOGRAPH_RESOURCE_TEARDOWNS = new WeakMap<object, Promise<void>>();

function rememberCartographResourceTeardown(instance: object, teardown: Promise<void>): Promise<void> {
  const observed = teardown.catch(() => {});
  CARTOGRAPH_RESOURCE_TEARDOWNS.set(instance, observed);
  return observed;
}

// ---------------------------------------------------------------------------
// CartographCore — 14 members (9 fields + constructor + 4 methods)
// The god_class biomarker threshold is 15; keeping exactly 14 here.
// ---------------------------------------------------------------------------

/**
 * Core state and lifecycle for a Cartograph project. Holds the database,
 * config, and all sub-system instances. Extended by {@link Cartograph}.
 *
 * @internal — extend via Cartograph, not directly.
 */
export class CartographCore {
  /** @internal Read by cluster files (e.g. cartograph-llm-pass.ts). */
  db: DatabaseConnection;
  /** @internal Read by cluster files (e.g. cartograph-llm-pass.ts). */
  queries: QueryBuilder;
  /** @internal Read by cluster files (e.g. cartograph-llm-pass.ts). */
  config: CartographConfig;
  /** @internal Read by cluster files (e.g. cartograph-llm-pass.ts). */
  projectRoot: string;
  /**
   * Graph-processing subsystems. Access individual systems via
   * `cg.internals.orchestrator`, `cg.internals.traverser`, etc.
   * @internal
   */
  internals: CartographInternals;
  /** @internal Paired in-process mutex + cross-process file lock. */
  lock: IndexLock;
  /** File-watcher facade — owns the FileWatcher lifecycle. */
  watcher: CartographWatcher;
  /** LLM facade — owns the resolved-LLM cache, embedding cache, and background-summarisation lifecycle. */
  llm: CartographLlmService;
  /** Stats / health facade — graph stats, node metrics, churn, freshness cache, tests<->subjects. */
  stats: CartographStats;

  /** @internal — use Cartograph.init / Cartograph.open / Cartograph.openSync */
  constructor(args: {
    db: DatabaseConnection;
    queries: QueryBuilder;
    config: CartographConfig;
    projectRoot: string;
  }) {
    const { db, queries, config, projectRoot } = args;
    this.db = db;
    this.queries = queries;
    this.config = config;
    this.projectRoot = projectRoot;
    this.lock = {
      mutex: new Mutex(),
      file: new FileLock(path.join(projectRoot, '.cartograph', 'cartograph.lock')),
    };
    const traverser = new GraphTraverser(queries);
    this.internals = {
      orchestrator: new ExtractionOrchestrator(projectRoot, config, queries),
      resolver: createResolver(projectRoot, queries),
      graphManager: new GraphQueryManager(queries),
      traverser,
      contextBuilder: createContextBuilder(projectRoot, queries, traverser),
      // Cheap to construct — the worker thread is spawned lazily on the
      // first hook phase, not here.
      hookWorker: new HookWorkerClient(),
    };
    const subsystems = createCartographSubsystems(this);
    this.watcher = subsystems.watcher;
    this.llm = subsystems.llm;
    this.stats = subsystems.stats;
  }

  /** Close the Cartograph instance and release resources. */
  close(): void {
    if (CARTOGRAPH_RESOURCE_TEARDOWNS.has(this)) return;
    this.watcher.stop();
    this.llm.bgCtrl.cancel();
    // Fire-and-forget — `terminate()` is best-effort and `close()` is
    // synchronous. A stuck worker is killed by the process exit anyway.
    void rememberCartographResourceTeardown(this, this.internals.hookWorker.terminate());
    this.lock.file.release();
    this.db.close();
  }

  /**
   * Clear all data from the graph — including LLM-derived caches
   * (summaries, embeddings, directory summaries). Use for a true
   * reset; for `--force` re-index prefer {@link clearStructural}.
   */
  clear(): void {
    clearAll(this.queries);
    this.llm.embed.embeddingCache.invalidate();
  }

  /**
   * Clear structural data only (nodes/edges/files/refs/co-changes/
   * coverage/health). Preserves the content-hash-keyed LLM caches so
   * the next index run can short-circuit unchanged symbols. This is
   * what `--force` re-index should call.
   */
  clearStructural(): void {
    clearStructural(this.queries);
    this.llm.embed.embeddingCache.invalidate();
  }

  /**
   * Build the read-only context handed to every index hook.
   * @internal
   */
  buildHookContext(): IndexHookContext {
    return {
      projectRoot: this.projectRoot,
      config: this.config,
      queries: this.queries,
      db: this.db,
    };
  }
}

/**
 * Re-read `.cartograph/config.json` from disk and merge it into the
 * live config object. Lets an edit to include/exclude globs or a
 * feature flag take effect on the next index/sync WITHOUT restarting
 * the process — a long-lived MCP server otherwise pins the config it
 * loaded at startup (FRICTION-11).
 *
 * The config object is mutated in place via `Object.assign`, so the
 * extraction orchestrator and every hook context — all of which hold
 * the same object reference — observe the update with no recreation.
 * `loadConfig` always returns a complete config (defaults merged), so
 * a key deleted from the file falls back to its default rather than
 * lingering. A missing or malformed config.json is swallowed
 * (warn-logged): the in-memory config stands and the pass proceeds
 * rather than crashing. Module-scope (not a method) so `CartographCore`
 * / `Cartograph` stay under the `god_class` member threshold.
 */
export function cgRefreshConfigFromDisk(cg: CartographCore): void {
  try {
    Object.assign(cg.config, loadConfig(cg.projectRoot));
  } catch (err) {
    logWarn('config refresh skipped — could not reload .cartograph/config.json', {
      error: errMsg(err),
    });
  }
}

function createCartographSubsystems(cg: CartographCore): {
  watcher: CartographWatcher;
  llm: CartographLlmService;
  stats: CartographStats;
} {
  const cartograph = cg as Cartograph;
  return {
    watcher: new CartographWatcher(cartograph),
    llm: new CartographLlmService(cartograph),
    stats: new CartographStats(cartograph),
  };
}

// ---------------------------------------------------------------------------
// Cartograph — 14 members (6 static + 8 instance)
// Extends CartographCore without adding more fields; all new members are
// methods so no field-bloat is introduced.
// ---------------------------------------------------------------------------

/**
 * Main Cartograph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class Cartograph extends CartographCore {
  // ===========================================================================
  // Static Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new Cartograph project
   *
   * Creates the .Cartograph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new Cartograph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<Cartograph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`Cartograph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration. Preserve an existing hand-authored
    // `.cartograph/config.json` during partial setup recovery; CLI/API
    // options still win via the explicit merge below.
    const config = loadConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);
    pinDerivedPostgresSchema(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath, { database: config.database });
    const queries = new QueryBuilder(db.getDb(), db.hasVecExtension());

    const instance = new Cartograph({ db, queries, config, projectRoot: resolvedRoot });

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string, options: Omit<InitOptions, 'index' | 'onProgress'> = {}): Cartograph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`Cartograph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration. Preserve an existing hand-authored
    // `.cartograph/config.json` during partial setup recovery; CLI/API
    // options still win via the explicit merge below.
    const config = loadConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);
    pinDerivedPostgresSchema(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath, { database: config.database });
    const queries = new QueryBuilder(db.getDb(), db.hasVecExtension());

    return new Cartograph({ db, queries, config, projectRoot: resolvedRoot });
  }

  /**
   * Open an existing Cartograph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A Cartograph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<Cartograph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Cartograph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid Cartograph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);
    pinDerivedPostgresSchema(resolvedRoot, config);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath, {
      autoMigrate: options.autoMigrate ?? false,
      database: config.database,
    });
    const queries = new QueryBuilder(db.getDb(), db.hasVecExtension());

    const instance = new Cartograph({ db, queries, config, projectRoot: resolvedRoot });

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string, options: OpenOptions = {}): Cartograph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Cartograph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid Cartograph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);
    pinDerivedPostgresSchema(resolvedRoot, config);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath, {
      autoMigrate: options.autoMigrate ?? false,
      database: config.database,
    });
    const queries = new QueryBuilder(db.getDb(), db.hasVecExtension());

    return new Cartograph({ db, queries, config, projectRoot: resolvedRoot });
  }

  /**
   * Check if a directory has been initialized as a Cartograph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Return the cartograph tool playbook — which tool for which
   * question, common chains, anti-patterns, tier discipline.
   * Identical to the `cartograph_playbook` tool body and exposed here
   * for programmatic consumers (tests, scripts, agents that drive the
   * API without an MCP transport). Static — doesn't depend on an open
   * project. The MCP `initialize` handshake sends a shorter startup
   * guide to reduce connection-time context.
   */
  static getInstructions(): string {
    return FULL_PLAYBOOK;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    const coordinatorStart = Date.now();
    const result = await this.lock.mutex.withLock(async () => {
      // FRICTION-11: re-read .cartograph/config.json so an edit since
      // server startup (include/exclude globs, flags) takes effect.
      cgRefreshConfigFromDisk(this);
      const restoreConfig = cgApplyTransientIndexConfig(this, options);
      try {
        return await cgRunIndexUnderLock(this, options, coordinatorStart);
      } finally {
        restoreConfig();
      }
    });
    if (result.success && result.filesIndexed > 0) {
      // Drop the embedding cache — any new symbols extracted in this
      // pass will gain embeddings as background summarisation runs;
      // next similarity query rebuilds from SQLite.
      this.llm.embed.embeddingCache.invalidate();
    }
    this.stats.invalidateFreshness();
    if (result.success && result.filesIndexed > 0 && options.summarize !== false && !options.embedOnly) {
      // Fire-and-forget background summarisation. Skipped silently when
      // no LLM is configured AND none is auto-detectable on localhost.
      // Also skipped when `embedOnly: true` — the embed-only profile is
      // the embed-pass-only carve-out for operators who want semantic
      // search without summaries / classification / etc.
      void this.llm.bgCtrl.start();
    }
    return result;
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  /**
   * Resolve unresolved references after extraction. Two paths: fast
   * (changed files only, bounded set) and slow (all files, batched).
   */

  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    const result = await this.lock.mutex.withLock(async () => {
      try {
        this.lock.file.acquire();
      } catch {
        // Another process holds the index file-lock — flag as contention
        // so the caller can distinguish "skipped, retry later" from a
        // legitimate "nothing to sync."
        return {
          filesChecked: 0,
          filesAdded: 0,
          filesModified: 0,
          filesRemoved: 0,
          nodesUpdated: 0,
          durationMs: 0,
          lockContention: true,
        };
      }
      try {
        // FRICTION-11: re-read .cartograph/config.json so an edit made
        // since server startup takes effect on this sync.
        cgRefreshConfigFromDisk(this);
        const restoreConfig = cgApplyTransientIndexConfig(this, options);
        try {
          // Friction #66 self-heal — see indexAll's call site.
          applyExtractionLogicVersionHeal(this.queries);
          const syncResult = await this.internals.orchestrator.sync(options.onProgress);
          await cgSyncResolveReferences(this, syncResult, options.onProgress);
          await cgRunHookPhase(this, 'sync', syncResult);
          // Run maintenance on every sync, including no-op syncs. It is
          // cheap in steady state (PRAGMA optimize / incremental_vacuum
          // over a small freelist / short-timeout WAL truncate), and the
          // one-time legacy-DB full VACUUM in dbReclaimFreePages is
          // self-gated on the freelist ratio. Gating this behind a
          // changed-files check meant a clean-tree (no-op) sync never
          // reclaimed pages, so a bloated legacy auto_vacuum=0 DB could
          // never self-heal on a repo with no pending edits.
          dbRunMaintenance(this.db);
          return syncResult;
        } finally {
          restoreConfig();
        }
      } finally {
        this.lock.file.release();
      }
    });
    cgApplySyncSideEffects(this, result, options);
    return result;
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.lock.mutex.withLock(async () => {
      try {
        this.lock.file.acquire();
      } catch {
        return {
          success: false,
          filesIndexed: 0,
          filesSkipped: 0,
          filesErrored: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          errors: [
            { message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const },
          ],
          durationMs: 0,
        };
      }
      try {
        return this.internals.orchestrator.indexFiles(filePaths);
      } finally {
        this.lock.file.release();
      }
    });
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Get the current configuration
   */
  getConfig(): CartographConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CartographConfig>): void {
    if (updates.maxFileSize !== undefined) {
      cgAssertMaxFileSize(updates.maxFileSize, 'CartographConfig.maxFileSize');
    }
    Object.assign(this.config, updates);
    saveConfig(this.projectRoot, this.config);
    // Recreate orchestrator and resolver with new config
    this.internals.orchestrator = new ExtractionOrchestrator(this.projectRoot, this.config, this.queries);
    this.internals.resolver = createResolver(this.projectRoot, this.queries);
  }

  // ===========================================================================
  // Coverage
  // ===========================================================================

  /**
   * Parse a coverage report (lcov today; cobertura/jacoco TBD) and
   * upsert per-symbol rollups into `node_coverage`. Idempotent under
   * the same source key.
   */
  async ingestCoverage(
    reportPath: string,
    options: { format?: 'lcov'; source?: string; clearSource?: boolean } = {},
  ): Promise<import('./coverage/index.js').IngestResult> {
    const { ingestCoverage } = await import('./coverage/index.js');
    return ingestCoverage({ queries: this.queries, projectRoot: this.projectRoot, reportPath, options });
  }

  // ===========================================================================
  // Backwards-compatibility aliases
  // ===========================================================================

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove Cartograph from the project.
   * This closes the database and deletes the .Cartograph directory.
   *
   * Async because the hook-worker child must fully exit before we
   * delete the directory — on Windows the rm of `.cartograph/` would
   * fail with EBUSY against the child's still-open DB handle; on
   * POSIX the orphan-inode write window between the child's SIGTERM
   * and its exit can briefly drop ggml-metal teardown writes.
   *
   * WARNING: This permanently deletes all Cartograph data for the project.
   */
  async uninitialize(): Promise<void> {
    const existingTeardown = CARTOGRAPH_RESOURCE_TEARDOWNS.get(this);
    if (existingTeardown) {
      await existingTeardown;
    } else {
      await this.watcher.stopAndWait();
      this.llm.bgCtrl.cancel();
      // Await the child's actual exit before we touch the directory.
      // `close()` would fire-and-forget the terminate; that's fine for
      // process-exit cleanup but wrong here.
      const hookWorkerTeardown = this.internals.hookWorker.terminate();
      void rememberCartographResourceTeardown(this, hookWorkerTeardown);
      await hookWorkerTeardown;
      this.lock.file.release();
      this.db.close();
    }
    removeDirectory(this.projectRoot);
  }
}

/**
 * Post-mutex sync side effects: embedding cache invalidation, freshness
 * cache bust, and background-summarisation trigger. Pulled out of
 * {@link Cartograph.sync} so the async mutex body stays focused on the
 * lock/sync/hooks path.
 */
function cgApplySyncSideEffects(cg: Cartograph, result: SyncResult, options: IndexOptions): void {
  const changed = result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0;
  // Drop the embedding cache if anything actually moved — new embeddings
  // for added/modified files will be regenerated by the background pass.
  if (changed) cg.llm.embed.embeddingCache.invalidate();
  // Stamped metadata changed — drop cached freshness so the next
  // getFreshness() reads the new sha/timestamp instead of the prior value.
  cg.stats.invalidateFreshness();
  // Fire-and-forget background summarisation when files actually changed.
  // No-op on cold sync where nothing was added/modified.
  if ((result.filesAdded > 0 || result.filesModified > 0) && options.summarize !== false) {
    void cg.llm.bgCtrl.start();
  }
}

/**
 * Resolve unresolved references after a sync. Three modes, in priority order:
 *
 *  - With git-tracked `changedFilePaths`: run two scoped passes —
 *    (A) refs FROM the changed files (existing behavior), and
 *    (B) refs whose name matches a symbol DEFINED in the changed
 *    files but whose own file lives elsewhere. Pass B catches the
 *    rename / new-export case where stale refs in unmodified files
 *    would otherwise sit unresolved until `admin index --force`.
 *  - Without git info: batch across the whole `unresolved_refs`
 *    table to avoid OOM on large indexes.
 *  - Stranded-refs safety net (NEW): when `cgEdgesAppearDegenerate`
 *    flags the index — `unresolved_refs.count >= DEGENERATE_EDGE_UREF_FLOOR`
 *    with zero `calls` and zero `imports` edges — run a full batched
 *    drain even on a clean-tree sync. Catches the bug class where a
 *    prior incomplete sync (deleted-file evict, watcher race, partial
 *    bulk-pool failure) left cross-file reconstructed refs in the
 *    table but never resolved them — the symptom was a "🟢 in sync"
 *    status with call-graph queries returning empty. The check also
 *    fires on removal-only syncs (filesRemoved > 0, no adds/modifies)
 *    when degeneracy is detected, so a deletion that strands refs
 *    self-heals on the same sync. Cheap when the table is healthy
 *    (one COUNT then return); reuses `resolveAndPersistBatched` which
 *    deletes both resolved AND unresolved rows so legitimately-external
 *    refs don't accumulate forever in the corrupted-state recovery.
 */
async function cgSyncResolveReferences(
  self: Cartograph,
  result: SyncResult,
  onProgress?: (info: IndexProgress) => void,
): Promise<void> {
  const noFileMovement = result.filesAdded === 0 && result.filesModified === 0 && result.filesRemoved === 0;
  const willDrainStranded = noFileMovement && cgEdgesAppearDegenerate(self);
  // Skip work entirely when nothing moved AND the index isn't in the
  // known-degenerate state — preserves the steady-state "0 work, 0
  // churn" perf optimization (every cache hit on a long-lived server
  // would otherwise force a `warmCaches` repopulate next call).
  if (noFileMovement && !willDrainStranded) return;

  // Resolver caches `knownNames` / `knownFiles` at first warm and reuses
  // them across calls. ANY mutation invalidates them: adds/modifies bring
  // in new symbol names that aren't in the cached set; removals leave
  // already-deleted names in the cache so the membership pre-filter
  // wastes work attempting to resolve refs that can no longer match.
  // Clear so `warmCaches()` repopulates from current DB state on the
  // next resolve.
  self.internals.resolver.clearCaches();

  if (result.filesAdded > 0 || result.filesModified > 0) {
    if (result.changedFilePaths) {
      // Pass A: re-resolve refs LIVING IN the changed files (the
      // canonical case — file edited, its own unresolved refs may now
      // resolve against newly-stable targets).
      const fromChangedFiles = getUnresolvedReferencesByFiles(self.queries, result.changedFilePaths);
      // Pass B: re-resolve refs in OTHER files whose name matches a
      // symbol DEFINED in the changed files. Catches the rename and
      // new-export cases — `embedAllSummaries` → `embedAllNodes` had
      // call sites in 4 files unmodified by the rename commit; without
      // this pass their refs sat stale in `unresolved_refs` until a
      // human ran `admin index --force`. SQL filters out the file_path
      // overlap so a ref isn't reprocessed twice.
      const fromDefiningFiles = getUnresolvedReferencesByDefiningFiles(self.queries, result.changedFilePaths);
      const merged = [...fromChangedFiles, ...fromDefiningFiles];
      onProgress?.({ phase: 'resolving', current: 0, total: merged.length });
      self.internals.resolver.resolveAndPersist(merged, (current, total) => {
        onProgress?.({ phase: 'resolving', current, total });
      });
    } else {
      const unresolvedCount = getUnresolvedReferencesCount(self.queries);
      onProgress?.({ phase: 'resolving', current: 0, total: unresolvedCount });
      await self.internals.resolver.resolveAndPersistBatched((current, total) => {
        onProgress?.({ phase: 'resolving', current, total });
      });
    }
  }

  // Degraded-edges safety net. Pass A/B is scoped to changedFilePaths,
  // so refs reconstructed during a prior file deletion / partial sync
  // (whose source files aren't in *this* sync's change set, and whose
  // target symbol names aren't defined by *this* sync's changed files)
  // can sit forever otherwise — the symptom being "🟢 in sync" with
  // calls / imports / instantiates edges at zero. The degeneracy check
  // already ran above to decide whether to enter this function on a
  // no-file-movement sync; on a file-movement sync the prior Pass A/B
  // already drained what it could, so a second check picks up the
  // remaining stranded set. Two cheap COUNTs in steady state — the
  // drain itself only fires on a real corruption.
  if (willDrainStranded || cgEdgesAppearDegenerate(self)) {
    const stranded = getUnresolvedReferencesCount(self.queries);
    if (stranded > 0) {
      onProgress?.({ phase: 'resolving', current: 0, total: stranded });
      await self.internals.resolver.resolveAndPersistBatched((current, total) => {
        onProgress?.({ phase: 'resolving', current, total });
      });
    }
  }
}

/**
 * Detect the "resolved-edge kinds collapsed while `unresolved_refs` is
 * heavy" corrupted state.
 *
 * When the canonical resolved-reference edge kinds (`calls`, `imports`)
 * are both zero AND `unresolved_refs` count clears
 * {@link DEGENERATE_EDGE_UREF_FLOOR}, the index is in a degraded state
 * — most likely from a prior partial sync that cascaded the resolved
 * edges away and stranded the reconstructed refs without re-running the
 * resolver. Used by {@link cgSyncResolveReferences} to gate the
 * safety-net drain.
 *
 * Why those two kinds: `calls` and `imports` are the highest-volume
 * resolved-reference outputs (~12K + ~4K on a typical TS/JS project),
 * so both being zero with a heavy unresolved tail is a load-bearing
 * signal of corruption.
 *
 * Why the floor: small projects can legitimately have zero calls /
 * imports with a few unresolved refs that are awaiting a future sync's
 * resolution (the Pass B rename / new-export case explicitly relies on
 * stranded refs surviving). The drain `resolveAndPersistBatched` would
 * delete those refs, defeating that workflow. The floor keeps the
 * safety-net dormant in those cases and active in the genuine bug case.
 */
function cgEdgesAppearDegenerate(self: Cartograph): boolean {
  const row = self.queries.db
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM edges WHERE kind = 'calls') AS calls,
       (SELECT COUNT(*) FROM edges WHERE kind = 'imports') AS imports,
       (SELECT COUNT(*) FROM unresolved_refs) AS uref`,
    )
    .get() as { calls: number; imports: number; uref: number } | undefined;
  if (!row) return false;
  return row.calls === 0 && row.imports === 0 && row.uref >= DEGENERATE_EDGE_UREF_FLOOR;
}

// Default export
export default Cartograph;
