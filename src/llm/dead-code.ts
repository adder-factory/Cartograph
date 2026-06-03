/**
 * Dead-code judge.
 *
 * Tier-3 enrichment: combine the deterministic graph signal
 * ("0 incoming usage edges — calls / instantiations / type uses /
 * references — + not exported + not a test fixture")
 * with an LLM judge that knows about entry points the graph can't see
 * (CLI commands, MCP tool handlers, framework hooks called by name).
 *
 * Output is a confidence-tagged candidate list, NOT a delete list —
 * the user always decides.
 */

import { z } from 'zod';
import { type LlmClient, LlmEndpointError, BATCH_PARSE_FAILURE_LOG_CHARS, type ResponseJsonSchema } from './client.js';
import type { Node } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getSymbolDescriptions, type SymbolDescription } from '../db/queries-summaries.js';
import { findOrphanedSymbols, type FindOrphanedSymbolsOptions } from '../db/queries-roles.js';
import { getIncomingEdges, getOutgoingEdges } from '../db/queries-edges.js';
import { logDebug, logWarn } from '../errors.js';
import { compact } from '../utils.js';
import { pathCategory, isFixturePath } from '../path-class.js';

function zodFallback<T extends z.ZodType>(schema: T, value: z.output<T>): z.ZodCatch<T> {
  return schema['catch'](value);
}

/** Kinds we'd flag as potentially dead. Skip data shapes (interfaces,
 *  types, enums) — those are usually used via type-positions the
 *  reference resolver doesn't track. */
const SUSPECT_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'component']);

/** Per-language constructor method names. A constructor is reached via
 *  an `instantiates` edge (which targets the class, not the method),
 *  never a `calls` edge, so the orphan query always flags it — but its
 *  liveness IS its class's liveness and it is not an independently-
 *  removable unit. Excluded from dead-code candidates; the class node
 *  itself still surfaces when it is genuinely dead.
 *
 *  Keyed by language because `initialize` is a constructor only in Ruby
 *  — in TS/JS it is an ordinary method name and must NOT be skipped.
 *  An unknown language falls through the lookup and skips nothing. */
const CONSTRUCTOR_METHOD_NAME_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'constructor',
  javascript: 'constructor',
  tsx: 'constructor',
  jsx: 'constructor',
  python: '__init__',
  ruby: 'initialize',
  php: '__construct',
};

/**
 * Well-known Go method names that satisfy stdlib / framework interfaces
 * (encoding/json, fmt, io, sort, etc.). These are dispatched via interface
 * tables that the structural reference resolver does not track, so they
 * look orphaned to the graph but are live by convention.
 */
const GO_INTERFACE_METHOD_NAMES: ReadonlySet<string> = new Set([
  'MarshalJSON',
  'UnmarshalJSON',
  'MarshalBinary',
  'UnmarshalBinary',
  'MarshalText',
  'UnmarshalText',
  'String',
  'Error',
  'Read',
  'Write',
  'Close',
  'Len',
  'Less',
  'Swap',
  'Format',
  'ServeHTTP',
]);

/** Prefixes for Go test-framework discovery (testing package). Functions
 *  matching these in `_test.go` files are dispatched by `go test` via
 *  reflection on the test binary's symbol table — invisible to the
 *  reference resolver. Kept live regardless of `includeTests` because
 *  even when the caller asks for test-file orphans, these patterns are
 *  framework-dispatched, not unused. */
const GO_TEST_NAME_PREFIXES = ['Test', 'Benchmark', 'Example', 'Fuzz'];

/**
 * Exact public/back-compat shims intentionally kept out of graph-only
 * dead-code reports. These methods are reachable by external consumers
 * through the package API, so an in-repo incoming-edge check cannot
 * prove them dead. Keep the list small and delete entries with the
 * major release that removes the deprecated surface.
 */
export const PUBLIC_API_SHIM_ALLOWLIST: ReadonlyArray<{
  readonly filePath: string;
  readonly kind: string;
  readonly name: string;
  readonly reason: string;
}> = [
  {
    filePath: 'src/cartograph-llm-service.ts',
    kind: 'method',
    name: 'hasLlm',
    reason: 'Deprecated CartographLlmService delegator kept for compatibility; prefer cg.llm.config.hasLlm().',
  },
  {
    filePath: 'src/cartograph-llm-service.ts',
    kind: 'method',
    name: 'getEffectiveLlmConfig',
    reason:
      'Deprecated CartographLlmService delegator kept for compatibility; prefer cg.llm.config.getEffectiveLlmConfig().',
  },
  {
    filePath: 'src/db/index.ts',
    kind: 'method',
    name: 'getPath',
    reason: 'DatabaseConnection public accessor used by embedders and diagnostics.',
  },
  {
    filePath: 'src/db/index.ts',
    kind: 'method',
    name: 'transaction',
    reason: 'DatabaseConnection public transaction wrapper used by embedders and tests.',
  },
];

