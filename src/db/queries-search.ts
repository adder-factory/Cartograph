/**
 * Search queries — name lookups (exact / qualified / lower), the
 * full hybrid `searchNodes` pipeline (FTS + LIKE + fuzzy + exact-name
 * supplements + multi-signal scoring + filter pass), the suggester
 * for "did you mean…?" misses, and the helpers that back specific
 * MCP/CLI tools (`findNodesByExactName`, `findNodesByNameSubstring`).
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain search helpers as direct members. The functions
 * read the `nodes` (+ FTS) and `edges` tables via the `@internal`-
 * tagged `db` and `stmts` fields on the parent `QueryBuilder`.
 */

import type { Node, NodeKind, EdgeKind, Language, SearchOptions, SearchResult } from '../types.js';
import { compact } from '../utils.js';
import {
  kindBonus,
  nameMatchBonus,
  scorePathRelevance,
  filterStopwords,
  diversifyByFile,
  dotQualifiedBonus,
  parseDotQualified,
  isRouteShapedQuery,
} from '../search/query-utils.js';
import { parseQuery, isSubsequence, longestCommonSubstring } from '../search/query-parser.js';
import { boundedEditDistance } from '../text-distance.js';
import { z } from 'zod';
import { type QueryBuilder, type NodeRow, rowToNode } from './queries.js';
import { defineQuery, defineDynamicQuery, type TypedQuery, type DynamicTypedQuery } from './typed-query.js';

// ─── Zod schemas + typed queries (module-level; bound per-DB lazily) ──────

/**
 * SQLite-side `nodes` row shape. Mirrors the {@link NodeRow} interface
 * exported from `queries.ts`. Drift between the two — a new nullable
 * column added to `NodeRow` but missed here — surfaces as a row-validation
 * failure on the first `searchQuery.all(...)` call rather than as a silent
 * shape mismatch at the call sites that downcast.
 */
const NodeRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  file_path: z.string(),
  language: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  start_column: z.number(),
  end_column: z.number(),
  docstring: z.string().nullable(),
  signature: z.string().nullable(),
  visibility: z.string().nullable(),
  is_exported: z.number(),
  is_async: z.number(),
  is_static: z.number(),
  decorators: z.string().nullable(),
  decorator_args: z.string().nullable(),
  updated_at: z.number(),
  centrality: z.number().nullable(),
  betweenness: z.number().nullable(),
  body_hash: z.string(),
}) satisfies z.ZodType<NodeRow>;

const getNodesByNameQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE name = @name',
  params: z.object({ name: z.string() }),
  row: NodeRowSchema,
});

const getNodesByQualifiedNameExactQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE qualified_name = @qualifiedName',
  params: z.object({ qualifiedName: z.string() }),
  row: NodeRowSchema,
});

const getNodesByLowerNameQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE lower(name) = @lowerName',
  params: z.object({ lowerName: z.string() }),
  row: NodeRowSchema,
});

/** B25 (2026-05-24) — `(name, file_path)` exact lookup. Replaces the
 *  whole-project `getNodesByName` + JS `.filter((n) => n.filePath === filePath)`
 *  pattern that ran in `lookupSymbolByNameInFile`. On a 329K-node /
 *  39K-file graph that pattern returned hundreds of rows for common
 *  names (`log` / `parse` / `run`) at 1-10 ms each; per-file scanners
 *  in Group B made millions of these calls and stalled the postHook
 *  for 10+ min. The composite filter pushes the predicate into SQL
 *  so the planner can use the existing `idx_nodes_name` index AND
 *  the equality on `file_path` to return at most a handful of rows.
 *  Limit 4 — caller takes the first; the cap is for the rare
 *  duplicate-symbol-in-same-file case. */
const getNodesByNameAndFileQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE name = @name AND file_path = @filePath LIMIT 4',
  params: z.object({ name: z.string(), filePath: z.string() }),
  row: NodeRowSchema,
});

/** Fetch every (name, id) pair for nodes declared in `filePath`. The
 *  shape powers the value-ref-edges hook's per-file name → id map:
 *  one query per file replaces ~30 per-name `getNodesByNameAndFile`
 *  calls per file, dropping the value-ref-edges wall on TS-scale
 *  corpora from ~63s to ~few seconds. The query returns `name` + `id`
 *  only (not the full Node row) so the bulk fetch stays cheap; the
 *  consumer needs `id` only for edge emission, with `name` as the
 *  lookup key. */
const getSymbolNameIndexByFileQuery = defineQuery({
  sql: 'SELECT name, id FROM nodes WHERE file_path = @filePath',
  params: z.object({ filePath: z.string() }),
  row: z.object({ name: z.string(), id: z.string() }),
});

// Static FTS5 MATCH query — the hand-tuned phrase pattern is built at
// the call site from a pre-validated bare identifier and bound as a
// param, so the SQL string itself is constant.
const findSignatureTokenOwnerQuery = defineQuery({
  sql: `
    SELECT nodes.* FROM nodes_fts
    JOIN nodes ON nodes_fts.id = nodes.id
    WHERE nodes_fts MATCH @match
    ORDER BY bm25(nodes_fts) LIMIT 10
  `,
  params: z.object({ match: z.string() }),
  row: NodeRowSchema,
});

// ─── Pattern-A typed queries (Phase 2 migrations) ────────────────────────
//
// json_each(@jsonArray) — variable IN-lists with a single JSON-stringified
// param. Eliminates the per-call placeholder concat AND the SQLite
// SQLITE_LIMIT_VARIABLE_NUMBER ceiling that forced 900-element chunking.

const nodesByIdsBulkQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(@idsJson))',
  params: z.object({ idsJson: z.string() }),
  row: NodeRowSchema,
});

const nodesCallingAnyQuery = defineQuery({
  sql: `
    SELECT DISTINCT e.source AS id
    FROM edges e
    JOIN nodes tgt ON e.target = tgt.id
    WHERE e.kind = 'calls' AND tgt.name IN (SELECT value FROM json_each(@namesJson))
  `,
  params: z.object({ namesJson: z.string() }),
  row: z.object({ id: z.string() }),
});

const nodesCalledByAnyQuery = defineQuery({
  sql: `
    SELECT DISTINCT e.target AS id
    FROM edges e
    JOIN nodes src ON e.source = src.id
    WHERE e.kind = 'calls' AND src.name IN (SELECT value FROM json_each(@namesJson))
  `,
  params: z.object({ namesJson: z.string() }),
  row: z.object({ id: z.string() }),
});

declare module './queries.js' {
  interface QueryRegistry {
    getNodesByName?: TypedQuery<{ name: string }, NodeRow>;
    getNodesByNameAndFile?: TypedQuery<{ name: string; filePath: string }, NodeRow>;
    getSymbolNameIndexByFile?: TypedQuery<{ filePath: string }, { name: string; id: string }>;
    getNodesByQualifiedNameExact?: TypedQuery<{ qualifiedName: string }, NodeRow>;
    getNodesByLowerName?: TypedQuery<{ lowerName: string }, NodeRow>;
    findSignatureTokenOwner?: TypedQuery<{ match: string }, NodeRow>;
    nodesByIdsBulk?: TypedQuery<{ idsJson: string }, NodeRow>;
    nodesCallingAny?: TypedQuery<{ namesJson: string }, { id: string }>;
    nodesCalledByAny?: TypedQuery<{ namesJson: string }, { id: string }>;
  }
}

/**
 * Argument bundle for `addSupplementCandidates`. Bundling lets the
 * helper take a single `p` parameter instead of 8 positional args.
 */
interface SupplementParams {
  /** SQL match shape — `eq` for exact name match, `like` for substring. */
  predicate: 'eq' | 'like';
  /** Names / substrings to fan out queries for. */
  values: string[];
  /** Optional `kind IN (…)` filter applied to every supplement query. */
  kinds: NodeKind[] | undefined;
  /** Optional `language IN (…)` filter applied to every supplement query. */
  languages: string[] | undefined;
  /** Per-query LIMIT. Currently safe-interpolated (numeric literals only). */
  limit: number;
  /** Sink — newly-found rows are pushed here as `{ node, score: baseScore }`. */
  results: SearchResult[];
  /** Dedup set; populated rows skip insertion. Mutated by the helper. */
  existingIds: Set<string>;
  /** Score assigned to every supplement-found row. Caller's
   *  multi-signal pass adds bonuses on top. */
  baseScore: number;
}

// ── findNodesByExactName tunables ──────────────────────────────────────────
/** Default cap on returned results when caller doesn't pass `options.limit`. */
const EXACT_NAME_DEFAULT_LIMIT = 50;
/** Floor on the per-name limit when N query terms split the budget. */
const MIN_PER_NAME_LIMIT = 8;
/** SQL constant emitted as the base score for every exact-name match. */
const EXACT_MATCH_SCORE = 1;
/** Multiplier on perNameLimit for the SQL fetch — overfetch so co-location boosts can surface. */
const PER_NAME_FETCH_MULTIPLIER = 3;
/** Score bonus applied when a result lives in a "distinctive" file (see findDistinctiveFiles). */
const CO_LOCATION_BOOST = 20;
/** SQL LIMIT (100) on pass-1's file scan — keeps pathologically common names like "run" bounded. */
const PASS1_FILE_LIMIT = 100;
/** A name appearing in fewer than this many files is "distinctive" (a strong disambiguator). */
const DISTINCTIVE_FILE_CAP = 10;

