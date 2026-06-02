/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  Subgraph,
  CodeBlock,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
} from '../types.js';
import { type QueryBuilder, getNodesByKind } from '../db/queries.js';
import { searchNodes, findNodesByExactName, findNodesByNameSubstring } from '../db/queries-search.js';
import { getOutgoingEdges, findEdgesBetweenNodes } from '../db/queries-edges.js';
import type { GraphTraverser } from '../graph/index.js';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter.js';
import { logDebug } from '../errors.js';
import { validatePathWithinRootReal, compact } from '../utils.js';
import { isDiagnosticPath } from '../path-class.js';
import { ScoreTrace } from './score-trace.js';
import { extractSearchTerms, scorePathRelevance, getStemVariants } from '../search/query-utils.js';
import { runSequential } from '../utils/async-iteration.js';

/**
 * Extract likely symbol names from a natural language query
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers (no spaces, not common English words)
 *
 * @param query - Natural language query
 * @returns Array of potential symbol names
 */
/** Add a dot-qualified path (`app.isPackaged`) AND each individual
 *  part (`app`, `isPackaged`) to `symbols`. Single-char parts skipped
 *  — they're below the noise threshold the rest of the extractor uses. */
function addDotPathAndParts(symbols: Set<string>, path: string): void {
  symbols.add(path);
  for (const part of path.split('.')) {
    if (part.length >= 2) symbols.add(part);
  }
}

/**
 * Merge per-term hits into the cross-term accumulator: weight each
 * row's score, max-merge against any existing row for the same node,
 * tally how many distinct terms hit each node. Pulled out of the
 * outer per-term for-loop so the body stays at depth 3.
 */
function accumulateTermResults(
  termResultsMap: Map<string, { result: SearchResult; termHits: number }>,
  termResults: ReadonlyArray<SearchResult>,
  weight: number,
): void {
  const skipReweight = weight >= 0.999;
  for (const r of termResults) {
    const reweighted = { ...r, score: r.score * weight };
    const adjusted = skipReweight ? r : reweighted;
    const existing = termResultsMap.get(r.node.id);
    if (existing) {
      existing.termHits++;
      existing.result.score = Math.max(existing.result.score, adjusted.score);
      continue;
    }
    termResultsMap.set(r.node.id, { result: adjusted, termHits: 1 });
  }
}

/**
 * English stopwords + generic code-shaped nouns/verbs (`handle`,
 * `code`, `request`, `data`, …) that match thousands of unrelated
 * symbols when used as a search term. Hoisted to module scope so the
 * Set is allocated once at load instead of per-call, and so
 * {@link extractSymbolsFromQuery} stays under the `large_method`
 * biomarker threshold.
 */
const QUERY_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'have',
  'been',
  'will',
  'would',
  'could',
  'should',
  'does',
  'done',
  'make',
  'made',
  'use',
  'used',
  'using',
  'work',
  'works',
  'find',
  'found',
  'show',
  'call',
  'called',
  'calling',
  'get',
  'set',
  'add',
  'all',
  'any',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'not',
  'but',
  'are',
  'was',
  'were',
  'has',
  'had',
  'its',
  'can',
  'did',
  'may',
  'also',
  'into',
  'than',
  'then',
  'them',
  'each',
  'other',
  'some',
  'such',
  'only',
  'same',
  'about',
  'after',
  'before',
  'between',
  'through',
  'during',
  'without',
  'again',
  'further',
  'once',
  'here',
  'there',
  'both',
  'just',
  'more',
  'most',
  'very',
  'being',
  'having',
  'doing',
  'system',
  'need',
  'needs',
  'want',
  'wants',
  'like',
  'look',
  'change',
  'changes',
  'changed',
  'changing',
  // Common English nouns/verbs that match thousands of unrelated code symbols
  'layer',
  'handle',
  'handles',
  'handling',
  'incoming',
  'outgoing',
  'data',
  'flow',
  'flows',
  'level',
  'levels',
  'request',
  'requests',
  'response',
  'responses',
  'implement',
  'implements',
  'implementation',
  'interface',
  'interfaces',
  'class',
  'classes',
  'method',
  'methods',
  'trigger',
  'triggers',
  'affected',
  'affect',
  'affects',
  'else',
  'code',
  'failing',
  'failed',
  'silently',
  'decide',
  'decides',
  'return',
  'returns',
  'returned',
  'take',
  'takes',
  'taken',
  'check',
  'checks',
  'checked',
  'create',
  'creates',
  'created',
  'read',
  'reads',
  'write',
  'writes',
  'written',
  'start',
  'starts',
  'stop',
  'stops',
  'run',
  'runs',
  'running',
]);

function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  // Each pattern extracts a different identifier shape. The minLength
  // gate skips noise that the bare regex would otherwise admit.
  collectRegexMatches(query, { pattern: /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*)\b/g, minLength: 2 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z]+(?:[A-Z][a-z]*)+)\b/g, minLength: 2 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi, minLength: 3 }, symbols);
  collectRegexMatches(query, { pattern: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g, minLength: 1 }, symbols);
  collectRegexMatches(query, { pattern: /\b([A-Z]{2,})\b/g, minLength: 1 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z][a-z0-9]{2,})\b/g, minLength: 1 }, symbols);

  // Dot notation needs its own loop because matches expand into parts
  // (e.g., "app.isPackaged" → ["app.isPackaged", "app", "isPackaged"]).
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9.]*\.[a-zA-Z0-9.]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1] && isDottedIdentifierPath(match[1])) addDotPathAndParts(symbols, match[1]);
  }

  return Array.from(symbols).filter((s) => !QUERY_STOPWORDS.has(s.toLowerCase()));
}

function isDottedIdentifierPath(value: string): boolean {
  const parts = value.split('.');
  return parts.length > 1 && parts.every(isIdentifierPathPart);
}

function isIdentifierPathPart(value: string): boolean {
  if (!value) return false;
  if (!/[a-zA-Z]/.test(value[0]!)) return false;
  for (const char of value.slice(1)) {
    if (!/[a-zA-Z0-9]/.test(char)) return false;
  }
  return true;
}

/**
 * Default options for context building
 *
 * Tuned for minimal context usage while still providing useful results:
 * - Fewer nodes and code blocks by default
 * - Smaller code block size limit
 * - Shallower traversal
 */
const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20, // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5, // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3, // Reduced from 5 - fewer entry points
  traversalDepth: 1, // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
  extraCandidates: [],
  behaviorBias: false,
  explain: false,
};

/**
 * Node kinds that provide high information value in context results.
 * Imports/exports are excluded because they have near-zero information density -
 * they tell you something exists, not how it works.
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'struct',
  'trait',
  'component',
  'route',
  'variable',
  'constant',
  'enum',
  'module',
  'namespace',
];

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3, // Reduced from 5
  traversalDepth: 1, // Reduced from 2
  maxNodes: 20, // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // Filter out imports/exports by default
  extraCandidates: [],
  behaviorBias: false,
  explain: false,
};

/**
 * Immutable slice of `ContextBuilder` threaded through module-scope helpers.
 * Extracted so private methods can become free functions without needing
 * the full class instance.
 */
interface ContextBuilderState {
  projectRoot: string;
  queries: QueryBuilder;
  traverser: GraphTraverser;
}

/**
 * Shared context threaded through the CamelCase + compound scoring helpers.
 * Bundles the mutable state (`searchResults`, `searchIdSet`) with read-only
 * inputs so the helpers can declare a single parameter and stay under the
 * `long_parameter_list` threshold. Also carries `st` so sub-helpers like
 * `cbScanOneCamelTerm` don't need a separate first parameter.
 */
interface ScoringContext {
  st: ContextBuilderState;
  searchResults: SearchResult[];
  symbolsFromQuery: string[];
  query: string;
  isTestQuery: boolean;
  opts: Required<FindRelevantContextOptions>;
  definitionKinds: NodeKind[];
  searchIdSet: Set<string>;
}

/** Args bundle for `cbCollectAndScoreCandidates` — the per-call query inputs. */
interface CandidateQueryArgs {
  query: string;
  opts: Required<FindRelevantContextOptions>;
  isTestQuery: boolean;
  /** Set only under `explain: true` — collects per-pass score snapshots.
   *  `| undefined` is explicit so the field can be passed unconditionally
   *  under `exactOptionalPropertyTypes`. */
  trace?: ScoreTrace | undefined;
}

/**
 * Top seed score (22) for the rank-0 extra candidate. `extras` are hybrid
 * FTS + semantic hits from `CartographLlmService.searchHybrid`, merged via
 * `cbMergeExtraCandidates`; populated only for behaviour questions. Each
 * subsequent rank decays by `EXTRA_CANDIDATE_RANK_DECAY` (0.7) so rank-0
 * gets 22, rank-1 gets 21.3, …, bottoming out at `EXTRA_CANDIDATE_FLOOR`.
 * 22 places the top semantic hit just above `PREFIX_BASE_BONUS` (15) and
 * `BASE_CAMEL_SCORE` (8) so it is competitive with strong lexical matches
 * without displacing an exact-name hit. The pre-r9 behaviour was a flat
 * `EXTRA_CANDIDATE_FLOOR` (1.0): that cleared `minScore` but sat below
 * EVERY lexical hit, so on a query with enough lexical matches the semantic
 * channel was trimmed before reaching the subgraph (friction F-r9-1 —
 * "how does the file watcher trigger sync" missed `FileWatcher` /
 * `watcherHandleFileEvent` entirely).
 */
