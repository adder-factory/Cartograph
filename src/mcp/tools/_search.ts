/**
 * @internal — by='name' handler for the consolidated `cartograph_find`
 * family tool (formerly the top-level `cartograph_search` tool). Dispatched
 * from `find.ts` when `by === 'name'`. No registered ToolModule export —
 * the registry only knows FIND_TOOL.
 *
 * Preserves the pre-merge `cartograph_search` API verbatim: four modes
 * (`exact` / `fuzzy` / `semantic` / `intent`), `compact` + `fields:[]`
 * projection (mode='exact' only), delta-mode `since:` cursor, kind /
 * language filters, all the empty-result probe diagnostics.
 */
import type { ToolResult } from '../tool-types.js';
import type { SearchResult } from '../../search/types.js';
import type { Language, Node, NodeKind } from '../../types.js';
import { clamp, compact, isTestPath, numArg } from '../../utils.js';
import {
  applyDeltaSince,
  freshnessHintForEmptyResult,
  mintCallId,
  parseSearchFieldsArg,
  type SearchFieldName,
  textResult,
  validateStringOutcome,
} from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import type { ToolCtx } from './types.js';
import type { RefIdCache } from './_id-cache.js';
import { getNodesByName, searchNodes, suggestSymbolNames, DEPENDENCY_EDGE_KINDS } from '../../db/queries-search.js';
import { lookupNestedFnsByName, type NestedFnLookupRow } from '../../db/queries-nested-functions.js';
import { handleSearchFuzzy } from './_search-fuzzy.js';
import { handleSearchSemantic } from './_search-semantic.js';
import { handleSearchIntent } from './_search-intent.js';
import { parseQuery, type CentralityFilter } from '../../search/query-parser.js';
import { rowToNode, type NodeRow } from '../../db/queries.js';

/** Default `limit` when caller doesn't pass one. */
const DEFAULT_SEARCH_LIMIT = 10;
/** Hard cap on caller-supplied `limit` to bound upstream FTS cost. */
const MAX_SEARCH_LIMIT = 100;
/** Over-fetch multiplier so prod/test re-rank can promote a real prod hit ranked just outside `limit`. */
const SEARCH_OVERFETCH_MULTIPLIER = 3;
/** Cap on the count of "did you mean" suggestions returned with a no-results response. */
const MAX_SUGGESTIONS = 5;
/** Cap on distinct kinds listed in the "without the kind filter, X results would have matched" hint. */
const MAX_HINT_KINDS = 3;
/** Top-N results checked for token-coverage when deciding to surface the explore-hint. */
const COVERAGE_TOP_N = 5;
/** Minimum query-token length (2) kept for the multi-token-coverage check (excludes 1-char noise). */
const MIN_COVERAGE_TOKEN_LEN = 2;
/** Trigger the explore hint when fewer top-N results match this many query tokens. */
const MIN_TOKEN_COVERAGE = 2;

/**
 * Compact list-based formatting for search results — name + kind
 * on its own line, location below, signature when present.
 *
 * When `kindFilter` is set every row already has that kind — drop
 * the redundant `(${kind})` suffix from each row and put the kind
 * once in the header. Saves ~15 chars/row on a single-kind query.
 */
interface FormatSearchResultsOpts {
  results: SearchResult[];
  kindFilter: string | undefined;
  /** Stage 6 #6.1 — emit terse pipe-delimited rows instead of markdown. */
  compact?: boolean;
  /** Stage 6 #6.3 — restrict compact rows to a subset of fields. Only effective when `compact: true`. */
  fields?: ReadonlyArray<SearchFieldName>;
  /** Cache for minting per-row `n_xxxxxxxx` UIDs when the `id` field is requested. */
  refIds?: RefIdCache | undefined;
}

