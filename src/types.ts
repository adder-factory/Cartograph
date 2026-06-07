/**
 * Cartograph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

import type { LayerConfig, LayerException } from './biomarkers/layering-types.js';
import type { ExtractionError } from './extraction/types.js';
import type { Language, NodeKind } from './graph/core-types.js';

export type { LayerConfig, LayerException } from './biomarkers/layering-types.js';
export type {
  BuildContextOptions,
  CodeBlock,
  FindRelevantContextOptions,
  TaskContext,
  TaskInput,
} from './context/types.js';
export type { GraphStats, SchemaVersion } from './db/types.js';
export type {
  ExtractionError,
  ExtractionResult,
  NestedFunctionManifestRow,
  UnresolvedReference,
} from './extraction/types.js';
export type {
  CandidateScoreTrace,
  ScoreExplanation,
  ScorePassEntry,
  Subgraph,
  TraversalOptions,
} from './graph/types.js';
export type { Context, DecoratorArgsEntry, Edge, EdgeKind, Language, Node, NodeKind } from './graph/core-types.js';
export type { SearchOptions, SearchResult } from './search/types.js';

// =============================================================================
// File Types
// =============================================================================

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];

  /**
   * Number of git commits touching this path. 0 when uncommitted or
   * mining disabled. Lower bound on shallow clones.
   */
  commitCount?: number;

  /** Current line count of the file on disk (newline-delimited). */
  loc?: number;

  /** Unix seconds, first commit timestamp touching this path. */
  firstSeenTs?: number | null;

  /** Unix seconds, most recent commit timestamp touching this path. */
  lastTouchedTs?: number | null;

  /**
   * True when the path matches a known test-file convention
   * (see src/test-detection.ts). Set at index time. Defaults to
   * false; downstream consumers (dead-code analysis, biomarker
   * rollups, co-change weighting) read this directly.
   */
  isTest?: boolean;

  /**
   * Force-re-extract flag (migration 047). Set to true by
   * `applyExtractionLogicVersionHeal`; the sync change-detection path
   * treats this file as "modified" regardless of content_hash match.
   * Cleared back to false when `upsertFile` writes the post-re-extract
   * record. Defaults to false. See staleness-redesign Phase 1 / friction F4.
   */
  needsReextract?: boolean;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Framework-specific hints for better extraction
 */
interface FrameworkHint {
  /** Framework name (react, express, django, etc.) */
  name: string;

  /** Version constraint if relevant */
  version?: string;

  /** Custom patterns for this framework */
  patterns?: {
    /** Component detection patterns */
    components?: string[];
    /** Route detection patterns */
    routes?: string[];
    /** Model detection patterns */
    models?: string[];
  };
}

/**
 * Configuration for a Cartograph project
 */
export interface CartographConfig {
  /** Schema version for migrations */
  version: number;

  /** Root directory of the project */
  rootDir: string;

  /** Glob patterns for files to include */
  include: string[];

  /** Glob patterns for files to exclude */
  exclude: string[];

  /** Languages to process (auto-detected if empty) */
  languages: Language[];

  /** Framework hints for better extraction */
  frameworks: FrameworkHint[];

  /** Maximum file size to process (in bytes) */
  maxFileSize: number;

  /** Whether to extract docstrings */
  extractDocstrings: boolean;

  /** Whether to track call sites */
  trackCallSites: boolean;

  /**
   * Whether to recurse into git submodules during indexing and sync.
   * Default: true.
   */
  indexSubmodules?: boolean;

  /**
   * Mine the file-level co-change graph from git history. Default true.
   */
  enableCoChange?: boolean;

  /**
   * Run the static-analysis biomarker engine after every indexAll/sync
   * (Brain Method, Complex Method, Nested Complexity, Complex
   * Conditional, Large Method). Cheap on sync (only re-analyses
   * touched files); enabled by default. Set false on environments
   * where the extra parser run is unwanted.
   */
  enableBiomarkers?: boolean;