const EXTRA_CANDIDATE_TOP = 22;
const EXTRA_CANDIDATE_RANK_DECAY = 0.7;
/**
 * Minimum seed score (1.0) for any extra candidate — the `Math.max`
 * floor applied when the rank-decay formula (`EXTRA_CANDIDATE_TOP -
 * rank * EXTRA_CANDIDATE_RANK_DECAY`) would otherwise drop below this
 * value (happens at rank ≥ 30 with the current constants). Kept above
 * `minScore` (default 0.3) so even a deep-ranked semantic hit survives
 * the filter pass and can enter the subgraph. Nodes already in the
 * lexical pool are only boosted toward their rank-aware seed score,
 * never damped, via `Math.max`.
 */
const EXTRA_CANDIDATE_FLOOR = 1;

/**
 * Merge externally-supplied seed candidates into a running search-result
 * list. Pulled out of `cbCollectAndScoreCandidates` so the merge stays
 * one expression deep. `extras` arrives ranked best-first; each is
 * seeded with a rank-aware score (see `EXTRA_CANDIDATE_TOP`) so a
 * strong semantic hit is competitive with lexical matches. A node
 * already in the lexical pool is boosted toward its rank-aware seed
 * (never damped) — found by both channels is the strongest evidence.
 */
function cbMergeExtraCandidates(
  searchResults: SearchResult[],
  extras: ReadonlyArray<SearchResult> | undefined,
): SearchResult[] {
  if (!extras || extras.length === 0) return searchResults;
  const byId = new Map<string, SearchResult>();
  for (const r of searchResults) byId.set(r.node.id, r);
  for (let i = 0; i < extras.length; i++) {
    const extra = extras[i]!;
    const seed = Math.max(EXTRA_CANDIDATE_FLOOR, EXTRA_CANDIDATE_TOP - i * EXTRA_CANDIDATE_RANK_DECAY);
    const existing = byId.get(extra.node.id);
    if (existing) {
      existing.score = Math.max(existing.score, seed);
      continue;
    }
    const seeded: SearchResult = { node: extra.node, score: seed };
    byId.set(extra.node.id, seeded);
    searchResults.push(seeded);
  }
  return searchResults;
}

/** Number of top semantic extra-candidates guaranteed an entry-point slot. */
const GUARANTEED_EXTRA_ROOTS = 3;

/**
 * Guarantee the top few semantic `extraCandidates` appear in the
 * entry-point (root) set. The lexical scoring channel structurally
 * favours prefix matches over substring matches — for the term
 * "watcher", `WatcherStats` (prefix) outscores `FileWatcher`
 * (substring) — so for a behaviour question the actual subject can
 * lose every entry-point slot to incidental shape symbols even after
 * rank-aware seeding and the co-occurrence carve-out (friction
 * F-r9-1). The semantic channel already ranked it #1; honour that
 * directly rather than trying to out-tune the lexical race. Non-
 * production-path (test / fixture / script / benchmark) and low-value-
 * kind extras are skipped so semantic noise (e.g. a spike-script
 * `main`) is never promoted.
 */
function cbEnsureTopExtraRoots(
  filteredResults: SearchResult[],
  extras: ReadonlyArray<SearchResult> | undefined,
  searchLimit: number,
): SearchResult[] {
  if (!extras || extras.length === 0) return filteredResults;
  const present = new Set(filteredResults.map((r) => r.node.id));
  const guaranteed: SearchResult[] = [];
  for (const e of extras) {
    if (guaranteed.length >= GUARANTEED_EXTRA_ROOTS) break;
    if (!HIGH_VALUE_NODE_KINDS.includes(e.node.kind)) continue;
    if (isDiagnosticPath(e.node.filePath)) continue;
    if (present.has(e.node.id)) continue;
    guaranteed.push({ node: e.node, score: EXTRA_CANDIDATE_TOP });
  }
  if (guaranteed.length === 0) return filteredResults;
  // Prepend the guaranteed roots; the lowest-scored lexical tail is
  // trimmed so the root count still respects `searchLimit`.
  return [...guaranteed, ...filteredResults].slice(0, Math.max(searchLimit, guaranteed.length));
}

/** Code-block extraction budget for `cbExtractCodeBlocks`. */
interface CodeBlockBudget {
  maxBlocks: number;
  maxBlockSize: number;
}

/** Inputs for the multi-term text-search pass (`cbCollectTermResultsAcross`). */
interface TextSearchParams {
  searchTerms: string[];
  searchKinds: NodeKind[];
  fetchLimit: number;
}

/** Prefix-scan inputs for `cbAppendPrefixDefinitionMatches`. */
interface PrefixMatchArgs {
  symbolsFromQuery: string[];
  exactMatches: SearchResult[];
  opts: Required<FindRelevantContextOptions>;
}

/** (nodes, edges, roots) slice of a working subgraph — shared by trim/cap helpers. */
interface SubgraphWorkspace {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
}

/** Regex-pattern spec for `collectRegexMatches`. */
interface RegexSpec {
  pattern: RegExp;
  minLength: number;
}

/** Args bundle for {@link ContextBuilder.finaliseSubgraph} — keeps the
 *  signature compact (5 positional → 1 ctx) and pairs the working
 *  graph with the test-query flag the trim/cap policy depends on. */
interface FinaliseSubgraphArgs {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
  maxNodes: number;
  isTestQuery: boolean;
}

/** Args bundle for {@link ContextBuilder.expandTypeHierarchy} — the
 *  filteredResults seed plus the working graph that the helper will
 *  mutate in place when adding hierarchy nodes/edges. */
interface ExpandTypeHierarchyArgs {
  filteredResults: SearchResult[];
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
  maxNodes: number;
}

/** Args bundle for {@link ContextBuilder.appendCamelCaseAndCompoundMatches} —
 *  the inputs that feed the inner {@link ScoringContext} (helper builds
 *  the rest of the context from these + module-local kind constants). */
interface CamelMatchArgs {
  searchResults: SearchResult[];
  symbolsFromQuery: string[];
  query: string;
  isTestQuery: boolean;
  opts: Required<FindRelevantContextOptions>;
}

// ── CamelCase / compound scoring tunables ───────────────────────────────────
/** Skip query symbols shorter than this — too many incidental matches. */
const MIN_TITLECASED_LENGTH = 3;
/** SQLite scans all LIKE matches to sort, so LIMIT is essentially free; fetch generously. */
const MAX_LIKE_RESULTS = 200;
/** Per-term cap as a fraction of `searchLimit` — half so two terms can roughly fill the budget. */
const CAMEL_PER_TERM_DIVISOR = 2;
/** Widen the per-term accumulation pool so multi-term hits survive each per-term cut. */
const CAMEL_ACCUM_MULTIPLIER = 4;
/** Floor for a single-CamelCase-match score before bonuses. */
const BASE_CAMEL_SCORE = 8;
/** Brevity bonus for matched names — concise core classes outrank verbose helpers. */
const BREVITY_BONUS_BASE = 6;
/** Divisor on the `extra-chars` part of brevity; 4 for CamelCase, 8 for compound. */
const CAMEL_BREVITY_DIVISOR = 4;
const COMPOUND_BREVITY_DIVISOR = 8;
/** Aggressive multi-term CamelCase bonus per additional matched term. */
const CAMEL_MULTI_TERM_BONUS = 30;
/** Compound-match score: floor + per-extra-term bonus. */
const COMPOUND_BASE_SCORE = 10;
const COMPOUND_PER_TERM_BONUS = 20;

// ── findRelevantContext orchestration tunables ─────────────────────────────
/**
 * PageRank-centrality blend weight for `applyCentralityBoost`.
 *
 * `score *= 1 + γ * sqrt(centrality)`. With γ=5.0 and the empirical
 * top-centrality of ~0.12 in this codebase, the most-central hub
 * gets a ~+173% bump (sqrt(0.12)*5 ≈ 1.73), a 0.01-centrality node
 * gets +50%, a 0.001-centrality leaf gets +16%. Iteratively tuned
 * against the self-eval suite — γ=5 was the value that recovered
 * `self-explore-biomarker-engine`'s recall after the common-term
 * dampener (`DAMPEN_RATE`) downweighted shared tokens. Bump
 * cautiously — over-amplification promotes hubs the user didn't
 * ask about.
 */
