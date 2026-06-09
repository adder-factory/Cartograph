/**
 * `cartograph_digest` — composite "land in a new repo" overview in
 * one round-trip. Backlog #12. Replaces 5+ separate calls
 * (hotspots / biomarkers / entry-points / churn / stats) for the
 * common "I just opened this codebase, what should I look at?"
 * workflow.
 *
 * Sections (each capped, gracefully missing when no data):
 *   - Headline counts (files / nodes / edges / language mix shorthand)
 *   - Top hotspots (file-level churn × centrality, top 5)
 *   - Top biomarker findings (worst severity, top 5)
 *   - Entry points (routes + CLI commands + public exports — top 5 each)
 *   - Recently touched files (touched in last 30 days, top 5 by
 *     lifetime commit count — the index carries no windowed churn)
 *   - Suggested next queries — context-sensitive nudges based on
 *     what was notable (e.g. "no biomarker data — run `cartograph
 *     admin index` to populate")
 *
 * No internal cache: every section maps to ONE indexed-table query
 * (FTS or simple WHERE), all sub-millisecond. Adding a digest cache
 * would be premature; revisit if a >50K-file project measures slow.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { getHotspots } from '../../db/queries-history.js';
import { getFindingsRanked, getFindingsStats } from '../../db/queries-findings.js';
import { SEVERITY_DESC } from '../../biomarkers/types.js';
import { getNodesByKind } from '../../db/queries.js';
import { getMetadata } from '../../db/queries-metadata.js';
import type Cartograph from '../../index.js';
import { isTestPath } from '../../utils.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import { isCliCommandRoute, collectPublicExportNodes } from './entry-points.js';
import { DEFAULT_MIN_COMMITS } from './hotspots.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { areBiomarkersPending } from '../../biomarkers/pending.js';
import { type ToolOutcome, ok } from './_outcome.js';
import type { Node } from '../../types.js';

const digestSchema = z.object({
  projectPath: projectPathField,
});

type DigestArgs = z.infer<typeof digestSchema>;

const TOP_HOTSPOTS = 5;
const TOP_FINDINGS = 5;
const TOP_ENTRIES = 5;
const TOP_RECENT = 5;
const RECENT_DAYS = 30;
const SCORE_DECIMALS = 3;

async function handleDigest(ctx: ToolCtx, args: DigestArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const stats = cg.stats.getStats();

  // `stats.nodeCount` counts every extractor node — including the one
  // `kind='file'` node emitted per file. Subtract `fileCount` so the
  // "symbols" figure is a true symbol count, reconcilable with
  // `cartograph_files --format summary` (which uses
  // `getAllFilesWithSymbolCount`, applying the same -1-per-file fix).
  const symbolCount = Math.max(0, stats.nodeCount - stats.fileCount);
  const lines: string[] = [
    `# 📊 Cartograph digest — \`${cg.projectRoot}\``,
    '',
    `**${stats.fileCount.toLocaleString()} files** · **${symbolCount.toLocaleString()} symbols** · **${stats.edgeCount.toLocaleString()} edges** · top languages: ${formatLangMix(stats)}`,
    '',
  ];

  appendHotspotsSection(lines, cg);
  appendBiomarkersSection(lines, cg);
  appendEntryPointsSection(lines, cg);
  appendRecentChurnSection(lines, cg);
  appendSuggestedQueriesSection(lines, cg);

  return ok(renderToolResponse({ body: lines.join('\n') }));
}

/** "typescript 365 · javascript 9 · ..." — top 3 languages by file count. */
function formatLangMix(stats: ReturnType<Cartograph['stats']['getStats']>): string {
  const langs = Object.entries(stats.filesByLanguage ?? {})
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (langs.length === 0) return '(none)';
  return langs.map(([lang, n]) => `${lang} ${n}`).join(' · ');
}

function appendHotspotsSection(lines: string[], cg: Cartograph): void {
  const hot =
    safe(() => getHotspots(cg.queries, { limit: TOP_HOTSPOTS, minCommits: DEFAULT_MIN_COMMITS, sortBy: 'risk' })) ?? [];
  lines.push(renderMarkdownBulletList(buildDigestHotspotsSpec(hot)));
}

/**
 * Build the digest 🔥 Hotspots section spec. H2 heading-level (each
 * digest section is a top-level H2). The empty-rows path emits the
 * canned "No hotspot data" empty-state via the `emptyState` field;
 * the title interpolates the populated count when rows exist.
 */
