import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { ToolResult } from '../tool-types.js';
import { getHotspots, getCategorizedHotspots, type HotspotRow } from '../../db/queries-history.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { isShallowClone } from '../../git-utils.js';

/** Default cap on returned rows; callers can override via `limit:N` arg. */
const DEFAULT_LIMIT = 15;
/** Hard cap on caller-supplied `limit` so a request can't ask for the whole index. */
const MAX_LIMIT = 100;
/** Default `minCommits` floor — excludes test fixtures and one-off files. */
export const DEFAULT_MIN_COMMITS = 3;
/** Centrality / risk numbers rounded to this many decimal places in the output. */
const SCORE_DECIMALS = 4;
/** ms → seconds for `last_touched_ts` math. */
const MS_PER_SECOND = 1000;
/** seconds-per-day for the age threshold. */
const SECONDS_PER_DAY = 86400;
/** Days under this report in days; at/above, switch to months. */
const DAYS_TO_MONTHS = 30;

/**
 * Zod schema for `cartograph_hotspots`. `limit` is `.int().min(1).max(100)`,
 * `minCommits` `.int().min(0)`, `recencyDays` `.int().min(1)`,
 * `minCentrality` `.min(0).max(1)` (a 0-1 fraction, not an integer) —
 * out-of-range / non-integer values are REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision), matching the
 * CLI's `assignIntArg` / `assignFloatArg` rejections. The handler
 * therefore drops the old `clampInt` + `Math.max(0, …)` plumbing.
 */
const hotspotsSchema = z.object({
  category: z
    .enum(['risk', 'maintenance', 'brittle', 'all'])
    .default('risk')
    .describe(
      "Maintenance lens. 'risk' (default) = high centrality × high churn; 'maintenance' = high churn + low centrality (refactor targets); 'brittle' = high centrality + low churn + ≥1 external dependent (real downstream blast radius); 'all' = all three sections (cap per section = ceil(limit/3)).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      'Max files to return (default 15). Integer in [1, 100]; out-of-range is rejected. When category=all, split across 3 sections.',
    ),
  minCommits: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_MIN_COMMITS)
    .describe(
      'Exclude files touched in fewer than N commits (default 3, excluding test fixtures and one-off files). Non-negative integer.',
    ),
  minCentrality: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      'Exclude files whose total node centrality (Σ PageRank) is below this threshold (default 0 = no filter). Fraction in [0, 1]; useful to drop docs/config files.',
    ),
  sortBy: z
    .enum(['risk', 'centrality', 'churn'])
    .default('risk')
    .describe(
      "Sort dimension (category='risk' only): risk = centrality × churn (default), centrality = structural importance, churn = change frequency.",
    ),
  recencyDays: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Restrict to files touched within the last N days (default: no recency filter). Positive integer.'),
  projectPath: projectPathField,
});

type HotspotsArgs = z.infer<typeof hotspotsSchema>;

type HotspotSort = 'risk' | 'centrality' | 'churn';
type HotspotCategory = 'risk' | 'maintenance' | 'brittle' | 'all';

/** Parsed and normalized arguments for hotspots query. */
interface ParsedHotspotsArgs {
  limit: number;
  minCommits: number;
  minCentrality: number;
  sortBy: HotspotSort;
  recencyDays: number | undefined;
  category: HotspotCategory;
}

/** Arguments for categorized hotspots query. */
interface CategorizedHotspotsQueryArgs {
  minCommits: number;
  minCentrality: number;
  limitPerCategory: number;
  recencyDays?: number;
}

/**
 * Project the parsed/typed Zod args onto the internal
 * {@link ParsedHotspotsArgs} shape. Defaults and numeric ranges are
 * already enforced by `safeParse` at the dispatch boundary, so this is
 * now a plain field copy (kept as a function so the rest of the module
 * is unchanged).
 */
function parseHotspotsArgs(args: HotspotsArgs): ParsedHotspotsArgs {
  return {
    limit: args.limit,
    minCommits: args.minCommits,
    minCentrality: args.minCentrality,
    sortBy: args.sortBy,
    recencyDays: args.recencyDays,
    category: args.category,
  };
}

