/**
 * Search Query Utilities
 *
 * Shared module for search term extraction and scoring.
 */

import * as path from 'node:path';
import type { Node } from '../types.js';
import { isDiagnosticPath } from '../path-class.js';

/**
 * Common stop words to filter from search queries.
 * Includes generic English + code-specific noise words.
 */
export const STOP_WORDS = new Set([
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'it',
  'that',
  'this',
  'are',
  'was',
  'be',
  'has',
  'had',
  'have',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'not',
  'no',
  'all',
  'each',
  'every',
  'how',
  'what',
  'where',
  'when',
  'who',
  'which',
  'why',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'they',
  'show',
  'give',
  'tell',
  'been',
  'done',
  'made',
  'used',
  'using',
  'work',
  'works',
  'found',
  'also',
  'into',
  'then',
  'than',
  'just',
  'more',
  'some',
  'such',
  'over',
  'only',
  'out',
  'its',
  'so',
  'up',
  'as',
  'if',
  'look',
  'need',
  'needs',
  'want',
  'happen',
  'happens',
  'affect',
  'affected',
  'break',
  'breaks',
  'failing',
  'implemented',
  'implement',
  // Code-specific noise (avoid filtering common symbol names like get/set/add/build/find/list)
  'code',
  'file',
  'files',
  'function',
  'method',
  'class',
  'type',
  'fix',
  'bug',
  'called',
]);

/**
 * Drop {@link STOP_WORDS} from a list of query terms. Returns the
 * original list if every term is a stopword (so a degenerate input like
 * `["the"]` still returns something rather than producing an empty
 * downstream FTS query).
 */
export function filterStopwords(terms: string[]): string[] {
  const filtered = terms.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  return filtered.length > 0 ? filtered : terms;
}

/**
 * Minimum stem length to surface as a FTS prefix-match candidate.
 * Below this we'd over-match (e.g. `i*` would explode in size), so
 * shorter stems are dropped at the end.
 */
const MIN_STEM_LENGTH = 3;
/** Tokens shorter than this are dropped from search-term extraction
 *  (compound, snake-case, and plain-word splits all share the cap).
 *  Distinct from `MIN_STEM_LENGTH` (FTS prefix-stem floor) — happens
 *  to share the value, but governs a different stage. */
const MIN_TOKEN_LENGTH = 3;

/** A stemming rule: drop `suffix`, accept inputs of at least `minTermLength` chars. */
interface StemRule {
  /** English suffix this rule matches (lowercase). */
  suffix: string;
  /** Minimum input-term length for this rule to fire. Prevents over-stripping (e.g. -er on "her"). */
  minTermLength: number;
  /** Optional secondary suffix that disqualifies the match (e.g. -s rule excludes -ss). */
  notSuffix?: string;
  /**
   * Custom expansion: receives the lowercased input term, returns
   * variant strings to add. When omitted, the default expansion
   * `term.slice(0, -suffix.length)` is added.
   */
  expand?: (term: string, base: string) => string[];
}

/**
 * Independent stemming rules — each fires whenever its suffix
 * matches, regardless of whether other rules in this list also
 * fire. Use `PLURAL_RULES` below for the mutually-exclusive
 * `-ies`/`-es`/`-s` family.
 */
const STEM_RULES: ReadonlyArray<StemRule> = [
  // caching → cach / cache, handling → handl / handle, running → run
  {
    suffix: 'ing',
    minTermLength: 6,
    expand: (_term, base) => doubledTailVariants(base, [base, base + 'e']),
  },
  // eviction → evict, expression → express (also catches the rare -sion alternative)
  { suffix: 'tion', minTermLength: 6 },
  { suffix: 'sion', minTermLength: 6 },
  // management → manage
  { suffix: 'ment', minTermLength: 7 },
  // handled → handle, propagated → propagate, carried → carry; -eed excluded
  {
    suffix: 'ed',
    minTermLength: 5,
    notSuffix: 'eed',
    expand: (term) => {
      const variants = [term.slice(0, -1), term.slice(0, -2)];
      if (term.endsWith('ied') && term.length > 5) {
        variants.push(term.slice(0, -3) + 'y');
      }
      return variants;
    },
  },
  // builder → build / builde, handler → handl / handle, getter → get
  {
    suffix: 'er',
    minTermLength: 5,
    expand: (_term, base) => doubledTailVariants(base, [base, base + 'e']),
  },
];