  /**
   * Optional LLM configuration for value-add features (symbol
   * summarisation, semantic search, dead-code judging, role classification,
   * RAG Q&A). Supported chat providers: `openai-compat` (HTTP via
   * the openai npm SDK), `claude-bridge` (`claude` CLI subprocess),
   * `anthropic-api` (Anthropic HTTPS). Embedding + reranker only
   * support `openai-compat`.
   *
   * Off by default — cartograph remains FTS-only and zero-dependency
   * when this is absent.
   *
   * Each tier (summarizeLlm / askLlm / localLlm / embeddingLlm /
   * rerankerLlm) carries its own `endpoint` + `model`, so the user
   * can mix backends per tier. Most common shape: one llama-server
   * per tier on different ports, OR one Ollama for everything.
   *
   * Example (all-in-one llama-cpp — multiple instances on
   * different ports):
   *
   *   "llm": {
   *     "enabled": true,
   *     "summarizeLlm": { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:8081",
   *                       "model": "qwen2.5-coder-3b-instruct" },
   *     "askLlm":       { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:8082",
   *                       "model": "qwen2.5-coder-7b-instruct" },
   *     "embeddingLlm": { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:8080",
   *                       "model": "jina-embeddings-v2-base-code" }
   *   }
   *
   *   Start each: `llama-server -m <model> --port <port> [--embeddings|--rerank]`.
   *
   * Example (Ollama for everything — single port, auto model swap):
   *
   *   "llm": {
   *     "enabled": true,
   *     "summarizeLlm": { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:11434",
   *                       "model": "qwen2.5-coder:3b" },
   *     "embeddingLlm": { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:11434",
   *                       "model": "nomic-embed-text" }
   *   }
   *
   * Example (claude-bridge for chat, llama-server HTTP for embeddings):
   *
   *   "llm": {
   *     "enabled": true,
   *     "summarizeLlm": { "provider": "claude-bridge",
   *                       "model": "claude-haiku-4-5" },
   *     "embeddingLlm": { "provider": "openai-compat",
   *                       "endpoint": "http://localhost:8080",
   *                       "model": "jina-embeddings-v2-base-code" }
   *   }
   */
  llm?:
    | {
        /**
         * Master switch. When `false` (or unset and no chat/embeddings
         * blocks present), all LLM-driven features are skipped.
         */
        enabled?: boolean;

        /** LLM provider for cartograph's own indexing-time calls — bulk
         *  summarisation pass, role classification, directory summaries,
         *  dead-code judge default. Pick a fast small code-tuned model;
         *  this is the workload that runs hundreds-thousands of times on
         *  a fresh corpus.
         *
         *  Falls through here when `askLlm` / `localLlm` are unset
         *  (single-provider behaviour). Configure those slots separately
         *  for higher-quality ask answers and agent-delegated prose. */
        summarizeLlm?: {
          provider: import('./llm/client.js').ChatProvider;
          /** Default model for bulk tasks (e.g. claude-haiku-4-5 for claude-bridge,
           *  or the backend-served model id for openai-compat). */
          model?: string;
          /** Optional override for higher-stakes single-shot calls (ask, dead-code).
           *  Defaults to `model` when unset. Same provider as `summarizeLlm`; for a
           *  different provider entirely, use the top-level `askLlm` block instead. */
          askModel?: string;
          /** Bearer token (anthropic-api uses ANTHROPIC_API_KEY env var by default;
           *  openai-compat uses it for cloud providers). */
          apiKey?: string;
          /** openai-compat only: base URL of the HTTP backend
           *  (e.g. `http://localhost:8080` for llama-server). */
          endpoint?: string;
          /** Per-request timeout in ms. Default 300000 (openai-compat) /
           *  120000 (claude-bridge) / 60000 (anthropic-api). */
          timeoutMs?: number;
          /** Path to the `claude` binary (claude-bridge only); auto-detected on PATH if absent. */
          claudeBin?: string;
          /** Cache-misses per LLM call during summarisation. Provider-aware
           *  default: 3 for claude-bridge / anthropic-api (per-call overhead
           *  amortises across batched outputs), 1 for openai-compat. Override
           *  to disable batching entirely with 1. */
          summaryBatchSize?: number;
        };

        /** LLM the USER discusses the codebase with — backs `cartograph_ask`
         *  (MCP tool), the web viewer's Ask-AI panel, and the
         *  `cartograph_dead_code` LLM judge. **Low volume, high stakes**:
         *  one question at a time, the answer matters.
         *
         *  When unset, falls back to `summarizeLlm` with
         *  `summarizeLlm.askModel` swapped in (single-provider behaviour).
         *
         *  Example: bulk summaries on a fast local llama-server,
         *  ask on Sonnet via claude-bridge.
         *
         *      "summarizeLlm": { "provider": "openai-compat",
         *                        "endpoint": "http://localhost:8081",
         *                        "model": "qwen2.5-coder-3b" },
         *      "askLlm": { "provider": "claude-bridge",
         *                  "model": "claude-sonnet-4-6" }
         */
        askLlm?: {
          provider: import('./llm/client.js').ChatProvider;
          model?: string;
          apiKey?: string;
          /** openai-compat only: base URL of the HTTP backend. */
          endpoint?: string;
          timeoutMs?: number;
          claudeBin?: string;
        };

        /** Optional separate provider for `cartograph_local_chat` calls —
         *  the local-tier sibling. The agent routes coding subtasks here:
         *  paraphrase verification, draft prose, snippet classification,
         *  mechanical refactor previews, file summaries.
         *
         *  When unset, these calls fall through to `summarizeLlm`.
         *
         *  Example: summarizeLlm runs a 3B code model, localLlm runs a
         *  7B general-purpose model for richer prose output (two
         *  llama-server instances on different ports):
         *
         *      "summarizeLlm": { "provider": "openai-compat",
         *                        "endpoint": "http://localhost:8081",
         *                        "model": "qwen2.5-coder-3b" },
         *      "localLlm":     { "provider": "openai-compat",
         *                        "endpoint": "http://localhost:8082",
         *                        "model": "qwen2.5-coder-7b" }
         */
        localLlm?: {
          provider: import('./llm/client.js').ChatProvider;
          model?: string;
          apiKey?: string;
          /** openai-compat only: base URL of the HTTP backend. */
          endpoint?: string;
          timeoutMs?: number;
          claudeBin?: string;
        };

        /**
         * Embedding provider. Only `'openai-compat'` after the
         * in-process `'local'` pathway was deleted 2026-05-24c.
         *
         * HTTP via the official `openai` npm SDK pointing at any
         * backend that implements `/v1/embeddings`: llama-cpp's
         * llama-server, Ollama, Apple MLX's mlx_lm.server, LM Studio,
         * vLLM, LocalAI, or a cloud OpenAI-compat provider. Set
         * `endpoint` to the backend URL + `model` to its model
         * identifier. `apiKey` only needed for cloud providers.
         *
         * Run `cartograph admin install-models --write-config` to get
         * a working default config (HTTP via llama-server).
         */
        embeddingLlm?: {
          provider: import('./llm/client.js').EmbeddingProvider;
          /** Model identifier the HTTP backend expects
           *  (e.g. `nomic-embed-text` for Ollama, a model id for
           *  cloud OpenAI, the backend's alias for llama-server). */
          model: string;
          /** HTTP base URL of the backend
           *  (e.g. `http://localhost:8080` for llama-server,
           *  `http://localhost:11434` for Ollama). Omit for the
           *  cloud OpenAI default. */
          endpoint?: string;
          /** Optional Bearer token for cloud OpenAI-compat providers
           *  (OpenAI, together.ai, fireworks.ai, groq). Ignored by
           *  local backends. */
          apiKey?: string;
          /** Legacy field retained for back-compat with older configs.
           *  Ignored — the HTTP backend's own scheduler controls
           *  parallelism. */
          endpoints?: string[];
          timeoutMs?: number;
          /** Retained for back-compat with older configs; ignored by
           *  the HTTP path (model quant is baked into the file). */
          dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q4' | 'q8';
        };

        /** Optional cross-encoder reranker that re-orders the semantic
         *  top-K based on a joint (query, candidate) read. Off by default
         *  (`null` / unset). Adds ~1s per search when enabled but lifts
         *  recall on subtle / disambiguation-heavy queries.
         *
         *  Only `'openai-compat'` after the in-process `'local'`
         *  pathway was deleted 2026-05-24c. HTTP via Cohere-shape
         *  `POST /v1/rerank`. Supported by llama-server (`--rerank`
         *  flag), Jina Reranker API, Voyage AI, and Cohere itself.
         *  Set `endpoint` for local backends, `apiKey` for cloud.
         *  `model` is the identifier the backend expects. */
        rerankerLlm?: {
          provider: 'openai-compat';
          model?: string;
          /** Base URL of the HTTP backend. */
          endpoint?: string;
          /** Optional Bearer token for cloud backends. */
          apiKey?: string;
          /** Per-request timeout in milliseconds (default 60_000). */
          timeoutMs?: number;
          dtype?: string;
        } | null;

        /** Auto-summarise indexed symbols in a background pass. Default true when llm is enabled. */
        summarize?: boolean;

        /** Lever C — cap on how many symbol summaries one eager pass
         *  generates. The pass walks candidates by importance (priority-
         *  queue items first, then PageRank centrality DESC) and stops
         *  after this many cache-MISS generations; the lower-importance
         *  tail is left un-summarised until `find mode:intent` references
         *  it, at which point the demand-driven `summary_priority_queue`
         *  picks it up on the next pass. Cache-hits and explicitly-queued
         *  priority items never count toward the cap.
         *
         *  Values:
         *    - unset → a built-in default (~600)
         *    - `0` → AD-HOC ONLY: no eager summarisation at all; every
         *      symbol stays un-summarised until `find mode:intent`
         *      references it (the miss enqueues it, the next pass picks it
         *      up). The leanest mode — base indexing only, summaries purely
         *      on demand.
         *    - `N > 0` → cap at N per pass
         *    - negative → uncapped (summarise every eligible symbol)
         *  Raise it for a large repo whose hot set exceeds the default;
         *  set `0` to skip the indexing-time LLM tail entirely. */
        summarizeEagerLimit?: number;
      }
    | undefined;