/** Arguments for {@link buildCategorizedQueryOpts}. */
interface BuildCategorizedQueryOptsArgs {
  minCommits: number;
  minCentrality: number;
  limitPerCategory: number;
  recencyDays: number | undefined;
}

/**
 * Build query options for categorized hotspots with optional recency filter.
 */
function buildCategorizedQueryOpts(args: BuildCategorizedQueryOptsArgs): CategorizedHotspotsQueryArgs {
  const { minCommits, minCentrality, limitPerCategory, recencyDays } = args;
  const opts: CategorizedHotspotsQueryArgs = { minCommits, minCentrality, limitPerCategory };
  if (recencyDays !== undefined) opts.recencyDays = recencyDays;
  return opts;
}

/* `formatRiskRow` + `formatBasicRow` + `formatAllSection` removed
 * (G16 Track B batch 5) — superseded by `buildHotspotsAllRiskSpec`
 * + `buildHotspotsAllCategorySpec`, both rendered through the
 * MarkdownTableSpec contract. The category=all composite now also
 * routes null LOC through the `'—'` rendering used by the
 * per-category specs from batch 1+2 — the legacy template-literal
 * `'null'` emission documented in the prior g16-track-b follow-up
 * comments is gone.
 */

/** Arguments for {@link formatCategorizedHotspots}. */
interface FormatCategorizedHotspotsArgs {
  perCat: number;
  riskRows: HotspotRow[];
  maintenanceRows: HotspotRow[];
  brittleRows: HotspotRow[];
  minCommits: number;
}

/**
 * Format markdown output for category='all' (three sections).
 *
 * Returns the body + an optional cap footer; the `renderToolResponse`
 * chokepoint truncates the body first, then appends the footer — so a
 * wide three-section table can't push the "raise limit" hint off-budget
 * (the legacy code appended the footer BEFORE truncation).
 */
function formatCategorizedHotspots(args: FormatCategorizedHotspotsArgs): { body: string; footer: string | undefined } {
  const { perCat, riskRows, maintenanceRows, brittleRows, minCommits } = args;
  const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
  const lines: string[] = [
    `## Hotspots (category=all, top ${perCat} per section)`,
    '',
    'Three maintenance-lens categories — each highlights a different risk dimension.',
  ];
  if (minCommits > DEFAULT_MIN_COMMITS) {
    lines.push(
      '',
      `> ⚠️ \`minCommits: ${minCommits}\` is above the default (${DEFAULT_MIN_COMMITS}). ` +
        `The SQL floor pre-filters low-churn files, so the **Brittle dependencies** section shows ` +
        `the LEAST churned of the survivors — not truly low-churn. Lower \`minCommits\` or omit it for accurate brittle results.`,
    );
  }
  lines.push(
    '',
    renderMarkdownTable(buildHotspotsAllRiskSpec(riskRows, nowSec)),
    renderMarkdownTable(buildHotspotsAllCategorySpec({ rows: maintenanceRows, category: 'maintenance', nowSec })),
    renderMarkdownTable(buildHotspotsAllCategorySpec({ rows: brittleRows, category: 'brittle', nowSec })),
  );

  // Heuristic "more available" signal: if any section filled to its
  // per-category cap, more rows likely exist beyond the truncation.
  const anySectionAtCap =
    riskRows.length === perCat || maintenanceRows.length === perCat || brittleRows.length === perCat;
  const footer = anySectionAtCap
    ? `_One or more sections hit the per-category cap (${perCat}). Raise \`limit\` if you need more rows in any bucket._`
    : undefined;

  return { body: lines.join('\n'), footer };
}

/**
 * Build the H3 sub-section spec for the `category=all` Risk section.
 * Same 7-column shape as the standalone risk view from batch 1
 * ({@link buildHotspotsRiskSpec}) but with the composite-shorter
 * title `Risk hotspots`, a different preamble that's tighter for the
 * 3-section layout, an empty-state that names "this category" rather
 * than "this filter", and `headingLevel: 3`. The two specs share the
 * column layout — column drift would surface in tests that read
 * `spec.columns`.
 */
