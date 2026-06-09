import { isSubsequence, longestCommonSubstring } from '../search/query-parser.js';
import { boundedEditDistance } from '../text-distance.js';
import type { QueryBuilder } from './queries.js';

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

/** Shared scan state for the suggestion-tier helpers. Bundles
 *  `allNames` (the full distinct-name corpus) and `seen` (names
 *  already committed to a higher tier) so each tier function takes
 *  a single state arg instead of two positional arrays. */
interface SuggestScanState {
  allNames: ReadonlyArray<string>;
  seen: Set<string>;
}

/**
 * Suggest the closest symbol names to a misspelt query. Used when a
 * direct lookup misses entirely — instead of a dead-end "not found",
 * the caller can offer "did you mean…?" alternatives. Case-insensitive,
 * tighter limit than the regular fuzzy fallback (intent here is
 * suggestion, not retrieval).
 */
export type SuggestMatch = { name: string; dist: number };

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