  /** Custom symbol patterns to extract */
  customPatterns?:
    | Array<{
        /** Name for this pattern group */
        name: string;
        /** Regex pattern to match */
        pattern: string;
        /** Node kind to assign */
        kind: NodeKind;
      }>
    | undefined;

  /**
   * Allowlist of package.json dependencies that should never be flagged
   * as unused, even if they have no direct code imports. Use for
   * dependencies that are invoked via npm scripts or other tooling-based
   * references (e.g. typescript → tsc, vitest → vitest run).
   */
  dependenciesAllowlist?: string[];

  /**
   * Architectural layering rules. When set, the cross-file biomarker
   * pass walks `imports` edges and flags any cross-layer import that
   * violates a layer's `canImport` / `cannotImport` declaration.
   * Findings surface under the `illegal_import` biomarker, attached
   * to the import node.
   *
   * Off entirely when `layers` is undefined or empty.
   */
  layers?: LayerConfig[];

  /** Per-file exceptions to layering rules. Use sparingly. */
  layerExceptions?: LayerException[];

  /**
   * Path globs whose symbols are exempt from the `duplicate_code`
   * biomarker. Use for deliberate, accepted duplication — generated
   * delegators, scaffolded boilerplate. Matched against `file_path`
   * (a symbol is exempt when its file matches any glob). Off entirely
   * when undefined or empty.
   */
  duplicateCodeAllowlist?: string[];