export function isPublicApiShim(node: Pick<Node, 'filePath' | 'kind' | 'name'>): boolean {
  return PUBLIC_API_SHIM_ALLOWLIST.some(
    (entry) => entry.filePath === node.filePath && entry.kind === node.kind && entry.name === node.name,
  );
}

/**
 * Go-specific liveness conventions the graph resolver can't observe.
 * Returns true when the symbol is structurally orphan but live by Go
 * convention (program entry, package init, test framework discovery,
 * interface satisfaction).
 *
 * Interaction with `findOrphanedSymbolsQuery`: that SQL filters
 * `WHERE n.is_exported = 0`, so PascalCase Go names (the typical
 * shape for `Test*` / `Benchmark*` / `MarshalJSON` / `String` etc.)
 * never reach this predicate today — they're filtered upstream.
 * `main` and `init` are lowercase and DO pass through; they're the
 * primary cases this predicate catches in the current pipeline. The
 * other branches (interface-method names, test prefixes) are kept as
 * defense-in-depth so the dead-code path stays correct if a future
 * refactor narrows the SQL filter (e.g. a stricter Go is_exported
 * rule that requires receiver-type exportedness too).
 */
function isGoConventionLive(node: Node): boolean {
  if (node.language !== 'go') return false;
  // Program entry / package init: dispatched by the Go runtime, never
  // imported / called from source. Always live regardless of file path.
  if (node.kind === 'function' && (node.name === 'main' || node.name === 'init')) return true;
  // testing-package discovery: functions in `_test.go` named TestX /
  // BenchmarkX / ExampleX / FuzzX are dispatched by `go test`. TestMain
  // is naturally caught by the loop (Test + uppercase 'M'); no special
  // case needed.
  if (node.kind === 'function' && node.filePath.endsWith('_test.go')) {
    for (const prefix of GO_TEST_NAME_PREFIXES) {
      // Strict prefix + an uppercase letter to dodge bare `Test()`, which
      // isn't testing-package-dispatched.
      if (node.name.startsWith(prefix) && /^[A-Z]$/.test(node.name.charAt(prefix.length))) return true;
    }
  }
  // Well-known interface-satisfaction methods (fmt.Stringer / error /
  // io.Reader/Writer/Closer / sort.Interface / json.Marshaler / etc.).
  if (node.kind === 'method' && GO_INTERFACE_METHOD_NAMES.has(node.name)) return true;
  return false;
}

/**
 * Whether a path is exempt from dead-code suspicion: test, script, and
 * benchmark code is expected to carry uncalled symbols. Fixtures are
 * deliberately NOT included — `findGraphCandidates` callers that want
 * fixture orphans dropped pass `isFixturePath` through the `isExempt`
 * hook (fixture orphans sort first by file_path and would otherwise
 * eat a small `max` budget; see that parameter's doc).
 */
function isSuspicionExemptPath(filePath: string): boolean {
  const c = pathCategory(filePath);
  return c === 'test' || c === 'script' || c === 'benchmark';
}

const DEFAULT_CONCURRENCY = 8;
/** Candidates per batched judge call. Verdict output is ~80 tokens
 *  per entry, so 8 keeps a batch's output under ~800 tokens — well
 *  inside Sonnet's per-call budget. */
const DEFAULT_BATCH_SIZE = 8;

/** Confidence (0.5) returned when the judge response parses but
 *  doesn't include a numeric `confidence` field. */
const DEFAULT_JUDGE_CONFIDENCE = 0.5;
/** Confidence (0.3) returned when the judge response is unparseable. */
const UNPARSEABLE_JUDGE_CONFIDENCE = 0.3;
/** Cap (280 chars) on the judge's reason field as stored. 200 was too
 *  tight — the judge's one-line rationale routinely ran past it and
 *  was sliced mid-word; {@link truncateReason} now trims on a word
 *  boundary, and the slightly wider cap leaves room for a full clause. */
const JUDGE_REASON_MAX_CHARS = 280;
/** Floor (100) on the per-page DB fetch in `findGraphCandidates`. */
const FIND_GRAPH_PAGE_FLOOR = 100;
/**
 * Hard ceiling (50000) on the OFFSET scan in `findGraphCandidates`.
 * The paging loop's correctness comes from its natural termination
 * (`page.length < pageSize` once the orphan rows run out), so this is
 * only a backstop against pathologically large, mostly-exempt repos.
 * Any repo with fewer orphan rows than this exhausts the table — and
 * therefore finds every real orphan — before the cap can bind. It is
 * NOT scaled by `max`: the exempt-prefix size is a property of the
 * repo, not of how many results the caller asked for. (The old
 * `max * 25` cap let cartograph_review's 5-per-lens digest stop inside
 * the `__tests__/` prefix and report a false "no orphaned symbols".)
 */
const FIND_GRAPH_SCAN_LIMIT = 50000;
/** Multiplier (4) on `max` for the per-page DB fetch — overfetch so
 *  SUSPECT_KINDS filtering still returns enough candidates. */
