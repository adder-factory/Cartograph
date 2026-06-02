/**
 * Symbol-resolution helpers shared across multiple MCP handlers.
 *
 * `findSymbol` (used by callers/callees/impact/history/node/similar
 * via execute()) and `findAllSymbols` (used when a name resolves to
 * multiple equally-valid sources) translate a user-supplied symbol
 * name into the indexed `Node`(s) the handler should operate on.
 *
 * `notFoundMessage` builds the "not found, did you mean…" body used
 * when both lookups miss; it always renders a bullet list of up to
 * 5 nearby names.
 *
 * Pure functions parameterised by `cg`. No `this` and no class state
 * — the legacy private methods on `ToolHandler` simply delegate here.
 */

import type Cartograph from '../../index.js';
import type { Node } from '../../types.js';
import { getNodesByName, searchNodes, suggestSymbolNames } from '../../db/queries-search.js';
import { getFileByPath } from '../../db/queries-files.js';
import { RefIdCache } from './_id-cache.js';
import { freshnessHintForEmptyResult, isFixturePath } from './shared.js';

/**
 * FTS candidate cap for qualified lookups (`Session.request`). Wider
 * than the plain-name cap because the target may rank lower in FTS
 * when many partial matches share the rhs token.
 */
const QUALIFIED_LOOKUP_LIMIT = 50;

/**
 * FTS candidate cap for plain-name lookups. Tight enough to keep
 * dispatch cheap while still catching homonyms.
 */
const PLAIN_LOOKUP_LIMIT = 10;

/**
 * Cap on did-you-mean suggestions surfaced to the caller. Mirrors the
 * other suggester sites; readable bullet list without overwhelming the
 * agent's context.
 */
const SUGGESTION_LIMIT = 5;

/**
 * Render limit for did-you-mean suggestions in the fuzzy-fallback
 * note. One less than the raw fetch so the matched fuzzy name itself
 * can be filtered out without losing a slot.
 */
const SUGGESTION_RENDER_LIMIT = 4;

/**
 * The set of `NodeKind` prefixes a raw node id can carry. `generateNodeId`
 * (`extraction/tree-sitter-helpers.ts`) mints ids as `${kind}:${hash}`
 * where `hash` is 32 lowercase hex chars; the cache UID for the
 * `_id-cache.ts` short-id family is the separate `n_xxxxxxxx` form.
 */
const NODE_ID_KINDS = new Set<string>([
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
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'table',
  'resource',
]);

/**
 * Detect a raw node id of the form `${kind}:${32-hex}` minted by
 * `generateNodeId`. Callers (e.g. `cartograph_note`) sometimes pass a
 * node id verbatim — extracted from a prior tool result — instead of a
 * name or an `n_` UID. Without this, such ids fall through to FTS name
 * lookup and miss, producing a spurious "symbol not found".
 */
function isRawNodeId(s: string): boolean {
  const colon = s.indexOf(':');
  if (colon <= 0) return false;
  const kind = s.slice(0, colon);
  if (!NODE_ID_KINDS.has(kind)) return false;
  return /^[0-9a-f]{32}$/.test(s.slice(colon + 1));
}

/**
 * True iff the indexed node is the symbol the caller asked for.
 * Handles three cases: simple-name match, file-basename match (for
 * tools like Liquid where a "product-card" lookup should resolve
 * `product-card.liquid`), and qualified-name match where the input
 * uses dot syntax (`Parent.child`) but the index stores `::`.
 */
function matchesSymbol(node: Node, symbol: string): boolean {
  if (node.name === symbol) return true;
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;
  if (symbol.includes('.')) {
    const parts = symbol.split('.');
    const qualifiedSuffix = parts.join('::');
    if (node.qualifiedName.includes(qualifiedSuffix)) return true;
  }
  return false;
}

/**
 * Minimum-similarity gate for "Did you mean" suggestions.
 *
 * `suggestSymbolNames` returns a `dist` per match. The edit-distance
 * tier emits a real Levenshtein distance (≤5); the containment and
 * subsequence tiers emit modest offsets; but the longest-common-
 * substring FALLBACK tier adds an offset of ~104+ (`SUGGEST_SUBSTR_OFFSET
 * == 100` in `queries-search.ts`). That last tier fires when a candidate
 * merely shares a 4-char run with the query — the source of noise like
 * `tRead` for a clearly-bogus `zzznotreal` (shared run `trea`).
 *
 * The gate drops ONLY that LCS-fallback tier (`dist >= SUGGEST_SUBSTR_GATE`),
 * keeping every edit / containment / subsequence match — so legitimate
 * radical abbreviations (`GnrtHndlr` → `GenerateHandler`, a subsequence
 * match) still surface. When nothing clears the gate the caller emits a
 * plain "not found" with no suggestion block.
 */