// ── suggestSymbolNames tunables ────────────────────────────────────────────
/** Default suggestion count for `suggestSymbolNames`. */
const SUGGEST_DEFAULT_LIMIT = 3;
/** Minimum query length below which `suggestSymbolNames` returns []. */
const SUGGEST_MIN_QUERY_LEN = 3;
/** Divisor that scales the edit-distance budget with query length (looser than `searchNodesFuzzy`). */
const SUGGEST_EDIT_DIST_DIVISOR = 3;
/** Hard ceiling on the edit-distance budget regardless of query length. */
const SUGGEST_MAX_EDIT_DIST = 5;
/** A subsequence/substring match on a name N×× longer than the query is coincidence; cap at this multiplier. */
const SUGGEST_LENGTH_CAP_MULT = 4;
/** Distance offset added to substring matches so they sort after edit + subsequence matches. */
const SUGGEST_SUBSTR_OFFSET = 100;
/** Minimum shared-substring length for the longest-common-substring fallback to fire. */
const SUGGEST_MIN_SUBSTR = 4;
/**
 * Distance offset for the verbatim-containment tier (the query appears
 * verbatim inside the candidate name). Sits past SUGGEST_MAX_EDIT_DIST
 * so the row renders as "(token match)" rather than a misleading
 * "(edit-dist N)". Cross-tier ordering in `suggestSymbolNames` is by
 * concatenation, so this value only has to clear the edit-distance
 * ceiling for the display label — it does not drive the sort.
 */
const SUGGEST_CONTAINMENT_OFFSET = SUGGEST_MAX_EDIT_DIST + 1;

// Note: the prior `SQLITE_VAR_LIMIT` / `chunkIds` chunking utility was
// removed in the Phase 2 typed-query migration (2026-05-20). The
// chunked IN-lists are now expressed as `json_each(@jsonArray)` —
// `json_each` reads the JSON-stringified id/name list as a virtual
// table, so SQLite's per-statement bound-parameter cap no longer
// applies and a single query handles any input size.

/** Default rendered-row cap (100) applied to every public search entry point's `limit` option. */
const SEARCH_DEFAULT_LIMIT = 100;

/** Default per-file diversification cap — at most N hits per file
 *  in the rendered result set so a hub file doesn't dominate. */
const SEARCH_DEFAULT_PER_FILE_CAP = 3;

/** Hard cap on the cascade's internal over-fetch when centrality
 *  filtering / sorting is in play; bounds SQL time on large repos. */
const SEARCH_CASCADE_LIMIT_CAP = 5000;

/** Multiplier applied to the user-facing limit to size the cascade
 *  pool when centrality post-filtering needs headroom. */
const SEARCH_CASCADE_LIMIT_MULTIPLIER = 50;

/** Floor for the cascade pool — never under-fetch this many
 *  candidates regardless of how small the user-facing limit is. */
const SEARCH_CASCADE_LIMIT_FLOOR = 1000;

/**
 * Get nodes by exact name match (uses idx_nodes_name index)
 */
export function getNodesByName(qb: QueryBuilder, name: string): Node[] {
  qb.queries.getNodesByName ??= getNodesByNameQuery(qb.db);
  const rows = qb.queries.getNodesByName.all({ name });
  return rows.map(rowToNode);
}

/**
 * Get nodes by exact (name, file_path) match — the tight SQL-side
 * filter that {@link getNodesByName} + JS `.filter` was emulating
 * inefficiently for every per-file edge-resolution call. B25
 * (2026-05-24) — replaces the dominant cost of `value-ref-edges` /
 * `dynamic-import-edges` / `re-export-edges` on JS/TS-heavy repos.
 */
export function getNodesByNameAndFile(qb: QueryBuilder, name: string, filePath: string): Node[] {
  qb.queries.getNodesByNameAndFile ??= getNodesByNameAndFileQuery(qb.db);
  const rows = qb.queries.getNodesByNameAndFile.all({ name, filePath });
  return rows.map(rowToNode);
}

/**
 * Build a `name → id` map for every node declared in `filePath`. One
 * call per file replaces the ~30 per-name `getNodesByNameAndFile`
 * calls per file the edge-emitting hooks were doing.
 *
 * Same-name collisions within a file (rare — overload-shape, e.g. an
 * exported function aliased to the same name as a private helper)
 * keep the FIRST id seen, matching the pre-2026-05-25 `[0]?.id`
 * semantics of the single-name path.
 */
export function getSymbolNameIndexByFile(qb: QueryBuilder, filePath: string): Map<string, string> {
  qb.queries.getSymbolNameIndexByFile ??= getSymbolNameIndexByFileQuery(qb.db);
  const rows = qb.queries.getSymbolNameIndexByFile.all({ filePath });
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!out.has(r.name)) out.set(r.name, r.id);
  }
  return out;
}

/**
 * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
 */
export function getNodesByQualifiedNameExact(qb: QueryBuilder, qualifiedName: string): Node[] {
  qb.queries.getNodesByQualifiedNameExact ??= getNodesByQualifiedNameExactQuery(qb.db);
  const rows = qb.queries.getNodesByQualifiedNameExact.all({ qualifiedName });
  return rows.map(rowToNode);
}

/**
 * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
 */
export function getNodesByLowerName(qb: QueryBuilder, lowerName: string): Node[] {
  qb.queries.getNodesByLowerName ??= getNodesByLowerNameQuery(qb.db);
  const rows = qb.queries.getNodesByLowerName.all({ lowerName });
  return rows.map(rowToNode);
}

/**
 * Node kinds whose `signature` column can legitimately *own* a
 * parameter / destructured local. A `function` / `method` / `class`
 * (etc.) signature lists parameters; an `import` / `file` / `export` /
 * `module` / `namespace` node's signature does not — it holds a module
 * path or is empty. Citation grounding's tertiary "is this token a
 * real parameter?" pass must only consult the former: an `import`
 * node's signature containing the token (e.g. the import specifier
 * text) would otherwise mis-attribute a cited identifier to that
 * import, presenting a bogus "in the signature of `./foo`" line.
 */
const SIGNATURE_OWNER_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'constructor',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'type_alias',
  'enum',
  'component',
  'route',
]);

/**
 * Find an indexed node whose `signature` contains `token` as a whole
 * word. Used by citation grounding to recognise identifiers — typically
 * function parameters or destructured locals — that cartograph does NOT
 * index as their own nodes (only ~top-level symbols become nodes), yet
 * are demonstrably real code because they appear verbatim in some
 * symbol's signature. Lets the verifier tell them apart from genuine
 * hallucinations.
 *
 * Self-defending: returns null for any `token` that is not a bare
 * identifier (`[A-Za-z_]\w*`). A qualified name (`Foo.bar`)
 * would mis-tokenise into a misleading two-token phrase, so the guard
 * lives in the function rather than relying on callers. The FTS5
 * `signature:"..."` phrase query is column-scoped and word-boundary-
 * aware via the `unicode61` tokenizer, so it won't match `via` inside
 * `trivia`. Caveat: `unicode61` treats `_` as a separator, so an
 * underscore-joined identifier (`my_param`) is matched as its component
 * tokens — imprecise but acceptable; the camelCase parameters this
 * targets are unaffected.
 *
 * Restricted to {@link SIGNATURE_OWNER_KINDS}: an `import` / `file` /
 * `export` node can hold the token in its signature (a module path,
 * a re-export name) without that token being a parameter — matching
 * one mis-attributes the citation. The owner walk skips them and falls
 * through to the next-best FTS hit.
 *
 * Returns the best lexical-match owner (a recognisable container name
 * for the rendered message), or null when the token appears in no
 * signature-bearing symbol.
 */
export function findSignatureTokenOwner(qb: QueryBuilder, token: string): Node | null {
  // Only a bare identifier is safe to interpolate into the phrase query.
  if (!/^[A-Za-z_]\w*$/.test(token)) return null;
  // Fetch a small bm25-ranked window rather than just the top hit:
  // the best lexical match may be an import/file node we must skip,
  // and the genuine signature owner could be ranked just behind it.
  try {
    qb.queries.findSignatureTokenOwner ??= findSignatureTokenOwnerQuery(qb.db);
    const rows = qb.queries.findSignatureTokenOwner.all({ match: `signature:"${token}"` });
    for (const row of rows) {
      const node = rowToNode(row);
      if (SIGNATURE_OWNER_KINDS.has(node.kind)) return node;
    }
    return null;
  } catch {
    // Malformed FTS query (defensive — token is pre-validated as a bare
    // identifier) → treat as no match.
    return null;
  }
}

/**
 * Search nodes by name using FTS with fallback to LIKE for better matching
 *
 * Search strategy:
 * 1. Try FTS5 prefix match (query*) for word-start matching
 * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
 * 3. Score results based on match quality
 */
/**
 * Resolved query state — the parsed query merged with caller-supplied
 * SearchOptions and the lazy graph-memo helpers. `searchNodes` builds
 * one of these and threads it through the retrieval / scoring /
 * filter passes so each helper has the full context.
 */
interface ResolvedQuery {
  text: string;
  kinds: NodeKind[] | undefined;
  languages: Language[] | undefined;
  pathPrefixes: string[];
  pathFilters: string[];
  nameFilters: string[];
  signatureFilters: string[];
  callersOf: string[];
  calleesOf: string[];
  dependsOn: string[];
  callersSet: () => Set<string>;
  calleesSet: () => Set<string>;
  dependsOnSet: () => Set<string>;
  centralityFilter?: import('../search/query-parser.js').CentralityFilter;
  sortBy?: import('../search/query-parser.js').SortMode;
}

/** Retrieval execution context — the query-builder handle paired with
 *  its resolved query. Both are always needed together, so bundling
 *  them lets `runRetrievalCascade` take pagination as its only extra args. */
interface RetrievalCtx {
  qb: QueryBuilder;
  rq: ResolvedQuery;
}

/** Fuzzy-search query context — the query-builder handle paired with
 *  the normalised query string. Both are always needed together. */
interface FuzzyQueryCtx {
  qb: QueryBuilder;
  lowered: string;
}

