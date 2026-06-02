import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type Cartograph from '../../index.js';
import { compact } from '../../utils.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';
import {
  getCoverageStats,
  getNodeCoverage,
  getCoverageRanked,
  listCoverageSources,
  clearCoverageSource,
} from '../../db/queries-coverage.js';
import { handleCoverageLoad } from './_coverage-load.js';
import { handleCoverageRefresh } from './_coverage-refresh.js';
import { buildCoverageTips } from './_coverage-tips.js';
import type { RefIdCache } from './_id-cache.js';
import { resolveSymbolToNode, symbolNotFound } from './symbol-resolver.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/** Milliseconds per day — used to bucket coverage `ingestedAt` ages. */
const MS_PER_DAY = 86_400_000;

/** Day count above which `fmtAge` switches from "Nd ago" to "Nmo ago". */
const DAYS_PER_MONTH = 30;

/** Clamp ceiling for `limit` from agent input on `mode='ranked'`. */
const COVERAGE_RANKED_LIMIT_MAX = 200;

/** Default `limit` when caller doesn't pass one. */
const COVERAGE_RANKED_LIMIT_DEFAULT = 30;

/** Decimal places rendered for the centrality column. */
const CENTRALITY_DECIMALS = 4;

const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;
const fmtAge = (ts: number) => {
  const days = Math.floor((Date.now() - ts) / MS_PER_DAY);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < DAYS_PER_MONTH) return `${days}d ago`;
  const months = Math.floor(days / DAYS_PER_MONTH);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
};

// P6: returns a `ToolOutcome`. This is the campaign's error-heavy
// POC — eight distinct return sites across the dispatcher + five
// sub-handlers (`via='llm'` rejection, the `drop` missing/unknown
// `source` pair, `symbol`'s validateString + not-found errors, plus
// every success path). Each error becomes the typed `err(...)` arm;
// each success becomes `ok(...)`. The sub-handlers below are
// converted in lockstep so the whole family returns `ToolOutcome`.
//
// The `load` / `refresh` sub-handlers live in `_coverage-load.ts` /
// `_coverage-refresh.ts`; the P6 wave converted them to return a
// `ToolOutcome` of their own, so the dispatcher returns their result
// directly (no `ok(...)` re-wrap).
async function handleCoverage(ctx: ToolCtx, args: CoverageArgs): Promise<ToolOutcome> {
  // `load` and `refresh` are dispatched without resolving the cg
  // upfront — each handler does its own getCartograph and full
  // validation. This keeps the read-mode path unchanged. The
  // `_coverage-load` / `_coverage-refresh` sub-handlers still take a
  // raw `Record<string, unknown>` (they own files outside this
  // migration's scope); the parsed args are a superset, so the cast
  // is safe.
  if (args.mode === 'load') return handleCoverageLoad(ctx, args as Record<string, unknown>);
  if (args.mode === 'refresh') return handleCoverageRefresh(ctx, args as Record<string, unknown>);

  const cg = ctx.getCartograph(args.projectPath);
  // Infer `symbol` mode from a bare `symbol` arg when `mode` is
  // omitted. Without this a `{symbol}` call with no `mode` runs
  // `ranked` and silently drops the symbol. Enforced here so BOTH the
  // MCP surface and the generated `coverage <symbol>` CLI command get
  // the inference from one place. `ranked` stays the no-arg default.
  const mode = args.mode ?? (args.symbol ? 'symbol' : 'ranked');
  // `via` defaults to `auto` via the schema. `via='llm'` is reserved
  // for a future LLM-mediated coverage ranker (not shipped). `rule`
  // and `auto` route to the lcov-data path according to `mode:`.
  const via = args.via ?? 'auto';
  if (via === 'llm') {
    return err(
      "via='llm' is not supported on `cartograph_coverage` yet — no LLM-mediated coverage ranker is shipped. " +
        "Use `via: 'rule'` / no `via` for centrality-weighted lcov ranking.",
    );
  }

  if (mode === 'stats') return handleCoverageStats(cg, args.source);
  if (mode === 'sources') return handleCoverageSources(cg);
  if (mode === 'drop') return handleCoverageDrop(cg, args.source);
  if (mode === 'symbol') return handleCoverageSymbol(cg, args, ctx.refIds);
  return handleCoverageRanked(cg, args);
}

/**
 * mode='sources' — list every ingested coverage source with its row
 * count and freshest ingestion age. The discovery half of the source-
 * cleanup path: a stray / typo `source` label loaded once is otherwise
 * invisible (the default `ranked`/`stats` query picks the highest-
 * coverage row per symbol, so orphan sources just accumulate silently).
 */