const CENTRALITY_BOOST_WEIGHT = 5;
/** Hard ceiling (100) on caller-supplied `searchLimit` — multiplied 5× elsewhere; cap prevents runaway fetches. */
const MAX_SEARCH_LIMIT = 100;
/** Hard ceiling on caller-supplied `maxNodes`. */
const MAX_NODES = 1000;
/** Hard ceiling on caller-supplied `traversalDepth`. */
const MAX_TRAVERSAL_DEPTH = 10;
/** Over-fetch multiplier feeding `findNodesByExactName` so co-location boost has room to re-rank. */
const EXACT_FETCH_MULT = 5;
/** Trim factor for the exact-match channel's intermediate output (after co-location boost). */
const EXACT_TRIM_MULT = 2;
/** Final trim factor before the merge step — keeps exact + prefix combined under control. */
const PREFIX_TRIM_MULT = 3;
/** Cap on the merged-channel list before filter + entry-point cap. */
const MERGED_TRIM_MULT = 3;
/** Per-term over-fetch in the text-search channel. */
const TEXT_FETCH_MULT = 2;
/** Per-term final trim cap in the text-search channel. */
const TEXT_TRIM_MULT = 2;
/** FTS limit when scanning class-like definitions whose name has the title-cased query as prefix. */
const PREFIX_FTS_LIMIT = 30;
/** Co-location bonus per extra distinct query symbol matched in the same file. */
const COLOCATION_BOOST = 20;
/** Base score uplift for a prefix-class match (added on top of the FTS score). */
const PREFIX_BASE_BONUS = 15;
/** Brevity-bonus ceiling for prefix-class matches (added before the per-extra-char penalty). */
const PREFIX_BREVITY_CEIL = 10;
/** Char-length divisor in the prefix-class brevity penalty. */
const PREFIX_BREVITY_DIVISOR = 3;
/** Boost per *additional* term matched in the text-search merge ("two terms" pays once, "three terms" pays twice, etc.). */
const TEXT_MULTI_TERM_BONUS = 5;
/** Smooth common-term dampener: each term's score is multiplied by
 *  `1 - DAMPEN_RATE * (termHits / fetchLimit)`. 0.5 = saturated terms
 *  (16/16) get 0.5×, mid-saturation 0.75×, rare hits ~1.0×. Tuned
 *  on the eval suite — see runMultiTermTextSearch's inline notes. */
const TEXT_SEARCH_DAMPEN_RATE = 0.5;

/**
 * Default search-kind set for `runMultiTermTextSearch` when the
 * caller didn't supply `nodeKinds`. Imports are intentionally absent
 * — they flood FTS with qualified-name matches almost no exploration
 * query wants.
 */
const DEFAULT_TEXT_SEARCH_KINDS: NodeKind[] = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'export',
  'route',
  'component',
];

/** Pick search kinds — caller-supplied list when non-empty, otherwise
 *  the project default. Lifted out of `runMultiTermTextSearch` so the
 *  conditional expression doesn't push the method past the
 *  conditional-operand budget. */
function pickSearchKinds(callerKinds: readonly NodeKind[] | undefined): NodeKind[] {
  if (callerKinds && callerKinds.length > 0) return [...callerKinds];
  return DEFAULT_TEXT_SEARCH_KINDS;
}

/** Score multiplier applied to non-production results (test / fixture /
 *  script / benchmark — `isDiagnosticPath`) when the query isn't itself
 *  test-flavoured. */
const TEST_FILE_PENALTY = 0.3;

/**
 * Behaviour-question bias multipliers. When the caller opts in via
 * `behaviorBias: true` (MCP layer flips it on for "how/when/why does X
 * happen" phrasing), function/method/route nodes get a small boost and
 * shape-only kinds (interface, type_alias, etc.) get a small penalty.
 * Tuned to nudge — not exclude — so a behaviour question that genuinely
 * needs a shape symbol can still surface it on raw lexical fit.
 *
 * Reproduces the friction caught 2026-05-14 where "how does the file
 * watcher decide when to trigger a sync" surfaced WatcherStats /
 * WatcherState / WatchEventCtx interfaces but missed the gating
 * function `watcherHandleFileEvent`.
 */
const BEHAVIOR_BIAS_FN_BOOST = 1.4;
const BEHAVIOR_BIAS_SHAPE_PENALTY = 0.7;
const BEHAVIOR_BIAS_FN_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'route', 'component']);
const BEHAVIOR_BIAS_SHAPE_KINDS: ReadonlySet<string> = new Set(['interface', 'type_alias', 'enum', 'enum_member']);

function applyBehaviorBias(results: SearchResult[]): void {
  for (const r of results) {
    if (BEHAVIOR_BIAS_FN_KINDS.has(r.node.kind)) {
      r.score *= BEHAVIOR_BIAS_FN_BOOST;
    } else if (BEHAVIOR_BIAS_SHAPE_KINDS.has(r.node.kind)) {
      r.score *= BEHAVIOR_BIAS_SHAPE_PENALTY;
    }
  }
}

// ── Per-file diversification + non-production caps ─────────────────────────
/** Cap any one file at this fraction of the total budget. */
const PER_FILE_CAP_FRACTION = 0.2;
/** Floor on the per-file cap so small budgets still surface multiple symbols per file. */
const MIN_PER_FILE_CAP = 5;
/** Test/sample/integration files capped at this fraction so they don't flood. */
const NON_PROD_CAP_FRACTION = 0.15;
/** Floor on the non-prod cap. */
const MIN_NON_PROD_CAP = 3;
/** Sort weight added to entry-point (root) nodes when picking eviction order. */
const ROOT_PRIORITY_BONUS = 10;

/**
 * Max entry-point names rendered inline in the context summary string.
 * Above this we summarise the remainder as "and N more" to keep the
 * summary scannable.
 */
const ENTRY_POINTS_INLINE_CAP = 3;
/**
 * Per-kind sort weight inside the per-file cap (3 for entry types,
 * 1 for methods/functions, 0 for fields/properties). Defaults to 0
 * for any kind not listed, dropping it to the bottom.
 */
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  class: 3,
  interface: 3,
  struct: 3,
  trait: 3,
  protocol: 3,
  enum: 3,
  method: 1,
  function: 1,
  property: 0,
  field: 0,
  variable: 0,
};

/**
 * In-place re-rank: boost each result's score by its node's PageRank
 * centrality. `score *= 1 + weight * sqrt(centrality)`. Sqrt-smoothing
 * keeps the boost meaningful for high-centrality hubs (~+69% at the
 * top of this repo) without distorting the long tail (low-centrality
 * leaves get a ~+6% nudge). Nodes with NULL/undefined centrality
 * (centrality hook hasn't run yet) are left at their original score.
 *
 * Closes the gap behind `findRelevantContext`'s explore-pipeline
 * failures: the agent's "how does X work" queries should surface the
 * orchestrator hubs (ExtractionOrchestrator, etc.) above the
 * incidental matches that share query tokens. BM25 alone scored them
 * comparably; centrality is the missing tiebreaker.
 */
function applyCentralityBoost(results: SearchResult[], weight: number): void {
  if (weight <= 0) return;
  for (const r of results) {
    const c = r.node.centrality;
    if (c == null || c <= 0) continue;
    r.score *= 1 + weight * Math.sqrt(c);
  }
}

/**
 * Merge two search channels (exact-match + text-FTS) into a single
 * deduped list, taking the maximum score when a node appears in
 * both. Exact matches go in first so they win the entry-order tie
 * within the dedup map, but the score is reconciled per-id via
 * `Math.max` so the merged row reflects the best evidence either
 * channel produced.
 */
function mergeSearchChannels(exactMatches: SearchResult[], textResults: SearchResult[]): SearchResult[] {
  const resultById = new Map<string, SearchResult>();
  const merged: SearchResult[] = [];
  for (const result of exactMatches) {
    const existing = resultById.get(result.node.id);
    if (existing) {
      existing.score = Math.max(existing.score, result.score);
    } else {
      resultById.set(result.node.id, result);
      merged.push(result);
    }
  }
  for (const result of textResults) {
    const existing = resultById.get(result.node.id);
    if (existing) {
      existing.score = Math.max(existing.score, result.score);
    } else {
      resultById.set(result.node.id, result);
      merged.push(result);
    }
  }
  return merged;
}

/** Render a `TaskInput` (string or `{title, description?}`) into the
 *  composite query string used by {@link ContextBuilder.buildContext}. */
function stringifyTaskInput(input: TaskInput): string {
  if (typeof input === 'string') return input;
  if (input.description) return `${input.title}: ${input.description}`;
  return input.title;
}

/** Drop an empty `nodeKinds` array down to undefined so the underlying
 *  query treats it as "no kind filter" instead of "filter to no kinds". */
function pickKindFilter<K>(kinds: K[] | undefined): K[] | undefined {
  if (kinds === undefined) return undefined;
  if (kinds.length === 0) return undefined;
  return kinds;
}

/** Trim a code block to `maxBytes`, appending an ellipsis marker when
 *  the slice fired. Pulled out of {@link ContextBuilder.extractCodeBlocks}
 *  so its inner-loop conditional stays simple. */
function truncateCodeBlock(code: string, maxBytes: number): string {
  if (code.length <= maxBytes) return code;
  return code.slice(0, maxBytes) + '\n// ... truncated ...';
}

/**
 * One-hop expansion of root ids along all edges (both directions). Used by
 * `trimToMaxNodes` to keep edge endpoints together when culling.
 */