/** Shared scan state for the suggestion-tier helpers. Bundles
 *  `allNames` (the full distinct-name corpus) and `seen` (names
 *  already committed to a higher tier) so each tier function takes
 *  a single state arg instead of two positional arrays. */
interface SuggestScanState {
  allNames: ReadonlyArray<string>;
  seen: Set<string>;
}

/** Scoring + diversification parameters for `scoreAndDiversify`. */
interface ScoringParams {
  scoringQuery: string;
  limit: number;
  perFileCap: number;
}

/**
 * Parse the field-qualified bits out of `query` (kind:/lang:/path:/
 * name:/sig:/callers-of:/callees-of:/depends-on:) and union them with
 * the caller-supplied `SearchOptions`. Filters compose intersection-
 * style; the graph-derived `callersSet`/`calleesSet`/`dependsOnSet`
 * are returned as lazy thunks so the SQL-only path doesn't pay for
 * graph traversal.
 */
function resolveSearchQuery(qb: QueryBuilder, query: string, options: SearchOptions): ResolvedQuery {
  const parsed = parseQuery(query);
  const kinds =
    parsed.kinds.length > 0 ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds])) : options.kinds;
  const languages =
    parsed.languages.length > 0
      ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
      : options.languages;
  const pathFilters =
    options.pathFilters && options.pathFilters.length > 0
      ? Array.from(new Set([...parsed.pathFilters, ...options.pathFilters]))
      : parsed.pathFilters;
  const pathPrefixes = options.pathPrefixes ? Array.from(new Set(options.pathPrefixes)) : [];
  let cachedCallersSet: Set<string> | null = null;
  let cachedCalleesSet: Set<string> | null = null;
  let cachedDependsOnSet: Set<string> | null = null;
  return {
    text: parsed.text,
    kinds,
    languages,
    pathPrefixes,
    pathFilters,
    nameFilters: parsed.nameFilters,
    signatureFilters: parsed.signatureFilters,
    callersOf: parsed.callersOf,
    calleesOf: parsed.calleesOf,
    dependsOn: parsed.dependsOn,
    callersSet: () => {
      cachedCallersSet ??= nodesCallingAny(qb, parsed.callersOf);
      return cachedCallersSet;
    },
    calleesSet: () => {
      cachedCalleesSet ??= nodesCalledByAny(qb, parsed.calleesOf);
      return cachedCalleesSet;
    },
    dependsOnSet: () => {
      cachedDependsOnSet ??= nodesDependingOnAny(qb, parsed.dependsOn);
      return cachedDependsOnSet;
    },
    ...(parsed.centralityFilter ? { centralityFilter: parsed.centralityFilter } : {}),
    ...(parsed.sortBy ? { sortBy: parsed.sortBy } : {}),
  };
}

/**
 * Run the retrieval cascade: FTS5 first, fall back to LIKE substring
 * for short stems, then fuzzy Levenshtein when both come up empty.
 * Each tier requires progressively more text to fire (LIKE >=2 chars,
 * fuzzy >=3) — guards against single-letter queries triggering a
 * full-table scan.
 */
function runRetrievalCascade(ctx: RetrievalCtx, limit: number, offset: number): SearchResult[] {
  const { qb, rq } = ctx;
  let results = selectInitialResults(qb, {
    text: rq.text,
    kinds: rq.kinds,
    languages: rq.languages,
    limit,
    offset,
    callersOf: rq.callersOf,
    calleesOf: rq.calleesOf,
    dependsOn: rq.dependsOn,
    signatureFilters: rq.signatureFilters,
    nameFilters: rq.nameFilters,
    callersSet: rq.callersSet,
    calleesSet: rq.calleesSet,
    dependsOnSet: rq.dependsOnSet,
  });
  if (results.length === 0 && rq.text.length >= 2) {
    results = searchNodesLike(qb, rq.text, compact({ kinds: rq.kinds, languages: rq.languages, limit, offset }));
  }
  if (results.length === 0 && rq.text.length >= 3) {
    results = searchNodesFuzzy(qb, rq.text, compact({ kinds: rq.kinds, languages: rq.languages, limit }));
  }
  return results;
}

/**
 * Multi-signal score + per-file diversification. Bonuses cover kind
 * priority, path relevance, name-match shape, and the dotted-qualified
 * boost. Diversification kicks in only when results overflow the
 * caller's `limit` — the rescore order is meaningful and we don't
 * shuffle it without benefit.
 */
function scoreAndDiversify(results: SearchResult[], p: ScoringParams): SearchResult[] {
  const { scoringQuery, limit, perFileCap } = p;
  if (results.length > 0 && scoringQuery) {
    results = results.map((r) => ({
      ...r,
      score:
        r.score +
        kindBonus(r.node.kind) +
        scorePathRelevance(r.node.filePath, scoringQuery) +
        nameMatchBonus(r.node.name, scoringQuery) +
        dotQualifiedBonus(r.node.name, r.node.filePath, scoringQuery),
    }));
    results.sort((a, b) => b.score - a.score);
  }
  if (perFileCap > 0 && results.length > limit) {
    return diversifyByFile(results, limit, perFileCap);
  }
  if (results.length > limit) {
    return results.slice(0, limit);
  }
  return results;
}

export function searchNodes(qb: QueryBuilder, query: string, options: SearchOptions = {}): SearchResult[] {
  const { limit = SEARCH_DEFAULT_LIMIT, offset = 0, perFileCap = SEARCH_DEFAULT_PER_FILE_CAP } = options;
  const rq = resolveSearchQuery(qb, query, options);
  // Centrality filter and sort:centrality are post-cascade — they
  // can only see what the cascade returned. Over-fetch when either
  // is in play so a strict threshold (or "top by centrality") still
  // has a meaningful candidate pool to pick from. Cap to keep the SQL
  // bounded on large repos.
  const needsCentralityHeadroom = rq.centralityFilter !== undefined || rq.sortBy === 'centrality';
  const cascadeLimit = needsCentralityHeadroom
    ? Math.min(SEARCH_CASCADE_LIMIT_CAP, Math.max(limit * SEARCH_CASCADE_LIMIT_MULTIPLIER, SEARCH_CASCADE_LIMIT_FLOOR))
    : limit;
  let results = runRetrievalCascade({ qb, rq }, cascadeLimit, offset);
  if (results.length > 0 && query) {
    addExactNameSupplements({ qb, results, query, kinds: rq.kinds, languages: rq.languages });
  }
  // Pass the user-facing `limit` (not `cascadeLimit`) so the per-file
  // diversification guard fires correctly. cascadeLimit is the SQL
  // budget; diversification is about the surfaced output.
  results = scoreAndDiversify(results, { scoringQuery: rq.text || query, limit, perFileCap });
  results = applySearchHardFilters(results, {
    pathPrefixes: rq.pathPrefixes,
    pathFilters: rq.pathFilters,
    nameFilters: rq.nameFilters,
    signatureFilters: rq.signatureFilters,
    callersOf: rq.callersOf,
    calleesOf: rq.calleesOf,
    dependsOn: rq.dependsOn,
    callersSet: rq.callersSet,
    calleesSet: rq.calleesSet,
    dependsOnSet: rq.dependsOnSet,
  });
  if (rq.centralityFilter) results = applyCentralityFilter(results, rq.centralityFilter);
  if (rq.sortBy === 'centrality') results = sortByCentrality(results);
  if (needsCentralityHeadroom && results.length > limit) results = results.slice(0, limit);
  return results;
}

/**
 * Drop results whose centrality fails the comparison. Nodes with
 * NULL/undefined centrality (centrality hook hasn't run yet, or the
 * node was extracted-but-not-yet-ranked) are dropped on `>`/`>=`
 * filters and kept on `<`/`<=` — there's no defensible interpretation
 * of "this null is greater than 0.01", but "this null is less than
 * 0.5" reads naturally as "may be small enough."
 */
function applyCentralityFilter(
  results: SearchResult[],
  cf: import('../search/query-parser.js').CentralityFilter,
): SearchResult[] {
  return results.filter((r) => {
    const c = r.node.centrality;
    if (c === undefined || c === null) {
      return cf.op === '<' || cf.op === '<=';
    }
    switch (cf.op) {
      case '>':
        return c > cf.value;
      case '>=':
        return c >= cf.value;
      case '<':
        return c < cf.value;
      case '<=':
        return c <= cf.value;
    }
    // Exhaustive switch above — added explicit return so biome's
    // useIterableCallbackReturn doesn't trip on an unreachable fall-through.
    return false;
  });
}

/**
 * Stable sort by centrality DESC, NULLs last. Stability matters
 * because the agent often calls `sort:centrality` to RE-ORDER an
 * existing kind-or-text-narrowed result; a destabilising sort would
 * scramble the within-bucket order that scoreAndDiversify produced.
 *
 * Trade-off: this runs AFTER `scoreAndDiversify`'s per-file cap.
 * If a hub file has multiple high-centrality symbols, they will
 * surface consecutively in the centrality-sorted output even though
 * diversification just spread them out. That's intentional — when
 * the agent asked for centrality order, the cluster signal is the
 * point. To keep diversification dominant, drop `sort:centrality`
 * (default relevance order preserves the file cap).
 */
function sortByCentrality(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    const ca = a.node.centrality ?? Number.NEGATIVE_INFINITY;
    const cb = b.node.centrality ?? Number.NEGATIVE_INFINITY;
    if (ca === cb) return 0;
    return cb - ca;
  });
}

/**
 * Pick the seed result set BEFORE supplements / scoring / filters.
 * Three modes are mutually exclusive in priority order:
 *   1. text query → FTS5 prefix search
 *   2. graph-only query (callers-of: / callees-of: / depends-on:
 *      alone) → seed from the graph-derived id set, then post-filter
 *      by kind/lang since this path doesn't use the SQL WHERE the
 *      FTS path does.
 *   3. filter-only query (kind:/lang:/sig:) → SQL scan with
 *      `signatureLike` pushed down to match the JS post-filter's
 *      OR semantics.
 * Filter-only over-fetches 5× because path:/name: filters at the
 * end can be very selective.
 */
