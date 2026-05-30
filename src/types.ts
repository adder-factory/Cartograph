/**
 * Cartograph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph
 */
export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component'
  | 'table' // SQL CREATE TABLE — distinct from `class` for kind histograms
  | 'resource'; // Terraform / Bicep / CloudFormation declared resources

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains' // Parent contains child (file→class, class→method)
  | 'calls' // Function/method calls another
  | 'imports' // File imports from another
  | 'exports' // File exports a symbol
  | 'extends' // Class/interface extends another
  | 'implements' // Class implements interface
  // Structural symbol-to-symbol refs: named/aliased re-exports, GraphQL
  // type refs, HCL resource refs, SQL table refs, Svelte slot refs,
  // Liquid template bindings. NOT for runtime instance-field reads —
  // those use `field_access` (see below).
  | 'references'
  | 'type_of' // Variable/parameter has type
  | 'returns' // Function returns type
  | 'instantiates' // Creates instance of class
  | 'overrides' // Method overrides parent method
  | 'decorates' // Decorator applied to symbol
  | 'tests' // Test file → subject file (convention-derived)
  // Runtime data access: source method/function reads `obj.field` or
  // `this.field` (member_expression NOT in call position). Used by
  // ATFD/LAA-based feature_envy detection — distinct from `calls`
  // because feature envy is about data dependencies, not call dependencies.
  | 'field_access'
  // Embedding-cosine similarity between two indexed symbols, written
  // by the post-embedding similarity-edge pass. Confidence column
  // stores a categorical bucket; metadata.score holds the raw
  // similarity (1 - cosine distance). Excluded from default
  // structural traversals — opt in via traversal options.
  | 'similar_to'
  // Intra-procedural data flow: variable defined (assigned) in a
  // function body and read elsewhere within the same function scope.
  // Source = enclosing function/method node; target = same.
  // metadata.name carries the variable name. Distinct from
  // `field_access` (which targets fields, not locals).
  | 'def_use';

/**
 * Supported programming languages
 */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'svelte'
  | 'vue'
  | 'liquid'
  | 'lua'
  | 'objc'
  | 'pascal'
  | 'hcl'
  | 'r'
  | 'sql'
  | 'scala'
  | 'rescript'
  | 'elixir'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'graphql'
  | 'prisma'
  | 'properties'
  | 'xml'
  | 'yaml'
  | 'unknown';

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * B9 (2026-05-26) — captured argument literals for a single decorator
 * on a symbol. Stored on `Node.decoratorArgs` (and persisted to the
 * `nodes.decorator_args` JSON column added by migration 070).
 *
 * `name` is the decorator name (matching one of the entries in
 * `Node.decorators`). `argStrings` collects every string literal
 * from the decorator's `call_expression` argument list, in source
 * order; `argIdents` collects every bare identifier argument
 * (e.g. `@UseGuards(AuthGuard, RolesGuard)` → argIdents = ['AuthGuard',
 * 'RolesGuard']). Object-literal and array-literal args are NOT
 * captured in v1 — they'd require recursive walking; a future
 * extension can add `argObjects` when a consumer needs it.
 *
 * **Lookup is name-keyed, NOT positional**: this array is the
 * compact (null-filtered) projection of every decorator on the
 * symbol — bare decorators (`@Override`) and empty-arg calls
 * (`@Foo()`) are OMITTED entirely. Consumers MUST use
 * `decoratorArgs.find((a) => a.name === 'Get')` rather than
 * indexing positionally against `Node.decorators`. The two arrays
 * intentionally have different lengths in the mixed case.
 *
 * Framework resolvers read these directly off the graph (no
 * source re-parsing). Canonical pattern: an index-hook or
 * framework-extractor scans method/class nodes whose `decorators`
 * contains a known framework name (`Get`, `Controller`,
 * `RequestMapping`, `Value`, `MessagePattern`, etc.), then reads
 * `decoratorArgs.find((a) => a.name === 'Get')?.argStrings[0]`
 * for the URL / topic / config-key string.
 */