export function buildDigestHotspotsSpec(
  hot: ReadonlyArray<{ filePath: string; riskScore: number; commitCount: number; loc: number | null }>,
): MarkdownBulletListSpec<(typeof hot)[number]> {
  const title = hot.length === 0 ? '🔥 Hotspots' : `🔥 Hotspots (top ${hot.length}, churn × centrality)`;
  return {
    title,
    rows: hot,
    formatRow: (h) =>
      `- \`${h.filePath}\` — risk ${h.riskScore.toFixed(SCORE_DECIMALS)} (${h.commitCount} commits, ${h.loc} LOC)`,
    emptyState: [
      '## 🔥 Hotspots',
      '_No hotspot data — needs git history + centrality. Run `cartograph quickstart` for a first index, or `cartograph admin index` to rebuild._',
      '',
    ].join('\n'),
  };
}

function appendBiomarkersSection(lines: string[], cg: Cartograph): void {
  const stats = safe(() => getFindingsStats(cg.queries));
  // Pull warning+ first; if the project has no warning-tier findings
  // but the stats rollup shows info-tier entries, fall back to those
  // so the section body isn't empty when the header claims findings.
  let findings = safe(() => getFindingsRanked(cg.queries, { minSeverity: 'warning', limit: TOP_FINDINGS })) ?? [];
  if (findings.length === 0 && stats && stats.totalFindings > 0) {
    findings = safe(() => getFindingsRanked(cg.queries, { minSeverity: 'info', limit: TOP_FINDINGS })) ?? [];
  }
  if (!stats || stats.totalFindings === 0) {
    // Distinguish three states: (a) "biomarkers ran, project is clean"
    // (b) "biomarkers pending — post-hook hasn't completed yet" and
    // (c) "biomarkers never ran". The `areBiomarkersPending` signal
    // (G10.7) gates (b) — empty findings + pending timestamp means the
    // post-hook is still in flight after a re-index, so don't render a
    // misleading "clean" verdict.
    const indexedAt = safe(() => getMetadata(cg.queries, 'index_timestamp'));
    let state: BiomarkerSectionState = 'never-ran';
    if (indexedAt) {
      state = safe(() => areBiomarkersPending(cg)) ? 'pending' : 'clean';
    }
    lines.push(renderMarkdownBulletList(buildDigestBiomarkersSpec({ findings: [], stats: null, state })));
    return;
  }
  // Reconcile the count in the header with the (capped, severity-ranked)
  // list above. The list only shows the top `TOP_FINDINGS` rows, and on a
  // project with warning-tier findings it shows ONLY those — leaving the
  // info-tier count in the header with no corresponding rows. Without an
  // explicit marker the agent reads "8 findings" but sees 2 lines and
  // assumes data is missing. The marker names exactly what was elided.
  lines.push(renderMarkdownBulletList(buildDigestBiomarkersSpec({ findings, stats, state: 'populated' })));
}

/** Three biomarker-section states the digest distinguishes — "the
 *  index has data; render the findings", "biomarkers never ran",
 *  "biomarkers ran but project is clean", "post-hook still pending"
 *  (G10.7 signal). Each state owns its empty-state copy on the spec. */
export type BiomarkerSectionState = 'populated' | 'never-ran' | 'clean' | 'pending';

/** Args for {@link buildDigestBiomarkersSpec} — kept in an interface
 *  so the builder stays under the 4-param long_parameter_list floor. */
export interface BuildDigestBiomarkersSpecArgs {
  readonly state: BiomarkerSectionState;
  readonly findings: ReadonlyArray<{
    name: string;
    kind: string;
    biomarker: string;
    filePath: string;
    severity?: string;
  }>;
  readonly stats: ReturnType<typeof getFindingsStats> | null;
}

/**
 * Build the digest 🩺 Code Health section spec. Routes through one
 * of four states (`populated` / `never-ran` / `clean` / `pending`);
 * each state owns its empty-state copy via the spec.
 */