function selectInitialResults(
  qb: QueryBuilder,
  params: {
    text: string;
    kinds: NodeKind[] | undefined;
    languages: Language[] | undefined;
    limit: number;
    offset: number;
    callersOf: string[];
    calleesOf: string[];
    dependsOn: string[];
    signatureFilters: string[];
    nameFilters: string[];
    callersSet: () => Set<string>;
    calleesSet: () => Set<string>;
    dependsOnSet: () => Set<string>;
  },
): SearchResult[] {
  const {
    text,
    kinds,
    languages,
    limit,
    offset,
    callersOf,
    calleesOf,
    dependsOn,
    signatureFilters,
    nameFilters,
    callersSet,
    calleesSet,
    dependsOnSet,
  } = params;

  if (text) {
    return searchNodesFTS(qb, text, compact({ kinds, languages, limit, offset }));
  }

  if (callersOf.length > 0 || calleesOf.length > 0 || dependsOn.length > 0) {
    return seedFromGraphQualifierUnion(qb, {
      callersOf,
      calleesOf,
      dependsOn,
      callersSet,
      calleesSet,
      dependsOnSet,
      kinds,
      languages,
    });
  }

  return searchAllByFilters(
    qb,
    compact({
      kinds,
      languages,
      limit: limit * 5,
      signatureLike: signatureFilters.length > 0 ? signatureFilters : undefined,
      // F-T: push the `name:foo` qualifier into SQL so a target whose
      // name sorts past the alphabetical-cascade cap still surfaces.
      // The JS post-filter in `applySearchHardFilters` still runs (so
      // the substring semantics match), but it now operates on a row
      // set that's already been narrowed by the same predicate.
      nameLike: nameFilters.length > 0 ? nameFilters : undefined,
    }),
  );
}

/**
 * Resolve the seed-id union from callers-of + callees-of + depends-on
 * and apply the kind/language filter. Returns score=1 for every
 * survivor — the caller later applies its own ranking.
 */
function seedFromGraphQualifierUnion(
  qb: QueryBuilder,
  args: {
    callersOf: string[];
    calleesOf: string[];
    dependsOn: string[];
    callersSet: () => Set<string>;
    calleesSet: () => Set<string>;
    dependsOnSet: () => Set<string>;
    kinds: NodeKind[] | undefined;
    languages: Language[] | undefined;
  },
): SearchResult[] {
  const { callersOf, calleesOf, dependsOn, callersSet, calleesSet, dependsOnSet, kinds, languages } = args;
  const seedIds = new Set<string>();
  if (callersOf.length > 0) for (const id of callersSet()) seedIds.add(id);
  if (calleesOf.length > 0) for (const id of calleesSet()) seedIds.add(id);
  if (dependsOn.length > 0) for (const id of dependsOnSet()) seedIds.add(id);
  const seedNodes = nodesByIds(qb, [...seedIds]).filter((n) => {
    if (kinds && kinds.length > 0 && !kinds.includes(n.kind)) return false;
    if (languages && languages.length > 0 && !languages.includes(n.language)) return false;
    return true;
  });
  return seedNodes.map((node) => ({ node, score: 1 }));
}

/**
 * Ensure exact name matches are always candidates. BM25 can bury
 * short exact-match names (e.g. `getBean`) under hundreds of
 * compound names (e.g. `getBeanDescriptor`) in large codebases,
 * pushing them past the FTS fetch limit before post-hoc scoring
 * can help. Add them as supplements at score = max-BM25-score so
 * the post-hoc nameMatchBonus (exact=30 vs prefix=20) can
 * differentiate them after rescoring.
 *
 * Two supplement passes:
 *   - Exact-name match on the base query terms, plus the RHS of any
 *     dot-qualified term (`llm.Generate` → also try `Generate`),
 *     plus URL-segment splits of route-shaped terms
 *     (`/api/generate` → `api`, `generate`).
 *   - Route-handler LIKE on the longest URL segment so symbols whose
 *     name CONTAINS the segment (`GenerateHandler`) come in as
 *     candidates that the route-handler path bonus can promote.
 */
interface AddExactNameSupplementsArgs {
  qb: QueryBuilder;
  results: SearchResult[];
  query: string;
  kinds: NodeKind[] | undefined;
  languages: Language[] | undefined;
}

/**
 * Min length of a route-segment kept as a supplemental search term.
 * Below 3 chars the segments are noise (`a`, `to`, `id`) — they'd
 * match thousands of unrelated nodes.
 */
const ROUTE_SEGMENT_MIN_LENGTH = 3;

/**
 * Min length of a route segment eligible for the route-handler LIKE
 * supplement. Tighter than the term-supplement threshold because LIKE
 * is more expensive and matches partials.
 */
const LIKE_SEGMENT_MIN_LENGTH = 4;

/** Per-pass cap for exact-name name-supplement candidates. */
const EXACT_NAME_SUPPLEMENT_LIMIT = 20;

/** Per-pass cap for the route-handler LIKE supplement. */
const ROUTE_LIKE_SUPPLEMENT_LIMIT = 50;

function addExactNameSupplements(args: AddExactNameSupplementsArgs): void {
  const { qb, results, query, kinds, languages } = args;
  const existingIds = new Set(results.map((r) => r.node.id));
  const maxFtsScore = Math.max(...results.map((r) => r.score));
  const baseTerms = query.split(/\s+/).filter((t) => t.length >= 2);

  const extra: string[] = [];
  for (const t of baseTerms) {
    const dq = parseDotQualified(t);
    if (dq) extra.push(dq.rhs);
    if (!isRouteShapedQuery(t)) continue;
    for (const seg of t.split('/').filter((s) => s.length >= ROUTE_SEGMENT_MIN_LENGTH)) {
      extra.push(seg);
    }
  }

  addSupplementCandidates(qb, {
    predicate: 'eq',
    values: [...baseTerms, ...extra],
    kinds,
    languages,
    limit: EXACT_NAME_SUPPLEMENT_LIMIT,
    results,
    existingIds,
    baseScore: maxFtsScore,
  });

  const routeQueryTerm = baseTerms.find((t) => isRouteShapedQuery(t));
  if (!routeQueryTerm) return;
  const longestSegment = routeQueryTerm
    .split('/')
    .filter((s) => s.length >= LIKE_SEGMENT_MIN_LENGTH)
    .sort((a, b) => b.length - a.length)[0];
  if (!longestSegment) return;
  addSupplementCandidates(qb, {
    predicate: 'like',
    values: [longestSegment],
    kinds,
    languages,
    limit: ROUTE_LIKE_SUPPLEMENT_LIMIT,
    results,
    existingIds,
    baseScore: maxFtsScore,
  });
}

/**
 * Apply the post-scoring hard gates: path / name / signature
 * substring filters and the callers-of / callees-of / depends-on
 * graph filters. These are AFTER scoring because scoring already uses
 * path/name as soft signals; the explicit filters here are a hard
 * intersection with whatever the scoring promoted.
 */
function applySearchHardFilters(
  results: SearchResult[],
  filters: {
    pathPrefixes: string[];
    pathFilters: string[];
    nameFilters: string[];
    signatureFilters: string[];
    callersOf: string[];
    calleesOf: string[];
    dependsOn: string[];
    callersSet: () => Set<string>;
    calleesSet: () => Set<string>;
    dependsOnSet: () => Set<string>;
  },
): SearchResult[] {
  let out = results;
  if (filters.pathPrefixes.length > 0) {
    const lowered = filters.pathPrefixes.map((p) => p.toLowerCase());
    out = out.filter((r) => {
      const fp = r.node.filePath.toLowerCase();
      return lowered.some((p) => fp.startsWith(p));
    });
  }
  if (filters.pathFilters.length > 0) {
    const lowered = filters.pathFilters.map((p) => p.toLowerCase());
    out = out.filter((r) => {
      const fp = r.node.filePath.toLowerCase();
      return lowered.some((p) => fp.includes(p));
    });
  }
  if (filters.nameFilters.length > 0) {
    const lowered = filters.nameFilters.map((n) => n.toLowerCase());
    out = out.filter((r) => {
      const nm = r.node.name.toLowerCase();
      return lowered.some((n) => nm.includes(n));
    });
  }
  if (filters.signatureFilters.length > 0) {
    const lowered = filters.signatureFilters.map((s) => s.toLowerCase());
    out = out.filter((r) => {
      const sig = (r.node.signature ?? '').toLowerCase();
      return lowered.some((s) => sig.includes(s));
    });
  }
  if (filters.callersOf.length > 0) {
    const allowed = filters.callersSet();
    out = out.filter((r) => allowed.has(r.node.id));
  }
  if (filters.calleesOf.length > 0) {
    const allowed = filters.calleesSet();
    out = out.filter((r) => allowed.has(r.node.id));
  }
  if (filters.dependsOn.length > 0) {
    const allowed = filters.dependsOnSet();
    out = out.filter((r) => allowed.has(r.node.id));
  }
  return out;
}

/**
 * Run a name-shape supplement query and dedupe-push the rows into
 * `searchNodes`'s in-flight result list. Used by both the exact-name
 * supplement (so short exact matches like `getBean` aren't buried
 * under `getBeanDescriptor`) and the route-segment LIKE supplement
 * (so `/api/generate` surfaces `GenerateHandler`). Optional kind /
 * language filters compose the same way in both passes.
 */