function formatSearchResults(opts: FormatSearchResultsOpts): string {
  const { results, kindFilter, compact = false, fields, refIds } = opts;
  if (compact) {
    return formatSearchResultsCompact({
      results,
      kindFilter,
      ...(fields ? { fields } : {}),
      refIds,
    });
  }

  const headerSuffix = kindFilter ? ` (kind=${kindFilter})` : '';
  const lines: string[] = [`## Search Results (${results.length} found)${headerSuffix}`, ''];

  for (const result of results) {
    const { node } = result;
    const location = node.startLine ? `:${node.startLine}` : '';
    const kindSuffix = kindFilter ? '' : ` (${node.kind})`;
    lines.push(`### ${node.name}${kindSuffix}`, `${node.filePath}${location}`);
    if (node.signature) lines.push(`\`${node.signature}\``);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Compact one-line-per-result renderer for `cartograph_search`. Mirrors
 * the `formatNodeListCompact` shape used by callers / callees, but with
 * `signature` available in place of `role` (search rows carry a
 * signature; graph-walk rows don't).
 *
 *   Search Results (N)
 *   name|kind|path:line[|sig:<...>][|id:n_xxxxxxxx]
 *   ...
 *
 * When `fields` is set, restricts to the named columns (canonical order
 * regardless of input ordering). Defaults to name|kind|path|line|signature
 * plus `id` when refIds is available — matches markdown-mode parity.
 */
interface FormatSearchResultsCompactArgs {
  results: SearchResult[];
  kindFilter: string | undefined;
  fields?: ReadonlyArray<SearchFieldName>;
  refIds?: RefIdCache | undefined;
}

function pushSearchPathLineColumns(cols: string[], node: Node, fieldSet: ReadonlySet<string>): void {
  const hasPathField = fieldSet.has('path');
  const hasLineField = fieldSet.has('line') && Boolean(node.startLine);
  if (hasPathField && hasLineField) cols.push(`${node.filePath}:${node.startLine}`);
  else if (hasPathField) cols.push(node.filePath);
  else if (hasLineField) cols.push(String(node.startLine));
}

function formatSearchCompactColumns(node: Node, fieldSet: ReadonlySet<string>, refIds: RefIdCache | undefined): string {
  const cols: string[] = [];
  if (fieldSet.has('name')) cols.push(node.name);
  if (fieldSet.has('kind')) cols.push(node.kind);
  pushSearchPathLineColumns(cols, node, fieldSet);
  if (fieldSet.has('signature') && node.signature) cols.push(`sig:${node.signature}`);
  const hasIdField = fieldSet.has('id') && refIds !== undefined;
  if (hasIdField) cols.push(`id:${refIds.mint(node.id)}`);
  return cols.join('|');
}

function formatSearchResultsCompact(args: FormatSearchResultsCompactArgs): string {
  const { results, kindFilter, fields, refIds } = args;
  const headerSuffix = kindFilter ? ` (kind=${kindFilter})` : '';
  const lines: string[] = [`Search Results (${results.length})${headerSuffix}`];

  const defaultFields: ReadonlyArray<SearchFieldName> = refIds
    ? ['name', 'kind', 'path', 'line', 'signature', 'id']
    : ['name', 'kind', 'path', 'line', 'signature'];
  const hasExplicitFields = Array.isArray(fields) && fields.length > 0;
  const fieldSet = hasExplicitFields ? new Set<string>(fields) : new Set<string>(defaultFields);

  for (const r of results) {
    lines.push(formatSearchCompactColumns(r.node, fieldSet, refIds));
  }
  return lines.join('\n');
}

/**
 * Build the "no results" response. Two distinct signals:
 *  1. When `kind` was set AND dropping it would have produced hits,
 *     name the kinds that would have matched — prevents the agent
 *     concluding the symbol doesn't exist when its kind was wrong.
 *  2. Otherwise, surface near-matches via suggestSymbolNames + add a
 *     concept-query explore hint when the query is multi-token.
 */
function buildEmptyResultsResponse(
  cg: import('../../index.js').default,
  query: string,
  kind: string | undefined,
): ToolResult {
  const graphQualifierHint = probeGraphQualifierCulprit(cg, query);
  if (graphQualifierHint) return textResult(graphQualifierHint);

  const centralityHint = probeCentralityFilterCulprit(cg, query);
  if (centralityHint) return textResult(centralityHint);

  const booleanHint = probeBooleanOperatorCulprit(query);
  if (booleanHint) return textResult(`No results for "${query}". ${booleanHint}`);

  // Effective kind filter: explicit `args['kind']` plus any inline
  // `kind:X` token(s) lifted from the query string. Without including
  // the inline form, an agent who writes `getNodeById kind:function`
  // (the rich-query syntax cartograph documents in tool descriptions)
  // gets the bare did-you-mean trail instead of the much-more-useful
  // "drop the kind filter — there ARE method matches" hint.
  const inlineKindTokens = [...query.matchAll(/\bkind:(\S+)/gi)].map((m) => m[1]!);
  const effectiveKind = kind ?? inlineKindTokens[0];
  const kindHint = effectiveKind ? probeKindFilterCulprit(cg, query, effectiveKind) : null;
  if (kindHint) return textResult(kindHint);

  // F#12 slice 2: when nothing matched in the graph, fall through to
  // the nested-function manifest. Symbols inside mega-files
  // (`checker.ts` class — body > `largeFunctionThreshold`) aren't graph
  // nodes, so without this probe the agent gets "no results" for a
  // name that DOES exist — just not as a first-class node. Renders a
  // dedicated "Nested matches" section that points at
  // `cartograph_node({deep:true})` for the body view.
  const nestedHint = probeNestedFunctionManifestCulprit(cg, query, effectiveKind);
  if (nestedHint) return textResult(nestedHint);

  const suggestions = suggestSymbolNames(cg.queries, query, MAX_SUGGESTIONS);
  const queryTokens = query.trim().split(/\s+/);
  const suggestionNames = suggestions.map((s) => `\`${s.name}\``).join(', ');
  const suggestionLine = suggestions.length > 0 ? ` Did you mean: ${suggestionNames}?` : '';
  const exploreHint =
    queryTokens.length >= 2
      ? `\n\n> **Tip:** Multi-word queries are concept searches — try \`cartograph_explore\` for "${query}" to search across signatures and bodies.`
      : '';
  // Include the kind filter when active — an agent reading "no results"
  // without that context has no signal that the filter is the reason.
  const kindNote = effectiveKind ? ` (kind=${effectiveKind})` : '';
  return textResult(
    `No results found for "${query}"${kindNote}.${suggestionLine}${exploreHint}${freshnessHintForEmptyResult(cg)}`,
  );
}

/**
 * Render a "Nested matches" section for an empty exact-name search
 * when the query maps to one or more nested-function manifest rows.
 * Output shape (matches the F#12 plan §cartograph_find-integration):
 *
 *   ## Nested matches for `getTypeOfSymbol` (N hits)
 *
 *   - `getTypeOfSymbol` — inside `createTypeChecker`
 *     src/compiler/checker.ts:12345
 *
 *   > Pass `cartograph_node({symbol: 'getTypeOfSymbol', deep: true})` for
 *   > the inline body view; the function lives in a mega-file and was
 *   > not extracted as a first-class graph node.
 */
function renderNestedMatchesSection(query: string, rows: ReadonlyArray<NestedFnLookupRow>): string {
  const header = `## Nested matches for \`${query}\` (${rows.length} hit${rows.length === 1 ? '' : 's'})`;
  const lines = rows.map((r) => {
    const parent = r.parentName ? ` — inside \`${r.parentName}\`` : '';
    // F#12 slice 3: surface hit_count + promotion status so the agent
    // sees popularity accumulating and learns when a symbol has
    // graduated to a first-class node. Rows where promoted_node_id is
    // set render with a ✓ marker — `deep:true` on those now routes
    // through the normal node-card pipeline.
    const promoted = r.promotedNodeId === null ? '' : `  ✓ promoted`;
    const hitTrail = r.hitCount > 0 ? `  hit ${r.hitCount}` : '';
    return `- \`${r.name}\`${parent}\n  ${r.filePath}:${r.startLine}${hitTrail}${promoted}`;
  });
  const footer =
    `> Pass \`cartograph_node({symbol: ${JSON.stringify(query)}, deep: true})\` for ` +
    `the inline body view; F#12 manifest entries become first-class graph ` +
    `nodes automatically once \`hit_count\` crosses \`nestedPromotionThreshold\` ` +
    `(default 5).`;
  return `${header}\n\n${lines.join('\n')}\n\n${footer}`;
}

/**
 * F#12 slice 2 probe — when an exact-name search returns nothing AND
 * the manifest holds one or more rows for that name, render a
 * "Nested matches" hint pointing at `cartograph_node({deep:true})`.
 *
 * Skipped when an effective `kind:` filter is set — manifest rows have
 * no kind column (they're not graph nodes), so a kind filter is by
 * construction unsatisfiable. The kind probe above already handled
 * the "drop the kind filter" case.
 *
 * Skipped when the query contains FTS qualifiers or boolean operators
 * — manifest lookups are bare-name only. Compound queries flow through
 * to the suggestSymbolNames footer.
 */
function probeNestedFunctionManifestCulprit(
  cg: import('../../index.js').default,
  query: string,
  effectiveKind: string | undefined,
): string | null {
  if (effectiveKind !== undefined) return null;
  // Reject any query that isn't a single bare identifier — manifest
  // lookups are exact-name only. Permissive shape: alpha/digit/_/$
  // (matches JS-family identifier conventions).
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(query.trim())) return null;
  const rows = lookupNestedFnsByName(cg.queries, query.trim(), MAX_SUGGESTIONS);
  if (rows.length === 0) return null;
  return renderNestedMatchesSection(query.trim(), rows);
}

/**
 * Probe whether stripping `centrality:X` filters would have produced hits —
 * the most-likely silent killer when the suggestSymbolNames fallback is
 * unhelpful. Returns the targeted hint, or null if centrality wasn't the cause.
 *
 * Differentiates two cases:
 *   1. All nodes have NULL centrality (hook hasn't run) → suggest running `cartograph index`
 *   2. Some nodes have centrality but none met the threshold → suggest relaxing the threshold
 */
function probeCentralityFilterCulprit(cg: import('../../index.js').default, query: string): string | null {
  const stripped = query.replaceAll(/\bcentrality:\S+\s*/gi, '').trim();
  if (stripped === query) return null;
  const without = searchNodes(cg.queries, stripped, { limit: MAX_SUGGESTIONS });
  if (without.length === 0) return null;

  // Check if any node in the entire database has non-NULL centrality.
  // This tells us whether the centrality hook has run yet.
  const anyCentrality = cg.queries.db.prepare('SELECT 1 FROM nodes WHERE centrality IS NOT NULL LIMIT 1').get() as
    | { [key: number]: number }
    | undefined;

  const hasCentralityData = anyCentrality !== undefined;

  const baseMessage = `No results for "${query}". Without the centrality filter, ${without.length} result${without.length === 1 ? '' : 's'} match. `;

  if (hasCentralityData) {
    // Some nodes have centrality, but the filter was too strict.
    return (
      baseMessage +
      'All nodes meeting the centrality threshold were dropped by other filters. Try `centrality:>0` or drop the filter to relax the constraint.'
    );
  } else {
    // Centrality hook hasn't run — all nodes have NULL centrality.
    return (
      baseMessage +
      "If the centrality hook hasn't run yet (fresh index, --force pending), every node has NULL centrality and `>` / `>=` filters drop them all. Drop the centrality filter or run `cartograph index`."
    );
  }
}

/**
 * Probe for stray boolean operators (`AND` / `OR` / `NOT` / `NEAR`)
 * in the user query. The FTS prefix builder strips these tokens so
 * the agent's intended disjunction silently degrades into an
 * implicit-OR over the remaining bare terms — and field-qualified
 * forms like `name:X OR name:Y` lose their disjunction structure
 * entirely. Returns a hint pointing at the cause; null when no
 * standalone operator was found.
 */
function probeBooleanOperatorCulprit(query: string): string | null {
  const operators = [...query.matchAll(/\b(AND|OR|NOT|NEAR)\b/g)].map((m) => m[1]!);
  if (operators.length === 0) return null;
  const unique = [...new Set(operators)].sort((a, b) => Number(a > b) - Number(a < b));
  return (
    `Detected boolean operator${unique.length === 1 ? '' : 's'} (${unique.join(', ')}) in the query — ` +
    "cartograph_find (by='name') does NOT parse FTS5 boolean syntax; these tokens are stripped before matching. " +
    'For disjunctions, issue separate calls (one per term) and merge client-side. ' +
    'For "find X with property Y", use the field-qualified single-term syntax (e.g. `getFoo kind:function`).'
  );
}

/**
 * List the OTHER field qualifiers present in a query (everything except
 * `kind:`). Returned in the form `lang:go, path:src/` for inlining into
 * empty-result hints — so an agent who sees "Without the kind filter,
 * 5 results match" understands that 5 = "matching the remaining filters",
 * not "matching the entire codebase".
 *
 * @internal — exported for unit testing the field-qualifier scanner.
 */
export function describeRemainingFilters(query: string): string | null {
  const matches = [...query.matchAll(/\b(lang|language|path|name|sig):\S+/gi)].map((m) => m[0]);
  if (matches.length === 0) return null;
  return matches.join(', ');
}

/**
 * Probe whether stripping `kind:X` filters would have produced hits, and if so
 * tell the caller which kinds DID match. Strips every `kind:X` token from the
 * probe so the inline qualifier doesn't re-apply itself.
 */
function probeKindFilterCulprit(
  cg: import('../../index.js').default,
  query: string,
  effectiveKind: string,
): string | null {
  const probeQuery = query.replaceAll(/\bkind:\S+\s*/gi, '').trim();
  const without = searchNodes(cg.queries, probeQuery, { limit: MAX_SUGGESTIONS });
  if (without.length === 0) return null;
  const kinds = [...new Set(without.map((r) => r.node.kind))].slice(0, MAX_HINT_KINDS).join(', ');
  const remaining = describeRemainingFilters(query);
  // When `kind:` is one of several filters, the probe's "5 results match"
  // only describes the residue under the OTHER filters — not the whole
  // codebase. Surface that explicitly so the agent doesn't misread the
  // count as "5 Go classes" when they wrote `kind:class lang:go` and
  // the residue is actually "5 symbols whose name token matched, in Go".
  const remainingNote = remaining ? ` Other filters still active: ${remaining}.` : '';
  return (
    `No results for "${query}" with kind=${effectiveKind}. ` +
    `Without the kind filter, ${without.length} result${without.length === 1 ? '' : 's'} ` +
    `(kind${without.length === 1 ? '' : 's'}: ${kinds}).` +
    remainingNote +
    ` Drop the kind filter or set it to one of those.`
  );
}

/**
 * Probe whether `callers-of:NAME` / `callees-of:NAME` was the silent
 * killer of an empty result set. Distinguishes three cases per
 * qualifier:
 *
 *   1. NAME doesn't exist in `nodes` at all → "no symbol named NAME"
 *   2. NAME exists but no incoming/outgoing `calls` edge in the
 *      graph (common for dispatch-table targets like `sync: handleSync`
 *      where the extractor emits a reference but no call edge) →
 *      "NAME exists but has no callers/callees in the call graph"
 *   3. Edges exist but every caller/callee was filtered out by another
 *      qualifier (e.g. `callers-of:foo kind:method` when callers are
 *      functions) → "drop or relax the other filter"
 *
 * Without this probe, the empty result falls through to the generic
 * "did you mean…?" message, which is actively misleading — the
 * qualifier IS implemented; the graph just lacks the edge.
 *
 * When a query carries MULTIPLE graph qualifiers, the first present
 * (priority: `depends-on:` alone → `callers-of:` → `callees-of:`) is
 * diagnosed and the rest ignored — one culprit message is clearer
 * than a compound one. This is intentional, not an oversight.
 */
/** @internal — exported for unit testing the graph-qualifier probe. */
export function probeGraphQualifierCulprit(cg: import('../../index.js').default, query: string): string | null {
  const parsed = parseQuery(query);
  // depends-on: has a wider edge-kind set + distinct messaging, so it
  // gets its own probe. Only when it's the sole graph qualifier — a
  // mixed query falls through to the callers/callees probe below
  // (first qualifier wins, matching the rest of this function).
  if (parsed.dependsOn.length > 0 && parsed.callersOf.length === 0 && parsed.calleesOf.length === 0) {
    return probeDependsOnCulprit(cg, query, parsed.dependsOn[0]!);
  }
  if (parsed.callersOf.length === 0 && parsed.calleesOf.length === 0) return null;

  const target = parsed.callersOf[0] ?? parsed.calleesOf[0]!;
  const direction = parsed.callersOf.length > 0 ? 'callers' : 'callees';
  const qualifier = parsed.callersOf.length > 0 ? 'callers-of' : 'callees-of';

  // Case 1: target name doesn't exist as any node. (bun:sqlite's raw
  // .get() returns null for no rows; better-sqlite3 returned undefined
  // — `== null` matches either nullish.)
  const nameRow = cg.queries.db.prepare('SELECT 1 FROM nodes WHERE name = ? LIMIT 1').get(target) as
    | { [key: number]: number }
    | null
    | undefined;
  if (nameRow == null) {
    return (
      `No results for "${query}". The \`${qualifier}:${target}\` qualifier refers to a symbol "${target}" that doesn't exist in this index. ` +
      `Check the spelling, or run \`cartograph_find by:name query:${target}\` to find similar names.`
    );
  }

  // Case 2: target exists but no calls edge — count edges directly.
  const edgeCountSql =
    direction === 'callers'
      ? `SELECT COUNT(*) AS n FROM edges e JOIN nodes tgt ON e.target = tgt.id WHERE e.kind = 'calls' AND tgt.name = ?`
      : `SELECT COUNT(*) AS n FROM edges e JOIN nodes src ON e.source = src.id WHERE e.kind = 'calls' AND src.name = ?`;
  const edgeCount = (cg.queries.db.prepare(edgeCountSql).get(target) as { n: number } | undefined)?.n ?? 0;
  if (edgeCount === 0) {
    return (
      `No results for "${query}". \`${target}\` exists but has no incoming \`calls\` edges in the graph. ` +
      `This is common for dispatch-table handlers (e.g. \`sync: ${target}\`) and re-exports — the extractor records a \`references\` edge but no \`calls\`. ` +
      `Try \`cartograph_graph direction:callers start:${target}\` for the broader call-or-reference set, or \`cartograph_graph start:${target}\` for the full edge list.`
    );
  }

  // Case 3: edges exist but were filtered out. Strip every other
  // qualifier and re-run callers-of alone to confirm. If THAT path
  // returns rows, point at the conflicting filter; otherwise stay
  // silent so a later probe (kind:, lang:) can attribute correctly.
  const aloneQuery = `${qualifier}:${target}`;
  const alone = searchNodes(cg.queries, aloneQuery, { limit: MAX_SUGGESTIONS });
  if (alone.length === 0) return null;
  return (
    `No results for "${query}". \`${qualifier}:${target}\` alone returns ${alone.length} ${direction}, ` +
    `but the other qualifiers in the query (kind:/lang:/path:/name:/sig:) filter them all out. ` +
    `Drop one of the other qualifiers and rerun.`
  );
}

/**
 * `depends-on:` counterpart of {@link probeGraphQualifierCulprit} —
 * the same three-case empty-result diagnosis (missing symbol / no
 * dependency edge / filtered out) over the wider dependency-edge set
 * ({@link DEPENDENCY_EDGE_KINDS}).
 */
function probeDependsOnCulprit(cg: import('../../index.js').default, query: string, target: string): string | null {
  // Case 1: target name doesn't exist as any node. (bun:sqlite's raw
  // .get() returns null for no rows; better-sqlite3 returned undefined
  // — `== null` matches either nullish.)
  const nameRow = cg.queries.db.prepare('SELECT 1 FROM nodes WHERE name = ? LIMIT 1').get(target) as
    | { [key: number]: number }
    | null
    | undefined;
  if (nameRow == null) {
    return (
      `No results for "${query}". The \`depends-on:${target}\` qualifier refers to a symbol "${target}" that doesn't exist in this index. ` +
      `Check the spelling, or run \`cartograph_find by:name query:${target}\` to find similar names.`
    );
  }

  // Case 2: target exists but nothing has a dependency edge to it.
  const kindList = DEPENDENCY_EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  const edgeCount =
    (
      cg.queries.db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges e JOIN nodes tgt ON e.target = tgt.id WHERE e.kind IN (${kindList}) AND tgt.name = ?`,
        )
        .get(target) as { n: number } | undefined
    )?.n ?? 0;
  if (edgeCount === 0) {
    return (
      `No results for "${query}". \`${target}\` exists but nothing depends on it — no \`calls\` / \`imports\` / \`extends\` / type-usage edge points at it in the graph. ` +
      `Try \`cartograph_graph direction:callers start:${target}\` for the full incoming-edge set.`
    );
  }

  // Case 3: edges exist but every dependant was filtered out by the
  // other qualifiers — re-run depends-on alone to confirm.
  const alone = searchNodes(cg.queries, `depends-on:${target}`, { limit: MAX_SUGGESTIONS });
  if (alone.length === 0) return null;
  return (
    `No results for "${query}". \`depends-on:${target}\` alone returns ${alone.length} dependant(s), ` +
    `but the other qualifiers in the query (kind:/lang:/path:/name:/sig:) filter them all out. ` +
    `Drop one of the other qualifiers and rerun.`
  );
}

/** Interface for pre/post result hints from multi-token query analysis. */
interface ConceptHints {
  preResult: string;
  postResult: string;
}

/**
 * Concept-query hint: multi-token queries against FTS5 prefix-match
 * the first token, which can return prefix-only hits (`edges kind
 * constraint check` returns 5 unrelated `edges` methods). When the
 * top-N results share no token beyond the first with the query,
 * append the explore tip so the agent isn't misled.
 *
 * Gate: ≥2 raw tokens AND ≥2 of those tokens ≥ MIN_COVERAGE_TOKEN_LEN
 * chars. Single-char tokens are excluded from the coverage check —
 * they appear in nearly every identifier and would defeat the signal.
 *
 * Returns both `preResult` and `postResult` hints:
 *   - `preResult`: shown BEFORE results when query has 2+ non-qualified tokens
 *   - `postResult`: shown AFTER results when top-N coverage is poor
 * Only one appears in the final response.
 */
/** @internal — exported for unit testing the qualifier-token filter. */
export function buildConceptHintIfNeeded(query: string, results: ReadonlyArray<SearchResult>): ConceptHints {
  // Drop rich-query-language qualifiers (`kind:`, `path:`, `lang:`, etc.).
  // They're filters, not concept signal — counting them triggered the
  // tip on queries like `getAllImports kind:function` where there's
  // really only one concept token and the suggestion to use _explore
  // doesn't apply.
  const rawTokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => !t.includes(':'));
  const coverageTokens = rawTokens.filter((t) => t.length >= MIN_COVERAGE_TOKEN_LEN);

  // Pre-result hint: when the query shape suggests multi-symbol lookup.
  let preResult = '';
  if (rawTokens.length >= 2) {
    preResult = `> **Multi-token query detected.** Top results match only the first non-qualified token. To search each name separately, call \`cartograph_find by:name\` per name. To search across signatures and bodies, use \`cartograph_explore\`.`;
  }

  // Post-result hint: when we have results but they poorly match the query tokens.
  let postResult = '';
  if (rawTokens.length >= 2 && coverageTokens.length >= MIN_TOKEN_COVERAGE) {
    const lowered = coverageTokens.map((t) => t.toLowerCase());
    const tokenCoverage = (haystack: string): number => {
      const h = haystack.toLowerCase();
      return lowered.filter((t) => h.includes(t)).length;
    };
    const topResults = results.slice(0, COVERAGE_TOP_N);
    const wellMatched = topResults.filter((r) => {
      const text = `${r.node.name} ${r.node.signature ?? ''} ${r.node.filePath}`;
      return tokenCoverage(text) >= MIN_TOKEN_COVERAGE;
    });
    // Only show post-result if results exist AND they match poorly AND no pre-result.
    if (wellMatched.length === 0 && results.length > 0 && preResult === '') {
      postResult = `\n\n> **Tip:** Top results match only the first query token — for concept searches across signatures and bodies, try \`cartograph_explore\` with the same query.`;
    }
  }

  return { preResult, postResult };
}