export function buildDigestBiomarkersSpec(
  args: BuildDigestBiomarkersSpecArgs,
): MarkdownBulletListSpec<(typeof args.findings)[number]> {
  const { state, findings, stats } = args;
  if (state !== 'populated' || !stats) {
    // Fall through to the 'clean' note as a defensive default when
    // state === 'populated' but stats is null (call shape bug; the
    // caller always passes both together).
    const noteState = state === 'populated' ? 'clean' : state;
    const note = DIGEST_BIOMARKER_STATE_NOTES[noteState];
    return {
      title: '🩺 Code Health',
      rows: [],
      formatRow: () => '',
      emptyState: ['## 🩺 Code Health', note, ''].join('\n'),
    };
  }
  const sevSummary = SEVERITY_DESC.map((s) => `${stats.bySeverity[s] ?? 0} ${s}`).join(' · ');
  const elision = describeElidedFindings(stats, findings);
  const findingNoun = stats.totalFindings === 1 ? 'finding' : 'findings';
  const title = `🩺 Code Health — ${stats.totalFindings} ${findingNoun} (${sevSummary})`;
  const baseSpec: MarkdownBulletListSpec<(typeof findings)[number]> = {
    title,
    rows: findings,
    formatRow: (f) => `- \`${f.name}\` (${f.kind}) — ${f.biomarker} in ${f.filePath}`,
    // Reachable when `stats.totalFindings > 0` but `getFindingsRanked`
    // returned no rows (e.g. a partial-rescan landed mid-call). Surface
    // the count + a recovery hint instead of a bare heading so the
    // agent doesn't see a misleading silently-empty section.
    emptyState: [
      `## ${title}`,
      `_Findings counted but none returned by the ranked query — retry after the next \`cartograph admin sync\`._`,
      '',
    ].join('\n'),
  };
  return elision ? { ...baseSpec, footers: [elision] } : baseSpec;
}

/** Per-state empty-section copy for the digest biomarker rollup —
 *  exported as a named record so the wording-lint walks each state's
 *  copy separately (the alternative would be one mega emptyState
 *  with conditional logic the lint can't introspect). */
export const DIGEST_BIOMARKER_STATE_NOTES: Record<Exclude<BiomarkerSectionState, 'populated'>, string> = {
  'never-ran':
    '_No biomarker data — run `cartograph quickstart` for a first index, or `cartograph admin index` to rebuild._',
  pending: '_⏳ Biomarker pass pending — re-run after `cartograph admin sync` completes._',
  clean: '_Project clean ✓ — 0 biomarker findings across all detectors._',
};

/**
 * Describe the findings present in `stats` but absent from the rendered
 * `shown` list, so the digest's count and list reconcile. Returns `null`
 * when every finding is already on screen (nothing elided).
 */