/**
 * Plural-stripping priority chain: at most ONE of these fires per
 * input term. Order matters — `-ies` is checked first (so `entries`
 * doesn't get caught by the `-es` rule and stripped to `entri`),
 * then `-es`, then bare `-s`.
 */
const PLURAL_RULES: ReadonlyArray<StemRule> = [
  // entries → entry
  { suffix: 'ies', minTermLength: 5, expand: (term) => [term.slice(0, -3) + 'y'] },
  // processes → process, classes → class
  { suffix: 'es', minTermLength: 5 },
  // errors → error; -ss endings like "class" are excluded
  { suffix: 's', minTermLength: 5, notSuffix: 'ss' },
];

/**
 * For verbs like `running` / `handler` the suffix-stripped base ends
 * in a doubled consonant (`runn`, `handl`). Add a single-consonant
 * variant alongside the literal-stripped form so FTS catches both.
 */
function doubledTailVariants(base: string, variants: string[]): string[] {
  if (base.length >= 2 && base.at(-1) === base.at(-2)) {
    return [...variants, base.slice(0, -1)];
  }
  return variants;
}

/**
 * Generate stem variants of a search term by removing common English suffixes.
 * Used for FTS query expansion so "caching" also finds "cache", "eviction" finds "evict", etc.
 * Stems are used as PREFIX matches in FTS, so they don't need to be perfect English words.
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  for (const rule of STEM_RULES) applyStemRule(t, rule, variants);

  // Plural family: first match wins.
  for (const rule of PLURAL_RULES) {
    if (applyStemRule(t, rule, variants)) break;
  }

  return [...variants].filter((v) => v.length >= MIN_STEM_LENGTH && v !== t);
}

/** Try one rule against `term`; on match, push variants into `out` and return true. */
function applyStemRule(term: string, rule: StemRule, out: Set<string>): boolean {
  if (!matchesStemRule(term, rule)) return false;
  const base = term.slice(0, -rule.suffix.length);
  if (rule.expand) {
    for (const v of rule.expand(term, base)) out.add(v);
  } else {
    out.add(base);
  }
  return true;
}

function matchesStemRule(term: string, rule: StemRule): boolean {
  if (term.length < rule.minTermLength) return false;
  if (!term.endsWith(rule.suffix)) return false;
  if (rule.notSuffix && term.endsWith(rule.notSuffix)) return false;
  return true;
}

/**
 * Extract meaningful search terms from a natural language query.
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dot.notation
 * into individual tokens before filtering.
 *
 * Preserves original compound identifiers (e.g., "scrapeLoop") alongside
 * their split parts so that FTS can match both the full symbol name and
 * individual words within it.
 *
 * Also generates stem variants (e.g., "caching"→"cache", "eviction"→"evict")
 * so FTS prefix matching can find related code symbols.
 */
/**
 * Add lowercased compound identifiers (CamelCase, snake_case) from
 * `query` to `tokens`, preserving the full compound shape so FTS can
 * match the symbol's exact name as well as its split words.
 */
function harvestCompoundIdentifiers(query: string, tokens: Set<string>): void {
  for (const identifier of scanAsciiIdentifiers(query)) {
    if (identifier.length < MIN_TOKEN_LENGTH) continue;
    if (isCamelOrPascalCompound(identifier) || isSnakeCompound(identifier)) {
      tokens.add(identifier.toLowerCase());
    }
  }
}