export function buildHotspotsAllRiskSpec(
  rows: ReadonlyArray<Omit<HotspotsRiskTableRow, 'i'>>,
  nowSec: number,
): MarkdownTableSpec<HotspotsRiskTableRow> {
  return {
    title: 'Risk hotspots',
    headingLevel: 3,
    preamble: ['High structural centrality × high churn. Where bugs hide — review these first.'],
    emptyState: '_No files qualify for this category._',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'File', cell: (r) => `\`${r.filePath}\`` },
      { header: 'Centrality', align: 'right', cell: (r) => r.fileCentrality.toFixed(SCORE_DECIMALS) },
      { header: 'Commits', align: 'right', cell: (r) => String(r.commitCount) },
      // Null LOC → `'—'`, matching the standalone risk spec's
      // convention (the category=all path previously emitted the
      // literal string `'null'` via the legacy `formatRiskRow`
      // template; the migration retires that behavior).
      { header: 'LOC', align: 'right', cell: (r) => (r.loc == null ? '—' : String(r.loc)) },
      { header: 'Last touched', cell: (r) => formatAge(r.lastTouchedTs, nowSec) },
      { header: 'Risk', align: 'right', cell: (r) => r.riskScore.toFixed(SCORE_DECIMALS) },
    ],
    rows: rows.map((r, i) => ({ ...r, i })),
  };
}

/** Arg bundle for {@link buildHotspotsAllCategorySpec} — keeps the
 *  builder under the 4-param `long_parameter_list` info floor. */
export interface BuildHotspotsAllCategorySpecArgs {
  rows: ReadonlyArray<Omit<HotspotsCategoryTableRow, 'i'>>;
  category: 'maintenance' | 'brittle';
  nowSec: number;
}

/**
 * Build the H3 sub-section spec for the `category=all` Maintenance
 * burden / Brittle dependencies section. Same 6-column shape as the
 * standalone category view from batch 2 ({@link buildHotspotsCategorySpec})
 * but with composite-shorter titles ('Maintenance burden' / 'Brittle
 * dependencies' — no 'Hotspots — ' prefix), preambles tightened for
 * the 3-section layout, and `headingLevel: 3`. The
 * `minCommits`-above-floor brittle warning DOES NOT render here — the
 * outer {@link formatCategorizedHotspots} composer hoists that
 * warning to the H2 level (so the reader sees it once at the top
 * rather than per-section).
 */
export function buildHotspotsAllCategorySpec(
  args: BuildHotspotsAllCategorySpecArgs,
): MarkdownTableSpec<HotspotsCategoryTableRow> {
  const { rows, category, nowSec } = args;
  const title = category === 'maintenance' ? 'Maintenance burden' : 'Brittle dependencies';
  const preamble =
    category === 'maintenance'
      ? 'High churn, low centrality. Not depended on, but always changing — refactor target or tooling-debt smell.'
      : 'High centrality, low churn. Stable critical code — changes here have outsized impact. Tread carefully.';
  return {
    title,
    headingLevel: 3,
    preamble: [preamble],
    emptyState: '_No files qualify for this category._',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'File', cell: (r) => `\`${r.filePath}\`` },
      { header: 'Centrality', align: 'right', cell: (r) => r.fileCentrality.toFixed(SCORE_DECIMALS) },
      { header: 'Commits', align: 'right', cell: (r) => String(r.commitCount) },
      // Null LOC → `'—'`, matching the standalone category spec
      // (the category=all path previously emitted `'null'` via
      // `formatBasicRow`'s template — retired).
      { header: 'LOC', align: 'right', cell: (r) => (r.loc == null ? '—' : String(r.loc)) },
      { header: 'Last touched', cell: (r) => formatAge(r.lastTouchedTs, nowSec) },
    ],
    rows: rows.map((r, i) => ({ ...r, i })),
  };
}

/**
 * Format markdown output for category='maintenance' or category='brittle'.
 * Returns the raw body; the chokepoint owns truncation.
 */
function formatSingleCategoryHotspots(
  category: 'maintenance' | 'brittle',
  rows: HotspotRow[],
  minCommits: number,
): string {
  const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
  return renderMarkdownTable(buildHotspotsCategorySpec({ rows, category, nowSec, minCommits }));
}

/** Arg bundle for {@link buildHotspotsCategorySpec} — keeps the
 *  builder under the 4-param `long_parameter_list` info floor. */