  /**
   * Opt into Tier 3 of the `duplicate_code` biomarker — partial
   * (Type-3) near-miss clone detection via token-multiset overlap.
   * Off by default: Tier 3 is the false-positive-prone tier (it
   * matches bodies with added / removed / reordered statements), so
   * a project turns it on deliberately. Tiers 1/2/4 always run.
   */
  duplicateCodePartialClones?: boolean;

  /**
   * Compute PageRank centrality over calls+references after each
   * indexAll/sync. Cheap (sub-second on realistic projects); enabled
   * by default.
   */
  enableCentrality?: boolean;

  /**
   * Compute sampled Brandes betweenness centrality (G23) over the
   * same calls+references subgraph after each indexAll/sync. Distinct
   * signal from PageRank — surfaces "structural bridge" nodes that
   * lie on the only path between subsystems even when their direct
   * caller count is low. Opt-in (default false) because the
   * single-threaded path can take tens of seconds on TS-scale; the
   * worker pool brings it back under 10 s but still adds cost vs the
   * always-on centrality phase.
   */
  enableBetweenness?: boolean;

  /**
   * Mine git log for per-file churn metrics (commit count, LOC,
   * first-seen / last-touched timestamps). Set to false on shallow
   * clones or non-git checkouts where the data would be misleading.
   * Enabled by default.
   */
  enableChurn?: boolean;