const FIND_GRAPH_PAGE_MULTIPLIER = 4;
/** Floor (200) on the per-batch maxTokens budget for batched judges. */
const BATCH_JUDGE_MIN_MAX_TOKENS = 200;
/** Approx tokens per batched judge entry (100). */
const BATCH_JUDGE_TOKENS_PER_ENTRY = 100;

export interface DeadCodeOptions {
  signal?: AbortSignal;
  concurrency?: number;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
  /** Max candidates to judge in one pass (cap for very large repos). */
  maxCandidates?: number;
  /** Drop fixture/test-bed paths from the candidate set BEFORE judging,
   *  so a small `maxCandidates` budget isn't spent on orphans the
   *  caller will filter out afterward (fixture paths sort first). */
  excludeFixtures?: boolean;
  /** Include test / script / benchmark files in the candidate set.
   *  Default false: those paths are expected to carry uncalled symbols
   *  and are exempt from dead-code suspicion. Set true to also surface
   *  orphans in test/script/benchmark code. */
  includeTests?: boolean;
}

export interface DeadCodeCandidate {
  node: Node;
  /** "dead" | "live" | "uncertain" — model's verdict. */
  verdict: 'dead' | 'live' | 'uncertain';
  /** 0..1 — model's stated confidence. Heuristic, not calibrated. */
  confidence: number;
  /** One-line justification. */
  reason: string;
}

export interface DeadCodeResult {
  candidates: number;
  judged: number;
  errors: number;
  results: DeadCodeCandidate[];
  durationMs: number;
}

/** Bundled arguments for {@link findGraphCandidates}. */
export interface FindGraphCandidatesArgs {
  /** Prepared-statement query surface over the cartograph DB. */
  readonly queries: QueryBuilder;
  /** Maximum number of post-filter survivor candidates to return. */
  readonly max: number;
  /**
   * Optional extra path-exemption predicate (e.g. fixture directories
   * via `isFixturePath`) applied INLINE so exempt paths don't consume
   * the `max` budget only to be filtered out afterward.
   */
  readonly isExempt?: ((filePath: string) => boolean) | undefined;
  /**
   * Controls the built-in test / script / benchmark path exemption.
   * When false (default) those paths are always dropped; when true
   * their orphans are kept as candidates.
   */
  readonly includeTests?: boolean;
  /** Literal project-relative file-path prefix to keep. */
  readonly pathFilter?: string | undefined;
  /**
   * Test-only: override the orphan-source. Production callers omit
   * this and the function uses the imported `findOrphanedSymbols`.
   *
   * Background: `__tests__/dead-code-pagination.test.ts` previously
   * intercepted `findOrphanedSymbols` via a top-level
   * `mock.module('../src/db/queries-roles.js', ...)`. Under bun:test
   * with `--shard=K/N`, that mock fires when the test FILE loads and
   * mutates the module registry for the entire shard process —
   * subsequent files in the same shard inherit the mock (and the
   * delegation pattern in dead-code-pagination's `afterAll` cannot
   * unwind it, since previously-resolved ESM bindings in transitive
   * importers like `src/llm/classifier.ts` are frozen). Symptom was
   * `__tests__/llm-tiers.test.ts` tests 2-17 hanging on
   * `bgCtrl.awaitCompletion()` for ~30s each. Injecting this here
   * lets the test pass a closure DIRECTLY — no module-registry
   * mutation, no cross-file leak.
   */
  readonly _findOrphanedSymbolsForTest?: (queries: QueryBuilder, options?: FindOrphanedSymbolsOptions) => Node[];
}

/**
 * Find graph-level "looks dead" candidates BEFORE asking the LLM.
 * Cheap pre-filter so we don't burn tokens on obviously-live symbols.
 *
 * `findOrphanedSymbols` orders by file_path, and `_` sorts before any
 * letter — so `__tests__/` orphans dominate the first pages on JS/TS
 * repos. Pagination keeps fetching until we have `max` post-filter
 * survivors or the orphan rows run out; FIND_GRAPH_SCAN_LIMIT is the
 * OFFSET-scan backstop for a pathologically large, mostly-exempt repo.
 *
 * `isExempt` lets a caller drop additional paths (e.g. fixture
 * directories via `isFixturePath`) INLINE, so they don't consume the
 * `max` budget only to be filtered out afterward. `docs/test-beds/`
 * orphans sort ahead of `src/`; without this a small-`max` caller
 * fills entirely with fixtures and post-filters down to nothing.
 *
 * `includeTests` (default false) controls the built-in test / script /
 * benchmark path exemption. When false those paths are always dropped
 * (the historical behavior — they're expected to carry uncalled
 * symbols); when true their orphans are kept as candidates.
 */
