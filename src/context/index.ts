/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import type { Node, Edge, NodeKind } from '../types.js';
import type { Subgraph } from '../graph/types.js';
import type { SearchResult } from '../search/types.js';
import type { BuildContextOptions, FindRelevantContextOptions, TaskContext, TaskInput } from './types.js';
import { type QueryBuilder, getNodesByKind } from '../db/queries.js';
import { searchNodes, findNodesByExactName, findNodesByNameSubstring } from '../db/queries-search.js';
import type { GraphTraverser } from '../graph/index.js';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter.js';
import { logDebug } from '../errors.js';
import { compact } from '../utils.js';
import { isDiagnosticPath } from '../path-class.js';
import { ScoreTrace } from './score-trace.js';
import { extractSymbolsFromQuery } from './query-symbols.js';
import { buildTaskContext, extractCodeBlocks } from './task-context.js';
import type { ContextBuilderState } from './builder-state.js';
import { HIGH_VALUE_NODE_KINDS, normalizeBuildOptions, normalizeFindOptions, pickSearchKinds } from './options.js';
import {
  CENTRALITY_BOOST_WEIGHT,
  TEST_FILE_PENALTY,
  TEXT_MULTI_TERM_BONUS,
  TEXT_SEARCH_DAMPEN_RATE,
  accumulateTermResults,
  applyBehaviorBias,
  applyCentralityBoost,
  applyMultiTermBoost,
  colocationScore,
  countTermGroupMatches,
  groupSubstringStemVariants,
  mergeSearchChannels,
} from './scoring.js';
import { expandTypeHierarchy, expandViaTraversal, finaliseSubgraph, resolveImportsToDefinitions } from './subgraph.js';
import { extractNodeSourceCode } from './source-code.js';
import { extractSearchTerms, scorePathRelevance, getStemVariants } from '../search/query-utils.js';

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
/** Base score uplift for a prefix-class match (added on top of the FTS score). */
const PREFIX_BASE_BONUS = 15;
/** Brevity-bonus ceiling for prefix-class matches (added before the per-extra-char penalty). */
const PREFIX_BREVITY_CEIL = 10;
/** Char-length divisor in the prefix-class brevity penalty. */
const PREFIX_BREVITY_DIVISOR = 3;

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

/** Mutable accumulator passed across {@link ContextBuilder.scanOneCamelTerm} calls. */
interface CamelTermAcc {
  searched: Set<string>;
  nodeTerms: Map<string, { result: SearchResult; termCount: number }>;
  accumPerTerm: number;
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

/**
 * Re-score exact matches by co-location: symbols that share a file
 * with other matched symbols get a small boost to promote
 * "this file has several relevant symbols" results.
 */
/** Compute the co-location bonus for a result given how many distinct
 *  symbol names from the match set live in the same file. */
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
  filteredResults = resolveImportsToDefinitions(st, filteredResults);
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
    return { queries: this.queries, traverser: this.traverser };
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
    const opts = normalizeBuildOptions(options);
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

    const codeBlocks = opts.includeCode
      ? await extractCodeBlocks(
          subgraph,
          {
            maxBlocks: opts.maxCodeBlocks,
            maxBlockSize: opts.maxCodeBlockSize,
          },
          (node) => extractNodeSourceCode(this.projectRoot, node),
        )
      : [];
    const context = buildTaskContext({ query, subgraph, codeBlocks });

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
    const opts = normalizeFindOptions(options);

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
    expandTypeHierarchy(st, { filteredResults, nodes, edges, roots, maxNodes: opts.maxNodes });
    expandViaTraversal(st, filteredResults, { nodes, edges, opts });
    const subgraph = finaliseSubgraph(st, { nodes, edges, roots, maxNodes: opts.maxNodes, isTestQuery });
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

    return extractNodeSourceCode(this.projectRoot, node);
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