function handleCoverageSources(cg: Cartograph): ToolOutcome {
  const sources = listCoverageSources(cg.queries);
  if (sources.length === 0) {
    const tips = buildCoverageTips({ projectRoot: cg.projectRoot, newestIngestedAt: null });
    return ok(textResult(`No coverage sources ingested yet.${tips}`));
  }
  return ok(textResult(renderMarkdownTable(buildCoverageSourcesSpec(sources))));
}

/**
 * One row of the coverage-sources table as the renderer sees it.
 * Exported alongside {@link buildCoverageSourcesSpec} so the wording
 * lint can construct an instance without a real Cartograph.
 */
export interface CoverageSourcesTableRow {
  source: string;
  rowCount: number;
  newestIngestedAt: number;
}

/**
 * Build the typed `ResultSpec` for the coverage-sources listing table.
 * Pure — call sites pass the rows already fetched from
 * `listCoverageSources`. The wording-alignment lint pins the title +
 * column headers + the cleanup-footer to the source-management
 * vocabulary.
 */
export function buildCoverageSourcesSpec(
  shown: ReadonlyArray<CoverageSourcesTableRow>,
): MarkdownTableSpec<CoverageSourcesTableRow> {
  return {
    title: 'Coverage sources',
    // emptyState never rendered — caller short-circuits on
    // sources.length === 0 with a freshness-aware tips block; the
    // wording lives on the spec for lint visibility.
    emptyState: 'No coverage sources ingested yet.',
    columns: [
      { header: 'Source', cell: (r) => `\`${r.source}\`` },
      { header: 'Rows', align: 'right', cell: (r) => String(r.rowCount) },
      { header: 'Newest report', cell: (r) => fmtAge(r.newestIngestedAt) },
    ],
    rows: shown,
    footers: ["Drop a stray / typo source with `cartograph_coverage({mode: 'drop', source: '<label>'})`."],
  };
}

/**
 * mode='drop' — delete every `node_coverage` row for one source label.
 * The cleanup half of the source-management path: removes an accidental
 * or typo'd source entirely (distinct from the per-load `clear` flag,
 * which only clears rows for the source you are *re-loading*).
 */
function handleCoverageDrop(cg: Cartograph, source: string | undefined): ToolOutcome {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return err(
      "cartograph_coverage mode='drop': `source` must be a non-empty string naming the source to delete. " +
        "Call `mode: 'sources'` first to list the ingested labels.",
    );
  }
  const known = listCoverageSources(cg.queries);
  if (!known.some((s) => s.source === source)) {
    const knownSourceNames = known.map((s) => `\`${s.source}\``).join(', ');
    const names =
      known.length > 0
        ? ` Known sources: ${knownSourceNames}.`
        : ' No coverage sources are ingested.';
    return err(`No coverage source named \`${source}\` — nothing to drop.${names}`);
  }
  const removed = clearCoverageSource(cg.queries, source);
  return ok(textResult(`Dropped coverage source \`${source}\` — removed ${removed} row${removed === 1 ? '' : 's'}.`));
}

/** Conventional paths checked by `mode=refresh` (subset — just the most
 *  common ones, same as `_coverage-refresh.ts:CONVENTIONAL_PATHS`). */
const CONVENTIONAL_COVERAGE_PATHS = [
  'coverage/lcov.info',
  'coverage/lcov-report/lcov.info',
  'lcov.info',
  'coverage.lcov',
] as const;

/**
 * Return the first existing conventional coverage file path relative to
 * `projectRoot`, or `null` when none are found. Used by the stats
 * empty-state message so the agent knows whether to call `refresh`.
 */
function findExistingCoverageFile(projectRoot: string): string | null {
  for (const rel of CONVENTIONAL_COVERAGE_PATHS) {
    try {
      const abs = path.resolve(projectRoot, rel);
      if (fs.statSync(abs).isFile()) return rel;
    } catch {
      // not present — skip
    }
  }
  return null;
}

