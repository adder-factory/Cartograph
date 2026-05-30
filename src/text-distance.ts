/**
 * Shared string edit-distance primitives — one implementation behind
 * every "did you mean?" / fuzzy-match path in the codebase.
 *
 * Levenshtein edit distance was independently re-implemented four
 * times (`mcp/tools/sql.ts` column-name suggestions,
 * `mcp/tools/_unknown-arg-warnings.ts` unknown-arg keys,
 * `mcp/tools/affected.ts` path suggestions, `search/query-parser.ts`
 * fuzzy name matching) — the same algorithm in four subtly different
 * shapes. This module is the single source of truth.
 *
 * Both functions are case-SENSITIVE by design: callers that want
 * case-insensitive matching lowercase their inputs first (every
 * fuzzy path already does). Keeping case-folding out of the
 * primitive avoids a hidden `toLowerCase()` on the call sites that
 * pass pre-folded strings.
 */

interface EditRowCtx {
  a: string[];
  b: string[];
  prev: number[];
  cur: number[];
}

/** Try the cheap structural shortcuts before running full DP.
 *  Returns the answer when the shortcut applies, or `null` to fall
 *  through to the DP path. */
function tryEditDistanceShortcut(a: string, b: string, maxDist: number): number | null {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;
  return null;
}

/** Compute one DP row in-place; returns the row's minimum value (used
 *  by the early-cutoff `rowMin > maxDist` check in the outer loop). */
function fillEditRow(ctx: EditRowCtx, i: number): number {
  const { a, b, prev, cur } = ctx;
  const bl = b.length;
  cur[0] = i;
  let rowMin = cur[0];
  for (let j = 1; j <= bl; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    const insertion = cur[j - 1]! + 1;
    const deletion = prev[j]! + 1;
    const substitution = prev[j - 1]! + cost;
    cur[j] = Math.min(insertion, deletion, substitution);
    if (cur[j]! < rowMin) rowMin = cur[j]!;
  }
  return rowMin;
}

/**
 * Levenshtein edit distance with an early-exit bound. Returns
 * `maxDist + 1` as soon as the distance is known to exceed `maxDist`;
 * that early-exit makes the fuzzy fallback cheap even over tens of
 * thousands of names.
 *
 * Pure DP, O(min(len(a), len(b))) memory. Case-sensitive — callers
 * pass `lowercase(name)` strings when they want case-insensitive
 * matching.
 */
export function boundedEditDistance(a: string, b: string, maxDist: number): number {
  const shortcut = tryEditDistanceShortcut(a, b, maxDist);
  if (shortcut !== null) return shortcut;
  const aCodePoints = Array.from(a);
  const bCodePoints = Array.from(b);
  const al = aCodePoints.length;
  const bl = bCodePoints.length;

  const ctx: EditRowCtx = {
    a: aCodePoints,
    b: bCodePoints,
    prev: new Array<number>(bl + 1),
    cur: new Array<number>(bl + 1),
  };
  for (let j = 0; j <= bl; j++) ctx.prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const rowMin = fillEditRow(ctx, i);
    if (rowMin > maxDist) return maxDist + 1;
    [ctx.prev, ctx.cur] = [ctx.cur, ctx.prev];
  }
  return ctx.prev[bl]!;
}

/**
 * Unbounded Levenshtein edit distance — the exact distance with no
 * early-exit cutoff. Use when ranking a small candidate set where the
 * true distance is needed (e.g. "did you mean?" suggestions); prefer
 * {@link boundedEditDistance} when scanning a large corpus and a
 * cutoff lets you skip most of the work.
 */
export function editDistance(a: string, b: string): number {
  return boundedEditDistance(a, b, Number.POSITIVE_INFINITY);
}
