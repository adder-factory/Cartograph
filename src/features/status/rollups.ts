import { areBiomarkersPending } from '../../biomarkers/pending.js';
import { getCoverageStats } from '../../db/queries-coverage.js';
import { getAllDirectorySummaries } from '../../db/queries-directory-summaries.js';
import { getEmbeddingsTotal } from '../../db/queries-embeddings.js';
import { getFindingsRanked, getFindingsStats } from '../../db/queries-findings.js';
import { getHotspots } from '../../db/queries-history.js';
import { getRoleCounts } from '../../db/queries-roles.js';
import {
  countPendingSummarizable,
  getSummaryBreakdown,
  getSummaryCoverage,
  getWeightedSummaryCoverage,
  type SummaryBreakdown,
} from '../../db/queries-summaries.js';
import { logWarn } from '../../errors.js';
import { isShallowClone } from '../../git-utils.js';
import type Cartograph from '../../index.js';
import { getDetachedSummarizeState } from '../../llm/detached-summarize.js';
import {
  DEFAULT_DOC_CHAR_THRESHOLD,
  MIN_BODY_LINES,
  MIN_BODY_LINES_BY_KIND,
  SUMMARIZABLE_KINDS,
} from '../../llm/summarizer.js';
import {
  getCommonUnresolvedReferenceNames,
  getUnresolvedReferenceBuckets,
  getUnresolvedReferencesCount,
  type UnresolvedRefBucket,
  type UnresolvedRefNameSample,
} from '../../db/queries-unresolved-refs.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from '../../rendering/result-spec.js';

function rollupCountPhrase(shown: number, requestedTopN: number, noun: string): string {
  const plural = shown === 1 ? noun : `${noun}s`;
  if (shown < requestedTopN) {
    return shown === 1 ? `1 ${noun}` : `all ${shown} ${plural}`;
  }
  return `Top ${shown} ${plural}`;
}

export function appendInlineHotspots(lines: string[], cg: Cartograph, topN: number): void {
  if (topN <= 0) return;
  let rows: ReturnType<typeof getHotspots>;
  try {
    rows = getHotspots(cg.queries, { limit: topN, sortBy: 'risk' });
  } catch {
    return;
  }
  if (rows.length === 0) return;
  lines.push('', renderMarkdownBulletList(buildStatusInlineHotspotsSpec(rows, topN)));
  const banner = statusShallowCloneBanner(cg.projectRoot, rows);
  if (banner) {
    lines.push('', banner);
  }
}

function statusShallowCloneBanner(
  projectRoot: string,
  rows: ReadonlyArray<{ commitCount: number }>,
): string | undefined {
  if (!isShallowClone(projectRoot)) return undefined;
  if (rows.length === 0) return undefined;
  const zeroCount = rows.filter((r) => r.commitCount === 0).length;
  if (zeroCount < rows.length / 2) return undefined;
  return (
    '_⚠ Shallow clone detected (every commit count = 0). Risk scores are uniformly 0; ' +
    'run `git fetch --unshallow` to enable churn signals._'
  );
}

const ROLLUP_SCORE_DECIMALS = 4;

export function buildStatusInlineHotspotsSpec(
  rows: ReadonlyArray<{
    filePath: string;
    commitCount: number;
    loc: number | null;
    fileCentrality: number;
    riskScore: number;
  }>,
  topN: number,
): MarkdownBulletListSpec<(typeof rows)[number]> {
  return {
    title: `🔥 ${rollupCountPhrase(rows.length, topN, 'hotspot')} (by risk = centrality × churn)`,
    headingLevel: 3,
    rows,
    formatRow: (r) =>
      `- \`${r.filePath}\` — commits: ${r.commitCount}, LOC: ${r.loc}, ` +
      `centrality: ${r.fileCentrality.toFixed(ROLLUP_SCORE_DECIMALS)}, risk: ${r.riskScore.toFixed(ROLLUP_SCORE_DECIMALS)}`,
    emptyState: '_No hotspot data._',
    footers: ['_Pass `topHotspots: 0` to suppress; call `cartograph_hotspots` for `sortBy` / `recencyDays` filters._'],
  };
}