// Predicate switching (`= ?` vs `LIKE ?`) is encoded as two static
// typed queries (Pattern C). Kind/language filters are Pattern A
// (json_each) gated by Pattern B (NULL sentinel). The two call sites
// pass numeric literals for `limit` (20 / 50) — emitted as static
// per-limit query variants below so the SQL stays static.
function makeSupplementCandidatesQuery(predicate: 'eq' | 'like', limit: number) {
  const compare = predicate === 'eq' ? '= @value' : 'LIKE @value';
  return defineQuery({
    sql: `
      SELECT * FROM nodes
      WHERE name ${compare} COLLATE NOCASE
        AND (@kindsJson IS NULL OR kind IN (SELECT value FROM json_each(@kindsJson)))
        AND (@languagesJson IS NULL OR language IN (SELECT value FROM json_each(@languagesJson)))
      LIMIT ${limit}
    `,
    params: z.object({
      value: z.string(),
      kindsJson: z.string().nullable(),
      languagesJson: z.string().nullable(),
    }),
    row: NodeRowSchema,
  });
}

const supplementCandidatesQueries = {
  eq_exact: makeSupplementCandidatesQuery('eq', EXACT_NAME_SUPPLEMENT_LIMIT),
  like_route: makeSupplementCandidatesQuery('like', ROUTE_LIKE_SUPPLEMENT_LIMIT),
} as const;

type SupplementCandidatesRegistryKey = 'supplementCandidatesEqExact' | 'supplementCandidatesLikeRoute';

function selectSupplementCandidatesQuery(
  predicate: SupplementParams['predicate'],
  limit: number,
): { query: ReturnType<typeof makeSupplementCandidatesQuery>; regKey: SupplementCandidatesRegistryKey } {
  if (predicate === 'eq' && limit === EXACT_NAME_SUPPLEMENT_LIMIT) {
    return { query: supplementCandidatesQueries.eq_exact, regKey: 'supplementCandidatesEqExact' };
  }
  if (predicate === 'like' && limit === ROUTE_LIKE_SUPPLEMENT_LIMIT) {
    return { query: supplementCandidatesQueries.like_route, regKey: 'supplementCandidatesLikeRoute' };
  }
  throw new Error(
    `addSupplementCandidates: unsupported (predicate=${predicate}, limit=${limit}); ` +
      `the typed-query matrix covers only the two call-site pairs.`,
  );
}

function appendSupplementRows(args: {
  rows: NodeRow[];
  results: SearchResult[];
  existingIds: Set<string>;
  baseScore: number;
}): void {
  const { rows, results, existingIds, baseScore } = args;
  for (const row of rows) {
    if (existingIds.has(row.id)) continue;
    results.push({ node: rowToNode(row), score: baseScore });
    existingIds.add(row.id);
  }
}

declare module './queries.js' {
  interface QueryRegistry {
    supplementCandidatesEqExact?: TypedQuery<
      { value: string; kindsJson: string | null; languagesJson: string | null },
      NodeRow
    >;
    supplementCandidatesLikeRoute?: TypedQuery<
      { value: string; kindsJson: string | null; languagesJson: string | null },
      NodeRow
    >;
  }
}

function addSupplementCandidates(qb: QueryBuilder, p: SupplementParams): void {
  const { predicate, values, kinds, languages, limit, results, existingIds, baseScore } = p;
  // The two call sites pin `predicate × limit` to one of two pairs:
  // ('eq', EXACT_NAME_SUPPLEMENT_LIMIT) or ('like', ROUTE_LIKE_SUPPLEMENT_LIMIT).
  // Pick the matching pre-prepared statement; an unknown combination
  // is a programming error caught here, not silently routed.
  const { query, regKey } = selectSupplementCandidatesQuery(predicate, limit);
  qb.queries[regKey] ??= query(qb.db);
  const stmt = qb.queries[regKey];
  const kindsJson = kinds && kinds.length > 0 ? JSON.stringify(kinds) : null;
  const languagesJson = languages && languages.length > 0 ? JSON.stringify(languages) : null;
  for (const v of values) {
    const value = predicate === 'eq' ? v : `%${v}%`;
    const rows = stmt.all({ value, kindsJson, languagesJson });
    appendSupplementRows({ rows, results, existingIds, baseScore });
  }
}

/**
 * Bulk-fetch nodes by id. Used by graph-qualifier search paths
 * (callers-of / callees-of) to materialise the seed set without
 * issuing one SELECT per id. Single query — `json_each` reads the
 * JSON-stringified id list as a virtual table, so the per-statement
 * parameter cap that previously forced chunking no longer applies.
 */
function nodesByIds(qb: QueryBuilder, ids: string[]): Node[] {
  if (ids.length === 0) return [];
  qb.queries.nodesByIdsBulk ??= nodesByIdsBulkQuery(qb.db);
  const rows = qb.queries.nodesByIdsBulk.all({ idsJson: JSON.stringify(ids) });
  return rows.map(rowToNode);
}

/**
 * Shared implementation for `callers-of:` and `callees-of:` qualifiers.
 *
 * When `direction === 'callers'` (default): returns the set of node IDs that
 * have at least one outgoing `calls` edge to a node whose `name` is in
 * `names` — i.e. nodes that **call** any of the named targets.
 *
 * When `direction === 'callees'`: returns the set of node IDs that are the
 * **target** of a `calls` edge from a node whose `name` is in `names` — i.e.
 * nodes that are **called by** any of the named sources.
 *
 * Both variants are Pattern C (one typed query each), with the variable
 * IN-list rebuilt as `json_each(@namesJson)` — Pattern A. Chunking
 * dropped: `json_each` is unaffected by SQLite's bound-param cap.
 */
function nodesRelatedByCallsAny(qb: QueryBuilder, names: string[], direction: 'callers' | 'callees'): Set<string> {
  if (names.length === 0) return new Set();
  const out = new Set<string>();
  const namesJson = JSON.stringify(names);
  if (direction === 'callers') {
    qb.queries.nodesCallingAny ??= nodesCallingAnyQuery(qb.db);
    for (const r of qb.queries.nodesCallingAny.all({ namesJson })) out.add(r.id);
  } else {
    qb.queries.nodesCalledByAny ??= nodesCalledByAnyQuery(qb.db);
    for (const r of qb.queries.nodesCalledByAny.all({ namesJson })) out.add(r.id);
  }
  return out;
}

/**
 * Set of node IDs that have at least one outgoing `calls` edge to
 * a node whose `name` matches any element of `names`. Backs the
 * `callers-of:NAME` query qualifier. Chunked for the 999-variable
 * SQLite cap.
 */
function nodesCallingAny(qb: QueryBuilder, names: string[]): Set<string> {
  return nodesRelatedByCallsAny(qb, names, 'callers');
}

/**
 * Set of node IDs that are called BY a node whose `name` matches
 * any element of `names`. Backs the `callees-of:NAME` query
 * qualifier. Chunked for the 999-variable SQLite cap.
 */
function nodesCalledByAny(qb: QueryBuilder, names: string[]): Set<string> {
  return nodesRelatedByCallsAny(qb, names, 'callees');
}

/**
 * Edge kinds that constitute a structural "source depends on target"
 * relation — the source needs the target to compile/run. Backs the
 * `depends-on:` qualifier. Deliberately EXCLUDES `contains` (nesting,
 * not dependency), `exports` (re-export, reverse direction),
 * `references` / `field_access` (bare-name-collision noise),
 * `decorates` (ambiguous direction), `tests`, and the opt-in derived
 * kinds (`similar_to` / `def_use`).
 */
export const DEPENDENCY_EDGE_KINDS = [
  'calls',
  'imports',
  'extends',
  'implements',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
] as const satisfies readonly EdgeKind[];

/**
 * Static SQL fragment of the dependency-edge-kind allowlist, built from
 * {@link DEPENDENCY_EDGE_KINDS} once at module-load. Embedding the list
 * lets the typed query stay static — adding a kind to the const updates
 * this fragment on the next module-load, which is the right
 * invalidation boundary.
 */
const DEPENDENCY_KIND_SQL_LIST = DEPENDENCY_EDGE_KINDS.map((k) => `'${k}'`).join(', ');

const nodesDependingOnAnyQuery = defineQuery({
  sql: `
    SELECT DISTINCT e.source AS id
    FROM edges e
    JOIN nodes tgt ON e.target = tgt.id
    WHERE e.kind IN (${DEPENDENCY_KIND_SQL_LIST})
      AND tgt.name IN (SELECT value FROM json_each(@namesJson))
  `,
  params: z.object({ namesJson: z.string() }),
  row: z.object({ id: z.string() }),
});

declare module './queries.js' {
  interface QueryRegistry {
    nodesDependingOnAny?: TypedQuery<{ namesJson: string }, { id: string }>;
    searchAllByFilters?: DynamicTypedQuery<SearchAllByFiltersParams, NodeRow>;
  }
}

/**
 * Dynamic-SQL typed query for the no-text field-filter-only search path.
 * Four independent optional clauses: `kinds`/`languages` IN-lists,
 * `signatureLike`/`nameLike` multi-LIKE OR-of-OR. Each combination
 * produces a distinct SQL shape; defineDynamicQuery caches one prepared
 * statement per shape.
 */
const SearchAllByFiltersParamsSchema = z.object({
  kinds: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  signatureLike: z.array(z.string()).optional(),
  nameLike: z.array(z.string()).optional(),
  limit: z.number(),
});
type SearchAllByFiltersParams = z.infer<typeof SearchAllByFiltersParamsSchema>;