export interface BuildHotspotsCategorySpecArgs {
  rows: ReadonlyArray<Omit<HotspotsCategoryTableRow, 'i'>>;
  category: 'maintenance' | 'brittle';
  nowSec: number;
  minCommits: number;
}

/**
 * One row of the hotspots-category table — same 6-col shape as risk
 * minus the Risk column. Exported alongside
 * {@link buildHotspotsCategorySpec} so the wording-lint test can
 * construct an instance without a real Cartograph.
 */
export interface HotspotsCategoryTableRow {
  i: number;
  filePath: string;
  fileCentrality: number;
  commitCount: number;
  loc: number | null;
  lastTouchedTs: number | null;
}

/**
 * Build the typed `ResultSpec` for the hotspots category=maintenance |
 * brittle table. Pure — call sites pass already-fetched rows, the
 * category, a captured `nowSec`, and the effective `minCommits` (so
 * the brittle-above-floor warning can render in the preamble). The
 * wording-alignment lint pins title + preamble + column headers to
 * the category-specific vocabulary.
 */
export function buildHotspotsCategorySpec(
  args: BuildHotspotsCategorySpecArgs,
): MarkdownTableSpec<HotspotsCategoryTableRow> {
  const { rows, category, nowSec, minCommits } = args;
  const categoryLabel = category === 'maintenance' ? 'Maintenance burden' : 'Brittle dependencies';
  const categoryRationale =
    category === 'maintenance'
      ? 'High churn, low centrality. Not depended on but always changing — refactor target / tooling-debt smell.'
      : 'High centrality, low churn. Stable critical code — changes here have outsized impact.';
  const preamble: string[] = [categoryRationale];
  // `brittle` semantics require LOW churn. If the caller passed a high
  // `minCommits`, the SQL floor excludes most low-churn files BEFORE
  // categorisation. Any rows that survive may be comparatively low-churn
  // relative to the remaining set, but still carry more commits than the
  // category's intent suggests. Surface the caveat in the preamble.
  if (category === 'brittle' && minCommits > DEFAULT_MIN_COMMITS) {
    preamble.push(
      '',
      `> ⚠️ \`minCommits: ${minCommits}\` is above the default (${DEFAULT_MIN_COMMITS}). The SQL floor pre-filters low-churn files, ` +
        `so "brittle" results here are the LEAST churned of those that survived the floor — not necessarily truly low-churn. ` +
        `Lower \`minCommits\` or omit it to get accurate brittle results.`,
    );
  }
  return {
    title: `Hotspots — ${categoryLabel} (top ${rows.length})`,
    preamble,
    emptyState: `No files qualify for the ${categoryLabel.toLowerCase()} category. Check \`minCommits\` (default 3) and \`minCentrality\`.`,
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'File', cell: (r) => `\`${r.filePath}\`` },
      { header: 'Centrality', align: 'right', cell: (r) => r.fileCentrality.toFixed(SCORE_DECIMALS) },
      { header: 'Commits', align: 'right', cell: (r) => String(r.commitCount) },
      // Null LOC → `'—'`, matching the risk-spec convention. See
      // `HotspotsRiskTableRow.loc` for the rationale.
      { header: 'LOC', align: 'right', cell: (r) => (r.loc == null ? '—' : String(r.loc)) },
      { header: 'Last touched', cell: (r) => formatAge(r.lastTouchedTs, nowSec) },
    ],
    rows: rows.map((r, i) => ({ ...r, i })),
  };
}

/**
 * Format markdown output for category='risk' (default behavior).
 * Returns the raw body; the chokepoint owns truncation.
 */
function formatRiskHotspots(sortBy: HotspotSort, rows: HotspotRow[]): string {
  const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
  return renderMarkdownTable(buildHotspotsRiskSpec(rows, sortBy, nowSec));
}

/**
 * One row of the hotspots-risk table as the renderer sees it. Exported
 * alongside {@link buildHotspotsRiskSpec} so the wording-lint test in
 * `__tests__/result-spec.test.ts` can construct an instance without a
 * real Cartograph.
 */