/** Modes that go through dedicated sub-handlers (not the FTS-backed exact path). */
const ALTERNATE_SEARCH_MODES: ReadonlySet<unknown> = new Set(['fuzzy', 'semantic', 'intent']);
/** Every mode value handleSearch accepts (including the default). */
const ALL_SEARCH_MODES: ReadonlySet<unknown> = new Set(['exact', 'fuzzy', 'semantic', 'intent']);

/**
 * Render the empty-rows body for delta-mode searches where every hit
 * was already surfaced in a prior call. Split out from handleSearch's
 * inline ternary so the conditional doesn't carry the full template's
 * identifier set as "operands" (complex_conditional metric counts
 * every identifier in the conditional's subtree).
 */
function formatAllAlreadySeenBody(kind: string | undefined, totalBefore: number): string {
  const kindNote = kind ? ` (kind=${kind})` : '';
  const plural = totalBefore === 1 ? '' : 's';
  return `## Search Results (0 new)${kindNote}\n\n_All ${totalBefore} hit${plural} were already returned in the prior call._`;
}

/**
 * Validate `mode` and dispatch fuzzy/semantic delegates. Returns a
 * delegated {@link ToolOutcome} (or `err` arm) when the mode resolved
 * elsewhere, or null when the caller should continue with the default
 * exact path.
 */