const searchAllByFiltersQuery = defineDynamicQuery({
  params: SearchAllByFiltersParamsSchema,
  row: NodeRowSchema,
  build: (p) => {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const bindings: Record<string, unknown> = { limit: p.limit };
    if (p.kinds && p.kinds.length > 0) {
      sql += ' AND kind IN (SELECT value FROM json_each(@kinds))';
      bindings['kinds'] = JSON.stringify(p.kinds);
    }
    if (p.languages && p.languages.length > 0) {
      sql += ' AND language IN (SELECT value FROM json_each(@languages))';
      bindings['languages'] = JSON.stringify(p.languages);
    }
    if (p.signatureLike && p.signatureLike.length > 0) {
      const ors = p.signatureLike.map((_, i) => `signature LIKE @sigLike${i} COLLATE NOCASE`).join(' OR ');
      sql += ` AND (${ors})`;
      p.signatureLike.forEach((s, i) => {
        bindings[`sigLike${i}`] = `%${s}%`;
      });
    }
    if (p.nameLike && p.nameLike.length > 0) {
      const ors = p.nameLike.map((_, i) => `name LIKE @nameLike${i} COLLATE NOCASE`).join(' OR ');
      sql += ` AND (${ors})`;
      p.nameLike.forEach((n, i) => {
        bindings[`nameLike${i}`] = `%${n}%`;
      });
    }
    sql += ' ORDER BY name LIMIT @limit';
    return { sql, bindings };
  },
});

/**
 * Set of node IDs with at least one outgoing dependency edge (kind ∈
 * {@link DEPENDENCY_EDGE_KINDS}) to a node whose `name` matches any
 * element of `names`. Backs the `depends-on:NAME` query qualifier —
 * broader than `nodesCallingAny` (calls-only). Single query via
 * `json_each` — chunking dropped (no per-stmt param cap applies).
 */
function nodesDependingOnAny(qb: QueryBuilder, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  qb.queries.nodesDependingOnAny ??= nodesDependingOnAnyQuery(qb.db);
  const rows = qb.queries.nodesDependingOnAny.all({ namesJson: JSON.stringify(names) });
  const out = new Set<string>();
  for (const r of rows) out.add(r.id);
  return out;
}

/**
 * Match-everything path used when the user supplied only field
 * filters (`kind:function lang:typescript`) with no text. Returns
 * candidates ordered by name; the caller's filter pass narrows to
 * what was asked for.
 */
function searchAllByFilters(
  qb: QueryBuilder,
  options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
    /** SQL pre-filter on the signature column. ALL provided strings
     *  are OR'd (matches the OR semantics of path:/name: filters in
     *  the JS post-filter pass), so multi-sig: queries behave
     *  consistently with multi-path:/multi-name: queries. Necessary
     *  because the JS post-filter alone has nothing to narrow when
     *  the candidate set is the first 50 nodes by name. */
    signatureLike?: string[];
    /** SQL pre-filter on the name column. Same OR-of-LIKE semantics as
     *  {@link signatureLike} and the corresponding JS post-filter in
     *  {@link applySearchHardFilters}. Friction F-T: without this push-
     *  down a query like `name:isBiomarkerCacheCold` (no text) would
     *  scan the first `limit*5` rows alphabetically and never reach a
     *  target whose name sorts past that prefix. */
    nameLike?: string[];
  },
): SearchResult[] {
  qb.queries.searchAllByFilters ??= searchAllByFiltersQuery(qb.db);
  const rows = qb.queries.searchAllByFilters.all({
    kinds: options.kinds ? [...options.kinds] : undefined,
    languages: options.languages ? [...options.languages] : undefined,
    signatureLike: options.signatureLike,
    nameLike: options.nameLike,
    limit: options.limit,
  });
  return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
}

/**
 * Suggest the closest symbol names to a misspelt query. Used when a
 * direct lookup misses entirely — instead of a dead-end "not found",
 * the caller can offer "did you mean…?" alternatives. Case-insensitive,
 * tighter limit than the regular fuzzy fallback (intent here is
 * suggestion, not retrieval).
 */
type SuggestMatch = { name: string; dist: number };

/**
 * Tier 0: the lowercased query appears verbatim inside the candidate
 * name. A verbatim containment ("watch" in "FileWatcher") is a
 * stronger relevance signal than a same-distance edit match against
 * an unrelated word ("watch" ~ "path"), so this tier is concatenated
 * ahead of the edit-distance tier. Prefix matches (index 0) sort
 * before mid-string matches; within an offset shorter names — closer
 * to the bare query — rank first. `dist` is offset past the
 * edit-distance ceiling so the row renders as "(token match)".
 */
function tierContainmentMatches(scan: SuggestScanState, lowered: string): SuggestMatch[] {
  const { allNames, seen } = scan;
  const out: SuggestMatch[] = [];
  for (const name of allNames) {
    if (seen.has(name)) continue;
    const lo = name.toLowerCase();
    if (lo === lowered) continue;
    // A name vastly longer than the query is a coincidental containment.
    if (name.length > lowered.length * SUGGEST_LENGTH_CAP_MULT) continue;
    const idx = lo.indexOf(lowered);
    if (idx < 0) continue;
    out.push({ name, dist: SUGGEST_CONTAINMENT_OFFSET + idx });
  }
  out.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length);
  return out;
}

/** Tier 1: bounded edit distance. Skip case-identical matches (those
 *  would have hit the exact-match path) and names already claimed by
 *  the tier-0 containment pass. */
function tierEditDistanceMatches(scan: SuggestScanState, lowered: string, maxDist: number): SuggestMatch[] {
  const { allNames, seen } = scan;
  const out: SuggestMatch[] = [];
  for (const name of allNames) {
    if (seen.has(name) || name.toLowerCase() === lowered) continue;
    const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
    if (dist <= maxDist) out.push({ name, dist });
  }
  out.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length);
  return out;
}

/**
 * Tier 2: subsequence matching for radical abbreviations like
 * `GnrtHndlr` → `GenerateHandler` or `gNAme` → `getName`. Each
 * query char must appear in order in the candidate (case-insensitive).
 * Distance is offset by `editOffset` so a subseq match always sorts
 * after an edit match.
 */
function tierSubsequenceMatches(scan: SuggestScanState, lowered: string, editOffset: number): SuggestMatch[] {
  const { allNames, seen } = scan;
  const out: SuggestMatch[] = [];
  for (const name of allNames) {
    if (seen.has(name) || name.toLowerCase() === lowered) continue;
    // A 1:1 subsequence match on a vastly longer name is noise.
    if (name.length > lowered.length * SUGGEST_LENGTH_CAP_MULT) continue;
    if (!isSubsequence(lowered, name.toLowerCase())) continue;
    out.push({ name, dist: editOffset + (name.length - lowered.length) });
  }
  out.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length);
  return out;
}

/**
 * Tier 3: longest-common-substring. Catches synonym swaps like
 * `addEdge` → `insertEdge` (share `Edge`) where edit distance is too
 * far AND char order in the swapped segment doesn't subseq-match.
 * Substring of length ≥ SUGGEST_MIN_SUBSTR picks up the shared domain
 * noun while ignoring whatever wraps it.
 */
function tierSubstringMatches(scan: SuggestScanState, lowered: string, substrOffset: number): SuggestMatch[] {
  if (lowered.length < SUGGEST_MIN_SUBSTR) return [];
  const { allNames, seen } = scan;
  const out: SuggestMatch[] = [];
  for (const name of allNames) {
    if (seen.has(name) || name.toLowerCase() === lowered) continue;
    if (name.length > lowered.length * SUGGEST_LENGTH_CAP_MULT) continue;
    const matchLen = longestCommonSubstring(name.toLowerCase(), lowered);
    if (matchLen < SUGGEST_MIN_SUBSTR) continue;
    out.push({ name, dist: substrOffset + (lowered.length - matchLen) });
  }
  out.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length);
  return out;
}

export function suggestSymbolNames(qb: QueryBuilder, query: string, limit = SUGGEST_DEFAULT_LIMIT): SuggestMatch[] {
  const lowered = query.toLowerCase();
  if (lowered.length < SUGGEST_MIN_QUERY_LEN) return [];
  const maxDist = Math.min(Math.ceil(lowered.length / SUGGEST_EDIT_DIST_DIVISOR), SUGGEST_MAX_EDIT_DIST);
  const allNames = qb.getAllNodeNames();
  const seen = new Set<string>();
  const scan: SuggestScanState = { allNames, seen };

  // Tier 0: verbatim containment ranks ahead of typo-distance matches.
  const containMatches = tierContainmentMatches(scan, lowered);
  if (containMatches.length >= limit) return containMatches.slice(0, limit);
  for (const m of containMatches) seen.add(m.name);

  const editMatches = tierEditDistanceMatches(scan, lowered, maxDist);
  if (containMatches.length + editMatches.length >= limit) {
    return [...containMatches, ...editMatches].slice(0, limit);
  }
  for (const m of editMatches) seen.add(m.name);

  const subseqOffset = maxDist + 1;
  const subseqMatches = tierSubsequenceMatches(scan, lowered, subseqOffset);
  if (containMatches.length + editMatches.length + subseqMatches.length >= limit) {
    return [...containMatches, ...editMatches, ...subseqMatches].slice(0, limit);
  }
  for (const m of subseqMatches) seen.add(m.name);

  const substrMatches = tierSubstringMatches(scan, lowered, subseqOffset + SUGGEST_SUBSTR_OFFSET);
  return [...containMatches, ...editMatches, ...subseqMatches, ...substrMatches].slice(0, limit);
}

/**
 * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
 * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
 * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
 * Bounded edit distance keeps each comparison cheap; the per-query
 * scan is O(distinct-name-count) which is far smaller than total
 * node count on any real codebase.
 */