function scanAsciiIdentifiers(value: string): string[] {
  const identifiers: string[] = [];
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (start === -1) {
      if (isAsciiLetter(char) && !isIdentifierBodyChar(value[i - 1])) start = i;
      continue;
    }
    if (isIdentifierBodyChar(char)) continue;
    identifiers.push(value.slice(start, i));
    start = -1;
  }
  if (start !== -1) identifiers.push(value.slice(start));
  return identifiers;
}

function isIdentifierBodyChar(char: string | undefined): boolean {
  if (!char) return false;
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '_';
}

function isAsciiLetter(char: string): boolean {
  return isLowerAscii(char) || isUpperAscii(char);
}

function isSnakeCompound(identifier: string): boolean {
  if (!identifier.includes('_')) return false;
  const parts = identifier.split('_');
  return parts.length > 1 && parts.every((part) => part.length > 0);
}

function isCamelOrPascalCompound(identifier: string): boolean {
  if (identifier.includes('_')) return false;
  for (let i = 1; i < identifier.length; i++) {
    if (isLowerAscii(identifier[i - 1]!) && isUpperAscii(identifier[i]!)) return true;
  }
  for (let i = 1; i < identifier.length - 1; i++) {
    if (isUpperAscii(identifier[i]!) && isLowerAscii(identifier[i + 1]!) && hasPriorUpperOrDigit(identifier, i)) {
      return true;
    }
  }
  return false;
}

function hasPriorUpperOrDigit(value: string, endExclusive: number): boolean {
  for (let i = 0; i < endExclusive; i++) {
    if (isUpperAscii(value[i]!) || isAsciiDigit(value[i]!)) return true;
  }
  return false;
}