export function findGraphCandidates(args: FindGraphCandidatesArgs): Node[] {
  const { queries, max, isExempt, includeTests = false, pathFilter } = args;
  const findOrphans = args._findOrphanedSymbolsForTest ?? findOrphanedSymbols;
  const out: Node[] = [];
  const pageSize = Math.max(max * FIND_GRAPH_PAGE_MULTIPLIER, FIND_GRAPH_PAGE_FLOOR);
  let offset = 0;
  while (out.length < max && offset < FIND_GRAPH_SCAN_LIMIT) {
    const page = fetchGraphCandidatePage(findOrphans, { queries, pageSize, offset, pathFilter });
    if (page.length === 0) break;
    appendGraphCandidateSurvivors({ out, page, queries, includeTests, isExempt, max });
    if (out.length >= max || page.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

type OrphanFinder = NonNullable<FindGraphCandidatesArgs['_findOrphanedSymbolsForTest']>;

interface FetchGraphCandidatePageArgs {
  readonly queries: QueryBuilder;
  readonly pageSize: number;
  readonly offset: number;
  readonly pathFilter: string | undefined;
}

function fetchGraphCandidatePage(findOrphans: OrphanFinder, args: FetchGraphCandidatePageArgs): Node[] {
  const findOpts: FindOrphanedSymbolsOptions = { limit: args.pageSize, offset: args.offset };
  if (args.pathFilter) findOpts.pathFilter = args.pathFilter;
  return findOrphans(args.queries, findOpts);
}

interface AppendGraphCandidateSurvivorsArgs {
  readonly out: Node[];
  readonly page: ReadonlyArray<Node>;
  readonly queries: QueryBuilder;
  readonly includeTests: boolean;
  readonly isExempt: ((filePath: string) => boolean) | undefined;
  readonly max: number;
}

function appendGraphCandidateSurvivors(args: AppendGraphCandidateSurvivorsArgs): void {
  const { out, page, queries, includeTests, isExempt, max } = args;
  for (const node of page) {
    if (shouldSkipGraphCandidate({ queries, node, includeTests, isExempt })) continue;
    out.push(node);
    if (out.length >= max) break;
  }
}

interface GraphCandidateSkipArgs {
  readonly queries: QueryBuilder;
  readonly node: Node;
  readonly includeTests: boolean;
  readonly isExempt: ((filePath: string) => boolean) | undefined;
}

function shouldSkipGraphCandidate(args: GraphCandidateSkipArgs): boolean {
  const { queries, node, includeTests, isExempt } = args;
  if (!SUSPECT_KINDS.has(node.kind)) return true;
  // A constructor is reached via `instantiates`, not `calls`, so it always
  // looks orphaned; the class node carries the real liveness signal.
  if (node.kind === 'method' && CONSTRUCTOR_METHOD_NAME_BY_LANGUAGE[node.language] === node.name) return true;
  // Go conventions the resolver can't see are skipped regardless of
  // includeTests because framework-dispatched cases are still live.
  if (isGoConventionLive(node)) return true;
  if (isPublicApiShim(node)) return true;
  if (isDecoratedFrameworkHook(node)) return true;
  if (isFrameworkConventionLive(node)) return true;
  if (isPublicMemberOnExportedContainer(queries, node)) return true;
  if (!includeTests && isSuspicionExemptPath(node.filePath)) return true;
  return isExempt?.(node.filePath) === true;
}

function isDecoratedFrameworkHook(node: Node): boolean {
  return (node.decorators?.length ?? 0) > 0 || (node.decoratorArgs?.length ?? 0) > 0;
}

const FRAMEWORK_DISPATCHED_NAMES: ReadonlySet<string> = new Set([
  'action',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillUnmount',
  'generateMetadata',
  'generateStaticParams',
  'getServerSideProps',
  'getStaticPaths',
  'getStaticProps',
  'loader',
  'middleware',
  'render',
]);

function isFrameworkConventionLive(node: Node): boolean {
  if (FRAMEWORK_DISPATCHED_NAMES.has(node.name)) return true;
  if (node.filePath.startsWith('src/mcp/tools/') && /^handle[A-Z]/.test(node.name)) return true;
  if (node.filePath.startsWith('src/bin/') && /^run[A-Z].*Command$/.test(node.name)) return true;
  return false;
}

function isPublicMemberOnExportedContainer(queries: QueryBuilder, node: Node): boolean {
  if (node.kind !== 'method') return false;
  if (node.visibility === 'private' || node.visibility === 'protected') return false;
  try {
    const incoming = getIncomingEdges(queries, node.id, ['contains']);
    for (const edge of incoming) {
      const parent = queries.getNodeById(edge.source);
      if (!parent) continue;
      if (parent.isExported && CONTAINER_KINDS_FOR_INTERFACE_DISPATCH.has(parent.kind)) return true;
    }
  } catch {
    /* Missing edge metadata should not suppress real candidates. */
  }
  return false;
}

interface JudgeResponse {
  verdict: 'dead' | 'live' | 'uncertain';
  confidence: number;
  reason: string;
}

/**
 * Structured-output schema for a batched judge call. Object-rooted
 * (`{results: [...]}`) so it doubles as an Anthropic tool `input_schema`.
 * `verdict` is an `enum` — on the grammar-constrained backends
 * (openai-compat / anthropic-api) the model cannot emit a non-verdict, and the
 * reply is valid JSON by construction. Passed as `ChatOptions.responseSchema`.
 */
const BATCH_JUDGE_SCHEMA: ResponseJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          verdict: { enum: ['dead', 'live', 'uncertain'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['i', 'verdict', 'confidence', 'reason'],
      },
    },
  },
  required: ['results'],
};

const JUDGE_HEADER = [
  'You are reviewing whether symbols are dead code.',
  'Every symbol below is a CONFIRMED graph orphan: static analysis',
  'found ZERO incoming usage edges — no calls, no instantiations, no',
  'type uses, no references — AND it is NOT exported. Treat',
  '"no callers, not exported" as an established fact — do NOT claim',
  'the symbol is "present in the reference graph", "used internally",',
  'or "referenced elsewhere". The reference graph already says the',
  'opposite; citing graph presence as evidence of liveness is wrong.',
  '',
  'The graph CANNOT see these forms of use, so your ONLY job is to',
  'judge whether the symbol is reachable through one of them:',
  '  - dynamic dispatch (method called by string name)',
  '  - framework hooks (e.g. Express middleware, CLI commands,',
  '    MCP tool handlers, React component used in JSX from another file)',
  '  - test fixtures used implicitly',
  '  - public API consumed by external projects',
  '  - entry points the build invokes directly',
  '',
  'If none of those apply, the symbol is "dead". A symbol is "live"',
  'ONLY when you can name the specific dynamic/external mechanism that',
  'reaches it; "uncertain" when such a mechanism is plausible but',
  'unconfirmed. Base the verdict on the name, kind, and file path —',
  'never on the static graph, which has already ruled out static use.',
].join('\n');

interface BatchItem {
  node: Node;
  summary: string | null;
  /** Names of {@link HEDGE_SIGNALS} that fired for this candidate. Each
   *  signal contributes a `[WARN: ...]` annotation to the per-item
   *  prompt line AND caps the confidence on a `dead`/`live` verdict at
   *  the signal's `confidenceCap`. Computed once during batch building
   *  via {@link detectHedgeSignals} so {@link buildBatchPrompt} and
   *  {@link DeadCodeJudgeRun.downgradeForHedgeSignals} share the same
   *  per-candidate decision without re-walking the graph. Empty set
   *  when no signal fires — the common case for the long tail. */
  hedgeSignals: ReadonlySet<string>;
}

/**
 * One structural reason to hedge a confident `dead`/`live` verdict on
 * a candidate. The dead-code judge runs against the static reference
 * graph, which can't see dispatch routes that pass through interface
 * types, decorator registries, framework handler registrations, etc.
 * A symbol that looks structurally orphaned MAY be called by every
 * consumer of an interface the static graph doesn't traverse —
 * confident `[DEAD 100%]` verdicts on such symbols are
 * over-confident regardless of what the LLM said.
 *
 * Adding a new hedge reason (e.g. `framework-handler-signature`,
 * `decorator-target`, `callback-in-registry`) is ONE entry in
 * {@link HEDGE_SIGNALS} — the `detect` predicate fires at batch
 * build, the `promptAnnotation` shows up in the per-item line so
 * the LLM knows to hedge, and the `confidenceCap` is enforced
 * post-hoc by `downgradeForHedgeSignals`.
 */
export interface HedgeSignal {
  /** Stable identifier — surfaced in `BatchItem.hedgeSignals` and
   *  rule-attribution prose ("(hedge: interface-dispatch)"). */
  name: string;
  /** One-line user-facing description of what the signal detects. */
  description: string;
  /** Per-candidate detector. Runs once at batch build time; pure
   *  query — should not throw. Return false on missing context so
   *  the signal becomes a pure-decision predicate. */
  detect: (queries: QueryBuilder, node: Node) => boolean;
  /** Annotation appended to the per-item prompt line when the signal
   *  fires. Should start with `[WARN: ...]` so the LLM grammar
   *  recognises it as a structural caveat. */
  promptAnnotation: string;
  /** Maximum confidence cap on a `dead` or `live` verdict when this
   *  signal fires. The lowest cap among all fired signals wins. */
  confidenceCap: number;
}

/**
 * Confidence ceiling (0.6) applied to a `dead`/`live` verdict on a
 * method whose enclosing class `implements` or `extends` an
 * interface / abstract base / protocol. Interface dispatch routes
 * calls through the interface type, hiding the concrete implementor
 * from the static reference graph — a method that looks orphaned
 * structurally may in fact be called by every consumer of the
 * interface. The judge can't see that; clamping confidence stops a
 * boilerplate `[DEAD 100%]` heading from inviting deletion.
 *
 * 0.6 keeps the candidate visible (above the 0.25 self-contradiction
 * hedge in the renderer) while signalling that a manual check is
 * required. The 0.4 gap below 1.0 is large enough that an agent
 * sorting by confidence will see other (uncontested) candidates
 * first.
 *
 * Re-exported so the structural friction fix #15 stays addressable by
 * symbol name from outside the registry (existing tests pin this
 * constant directly).
 */
export const INTERFACE_DISPATCH_CONFIDENCE_CAP = 0.6;

/**
 * Registry of all structural hedge signals the judge knows about.
 * Adding a new entry is one PR with one test in
 * `__tests__/dead-code-judge-run.test.ts`.
 */
export const HEDGE_SIGNALS: ReadonlyArray<HedgeSignal> = [
  {
    name: 'interface-dispatch',
    description:
      'Method on a class / struct / trait that `implements` or `extends` an interface / abstract base / protocol — callers route through the interface type, invisible to the static reference graph.',
    detect: (queries, node) => isMethodOnInterfaceImplementor(queries, node),
    promptAnnotation:
      '[WARN: method on interface implementor — callers may dispatch through the interface type, invisible to the static graph]',
    confidenceCap: INTERFACE_DISPATCH_CONFIDENCE_CAP,
  },
];

/** Compute the set of hedge-signal names that fire for one candidate.
 *  Pure — no mutation of node / queries; safe to call repeatedly. */
function detectHedgeSignals(queries: QueryBuilder, node: Node): ReadonlySet<string> {
  const fired = new Set<string>();
  for (const sig of HEDGE_SIGNALS) {
    if (sig.detect(queries, node)) fired.add(sig.name);
  }
  return fired;
}

/**
 * Cap a confident `dead`/`live` verdict at the lowest cap among every
 * hedge signal that fired for this candidate, and prepend a short note
 * naming the reason. Non-`dead`/`live` verdicts and verdicts already
 * below every fired signal's cap pass through untouched. Pure — never
 * mutates the input.
 *
 * Reads `item.hedgeSignals` (the set computed once at batch-build
 * time) so the post-pass is O(|signals|) rather than re-walking the
 * graph per candidate.
 */
export function downgradeForHedgeSignals(item: BatchItem, judged: JudgeResponse): DeadCodeCandidate {
  const node = item.node;
  const definite = judged.verdict === 'dead' || judged.verdict === 'live';
  if (!definite || item.hedgeSignals.size === 0) return { node, ...judged };

  // Find the lowest cap among signals that fired AND that bind below
  // the judge's confidence. The "binds below" check means a signal
  // with cap 0.6 doesn't change a 0.4 verdict — only confident
  // verdicts get hedged.
  let bindingCap = Number.POSITIVE_INFINITY;
  const namesBinding: string[] = [];
  for (const sig of HEDGE_SIGNALS) {
    if (!item.hedgeSignals.has(sig.name)) continue;
    if (judged.confidence <= sig.confidenceCap) continue;
    if (sig.confidenceCap < bindingCap) bindingCap = sig.confidenceCap;
    namesBinding.push(sig.name);
  }
  if (!Number.isFinite(bindingCap) || namesBinding.length === 0) return { node, ...judged };

  const reasonText = namesBinding.length === 1 ? namesBinding[0]! : namesBinding.join(', ');
  const annotated = truncateReason(`(hedge: ${reasonText}; confidence capped) ${judged.reason}`);
  return {
    node,
    verdict: judged.verdict,
    confidence: bindingCap,
    reason: annotated,
  };
}

function buildBatchPrompt(items: BatchItem[]): string {
  const lines = items.map((it, i) => {
    const sum = it.summary ? ` summary=${it.summary}` : '';
    const annotations = HEDGE_SIGNALS.filter((sig) => it.hedgeSignals.has(sig.name))
      .map((sig) => ` ${sig.promptAnnotation}`)
      .join('');
    return `${i}. ${it.node.name} (${it.node.kind}) at ${it.node.filePath}:${it.node.startLine}${sum}${annotations}`;
  });
  return [
    JUDGE_HEADER,
    '',
    'Symbols (zero-indexed):',
    ...lines,
    '',
    'Reply with a JSON object whose "results" array has one entry per',
    'symbol IN THE SAME ORDER:',
    '{"results":[{"i":0,"verdict":"dead"|"live"|"uncertain","confidence":0.0-1.0,"reason":"..."},...]}',
    'No prose, no markdown fences. Just the JSON object.',
  ].join('\n');
}

/**
 * Whether the given node is a method on a class / struct / trait that
 * appears on the source side of an `implements` or `extends` edge —
 * i.e. interface dispatch can reach this method through the
 * superclass / interface type without showing up as a direct
 * caller of the concrete method in the static graph.
 *
 * The walk: find the parent container via incoming `contains` edges
 * on the method; if the parent is a container kind, check whether
 * it has any outgoing `implements` / `extends` edges. If so, every
 * method on it is potentially interface-dispatched.
 *
 * Returns false on a missing parent / non-container parent / any
 * thrown query error so the caller can use it as a pure-decision
 * predicate without try/catch.
 */
const CONTAINER_KINDS_FOR_INTERFACE_DISPATCH: ReadonlySet<string> = new Set([
  'class',
  'struct',
  'trait',
  'protocol',
  'interface',
]);

export function isMethodOnInterfaceImplementor(queries: QueryBuilder, node: Node): boolean {
  if (node.kind !== 'method') return false;
  try {
    const incoming = getIncomingEdges(queries, node.id, ['contains']);
    for (const edge of incoming) {
      const parent = queries.getNodeById(edge.source);
      if (!parent || !CONTAINER_KINDS_FOR_INTERFACE_DISPATCH.has(parent.kind)) continue;
      const outgoing = getOutgoingEdges(queries, parent.id, ['implements', 'extends']);
      if (outgoing.length > 0) return true;
    }
  } catch {
    /* missing edges table / corrupt row — treat as "no interface" so
     * we don't accidentally downgrade everything on a misconfigured DB. */
  }
  return false;
}

/**
 * Cap the judge's reason at {@link JUDGE_REASON_MAX_CHARS}, trimming on
 * a word boundary so the stored rationale never ends mid-word. When the
 * cap falls inside a word, the last whitespace before it is the cut
 * point; the trimmed text gets a single-character ellipsis. A reason
 * already within the cap is returned untouched. A reason with no
 * whitespace before the cap (one very long token) is hard-sliced — an
 * ellipsis there is the lesser evil vs. an unbounded field.
 *
 * Exported for direct testing.
 */
export function truncateReason(reason: string): string {
  if (reason.length <= JUDGE_REASON_MAX_CHARS) return reason;
  const window = reason.slice(0, JUDGE_REASON_MAX_CHARS);
  const lastSpace = window.lastIndexOf(' ');
  const head = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
  return `${head}…`;
}

/**
 * Parse a batched judge reply into a position→verdict map.
 *
 * The reply is expected to be `{"results":[{"i":0,"verdict":…},…]}` —
 * guaranteed on the grammar-constrained backends (openai-compat / anthropic-api)
 * by {@link BATCH_JUDGE_SCHEMA}, best-effort on claude-bridge. A thin
 * guard, not a recovery parser: a malformed reply (only the
 * soft-constrained claude-bridge path can produce one) yields fewer
 * entries, and `applyBatchVerdicts` fills the gaps with `uncertain`.
 * Each kept entry has its verdict whitelisted, confidence clamped to
 * 0..1, and reason length-capped.
 *
 * Exported for direct testing.
 */
/**
 * Zod v4 schema for ONE judge result entry — applied per-entry inside
 * {@link parseBatchJudges} so a single malformed row is dropped while
 * the rest survive. Field semantics mirror the prior hand-rolled
 * guards exactly:
 *  - `i`          — `z.coerce` honours the occasional string index
 *                   (`"3"`); `.int()` rejects fractionals; the caller
 *                   range-checks against `expectedSize`.
 *  - `verdict`    — lower-cased then whitelisted; ANY non-verdict
 *                   (wrong type, unknown string) collapses to
 *                   `'uncertain'` via `.catch` rather than dropping
 *                   the whole entry.
 *  - `confidence` — only a real number is honoured (a string is NOT
 *                   coerced — matches the old `typeof === 'number'`
 *                   gate; `z.number()` also rejects `NaN`); anything
 *                   else falls back to the default, then clamps 0..1.
 *  - `reason`     — a non-string collapses to `''` before the
 *                   word-boundary length cap.
 */
const JudgeEntrySchema = z.object({
  i: z.coerce.number().int(),
  verdict: zodFallback(
    z.preprocess(
      (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).toLowerCase() : ''),
      z.enum(['dead', 'live', 'uncertain']),
    ),
    'uncertain',
  ),
  confidence: zodFallback(z.number(), DEFAULT_JUDGE_CONFIDENCE).transform((n) => Math.max(0, Math.min(1, n))),
  reason: zodFallback(z.string(), '').transform(truncateReason),
});