function expandPriorityFromRoots(roots: readonly string[], edges: readonly Edge[]): Set<string> {
  const priorityIds = new Set(roots);
  for (const edge of edges) {
    if (priorityIds.has(edge.source)) priorityIds.add(edge.target);
    if (priorityIds.has(edge.target)) priorityIds.add(edge.source);
  }
  return priorityIds;
}

/** Keep priority ids first, then fill up to `maxNodes` from the rest. */
function pickTopNodes(nodes: Map<string, Node>, priorityIds: Set<string>, maxNodes: number): Map<string, Node> {
  const finalNodes = new Map<string, Node>();
  for (const id of priorityIds) {
    const node = nodes.get(id);
    if (node && finalNodes.size < maxNodes) finalNodes.set(id, node);
  }
  for (const [id, node] of nodes) {
    if (finalNodes.size >= maxNodes) break;
    if (!finalNodes.has(id)) finalNodes.set(id, node);
  }
  return finalNodes;
}

/** Mutable accumulator passed across {@link ContextBuilder.scanOneCamelTerm} calls. */
interface CamelTermAcc {
  searched: Set<string>;
  nodeTerms: Map<string, { result: SearchResult; termCount: number }>;
  accumPerTerm: number;
}

/** Mutable accumulator passed across {@link mergeHierarchyInto} calls. */
interface HierarchyAccum {
  nodes: Map<string, Node>;
  edges: Edge[];
  counter: { added: number };
  maxHierarchyNodes: number;
}

/**
 * Merge one type-hierarchy result into the running accumulator, capped by
 * `acc.maxHierarchyNodes`. `acc.counter.added` is shared mutable state so
 * the cap survives across hierarchies.
 */
function mergeHierarchyInto(hierarchy: { nodes: Map<string, Node>; edges: Edge[] }, acc: HierarchyAccum): void {
  for (const [id, node] of hierarchy.nodes) {
    if (!acc.nodes.has(id) && acc.counter.added < acc.maxHierarchyNodes) {
      acc.nodes.set(id, node);
      acc.counter.added++;
    }
  }
  for (const edge of hierarchy.edges) {
    if (!acc.nodes.has(edge.source) || !acc.nodes.has(edge.target)) continue;
    const exists = acc.edges.some((e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind);
    if (!exists) acc.edges.push(edge);
  }
}

/**
 * Build the priority list for `extractCodeBlocks`: roots first, then non-root
 * functions/methods, then non-root classes. Module-scope helper so its branches
 * don't roll up into the parent's complexity.
 */
function collectPriorityCodeBlockNodes(subgraph: Subgraph): Node[] {
  const out: Node[] = [];
  // 1) entry-point roots
  for (const id of subgraph.roots) {
    const node = subgraph.nodes.get(id);
    if (node) out.push(node);
  }
  // 2) non-root functions/methods
  appendNonRootByKind(subgraph, out, (k) => k === 'function' || k === 'method');
  // 3) non-root classes
  appendNonRootByKind(subgraph, out, (k) => k === 'class');
  return out;
}

/** Append nodes to `out` whose kind matches `pred` and which aren't roots. */
function appendNonRootByKind(subgraph: Subgraph, out: Node[], pred: (kind: string) => boolean): void {
  for (const node of subgraph.nodes.values()) {
    if (subgraph.roots.includes(node.id)) continue;
    if (pred(node.kind)) out.push(node);
  }
}

/**
 * Run a global regex over `text` and add capture-group 1 to `out` when
 * its length >= `minLength`. Keeps the per-pattern boilerplate in one place.
 */
function collectRegexMatches(text: string, spec: RegexSpec, out: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = spec.pattern.exec(text)) !== null) {
    if (match[1] && match[1].length >= spec.minLength) out.add(match[1]);
  }
}

/**
 * Group query terms that are substrings of each other (stem variants of the
 * same root). Largest first so longer terms anchor each group.
 */
function groupSubstringStemVariants(queryTerms: string[]): string[][] {
  const termGroups: string[][] = [];
  const sorted = [...queryTerms].sort((a, b) => b.length - a.length);
  const assigned = new Set<string>();
  for (const term of sorted) {
    if (assigned.has(term)) continue;
    const group = [term];
    assigned.add(term);
    for (const other of sorted) {
      if (assigned.has(other)) continue;
      if (term.includes(other) || other.includes(term)) {
        group.push(other);
        assigned.add(other);
      }
    }
    termGroups.push(group);
  }
  return termGroups;
}

/**
 * Count how many term groups match a node's name (substring) or
 * containing-directory segment (exact segment match).
 */
function countTermGroupMatches(node: Node, termGroups: string[][]): number {
  // Name match is substring; directory match is exact segment
  // ("search" matches `search/` but NOT `elasticsearch/`).
  const nameLower = node.name.toLowerCase();
  const dirSegments = path.dirname(node.filePath).toLowerCase().split('/');
  let matchCount = 0;
  for (const group of termGroups) {
    if (groupMatchesNode(group, nameLower, dirSegments)) matchCount++;
  }
  return matchCount;
}

/** True if any term in the group matches the node's name or a dir segment. */
function groupMatchesNode(group: string[], nameLower: string, dirSegments: string[]): boolean {
  for (const term of group) {
    if (nameLower.includes(term)) return true;
    if (dirSegments.includes(term)) return true;
  }
  return false;
}

/** Args bundle for {@link applyMultiTermBoost}. */
interface ApplyMultiTermBoostArgs {
  result: SearchResult;
  matchCount: number;
  exactMatchIds: Set<string>;
  extraIds: ReadonlySet<string>;
}

/**
 * Apply the multi-term boost (or non-exact-match penalty) to a
 * SearchResult. A node matching ≥2 query term-groups is boosted; one
 * matching <2 is damped as an incidental hit — UNLESS it is an exact
 * name match or a semantic `extraCandidate`. The extra-candidate
 * carve-out exists because a stop-word in the query can hide a real
 * match: "file watcher" drops `file` (a stop-word), so `FileWatcher`
 * matches only the `watcher` group and would be penalised as
 * incidental — even though the semantic channel ranked it the #1 hit
 * (friction F-r9-1). The lexical co-occurrence rule must not override
 * the semantic channel's verdict.
 */
function applyMultiTermBoost(args: ApplyMultiTermBoostArgs): void {
  const { result, matchCount, exactMatchIds, extraIds } = args;
  if (matchCount >= 2) {
    result.score *= 1 + matchCount * 0.5;
  } else if (!exactMatchIds.has(result.node.id) && !extraIds.has(result.node.id)) {
    result.score *= 0.6;
  }
}

/**
 * Filter LIKE-result candidates by CamelCase / acronym boundary, score them, and
 * return the surviving SearchResult objects (caller sorts and accumulates).
 */
function collectCamelTermCandidates(
  likeResults: SearchResult[],
  titleCased: string,
  ctx: { query: string; isTestQuery: boolean; searchIdSet: Set<string> },
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of likeResults) {
    const name = r.node.name;
    const idx = name.indexOf(titleCased);
    if (idx <= 0) continue;
    // CamelCase boundary (lowercase before) OR acronym boundary
    // (uppercase before, e.g., RPCProtocol).
    if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
    if (ctx.searchIdSet.has(r.node.id)) continue;
    if (isDiagnosticPath(r.node.filePath) && !ctx.isTestQuery) continue;

    const pathScore = scorePathRelevance(r.node.filePath, ctx.query);
    const brevityBonus = Math.max(0, BREVITY_BONUS_BASE - (name.length - titleCased.length) / CAMEL_BREVITY_DIVISOR);
    out.push({ node: r.node, score: BASE_CAMEL_SCORE + brevityBonus + pathScore });
  }
  return out;
}

// ── ContextBuilder module-scope helpers ──────────────────────────────────────
// All prefixed `cb` to namespace them clearly. Each takes a
// `ContextBuilderState` (≤3 params total) instead of `this`.

/**
 * Extract code from a node's source file.
 * Symlink-aware: validates the path is still within the project root.
 */
async function cbExtractNodeCode(st: ContextBuilderState, node: Node): Promise<string | null> {
  const filePath = validatePathWithinRootReal(st.projectRoot, node.filePath);
  if (!filePath) return null;
  const exists = await fsp.access(filePath).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const startIdx = Math.max(0, node.startLine - 1);
    const endIdx = Math.min(lines.length, node.endLine);
    return lines.slice(startIdx, endIdx).join('\n');
  } catch (error) {
    logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
    return null;
  }
}

/** Get entry points from a subgraph (the root nodes). */
function cbGetEntryPoints(subgraph: Subgraph): Node[] {
  return subgraph.roots.map((id) => subgraph.nodes.get(id)).filter((n): n is Node => n !== undefined);
}

/** Get unique sorted file paths from a subgraph. */
function cbGetRelatedFiles(subgraph: Subgraph): string[] {
  const files = new Set<string>();
  for (const node of subgraph.nodes.values()) files.add(node.filePath);
  return Array.from(files).sort((a, b) => Number(a > b) - Number(a < b));
}