export interface DecoratorArgsEntry {
  /** Decorator name. Find the matching entry in `Node.decorators`
   *  by name — this array is NOT positionally aligned with
   *  `Node.decorators` (bare + empty-arg decorators are omitted). */
  name: string;
  /** Every string literal in the decorator's call args, in source order. */
  argStrings: string[];
  /** Every bare identifier in the decorator's call args, in source order. */
  argIdents: string[];
  /** NAMED args keyed by arg name → string or boolean (`'true'`/`'false'`)
   *  value, populated across three grammar shapes: PHP-8 attributes
   *  (`#[Block(id: 'foo', admin_label: 'Bar')]`), Java/C# `element_value_pair`
   *  (`@ReactMethod(isBlockingSynchronousMethod = true)`, F#83), and Kotlin
   *  named `value_argument` (`@ReactProp(name = "x")`, F#84). Omitted
   *  (undefined) for positional-only decorators (TS/JS args carry no named
   *  form), so those round-trip through the same JSON column unchanged. Used
   *  by the Drupal plugin hook to read a plugin id off an attribute. */
  namedArgs?: Record<string, string>;
}

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /**
   * B9 (2026-05-26) — captured argument literals for each
   * call-form decorator on this symbol. Carries what `decorators`
   * discards: the URL path in `@Get('/x')`, the config key in
   * `@Value('${k}')`, the topic in `@MessagePattern('event')`.
   *
   * **Lookup is name-keyed, NOT positional.** The array is the
   * compact projection: bare decorators (`@Override`) and empty-
   * arg calls (`@Foo()`) are OMITTED, so `decoratorArgs.length`
   * can be less than `decorators.length`. Consumers MUST use
   * `decoratorArgs.find((a) => a.name === 'Foo')` rather than
   * indexing by position. See `DecoratorArgsEntry` for the entry
   * shape + capture rules.
   *
   * Undefined when the symbol has no call-form decorators
   * (legacy `@Override`-only patterns, pre-B9 rows). NULL-in-DB ≡
   * undefined here. Framework resolvers read this off the graph
   * directly — no source re-parsing. See `tsExtractDecoratorsFor`.
   */
  decoratorArgs?: DecoratorArgsEntry[];

  /** When the node was last updated */
  updatedAt: number;

  /**
   * PageRank centrality score over calls+references edges, in (0, 1).
   * NULL/undefined when not yet computed (fresh DB before first
   * indexAll, or `enableCentrality: false`).
   */
  centrality?: number | null;

  /**
   * Sampled Brandes betweenness centrality over the same
   * calls+references subgraph (G23). Distinct signal from
   * `centrality` — flags structural-bridge nodes that lie on the only
   * path between two subsystems even when their direct caller count
   * is low. NULL/undefined when not yet computed (fresh DB, or
   * `enableBetweenness: false` — defaults to false). Magnitude is
   * normalised to roughly [0, 1] for directed graphs; the relative
   * ranking is the durable signal, not the absolute value.
   */
  betweenness?: number | null;

  /**
   * Per-symbol sha256(signature + body_text), 32-hex-char prefix.
   * Computed by the tree-sitter extractor on node creation; identical
   * to the hash the summarizer writes to `symbol_summaries.content_hash`.
   * Joined by `getStaleArtifactsCount` (staleness-redesign Phase 2 /
   * friction F4 follow-on) to flag stale summaries against the
   * current symbol body — replaces the prior file-level-hash compare
   * that always reported 100% stale. Empty string for legacy rows
   * pre-migration 048 (treated as "tracking pending" by the stale query).
   */
  bodyHash?: string;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown> | undefined;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /**
   * How sure the resolver is that this edge points at the right
   * target (#8). Categorical view of the float `confidence` already
   * stored in `metadata`. Default `EXTRACTED` for legacy rows.
   *   - `EXTRACTED`: concrete imports / fully-qualified / file-path
   *     resolution. Trustworthy.
   *   - `INFERRED`: heuristic same-name match, fuzzy dispatch,
   *     framework patterns below the high-confidence threshold.
   *     Verify before acting.
   *   - `AMBIGUOUS`: dynamic dispatch on an unresolved type, or a
   *     tie between equally-plausible targets. Flag and confirm.
   */
  confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

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
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /**
   * F#12 slice 2: nested-function manifest rows mined from manifest-mode
   * files (mega-files above `largeFunctionThreshold`). Empty on eager-mode
   * files — those already emit nested fns as first-class nodes via slice 1.
   * Persisted via `upsertNestedFunctionsForFile` so the storage path is
   * delete-by-file-then-insert per re-extract.
   */
  nestedFunctionManifest?: NestedFunctionManifestRow[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * F#12 slice 2: one manifest entry per nested function declaration in a
 * manifest-mode (mega-) file. Captures name + position + signature +
 * body hash — enough for `cartograph_find` to surface "this name exists
 * as a nested fn inside a mega-file" and for the stateless
 * `cartograph_node({deep:true})` ad-hoc view to re-locate the function
 * by position. NOT a graph node — no edges, no PageRank participation,
 * no cross-file resolution. Slice 3 adds the hit-counting + promotion
 * layer on top of these rows.
 *
 * `parentNodeId` is the CLOSEST REAL-NODE ANCESTOR — not the immediate
 * lexical parent. For nested-nested cases (e.g. `getInnerFn` inside
 * `getTypeOfSymbol` inside `createTypeChecker`), the immediate lexical
 * parent (`getTypeOfSymbol`) isn't itself a real node in manifest mode,
 * so the closest real ancestor (`createTypeChecker`) wins. Used for
 * the "inside `createTypeChecker`" render footer.
 */
export interface NestedFunctionManifestRow {
  parentNodeId: string;
  filePath: string;
  name: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  signature: string | null;
  bodyHash: string;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];

  /**
   * Number of call/reference sites that collapsed to this entry during
   * extraction-time dedup. ≥ 1 (1 = no duplicates seen). Used so the
   * resolver can stamp an accurate site count onto the edge metadata
   * even though we only emit one edge per (source, target, kind) pair.
   */
  siteCount?: number;

  /**
   * Additional 1-based line numbers (beyond `line`) where this same
   * reference also appeared. Capped — see EXTRA_SITES_CAP in the
   * extractor — so a 100-call hot loop doesn't blow the metadata budget.
   */
  extraLines?: number[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /**
   * Per-candidate score breakdown across the retrieval scoring
   * pipeline. Populated only when `findRelevantContext` /
   * `buildContext` is called with `explain: true` — otherwise absent
   * (the trace has a non-zero collection cost and bloats the output).
   */
  scoreTrace?: ScoreExplanation;
}

/** One candidate's score after a single named scoring pass. */
export interface ScorePassEntry {
  /** Pass name, e.g. `lexical-merge`, `centrality`, `behavior-bias`. */
  pass: string;
  /** The candidate's score immediately after that pass ran. */
  score: number;
}

/** The full scoring history of one retrieval candidate. */
export interface CandidateScoreTrace {
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  /** Score after the last pass the candidate was present for. */
  finalScore: number;
  /** Whether the candidate made it into the final entry-point set. */
  survived: boolean;
  /** Score after each pass, in pipeline order (passes where the
   *  candidate was absent are omitted). */
  passes: ScorePassEntry[];
}

/**
 * `explain: true` output for `cartograph_context` — makes the opaque
 * multi-channel scorer legible by showing, per candidate, what each
 * scoring pass contributed. Attached to {@link Subgraph.scoreTrace}.
 */
export interface ScoreExplanation {
  /** The query the scorer ran for. */
  query: string;
  /** Ordered names of every scoring pass that ran. */
  passNames: string[];
  /** Survivors first (by final score), then the top near-misses. */
  candidates: CandidateScoreTrace[];
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /**
   * Maximum depth to traverse (default: 10).
   * Pass `Infinity` to traverse the full reachable subgraph; callers should
   * combine that with a sensible `limit` since highly connected graphs can
   * produce a frontier far larger than `limit` allows during traversal.
   */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;

  /**
   * Cap the number of results from any single file before returning.
   * Default 3. Set to 0 to disable diversification (return raw ranked
   * results, even if 10 of them come from the same class). The class /
   * function / interface members of the same file are usually less
   * informative as multiple distinct results than as "this file plus
   * representative members" — diversification surfaces context across
   * the codebase rather than burying the user in one file's internals.
   */
  perFileCap?: number;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
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
 * One named architectural layer. Files matching `paths` (glob
 * patterns, project-root-relative POSIX) belong to this layer. The
 * layering rule walks `imports` edges and emits an `illegal_import`
 * finding when a layer-A file imports a layer-B file that the rule
 * forbids.
 *
 * Forbidden direction is expressed in EITHER direction:
 *   - `cannotImport: ['layer-name', 'glob/...']` listed on the
 *     SOURCE layer (preferred); OR
 *   - `canImport: [...]` listed on the source layer (allow-list — any
 *     import to a target NOT in this list is forbidden).
 *
 * Both forms accept layer names (matched against `Layer.name`) and
 * glob patterns (matched against the resolved target file path via
 * `Bun.Glob`).
 *
 * If neither field is set, the layer has no outbound restrictions.
 */
export interface LayerConfig {
  /** Stable name (referenced by other layers' canImport / cannotImport). */
  name: string;
  /** Glob patterns assigning files to this layer (matched via
   *  `Bun.Glob`). POSIX paths, project-root-relative. First-match wins
   *  across all layers in declared order. */
  paths: string[];
  /** Allow-list of layers/globs this layer is permitted to import.
   *  Mutually exclusive with `cannotImport` — set one, not both. */
  canImport?: string[];
  /** Deny-list of layers/globs this layer must NOT import.
   *  Mutually exclusive with `canImport`. */
  cannotImport?: string[];
}

/**
 * Per-file override that lifts the layering restriction for a single
 * file. Useful for the rare deliberate cross-layer reach (e.g. the
 * `mcp/tools/biomarkers.ts` tool legitimately imports the biomarker
 * engine). Match is exact (project-root-relative POSIX path).
 */
export interface LayerException {
  /** File path the exception applies to. */
  file: string;
  /** Targets this file is allowed to import despite layer rules.
   *  Layer names or globs. */
  canImport: string[];
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

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Number of tracked files matching test-file conventions (is_test=1). */
  testFileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown'). 'object' returns the raw
   *  TaskContext without serialising — useful for callers that need
   *  access to the underlying nodes (e.g. for per-file freshness checks). */
  format?: 'markdown' | 'json' | 'object';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /**
   * Seed candidates merged into the lexical pool. See
   * {@link FindRelevantContextOptions.extraCandidates}. Passed through
   * to `findRelevantContext`. Default empty.
   */
  extraCandidates?: SearchResult[];

  /**
   * Bias retrieval toward function/method/route kinds vs interfaces /
   * type aliases. See {@link FindRelevantContextOptions.behaviorBias}.
   * Default false.
   */
  behaviorBias?: boolean;

  /**
   * Collect a per-candidate score breakdown across the scoring
   * pipeline and attach it to {@link Subgraph.scoreTrace}. Off by
   * default — see {@link FindRelevantContextOptions.explain}.
   */
  explain?: boolean;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];

  /**
   * Externally-supplied candidate set merged into the lexical pool —
   * typically the hybrid FTS+semantic hits produced by
   * `CartographLlmService.searchHybrid()`. Used to seed behaviour-shaped
   * queries (`how/when/why does X happen`) so the gating function shows
   * up alongside the state-shape symbols the structural pass surfaces.
   * Scores are merged via `Math.max` per node-id so seed candidates can
   * promote — but never dampen — the deterministic lexical ranking.
   */
  extraCandidates?: SearchResult[];

  /**
   * When true, apply a small score multiplier to function/method/route
   * kinds (and a small penalty to interface/type/struct kinds) so a
   * "how does X happen" question doesn't surface only shape symbols.
   * Off by default — callers (MCP tools) opt in for behaviour-shaped
   * task strings.
   */
  behaviorBias?: boolean;

  /**
   * When true, the retrieval scorer records every candidate's score
   * after each scoring pass (lexical merge, semantic-extra seeding,
   * co-occurrence, camel/compound, centrality, behaviour bias) and
   * attaches the breakdown to {@link Subgraph.scoreTrace}. Off by
   * default — the multi-channel scorer is otherwise opaque, so this
   * is the diagnostic lever for "why did symbol X rank where it did".
   */
  explain?: boolean;
}
