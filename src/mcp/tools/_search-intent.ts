/**
 * @internal — intent-mode handler for `cartograph_find({by: 'name', mode: 'intent'})`.
 * FTS5 over THREE corpora that describe behavior:
 *   1. symbol_summaries.summary  (LLM-generated; sparse coverage)
 *   2. nodes.docstring           (extracted at index time; free)
 *   3. test_names.description    (mined from it/test/describe calls)
 *
 * The first two anchor to a specific symbol; test names anchor to a
 * test file:line and are rendered as a separate block — the agent
 * uses them as a chase-target ("the test at L142 says X — what does
 * it call?") via cartograph_graph({direction: 'callees'}) on the file.
 */

import { logDebug } from '../../errors.js';
import { clamp, numArg } from '../../utils.js';
import { textResult, truncateOutput } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type { ToolCtx } from './types.js';
import type Cartograph from '../../index.js';
import type { SqliteDatabase } from '../../db/sqlite-adapter.js';
import {
  searchIntentSymbolRows,
  searchIntentTestNameRows,
  type IntentSearchFilters,
  type IntentSymbolHitRow as SymbolIntentRow,
  type IntentTestNameHitRow as TestNameIntentRow,
} from '../../db/queries-intent-search.js';
import { enqueueForPrioritySummary } from '../../db/queries-summary-priority.js';
import { getSummaryCoverage } from '../../db/queries-summaries.js';
import { SUMMARIZABLE_KINDS } from '../../llm/summarizer.js';
export { escapeLike } from '../../db/sql-like.js';

// ============ Constants ============

/** Default result limit when not specified */
const INTENT_DEFAULT_LIMIT = 10;

/** Maximum result limit (user-supplied limit is clamped to this) */
const INTENT_MAX_LIMIT = 100;

/** Over-fetch multiplier: fetch 2× user limit to account for deduplication */
const INTENT_OVERFETCH_MULTIPLIER = 2;

/** Absolute hard cap on over-fetch (never fetch more than this) */
const INTENT_OVERFETCH_MAX = 200;

/** Minimum token length to include in priority-queue lookup */
const INTENT_MIN_TOKEN_LENGTH = 3;

/** Slice size for candidate node IDs in priority-summary enqueueing */
const INTENT_MAX_PRIORITY_QUEUE_BATCH = 20;

/** Coverage percentage threshold below which to show "run summarize" hint */
const INTENT_COVERAGE_WARN_PCT = 50;

/** Snippet truncation length in result rendering */
const INTENT_SNIPPET_MAX_LENGTH = 120;

/**
 * BM25 rank multiplier applied to hits that survive the AND query.
 *
 * bm25() returns NEGATIVE numbers; lower (more negative) = better match.
 * Multiplying by a factor < 1.0 makes the value less negative, which would
 * push AND-confirmed hits DOWN — the wrong direction. We need to make AND
 * hits MORE negative to boost them to the top.
 *
 * Multiplying by a factor > 1.0 achieves this: e.g. −3.5 × 1.5 = −5.25,
 * which sorts before −3.5 in ascending ORDER BY rank. Value chosen so that
 * a "all tokens present" docstring overtakes a "2-of-7 tokens" shorter
 * docstring even when BM25 penalises the longer text for length.
 */
const INTENT_AND_BOOST = 1.5;

/**
 * Sanitize user query for FTS5 to prevent reserved-character crashes.
 * Removes or replaces FTS5 reserved characters: `-`, `^`, `*`, `(`, `)`, `:`, `"`
 * This prevents unintentional operator interpretation (e.g., `issue-tagged` as `issue MINUS tagged`).
 *
 * Returns [sanitized query, was_modified: boolean]
 */