/** Generate a one-line summary of the context result. */
function cbGenerateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const files = cbGetRelatedFiles(subgraph);
  const entryPointNames = entryPoints
    .slice(0, ENTRY_POINTS_INLINE_CAP)
    .map((n) => n.name)
    .join(', ');
  const overflow = entryPoints.length - ENTRY_POINTS_INLINE_CAP;
  const remaining = overflow > 0 ? ` and ${overflow} more` : '';
  return (
    `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
    `Key entry points: ${entryPointNames}${remaining}. ` +
    `${edgeCount} relationships identified.`
  );
}

interface CbAssembleTaskContextArgs {
  query: string;
  subgraph: Subgraph;
  entryPoints: Node[];
  codeBlocks: CodeBlock[];
  relatedFiles: string[];
  summary: string;
}

/** Assemble a TaskContext from pre-computed subgraph components. */
function cbAssembleTaskContext(args: CbAssembleTaskContextArgs): TaskContext {
  const { query, subgraph, entryPoints, codeBlocks, relatedFiles, summary } = args;
  return {
    query,
    subgraph,
    entryPoints,
    codeBlocks,
    relatedFiles,
    summary,
    stats: {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    },
  };
}

/** Read a node's source and wrap it in a CodeBlock, or undefined if extraction fails. */
async function cbTryBuildCodeBlock(
  st: ContextBuilderState,
  node: Node,
  maxBlockSize: number,
): Promise<CodeBlock | undefined> {
  const code = await cbExtractNodeCode(st, node);
  if (!code) return undefined;
  return {
    content: truncateCodeBlock(code, maxBlockSize),
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    language: node.language,
    node,
  };
}

/** Extract code blocks for key nodes in the subgraph. */
async function cbExtractCodeBlocks(
  st: ContextBuilderState,
  subgraph: Subgraph,
  budget: CodeBlockBudget,
): Promise<CodeBlock[]> {
  const priorityNodes = collectPriorityCodeBlockNodes(subgraph);
  const blocks: CodeBlock[] = [];
  await runSequential(priorityNodes, async (node) => {
    if (blocks.length >= budget.maxBlocks) return false;
    const block = await cbTryBuildCodeBlock(st, node, budget.maxBlockSize);
    if (block) blocks.push(block);
    return true;
  });
  return blocks;
}

/** Resolve import/export nodes to their actual definitions where possible. */
function cbResolveImportsToDefinitions(st: ContextBuilderState, results: SearchResult[]): SearchResult[] {
  const resolved: SearchResult[] = [];
  const seenIds = new Set<string>();
  for (const result of results) {
    const { node, score } = result;
    if (node.kind !== 'import' && node.kind !== 'export') {
      cbPushUniqueSearchResult(resolved, seenIds, result);
      continue;
    }
    const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
    const outgoingEdges = getOutgoingEdges(st.queries, node.id, [edgeKind as EdgeKind]);
    let foundDefinition = false;
    for (const edge of outgoingEdges) {
      const targetNode = st.queries.getNodeById(edge.target);
      if (targetNode && cbPushUniqueSearchResult(resolved, seenIds, { node: targetNode, score })) {
        foundDefinition = true;
        logDebug('Resolved import to definition', {
          import: node.name,
          definition: targetNode.name,
          kind: targetNode.kind,
        });
      }
    }
    if (!foundDefinition) logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
  }
  return resolved;
}

function cbPushUniqueSearchResult(results: SearchResult[], seenIds: Set<string>, result: SearchResult): boolean {
  if (seenIds.has(result.node.id)) return false;
  seenIds.add(result.node.id);
  results.push(result);
  return true;
}

/** After all eviction passes, recover structurally-relevant edges between surviving nodes. */
function cbRecoverEdgesBetween(st: ContextBuilderState, finalNodes: Map<string, Node>, finalEdges: Edge[]): Edge[] {
  const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
  const recoveredEdges = findEdgesBetweenNodes(st.queries, [...finalNodes.keys()], recoveryKinds);
  const existingEdgeKeys = new Set(finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`));
  for (const edge of recoveredEdges) {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!existingEdgeKeys.has(key)) {
      finalEdges.push(edge);
      existingEdgeKeys.add(key);
    }
  }
  return finalEdges;
}

/**
 * When the working subgraph exceeds `maxNodes`, build a priority set of
 * entry points + their direct neighbours and keep those first; backfill
 * the remaining budget with arbitrary other nodes.
 */
function cbTrimToMaxNodes(ws: SubgraphWorkspace, maxNodes: number): { nodes: Map<string, Node>; edges: Edge[] } {
  const { nodes, edges, roots } = ws;
  if (nodes.size <= maxNodes) return { nodes, edges };
  const priorityIds = expandPriorityFromRoots(roots, edges);
  const finalNodes = pickTopNodes(nodes, priorityIds, maxNodes);
  const finalEdges = edges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
  return { nodes: finalNodes, edges: finalEdges };
}

/**
 * Cap any one file at ~20% of the budget to prevent a single file
 * from dominating via BFS that follows `contains` up to a parent class.
 */
function cbApplyPerFileDiversityCap(finalNodes: Map<string, Node>, roots: string[], maxNodes: number): void {
  const maxPerFile = Math.max(MIN_PER_FILE_CAP, Math.ceil(maxNodes * PER_FILE_CAP_FRACTION));
  const fileCounts = new Map<string, string[]>();
  for (const [id, node] of finalNodes) {
    const ids = fileCounts.get(node.filePath) || [];
    ids.push(id);
    fileCounts.set(node.filePath, ids);
  }
  const rootSet = new Set(roots);
  for (const [, nodeIds] of fileCounts) {
    if (nodeIds.length <= maxPerFile) continue;
    nodeIds.sort((a, b) => {
      const aRoot = rootSet.has(a) ? ROOT_PRIORITY_BONUS : 0;
      const bRoot = rootSet.has(b) ? ROOT_PRIORITY_BONUS : 0;
      const aKind = KIND_PRIORITY[finalNodes.get(a)!.kind] ?? 0;
      const bKind = KIND_PRIORITY[finalNodes.get(b)!.kind] ?? 0;
      return bRoot + bKind - (aRoot + aKind);
    });
    for (const id of nodeIds.slice(maxPerFile)) finalNodes.delete(id);
  }
}

/** Limit test/sample/integration/example files to ~15% of the budget. */
function cbApplyNonProductionCap(finalNodes: Map<string, Node>, roots: string[], args: FinaliseSubgraphArgs): void {
  if (args.isTestQuery) return;
  const maxNonProd = Math.max(MIN_NON_PROD_CAP, Math.ceil(args.maxNodes * NON_PROD_CAP_FRACTION));
  const nonProdIds: string[] = [];
  for (const [id, node] of finalNodes) {
    if (isDiagnosticPath(node.filePath)) nonProdIds.push(id);
  }
  if (nonProdIds.length <= maxNonProd) return;
  for (const id of nonProdIds.slice(maxNonProd)) {
    finalNodes.delete(id);
    const rootIdx = roots.indexOf(id);
    if (rootIdx !== -1) roots.splice(rootIdx, 1);
  }
}

/** Phase 3 of `findRelevantContext`: trim + diversity caps + edge recovery. */
function cbFinaliseSubgraph(st: ContextBuilderState, args: FinaliseSubgraphArgs): Subgraph {
  const { nodes, edges, roots, maxNodes } = args;
  const trimmed = cbTrimToMaxNodes({ nodes, edges, roots }, maxNodes);
  const finalNodes = trimmed.nodes;
  let finalEdges = trimmed.edges;
  cbApplyPerFileDiversityCap(finalNodes, roots, maxNodes);
  cbApplyNonProductionCap(finalNodes, roots, args);
  finalEdges = finalEdges.filter((e) => finalNodes.has(e.source) && finalNodes.has(e.target));
  finalEdges = cbRecoverEdgesBetween(st, finalNodes, finalEdges);
  return { nodes: finalNodes, edges: finalEdges, roots };
}

interface TraversalAccumulator {
  nodes: Map<string, Node>;
  edges: Edge[];
  opts: Required<FindRelevantContextOptions>;
}

/** Phase 2 of `findRelevantContext`: BFS traversal from each entry point. */
function cbExpandViaTraversal(st: ContextBuilderState, entryPoints: SearchResult[], acc: TraversalAccumulator): void {
  for (const result of entryPoints) {
    const traversalResult = st.traverser.traverseBFS(result.node.id, cbTraversalOptions(acc.opts, entryPoints.length));
    for (const [id, node] of traversalResult.nodes) {
      if (!acc.nodes.has(id)) acc.nodes.set(id, node);
    }
    for (const edge of traversalResult.edges) {
      cbPushUniqueEdge(acc.edges, edge);
    }
  }
}

function cbTraversalOptions(opts: Required<FindRelevantContextOptions>, entryPointCount: number) {
  return compact({
    maxDepth: opts.traversalDepth,
    edgeKinds: nonEmptyArrayOrUndefined(opts.edgeKinds),
    nodeKinds: nonEmptyArrayOrUndefined(opts.nodeKinds),
    direction: 'both' as const,
    limit: Math.ceil(opts.maxNodes / Math.max(1, entryPointCount)),
  });
}