export interface HotspotsRiskTableRow {
  i: number;
  filePath: string;
  fileCentrality: number;
  commitCount: number;
  /** Source LOC for the file — `null` when the file row predates the
   *  LOC backfill or the file is binary. Renders as `'—'` — the
   *  null-rendering convention matching every other numeric-null
   *  column in the codebase (cf. coverage centrality). The
   *  pre-migration handler template-literal'd this as the literal
   *  string `'null'`; switching to `'—'` was an intentional UX fix
   *  in this commit (locked by the regression test
   *  `hotspots risk spec renders null LOC as '—'`). */
  loc: number | null;
  lastTouchedTs: number | null;
  riskScore: number;
}

/**
 * Build the typed `ResultSpec` for the hotspots category=risk table.
 * Pure — call sites pass already-fetched rows + `sortBy` + a captured
 * `nowSec`. The wording-alignment lint pins the title / preamble /
 * column headers to the hotspots vocabulary.
 */
export function buildHotspotsRiskSpec(
  rows: ReadonlyArray<Omit<HotspotsRiskTableRow, 'i'>>,
  sortBy: HotspotSort,
  nowSec: number,
): MarkdownTableSpec<HotspotsRiskTableRow> {
  return {
    title: `Hotspots (sortBy=${sortBy}, top ${rows.length})`,
    preamble: ['High-risk files = high structural centrality × high git churn. Review these first.'],
    emptyState:
      'No hotspots match the filter. Check `minCommits` (default 3 — excludes test fixtures and one-off files) and `minCentrality`.',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'File', cell: (r) => `\`${r.filePath}\`` },
      { header: 'Centrality', align: 'right', cell: (r) => r.fileCentrality.toFixed(SCORE_DECIMALS) },
      { header: 'Commits', align: 'right', cell: (r) => String(r.commitCount) },
      {
        header: 'LOC',
        align: 'right',
        // Null LOC renders as `'—'` (matching the coverage tool's
        // centrality-null convention). The pre-migration handler
        // template-literal'd null as the literal string `'null'`, which
        // surfaced as a UX bug in any file row that predates the LOC
        // backfill or carries a binary path. `'—'` reads as "no
        // value", aligned with how every other numeric-null column in
        // the codebase renders.
        cell: (r) => (r.loc == null ? '—' : String(r.loc)),
      },
      { header: 'Last touched', cell: (r) => formatAge(r.lastTouchedTs, nowSec) },
      { header: 'Risk', align: 'right', cell: (r) => r.riskScore.toFixed(SCORE_DECIMALS) },
    ],
    rows: rows.map((r, i) => ({ ...r, i })),
  };
}

/**
 * Returns an informational shallow-clone warning line when the repo is a
 * shallow clone AND ≥ half of the result rows show zero commits. In that
 * situation churn mining silently produces no data (git has no history to
 * count), so risk scores are uniformly 0 — which users misread as "no risk".
 *
 * The check is deliberately lenient: if SOME rows have commits > 0 (e.g.
 * a partial unshallow, or files committed after clone), the warning only
 * fires when the zero-commit majority is still ≥ 50 % of the list.
 */
function shallowCloneBanner(projectRoot: string, rows: ReadonlyArray<{ commitCount: number }>): string | undefined {
  if (!isShallowClone(projectRoot)) return undefined;
  if (rows.length === 0) return undefined;
  const zeroCount = rows.filter((r) => r.commitCount === 0).length;
  if (zeroCount < rows.length / 2) return undefined;
  return (
    '_⚠ Shallow clone — no churn history available; risk = 0 across the list. ' +
    'Run `git fetch --unshallow` to enable churn._'
  );
}

/** Handle category=all: fetch all three categories and render the combined report. */
function handleAllCategories(cg: ReturnType<ToolCtx['getCartograph']>, parsed: ParsedHotspotsArgs): ToolResult {
  const { limit, minCommits, minCentrality, recencyDays } = parsed;
  const perCat = Math.ceil(limit / 3);
  const catOpts = buildCategorizedQueryOpts({ minCommits, minCentrality, limitPerCategory: perCat, recencyDays });
  const {
    risk: riskRows,
    maintenance: maintenanceRows,
    brittle: brittleRows,
  } = getCategorizedHotspots(cg.queries, catOpts);
  const allEmpty = riskRows.length === 0 && maintenanceRows.length === 0 && brittleRows.length === 0;
  if (allEmpty) return renderToolResponse({ body: '', empty: { message: formatNoHotspotsMessage(cg) } });
  const { body, footer } = formatCategorizedHotspots({ perCat, riskRows, maintenanceRows, brittleRows, minCommits });
  const allRows = [...riskRows, ...maintenanceRows, ...brittleRows];
  const banner = shallowCloneBanner(cg.projectRoot, allRows);
  return renderToolResponse({ body, footers: [banner, footer] });
}