function sanitizeQueryForFts5(query: string): [string, boolean] {
  const original = query;
  // Replace all FTS5-reserved characters with spaces, then collapse whitespace
  const sanitized = query
    .replaceAll(/[-^*():"]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  return [sanitized, original !== sanitized];
}

interface IndexCoverageMetrics {
  summaryRows: number;
  docstringRows: number;
  testNameRows: number;
}

/**
 * Validate and parse search intent arguments.
 * Returns parsed args or a {@link ToolOutcome} `err` arm if validation fails.
 */
function validateSearchIntentArgs(
  args: Record<string, unknown>,
): [string, number, string | undefined, string | undefined, string | undefined, boolean, string] | ToolOutcome {
  const rawQuery = args['query'];
  if (typeof rawQuery !== 'string' || rawQuery.trim() === '') {
    return err('mode=intent: `query` (string) is required.');
  }

  const [sanitizedQuery, wasSanitized] = sanitizeQueryForFts5(rawQuery.trim());
  if (sanitizedQuery === '') {
    return err('mode=intent: query becomes empty after removing FTS5 operators. Please provide alphanumeric terms.');
  }

  const limit = clamp(numArg(args['limit'], INTENT_DEFAULT_LIMIT), 1, INTENT_MAX_LIMIT);
  const kind = args['kind'] as string | undefined;
  const languageFilter = args['languageFilter'] as string | undefined;
  const pathFilter = args['pathFilter'] as string | undefined;

  return [sanitizedQuery, limit, kind, languageFilter, pathFilter, wasSanitized, rawQuery.trim()];
}

/**
 * Check if index has summaries, docstrings, and/or test names indexed.
 */
function checkIndexCoverage(db: SqliteDatabase): IndexCoverageMetrics | ToolOutcome {
  try {
    const summaryRows = (
      db.prepare(`SELECT COUNT(*) AS c FROM symbol_summaries WHERE summary IS NOT NULL AND summary != ''`).get() as {
        c: number;
      }
    ).c;
    const docstringRows = (
      db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE docstring IS NOT NULL AND docstring != ''`).get() as {
        c: number;
      }
    ).c;
    const testNameRows = (db.prepare(`SELECT COUNT(*) AS c FROM test_names`).get() as { c: number }).c;

    const hasNoIndexedContent = summaryRows === 0 && docstringRows === 0 && testNameRows === 0;
    if (hasNoIndexedContent) {
      return err(
        'mode=intent: no summaries, docstrings, or test names indexed — run `cartograph index` for first setup, ' +
          'or re-run `cartograph admin index` to rebuild extracted docstrings/test names. Use `cartograph admin summarize --all` to populate summaries.',
      );
    }

    return { summaryRows, docstringRows, testNameRows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`mode=intent: failed to check index coverage: ${msg}`);
  }
}

interface SearchResults {
  summaryHits: SymbolIntentRow[];
  docstringHits: SymbolIntentRow[];
  testNameHits: TestNameIntentRow[];
  /** Node IDs confirmed by the AND query — every token was present. */
  andConfirmedIds: Set<string>;
}

interface ExecuteIntentSearchesArgs {
  db: SqliteDatabase;
  query: string;
  coverage: IndexCoverageMetrics;
  limit: number;
  filters: IntentSearchFilters;
}

/**
 * Build FTS5 MATCH expressions for both OR and AND semantics.
 *
 * OR expression: FTS5 bare-term queries use implicit AND, so a natural-language
 * phrase like "strip comments from javascript before scanning" matches a document
 * ONLY when every word is present — causing zero hits for terse summaries.
 * Joining tokens with " OR " lets bm25() rank documents by how many terms
 * they contain, giving "best behavioral match first" semantics.
 *
 * AND expression: space-joining tokens uses FTS5's default implicit AND —
 * a document must contain every token. Used to identify high-precision hits
 * (full-phrase match) that get a rank boost during merge.
 *
 * Returns [orExpr, andExpr | null]. andExpr is null when there is only one
 * token (AND and OR are identical — no dual-query overhead needed) or when
 * extractQueryTokens yields no tokens.
 *
 * Falls back to the raw sanitized query for the OR expression when
 * extractQueryTokens yields no tokens (all words shorter than
 * INTENT_MIN_TOKEN_LENGTH), so we never send an empty MATCH expression.
 */
function buildMatchExpressions(query: string): [string, string | null] {
  const tokens = extractQueryTokens(query);
  if (tokens.length === 0) return [query, null];
  const orExpr = tokens.join(' OR ');
  const andExpr = tokens.length >= 2 ? tokens.join(' ') : null;
  return [orExpr, andExpr];
}

/**
 * Execute backend-native full-text searches against the three corpora.
 *
 * When there are ≥2 tokens, runs a second AND query (implicit FTS5 AND —
 * every token must be present) alongside the primary OR query. Node IDs
 * that appear in the AND results are collected into `andConfirmedIds` and
 * used by `mergeSymbolResults` to apply an `INTENT_AND_BOOST` rank
 * multiplier, ensuring verbatim/near-verbatim docstring matches sort above
 * partial-token matches regardless of document length penalties from BM25.
 */
function executeIntentSearches(args: ExecuteIntentSearchesArgs): SearchResults | ToolOutcome {
  const { db, query, coverage, limit, filters } = args;
  const overFetch = Math.min(limit * INTENT_OVERFETCH_MULTIPLIER, INTENT_OVERFETCH_MAX);
  let summaryHits: SymbolIntentRow[] = [];
  let docstringHits: SymbolIntentRow[] = [];
  let testNameHits: TestNameIntentRow[] = [];
  const andConfirmedIds = new Set<string>();

  const [orExpr, andExpr] = buildMatchExpressions(query);

  try {
    summaryHits = searchIntentSymbolRows({
      db,
      corpus: 'summary',
      expression: orExpr,
      filters,
      limit: overFetch,
      rowCount: coverage.summaryRows,
    });
    docstringHits = searchIntentSymbolRows({
      db,
      corpus: 'docstring',
      expression: orExpr,
      filters,
      limit: overFetch,
      rowCount: coverage.docstringRows,
    });
    if (!filters.kind && !filters.language) {
      testNameHits = searchIntentTestNameRows({
        db,
        expression: orExpr,
        limit,
        rowCount: coverage.testNameRows,
        ...(filters.pathPrefix === undefined ? {} : { pathPrefix: filters.pathPrefix }),
      });
    }
    collectAndConfirmedIds({ db, andExpr, filters, overFetch, coverage, out: andConfirmedIds });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const engine = db.dialect === 'postgres' ? 'PostgreSQL full-text' : 'FTS5';
    return err(`mode=intent: ${engine} search failed (${msg}). Try escaping or simplifying the query.`);
  }

  return { summaryHits, docstringHits, testNameHits, andConfirmedIds };
}

function collectAndConfirmedIds(args: {
  db: SqliteDatabase;
  andExpr: string | null;
  filters: IntentSearchFilters;
  overFetch: number;
  coverage: IndexCoverageMetrics;
  out: Set<string>;
}): void {
  const { db, andExpr, filters, overFetch, coverage, out } = args;
  if (andExpr === null || (coverage.summaryRows <= 0 && coverage.docstringRows <= 0)) return;
  for (const row of searchIntentSymbolRows({
    db,
    corpus: 'summary',
    expression: andExpr,
    filters,
    limit: overFetch,
    rowCount: coverage.summaryRows,
  })) {
    out.add(row.id);
  }
  for (const row of searchIntentSymbolRows({
    db,
    corpus: 'docstring',
    expression: andExpr,
    filters,
    limit: overFetch,
    rowCount: coverage.docstringRows,
  })) {
    out.add(row.id);
  }
}

/**
 * Merge symbol results (summary + docstring) by node ID, keeping best rank per node.
 *
 * Defensive null-guard on `text`: production data has surfaced rows where the
 * docstring FTS5 corpus retains a rowid whose `nodes.docstring` column was later
 * nulled (the AFTER-UPDATE-OF-docstring trigger should clear the FTS row but, in
 * older schemas / partially-migrated DBs, can leave dangling FTS entries). Such
 * rows produce `row.text === null` and crashed the renderer at `row.text.length`
 * — the "Cannot read properties of null (reading 'length')" reproducer. Dropping
 * them at the merge boundary keeps the renderer simple and gives the rest of the
 * pipeline a well-typed invariant: every emitted row has a non-empty `text`.
 *
 * AND-confirmed boost: nodes present in `andConfirmedIds` had every query token
 * present — they are high-precision matches. bm25() returns negative numbers
 * (lower = better). Multiplying an AND-confirmed rank by INTENT_AND_BOOST (> 1.0)
 * makes it more negative, moving it toward the top of the ascending sort.
 * This corrects BM25's length-normalisation penalty: a long docstring with all
 * tokens can otherwise lose to a short docstring with 2 of 7 tokens.
 */
interface MergeSymbolResultsArgs {
  summaryHits: SymbolIntentRow[];
  docstringHits: SymbolIntentRow[];
  limit: number;
  andConfirmedIds: Set<string>;
}

function mergeSymbolResults(args: MergeSymbolResultsArgs): SymbolIntentRow[] {
  const { summaryHits, docstringHits, limit, andConfirmedIds } = args;
  const bestByNode = new Map<string, SymbolIntentRow>();
  for (const row of [...summaryHits, ...docstringHits]) {
    // Skip rows whose text is null/empty — defensive guard against
    // stale FTS5 entries pointing to nulled docstring/summary columns.
    if (row.text === null || row.text === undefined || row.text === '') continue;
    const existing = bestByNode.get(row.id);
    if (!existing || row.rank < existing.rank) {
      bestByNode.set(row.id, row);
    }
  }
  return Array.from(bestByNode.values())
    .sort((a, b) => {
      // Apply AND-boost: multiply rank (negative) by INTENT_AND_BOOST (> 1)
      // to make AND-confirmed hits more negative → sorts first ascending.
      const ra = andConfirmedIds.has(a.id) ? a.rank * INTENT_AND_BOOST : a.rank;
      const rb = andConfirmedIds.has(b.id) ? b.rank * INTENT_AND_BOOST : b.rank;
      return ra - rb;
    })
    .slice(0, limit);
}

/**
 * Extract meaningful tokens from a query for unsummarised-symbol lookup.
 * Filters out FTS5 operators and tokens shorter than INTENT_MIN_TOKEN_LENGTH.
 */
function extractQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (t: string) => t.length >= INTENT_MIN_TOKEN_LENGTH && !['and', 'or', 'not'].includes(t), // FTS5 operators
    );
}

/**
 * Look up unsummarised, undocstrung nodes matching any of the given tokens
 * by exact name (case-insensitive). Returns a deduplicated set of node IDs.
 */
function findCandidateNodeIds(db: SqliteDatabase, tokens: string[]): Set<string> {
  const candidateNodeIds = new Set<string>();
  for (const token of tokens) {
    try {
      const rows = db
        .prepare(
          `
        SELECT n.id FROM nodes n
        WHERE LOWER(n.name) = ?
          AND n.id NOT IN (SELECT node_id FROM symbol_summaries WHERE summary IS NOT NULL AND summary != '')
          AND (n.docstring IS NULL OR n.docstring = '')
        LIMIT 20
      `,
        )
        .all(token) as Array<{ id: string }>;
      for (const row of rows) candidateNodeIds.add(row.id);
    } catch (err) {
      // Silently skip token-based lookup on error
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug(`[intent-search] token lookup failed for "${token}": ${errMsg}`);
    }
  }
  return candidateNodeIds;
}

/**
 * Attempt to enqueue candidate node IDs for priority summarisation.
 * Returns an early-return message string when nodes were enqueued, or
 * null when nothing was enqueued (caller should compute a coverage hint).
 */
function tryEnqueueForSummary(cg: Cartograph, candidateNodeIds: Set<string>, query: string): string | null {
  const hasNoCandidates = candidateNodeIds.size === 0;
  if (hasNoCandidates) return null;
  try {
    const result = enqueueForPrioritySummary({
      qb: cg.queries,
      nodeIds: Array.from(candidateNodeIds).slice(0, INTENT_MAX_PRIORITY_QUEUE_BATCH),
    });
    const n = result.enqueued + result.refreshed;
    const symbolsWereEnqueued = n > 0;
    if (symbolsWereEnqueued) {
      return `mode=intent: no summaries, docstrings, or test names matched "${query}".\n> Enqueued ${n} symbol(s) for priority summarisation; re-run after the next summarise pass.`;
    }
  } catch (err) {
    // Log and continue; don't fail the search on queue errors
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug(`[intent-search] queueing failed: ${errMsg}`);
  }
  return null;
}

/**
 * Compute a coverage hint line for appending to the zero-hit message.
 * Returns an empty string when the coverage query itself fails.
 */
function computeCoverageHint(cg: Cartograph): string {
  try {
    const cov = getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS);
    const hasSummarizableNodes = cov.total > 0;
    const coveragePercent = hasSummarizableNodes ? Math.round((cov.summarised / cov.total) * 100) : 0;
    const coverageIsBelowWarnThreshold = coveragePercent < INTENT_COVERAGE_WARN_PCT;
    if (coverageIsBelowWarnThreshold) {
      // Lever C — partial summary coverage is the EXPECTED steady state:
      // the eager pass summarises the high-importance core and the tail
      // drains on demand (this very miss enqueues its candidates). So
      // frame it as "tail not summarised yet", not "index incomplete".
      return `\n> intent-search ranks LLM summaries first (current coverage: ${coveragePercent}% — the rest summarise on demand as searches reference them). For a full pass now run \`cartograph admin summarize --all\`, or fall back to \`cartograph_find by='name' mode='exact'\` for name matches / \`cartograph_find by='content'\` for regex.`;
    }
    return `\n> 0 hits at ${coveragePercent}% coverage — the concept may not be summarised yet, or may not exist in the codebase. Try \`cartograph_context({format: "plan"})\` first; use \`cartograph_explore\` under \`--profile full\` for a broader source fallback.`;
  } catch (err) {
    // Log and continue; don't fail if coverage calculation fails
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug(`[intent-search] coverage calculation failed: ${errMsg}`);
    return '';
  }
}

/**
 * Handle zero-hit case: enqueue unsummarised symbols for priority summary
 * and compute coverage hint.
 */
function handleNoHitResults(query: string, cg: Cartograph): string {
  const tokens = extractQueryTokens(query);
  const candidateNodeIds = findCandidateNodeIds(cg.db.getDb(), tokens);
  const earlyReturn = tryEnqueueForSummary(cg, candidateNodeIds, query);
  if (earlyReturn !== null) return earlyReturn;
  const coverageHint = computeCoverageHint(cg);
  return `mode=intent: no summaries, docstrings, or test names matched "${query}".${coverageHint}`;
}

interface RenderIntentResultsArgs {
  query: string;
  symbolMerged: SymbolIntentRow[];
  testNameHits: TestNameIntentRow[];
  wasSanitized: boolean;
  originalQuery: string;
}

/**
 * Render search results as markdown.
 */
function renderIntentResults(args: RenderIntentResultsArgs): string {
  const { query, symbolMerged, testNameHits, wasSanitized, originalQuery } = args;
  const summaryHitCount = symbolMerged.filter((r) => r.source === 'summary').length;
  const docstringHitCount = symbolMerged.length - summaryHitCount;
  const totalHits = symbolMerged.length + testNameHits.length;
  const provenance = `${summaryHitCount} summaries, ${docstringHitCount} docstrings, ${testNameHits.length} test names`;
  const lines: string[] = [`## Intent search results for "${query}" (${totalHits} found — ${provenance})`, ''];

  const hasSymbolHits = symbolMerged.length > 0;
  if (hasSymbolHits) {
    lines.push('### Symbol matches');
    for (const row of symbolMerged) {
      const loc = row.start_line ? `:${row.start_line}` : '';
      lines.push(`- **${row.name}** (${row.kind}) — via ${row.source}`, `  ${row.file_path}${loc}`);
      const textExceedsSnippetLimit = row.text.length > INTENT_SNIPPET_MAX_LENGTH;
      const snippet = textExceedsSnippetLimit ? `${row.text.slice(0, INTENT_SNIPPET_MAX_LENGTH)}...` : row.text;
      lines.push(`  > ${snippet}`);
    }
    lines.push('');
  }

  if (testNameHits.length > 0) {
    lines.push(
      '### Test-description matches',
      "_Each line is a test assertion. Use `cartograph_graph({direction: 'callees'})` on the test file to find the subject symbol it exercises._",
    );
    for (const row of testNameHits) {
      lines.push(`- \`${row.file_path}:${row.line}\` — "${row.description}"`);
    }
    lines.push('');
  }

  // Add sanitization notice if query was modified
  if (wasSanitized) {
    lines.push(
      '---',
      `_Note: FTS5-reserved characters (hyphens, quotes, operators) were stripped from your query. ` +
        `Original: "${originalQuery}" → Sanitized: "${query}". ` +
        `For advanced FTS5 operators, use \`cartograph_find by='name' mode='exact'\` with the rich query language._`,
    );
  }

  return lines.join('\n').trimEnd();
}

interface ParsedSearchArgs {
  query: string;
  limit: number;
  kind: string | undefined;
  languageFilter: string | undefined;
  pathFilter: string | undefined;
  wasSanitized: boolean;
  originalQuery: string;
}

/** @internal Parse and validate raw tool args into typed search parameters. */
function resolveSearchArgs(args: Record<string, unknown>): ParsedSearchArgs | ToolOutcome {
  const validated = validateSearchIntentArgs(args);
  if ('ok' in validated) return validated;
  const [query, limit, kind, languageFilter, pathFilter, wasSanitized, originalQuery] = validated;
  return { query, limit, kind, languageFilter, pathFilter, wasSanitized, originalQuery };
}

/** @internal Run phases 3-7: build queries, execute searches, merge, handle zero-hit, render. */
function runIntentSearchPipeline(
  cg: Cartograph,
  parsed: ParsedSearchArgs,
  coverageMetrics: IndexCoverageMetrics,
): ToolOutcome {
  const { query, limit, kind, languageFilter, pathFilter, wasSanitized, originalQuery } = parsed;
  const filters: IntentSearchFilters = {};
  if (kind !== undefined) filters.kind = kind;
  if (languageFilter !== undefined) filters.language = languageFilter;
  if (pathFilter !== undefined) filters.pathPrefix = pathFilter;
  const searchResults = executeIntentSearches({
    db: cg.db.getDb(),
    query,
    coverage: coverageMetrics,
    limit,
    filters,
  });
  if ('ok' in searchResults) return searchResults;
  const symbolMerged = mergeSymbolResults({
    summaryHits: searchResults.summaryHits,
    docstringHits: searchResults.docstringHits,
    limit,
    andConfirmedIds: searchResults.andConfirmedIds,
  });
  const totalHits = symbolMerged.length + searchResults.testNameHits.length;
  if (totalHits === 0) return ok(textResult(handleNoHitResults(query, cg)));
  const rendered = renderIntentResults({
    query,
    symbolMerged,
    testNameHits: searchResults.testNameHits,
    wasSanitized,
    originalQuery,
  });
  return ok(textResult(truncateOutput(rendered)));
}

export async function handleSearchIntent(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const parsed = resolveSearchArgs(args);
  if ('ok' in parsed) return parsed;

  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const coverage = checkIndexCoverage(cg.db.getDb());
  if ('ok' in coverage) return coverage;

  return runIntentSearchPipeline(cg, parsed, coverage);
}