function nonEmptyArrayOrUndefined<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function cbPushUniqueEdge(edges: Edge[], edge: Edge): void {
  const exists = edges.some((e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind);
  if (!exists) edges.push(edge);
}

/**
 * Pass 1+2 type-hierarchy expansion for class/interface entry points.
 * Bounded by `maxNodes/4` to avoid drowning the rest of the budget.
 */
function cbExpandTypeHierarchy(st: ContextBuilderState, args: ExpandTypeHierarchyArgs): void {
  const { filteredResults, nodes, edges, roots, maxNodes } = args;
  const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
  const acc: HierarchyAccum = { nodes, edges, counter: { added: 0 }, maxHierarchyNodes: Math.ceil(maxNodes / 4) };
  for (const result of filteredResults) {
    if (acc.counter.added >= acc.maxHierarchyNodes) break;
    if (!typeHierarchyKinds.has(result.node.kind)) continue;
    mergeHierarchyInto(st.traverser.getTypeHierarchy(result.node.id), acc);
  }
  if (acc.counter.added === 0) return;
  const pass2Candidates = [...nodes.values()].filter((n) => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id));
  for (const candidate of pass2Candidates) {
    if (acc.counter.added >= acc.maxHierarchyNodes) break;
    mergeHierarchyInto(st.traverser.getTypeHierarchy(candidate.id), acc);
  }
}

/**
 * Re-score exact matches by co-location: symbols that share a file
 * with other matched symbols get a small boost to promote
 * "this file has several relevant symbols" results.
 */
/** Compute the co-location bonus for a result given how many distinct
 *  symbol names from the match set live in the same file. */
function colocationScore(baseScore: number, symbolCount: number): number {
  return symbolCount > 1 ? baseScore + (symbolCount - 1) * COLOCATION_BOOST : baseScore;
}

function cbApplyColocationBoost(matches: SearchResult[]): SearchResult[] {
  const fileSymbolCounts = new Map<string, Set<string>>();
  for (const r of matches) {
    const names = fileSymbolCounts.get(r.node.filePath) || new Set();
    names.add(r.node.name.toLowerCase());
    fileSymbolCounts.set(r.node.filePath, names);
  }
  const boosted = matches.map((r) => {
    const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size ?? 1;
    return { ...r, score: colocationScore(r.score, symbolCount) };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/** Channel 1: exact-name lookup with co-location boost. */
/**
 * MCP tool-name promotion. When the query mentions a canonical
 * `cartograph_X` token, look up the registered XXX_TOOL constant by
 * scanning constant signatures for `name: 'cartograph_X'`. Each hit is
 * appended to `exactMatches` with a high base score so the MCP-tool
 * entry point isn't drowned by unrelated symbols matching the
 * trailing English in the query (e.g. tokens like `name`/`content`/
 * `sql` that appear in tool axis descriptions).
 *
 * No-op when no `cartograph_*` token is present in the extracted
 * symbol list, or when no constant matches the signature pattern.
 */
function cbPromoteMcpToolMatches(
  st: ContextBuilderState,
  symbolsFromQuery: readonly string[],
  exactMatches: SearchResult[],
): SearchResult[] {
  const toolNames = symbolsFromQuery.filter((s) => /^cartograph_[a-z][a-z0-9_]*$/i.test(s)).map((s) => s.toLowerCase());
  if (toolNames.length === 0) return exactMatches;
  // One scan over `constant` nodes is bounded by the count of
  // top-level exported constants (~hundreds in a typical codebase),
  // and every signature comparison is a couple of substring checks.
  const constants = getNodesByKind(st.queries, 'constant');
  for (const tn of toolNames) {
    const needles = [`name: '${tn}'`, `name: "${tn}"`];
    for (const c of constants) {
      if (!c.signature) continue;
      if (!needles.some((needle) => c.signature!.includes(needle))) continue;
      if (exactMatches.some((e) => e.node.id === c.id)) continue;
      exactMatches.push({ node: c, score: MCP_TOOL_PROMOTION_SCORE });
    }
  }
  return exactMatches;
}

/** High base score for MCP-tool promotion — needs to clear typical
 *  text-search scores AND survive `applyCentralityBoost` (which
 *  amplifies competing hubs by `1 + 5 * sqrt(centrality)`, up to ~6×
 *  for a hub at centrality=1). The promoted node also gets
 *  centrality-boosted, but most XXX_TOOL constants sit at centrality
 *  ≈ 0 so they don't benefit. 200 leaves headroom for a competing
 *  symbol with FTS=40 + centrality=0.4 (boosted to ~166) — that's
 *  the realistic worst case from the reviewer audit. A truly
 *  exceptional hub at FTS=100 + centrality=1 (~600 boosted) could
 *  still outrank, but those would be relevant entry points anyway. */
const MCP_TOOL_PROMOTION_SCORE = 200;

/** Max symbols a query token may exactly-name before it is treated as
 *  too generic to promote. A token resolving to 1-N symbols is a
 *  specific anchor; one resolving to dozens — e.g. `extract`, where
 *  every language extractor class defines an `extract` method — is a
 *  generic English word and is left to normal ranking. */
const EXACT_NAME_PROMOTION_MAX_HITS = 4;

/** 175 — promotion score for a specific exact whole-word name match.
 *  Chosen to sit above the realistic worst-case competitor
 *  (a hub at FTS=40 + centrality=0.4 boosts to ~166 via
 *  `applyCentralityBoost`) so the promoted match survives both the
 *  `searchLimit * MERGED_TRIM_MULT` intermediate trim and the final
 *  `minScore` filter. Kept below MCP_TOOL_PROMOTION_SCORE so a
 *  canonical `cartograph_X` token remains a stronger anchor; an
 *  exceptional hub (FTS=100 + centrality=1, boosted to ~600) can
 *  still outrank, but such a hub is a relevant entry point anyway. */
const EXACT_NAME_PROMOTION_SCORE = 175;

/** @internal Bundle for {@link cbPromoteExactNameMatches} — keeps the signature below the long_parameter_list threshold. */
interface CbPromoteExactNameMatchesArgs {
  st: ContextBuilderState;
  symbolsFromQuery: readonly string[];
  exactMatches: SearchResult[];
  opts: Required<FindRelevantContextOptions>;
}

/**
 * Exact whole-word name promotion (FRICTION-AF). When a query token is
 * LITERALLY an indexed symbol name AND that name is specific (resolves
 * to at most {@link EXACT_NAME_PROMOTION_MAX_HITS} symbols), promote
 * those symbols with a high base score so the symbol the user named
 * survives the 3-seed budget.
 *
 * Caught 2026-05-15: "how does the sync method decide which files to
 * re-index" whiffed — the `sync` method was found by the exact-name
 * channel but out-ranked by FTS hits on the query's other tokens
 * (`*Extractor` / `*Index` symbols) and sliced out of the seed set.
 * Generic-name tokens (`extract` → ~20 `extract` methods) overflow the
 * hit cap and are skipped so the promotion doesn't flood the seeds.
 *
 * Generalises {@link cbPromoteMcpToolMatches}: that promotes canonical
 * `cartograph_X` tokens; this promotes any sufficiently-specific bare
 * identifier the query names outright.
 */
function cbPromoteExactNameMatches({
  st,
  symbolsFromQuery,
  exactMatches,
  opts,
}: CbPromoteExactNameMatchesArgs): SearchResult[] {
  const kinds = pickKindFilter(opts.nodeKinds);
  // B16 (2026-05-23) — index by node.id so per-hit lookup is O(1)
  // instead of `exactMatches.find(...)` per iteration (which was
  // O(n²) over the growing array on queries that hit many
  // promotable symbols). Seed from any existing entries on the
  // accumulator so a caller passing pre-populated `exactMatches`
  // doesn't re-add or re-score the same id.
  const byId = new Map<string, SearchResult>();
  for (const e of exactMatches) byId.set(e.node.id, e);
  for (const token of symbolsFromQuery) {
    let hits: SearchResult[];
    try {
      hits = findNodesByExactName(
        st.queries,
        [token],
        compact({
          kinds,
          // Probe one past the cap so an over-shared (generic) name is
          // detectable by `hits.length > MAX_HITS`.
          limit: EXACT_NAME_PROMOTION_MAX_HITS + 1,
        }),
      );
    } catch (error) {
      logDebug('Exact-name promotion lookup failed', { token, error: String(error) });
      continue;
    }
    if (hits.length === 0 || hits.length > EXACT_NAME_PROMOTION_MAX_HITS) continue;
    // `findNodesByExactName` already matches on `name COLLATE NOCASE`,
    // so this re-check is a defensive guard against future drift in
    // that query — not a live correctness dependency.
    const lowered = token.toLowerCase();
    for (const h of hits) {
      if (h.node.name.toLowerCase() !== lowered) continue;
      const existing = byId.get(h.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, EXACT_NAME_PROMOTION_SCORE);
      } else {
        const entry = { node: h.node, score: EXACT_NAME_PROMOTION_SCORE };
        byId.set(h.node.id, entry);
        exactMatches.push(entry);
      }
    }
  }
  return exactMatches;
}

function cbRunExactSymbolSearch(
  st: ContextBuilderState,
  symbolsFromQuery: string[],
  opts: Required<FindRelevantContextOptions>,
): SearchResult[] {
  if (symbolsFromQuery.length === 0) return [];
  let exactMatches: SearchResult[] = [];
  try {
    const kinds = pickKindFilter(opts.nodeKinds);
    exactMatches = findNodesByExactName(
      st.queries,
      symbolsFromQuery,
      compact({
        limit: Math.ceil(opts.searchLimit * EXACT_FETCH_MULT),
        kinds,
      }),
    );
    if (exactMatches.length > 1) {
      exactMatches = cbApplyColocationBoost(exactMatches);
    }
    exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * EXACT_TRIM_MULT));
    logDebug('Exact symbol matches', { count: exactMatches.length });
  } catch (error) {
    logDebug('Exact symbol lookup failed', { error: String(error) });
  }
  return exactMatches;
}