const SUGGEST_SUBSTR_GATE = 100;

function plausibleSuggestions(
  suggestions: ReadonlyArray<{ name: string; dist: number }>,
): Array<{ name: string; dist: number }> {
  return suggestions.filter((s) => s.dist < SUGGEST_SUBSTR_GATE);
}

/**
 * Relevance gate for the FTS top-1 *fuzzy fallback* (audit-4 #10 /
 * audit-4-group-3 #1). FTS5 token matching can return an arbitrary
 * unrelated symbol for a clearly-bogus query (`zzznotreal` →
 * `SUGGEST_SUBSTR_GATE`), and the pre-gate code accepted that row
 * verbatim — so `node zzznotreal` confidently presented a wrong
 * symbol, and `biomarkers`/`coverage`/`tests-for` reported the bogus
 * name as "healthy / 100% covered".
 *
 * The gate reuses the same `suggestSymbolNames` `dist` scale the
 * did-you-mean list already uses: run the suggester for the query and
 * accept the fuzzy candidate ONLY when its name appears among the
 * gated (`dist < SUGGEST_SUBSTR_GATE`) suggestions — i.e. it shares a
 * real edit / containment / subsequence relationship with the query,
 * not merely a coincidental 4-char run. When the candidate fails the
 * gate the caller falls through to a clean "not found + suggestions".
 *
 * A whole-string containment shortcut is kept: when the candidate's
 * lowercased name contains the query (or vice-versa) the relationship
 * is unambiguous even if the suggester's tier ordering buried it.
 */
function fuzzyCandidatePassesGate(cg: Cartograph, query: string, candidate: Node): boolean {
  const q = query.toLowerCase();
  const name = candidate.name.toLowerCase();
  if (name.includes(q) || q.includes(name)) return true;
  const gated = plausibleSuggestions(suggestSymbolNames(cg.queries, query, SUGGESTION_LIMIT));
  return gated.some((s) => s.name === candidate.name);
}

/**
 * Build a "not found" message that includes up to 5 nearby symbol
 * names so a misspelt or wrong-cased query lands somewhere actionable
 * instead of a dead end. Renders the candidates as a bullet list —
 * easier to scan than an inline comma-separated form, and matches the
 * shape an agent already sees from `search`/`node` did-you-mean. Used
 * by `callers`/`callees`/`impact` when the symbol misses entirely.
 *
 * A `plausibleSuggestions` similarity gate drops coincidence-tier
 * matches: a clearly-bogus name gets a clean "not found" with no
 * misleading suggestion list.
 */
export function notFoundMessage(cg: Cartograph, symbol: string): string {
  const suggestions = plausibleSuggestions(suggestSymbolNames(cg.queries, symbol, 5));
  if (suggestions.length === 0) {
    return `Symbol "${symbol}" not found in the codebase.`;
  }
  const lines = suggestions.map((s) => `- \`${s.name}\``).join('\n');
  return `Symbol "${symbol}" not found in the codebase. Did you mean:\n${lines}`;
}

/**
 * Canonical "symbol not found" response for MCP handlers — combines
 * `notFoundMessage` (did-you-mean bullet list) with
 * `freshnessHintForEmptyResult` (stale/in-sync index hint). Every
 * handler that surfaces "the `symbol` argument resolved to nothing"
 * should use this helper so the UX is identical across all tools.
 *
 * Do NOT use this for "no callers/results found" after a successful
 * symbol resolution — that is a different, correct case.
 */
export function symbolNotFound(cg: Cartograph, symbol: string): string {
  return notFoundMessage(cg, symbol) + freshnessHintForEmptyResult(cg);
}

/**
 * True when `symbol` is a `n_xxxxxxxx` short UID that the current
 * process's `RefIdCache` cannot resolve — a stale / evicted UID, or
 * (always) a UID minted by a different process. Such a string is NOT
 * a real symbol name: name-based lookup will miss, and the generic
 * "not found" + "true negative" footer would wrongly tell the agent
 * the symbol does not exist. Callers branch on this to emit a
 * UID-specific message instead (audit-4 #1).
 */
export function isUnresolvedUid(
  symbol: string,
  refIds: { resolve: (uid: string) => string | null } | undefined,
): boolean {
  if (!RefIdCache.isUid(symbol)) return false;
  // No cache at all, or the cache has no entry for this UID.
  return (refIds?.resolve(symbol) ?? null) === null;
}

/**
 * UID-specific "not found" message for a stale / cross-process `n_`
 * UID (audit-4 #1). Deliberately omits the `freshnessHintForEmptyResult`
 * "true negative" footer — a cache miss is not a genuine absence, and
 * that footer would mislead the agent into concluding the symbol does
 * not exist. Mirrors the analogous `since`-delta "call id is no longer
 * cached" copy.
 */