/** Handle category=maintenance or category=brittle: single-category request. */
function handleSingleCategory(cg: ReturnType<ToolCtx['getCartograph']>, parsed: ParsedHotspotsArgs): ToolResult {
  const { limit, minCommits, minCentrality, recencyDays, category } = parsed;
  const singleOpts = buildCategorizedQueryOpts({ minCommits, minCentrality, limitPerCategory: limit, recencyDays });
  const categorized = getCategorizedHotspots(cg.queries, singleOpts);
  const rows = category === 'maintenance' ? categorized.maintenance : categorized.brittle;
  if (rows.length === 0) return renderToolResponse({ body: '', empty: { message: formatNoHotspotsMessage(cg) } });
  const banner = shallowCloneBanner(cg.projectRoot, rows);
  return renderToolResponse({
    body: formatSingleCategoryHotspots(category as 'maintenance' | 'brittle', rows, minCommits),
    footers: [banner],
  });
}

/** Handle the default category=risk path (existing behavior, backward compatible). */
function handleRiskCategory(cg: ReturnType<ToolCtx['getCartograph']>, parsed: ParsedHotspotsArgs): ToolResult {
  const { limit, minCommits, minCentrality, sortBy, recencyDays } = parsed;
  const opts: {
    limit: number;
    minCommits: number;
    minCentrality: number;
    sortBy: HotspotSort;
    recencyDays?: number;
  } = { limit, minCommits, minCentrality, sortBy };
  if (recencyDays !== undefined) opts.recencyDays = recencyDays;
  const rows: HotspotRow[] = getHotspots(cg.queries, opts);
  if (rows.length === 0) return renderToolResponse({ body: '', empty: { message: formatNoHotspotsMessage(cg) } });
  // SQL LIMIT — exact-cap row count is the heuristic for "more available".
  // The chokepoint truncates the risk table first, then appends the cap
  // footer (verbatim `appendMoreHint` wording).
  const hasMore = rows.length >= limit;
  const banner = shallowCloneBanner(cg.projectRoot, rows);
  return renderToolResponse({
    body: formatRiskHotspots(sortBy, rows),
    footers: [banner, hasMore ? '> Result capped — pass a higher `limit` to see more.' : undefined],
  });
}

async function handleHotspots(ctx: ToolCtx, args: HotspotsArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const parsed = parseHotspotsArgs(args);
  const { category } = parsed;
  // The per-category helpers return a bare `ToolResult` (a pure
  // success envelope from `renderToolResponse`) — wrap in `ok(...)`.
  if (category === 'all') return ok(handleAllCategories(cg, parsed));
  if (category === 'maintenance' || category === 'brittle') return ok(handleSingleCategory(cg, parsed));
  return ok(handleRiskCategory(cg, parsed));
}

/**
 * Render `lastTouchedTs` (Unix seconds) as a relative age string —
 * `today`, `1d ago`, `12d ago`, `1mo ago`, `5mo ago`, or `—` when
 * the timestamp is missing.
 */
function formatAge(ts: number | null, nowSec: number): string {
  if (!ts) return '—';
  const days = Math.floor((nowSec - ts) / SECONDS_PER_DAY);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < DAYS_TO_MONTHS) return `${days}d ago`;
  const months = Math.floor(days / DAYS_TO_MONTHS);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

/** Snapshot of churn-table state used to drive the empty-result diagnostic. */
interface ChurnDiagnosticState {
  /** Number of rows in `co_changes` — non-zero proves churn mining ran. */
  coChangeRows: number;
  /** MAX(commit_count) over `files` — 0 means the per-file rollup is unwritten. */
  maxCommitCount: number;
}