interface PrefixDefScope {
  definitionKinds: NodeKind[];
  exactMatches: SearchResult[];
  opts: Required<FindRelevantContextOptions>;
}

/** Score and append prefix-matching definitions for one symbol. */
function cbAppendPrefixMatchesForSymbol(st: ContextBuilderState, sym: string, scope: PrefixDefScope): void {
  const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
  if (titleCased === sym) return;
  const prefixResults = searchNodes(st.queries, titleCased, { limit: PREFIX_FTS_LIMIT, kinds: scope.definitionKinds });
  const matched: SearchResult[] = [];
  for (const r of prefixResults) {
    if (!r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) continue;
    const brevityBonus = Math.max(
      0,
      PREFIX_BREVITY_CEIL - (r.node.name.length - titleCased.length) / PREFIX_BREVITY_DIVISOR,
    );
    matched.push({ ...r, score: r.score + PREFIX_BASE_BONUS + brevityBonus });
  }
  matched.sort((a, b) => b.score - a.score);
  for (const r of matched.slice(0, Math.ceil(scope.opts.searchLimit))) {
    if (!scope.exactMatches.some((e) => e.node.id === r.node.id)) scope.exactMatches.push(r);
  }
}

/**
 * Channel 2: title-cased prefix scan over class/interface-like definitions.
 * Stem variants (`caching → cache`) widen the net.
 */
function cbAppendPrefixDefinitionMatches(st: ContextBuilderState, args: PrefixMatchArgs): SearchResult[] {
  const { symbolsFromQuery, exactMatches, opts } = args;
  if (symbolsFromQuery.length === 0) return exactMatches;
  const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait', 'protocol', 'enum', 'type_alias'];
  const expandedSymbols = new Set(symbolsFromQuery);
  for (const sym of symbolsFromQuery) {
    for (const variant of getStemVariants(sym)) expandedSymbols.add(variant);
  }
  const scope: PrefixDefScope = { definitionKinds, exactMatches, opts };
  for (const sym of expandedSymbols) {
    cbAppendPrefixMatchesForSymbol(st, sym, scope);
  }
  exactMatches.sort((a, b) => b.score - a.score);
  return exactMatches.slice(0, Math.ceil(opts.searchLimit * PREFIX_TRIM_MULT));
}

/** Per-term FTS pass: accumulates term hits and dampens saturated-term scores. */
function cbCollectTermResultsAcross(
  st: ContextBuilderState,
  p: TextSearchParams,
): Map<string, { result: SearchResult; termHits: number }> {
  const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
  for (const term of p.searchTerms) {
    const termResults = searchNodes(st.queries, term, { limit: p.fetchLimit, kinds: p.searchKinds });
    const weight = 1 - TEXT_SEARCH_DAMPEN_RATE * (termResults.length / p.fetchLimit);
    accumulateTermResults(termResultsMap, termResults, weight);
  }
  return termResultsMap;
}