export function parseBatchJudges(text: string, expectedSize: number): Map<number, JudgeResponse> {
  const out = new Map<number, JudgeResponse>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const results =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!results) return out;
  for (const entry of results) {
    // Per-entry parse: a malformed row (unparseable `i`, non-object) is
    // dropped; `verdict` / `confidence` / `reason` self-heal via the
    // schema's `.catch` arms so a usable entry is never lost to one bad
    // sibling field. `applyBatchVerdicts` fills any gap with `uncertain`.
    const row = JudgeEntrySchema.safeParse(entry);
    if (!row.success) continue;
    const { i: idx, verdict, confidence, reason } = row.data;
    if (idx < 0 || idx >= expectedSize) continue;
    out.set(idx, { verdict, confidence, reason });
  }
  return out;
}

export async function judgeDeadCode(
  queries: QueryBuilder,
  client: LlmClient,
  options: DeadCodeOptions = {},
): Promise<DeadCodeResult> {
  return new DeadCodeJudgeRun(queries, client, options).run();
}

/**
 * Per-call state for {@link judgeDeadCode}. Workers share a cursor
 * (`nextStart`), the running counters, and the results sink via
 * instance fields. Single-shot — `run()` is intended to be called
 * once on a fresh instance.
 */
/** Mutable run-time counters — grouped to reduce field count. */
interface JudgeState {
  results: DeadCodeCandidate[];
  done: number;
  judged: number;
  errors: number;
  nextStart: number;
}