async function dispatchSearchMode(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome | null> {
  const mode = args['mode'];
  // Delta mode (#16) is wired only into mode='exact' — fuzzy + semantic
  // delegates render different row shapes and don't participate in
  // call-id chaining yet. Refuse loudly rather than silently swallowing
  // `since` and emitting unfiltered results without a footer.
  if (ALTERNATE_SEARCH_MODES.has(mode) && args['since'] !== undefined) {
    return err(
      `cartograph_find (by='name'): \`since\` (delta mode) is supported only with \`mode='exact'\` (default). ` +
        `Re-run without \`since\`, or switch to \`mode='exact'\`.`,
    );
  }
  // The `fuzzy` / `semantic` / `intent` sub-handlers are all converted
  // and return a typed `ToolOutcome` directly — no `ok(...)` wrap.
  if (mode === 'fuzzy') return handleSearchFuzzy(ctx, args);
  if (mode === 'semantic') return handleSearchSemantic(ctx, args);
  if (mode === 'intent') return handleSearchIntent(ctx, args);
  if (mode !== undefined && !ALL_SEARCH_MODES.has(mode)) {
    return err(
      `cartograph_find (by='name'): \`mode\` must be one of: 'exact' (name + FTS query lang), 'fuzzy' (name with typos), 'semantic' (concept via embeddings), 'intent' (behavior via summaries + docstrings + test descriptions). ` +
        `Got ${JSON.stringify(mode)}.`,
    );
  }
  return null;
}

/**
 * Re-rank raw FTS hits so prod paths come first while preserving each
 * group's relative order. Fixtures still surface when the query
 * legitimately matches only test paths — they're demoted, not dropped.
 */
function reorderProdFirst(rawResults: SearchResult[], limit: number): SearchResult[] {
  const prodHits = rawResults.filter((r) => !isTestPath(r.node.filePath));
  const fixtureHits = rawResults.filter((r) => isTestPath(r.node.filePath));
  return [...prodHits, ...fixtureHits].slice(0, limit);
}

function canonicalToolNameLiteral(query: string): string | null {
  const trimmed = query.trim();
  return /^cartograph_[a-z0-9_]+$/.test(trimmed) ? trimmed : null;
}

function isCanonicalToolConstantHit(result: SearchResult, canonicalToolName: string): boolean {
  const { node } = result;
  if (node.kind !== 'constant') return false;
  if (!node.name.endsWith('_TOOL')) return false;
  return Boolean(node.signature?.includes(`name: '${canonicalToolName}'`));
}

function prioritizeCanonicalToolNameResults(query: string, results: SearchResult[]): SearchResult[] {
  const canonicalToolName = canonicalToolNameLiteral(query);
  if (!canonicalToolName) return results;
  const toolHits = results.filter((r) => isCanonicalToolConstantHit(r, canonicalToolName));
  if (toolHits.length === 0) return results;
  const toolIds = new Set(toolHits.map((r) => r.node.id));
  return [...toolHits, ...results.filter((r) => !toolIds.has(r.node.id))];
}

/**
 * Map a `CentralityFilter` op into the SQL `WHERE centrality <op> ?`
 * fragment. `>` / `>=` reject NULL-centrality nodes; `<` / `<=` keep
 * them — same biased semantics as `applyCentralityFilter` in
 * `queries-search.ts`. Returns the operator string only; the numeric
 * value is always bound by the caller.
 */
function centralitySqlOp(cf: CentralityFilter): string {
  switch (cf.op) {
    case '>':
      return '>';
    case '>=':
      return '>=';
    case '<':
      return '<';
    case '<=':
      return '<=';
  }
}

/**
 * Direct-SQL fast path used when the parsed query carries
 * `centrality:<op><value>` and NO free-text portion (`kind:function
 * centrality:>0.05`, `centrality:>0 sort:centrality`, etc.). The full
 * `searchNodes` pipeline post-filters centrality AFTER a 1500-row
 * alphabetical cascade — on big repos the cascade fills with import
 * rows ordered like `../../...` and the real high-centrality methods
 * never make it through. This helper pushes the centrality predicate
 * (plus kind / language) into the WHERE clause so SQLite ranks every
 * node, then we ORDER BY centrality DESC.
 *
 * Hard filters that `searchNodes` does in JS (`path:`, `name:`,
 * `sig:`, `callers-of:`, `callees-of:`) are skipped here — they aren't
 * the bottleneck and routing through this fast path only when text is
 * empty + no graph qualifiers keeps the SQL trivially correct.
 */
interface CentralitySearchArgs {
  cg: import('../../index.js').default;
  cf: CentralityFilter;
  kinds: NodeKind[] | undefined;
  languages: Language[] | undefined;
  limit: number;
  sortByCentrality: boolean;
}

/** @internal — exported for unit testing the centrality push-down. */
export function runCentralityOnlySearch(args: CentralitySearchArgs): SearchResult[] {
  const { cg, cf, kinds, languages, limit } = args;
  const op = centralitySqlOp(cf);
  let sql = `SELECT * FROM nodes WHERE centrality IS NOT NULL AND centrality ${op} ?`;
  const params: (string | number)[] = [cf.value];
  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  if (languages && languages.length > 0) {
    sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
    params.push(...languages);
  }
  // Always ORDER BY centrality DESC — the user asked for "centrality
  // > X" with no text to score; surfacing the smallest of those first
  // would be surprising. `sortByCentrality` is currently always-on
  // for this path (no FTS score exists when text is empty); the param
  // is kept for forward-compatibility with future `sort:relevance`-
  // over-centrality behavior.
  sql += ' ORDER BY centrality DESC LIMIT ?';
  params.push(limit);
  const rows = cg.queries.db.prepare(sql).all(...params) as NodeRow[];
  return rows.map((row) => ({ node: rowToNode(row), score: row.centrality ?? 0 }));
}

/**
 * Should the centrality-pushdown fast path handle this query?
 * Triggered when (a) a centrality predicate is present, (b) the
 * free-text portion is empty (so we're not racing the FTS cascade),
 * and (c) no graph qualifiers are in play (those need their own
 * seed-id path which `searchNodes` already handles correctly).
 */
function shouldUseCentralityFastPath(parsed: ReturnType<typeof parseQuery>): boolean {
  return (
    parsed.centralityFilter !== undefined &&
    parsed.text === '' &&
    parsed.callersOf.length === 0 &&
    parsed.calleesOf.length === 0 &&
    parsed.dependsOn.length === 0
  );
}

/**
 * Identifier-ish token used for multi-name batch lookup: starts with
 * an ASCII letter or underscore, then alphanumeric / underscore. Matches
 * the conservative shape of a symbol name across every language
 * cartograph extracts — anything richer (dots, hyphens, brackets,
 * generics) is a sign the agent intended one richer query, not many
 * bare symbol names.
 */
const MULTI_NAME_TOKEN_RE = /^[A-Za-z_]\w*$/;

/**
 * Tokens that signal field-qualified FTS / boolean syntax. If ANY of
 * these characters / words appears, the query is treated as one rich
 * FTS phrase (legacy behavior) rather than a batch lookup. Keeps the
 * deliberate `name:foo path:src/` workflow unchanged.
 */
const MULTI_NAME_FTS_QUALIFIER_RE = /[:()]|\b(?:AND|OR|NOT|NEAR)\b/;

/**
 * Detect a multi-name batch query: ≥2 whitespace-separated bare
 * identifier tokens with no FTS qualifier in sight. Returns the
 * de-duplicated token list (preserving first-seen order) when this is
 * a multi-name query, or null otherwise. Single-word queries always
 * return null so the single-name path stays unchanged.
 */
/** @internal — exported for unit testing the multi-name detector. */
export function detectMultiNameQuery(query: string): string[] | null {
  if (MULTI_NAME_FTS_QUALIFIER_RE.test(query)) return null;
  const rawTokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (rawTokens.length < 2) return null;
  for (const t of rawTokens) {
    if (!MULTI_NAME_TOKEN_RE.test(t)) return null;
  }
  // De-duplicate, preserve first-seen order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of rawTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Strip standalone boolean operators (`AND` / `OR` / `NOT` / `NEAR`)
 * and collapse the resulting whitespace. Used by the dispatcher to
 * recover a multi-name disjunction (`Foo OR Bar`) into the per-token
 * union view — agents often type FTS5 boolean syntax expecting
 * disjunction, and the union view has the same semantics.
 *
 * Conservatively matches uppercase ONLY (FTS5 reserved words are
 * uppercase) so a lowercase identifier `or` / `and` / `not` (e.g. a
 * symbol literally named `not`) stays in the query.
 */
function stripBooleanOperators(query: string): string {
  return query
    .replaceAll(/\b(AND|OR|NOT|NEAR)\b/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Result of the OR-strip recovery attempt: tokens to route to the union
 * view, plus the set of standalone operators that were stripped (used by
 * the response renderer to surface the auto-recovery). */
interface MultiNameWithStrippedOps {
  tokens: string[];
  strippedOperators: string[];
}

/**
 * Two-step multi-name routing: try the query as-is, then retry after
 * stripping standalone boolean operators. Returns the tokens + the
 * (possibly empty) operator-strip set on success; null when neither
 * step yields a clean multi-name decomposition (the query falls through
 * to the FTS pipeline so the standard probe / empty-result hint chain
 * still fires).
 */
/** @internal — exported for unit testing. */
export function detectMultiNameQueryWithOperatorStrip(query: string): MultiNameWithStrippedOps | null {
  const direct = detectMultiNameQuery(query);
  if (direct !== null) return { tokens: direct, strippedOperators: [] };
  const ops = [...query.matchAll(/\b(AND|OR|NOT|NEAR)\b/g)].map((m) => m[1]!);
  if (ops.length === 0) return null;
  const stripped = stripBooleanOperators(query);
  const recovered = detectMultiNameQuery(stripped);
  if (recovered === null) return null;
  return { tokens: recovered, strippedOperators: [...new Set(ops)].sort((a, b) => Number(a > b) - Number(a < b)) };
}

/** One group of exact-name hits keyed by the input token. */
interface MultiNameGroup {
  token: string;
  nodes: Node[];
}

/**
 * Max length of a query token still treated as "very short" for the
 * short-token noise filter below. A 1-2 char token (`t`, `d`, `id`)
 * matches a swarm of throwaway single-letter locals that the indexer
 * records as their own `variable` / `parameter` / `constant` nodes —
 * exact name matches, technically, but useless union rows.
 */
const SHORT_TOKEN_MAX_LEN = 2;

/** Node kinds that, when the symbol itself has a 1-2 char name and is
 *  NOT exported, are almost always a throwaway local (loop counter,
 *  destructured temp). These are the union rows the short-token filter
 *  drops. Public symbols and all structural kinds (class / interface /
 *  type / function / …) are never dropped — a genuine short-but-real
 *  symbol survives. */
const SHORT_TOKEN_NOISE_KINDS: ReadonlySet<string> = new Set([
  'variable',
  'parameter',
  'constant',
  'field',
  'property',
]);

/**
 * Drop FTS-prefix-style noise from a SHORT-token (≤2 char) union group.
 *
 * `getNodesByName('t')` exact-matches every single-letter local the
 * indexer recorded as its own node — loop counters, destructured temps —
 * none of which the agent meant when it bare-typed `t` alongside real
 * symbol names. We keep a row only when it is plausibly a genuine
 * reference target: an exported symbol, OR any non-throwaway kind, OR a
 * node whose own name is longer than the token (so it isn't itself a
 * single-letter local). Everything else is discarded.
 *
 * Long tokens (≥3 char) are returned untouched — exact name collisions
 * there are real and rare.
 */
function filterShortTokenNoise(token: string, nodes: ReadonlyArray<Node>): Node[] {
  if (token.length > SHORT_TOKEN_MAX_LEN) return [...nodes];
  return nodes.filter((n) => {
    if (n.isExported) return true;
    if (!SHORT_TOKEN_NOISE_KINDS.has(n.kind)) return true;
    // A throwaway-kind node whose own name is also ≤2 chars is the
    // single-letter-local noise we're filtering out.
    return n.name.length > SHORT_TOKEN_MAX_LEN;
  });
}

/**
 * Look up each token via `getNodesByName` (exact name match, index-backed).
 * Each group is independent — a missing token returns an empty group so
 * the renderer can emit the `_no exact match_` placeholder.
 *
 * Very short tokens (1-2 chars) run through {@link filterShortTokenNoise}
 * so a bare `t` / `d` in a multi-name query doesn't drag a swarm of
 * single-letter throwaway locals into the union view.
 */
function gatherMultiNameGroups(
  cg: import('../../index.js').default,
  tokens: ReadonlyArray<string>,
  kindFilter: string | undefined,
): MultiNameGroup[] {
  const out: MultiNameGroup[] = [];
  for (const token of tokens) {
    let nodes = getNodesByName(cg.queries, token);
    if (kindFilter !== undefined) {
      nodes = nodes.filter((n) => n.kind === kindFilter);
    }
    nodes = filterShortTokenNoise(token, nodes);
    out.push({ token, nodes });
  }
  return out;
}

/**
 * Render one multi-name group in markdown shape. Mirrors
 * `formatSearchResults` per-row formatting so the union output looks
 * like N stacked single-name responses.
 */
function renderMultiNameGroupMarkdown(group: MultiNameGroup): string {
  const lines: string[] = [`### ${group.token} (${group.nodes.length} hit${group.nodes.length === 1 ? '' : 's'})`];
  if (group.nodes.length === 0) {
    lines.push('_no exact match — try mode:fuzzy_', '');
    return lines.join('\n');
  }
  for (const node of group.nodes) {
    const loc = node.startLine ? `:${node.startLine}` : '';
    const sig = node.signature ? ` \`${node.signature}\`` : '';
    lines.push(`- ${node.name} (${node.kind}) — ${node.filePath}${loc}${sig}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render one multi-name group in compact pipe-delimited shape. Mirrors
 * `formatSearchResultsCompact` per-row formatting. The group header is
 * preserved so the agent can distinguish union members even in compact
 * mode.
 */
function renderMultiNameGroupCompact(
  group: MultiNameGroup,
  fields: ReadonlyArray<SearchFieldName>,
  refIds: RefIdCache | undefined,
): string {
  const lines: string[] = [`### ${group.token} (${group.nodes.length})`];
  if (group.nodes.length === 0) {
    lines.push('_no exact match — try mode:fuzzy_');
    return lines.join('\n');
  }
  const fieldSet = new Set<string>(fields);
  for (const node of group.nodes) {
    lines.push(formatSearchCompactColumns(node, fieldSet, refIds));
  }
  return lines.join('\n');
}

/** Args bundle for the multi-name render pass. */
interface RenderMultiNameUnionArgs {
  groups: ReadonlyArray<MultiNameGroup>;
  kindFilter: string | undefined;
  isCompact: boolean;
  fields: ReadonlyArray<SearchFieldName> | null;
  refIds: RefIdCache | undefined;
}

/**
 * Compose the full multi-name union response body. The header counts
 * queries (groups) and total hits across the union so the agent gets a
 * one-line summary before the per-token breakdown.
 */
function renderMultiNameUnion(args: RenderMultiNameUnionArgs): string {
  const { groups, kindFilter, isCompact, fields, refIds } = args;
  const totalHits = groups.reduce((sum, g) => sum + g.nodes.length, 0);
  const kindNote = kindFilter ? ` (kind=${kindFilter})` : '';
  const header = `## Exact match union (${groups.length} queries, ${totalHits} hit${totalHits === 1 ? '' : 's'})${kindNote}`;
  const defaultFields: ReadonlyArray<SearchFieldName> = refIds
    ? ['name', 'kind', 'path', 'line', 'signature', 'id']
    : ['name', 'kind', 'path', 'line', 'signature'];
  const effectiveFields = isCompact && fields && fields.length > 0 ? fields : defaultFields;
  const body = groups
    .map((g) => (isCompact ? renderMultiNameGroupCompact(g, effectiveFields, refIds) : renderMultiNameGroupMarkdown(g)))
    .join('\n');
  return `${header}\n\n${body}`;
}

/**
 * Multi-name batch path for `by:'name'`, `mode:'exact'`. Activated by
 * `detectMultiNameQueryWithOperatorStrip` — short-circuits the FTS
 * pipeline so a query like `handleRole handleGraph handleStatus`
 * resolves each name and returns the union grouped by token instead of
 * being treated as one FTS phrase. `Foo OR Bar` auto-recovers through
 * the same path (`strippedOperators` arg surfaces the recovery in the
 * response).
 *
 * Honours `kind` (per-token filter), `compact` + `fields` (per-row
 * shape), and `pathFilter` (prefix-filters every group's hits). Delta
 * mode (`since`) is NOT plumbed through this path — multi-name lookups
 * are read-only "give me everything" queries and the call-id machinery
 * is tuned for repeated single-query pagination; threading it through
 * the union view would lock the cache to a token order the agent may
 * not preserve.
 */
interface HandleMultiNameExactArgs {
  ctx: ToolCtx;
  args: Record<string, unknown>;
  tokens: ReadonlyArray<string>;
  /** FTS5 boolean operators stripped by the auto-recovery pre-pass; surface as a one-line caller note when non-empty. */
  strippedOperators?: ReadonlyArray<string>;
}

async function handleMultiNameExact(a: HandleMultiNameExactArgs): Promise<ToolResult> {
  const { ctx, args, tokens } = a;
  const strippedOperators = a.strippedOperators ?? [];
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const kindFilter = typeof args['kind'] === 'string' ? args['kind'] : undefined;
  const groups = gatherMultiNameGroups(cg, tokens, kindFilter);
  const isCompact = args['compact'] === true;
  const fields = parseSearchFieldsArg(args['fields']);
  const unionBody = renderMultiNameUnion({
    groups,
    kindFilter,
    isCompact,
    fields,
    refIds: ctx.refIds,
  });
  // When the dispatcher recovered the multi-name decomposition by
  // stripping boolean operators, prepend a one-line note explaining
  // the auto-recovery so the agent learns the union view is the right
  // shape for disjunctions (rather than retrying `Foo OR Bar` as N
  // separate calls).
  let opNote = '';
  if (strippedOperators.length > 0) {
    opNote = `> Detected boolean operator${strippedOperators.length === 1 ? '' : 's'} (${strippedOperators.join(', ')}) — \`cartograph_find (by='name')\` does NOT parse FTS5 boolean syntax. Stripped and routed to the per-token union view below — same semantics as the disjunction you likely wanted, in one call.\n\n`;
  }
  const body = opNote + unionBody;
  // Stale-files note keys off the rendered nodes so the agent sees the
  // same drift signal as a single-name call. Flatten across groups.
  // The P5 chokepoint owns truncation + freshness placement.
  const allNodes = groups.flatMap((g) => g.nodes);
  return renderToolResponse({ body, freshness: { cg, nodes: allNodes } });
}

/** Args for {@link fetchExactSearchResults}. */
interface FetchExactSearchResultsArgs {
  cg: import('../../index.js').default;
  query: string;
  kind: string | undefined;
  pathFilter: string | undefined;
  limit: number;
}

/** Return type for {@link fetchExactSearchResults}. */
interface ExactSearchResults {
  rawResults: SearchResult[];
  fullResults: SearchResult[];
}

/**
 * Run the FTS or centrality-pushdown query and re-rank prod results
 * first. Returns the over-fetched `rawResults` (used for hasMore
 * detection) and the prod-first trimmed `fullResults`.
 *
 * Extracted from {@link handleFindByName} so the centrality ternary
 * doesn't roll into the parent's cyclomatic count.
 */
function fetchExactSearchResults(args: FetchExactSearchResultsArgs): ExactSearchResults {
  const { cg, query, kind, pathFilter, limit } = args;
  // Over-fetch a wider candidate set so the post-fetch prod/test re-rank
  // can pull a real prod hit ahead of test-bed/fixture noise.
  const fetchLimit = Math.min(limit * SEARCH_OVERFETCH_MULTIPLIER, MAX_SEARCH_LIMIT);
  const kinds = kind ? [kind as NodeKind] : undefined;
  // Centrality fast path (Task #14 fix): `searchNodes` post-filters
  // centrality AFTER an alphabetical 1500-row cascade, so high-
  // centrality methods in a 10k-node repo get crowded out by import
  // rows ordered like `../...js`. When the query is centrality-only
  // (no text / no graph qualifiers), push the predicate into SQL.
  const parsed = parseQuery(query);
  const rawResults =
    shouldUseCentralityFastPath(parsed) && pathFilter === undefined
      ? runCentralityOnlySearch({
          cg,
          cf: parsed.centralityFilter!,
          kinds: parsed.kinds.length > 0 ? parsed.kinds : kinds,
          languages: parsed.languages.length > 0 ? parsed.languages : undefined,
          limit: fetchLimit,
          sortByCentrality: parsed.sortBy === 'centrality',
        })
      : searchNodes(
          cg.queries,
          query,
          compact({ limit: fetchLimit, kinds, pathPrefixes: pathFilter === undefined ? undefined : [pathFilter] }),
        );
  const rankedResults = prioritizeCanonicalToolNameResults(query, rawResults);
  const fullResults = reorderProdFirst(rankedResults, limit);
  return { rawResults, fullResults };
}

/** Args for {@link buildFindByNameBody}. */
interface BuildFindByNameBodyArgs {
  results: SearchResult[];
  allAlreadySeen: boolean;
  kind: string | undefined;
  totalBefore: number;
  query: string;
  isCompact: boolean;
  fields: ReadonlyArray<SearchFieldName> | null;
  refIds: RefIdCache | undefined;
}

/**
 * Compose the response body text: either the "all already seen"
 * placeholder or the formatted result rows, wrapped with concept and
 * boolean-operator hints.
 *
 * Extracted from {@link handleFindByName} so the hint-prefix ternary
 * and the allAlreadySeen branch don't accumulate in the parent's
 * cyclomatic complexity.
 */
/** Args for {@link buildSearchResultsBody}. */
interface BuildSearchResultsBodyArgs {
  results: SearchResult[];
  kind: string | undefined;
  isCompact: boolean;
  fields: ReadonlyArray<SearchFieldName> | null;
  refIds: RefIdCache | undefined;
}

/**
 * Build the formatted body for non-empty, non-already-seen results.
 * Constructs `FormatSearchResultsOpts` imperatively (plain `if`
 * assignments) so the conditional spreads that inflated
 * complex_conditional in `buildFindByNameBody` are gone from its tree.
 */
function buildSearchResultsBody(args: BuildSearchResultsBodyArgs): string {
  const { results, kind, isCompact, fields, refIds } = args;
  // Stage 6 #6.1 / #6.3 — compact + field-projection rendering. Only
  // effective on mode='exact' (default); fuzzy/semantic/intent dispatch
  // earlier and have their own row shapes. `fields:` is silently
  // ignored when `compact:false` to keep the default surface unchanged.
  const opts: FormatSearchResultsOpts = { results, kindFilter: kind, refIds };
  if (isCompact) opts.compact = true;
  if (fields) opts.fields = fields;
  return formatSearchResults(opts);
}

/**
 * Wrap a result body with the boolean-operator prefix and the
 * pre/post concept hints. The pre-result hint is promoted to the top
 * when present; the post-result hint trails otherwise.
 *
 * Extracted from {@link buildFindByNameBody} so the two-ternary hint
 * composition doesn't accumulate in that function's conditional tree.
 */
function applyHintWrap(body: string, query: string, results: SearchResult[]): string {
  const hints = buildConceptHintIfNeeded(query, results);
  // Boolean-operator hint: surface when the query contains AND/OR/NOT/NEAR
  // even when FTS happened to return results — these tokens are stripped
  // before matching, so the apparent "disjunction" is incidental and the
  // user likely wanted separate per-term calls.
  const booleanOpHint = probeBooleanOperatorCulprit(query);
  const booleanOpPrefix = booleanOpHint ? `> ${booleanOpHint}\n\n` : '';
  // Promote pre-result hint to the top; otherwise append post-result hint.
  if (hints.preResult !== undefined && hints.preResult.length > 0) {
    return `${booleanOpPrefix}${hints.preResult}\n\n${body}`;
  }
  return booleanOpPrefix + body + hints.postResult;
}

function buildFindByNameBody(args: BuildFindByNameBodyArgs): string {
  const { results, allAlreadySeen, kind, totalBefore, query, isCompact, fields, refIds } = args;
  const body = allAlreadySeen
    ? formatAllAlreadySeenBody(kind, totalBefore)
    : buildSearchResultsBody({ results, kind, isCompact, fields, refIds });
  return applyHintWrap(body, query, results);
}

export async function handleFindByName(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const dispatched = await dispatchSearchMode(ctx, args);
  if (dispatched !== null) return dispatched;

  const query = validateStringOutcome({ value: args['query'], name: 'query' });
  if (typeof query !== 'string') return query;

  // Multi-name batch path: `handleRole handleGraph handleStatus` →
  // union of N exact-name lookups grouped by token. Triggers only on
  // mode='exact' (default — fuzzy / semantic / intent dispatched
  // earlier in `dispatchSearchMode`) when the query is 2+ bare
  // identifier tokens with no FTS qualifier. Field-qualified queries
  // (`name:foo path:src/`) and single-name queries pass through
  // unchanged to the FTS pipeline below.
  //
  // Delta mode (`since`) is incompatible with the union view — the
  // cached call-id is tuned for one ranked list, not N independent
  // groups. Fall through to the FTS pipeline so the agent gets the
  // documented "since UID is no longer cached" behavior instead of
  // a silent semantics change.
  if (args['since'] === undefined) {
    const multiName = detectMultiNameQueryWithOperatorStrip(query);
    if (multiName !== null) {
      const { tokens, strippedOperators } = multiName;
      return ok(await handleMultiNameExact({ ctx, args, tokens, strippedOperators }));
    }
  }

  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const kind = args['kind'] as string | undefined;
  const pathFilter = args['pathFilter'] as string | undefined;
  const requestedLimit = numArg(args['limit'], DEFAULT_SEARCH_LIMIT);
  const limit = clamp(requestedLimit, 1, MAX_SEARCH_LIMIT);
  // Surface an over-max clamp (audit-4 #9): a `--limit` above the
  // per-axis max is otherwise silently capped, leaving the header
  // `(N found)` ambiguous between "exactly N exist" and "limit hit".
  // Emitted as a chokepoint footer — no leading blank line; the
  // chokepoint owns footer separation.
  const limitClampNote =
    requestedLimit > MAX_SEARCH_LIMIT
      ? `> Requested limit ${Math.floor(requestedLimit)} exceeds the max of ${MAX_SEARCH_LIMIT} for by='name'; showing ${MAX_SEARCH_LIMIT}.`
      : '';

  const { rawResults, fullResults } = fetchExactSearchResults({ cg, query, kind, pathFilter, limit });
  if (fullResults.length === 0) return ok(buildEmptyResultsResponse(cg, query, kind));

  // Delta-mode (#16): when the agent passes `since=c_xxxx`, filter
  // out rows whose node id appeared in the prior cached call.
  const rowKey = (r: SearchResult) => r.node.id;
  const delta = applyDeltaSince({ callIds: ctx.callIds, sinceArg: args['since'], rows: fullResults, rowKey });
  const results = delta.rows;

  // hasMore signal: the over-fetch returned more candidates than the
  // user-facing limit. Computed against the unfiltered set — the
  // agent's hint should reflect the underlying query, not the delta.
  const hasMore = rawResults.length > fullResults.length;
  // Stage 6 #6.1 / #6.3 — `compact` local name avoids shadowing the
  // `compact` utility import used in fetchExactSearchResults above.
  const isCompact = args['compact'] === true;
  const fields = parseSearchFieldsArg(args['fields']);
  const hintText = buildFindByNameBody({
    results,
    allAlreadySeen: results.length === 0,
    kind,
    totalBefore: delta.totalBefore,
    query,
    isCompact,
    fields,
    refIds: ctx.refIds,
  });
  // Per-axis call-id scope: UIDs from `by:'name'` must not collide
  // with UIDs from `by:'content'` etc. Distinct scope names keep
  // the delta-mode cache addressable per-backend even though they
  // all live under one MCP tool name now.
  const newCallId = mintCallId({
    callIds: ctx.callIds,
    toolName: 'cartograph_find:name',
    currentKeys: fullResults.map(rowKey),
    priorKeys: delta.priorKeys,
  });
  const sinceMeta = buildSearchSinceMeta(delta, results.length);
  // P5 chokepoint: the delta-summary header describes the rows that
  // follow, so it stays in the BODY; the `more results` hint, the
  // over-max limit-clamp note, and the call-id marker are FOOTERS the
  // chokepoint places after truncation. Freshness (the stale-files
  // note) is computed by the chokepoint against the result nodes.
  const { header, marker } = splitCallIdFooter(newCallId, sinceMeta);
  const body = header + hintText;
  return ok(
    renderToolResponse({
      body,
      footers: [hasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined, limitClampNote, marker],
      freshness: { cg, nodes: results.map((r) => r.node) },
    }),
  );
}

/** Optional `since` metadata footer for search. */
function buildSearchSinceMeta(
  delta: ReturnType<typeof applyDeltaSince<SearchResult>>,
  newCount: number,
): { newCount: number; totalBefore: number; sinceUid: string; sinceMissing: boolean } | undefined {
  if (delta.sinceUid === null) return undefined;
  return {
    newCount,
    totalBefore: delta.totalBefore,
    sinceUid: delta.sinceUid,
    sinceMissing: delta.sinceMissing,
  };
}

// SEARCH_TOOL removed — registration now lives in `find.ts` (FIND_TOOL).
// The handler is exported as `handleFindByName` and reachable only
// through the family dispatcher when `by === 'name'`.