export function staleUidMessage(uid: string): string {
  return (
    `✗ UID "${uid}" is no longer cached — server restart / eviction / minted ` +
    'by another process. Re-run the query that produced it, or pass the symbol name.'
  );
}

/** Heuristic LoC ceiling below which a same-name function is treated
 *  as a thin re-export / forwarder wrapper. 4 lines covers the canonical
 *  `export function X(...) { return otherX(...); }` plus brace lines.
 *  Tunable if observed wrappers stretch longer. */
const THIN_WRAPPER_MAX_LINES = 4;

/** Kinds the thin-wrapper heuristic actually fires on. Restricted to
 *  callables — a file or class spanning ≤4 lines is a small unit of
 *  code, NOT a forwarder wrapper, and demoting it from disambiguation
 *  by elimination would mask the per-kind policy registry. */
const THIN_WRAPPER_ELIGIBLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

function isThinWrapper(node: Node): boolean {
  if (!THIN_WRAPPER_ELIGIBLE_KINDS.has(node.kind)) return false;
  const span = node.endLine - node.startLine + 1;
  return span > 0 && span <= THIN_WRAPPER_MAX_LINES;
}

/** Container kinds whose disambiguation goes through `container-by-member-count`. */
const CONTAINER_KINDS_FOR_DISAMBIGUATION: ReadonlySet<string> = new Set([
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
]);

/**
 * Per-kind disambiguation policy invoked when the same name resolves
 * to N > 1 indexed nodes that all share the same kind. Each policy
 * scores candidates; higher score wins. Ties fall through to
 * `node.centrality DESC` then `filePath ASC` (deterministic; baked
 * into `pickWithPolicy`).
 *
 * Adding a new kind-specific policy is ONE entry in
 * {@link SYMBOL_DISAMBIGUATION_POLICIES} — the dispatcher
 * {@link pickPolicyFor} matches the candidate set's homogeneous kind
 * against each policy's `applies` predicate.
 */
export interface DisambiguationPolicy {
  /** Stable identifier used in diagnostics and the disambiguation banner. */
  name: string;
  /** Human-readable description of what the policy ranks by. */
  description: string;
  /** Returns true when this policy applies to a homogeneous-kind candidate set. */
  applies: (kind: string) => boolean;
  /** Score one candidate. Higher wins; -Infinity means "won't pick". */
  score: (cg: Cartograph, node: Node) => number;
}

/**
 * Count incoming `calls` edges for a candidate symbol. Used by the
 * `callable-by-caller-count` policy to disambiguate function/method
 * homonyms — the more-called copy is the likely user target.
 */