  /**
   * Mine `Fixes/Closes/Resolves #N` commits and attribute issues to
   * symbols touched by their hunks. Enabled by default; turn off on
   * non-GitHub repos or where issue refs are noisy.
   */
  enableIssueHistory?: boolean;

  /**
   * Extract env-var / feature-flag read sites into config_refs.
   * Enabled by default.
   */
  enableConfigRefs?: boolean;

  /**
   * Extract SQL string-literal references (table reads/writes/DDL)
   * into sql_refs. Enabled by default.
   */
  enableSqlRefs?: boolean;

  /**
   * Extract module-format-sensitive build-context identifiers
   * (`__dirname`, `__filename`, `import.meta.*`) into
   * build_context_refs. Enabled by default. Used for CJS↔ESM
   * migration audits.
   */
  enableBuildContextRefs?: boolean;

  /**
   * Extract import-shaped specifiers from inside template literals /
   * string literals into `string_imports`. Surfaces test fixtures,
   * codegen sources, and doc examples that contain `import ... from
   * './x'` as data — useful for sed-style migration planning ("what
   * import-like strings will this rewrite touch?"). Enabled by default.
   */
  enableStringImports?: boolean;

  /**
   * F#12 — nested-function promotion: per-file mode threshold.
   *
   * When indexing a JS/TS-family file, if NO function body in the file
   * exceeds this many LOC, nested function declarations + arrow-bound
   * `const foo = () => {}` shapes are eagerly extracted as first-class
   * `function` nodes (with `contains` from their enclosing function).
   * When at least one function body crosses the threshold (the
   * `checker.ts` class), nested extraction is skipped — slice 2 will
   * handle those files via a manifest + adaptive promotion path. Skipping
   * keeps the index from blowing up by ~10× on mega-files.
   *
   * Default: 500 LOC. Set to `Infinity` to force eager extraction
   * everywhere (Option A — maximum fidelity, accepts the cost). Set
   * to `0` to disable eager extraction entirely.
   *
   * The threshold is also readable via the
   * `CARTOGRAPH_LARGE_FUNCTION_THRESHOLD` env var (the orchestrator
   * exports it from this field before the parse worker pool spawns).
   */
  largeFunctionThreshold?: number;

  /**
   * F#12 slice 3 — nested-function promotion threshold.
   *
   * Inside manifest-mode files (`largeFunctionThreshold` exceeded),
   * how many `cartograph_node({deep:true})` calls a nested function
   * must accumulate before it is auto-promoted to a real graph node
   * on the next sync. Once promoted, cross-file callers resolve to
   * the new node id, biomarker + centrality passes include it, and
   * `cartograph_find` shows a `✓ promoted` annotation.
   *
   * Default: 5. Pareto-aligned — on `checker.ts` with ~2400 nested
   * fns, empirically <5% ever cross this. Set to `Infinity` to disable
   * promotion entirely (manifest + ad-hoc view only — "maximum
   * cleanliness" mode). Set to `1` to promote on first deep call
   * ("eager promotion"). Only applies inside manifest-mode files —
   * files below `largeFunctionThreshold` already extract nested fns
   * eagerly via slice 1.
   *
   * Also readable via the `CARTOGRAPH_NESTED_PROMOTION_THRESHOLD` env
   * var (mirrors `largeFunctionThreshold`'s priming pattern for
   * worker_thread inheritance).
   */
  nestedPromotionThreshold?: number;
}

// `DEFAULT_CONFIG` lives in `./default-config.ts` so its `include`
// list can be derived from the language registry without import
// cycles. Re-exported here for backward compat with consumers that
// already import it from `'./types'`.
export { DEFAULT_CONFIG } from './default-config.js';
