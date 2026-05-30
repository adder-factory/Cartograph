/**
 * @internal — fuzzy-mode handler for the consolidated
 * `cartograph_search({mode: 'fuzzy'})` family. Lives in its own file
 * (prefixed `_` to discourage external import) to keep the family
 * dispatcher small. Logic preserved verbatim from the prior
 * `search-fuzzy.ts` so eval baseline is unchanged.
 */

import type { NodeKind } from '../../types.js';
import { clamp, compact, numArg } from '../../utils.js';
import { textResult, truncateOutput, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok } from './_outcome.js';
import type { ToolCtx } from './types.js';
import type Cartograph from '../../index.js';
import { searchNodes, suggestSymbolNames } from '../../db/queries-search.js';
import { renderMarkdownCardList, type MarkdownCardListSpec } from './_result-spec.js';

/** Default `limit` for fuzzy search when caller doesn't pass one. */
const FUZZY_LIMIT_DEFAULT = 10;

/** Clamp ceiling for `limit` from agent input. */
const FUZZY_LIMIT_MAX = 50;

/**
 * Multiplier widening the suggester fetch beyond `limit` so kind
 * filtering and homonym de-dup don't strand real hits just outside
 * the cutoff.
 */
const FUZZY_OVERFETCH_MULTIPLIER = 4;

/**
 * `suggestSymbolNames` returns four tiers in one ranked list and
 * encodes the tier in the `dist` value:
 *   - tier 0 (verbatim containment)           → dist > FUZZY_EDIT_DIST_MAX
 *   - tier 1 (true Levenshtein edit-distance) → dist ≤ FUZZY_EDIT_DIST_MAX
 *   - tier 2 (subsequence match)              → dist = maxBudget + 1 + ε
 *   - tier 3 (longest-common-substring)       → dist = maxBudget + 1 + 100 + ε
 *
 * Only tier 1 is a real edit distance — tier 0 / 2 / 3 carry offset
 * `dist` values purely for intra-tier ordering. For the 10-char query
 * `handelAdmn` the offsets work out to ~5 for tier 2 and ~105 for
 * tier 3, which is why anything past SUGGEST_MAX_EDIT_DIST renders as
 * "(token match)" rather than a nonsense "(edit-dist 109)".
 *
 * Kept in sync with `SUGGEST_MAX_EDIT_DIST` in `queries-search.ts`
 * (the suggester's hard ceiling). If that constant changes, bump
 * this one too — they encode the same threshold.
 */
const FUZZY_EDIT_DIST_MAX = 5;

interface FuzzyRow {
  name: string;
  dist: number;
  kind: string;
  filePath: string;
  line: number;
  signature: string | null;
}

interface CollectFuzzyArgs {
  cg: Cartograph;
  ranked: ReadonlyArray<{ name: string; dist: number }>;
  limit: number;
  kindFilter: string | undefined;
}

/** Resolve fuzzy-ranked candidate names through searchNodes, de-dup
 *  by node id, and stop at `limit`. Pulled out of
 *  {@link handleSearchFuzzy} so the per-name FTS loop's branching
 *  doesn't drive the orchestrator's cyclomatic complexity. */
function collectFuzzyRows(args: CollectFuzzyArgs): FuzzyRow[] {
  const { cg, ranked, limit, kindFilter } = args;
  const rows: FuzzyRow[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    if (rows.length >= limit) break;
    const nodes = searchNodes(
      cg.queries,
      r.name,
      compact({
        limit: 5,
        kinds: kindFilter ? [kindFilter as NodeKind] : undefined,
      }),
    );
    for (const sr of nodes) {
      if (rows.length >= limit) break;
      // FTS may broaden — keep only exact name matches at this stage
      if (sr.node.name !== r.name) continue;
      if (seen.has(sr.node.id)) continue;
      seen.add(sr.node.id);
      rows.push({
        name: sr.node.name,
        dist: r.dist,
        kind: sr.node.kind,
        filePath: sr.node.filePath,
        line: sr.node.startLine,
        signature: sr.node.signature ?? null,
      });
    }
  }
  return rows;
}

/**
 * Render the per-row "match strength" annotation. Only true
 * Levenshtein matches (dist within {@link FUZZY_EDIT_DIST_MAX}) get
 * the `(edit-dist N)` label — subsequence / substring fallbacks
 * surface as `(token match)` so the agent doesn't read a nonsense
 * "edit-dist 109" and assume the row is bogus.
 */
function formatFuzzyDistNote(dist: number): string {
  if (dist === 0) return '(exact)';
  if (dist <= FUZZY_EDIT_DIST_MAX) return `(edit-dist ${dist})`;
  return '(token match)';
}

/**
 * Build the fuzzy-search card-list spec. H2 outer heading with the
 * query string + hit count; one H3 card per hit carrying the match
 * strength annotation (`(exact)` / `(edit-dist N)` / `(token match)`).
 * Card body lines: `file:line` + optional signature backtick block.
 * The spec OWNS the title wording; the lint walks
 * `cardListSpecStrings` to pin "Fuzzy search" against drift.
 *
 * Caller (`handleSearchFuzzy`) short-circuits the empty path via
 * `textResult(...)` BEFORE this builder is called, so `emptyState`
 * is the never-rendered empty string.
 */
export function buildSearchFuzzySpec(query: string, rows: ReadonlyArray<FuzzyRow>): MarkdownCardListSpec<FuzzyRow> {
  return {
    title: `Fuzzy search for "${query}" (${rows.length} hit${rows.length === 1 ? '' : 's'})`,
    rows,
    rowHeading: (r) => `${r.name} (${r.kind}) ${formatFuzzyDistNote(r.dist)}`,
    rowBody: (r) => {
      const body: string[] = [`${r.filePath}:${r.line}`];
      if (r.signature) body.push(`\`${r.signature}\``);
      return body;
    },
    emptyState: '',
  };
}

function formatFuzzyRows(query: string, rows: ReadonlyArray<FuzzyRow>): string {
  return renderMarkdownCardList(buildSearchFuzzySpec(query, rows)).trimEnd();
}

export async function handleSearchFuzzy(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = validateStringOutcome({ value: args['query'], name: 'query' });
  if (typeof query !== 'string') return query;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const limit = clamp(numArg(args['limit'], FUZZY_LIMIT_DEFAULT), 1, FUZZY_LIMIT_MAX);
  const kindFilter = args['kind'] as string | undefined;

  // Pull a wider name set than `limit` so kind-filtering doesn't
  // strand a real hit just outside the cutoff. Each ranked name may
  // resolve to multiple nodes (homonyms across files / languages),
  // and we de-dupe by node id at the end.
  const ranked = suggestSymbolNames(cg.queries, query, limit * FUZZY_OVERFETCH_MULTIPLIER);
  if (ranked.length === 0) {
    return ok(
      textResult(
        `No fuzzy matches for "${query}" (max edit distance is bounded; try a longer / more specific stem, or fall back to \`cartograph_explore\` for concept searches).`,
      ),
    );
  }

  const rows = collectFuzzyRows({ cg, ranked, limit, kindFilter });
  if (rows.length === 0) {
    const kindNote = kindFilter ? ` with kind=${kindFilter}` : '';
    return ok(
      textResult(
        `Fuzzy ranked ${ranked.length} candidate name(s)${kindNote} but none resolved to indexed nodes. Drop \`kind\` or widen the query.`,
      ),
    );
  }

  return ok(textResult(truncateOutput(formatFuzzyRows(query, rows))));
}