function handleCoverageStats(cg: Cartograph, source: string | undefined): ToolOutcome {
  const stats = getCoverageStats(cg.queries, source);
  if (stats.symbolsWithCoverage === 0) {
    // Probe for existing lcov files so the empty-state message can name
    // a discoverable report rather than just saying "not found".
    const discoveredFile = findExistingCoverageFile(cg.projectRoot);
    const discoveredHint = discoveredFile
      ? ` (found \`${discoveredFile}\` on disk — call \`cartograph_coverage({mode: 'refresh'})\` to ingest it)`
      : '';
    const tips = buildCoverageTips({ projectRoot: cg.projectRoot, newestIngestedAt: null });
    return ok(textResult(`No coverage data ingested yet${discoveredHint}.${tips}`));
  }
  // Scope the freshness probe to `source` when set so a multi-source
  // project filtered to one source doesn't show the wrong source's age.
  // Mirrors the same scoping in handleCoverageRanked's filter-excluded
  // branch — both paths now treat `source` consistently.
  const newestIngestedAt = getNewestIngestedAt(cg, source);
  const sourceSuffix = source ? ` (source: ${source})` : '';
  const lines = [
    `## Project coverage${sourceSuffix}`,
    '',
    `- **Symbols with coverage:** ${stats.symbolsWithCoverage}`,
    `- **Weighted coverage:** ${fmtPct(stats.weightedPct)} (${stats.coveredLines}/${stats.totalLines} lines)`,
    `- **Sources:** ${stats.sources.length > 0 ? stats.sources.join(', ') : '(none)'}`,
  ];
  if (newestIngestedAt != null) {
    lines.push(`- **Newest report:** ${fmtAge(newestIngestedAt)}`);
  }
  const tips = buildCoverageTips({ projectRoot: cg.projectRoot, newestIngestedAt });
  return ok(textResult(lines.join('\n') + tips));
}

/** Newest `ingested_at` for the given `source`, or across all sources
 *  when `source` is omitted, in epoch ms. Returns null when no
 *  coverage rows exist (for the active scope). Scoping matters in
 *  multi-source projects: a stale-coverage warning should reflect the
 *  freshness of the source the caller is actually filtering on. */
function getNewestIngestedAt(cg: Cartograph, source?: string): number | null {
  const where = source ? 'WHERE source = ?' : '';
  const params = source ? [source] : [];
  const row = cg.queries.db.prepare(`SELECT MAX(ingested_at) AS m FROM node_coverage ${where}`).get(...params) as
    | { m: number | null }
    | undefined;
  return row?.m ?? null;
}

function handleCoverageSymbol(cg: Cartograph, args: CoverageArgs, refIds: RefIdCache | undefined): ToolOutcome {
  // Reject an empty / non-string `symbol` so a malformed value can't
  // crash the prepared statements behind getNode/searchNodes. A plain
  // inline check — `validateStringOutcome` would also fit, but this
  // path only needs the non-empty guard.
  const symbol = args.symbol;
  if (typeof symbol !== 'string' || symbol.trim().length === 0) {
    return err('symbol must be a non-empty string');
  }
  if (symbol.length > 4096) {
    return err('symbol must be at most 4096 characters');
  }

  // Resolve via `resolveSymbolToNode` (not the id-only sibling) so a
  // fuzzy FTS match surfaces a `⚠ Fuzzy fallback` banner — without it
  // an approximate guess would be presented as the queried symbol's
  // authoritative coverage. Mirrors biomarkers / note.
  const resolved = resolveSymbolToNode(cg, symbol, refIds);
  // err(...) (not the ok arm) so the adapter flips the CLI exit code
  // to 1 — matches biomarkers' symbol-not-found path. The whole point
  // of P6: this is now compiler-enforced, not a hand-picked convention.
  if (!resolved) return err(symbolNotFound(cg, symbol));
  const nodeId = resolved.node.id;
  const bannerPrefix = resolved.fuzzyBanner ? `${resolved.fuzzyBanner}\n\n` : '';

  const cov = getNodeCoverage(cg.queries, nodeId);
  if (!cov) {
    return ok(
      textResult(
        `${bannerPrefix}No coverage data for \`${symbol}\` (node ${nodeId}). Either it's not in any ingested report, or its span has no executable lines.`,
      ),
    );
  }
  const pct = cov.totalLines > 0 ? cov.coveredLines / cov.totalLines : 0;
  const lines = [
    `${bannerPrefix}## Coverage for \`${symbol}\``,
    '',
    `- **Lines:** ${fmtPct(pct)} (${cov.coveredLines}/${cov.totalLines})`,
  ];
  if (cov.totalBranches != null && cov.totalBranches > 0) {
    const bpct = (cov.coveredBranches ?? 0) / cov.totalBranches;
    lines.push(`- **Branches:** ${fmtPct(bpct)} (${cov.coveredBranches}/${cov.totalBranches})`);
  }
  lines.push(`- **Source:** ${cov.source}`, `- **Ingested:** ${fmtAge(cov.ingestedAt)}`);
  return ok(textResult(lines.join('\n')));
}