/** Channel 3: term-by-term FTS scan with multi-term boost. */
function cbRunMultiTermTextSearch(
  st: ContextBuilderState,
  query: string,
  opts: Required<FindRelevantContextOptions>,
): SearchResult[] {
  let textResults: SearchResult[] = [];
  try {
    const searchTerms = extractSearchTerms(query);
    if (searchTerms.length === 0) {
      logDebug('Text search results', { count: 0 });
      return textResults;
    }
    const searchKinds = pickSearchKinds(opts.nodeKinds);
    const fetchLimit = opts.searchLimit * TEXT_FETCH_MULT;
    const termResultsMap = cbCollectTermResultsAcross(st, { searchTerms, searchKinds, fetchLimit });
    textResults = Array.from(termResultsMap.values())
      .map(({ result, termHits }) => ({ ...result, score: result.score + (termHits - 1) * TEXT_MULTI_TERM_BONUS }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.searchLimit * TEXT_TRIM_MULT);
    logDebug('Text search results', { count: textResults.length });
  } catch (error) {
    logDebug('Text search failed', { query, error: String(error) });
  }
  return textResults;
}

/** Args bundle for {@link cbBoostMultiTermCoOccurrence}. */
interface CbBoostMultiTermCoOccurrenceArgs {
  searchResults: SearchResult[];
  query: string;
  exactMatches: SearchResult[];
  extraIds: ReadonlySet<string>;
}

/** Multi-term co-occurrence re-ranking with stem-variant grouping. */
function cbBoostMultiTermCoOccurrence(args: CbBoostMultiTermCoOccurrenceArgs): void {
  const { searchResults, query, exactMatches, extraIds } = args;
  const queryTerms = extractSearchTerms(query);
  if (queryTerms.length < 2) return;
  const termGroups = groupSubstringStemVariants(queryTerms);
  const exactMatchIds = new Set(exactMatches.map((r) => r.node.id));
  for (const result of searchResults) {
    applyMultiTermBoost({
      result,
      matchCount: countTermGroupMatches(result.node, termGroups),
      exactMatchIds,
      extraIds,
    });
  }
  searchResults.sort((a, b) => b.score - a.score);
}

/** Step 5b: per-term LIKE scan + CamelCase/acronym-boundary filter. Mutates acc in place. */
function cbScanOneCamelTerm(ctx: ScoringContext, sym: string, acc: CamelTermAcc): void {
  const { st, query, isTestQuery, definitionKinds, searchIdSet } = ctx;
  const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
  if (titleCased.length < MIN_TITLECASED_LENGTH) return;
  const termKey = titleCased.toLowerCase();
  if (acc.searched.has(termKey)) return;
  acc.searched.add(termKey);
  const likeResults = findNodesByNameSubstring(st.queries, titleCased, {
    limit: MAX_LIKE_RESULTS,
    kinds: definitionKinds,
    excludePrefix: true,
  });
  const termCandidates = collectCamelTermCandidates(likeResults, titleCased, { query, isTestQuery, searchIdSet });
  termCandidates.sort((a, b) => b.score - a.score);
  for (const r of termCandidates.slice(0, acc.accumPerTerm)) {
    const existing = acc.nodeTerms.get(r.node.id);
    if (existing) existing.termCount++;
    else acc.nodeTerms.set(r.node.id, { result: r, termCount: 1 });
  }
}

/** Steps 5b: CamelCase-boundary matching. Mutates `ctx.searchResults` in place. */
function cbAppendCamelCaseMatches(ctx: ScoringContext): void {
  const { searchResults, symbolsFromQuery, opts, searchIdSet } = ctx;
  const maxCamelPerTerm = Math.ceil(opts.searchLimit / CAMEL_PER_TERM_DIVISOR);
  const camelAcc: CamelTermAcc = {
    searched: new Set<string>(),
    nodeTerms: new Map<string, { result: SearchResult; termCount: number }>(),
    accumPerTerm: maxCamelPerTerm * CAMEL_ACCUM_MULTIPLIER,
  };
  for (const sym of symbolsFromQuery) cbScanOneCamelTerm(ctx, sym, camelAcc);
  const camelResults: SearchResult[] = [];
  for (const [, info] of camelAcc.nodeTerms) {
    info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * CAMEL_MULTI_TERM_BONUS;
    camelResults.push(info.result);
  }
  camelResults.sort((a, b) => b.score - a.score);
  for (const r of camelResults.slice(0, opts.searchLimit)) {
    searchResults.push(r);
    searchIdSet.add(r.node.id);
  }
}

/** Per-term LIKE scan for one symbol: merge hits into compound-term map. */
function cbAccumulateCompoundTerm(
  ctx: ScoringContext,
  sym: string,
  compoundTermMap: Map<string, { node: Node; terms: Set<string> }>,
): void {
  const { st, isTestQuery, definitionKinds, searchIdSet } = ctx;
  const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
  if (titleCased.length < MIN_TITLECASED_LENGTH) return;
  const likeResults = findNodesByNameSubstring(st.queries, titleCased, {
    limit: MAX_LIKE_RESULTS,
    kinds: definitionKinds,
    excludePrefix: false,
  });
  for (const r of likeResults) {
    if (searchIdSet.has(r.node.id)) continue;
    if (isDiagnosticPath(r.node.filePath) && !isTestQuery) continue;
    const entry = compoundTermMap.get(r.node.id);
    if (entry) entry.terms.add(titleCased);
    else compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
  }
}

/** Step 5c: compound-term matching (≥2 query terms at any position). */
function cbAppendCompoundMatches(ctx: ScoringContext): void {
  const { searchResults, symbolsFromQuery, query, opts, searchIdSet } = ctx;
  const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
  for (const sym of symbolsFromQuery) cbAccumulateCompoundTerm(ctx, sym, compoundTermMap);
  const compoundResults: SearchResult[] = [];
  for (const [, entry] of compoundTermMap) {
    if (entry.terms.size < 2) continue;
    const pathScore = scorePathRelevance(entry.node.filePath, query);
    const brevityBonus = Math.max(0, BREVITY_BONUS_BASE - entry.node.name.length / COMPOUND_BREVITY_DIVISOR);
    compoundResults.push({
      node: entry.node,
      score: COMPOUND_BASE_SCORE + (entry.terms.size - 1) * COMPOUND_PER_TERM_BONUS + pathScore + brevityBonus,
    });
  }
  compoundResults.sort((a, b) => b.score - a.score);
  const maxCompound = Math.ceil(opts.searchLimit / CAMEL_PER_TERM_DIVISOR);
  for (const r of compoundResults.slice(0, maxCompound)) {
    searchResults.push(r);
    searchIdSet.add(r.node.id);
  }
}

/** Steps 5b + 5c: CamelCase-boundary and compound-term matching. Mutates `searchResults` in place. */
function cbAppendCamelCaseAndCompoundMatches(st: ContextBuilderState, args: CamelMatchArgs): void {
  const { searchResults, symbolsFromQuery, query, isTestQuery, opts } = args;
  if (symbolsFromQuery.length === 0) return;
  const ctx: ScoringContext = {
    st,
    searchResults,
    symbolsFromQuery,
    query,
    isTestQuery,
    opts,
    definitionKinds: ['class', 'interface', 'struct', 'trait', 'protocol', 'enum', 'type_alias'],
    searchIdSet: new Set(searchResults.map((r) => r.node.id)),
  };
  cbAppendCamelCaseMatches(ctx);
  if (symbolsFromQuery.length >= 2) cbAppendCompoundMatches(ctx);
}

/**
 * Phase 1 of `findRelevantContext`: hybrid retrieval (exact + prefix-def +
 * multi-term text + CamelCase + compound) followed by scoring, filtering,
 * import resolution, and the entry-point cap.
 */
function cbCollectAndScoreCandidates(st: ContextBuilderState, qargs: CandidateQueryArgs): SearchResult[] {
  const { query, opts, isTestQuery, trace } = qargs;
  const symbolsFromQuery = extractSymbolsFromQuery(query);
  logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

  let exactMatches = cbRunExactSymbolSearch(st, symbolsFromQuery, opts);
  exactMatches = cbAppendPrefixDefinitionMatches(st, { symbolsFromQuery, exactMatches, opts });
  // MCP tool-name promotion: when the query mentions a canonical
  // `cartograph_X` token, the user almost always wants the registered
  // XXX_TOOL constant (and its dispatcher) at the top of the entry
  // points. The standard FTS path finds them but they get drowned by
  // unrelated symbols matching `name`/`content`/`sql` etc. tokens
  // also in the query. Promote with a high base score to lock the
  // top slots.
  exactMatches = cbPromoteMcpToolMatches(st, symbolsFromQuery, exactMatches);
  // Exact whole-word name promotion: a query token that is literally a
  // specific indexed symbol name should anchor the seed set rather than
  // lose it to FTS hits on the query's other tokens (FRICTION-AF).
  exactMatches = cbPromoteExactNameMatches({ st, symbolsFromQuery, exactMatches, opts });
  const textResults = cbRunMultiTermTextSearch(st, query, opts);
  let searchResults = mergeSearchChannels(exactMatches, textResults);
  // `explain` instrumentation: snapshot scores at each pass boundary.
  // Purely observational — every `trace?.snapshot` is a no-op unless
  // the caller opted into `explain: true`.
  trace?.snapshot('lexical-merge', searchResults);

  // Approach (a): when the MCP layer detected a behaviour-shaped task
  // (`how/when/why does X happen`), it pre-runs the same hybrid FTS +
  // semantic retriever `cartograph_ask` uses and forwards the hits as
  // `extraCandidates`. Merge them into the lexical pool BEFORE the
  // co-occurrence / camel-case / centrality passes so the rest of the
  // ranking still applies. Closes the friction caught 2026-05-14:
  // structural retrieval surfaced WatcherStats/State but missed the
  // gating function `watcherHandleFileEvent`. The semantic pool that
  // ask uses contains it; merging it in lets context surface it too.
  searchResults = cbMergeExtraCandidates(searchResults, opts.extraCandidates);
  trace?.snapshot('semantic-extras', searchResults);
  const extraIds: ReadonlySet<string> = new Set((opts.extraCandidates ?? []).map((e) => e.node.id));

  if (!isTestQuery) {
    for (const result of searchResults) {
      if (isDiagnosticPath(result.node.filePath)) result.score *= TEST_FILE_PENALTY;
    }
    trace?.snapshot('test-penalty', searchResults);
  }
  cbBoostMultiTermCoOccurrence({ searchResults, query, exactMatches, extraIds });
  trace?.snapshot('co-occurrence', searchResults);
  cbAppendCamelCaseAndCompoundMatches(st, { searchResults, symbolsFromQuery, query, isTestQuery, opts });
  trace?.snapshot('camel-compound', searchResults);

  applyCentralityBoost(searchResults, CENTRALITY_BOOST_WEIGHT);
  trace?.snapshot('centrality', searchResults);
  if (opts.behaviorBias) {
    applyBehaviorBias(searchResults);
    trace?.snapshot('behavior-bias', searchResults);
  }
  searchResults.sort((a, b) => b.score - a.score);
  searchResults = searchResults.slice(0, opts.searchLimit * MERGED_TRIM_MULT);

  let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);
  filteredResults = cbResolveImportsToDefinitions(st, filteredResults);
  if (filteredResults.length > opts.searchLimit) filteredResults = filteredResults.slice(0, opts.searchLimit);
  filteredResults = cbEnsureTopExtraRoots(filteredResults, opts.extraCandidates, opts.searchLimit);
  trace?.snapshot('final-roots', filteredResults);
  return filteredResults;
}

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private readonly projectRoot: string;
  private readonly queries: QueryBuilder;
  private readonly traverser: GraphTraverser;

  constructor(projectRoot: string, queries: QueryBuilder, traverser: GraphTraverser) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  /** Snapshot of the builder's immutable dependencies for module-scope helpers. */
  private state(): ContextBuilderState {
    return { projectRoot: this.projectRoot, queries: this.queries, traverser: this.traverser };
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(input: TaskInput, options: BuildContextOptions = {}): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };
    const query = stringifyTaskInput(input);

    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
      extraCandidates: opts.extraCandidates,
      behaviorBias: opts.behaviorBias,
      explain: opts.explain,
    });

    const entryPoints = cbGetEntryPoints(subgraph);
    const codeBlocks = opts.includeCode
      ? await cbExtractCodeBlocks(this.state(), subgraph, {
          maxBlocks: opts.maxCodeBlocks,
          maxBlockSize: opts.maxCodeBlockSize,
        })
      : [];
    const relatedFiles = cbGetRelatedFiles(subgraph);
    const summary = cbGenerateSummary(query, subgraph, entryPoints);
    const context = cbAssembleTaskContext({ query, subgraph, entryPoints, codeBlocks, relatedFiles, summary });

    if (opts.format === 'markdown') return formatContextAsMarkdown(context);
    if (opts.format === 'json') return formatContextAsJson(context);
    return context;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(query: string, options: FindRelevantContextOptions = {}): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };
    // Bound user-supplied limits — `searchLimit` is multiplied by 5 in
    // findNodesByExactName, so an unbounded request would pull millions
    // of rows before any filtering. The named ceilings are well above
    // the largest legitimate use we've seen.
    opts.searchLimit = Math.min(Math.max(1, opts.searchLimit), MAX_SEARCH_LIMIT);
    opts.maxNodes = Math.min(Math.max(1, opts.maxNodes), MAX_NODES);
    opts.traversalDepth = Math.min(Math.max(0, opts.traversalDepth), MAX_TRAVERSAL_DEPTH);

    if (!query || query.trim().length === 0) {
      return { nodes: new Map<string, Node>(), edges: [], roots: [] };
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
    const st = this.state();
    const trace = opts.explain ? new ScoreTrace() : undefined;
    const filteredResults = cbCollectAndScoreCandidates(st, { query, opts, isTestQuery, trace });

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Type-hierarchy expansion: ensure subclasses and superclasses of
    // class/interface entry points appear in results, bounded by
    // maxNodes/4 to avoid flooding.
    cbExpandTypeHierarchy(st, { filteredResults, nodes, edges, roots, maxNodes: opts.maxNodes });
    cbExpandViaTraversal(st, filteredResults, { nodes, edges, opts });
    const subgraph = cbFinaliseSubgraph(st, { nodes, edges, roots, maxNodes: opts.maxNodes, isTestQuery });
    if (trace) subgraph.scoreTrace = trace.finalize(query, filteredResults);
    return subgraph;
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return cbExtractNodeCode(this.state(), node);
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter.js';