export function appendInlineBiomarkers(lines: string[], cg: Cartograph, topN: number): void {
  if (topN <= 0) return;
  let rows: ReturnType<typeof getFindingsRanked>;
  try {
    rows = getFindingsRanked(cg.queries, { limit: topN, minSeverity: 'warning' });
  } catch {
    return;
  }
  if (rows.length === 0) {
    let totalFindings: number;
    try {
      totalFindings = getFindingsStats(cg.queries).totalFindings;
    } catch {
      return;
    }
    const pending = totalFindings === 0 && (safeBoolean(() => areBiomarkersPending(cg)) ?? false);
    lines.push(
      '',
      renderMarkdownBulletList(buildStatusInlineBiomarkersSpec({ rows: [], totalFindings, topN, pending })),
    );
    return;
  }
  lines.push(
    '',
    renderMarkdownBulletList(buildStatusInlineBiomarkersSpec({ rows, totalFindings: -1, topN, pending: false })),
  );
}

function safeBoolean(fn: () => boolean): boolean | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export interface BuildStatusInlineBiomarkersSpecArgs {
  readonly rows: ReadonlyArray<{
    name: string;
    kind: string;
    biomarker: string;
    severity: string;
    metric: number;
    centrality: number | null;
    filePath: string;
  }>;
  readonly totalFindings: number;
  readonly topN: number;
  readonly pending: boolean;
}

export function buildStatusInlineBiomarkersSpec(
  args: BuildStatusInlineBiomarkersSpecArgs,
): MarkdownBulletListSpec<BuildStatusInlineBiomarkersSpecArgs['rows'][number]> {
  const { rows, totalFindings, topN, pending } = args;
  if (rows.length === 0) {
    let note =
      `_No warning+ findings — ${totalFindings} info-level finding(s) present. ` +
      "Call `cartograph_biomarkers mode=ranked` with `minSeverity: 'info'` to see them._";
    if (pending) {
      note = STATUS_BIOMARKERS_PENDING_NOTE;
    } else if (totalFindings === 0) {
      note = STATUS_BIOMARKERS_CLEAN_NOTE;
    }
    return {
      title: '🩺 Biomarker findings',
      headingLevel: 3,
      rows: [],
      formatRow: () => '',
      emptyState: ['### 🩺 Biomarker findings', note].join('\n'),
    };
  }
  return {
    title: `🩺 ${rollupCountPhrase(rows.length, topN, 'biomarker finding')} (warning+)`,
    headingLevel: 3,
    rows,
    formatRow: (r) => {
      const cent = r.centrality == null ? '' : `, centrality: ${r.centrality.toFixed(ROLLUP_SCORE_DECIMALS)}`;
      return `- \`${r.name}\` (${r.kind}) — ${r.biomarker} ${r.severity} (metric: ${r.metric}${cent}) — \`${r.filePath}\``;
    },
    emptyState: '### 🩺 Biomarker findings',
    footers: [
      '_Pass `topBiomarkers: 0` to suppress; call `cartograph_biomarkers mode=ranked` for `biomarker` / `minCentrality` filters._',
    ],
  };
}

export const STATUS_BIOMARKERS_CLEAN_NOTE = '_Project clean ✓ — 0 biomarker findings across all detectors._';

export const STATUS_BIOMARKERS_PENDING_NOTE =
  '_⏳ Biomarker pass pending — re-run after `cartograph admin sync` completes._';

const SLOW_LENS_LOG_MS = 1_000;
const APPEND_FEATURE_READINESS_BUDGET_MS = 30_000;

function safeCall<T>(fn: () => T): T | undefined {
  const t0 = Date.now();
  try {
    const out = fn();
    const elapsed = Date.now() - t0;
    if (elapsed > SLOW_LENS_LOG_MS) {
      logWarn('cartograph_status: slow lens', { elapsedMs: elapsed, threshold: SLOW_LENS_LOG_MS });
    }
    return out;
  } catch {
    return undefined;
  }
}