function countCallersOf(cg: Cartograph, nodeId: string): number {
  const row = cg.queries.db
    .prepare(`SELECT COUNT(*) AS n FROM edges WHERE target = ? AND kind = 'calls'`)
    .get(nodeId) as { n?: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Count outgoing `contains` edges for a candidate symbol. Used by the
 * `container-by-member-count` policy to disambiguate class / struct /
 * interface / trait / protocol homonyms — the fuller container is the
 * likely user target (a one-method protocol is rarely what someone
 * means when they say "Resolver").
 */
function countMembersOf(cg: Cartograph, nodeId: string): number {
  const row = cg.queries.db
    .prepare(`SELECT COUNT(*) AS n FROM edges WHERE source = ? AND kind = 'contains'`)
    .get(nodeId) as { n?: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Registry of per-kind disambiguation policies. The dispatcher tries
 * each in order — the first whose `applies(kind)` returns true wins.
 *
 * Order matters insofar as a policy whose `applies` is a superset of
 * another's would mask the more specific entry; today every entry's
 * `applies` is mutually exclusive, but the registry order also drives
 * documentation-walk consumers, so keep declarative.
 */
export const SYMBOL_DISAMBIGUATION_POLICIES: ReadonlyArray<DisambiguationPolicy> = [
  {
    name: 'file-by-commit-count',
    description:
      "Files ranked by `files.commit_count` DESC — the historically busier copy is the likely target. Canonical for `cartograph_history`, where 'ambiguous file' should resolve to the high-churn copy rather than a stable-but-wrong low-churn lookalike.",
    applies: (kind) => kind === 'file',
    score: (cg, node) => getFileByPath(cg.queries, node.filePath)?.commitCount ?? 0,
  },
  {
    name: 'callable-by-caller-count',
    description:
      "Functions / methods ranked by incoming `calls` edge count DESC — the more-called copy is the likely target. Distinct from raw centrality (which factors in callers' OWN importance); a leaf function called 50 times scores higher than a hub called once. **Known limitation:** functions used only as callbacks (object-literal property values, `refine(fn)` arg etc. — `references` edges emitted by `value-ref-edges`) score 0 here and fall back to the centrality tie-break; widen to `kind IN ('calls', 'references')` if false-picks emerge in production.",
    applies: (kind) => kind === 'function' || kind === 'method',
    score: (cg, node) => countCallersOf(cg, node.id),
  },
  {
    name: 'container-by-member-count',
    description:
      'Class / struct / interface / trait / protocol ranked by outgoing `contains` edge count DESC — the fuller container is the likely target. A one-method protocol is rarely what someone means by a name shared with a 30-method class.',
    applies: (kind) => CONTAINER_KINDS_FOR_DISAMBIGUATION.has(kind),
    score: (cg, node) => countMembersOf(cg, node.id),
  },
];

/**
 * Find the first policy whose `applies(kind)` returns true for a
 * homogeneous-kind candidate set. Returns null when the candidate set
 * is mixed-kind or no policy matches — caller falls back to plain
 * centrality + path ordering.
 */
function pickPolicyFor(candidates: ReadonlyArray<{ node: Node }>): DisambiguationPolicy | null {
  if (candidates.length < 2) return null;
  const firstKind = candidates[0]!.node.kind;
  if (!candidates.every((m) => m.node.kind === firstKind)) return null;
  return SYMBOL_DISAMBIGUATION_POLICIES.find((p) => p.applies(firstKind)) ?? null;
}

/**
 * Apply the chosen policy's score + the documented tie-break cascade
 * (centrality DESC, filePath ASC). When `cg` is omitted (legacy
 * callers), or no policy applies to the candidate set's kind, fall
 * back to centrality + path alone — same behaviour as before the
 * registry landed.
 */
function pickWithPolicy(
  candidates: ReadonlyArray<{ node: Node }>,
  cg: Cartograph | undefined,
): { node: Node; policy: DisambiguationPolicy | null } {
  const policy = cg ? pickPolicyFor(candidates) : null;
  const enriched = candidates.map((m) => ({
    node: m.node,
    score: policy && cg ? policy.score(cg, m.node) : 0,
  }));
  enriched.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ac = a.node.centrality ?? 0;
    const bc = b.node.centrality ?? 0;
    if (ac !== bc) return bc - ac;
    return a.node.filePath.localeCompare(b.node.filePath);
  });
  return { node: enriched[0]!.node, policy };
}

/**
 * Pick the best exact match. Two stages run before the typed
 * {@link SYMBOL_DISAMBIGUATION_POLICIES} registry: a fixture-path
 * filter (prefer non-fixture paths over fixtures in docs/test-beds /
 * __tests__/fixtures /…), and a thin-wrapper demotion (prefer the
 * real implementation over a `export function X(...) { return otherX(...) }`
 * forwarder; FRICTION-41).
 *
 * The remaining candidates then go through the registry: every kind
 * class has a documented ranking (file by commit_count, function /
 * method by caller count, class-like by member count). Centrality
 * DESC and filePath ASC break ties so two equally-scored candidates
 * don't flip between runs.
 *
 * The returned `note` names the rest of the matches so the caller is
 * never silently shown only one of N candidates. It includes the
 * policy name as a `(disambiguation policy: <name>)` suffix so the
 * agent knows WHY a particular pick won — surfacing the policy on
 * the banner is part of the structural fix #30 closes (silent picks
 * lead to wrong-symbol downstream actions).
 */
function pickFromMultipleExactMatches(
  exactMatches: ReadonlyArray<{ node: Node }>,
  symbol: string,
  cg?: Cartograph,
): { node: Node; note: string } {
  // Tier #1: Filter to non-fixture nodes
  const nonFixtureMatches = exactMatches.filter((m) => !isFixturePath(m.node.filePath));
  let candidates = nonFixtureMatches.length > 0 ? nonFixtureMatches : exactMatches;

  // Tier #2 (FRICTION-41): demote thin re-export wrappers when a real
  // implementation is also in the candidate set. Skip the demotion when
  // EVERY candidate is a wrapper (degenerate case — fall through to the
  // registry so we still pick something stable).
  const nonWrapperMatches = candidates.filter((m) => !isThinWrapper(m.node));
  if (nonWrapperMatches.length > 0 && nonWrapperMatches.length < candidates.length) {
    candidates = nonWrapperMatches;
  }

  // Tier #3: dispatch via the policy registry.
  const { node: picked, policy } = pickWithPolicy(candidates, cg);
  const others = exactMatches
    .filter((m) => m.node.id !== picked.id)
    .map((r) => `${r.node.name} (${r.node.kind}) at ${r.node.filePath}:${r.node.startLine}`);
  const policySuffix = policy ? ` (disambiguation policy: ${policy.name})` : '';
  const note = `\n\n> **Note:** ${exactMatches.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`${policySuffix}. Others: ${others.join(', ')}`;
  return { node: picked, note };
}

/**
 * Compose a banner + body string with the banner at the TOP. The
 * banner's leading whitespace is normalised so the result reads as a
 * one-line headline above a blank-line separator. No-op when the
 * banner is empty / missing.
 *
 * The string-form primitive for the banner-at-top convention. Used
 * directly by consumers that build a raw markdown string
 * (`cartograph_node`, `cartograph_note`, `cartograph_tests_for` body) and
 * by {@link prependDisambiguationBanner} for consumers that already
 * have a wrapped ToolResult.
 *
 * Why banner-at-top: the disambiguation IS the headline — the agent
 * will read it and decide whether the picked candidate is the intended
 * one BEFORE acting on the rest of the response. Burying it as a
 * footer (the pre-#10 default) caused agents to act on wrong-symbol
 * picks. The banner-at-top convention is structural fix #30; every
 * consumer of {@link findSymbol} that surfaces multi-match
 * disambiguation should route through this helper or the wrapper
 * below.
 */
export function withDisambiguationBanner(note: string | undefined, body: string): string {
  if (!note) return body;
  const trimmed = note.replace(/^\n+/, '').trim();
  if (!trimmed) return body;
  return `${trimmed}\n\n${body}`;
}

/**
 * Wrap an MCP `ToolResult`-shaped object so its first text content
 * carries the disambiguation banner at the top. Delegates to
 * {@link withDisambiguationBanner} for the actual composition; this
 * variant is for consumers that already have a wrapped result (e.g.
 * `cartograph_history`).
 */
export function prependDisambiguationBanner<R extends { content?: ReadonlyArray<{ type: string; text?: string }> }>(
  result: R,
  note: string | undefined,
): R {
  if (!note || !result.content || result.content.length === 0) return result;
  const first = result.content[0];
  if (!first || first?.type !== 'text') return result;
  const composed = withDisambiguationBanner(note, first.text ?? '');
  return { ...result, content: [{ ...first, text: composed }] } as R;
}

/**
 * No exact match — return the top fuzzy result with a "did you mean"
 * note so the caller knows we guessed.
 */
function fuzzyFallbackResult(cg: Cartograph, symbol: string, fuzzy: Node): { node: Node; note: string } {
  const suggestions = plausibleSuggestions(suggestSymbolNames(cg.queries, symbol, SUGGESTION_LIMIT))
    .filter((s) => s.name !== fuzzy.name)
    .slice(0, SUGGESTION_RENDER_LIMIT);
  const suggestionNames = suggestions.map((s) => `\`${s.name}\``).join(', ');
  const suggestionList =
    suggestions.length > 0 ? ` Did you mean: ${suggestionNames}?` : '';
  const note = `\n\n> **Note:** No exact match for "${symbol}". Showing closest fuzzy result \`${fuzzy.name}\` (${fuzzy.kind}).${suggestionList}`;
  return { node: fuzzy, note };
}

/**
 * Resolve a symbol arg to a node id only — the simpler sibling of
 * {@link findSymbol}. Used by `mode=symbol` handlers in biomarkers /
 * coverage / role, where the caller crafts its own "not found" copy
 * and doesn't need the disambiguation note that `findSymbol` builds.
 *
 * Three input shapes, in order:
 *   1. `n_xxxxxxxx` short UID minted by a prior tabular tool response.
 *   2. Raw node id (matched via `getNodeById`).
 *   3. Symbol name (FTS top-1 fallback).
 *
 * The punctuation guard rejects characters that never appear in real
 * identifiers — SQL-injection-shaped inputs would otherwise reach the
 * FTS query. Returns `null` when nothing matches.
 *
 * Note: this is *not* a replacement for `findSymbol` — that helper
 * does multi-match disambiguation + fuzzy fallback with notes for
 * tools like callers / callees / impact. Use `findSymbol` when the
 * caller needs to surface multiple matches; use this when "one id
 * or null" is enough.
 */
/**
 * Result of {@link resolveSymbolToNode}. `fuzzy` is `true` when the
 * name had no exact match and the node was picked by FTS ranking —
 * an approximate guess the caller MUST surface so the agent knows the
 * resolution was not authoritative. `fuzzyBanner` carries a
 * caller-renderable one-liner naming the resolved node + kind + path.
 */
export interface ResolvedSymbol {
  /** The resolved node — never null when this object is returned. */
  node: Node;
  /** True when there was no exact name/id match and FTS guessed. */
  fuzzy: boolean;
  /** Visible banner when `fuzzy`; empty string otherwise. */
  fuzzyBanner: string;
}

/**
 * Resolve a symbol arg to a {@link ResolvedSymbol} — the disambiguating
 * sibling of {@link resolveSymbolToNodeId}. Unlike the id-only helper,
 * this flags whether the match was an exact name/id hit or an
 * approximate FTS guess, so `mode=symbol` handlers (biomarkers /
 * coverage / role) can surface a "fuzzy fallback" banner instead of
 * silently presenting an arbitrary node as the requested symbol.
 *
 * Returns `null` when nothing matches at all (caller renders its own
 * "not found" copy).
 */
export function resolveSymbolToNode(
  cg: Cartograph,
  symbol: string,
  refIds: { resolve: (uid: string) => string | null } | undefined,
): ResolvedSymbol | null {
  if (refIds && RefIdCache.isUid(symbol)) {
    const fromUid = refIds.resolve(symbol);
    if (fromUid) {
      const node = cg.queries.getNodeById(fromUid);
      if (node) return { node, fuzzy: false, fuzzyBanner: '' };
    }
    // Unknown / evicted UID falls through to name-based lookup.
  }
  if (/["';(){}[\]<>=&|\\]/.test(symbol)) return null;
  const direct = cg.queries.getNodeById(symbol);
  if (direct) return { node: direct, fuzzy: false, fuzzyBanner: '' };
  // Exact-name DB shortcut — mirrors `findSymbol`'s shortcut so the two
  // resolvers can't drift. Wins over FTS ranking on populous lowercase
  // variants (see `findSymbol` for the full reasoning).
  if (!symbol.includes('.')) {
    const exact = getNodesByName(cg.queries, symbol);
    if (exact.length > 0) return { node: exact[0]!, fuzzy: false, fuzzyBanner: '' };
  }
  const hits = searchNodes(cg.queries, symbol, { limit: 1 });
  if (hits.length === 0) return null;
  // No exact name/id match — the FTS top-1 is a guess. The query may
  // not even share a name with the resolved node (e.g. `runIndex`
  // resolving to an `import` of `./index-hooks/registry.js`). Flag it
  // so the caller never presents the guess as an authoritative match.
  const node = hits[0]!.node;
  if (matchesSymbol(node, symbol)) {
    return { node, fuzzy: false, fuzzyBanner: '' };
  }
  // Relevance gate (audit-4 #10 / group-3 #1): FTS5 token matching can
  // return an arbitrary unrelated symbol for a clearly-bogus query.
  // Reject the fuzzy guess when it shares no real similarity with the
  // query so `biomarkers` / `coverage` / `tests-for` emit a clean
  // "not found" instead of a false-positive "healthy" report.
  if (!fuzzyCandidatePassesGate(cg, symbol, node)) return null;
  return { node, fuzzy: true, fuzzyBanner: buildFuzzyBanner(symbol, node) };
}

/**
 * Build the visible "fuzzy fallback" banner naming the resolved node's
 * name, kind and path so the caller knows resolution was approximate.
 * @internal — exported for unit tests; not part of the public surface.
 */
export function buildFuzzyBanner(symbol: string, node: Node): string {
  return (
    `⚠ Fuzzy fallback — no symbol exactly named "${symbol}"; ` +
    `resolved to \`${node.name}\` (${node.kind}, ${node.filePath}:${node.startLine}). ` +
    `Pass an exact name or an \`n_\` UID to disambiguate.`
  );
}

export function resolveSymbolToNodeId(
  cg: Cartograph,
  symbol: string,
  refIds: { resolve: (uid: string) => string | null } | undefined,
): string | null {
  const resolved = resolveSymbolToNode(cg, symbol, refIds);
  return resolved ? resolved.node.id : null;
}

/**
 * Direct-id shortcuts shared by {@link findSymbol}. Tries, in order, the
 * `n_xxxxxxxx` UID lookup, the raw `${kind}:${32-hex}` node-id lookup, and the
 * file-path lookup. Returns a resolved node on a hit, or `null` to signal that
 * the caller should fall through to FTS name resolution. Behaviour is identical
 * to the inline blocks it replaces — same order, same fall-through semantics.
 */
function resolveSymbolShortcut(
  cg: Cartograph,
  symbol: string,
  refIds: { resolve: (uid: string) => string | null } | undefined,
): Node | null {
  // #15: short-id shortcut — if the agent passed an `n_xxxxxxxx`
  // UID minted by a prior tabular response, look up the original
  // node id directly. Skips the FTS round-trip and the
  // multiple-matches/exact-match heuristics that operate on names.
  if (refIds && RefIdCache.isUid(symbol)) {
    const nodeId = refIds.resolve(symbol);
    if (nodeId) {
      const node = cg.queries.getNodeById(nodeId);
      if (node) return node;
    }
    // Unknown / evicted UID falls through to name-based lookup —
    // the symbol arg might literally be a name that happens to
    // start with `n_` (unlikely but cheap to handle).
  }

  // #34: raw node-id shortcut — accept a `${kind}:${32-hex}` id
  // verbatim (as minted by `generateNodeId`). Some callers paste a
  // node id straight from a prior tool result; without this it would
  // fall through to FTS name lookup and miss.
  if (isRawNodeId(symbol)) {
    const node = cg.queries.getNodeById(symbol);
    if (node) return node;
    // Not in the index — fall through; the colon-bearing string is
    // almost certainly stale, but FTS may still surface something.
  }

  // File-path shortcut — when the symbol contains a `/`, try a
  // file-node lookup first so callers can pass `src/index.ts` and
  // get the file node back instead of "did you mean: index.ts".
  // Only fires on path-shaped input; bare basenames keep falling
  // through to the FTS path so multi-defined names stay name-resolved.
  if (symbol.includes('/')) {
    const fileNode = lookupFileNode(cg, symbol);
    if (fileNode) return fileNode;
  }

  return null;
}

/**
 * FTS-backed name resolution tail of {@link findSymbol}, reached only after the
 * direct-id and exact-name shortcuts miss. Runs the search cascade, prefers an
 * exact match, then falls back to a gated fuzzy "did you mean" result. Behaviour
 * is identical to the inline block it replaces.
 */
function resolveSymbolViaSearch(cg: Cartograph, symbol: string): { node: Node; note: string } | null {
  // Use higher limit for qualified lookups (e.g., "Session.request") since the
  // target may rank lower in FTS when there are many partial matches
  const limit = symbol.includes('.') ? QUALIFIED_LOOKUP_LIMIT : PLAIN_LOOKUP_LIMIT;
  const results = searchNodes(cg.queries, symbol, { limit });

  if (results.length === 0 || !results[0]) return null;

  const exactMatches = results.filter((r) => matchesSymbol(r.node, symbol));
  if (exactMatches.length === 1) {
    return { node: exactMatches[0]!.node, note: '' };
  }
  if (exactMatches.length > 1) {
    return pickFromMultipleExactMatches(exactMatches, symbol, cg);
  }

  // No exact match — fall back to the top fuzzy result with a "did
  // you mean" note. Silently returning `mockRunner` for `ModlRunner`
  // would look like a successful lookup and the agent would then act
  // on the wrong symbol.
  //
  // Relevance gate (audit-4 #10 / group-3 #1): FTS5 can return an
  // arbitrary unrelated symbol for a clearly-bogus query (`zzznotreal`
  // → `SUGGEST_SUBSTR_GATE`). Accepting it makes `node zzznotreal`
  // confidently print a wrong symbol's full details. When the top-1
  // fails the gate, fall through to a clean "not found + suggestions".
  if (!fuzzyCandidatePassesGate(cg, symbol, results[0].node)) return null;
  return fuzzyFallbackResult(cg, symbol, results[0].node);
}

export function findSymbol(
  cg: Cartograph,
  symbol: string,
  refIds?: { resolve: (uid: string) => string | null },
): { node: Node; note: string } | null {
  const shortcut = resolveSymbolShortcut(cg, symbol, refIds);
  if (shortcut) return { node: shortcut, note: '' };

  // Exact-name DB shortcut for unqualified names — mirrors the same
  // shortcut `findAllSymbols` uses. Wins over FTS ranking because
  // FTS' top-N can be saturated by populous lowercase variants
  // (e.g. 8000+ graphql fields named `node`) that bury the actual
  // target past the search-cascade cap. Without this, real symbol
  // names could miss here even though `getNodesByName` would resolve
  // them — producing "Symbol not found" on a name the index has.
  // Friction (2026-05-14): the `_node.ts` resolver previously diverged
  // from `_biomarkers.ts` because biomarkers' top-1 FTS hit benefits
  // from `addExactNameSupplements`, whereas this path filters through
  // `matchesSymbol` and could drop the target when supplements rank it
  // below 10. The exact-name lookup now harmonises both surfaces.
  if (!symbol.includes('.')) {
    const exact = getNodesByName(cg.queries, symbol);
    if (exact.length === 1) return { node: exact[0]!, note: '' };
    if (exact.length > 1) {
      return pickFromMultipleExactMatches(
        exact.map((node) => ({ node })),
        symbol,
        cg,
      );
    }
    // exact.length === 0 → fall through to FTS — the index has no row
    // by that bare name, so a fuzzy / qualified-form match may still
    // surface (e.g. `Class.method` queries land in the FTS-only path
    // when their `.` form isn't matched by getNodesByName's bare name).
  }

  return resolveSymbolViaSearch(cg, symbol);
}

/**
 * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
 * results across all matching symbols (e.g., multiple classes with an `execute` method).
 */
export function findAllSymbols(
  cg: Cartograph,
  symbol: string,
  refIds?: { resolve: (uid: string) => string | null },
): { nodes: Node[]; note: string } {
  const shortcut = resolveAllSymbolsShortcut(cg, symbol, refIds);
  if (shortcut) return shortcut;

  if (!symbol.includes('.')) {
    const exact = lookupAllByExactName(cg, symbol);
    if (exact) return exact;
    // null → fall through to FTS-backed search. The
    // FTS path's own exact-match filter (matchesSymbol) will still
    // return empty in most cases, but we keep the fallback for
    // qualified-name forms that have no dot — e.g. C++ `Class::method`,
    // Go-flavored `Mod/Func`, Rust `crate::path::ident`. matchesSymbol
    // only handles the dot-prefixed form, so other delimiters land
    // here and at least get FTS-ranked exact matches.
  }

  return resolveAllViaFtsExactFilter(cg, symbol);
}

function resolveAllSymbolsShortcut(
  cg: Cartograph,
  symbol: string,
  refIds?: { resolve: (uid: string) => string | null },
): { nodes: Node[]; note: string } | null {
  // #15: short-id shortcut — same as findSymbol. UID always
  // resolves to a single node (or empty when evicted).
  if (refIds && RefIdCache.isUid(symbol)) {
    const nodeId = refIds.resolve(symbol);
    if (nodeId) {
      const node = cg.queries.getNodeById(nodeId);
      if (node) return { nodes: [node], note: '' };
    }
  }

  // #34: raw node-id shortcut — same as findSymbol.
  if (isRawNodeId(symbol)) {
    const node = cg.queries.getNodeById(symbol);
    if (node) return { nodes: [node], note: '' };
  }

  // File-path shortcut — same as findSymbol. Lets `cartograph_graph`
  // batch / impact paths accept `src/index.ts` and resolve to the
  // file node before fuzzy-name fallback.
  if (symbol.includes('/')) {
    const fileNode = lookupFileNode(cg, symbol);
    if (fileNode) return { nodes: [fileNode], note: '' };
  }

  return null;
}

/**
 * Resolve a project-relative path string to its `kind='file'` node.
 * Returns null when no file matches — caller falls through to the
 * name-based lookup so callers passing a path-shaped name (rare but
 * possible — e.g. a symbol literally named `a/b`) still resolve.
 */
function lookupFileNode(cg: Cartograph, symbol: string): Node | null {
  const row = cg.queries.db.prepare(`SELECT id FROM nodes WHERE kind = 'file' AND file_path = ? LIMIT 1`).get(symbol) as
    | { id?: string }
    | undefined;
  if (!row?.id) return null;
  return cg.queries.getNodeById(row.id) ?? null;
}

/**
 * Exact-name DB lookup for unqualified names. Wins over FTS ranking because
 * FTS' top-50 can be saturated by populous lowercase variants (e.g. 8000+
 * graphql fields named `node`) that eclipse the actual target (interface
 * `Node`). Returns null when the index has no rows by that name (caller
 * falls through to FTS).
 */
function lookupAllByExactName(cg: Cartograph, symbol: string): { nodes: Node[]; note: string } | null {
  const exact = getNodesByName(cg.queries, symbol);
  if (exact.length === 0) return null;
  if (exact.length === 1) return { nodes: [exact[0]!], note: '' };
  const locations = exact.map((n) => `${n.kind} at ${n.filePath}:${n.startLine}`);
  const note = `\n\n> **Note:** Aggregated results across ${exact.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: exact, note };
}

/**
 * FTS-backed search filtered to exact symbol matches. Empty when FTS has
 * nothing OR when no FTS row passes the exact-match filter (caller surfaces
 * a clean "not found" with did-you-mean suggestions).
 */
function resolveAllViaFtsExactFilter(cg: Cartograph, symbol: string): { nodes: Node[]; note: string } {
  const results = searchNodes(cg.queries, symbol, { limit: 50 });
  if (results.length === 0) return { nodes: [], note: '' };

  const exactMatches = results.filter((r) => matchesSymbol(r.node, symbol));
  if (exactMatches.length === 0) return { nodes: [], note: '' };
  if (exactMatches.length === 1) return { nodes: [exactMatches[0]!.node], note: '' };

  const locations = exactMatches.map((r) => `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`);
  const note = `\n\n> **Note:** Aggregated results across ${exactMatches.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: exactMatches.map((r) => r.node), note };
}