function describeElidedFindings(
  stats: ReturnType<typeof getFindingsStats>,
  shown: ReadonlyArray<{ severity?: string }>,
): string | null {
  if (!stats) return null;
  const elided = stats.totalFindings - shown.length;
  if (elided <= 0) return null;
  // Break the elided count down by severity: of each tier, how many are
  // NOT in the shown list. `shown` is severity-ranked so the elided rows
  // are the lower-severity / past-the-cap tail.
  const shownBySeverity = new Map<string, number>();
  for (const f of shown) {
    const s = f.severity ?? 'info';
    shownBySeverity.set(s, (shownBySeverity.get(s) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const s of SEVERITY_DESC) {
    const remaining = (stats.bySeverity[s] ?? 0) - (shownBySeverity.get(s) ?? 0);
    if (remaining > 0) parts.push(`${remaining} ${s}`);
  }
  const breakdown = parts.length > 0 ? parts.join(' · ') : `${elided}`;
  return `- _… +${breakdown} more finding(s) not shown — run \`cartograph_biomarkers\` for the full list._`;
}

function appendEntryPointsSection(lines: string[], cg: Cartograph): void {
  // Routes — drop test-file fixtures so `app.get('/foo')` patterns
  // inside __tests__ don't dominate over real handlers in src/. Also
  // filter out CLI-command nodes (`cmd <NAME>`) emitted by the
  // commander/yargs/caporal/cac framework resolver — those are
  // structurally `kind: 'route'` but represent CLI subcommands, not
  // HTTP handlers, and have their own bucket in `cartograph_entry_points`.
  const allRoutes = safe(() => getNodesByKind(cg.queries, 'route')) ?? [];
  const routes = allRoutes.filter((r) => !isTestPath(r.filePath) && !isCliCommandRoute(r));
  // Public exports — use the same shared predicate as `cartograph_entry_points`
  // (calls + references + type-usage edges, skipCliPaths=true) so the digest
  // overview and the detailed entry-points tool always agree on which symbols
  // qualify. The pre-2026-05-15 local implementation checked only `['calls']`
  // edges and diverged from entry-points' richer edge set.
  const publicExports = safe(() => collectPublicExportNodes(cg, TOP_ENTRIES, true)) ?? [];

  if (routes.length === 0 && publicExports.length === 0) {
    lines.push('## 🚪 Entry points', DIGEST_ENTRY_POINTS_EMPTY_NOTE, '');
    return;
  }
  lines.push('## 🚪 Entry points', '');
  // Sub-sections use markdown bold prefixes (e.g. `**Routes (N):**`),
  // not H3 headings, because they nest inside the parent `## 🚪
  // Entry points` H2. `MarkdownBulletListSpec`'s renderer always
  // prepends a heading marker — so these sub-sections stay
  // hand-built. The wording is locked through the exported
  // `DIGEST_ROUTES_PREFIX` / `DIGEST_PUBLIC_EXPORTS_PREFIX_FN`
  // constants below.
  appendDigestRoutes(lines, routes);
  appendDigestPublicExports(lines, publicExports);
}

function appendDigestRoutes(lines: string[], routes: Node[]): void {
  if (routes.length === 0) return;
  const shown = routes.slice(0, TOP_ENTRIES);
  lines.push(`${DIGEST_ROUTES_PREFIX} (${routes.length}):**`);
  for (const r of shown) {
    const lineSuffix = r.startLine ? `:${r.startLine}` : '';
    lines.push(`- \`${r.name}\` — ${r.filePath}${lineSuffix}`);
  }
  if (routes.length > TOP_ENTRIES)
    lines.push(`- _… +${routes.length - TOP_ENTRIES} more (call \`cartograph_entry_points\` for all)_`);
  lines.push('');
}

function appendDigestPublicExports(lines: string[], publicExports: Node[]): void {
  if (publicExports.length === 0) return;
  lines.push(DIGEST_PUBLIC_EXPORTS_PREFIX_FN(publicExports.length));
  for (const n of publicExports) {
    const lineSuffix = n.startLine ? `:${n.startLine}` : '';
    lines.push(`- \`${n.name}\` (${n.kind}) — ${n.filePath}${lineSuffix}`);
  }
  lines.push('');
}

/** Empty-section note for the 🚪 Entry points digest section when
 *  there are neither routes nor public exports. Exported so the
 *  wording-lint walks it directly. */
export const DIGEST_ENTRY_POINTS_EMPTY_NOTE =
  '_No HTTP routes or zero-caller public exports. Run `cartograph_entry_points` for the full breakdown._';

/** Static prefix the routes sub-section bold-prefix line starts
 *  with (the dynamic count + closing `):**` is appended at render
 *  time). Exported as a constant so the wording-lint anchors on the
 *  literal "**Routes" wording — a rename to "**HTTP routes" would
 *  surface here. */
export const DIGEST_ROUTES_PREFIX = '**Routes';

/** Public-exports sub-section bold-prefix function. Same lint-anchor
 *  pattern as {@link DIGEST_ROUTES_PREFIX}; exported as a function
 *  because the line interpolates the count of shown exports. */
export const DIGEST_PUBLIC_EXPORTS_PREFIX_FN = (count: number): string =>
  `**Public exports (zero in-tree callers, top ${count}):**`;

/** ms-per-day for the relative "touched N days ago" rendering. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Render `last_touched_ts` (unix SECONDS) as a relative age, or
 *  `unknown` when the churn miner never stamped the file. */
function formatLastTouched(lastTouchedTs: number | null): string {
  if (lastTouchedTs == null || lastTouchedTs <= 0) return 'last touched: unknown';
  const ageDays = Math.floor((Date.now() - lastTouchedTs * 1000) / DAY_MS);
  if (ageDays <= 0) return 'touched today';
  if (ageDays === 1) return 'touched 1 day ago';
  return `touched ${ageDays} days ago`;
}

function appendRecentChurnSection(lines: string[], cg: Cartograph): void {
  const recent =
    safe(() =>
      getHotspots(cg.queries, {
        limit: TOP_RECENT,
        minCommits: 1,
        sortBy: 'churn',
        recencyDays: RECENT_DAYS,
      }),
    ) ?? [];
  lines.push(renderMarkdownBulletList(buildDigestRecentChurnSpec(recent, RECENT_DAYS)));
}

/** One row of the digest 🕒 Recently touched files section. */
export interface DigestRecentChurnRow {
  filePath: string;
  lastTouchedTs: number | null;
  commitCount: number;
  loc: number | null;
}

/**
 * Build the digest 🕒 Recently touched files spec. H2 heading-level
 * (top-level digest section). The empty path emits a "quiet
 * codebase" hint via `emptyState`; the populated title interpolates
 * the populated count.
 *
 * `recencyDays` selects files whose `last_touched_ts` falls inside
 * the window; `commitCount` is the file's LIFETIME commit count, NOT
 * a windowed tally (the index carries no per-file windowed commit
 * count). Heading + per-row wording say "lifetime commits"
 * explicitly and add the genuine windowed signal (when the file was
 * last touched) so the figure can't be misread as "N commits in the
 * last 30 days". A trailing footer pins the ranking rationale.
 */
export function buildDigestRecentChurnSpec(
  recent: ReadonlyArray<DigestRecentChurnRow>,
  recencyDays: number,
): MarkdownBulletListSpec<DigestRecentChurnRow> {
  const title =
    recent.length === 0
      ? `🕒 Recently touched files (last ${recencyDays} days)`
      : `🕒 Recently touched files (top ${recent.length}, touched in last ${recencyDays} days)`;
  const baseSpec: MarkdownBulletListSpec<DigestRecentChurnRow> = {
    title,
    rows: recent,
    formatRow: (r) =>
      `- \`${r.filePath}\` — ${formatLastTouched(r.lastTouchedTs)}, ${r.commitCount} lifetime commits, ${r.loc} LOC`,
    emptyState: [
      `## 🕒 Recently touched files (last ${recencyDays} days)`,
      `_No files touched in the last ${recencyDays} days — quiet codebase, or git history not mined yet._`,
      '',
    ].join('\n'),
  };
  return recent.length > 0
    ? {
        ...baseSpec,
        footers: ['_Ranked by lifetime commit count; the index does not track per-file windowed churn._'],
      }
    : baseSpec;
}

function appendSuggestedQueriesSection(lines: string[], cg: Cartograph): void {
  // Context-sensitive: pick 4-5 queries the agent is most likely to
  // want to fire next, based on what's notable in this digest.
  const stats = cg.stats.getStats();
  const suggestions: string[] = [];

  if (stats.fileCount > 0) {
    suggestions.push('`cartograph_files` — full project layout');
  }
  const findingsStats = safe(() => getFindingsStats(cg.queries));
  if (findingsStats && findingsStats.totalFindings > 0) {
    const worstBiomarker = Object.entries(findingsStats.byBiomarker).sort(([, a], [, b]) => b - a)[0]?.[0];
    if (worstBiomarker) {
      suggestions.push(`\`cartograph_biomarkers biomarker=${worstBiomarker}\` — drill into the most-frequent finding`);
    }
  }
  suggestions.push(
    '`cartograph_entry_points` — full top-of-stack breakdown',
    '`cartograph_context({task: "<task>"})` — task-driven context for any specific area',
    '`cartograph_find by=name <name>` — locate a specific symbol',
  );

  lines.push(renderMarkdownBulletList(buildDigestSuggestedQueriesSpec(suggestions)));
}

/**
 * Build the digest 🧭 Suggested next queries spec. H2 heading-level.
 * Each row is one suggestion line (already rendered as
 * "`cartograph_X arg` — explanation"); the spec carries the section
 * title for lint visibility. The suggestion strings themselves are
 * dynamic (composed from the project's actual state) so the lint
 * walks only the title.
 */
export function buildDigestSuggestedQueriesSpec(suggestions: readonly string[]): MarkdownBulletListSpec<string> {
  return {
    title: '🧭 Suggested next queries',
    rows: suggestions,
    formatRow: (s) => `- ${s}`,
    emptyState: '## 🧭 Suggested next queries\n_No suggestions for this project shape._',
  };
}

/** Run a query and swallow errors — digest must never fail when
 *  one section's data isn't ready (e.g. biomarkers table missing on
 *  a fresh-init project). Real DB-level failures (missing column
 *  after schema drift, prepared-statement throw) get logged to
 *  stderr so they're diagnosable; the section degrades to its
 *  "no data" hint instead of breaking the whole digest. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    process.stderr.write(`[cartograph_digest] section error: ${errorMessage(err)}\n`);
    return null;
  }
}

export const DIGEST_TOOL = defineTool({
  name: 'cartograph_digest',
  description:
    'Composite "land in a new repo" overview — first query on an unfamiliar codebase. ' +
    'Bundles top hotspots, worst biomarkers, entry points, recent churn, and suggested-next-queries (each capped at top 5).',
  schema: digestSchema,
  handle: handleDigest,
});