function trafficLight(state: 'empty' | 'partial' | 'full' | 'info'): string {
  if (state === 'full') return '🟢';
  if (state === 'partial') return '🟡';
  if (state === 'info') return '🔵';
  return '⚪';
}

type LensState = 'empty' | 'partial' | 'full' | 'info';
type LensReading = { present: false } | { present: true; state: LensState; line: string };

export interface LensOpts {
  summaryBreakdown: boolean;
  surface?: 'mcp' | 'cli';
}

type ReadinessLens = (cg: Cartograph, opts: LensOpts) => LensReading;

function countSummaryReuseCachedRows(cg: Cartograph): number {
  try {
    const row = cg.db
      .getDb()
      .prepare('SELECT COUNT(*) AS c FROM summary_store WHERE body_hash NOT IN (SELECT body_hash FROM summary_refs)')
      .get() as { c: number };
    return row.c ?? 0;
  } catch {
    return 0;
  }
}

function countEmbeddingReuseCachedRows(cg: Cartograph): number {
  try {
    const row = cg.db
      .getDb()
      .prepare(
        'SELECT COUNT(*) AS c FROM embedding_store WHERE body_hash NOT IN (SELECT body_hash FROM embedding_refs)',
      )
      .get() as { c: number };
    return row.c ?? 0;
  } catch {
    return 0;
  }
}

function hintSurface(opts: LensOpts): NonNullable<LensOpts['surface']> {
  return opts.surface ?? 'mcp';
}

function summarizeHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli'
    ? '`cartograph admin summarize --all`'
    : "`cartograph_admin({action: 'summarize', summarizeLimit: -1})`";
}

function agentSummaryBridgeHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli'
    ? '`cartograph summaries pending` + `cartograph summaries save`'
    : "`cartograph_summaries({action: 'pending'})` + `cartograph_summaries({action: 'save'})`";
}

function embedHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli' ? '`cartograph admin embed`' : "`cartograph_admin({action: 'embed'})`";
}

function semanticFindHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli'
    ? '`cartograph find --by name --mode semantic`'
    : "`cartograph_find({by: 'name', mode: 'semantic'})`";
}

function coverageLoadHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli'
    ? '`cartograph coverage --mode load --report-path <lcov>`'
    : "`cartograph_coverage({mode: 'load', reportPath: '<lcov>'})`";
}

function coverageReadHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli' ? '`cartograph coverage`' : '`cartograph_coverage`';
}

function roleReadHint(opts: LensOpts): string {
  return hintSurface(opts) === 'cli' ? '`cartograph role`' : '`cartograph_role`';
}