function isLowerAscii(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isUpperAscii(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();

  harvestCompoundIdentifiers(query, tokens);

  // Split camelCase / PascalCase: "getUserName" → "get User Name"
  // Then replace underscores/dots with spaces (snake_case, dot.notation)
  // and split on any non-alphanumeric character.
  const normalised = query
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replaceAll(/[_.]+/g, ' ');
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // Generate stem variants for broader FTS matching.
  // "caching" → "cache" finds CacheBuilder; "eviction" → "evict" finds evictEntries.
  // Also enables co-occurrence dampening by increasing term count above 1.
  // Stems are skipped when scoring path relevance (stems inflate path scores).
  if (includeStems) {
    for (const stem of computeNonShadowingStems(tokens)) tokens.add(stem);
  }

  return [...tokens];
}

/** Build the set of stem variants for `tokens` that aren't already in
 *  `tokens` and aren't stop-words. Pulled out so the stems block in
 *  {@link extractSearchTerms} stays at depth 1 instead of nesting
 *  `if/for/for/if` four levels deep. */
function computeNonShadowingStems(tokens: ReadonlySet<string>): Set<string> {
  const stems = new Set<string>();
  for (const token of tokens) {
    for (const variant of getStemVariants(token)) {
      if (tokens.has(variant)) continue;
      if (STOP_WORDS.has(variant)) continue;
      stems.add(variant);
    }
  }
  return stems;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function projectNameNoiseTokens(projectRoot: string): string[] {
  const base = path.basename(projectRoot).toLowerCase();
  const tokens = base.split(/[^a-z0-9]+/).filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

/**
 * Drop a standalone project-name token from broad natural-language
 * ranking queries when enough other anchors remain.
 *
 * A repo/product name is often present because the user names the
 * project ("in cartograph, how does sync work?"). Treating that word
 * as a normal FTS term can over-promote unrelated symbols whose name
 * happens to carry the project name. The guard is conservative:
 * stripping happens only when at least two non-project search terms
 * remain, so focused queries like "Cartograph class" keep their
 * literal anchor.
 */
export function suppressProjectNameQueryNoise(query: string, projectRoot: string): string {
  const noiseTokens = projectNameNoiseTokens(projectRoot);
  if (noiseTokens.length === 0) return query;

  const terms = extractSearchTerms(query, { stems: false });
  const noise = new Set(noiseTokens);
  const nonNoiseTerms = terms.filter((term) => !noise.has(term));
  if (nonNoiseTerms.length < 2) return query;

  let cleaned = query;
  for (const token of noiseTokens) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}(?=$|[^A-Za-z0-9_])`, 'gi');
    cleaned = cleaned.replaceAll(pattern, '$1');
  }
  cleaned = cleaned.replaceAll(/\s+/g, ' ').trim();
  return cleaned || query;
}

/**
 * Heuristic: query looks like a route / endpoint path.
 * E.g. "/api/generate", "/v1/users", "GET /healthz".
 * For these queries, the user is almost always trying to find the
 * handler that REGISTERS the route, not test functions whose name
 * happens to share tokens with the path.
 */
export function isRouteShapedQuery(query: string): boolean {
  // Slash-anchored: "/api/...", "/v1/...", "/healthz". The leading
  // boundary is either start-of-string or whitespace — the HTTP-method
  // form is handled by the second regex below.
  if (/(^|\s)\/[a-z0-9_-]+/i.test(query)) return true;
  // HTTP-method-shaped: "GET /foo", "POST /bar"
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(query)) return true;
  return false;
}

/** Directory segments that typically contain HTTP/route handler code. */
const ROUTE_HANDLER_DIRS = [
  'server',
  'servers',
  'route',
  'routes',
  'router',
  'handler',
  'handlers',
  'controller',
  'controllers',
  'api',
  'rest',
  'http',
];

// scorePathRelevance — per-term contributions when the query token
// appears at different points in the file path. Filename match is
// the strongest signal (the user usually knows what file they want);
// directory match is moderate; raw substring is the weakest hint.
const PATH_SCORE_FILENAME_MATCH = 10;
const PATH_SCORE_DIRECTORY_MATCH = 5;
const PATH_SCORE_GENERIC_PATH_MATCH = 3;

/**
 * Boost added when the query is route-shaped (e.g. `/api/generate`)
 * AND the candidate path lives in a recognised route-handler
 * directory. Without this, BM25 alone tends to surface tests whose
 * names tokenise close to URL segments.
 */
const PATH_SCORE_ROUTE_HANDLER_BOOST = 20;

// Penalties for test files when the query is NOT explicitly about
// tests. Route-shaped queries get a much heavier penalty because
// test files dominate the BM25 layer for URL-token matches.
const PATH_SCORE_TEST_PENALTY_ROUTE = 50;
const PATH_SCORE_TEST_PENALTY_DEFAULT = 15;

// nameMatchBonus — descending tiers of "the node name relates to the
// query" signal strength. Numbers are tuned so each tier dominates
// the next when ranking is otherwise tied.
const NAME_BONUS_EXACT_MATCH = 80;
const NAME_BONUS_TOKEN_EXACT_MATCH = 60;
/** Base for the prefix-match score; scaled by length-ratio (see usage). */
const NAME_BONUS_PREFIX_BASE = 10;
/** Maximum extra prefix-match score on top of {@link NAME_BONUS_PREFIX_BASE}. */
const NAME_BONUS_PREFIX_RAMP = 30;
const NAME_BONUS_ALL_TERMS_MATCH = 15;
const NAME_BONUS_SUBSTRING_MATCH = 10;

function pathHasRouteHandlerSegment(lowerPath: string): boolean {
  for (const seg of ROUTE_HANDLER_DIRS) {
    if (lowerPath.includes('/' + seg + '/') || lowerPath.startsWith(seg + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Score path relevance to a query.
 * Higher score = more relevant path.
 *
 * Path-shaped queries (e.g. `/api/generate`) get special handling: a
 * heavier test penalty and a bonus for files in `routes/`, `handlers/`,
 * `server/`, etc. — so the actual route handler outranks any test
 * function whose name happens to tokenise overlapping the URL path.
 */
export function scorePathRelevance(filePath: string, query: string): number {
  // Use base terms only — stem variants inflate path scores by generating
  // many near-duplicate terms that all match the same path segments.
  const terms = extractSearchTerms(query, { stems: false });
  if (terms.length === 0) return 0;

  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  const routeShaped = isRouteShapedQuery(query);
  let score = 0;

  for (const term of terms) {
    if (fileName.includes(term)) score += PATH_SCORE_FILENAME_MATCH;
    if (dirName.includes(term)) score += PATH_SCORE_DIRECTORY_MATCH;
    else if (pathLower.includes(term)) score += PATH_SCORE_GENERIC_PATH_MATCH;
  }

  if (routeShaped && pathHasRouteHandlerSegment(pathLower)) {
    score += PATH_SCORE_ROUTE_HANDLER_BOOST;
  }

  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  if (!isTestQuery && isDiagnosticPath(filePath)) {
    score -= routeShaped ? PATH_SCORE_TEST_PENALTY_ROUTE : PATH_SCORE_TEST_PENALTY_DEFAULT;
  }

  return score;
}

// `isTestFile` (a polyglot test/non-production path heuristic) was
// folded into the unified path classifier on 2026-05-15 — its
// language-specific filename conventions are now part of
// `path-class.ts`. `scorePathRelevance` (above) calls `isDiagnosticPath`
// directly; there is no longer a search-local copy to drift.

/**
 * Detect a package-qualified query: `lhs.Rhs` where the LHS looks like
 * a package/module name and the RHS looks like a symbol.
 *   - Go: `llm.Generate`
 *   - Python: `os.path`, `_io.BufferedReader` (underscore-prefixed
 *     internal modules are valid)
 *   - Java/Kotlin: `util.format`
 *
 * The LHS allows a leading underscore so Python's private-module
 * convention isn't silently rejected. Capitalised LHS (`Foo.Bar`) is
 * still excluded — that's typically a class.member access, not a
 * package reference, and treating it as one would over-trigger the
 * package-scope bonus on every method call.
 *
 * Returns the split, or null if the query isn't dot-qualified.
 */
export function parseDotQualified(query: string): { lhs: string; rhs: string } | null {
  if (!/^_?[a-z]\w*\.[A-Za-z]\w*$/.test(query.trim())) return null;
  const i = query.indexOf('.');
  return { lhs: query.slice(0, i), rhs: query.slice(i + 1) };
}

/** Score bonus for an exact RHS match on a node inside the LHS package. */
const DOT_QUALIFIED_EXACT_BONUS = 60;

/** Score bonus for an RHS prefix match on a node inside the LHS package. */
const DOT_QUALIFIED_PREFIX_BONUS = 30;

/** Score bonus for an RHS substring match on a node inside the LHS package. */
const DOT_QUALIFIED_CONTAINS_BONUS = 15;

/**
 * Bonus when a node belongs to the package named by the LHS of a
 * dot-qualified query AND its name matches the RHS. Lets `llm.Generate`
 * find `Generate` in `llm/`-rooted files even though FTS would
 * otherwise rank `TestGenerationLoop` (lots of token overlap) higher.
 */
export function dotQualifiedBonus(nodeName: string, filePath: string, query: string): number {
  const dq = parseDotQualified(query);
  if (!dq) return 0;
  const nameLower = nodeName.toLowerCase();
  const pathLower = filePath.toLowerCase();
  const rhsLower = dq.rhs.toLowerCase();
  const lhsLower = dq.lhs.toLowerCase();
  const inPackage = pathLower.includes('/' + lhsLower + '/') || pathLower.startsWith(lhsLower + '/');
  if (!inPackage) return 0;
  if (nameLower === rhsLower) return DOT_QUALIFIED_EXACT_BONUS;
  if (nameLower.startsWith(rhsLower)) return DOT_QUALIFIED_PREFIX_BONUS;
  if (nameLower.includes(rhsLower)) return DOT_QUALIFIED_CONTAINS_BONUS;
  return 0;
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replaceAll(/\s+/g, '').toLowerCase();

  if (nameLower === queryLower) return NAME_BONUS_EXACT_MATCH;

  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return NAME_BONUS_TOKEN_EXACT_MATCH;

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(NAME_BONUS_PREFIX_BASE + NAME_BONUS_PREFIX_RAMP * ratio);
  }

  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every((t) => nameLower.includes(t));
    if (allMatch) return NAME_BONUS_ALL_TERMS_MATCH;
  }

  if (nameLower.includes(queryLower)) return NAME_BONUS_SUBSTRING_MATCH;

  return 0;
}

/**
 * Kind-based bonus for search ranking. Hand-tuned tiers — the
 * intent (not the absolute number) is what matters; the relative
 * ordering controls how a multi-kind result list shakes out:
 *
 *   10 — top: callable code (function / method)
 *    9 — protocol-shaped definitions (interface / trait / protocol /
 *        route — agent searches for them by name as much as for code)
 *    8 — concrete types likely to anchor a domain (class / component)
 *    6 — alias-shaped types (type_alias / struct)
 *    5 — enum
 *    4 — top-level groupings (module / namespace)
 *    3 — members + constants (property / field / constant / enum_member)
 *    2 — variable
 *    1 — import / export (mostly noise; surfaces only on direct hits)
 *    0 — parameter / file (always rendered as containers, not targets)
 *
 * Hoisted to module scope so we don't rebuild it per call.
 */
const KIND_BONUS: Readonly<Record<string, number>> = {
  function: 10,
  method: 10,
  class: 8,
  interface: 9,
  type_alias: 6,
  struct: 6,
  trait: 9,
  enum: 5,
  component: 8,
  route: 9,
  module: 4,
  property: 3,
  field: 3,
  variable: 2,
  constant: 3,
  import: 1,
  export: 1,
  parameter: 0,
  namespace: 4,
  file: 0,
  protocol: 9,
  enum_member: 3,
};

export function kindBonus(kind: Node['kind']): number {
  return KIND_BONUS[kind] ?? 0;
}

/**
 * Cap consecutive results from the same file. Preserves overall ranking:
 * the highest-scoring hit from each file is taken first (up to `perFileCap`
 * per file), in score order. If `limit` isn't filled after the capped
 * pass, the remaining slots are filled with the next-best hits regardless
 * of file (preserves correctness — never hides a hit that would have
 * otherwise been returned).
 *
 * Why: queries like `"ExtractionOrchestrator"` return the matching class
 * plus 9 of its members from the same file. The first hit is informative;
 * the next 9 are implementation detail that pushes peer files (subclasses,
 * callers, sibling modules) past the limit. Capping per file surfaces
 * representative breadth without losing the top hit.
 */
export function diversifyByFile<T extends { node: Node }>(results: T[], limit: number, perFileCap: number): T[] {
  if (perFileCap <= 0) return results.slice(0, limit);
  const perFile = new Map<string, number>();
  const picked: T[] = [];
  const skipped: T[] = [];
  for (const r of results) {
    const f = r.node.filePath;
    const c = perFile.get(f) ?? 0;
    if (c < perFileCap) {
      picked.push(r);
      perFile.set(f, c + 1);
      if (picked.length >= limit) return picked;
    } else {
      skipped.push(r);
    }
  }
  // Backfill from skipped (in original score order) so we don't return
  // fewer results than the caller asked for. This also handles the
  // edge case where `results.length <= limit`: nothing was actually
  // dropped, but the per-file cap reordered them so peer files appear
  // earlier — `picked` first, then any leftover same-file hits.
  for (const r of skipped) {
    if (picked.length >= limit) break;
    picked.push(r);
  }
  return picked;
}