/**
 * Read the two churn signals the empty-result diagnostic needs:
 * `co_changes` population and the `files.commit_count` ceiling. A
 * defensive `try` keeps a hotspots call from hard-failing if the
 * churn tables are absent on a partially-built index — the caller
 * then falls back to the generic cause list.
 */
function readChurnDiagnosticState(cg: ReturnType<ToolCtx['getCartograph']>): ChurnDiagnosticState | null {
  try {
    const db = cg.queries.db;
    const coChangeRows = (db.prepare('SELECT COUNT(*) AS n FROM co_changes').get() as { n: number }).n;
    const maxCommitCount = (db.prepare('SELECT COALESCE(MAX(commit_count), 0) AS m FROM files').get() as { m: number })
      .m;
    return { coChangeRows, maxCommitCount };
  } catch {
    return null;
  }
}

/**
 * The "no hotspots" diagnostic — a cause list tailored to the actual
 * churn-table state rather than a fixed four-cause checklist.
 *
 * Hotspots rank on `files.commit_count`, so an empty result has three
 * genuine causes, distinguished by inspecting the churn tables:
 *   - churn not yet mined — `co_changes` is empty AND `commit_count` is
 *     0 everywhere (no git history, or the churn pass hasn't run);
 *   - churn rollup not persisted — `co_changes` HAS rows but
 *     `commit_count` is uniformly 0 (mining ran but the per-file
 *     rollup write-back is missing — a reindex heals it);
 *   - filter too strict — churn data IS present (`commit_count > 0`)
 *     but `minCommits` / `minCentrality` / `recencyDays` excluded
 *     every file.
 *
 * The pre-fix message hard-coded "not a git repo" / "minCommits too
 * high" as the headline causes, which actively misled the agent when
 * neither was true (friction #19, audit group 2 #2).
 */
function formatNoHotspotsMessage(cg: ReturnType<ToolCtx['getCartograph']>): string {
  const state = readChurnDiagnosticState(cg);
  const lines = ['No hotspots to report.', ''];
  if (state === null) {
    // Churn tables unreadable — fall back to a generic, honest list.
    lines.push(
      'This typically means one of:',
      '- The index has not been built yet — run `cartograph admin index`.',
      '- The project has no git history, so churn data is unavailable.',
      '- `minCommits` / `minCentrality` / `recencyDays` excluded every file.',
    );
    return lines.join('\n');
  }
  if (state.maxCommitCount > 0) {
    // Churn IS mined and persisted — the only way to get here is filters.
    lines.push(
      'Churn data is present (`files.commit_count` is populated), so the',
      'active filters excluded every file. Likely causes:',
      "- `minCommits` is set higher than any file's commit count.",
      '- `minCentrality` excluded every file with churn.',
      '- `recencyDays` is too narrow — no qualifying file was touched in-window.',
      '',
      'Lower or drop those filters and retry.',
    );
    return lines.join('\n');
  }
  if (state.coChangeRows > 0) {
    // Mining ran (co_changes filled) but the per-file rollup is all 0.
    lines.push(
      'Churn mining ran (`co_changes` has rows) but `files.commit_count`',
      'is 0 for every file — the per-file churn rollup was not persisted.',
      'Re-run `cartograph admin index` to rebuild it; if it persists this is',
      'a churn-rollup write-back bug, not a configuration issue.',
    );
    return lines.join('\n');
  }
  // No co_changes rows and no commit counts — churn was never mined.
  lines.push(
    'No churn data has been mined yet. This typically means one of:',
    '- The index has not finished building — run `cartograph admin index`.',
    '- The project has no git history (a fresh checkout or non-git tree).',
    '- `enableChurn` is disabled in `.cartograph/config.json`.',
  );
  return lines.join('\n');
}

export const HOTSPOTS_TOOL = defineTool({
  name: 'cartograph_hotspots',
  description:
    'File-level triage — hotspots thresholded at 75th/25th percentiles.\n\n' +
    "`category: 'risk'` (default) centrality × churn (where bugs hide); `'maintenance'` churn × low centrality (refactor target); `'brittle'` centrality × low churn AND ≥1 external dependent (outsized blast radius); `'all'` for every category. " +
    'Sort risk by `risk` | `centrality` | `churn`.',
  schema: hotspotsSchema,
  handle: handleHotspots,
});