function readSummariesLens(cg: Cartograph, opts: LensOpts): LensReading {
  const sumCov = safeCall(() => getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  if (!sumCov || sumCov.total === 0) return { present: false };
  const pct = Math.round((sumCov.summarised / sumCov.total) * 100);
  const summaryReuseCached = countSummaryReuseCachedRows(cg);
  const pending =
    safeCall(() =>
      countPendingSummarizable(cg.queries, SUMMARIZABLE_KINDS, {
        minBodyLinesByKind: MIN_BODY_LINES_BY_KIND,
        defaultMinBodyLines: MIN_BODY_LINES,
        docCharThreshold: DEFAULT_DOC_CHAR_THRESHOLD,
      }),
    ) ?? 0;
  let state: LensState = 'full';
  if (sumCov.summarised === 0) {
    state = 'empty';
  } else if (pending > 0) {
    state = 'partial';
  }
  let action = '';
  if (state === 'empty') {
    action = ` — run ${summarizeHint(opts)} (or ${agentSummaryBridgeHint(opts)})`;
  } else if (state === 'partial') {
    action = ` — ${pending} pending; run ${summarizeHint(opts)} to complete`;
  }
  const weighted = safeCall(() => getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  const weightedSuffix =
    weighted && weighted.weightedRatio !== null
      ? ` _(centrality-weighted: ${Math.round(weighted.weightedRatio * 100)}%)_`
      : '';
  const reuseSuffix = summaryReuseCached > 0 ? ` — ${summaryReuseCached} reuse-cached` : '';
  let line = `**Summaries:** ${sumCov.summarised} / ${sumCov.total} (${pct}%)${weightedSuffix}${reuseSuffix}${action}`;
  const bgProgress = cg.llm.bgCtrl.progress;
  if (bgProgress) {
    line += `\n    ⏳ summarization running in the background — ${bgProgress.phase} ${bgProgress.done}/${bgProgress.total}; re-check coverage shortly`;
  } else {
    const detached = safeCall(() => getDetachedSummarizeState(cg.projectRoot));
    if (detached?.running) {
      line += `\n    ⏳ detached summarizer running (pid ${detached.pid}) — coverage is still climbing; re-check shortly`;
    }
  }
  if (opts.summaryBreakdown) {
    const breakdown = safeCall(() =>
      getSummaryBreakdown(cg.queries, SUMMARIZABLE_KINDS, {
        minBodyLinesByKind: MIN_BODY_LINES_BY_KIND,
        defaultMinBodyLines: MIN_BODY_LINES,
        docCharThreshold: DEFAULT_DOC_CHAR_THRESHOLD,
      }),
    );
    if (breakdown) line += '\n' + formatSummaryBreakdown(breakdown);
  }
  return { present: true, state, line };
}

function formatSummaryBreakdown(b: SummaryBreakdown): string {
  const lines = [
    `    structural:       ${b.structural}`,
    `    neighbor-prop:    ${b.neighborProp}`,
    `    llm:              ${b.llm}`,
    `    skipped-by-floor: ${b.skippedByFloor}`,
  ];
  if (b.skippedByFloor > 0) {
    lines.push(
      `    _(denominator includes ${b.skippedByFloor} symbol${b.skippedByFloor === 1 ? '' : 's'} ` +
        `intentionally skipped — body shorter than \`MIN_BODY_LINES_BY_KIND\` floor)_`,
    );
  }
  return lines.join('\n');
}

function readEmbeddingsLens(cg: Cartograph, opts: LensOpts): LensReading {
  const embTotal = safeCall(() => getEmbeddingsTotal(cg.queries));
  if (embTotal === undefined) return { present: false };
  const state: LensState = embTotal === 0 ? 'empty' : 'full';
  const action =
    embTotal === 0 ? ` — run ${embedHint(opts)}; needed for ${semanticFindHint(opts)} + hybrid retrieval` : '';
  const reuseCached = countEmbeddingReuseCachedRows(cg);
  const reuseSuffix = reuseCached > 0 ? ` (+ ${reuseCached} reuse-cached)` : '';
  return { present: true, state, line: `**Embeddings:** ${embTotal} rows${reuseSuffix}${action}` };
}

function readCoverageLens(cg: Cartograph, opts: LensOpts): LensReading {
  const covStats = safeCall(() => getCoverageStats(cg.queries));
  if (covStats === undefined) return { present: false };
  const state: LensState = covStats.symbolsWithCoverage === 0 ? 'empty' : 'full';
  const action = formatCoverageAction(covStats, opts);
  return { present: true, state, line: `**Coverage:** ${covStats.symbolsWithCoverage} symbols${action}` };
}

function formatCoverageAction(covStats: { symbolsWithCoverage: number; sources: string[] }, opts: LensOpts): string {
  if (covStats.symbolsWithCoverage === 0) {
    return ` — run ${coverageLoadHint(opts)}; needed for ${coverageReadHint(opts)}`;
  }
  const sourceCount = covStats.sources.length;
  const plural = sourceCount === 1 ? '' : 's';
  return ` (${sourceCount} source${plural}: ${covStats.sources.join(', ')})`;
}

function readRolesLens(cg: Cartograph, opts: LensOpts): LensReading {
  const roleCounts = safeCall(() => getRoleCounts(cg.queries));
  if (roleCounts === undefined) return { present: false };
  const roleTotal = Array.from(roleCounts.values()).reduce((a, b) => a + b, 0);
  const state: LensState = roleTotal === 0 ? 'empty' : 'full';
  const action =
    roleTotal === 0
      ? ` — run ${summarizeHint(opts)} (classification runs as a side-effect of the summarisation pipeline); needed for ${roleReadHint(opts)}`
      : '';
  return { present: true, state, line: `**Roles:** ${roleTotal} classified${action}` };
}

function readDirectorySummariesLens(cg: Cartograph, opts: LensOpts): LensReading {
  const dirSummaries = safeCall(() => getAllDirectorySummaries(cg.queries).length);
  if (dirSummaries === undefined) return { present: false };
  const state: LensState = dirSummaries === 0 ? 'empty' : 'full';
  const action = dirSummaries === 0 ? ` — needs ≥3 summarised symbols per dir; run ${summarizeHint(opts)}` : '';
  return { present: true, state, line: `**Directory summaries:** ${dirSummaries}${action}` };
}

const UNRESOLVED_REFS_NOTABLE_THRESHOLD = 1000;
const UNRESOLVED_REFS_BUCKET_LIMIT = 4;
const UNRESOLVED_REFS_SAMPLE_LIMIT = 5;

function formatUnresolvedBucket(row: UnresolvedRefBucket): string {
  return `${row.referenceKind}/${row.language}: ${row.count.toLocaleString()}`;
}

function formatUnresolvedNameSample(row: UnresolvedRefNameSample): string {
  return `\`${row.referenceName}\` (${row.count.toLocaleString()} ${row.referenceKind}/${row.language})`;
}

function readUnresolvedRefsLens(cg: Cartograph): LensReading {
  const count = safeCall(() => getUnresolvedReferencesCount(cg.queries));
  if (count === undefined || count < UNRESOLVED_REFS_NOTABLE_THRESHOLD) return { present: false };
  const buckets = safeCall(() => getUnresolvedReferenceBuckets(cg.queries, UNRESOLVED_REFS_BUCKET_LIMIT)) ?? [];
  const samples = safeCall(() => getCommonUnresolvedReferenceNames(cg.queries, UNRESOLVED_REFS_SAMPLE_LIMIT)) ?? [];
  let line =
    `**Unresolved refs:** ${count.toLocaleString()} ` +
    '(informational — expected for builtins, external APIs, property access, framework hooks, and dynamic dispatch; not a corruption signal by itself)';
  if (buckets.length > 0) {
    line += `\n    by kind/language: ${buckets.map(formatUnresolvedBucket).join(', ')}`;
  }
  if (samples.length > 0) {
    line += `\n    common names: ${samples.map(formatUnresolvedNameSample).join(', ')}`;
  }
  return {
    present: true,
    state: 'info',
    line,
  };
}

const READINESS_LENSES: ReadinessLens[] = [
  readSummariesLens,
  readEmbeddingsLens,
  readCoverageLens,
  readRolesLens,
  readDirectorySummariesLens,
  readUnresolvedRefsLens,
];

export function appendFeatureReadiness(lines: string[], cg: Cartograph, opts: LensOpts): void {
  const rendered: string[] = [];
  const t0 = Date.now();
  let bailed = false;
  for (const lens of READINESS_LENSES) {
    if (Date.now() - t0 > APPEND_FEATURE_READINESS_BUDGET_MS) {
      bailed = true;
      logWarn('cartograph_status: lens budget exceeded; skipping remaining lenses', {
        budgetMs: APPEND_FEATURE_READINESS_BUDGET_MS,
        elapsedMs: Date.now() - t0,
        renderedSoFar: rendered.length,
        totalLenses: READINESS_LENSES.length,
      });
      break;
    }
    const reading = lens(cg, opts);
    if (!reading.present) continue;
    rendered.push(`- ${trafficLight(reading.state)} ${reading.line}`);
  }
  if (bailed) {
    rendered.push('- ⚠ _Some lenses skipped — total budget exceeded. See logs._');
  }
  if (rendered.length > 0) {
    lines.push('', '### 🚦 Feature Readiness', ...rendered);
  }
}