function handleCoverageRanked(cg: Cartograph, args: CoverageArgs): ToolOutcome {
  // `limit` is already an integer in [1, 200] — Zod rejected anything
  // else at the dispatch boundary, so no clamp is needed.
  const limit = args.limit ?? COVERAGE_RANKED_LIMIT_DEFAULT;
  const minCentrality = args.minCentrality;
  const maxPct = args.maxPct;
  const source = args.source;
  const kinds = args.kinds;
  const rows = getCoverageRanked(cg.queries, compact({ limit, minCentrality, maxPct, kinds, source }));
  if (rows.length === 0) {
    // Distinguish "coverage was never ingested" from "coverage exists
    // but the filter excluded every row". The first warrants the
    // ingest-a-report tips block; the second warrants a "tighten the
    // filter" pointer. `getCoverageStats(...).symbolsWithCoverage`
    // returns the count of distinct symbols that have at least one
    // coverage row — the load-bearing signal for "is there anything
    // worth filtering?". Handoff #6 sub-b: the prior implementation
    // used `getNewestIngestedAt` (effectively the same probe) but the
    // wrong-shaped tips block fired with no caveat that filter
    // tightness was the real issue.
    const symbolsWithCoverage = getCoverageStats(cg.queries, source).symbolsWithCoverage;
    if (symbolsWithCoverage === 0) {
      // No coverage data at all (or none under the active `source`
      // filter). Use a wording that implies "ingest" not "filter".
      const tips = buildCoverageTips({ projectRoot: cg.projectRoot, newestIngestedAt: null });
      const head =
        source === undefined ? 'No coverage data ingested yet.' : `No coverage data ingested for source "${source}".`;
      return ok(renderToolResponse({ body: '', empty: { message: head + tips } }));
    }
    // Coverage IS ingested — the filter excluded everything. Skip the
    // ingest-a-report tips entirely; emit a filter-specific pointer.
    // Scope the stale-coverage probe to `source` so a multi-source
    // project doesn't show "today" when the active source is months
    // old (or vice-versa).
    const newestIngestedAt = getNewestIngestedAt(cg, source);
    const freshness = buildCoverageTips({ projectRoot: cg.projectRoot, newestIngestedAt });
    const head = `No coverage rows match those filters out of ${symbolsWithCoverage} symbol${symbolsWithCoverage === 1 ? '' : 's'} with coverage. Try lowering \`minCentrality\` or raising \`maxPct\` (must be in [0, 1] — \`0.5\` = 50%).`;
    return ok(renderToolResponse({ body: '', empty: { message: head + freshness } }));
  }
  return ok(renderToolResponse({ body: renderMarkdownTable(buildCoverageRankedSpec(rows)) }));
}

/**
 * One row of the coverage-ranked table as the renderer sees it. Exported
 * alongside {@link buildCoverageRankedSpec} so the wording-lint test in
 * `__tests__/result-spec.test.ts` can construct an instance without a
 * real Cartograph.
 */
export interface CoverageRankedTableRow {
  i: number;
  name: string;
  kind: string;
  filePath: string;
  pct: number;
  coveredLines: number;
  totalLines: number;
  centrality: number | null;
}

/**
 * Build the typed `ResultSpec` for the coverage-ranked ("lowest first")
 * table. Pure — call sites pass the already-fetched + filtered rows.
 * The wording-alignment lint imports this and asserts the `title` /
 * preamble / column headers / empty-state stay aligned with the
 * coverage tool's `.describe()` text.
 */
export function buildCoverageRankedSpec(
  shown: ReadonlyArray<Omit<CoverageRankedTableRow, 'i'>>,
): MarkdownTableSpec<CoverageRankedTableRow> {
  return {
    title: `Coverage — lowest first (top ${shown.length})`,
    preamble: [
      'High-impact untested code = high centrality + low coverage. Tests for these protect the most callers per line of test written.',
    ],
    // emptyState is never rendered here — the caller short-circuits on
    // `rows.length === 0` to a freshness-aware empty message. The spec
    // owns the wording anyway so the lint can pin it.
    emptyState:
      'No coverage rows match those filters. Try lowering `minCentrality` or raising `maxPct`, or ingest a coverage report.',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'Symbol', cell: (r) => `\`${r.name}\`` },
      { header: 'Kind', cell: (r) => r.kind },
      { header: 'File', cell: (r) => `\`${r.filePath}\`` },
      {
        header: 'Coverage',
        align: 'right',
        cell: (r) => `${fmtPct(r.pct)} (${r.coveredLines}/${r.totalLines})`,
      },
      {
        header: 'PR centrality',
        align: 'right',
        cell: (r) => (r.centrality == null ? '—' : r.centrality.toFixed(CENTRALITY_DECIMALS)),
      },
    ],
    rows: shown.map((r, i) => ({ ...r, i })),
  };
}