class DeadCodeJudgeRun {
  private readonly t0 = Date.now();
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly graphCandidates: Node[];
  private readonly total: number;
  private readonly summaries: Map<string, SymbolDescription>;
  private readonly queries: QueryBuilder;
  private readonly st: JudgeState = { results: [], done: 0, judged: 0, errors: 0, nextStart: 0 };

  constructor(
    queries: QueryBuilder,
    private readonly client: LlmClient,
    private readonly options: DeadCodeOptions,
  ) {
    this.queries = queries;
    const max = options.maxCandidates ?? 200;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.graphCandidates = findGraphCandidates({
      queries,
      max,
      isExempt: options.excludeFixtures ? isFixturePath : undefined,
      includeTests: options.includeTests ?? false,
    });
    this.total = this.graphCandidates.length;
    this.summaries = getSymbolDescriptions(
      queries,
      this.graphCandidates.map((n) => n.id),
    );
  }

  async run(): Promise<DeadCodeResult> {
    await Promise.all(Array.from({ length: this.concurrency }, () => this.worker()));

    // Surface "dead" verdicts first, then uncertain, then live.
    this.st.results.sort((a, b) => {
      const order = { dead: 0, uncertain: 1, live: 2 } as const;
      if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
      return b.confidence - a.confidence;
    });

    return {
      candidates: this.total,
      judged: this.st.judged,
      errors: this.st.errors,
      results: this.st.results,
      durationMs: Date.now() - this.t0,
    };
  }