function searchNodesFuzzy(
  qb: QueryBuilder,
  text: string,
  options: { kinds?: NodeKind[]; languages?: Language[]; limit: number },
): SearchResult[] {
  const { kinds, languages, limit } = options;
  const lowered = text.toLowerCase();
  const maxDist = lowered.length <= 4 ? 1 : 2;

  const cappedCandidates = collectFuzzyNameCandidates({ qb, lowered }, maxDist, limit);

  const ctx: FuzzyFetchCtx = {
    qb,
    kinds,
    languages,
    seen: new Set<string>(),
    results: [],
    limit,
  };
  for (const c of cappedCandidates) {
    if (ctx.results.length >= limit) break;
    fetchFuzzyNameRows(ctx, c);
  }
  return ctx.results;
}

/**
 * Collect distinct node names within `maxDist` of `lowered` and cap the
 * survivor list. The cap bounds the per-name follow-up queries (each
 * survivor triggers a separate SELECT … WHERE name = ?).
 */
function collectFuzzyNameCandidates(
  fq: FuzzyQueryCtx,
  maxDist: number,
  limit: number,
): Array<{ name: string; dist: number }> {
  // Pull the distinct name list once. The set is cached on QueryBuilder
  // by getAllNodeNames(); even on a 200k-node project the distinct
  // name set is typically O(10k) because most names repeat.
  const allNames = fq.qb.getAllNodeNames();
  const candidates: Array<{ name: string; dist: number }> = [];
  for (const name of allNames) {
    const dist = boundedEditDistance(name.toLowerCase(), fq.lowered, maxDist);
    if (dist <= maxDist) candidates.push({ name, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
  return candidates.slice(0, FUZZY_FOLLOWUP_CAP);
}

/** Per-fuzzy-search shared context — bundles the filters + accumulators. */
interface FuzzyFetchCtx {
  qb: QueryBuilder;
  kinds: NodeKind[] | undefined;
  languages: Language[] | undefined;
  seen: Set<string>;
  results: SearchResult[];
  limit: number;
}

/**
 * Fetch up to 5 rows for a single fuzzy candidate name, applying the
 * kind/language filter. Score is 1 / (1 + dist) so exact matches (dist 0)
 * outrank dist-2 typos. Mutates `ctx.seen` and `ctx.results` in place.
 *
 * Uses Pattern B (sentinel `(@p IS NULL OR …)`) for the optional kind
 * and language filters. The kind/language columns aren't separately
 * indexed for this `name = ?` lookup (the seek is on `idx_nodes_name`),
 * so the sentinel cannot regress a scan that wasn't happening anyway —
 * and the `json_each(?)` virtual-table side stays cheap on empty lists
 * because the SQL short-circuits via the NULL sentinel.
 */
const fetchFuzzyNameRowsQuery = defineQuery({
  sql: `
    SELECT * FROM nodes
    WHERE name = @name
      AND (@kindsJson IS NULL OR kind IN (SELECT value FROM json_each(@kindsJson)))
      AND (@languagesJson IS NULL OR language IN (SELECT value FROM json_each(@languagesJson)))
    LIMIT 5
  `,
  params: z.object({
    name: z.string(),
    kindsJson: z.string().nullable(),
    languagesJson: z.string().nullable(),
  }),
  row: NodeRowSchema,
});

declare module './queries.js' {
  interface QueryRegistry {
    fetchFuzzyNameRows?: TypedQuery<{ name: string; kindsJson: string | null; languagesJson: string | null }, NodeRow>;
  }
}

function fetchFuzzyNameRows(ctx: FuzzyFetchCtx, c: { name: string; dist: number }): void {
  const { qb, kinds, languages, seen, results, limit } = ctx;
  qb.queries.fetchFuzzyNameRows ??= fetchFuzzyNameRowsQuery(qb.db);
  const rows = qb.queries.fetchFuzzyNameRows.all({
    name: c.name,
    kindsJson: kinds && kinds.length > 0 ? JSON.stringify(kinds) : null,
    languagesJson: languages && languages.length > 0 ? JSON.stringify(languages) : null,
  });
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
    if (results.length >= limit) return;
  }
}

/**
 * FTS5 search with prefix matching
 */
/**
 * Build the FTS5 query string by stripping special chars, dropping
 * boolean operators (so user input can't inject structure into the
 * OR-join), filtering stopwords, then OR-joining with prefix marks.
 */
function buildFtsPrefixQuery(query: string): string {
  const rawTerms = query
    .replaceAll(/['"*():^]/g, '')
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .filter((term) => !/^(AND|OR|NOT|NEAR)$/i.test(term));
  return filterStopwords(rawTerms)
    .map((term) => `"${term}"*`) // Prefix match each term
    .join(' OR ');
}

/**
 * Append an optional `kind`/`language` IN-list clause + binding entry
 * to the builder state. Uses `json_each(@kinds)` rather than
 * per-element placeholders so the SQL shape stays stable regardless
 * of array length (one cached prepared statement per "which filters
 * are present" combination, not per array length).
 */
function appendKindLanguageFiltersNamed(
  state: { sql: string; bindings: Record<string, unknown> },
  filter: { kinds?: readonly string[] | undefined; languages?: readonly string[] | undefined; tablePrefix?: string },
): void {
  const prefix = filter.tablePrefix ?? '';
  if (filter.kinds && filter.kinds.length > 0) {
    state.sql += ` AND ${prefix}kind IN (SELECT value FROM json_each(@kinds))`;
    state.bindings['kinds'] = JSON.stringify(filter.kinds);
  }
  if (filter.languages && filter.languages.length > 0) {
    state.sql += ` AND ${prefix}language IN (SELECT value FROM json_each(@languages))`;
    state.bindings['languages'] = JSON.stringify(filter.languages);
  }
}

function searchNodesFTS(qb: QueryBuilder, query: string, options: SearchOptions): SearchResult[] {
  const { kinds, languages, limit = SEARCH_DEFAULT_LIMIT, offset = 0 } = options;

  const ftsQuery = buildFtsPrefixQuery(query);
  if (!ftsQuery) return [];

  // BM25 column weights kept on the SQL side; ftsLimit comes from
  // limit*5 (min 100) so the post-fetch ranking has room to pick.
  const ftsLimit = Math.max(limit * 5, 100);

  qb.queries.searchNodesFTS ??= searchNodesFTSQuery(qb.db);
  try {
    const rows = qb.queries.searchNodesFTS.all({
      ftsQuery,
      kinds,
      languages,
      ftsLimit,
      offset,
    });
    return rows.map((row) => ({
      node: rowToNode(row),
      score: Math.abs(row.score), // bm25 returns negative scores
    }));
  } catch {
    // FTS query failed (malformed prefix etc.), return empty
    return [];
  }
}

/**
 * LIKE-based substring search for cases where FTS doesn't match —
 * useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle").
 */
function searchNodesLike(qb: QueryBuilder, query: string, options: SearchOptions): SearchResult[] {
  const { kinds, languages, limit = SEARCH_DEFAULT_LIMIT, offset = 0 } = options;
  qb.queries.searchNodesLike ??= searchNodesLikeQuery(qb.db);
  const rows = qb.queries.searchNodesLike.all({
    query,
    startsWith: `${query}%`,
    contains: `%${query}%`,
    kinds,
    languages,
    limit,
    offset,
  });
  return rows.map((row) => ({ node: rowToNode(row), score: row.score }));
}

/**
 * Find nodes by exact name match
 *
 * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
 * Returns high-confidence matches for known symbol names extracted from query.
 *
 * @param names - Array of symbol names to look up
 * @param options - Search options (kinds, languages, limit)
 * @returns SearchResult array with exact matches scored at 1.0
 */
/**
 * Score one queried name's exact-match rows against the distinctive-
 * file set, returning the top `perNameLimit` boosted results that
 * haven't already been seen on a prior name's pass.
 */
function scoreExactNameRows(
  qb: QueryBuilder,
  name: string,
  ctx: {
    kinds: NodeKind[] | undefined;
    languages: string[] | undefined;
    perNameLimit: number;
    distinctiveFiles: Set<string>;
    seenIds: Set<string>;
  },
): SearchResult[] {
  qb.queries.scoreExactNameRows ??= scoreExactNameRowsQuery(qb.db);
  const rows = qb.queries.scoreExactNameRows.all({
    name,
    kinds: ctx.kinds,
    languages: ctx.languages,
    limit: Math.max(ctx.perNameLimit * PER_NAME_FETCH_MULTIPLIER, EXACT_NAME_DEFAULT_LIMIT),
  });
  const nameResults: SearchResult[] = [];
  for (const row of rows) {
    const node = rowToNode(row);
    if (ctx.seenIds.has(node.id)) continue;
    const coLocationBoost = ctx.distinctiveFiles.has(node.filePath) ? CO_LOCATION_BOOST : 0;
    nameResults.push({ node, score: row.score + coLocationBoost });
  }
  nameResults.sort((a, b) => b.score - a.score);
  return nameResults.slice(0, ctx.perNameLimit);
}

export function findNodesByExactName(qb: QueryBuilder, names: string[], options: SearchOptions = {}): SearchResult[] {
  if (names.length === 0) return [];

  const { kinds, languages, limit = EXACT_NAME_DEFAULT_LIMIT } = options;

  // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
  //   Pass 1 — find which files contain *distinctive* (rare) names from the query.
  //   Pass 2 — query each name, boosting results that co-locate with distinctive ones.
  const distinctiveFiles = findDistinctiveFiles(qb, names, kinds);
  const perNameLimit = Math.max(MIN_PER_NAME_LIMIT, Math.ceil(limit / names.length));
  const allResults: SearchResult[] = [];
  const seenIds = new Set<string>();

  for (const name of names) {
    const top = scoreExactNameRows(qb, name, { kinds, languages, perNameLimit, distinctiveFiles, seenIds });
    for (const r of top) {
      seenIds.add(r.node.id);
      allResults.push(r);
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

/**
 * Pass-1 helper: for each queried name, pull the set of files
 * containing it. Names whose file set is in [1, DISTINCTIVE_FILE_CAP)
 * are considered "distinctive" — rare enough to be a strong
 * disambiguator. Returns the union of those files; pass-2 boosts
 * any result that lives in one of them.
 */
/**
 * Pass-1 SQL: distinct files containing a given name, with an optional
 * kind filter expressed as Pattern A (json_each) + Pattern B (NULL
 * sentinel) so the SQL stays static. `LIMIT` is the static
 * {@link PASS1_FILE_LIMIT} — interpolated directly because it's a
 * compile-time constant; SQLite doesn't accept LIMIT as a parameter
 * on this dialect.
 */
const findDistinctiveFilesQuery = defineQuery({
  sql: `
    SELECT DISTINCT file_path FROM nodes
    WHERE name COLLATE NOCASE = @name
      AND (@kindsJson IS NULL OR kind IN (SELECT value FROM json_each(@kindsJson)))
    LIMIT ${PASS1_FILE_LIMIT}
  `,
  params: z.object({ name: z.string(), kindsJson: z.string().nullable() }),
  row: z.object({ file_path: z.string() }),
});

declare module './queries.js' {
  interface QueryRegistry {
    findDistinctiveFiles?: TypedQuery<{ name: string; kindsJson: string | null }, { file_path: string }>;
  }
}

function findDistinctiveFiles(qb: QueryBuilder, names: string[], kinds: NodeKind[] | undefined): Set<string> {
  qb.queries.findDistinctiveFiles ??= findDistinctiveFilesQuery(qb.db);
  const kindsJson = kinds && kinds.length > 0 ? JSON.stringify(kinds) : null;
  const distinctiveFiles = new Set<string>();
  for (const name of names) {
    const rows = qb.queries.findDistinctiveFiles.all({ name, kindsJson });
    const files = new Set(rows.map((r) => r.file_path));
    if (files.size > 0 && files.size < DISTINCTIVE_FILE_CAP) {
      for (const f of files) distinctiveFiles.add(f);
    }
  }
  return distinctiveFiles;
}

/**
 * Find nodes whose name contains a substring (LIKE-based).
 * Useful for CamelCase-part matching where FTS fails because
 * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
 *
 * Results are ordered by name length (shorter = more likely to be the core type).
 *
 * Pattern C (2-variant) on `excludePrefix`; Pattern A + Pattern B on the
 * optional kind / language filters. The driving predicate is `name LIKE
 * '%…%'` which is already a scan — the index sentinels add no
 * scan-regression risk that wasn't already present.
 */
function makeFindNodesByNameSubstringQuery(excludePrefix: boolean) {
  const prefixClause = excludePrefix ? 'AND name NOT LIKE @prefixPattern' : '';
  return defineQuery({
    sql: `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE @containsPattern
        ${prefixClause}
        AND (@kindsJson IS NULL OR kind IN (SELECT value FROM json_each(@kindsJson)))
        AND (@languagesJson IS NULL OR language IN (SELECT value FROM json_each(@languagesJson)))
      ORDER BY length(name) ASC LIMIT @limit
    `,
    params: z.object({
      containsPattern: z.string(),
      // Always present in params; query just doesn't reference it when
      // `excludePrefix` is false. Optional from the binder's perspective
      // is fine — bun:sqlite in strict mode ignores unused named params.
      prefixPattern: z.string().nullable(),
      kindsJson: z.string().nullable(),
      languagesJson: z.string().nullable(),
      limit: z.number(),
    }),
    row: NodeRowSchema.extend({ score: z.number() }),
  });
}

const findNodesByNameSubstringQueries = {
  withPrefixExclusion: makeFindNodesByNameSubstringQuery(true),
  noPrefixExclusion: makeFindNodesByNameSubstringQuery(false),
} as const;

declare module './queries.js' {
  interface QueryRegistry {
    findNodesByNameSubstringExcludePrefix?: TypedQuery<
      {
        containsPattern: string;
        prefixPattern: string | null;
        kindsJson: string | null;
        languagesJson: string | null;
        limit: number;
      },
      NodeRow & { score: number }
    >;
    findNodesByNameSubstringNoPrefix?: TypedQuery<
      {
        containsPattern: string;
        prefixPattern: string | null;
        kindsJson: string | null;
        languagesJson: string | null;
        limit: number;
      },
      NodeRow & { score: number }
    >;
  }
}

export function findNodesByNameSubstring(
  qb: QueryBuilder,
  substring: string,
  options: SearchOptions & { excludePrefix?: boolean } = {},
): SearchResult[] {
  const { kinds, languages, limit = 30, excludePrefix } = options;
  const params = {
    containsPattern: `%${substring}%`,
    prefixPattern: excludePrefix ? `${substring}%` : null,
    kindsJson: kinds && kinds.length > 0 ? JSON.stringify(kinds) : null,
    languagesJson: languages && languages.length > 0 ? JSON.stringify(languages) : null,
    limit,
  };
  let rows: (NodeRow & { score: number })[];
  if (excludePrefix) {
    qb.queries.findNodesByNameSubstringExcludePrefix ??= findNodesByNameSubstringQueries.withPrefixExclusion(qb.db);
    rows = qb.queries.findNodesByNameSubstringExcludePrefix.all(params);
  } else {
    qb.queries.findNodesByNameSubstringNoPrefix ??= findNodesByNameSubstringQueries.noPrefixExclusion(qb.db);
    rows = qb.queries.findNodesByNameSubstringNoPrefix.all(params);
  }
  return rows.map((row) => ({
    node: rowToNode(row),
    score: row.score,
  }));
}

// ─── Dynamic typed queries for FTS / LIKE / exact-name searches ───────────

/**
 * Three queries that share the optional `kinds`/`languages` IN-list
 * shape. The IN-list arity varies, and `kinds`/`languages` are indexed
 * columns — Pattern B sentinel-OR would risk forcing a scan off
 * `idx_nodes_kind` / `idx_nodes_language` on the hot search path.
 * `defineDynamicQuery` caches one prepared statement per
 * filter-presence combination, so repeated calls reuse the prep.
 */
const NodeRowWithScoreSchema = NodeRowSchema.extend({ score: z.number() });
type NodeRowWithScore = z.infer<typeof NodeRowWithScoreSchema>;

const SearchNodesFTSParamsSchema = z.object({
  ftsQuery: z.string(),
  kinds: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  ftsLimit: z.number(),
  offset: z.number(),
});
type SearchNodesFTSParams = z.infer<typeof SearchNodesFTSParamsSchema>;

const searchNodesFTSQuery = defineDynamicQuery({
  params: SearchNodesFTSParamsSchema,
  row: NodeRowWithScoreSchema,
  build: (p) => {
    const state = {
      sql: `SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2, 10) as score
           FROM nodes_fts
           JOIN nodes ON nodes_fts.id = nodes.id
          WHERE nodes_fts MATCH @ftsQuery`,
      bindings: {
        ftsQuery: p.ftsQuery,
        ftsLimit: p.ftsLimit,
        offset: p.offset,
      } as Record<string, unknown>,
    };
    appendKindLanguageFiltersNamed(state, {
      kinds: p.kinds,
      languages: p.languages,
      tablePrefix: 'nodes.',
    });
    state.sql += ' ORDER BY score LIMIT @ftsLimit OFFSET @offset';
    return state;
  },
});

const SearchNodesLikeParamsSchema = z.object({
  query: z.string(),
  startsWith: z.string(),
  contains: z.string(),
  kinds: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  limit: z.number(),
  offset: z.number(),
});
type SearchNodesLikeParams = z.infer<typeof SearchNodesLikeParamsSchema>;

const searchNodesLikeQuery = defineDynamicQuery({
  params: SearchNodesLikeParamsSchema,
  row: NodeRowWithScoreSchema,
  build: (p) => {
    const state = {
      sql: `SELECT nodes.*,
           CASE
             WHEN name = @query THEN 1.0
             WHEN name LIKE @startsWith THEN 0.9
             WHEN name LIKE @contains THEN 0.8
             WHEN qualified_name LIKE @contains THEN 0.7
             ELSE 0.5
           END as score
         FROM nodes
         WHERE (
           name LIKE @contains OR
           qualified_name LIKE @contains OR
           name LIKE @startsWith
         )`,
      bindings: {
        query: p.query,
        startsWith: p.startsWith,
        contains: p.contains,
        limit: p.limit,
        offset: p.offset,
      } as Record<string, unknown>,
    };
    appendKindLanguageFiltersNamed(state, { kinds: p.kinds, languages: p.languages });
    state.sql += ' ORDER BY score DESC, length(name) ASC LIMIT @limit OFFSET @offset';
    return state;
  },
});

const ScoreExactNameParamsSchema = z.object({
  name: z.string(),
  kinds: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  limit: z.number(),
});
type ScoreExactNameParams = z.infer<typeof ScoreExactNameParamsSchema>;

const scoreExactNameRowsQuery = defineDynamicQuery({
  params: ScoreExactNameParamsSchema,
  row: NodeRowWithScoreSchema,
  build: (p) => {
    const state = {
      sql: `SELECT nodes.*, ${EXACT_MATCH_SCORE} as score
           FROM nodes
          WHERE name COLLATE NOCASE = @name`,
      bindings: { name: p.name, limit: p.limit } as Record<string, unknown>,
    };
    appendKindLanguageFiltersNamed(state, { kinds: p.kinds, languages: p.languages });
    state.sql += ' LIMIT @limit';
    return state;
  },
});

declare module './queries.js' {
  interface QueryRegistry {
    searchNodesFTS?: DynamicTypedQuery<SearchNodesFTSParams, NodeRowWithScore>;
    searchNodesLike?: DynamicTypedQuery<SearchNodesLikeParams, NodeRowWithScore>;
    scoreExactNameRows?: DynamicTypedQuery<ScoreExactNameParams, NodeRowWithScore>;
  }
}