/**
 * Zod schema for `cartograph_coverage` — a flat `mode`-discriminator
 * object. Every per-mode field is `.optional()` (the handler keeps all
 * cross-field / per-mode validation), matching the hand-written JSON
 * `inputSchema` exactly. `limit` is `.int().min(1).max(200)` — the
 * legacy handler clamped over-cap values, but under the locked
 * reject-out-of-range policy both ends are now rejected at the
 * dispatch boundary, so the handler drops the `clampInt`.
 */
const coverageSchema = z.object({
  mode: z
    .enum(['symbol', 'ranked', 'stats', 'load', 'refresh', 'sources', 'drop'])
    .optional()
    .describe(
      'Data-source axis. `refresh` auto-discovers and ingests an lcov report under conventional projectRoot paths (no `reportPath`). ' +
        '`load` ingests an explicit `reportPath`. `symbol` checks one node (auto-selected when a `symbol` arg is passed without `mode`). `ranked` (default) lists worst-coverage-first. `stats` returns the project rollup. ' +
        '`sources` lists ingested source labels with row count + age. `drop` deletes every row for one `source` label.',
    ),
  via: z
    .enum(['rule', 'llm', 'auto'])
    .optional()
    .describe(
      'Classifier axis. `rule` and the default `auto` run centrality-weighted lcov ranking. `llm` is not yet implemented (returns an error).',
    ),
  reportPath: z
    .string()
    .optional()
    .describe('(mode=load) Absolute or project-relative path to the lcov.info report file.'),
  clear: z
    .boolean()
    .default(false)
    .describe('(mode=load) Drop existing rows for this source before loading (full refresh).'),
  symbol: z
    .string()
    .optional()
    .describe(
      "For mode='symbol': node id, qualified name, or plain name. A plain name matching multiple symbols returns the first hit; qualify to disambiguate.",
    ),
  minCentrality: z
    .number()
    .optional()
    .describe(
      "For mode='ranked': only include symbols with centrality >= this, to focus on structurally important code. " +
        'Most repos sit in the `0.0001`–`0.01` range — start low and raise. Omit for no filter.',
    ),
  maxPct: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "For mode='ranked': only include symbols with coverage_pct <= this. Must be in [0, 1] (`0.5` = 50%; `1` = no upper bound); out-of-range is rejected. Default no filter.",
    ),
  kinds: z
    .array(z.string())
    .optional()
    .describe(
      "For mode='ranked': filter by node kind (e.g. ['function', 'method']). Default all symbol-bearing kinds.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      '(mode=load) Label for this report (e.g. "unit", "e2e"); default "lcov". ' +
        '(mode=ranked / stats) Filter the read to one source; default unfiltered, picking the highest-coverage row per symbol. ' +
        '(mode=drop) REQUIRED — the source label whose rows are deleted.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(COVERAGE_RANKED_LIMIT_MAX)
    .optional()
    .describe("For mode='ranked': max rows (default 30; integer in [1, 200], out-of-range rejected)."),
  includeTests: z
    .boolean()
    .optional()
    .describe('Include test files in the candidate set. Default true; set false to focus on production code.'),
  projectPath: projectPathField,
});

type CoverageArgs = z.infer<typeof coverageSchema>;

export const COVERAGE_TOOL = defineTool({
  name: 'cartograph_coverage',
  description:
    'Per-symbol coverage joined to the graph — composes with centrality/role/churn.\n\n' +
    '`mode`: `refresh` (auto-discover lcov under projectRoot) | `load` (explicit path) | `symbol` | `ranked` (default, worst-first) | `stats` | `sources` | `drop`. ' +
    "Useful query: `mode: 'ranked', maxPct: 0.5` for high-impact under-tested code; add `minCentrality` (start ~`0.0001`, most repos sit in `0.0001`–`0.01`) to focus on structurally critical symbols. " +
    "Onboarding: `mode: 'refresh'` after a test run, no path needed.",
  schema: coverageSchema,
  handle: handleCoverage,
  // mode='load' mutates indexed coverage rows. Mark the family as a
  // write tool — the read modes (symbol/ranked/stats) get hidden under
  // --no-write-tools too, but that's the conservative default.
  isWriteTool: true,
});