  private async worker(): Promise<void> {
    while (this.st.nextStart < this.graphCandidates.length) {
      if (this.options.signal?.aborted) return;
      const start = this.st.nextStart;
      this.st.nextStart += this.batchSize;
      const batchNodes = this.graphCandidates.slice(start, start + this.batchSize);
      const batch: BatchItem[] = batchNodes.map((n) => ({
        node: n,
        summary: this.summaries.get(n.id)?.text ?? null,
        hedgeSignals: detectHedgeSignals(this.queries, n),
      }));

      await this.judgeBatch(batch, start);
      if (this.options.signal?.aborted) return;
    }
  }

  /**
   * Apply a successfully-parsed batch verdict map to the running results,
   * synthesising 'uncertain' entries for any candidate the model dropped.
   *
   * Per-entry hedge / confidence-cap logic lives in
   * {@link downgradeForHedgeSignals}, which consults the
   * {@link HEDGE_SIGNALS} registry. This method just dispatches each
   * verdict through it.
   */
  private applyBatchVerdicts(batch: BatchItem[], parsed: Map<number, JudgeResponse>): void {
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      const judged_i = parsed.get(i);
      if (judged_i) {
        this.st.results.push(downgradeForHedgeSignals(item, judged_i));
      } else {
        this.st.results.push({
          node: item.node,
          verdict: 'uncertain',
          confidence: UNPARSEABLE_JUDGE_CONFIDENCE,
          reason: 'missing from batch response',
        });
      }
      this.st.judged++;
      this.st.done++;
      this.options.onProgress?.(this.st.done, this.total);
    }
  }

  /**
   * Judge one whole batch in a single grammar-constrained LLM call.
   *
   * {@link BATCH_JUDGE_SCHEMA} is passed as `responseSchema`, so on the
   * hard-constrained backends (openai-compat / anthropic-api) the reply is a
   * valid verdict set by construction — no per-item retry, no
   * prose-scanning. `applyBatchVerdicts` fills any position the model
   * omitted (or that the soft claude-bridge path mangled) with
   * `uncertain`. A chat-level failure marks the whole batch errored.
   */
  private async judgeBatch(batch: BatchItem[], start: number): Promise<void> {
    const batchMaxTokens = Math.max(BATCH_JUDGE_MIN_MAX_TOKENS, batch.length * BATCH_JUDGE_TOKENS_PER_ENTRY);
    let result: Awaited<ReturnType<typeof this.client.chat>> | undefined;
    try {
      result = await this.client.chat(
        [{ role: 'user', content: buildBatchPrompt(batch) }],
        compact({
          temperature: 0,
          maxTokens: batchMaxTokens,
          responseSchema: BATCH_JUDGE_SCHEMA,
          useAskModel: true,
          signal: this.options.signal,
        }),
      );
    } catch (err) {
      if (this.options.signal?.aborted) return;
      this.st.errors += batch.length;
      this.st.done += batch.length;
      this.options.onProgress?.(this.st.done, this.total);
      if (err instanceof LlmEndpointError) {
        logDebug('DeadCode: batch endpoint error', { error: err.message });
      } else {
        logWarn('DeadCode: batch unexpected error', { error: String(err) });
      }
      return;
    }
    if (this.options.signal?.aborted) return;

    const parsed = parseBatchJudges(result.text, batch.length);
    if (parsed.size === 0) {
      logDebug('DeadCode: batch reply produced no parseable verdicts — defaulting to uncertain', {
        batchStart: start,
        batchSize: batch.length,
        sample: result.text.slice(0, BATCH_PARSE_FAILURE_LOG_CHARS),
      });
    }
    this.applyBatchVerdicts(batch, parsed);
  }
}
