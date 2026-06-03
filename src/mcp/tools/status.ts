import * as fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { getCoverageStats } from '../../db/queries-coverage.js';
import { getEmbeddingsTotal } from '../../db/queries-embeddings.js';
import { isHnswAvailable } from '../../embeddings/hnsw-index.js';
import { getRoleCounts } from '../../db/queries-roles.js';
import { getAllDirectorySummaries } from '../../db/queries-directory-summaries.js';
import {
  getSummaryCoverage,
  getWeightedSummaryCoverage,
  countPendingSummarizable,
  getSummaryBreakdown,
  type SummaryBreakdown,
} from '../../db/queries-summaries.js';
import {
  SUMMARIZABLE_KINDS,
  MIN_BODY_LINES,
  MIN_BODY_LINES_BY_KIND,
  DEFAULT_DOC_CHAR_THRESHOLD,
} from '../../llm/summarizer.js';
import { getDetachedSummarizeState } from '../../llm/detached-summarize.js';
import { getStaleArtifactsCount } from '../../db/queries-metadata.js';
import { getStatsNodesByKindLanguage } from '../../db/queries.js';
import { logWarn } from '../../errors.js';
import { getParseCacheStats } from '../../db/queries-parse-cache.js';
import { getHotspots } from '../../db/queries-history.js';
import { getFindingsRanked, getFindingsStats } from '../../db/queries-findings.js';
import {
  getCommonUnresolvedReferenceNames,
  getUnresolvedReferenceBuckets,
  getUnresolvedReferencesCount,
  type UnresolvedRefBucket,
  type UnresolvedRefNameSample,
} from '../../db/queries-unresolved-refs.js';
import { areBiomarkersPending } from './biomarkers.js';
import { classifyChangedFiles, realModifiedCount, type ChangedFiles } from '../../changed-files-classify.js';
import { shortSha, isShallowClone } from '../../git-utils.js';
import { clamp } from '../../utils.js';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { detectModuleFormat, formatModuleFormatLine } from '../../module-format.js';
import { getAskModel, getChatModel, getEmbeddingModel } from '../../llm/provider.js';
import type Cartograph from '../../index.js';
import { contentDriftCount, hasFreshnessRisk } from '../../freshness.js';
import { DEGENERATE_EDGE_UREF_FLOOR } from '../../resolution/types.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import { resolveMcpServerProfile } from '../profiles.js';

// NOTE: `getToolModules` from './registry.js' is imported DYNAMICALLY
// inside `appendToolRegistryDrift` — a static import here creates a
// load-order cycle (registry.ts statically imports STATUS_TOOL from
// this file). See the comment on that function.

/** Hard cap on the optional inline rollup flags. The dedicated tools
 *  (`cartograph_hotspots`, `cartograph_biomarkers`) are still the right
 *  surface for higher counts — keep status compact.
 *
 *  The CLI `status` command mirrors this value as a local literal
 *  (`STATUS_MAX_INLINE_TOP_N` in src/bin/cartograph.ts) for its help
 *  text — it can't import this module at the top level (load-order
 *  cycle), only dynamically inside the handler. The clamp itself still
 *  runs through the shared {@link parseInlineTopN}. */
const MAX_INLINE_TOP_N = 30;

/**
 * Zod schema for `cartograph_status`.
 *
 * `topHotspots` / `topBiomarkers` are a DELIBERATE special case: a
 * plain `.optional()` number with NO `.min()`/`.max()`. Their
 * documented contract — "negative / non-numeric → suppressed; values
 * ≥ 1 capped at 30" — is a handler concern owned by
 * {@link parseInlineTopN}, so the schema must accept a negative value
 * (it means "suppress") rather than reject it. They also stay
 * default-free so the handler can distinguish "caller omitted" from
 * "caller passed 0" for the `verbose` precedence logic.
 *
 * `summaryBreakdown` / `verbose` are likewise default-free
 * `.optional()` booleans — the handler keys off `=== true` /
 * `typeof === 'boolean'` to honour the same omitted-vs-explicit
 * precedence.
 */
const statusSchema = z.object({
  projectPath: projectPathField,
  topHotspots: z
    .number()
    .optional()
    .describe(
      `Inline the top-N hotspots (by risk = centrality × churn). Default 0 (suppressed); values ≥ 1 capped at ${MAX_INLINE_TOP_N}.`,
    ),
  topBiomarkers: z
    .number()
    .optional()
    .describe(
      `Inline the top-N biomarker findings (warning+ severity, worst-first). Default 0 (suppressed); values ≥ 1 capped at ${MAX_INLINE_TOP_N}. ` +
        'With no warning+ findings, an explicit clean-state line is shown rather than dropping the request.',
    ),
  summaryBreakdown: z
    .boolean()
    .optional()
    .describe(
      'When true, expand the Summaries line into per-phase counts (structural / neighbor-prop / llm) plus symbols skipped by the body-line floor — disambiguates pending LLM work vs by-design floor gaps. Default false.',
    ),
  verbose: z
    .boolean()
    .optional()
    .describe(
      'One-call shortcut: when true, enables all three rollup flags at defaults (`topHotspots: 5`, `topBiomarkers: 5`, `summaryBreakdown: true`). Explicit caller values still win. Default false.',
    ),
});

type StatusArgs = z.infer<typeof statusSchema>;

async function handleStatus(ctx: ToolCtx, args: StatusArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const stats = cg.stats.getStats();
  const projectRoot = cg.projectRoot;
  const sourceLabel =
    args.projectPath === undefined ? '(default — server CWD at startup)' : '(from `projectPath` argument)';

  const { topHotspots, topBiomarkers, summaryBreakdown } = resolveStatusRollups(args);

  const lines: string[] = [];
  appendHeaderAndCounts({ lines, projectRoot, sourceLabel, stats });
  appendDefaultProjectSection(lines, ctx, projectRoot);
  appendBackendStatus(lines, cg, await isHnswAvailable());
  appendModuleFormat(lines, projectRoot);
  // Hoist the orchestrator's per-file drift snapshot so both
  // `appendFreshness` and `appendPendingChanges` see the same view —
  // otherwise the freshness banner would say "🟢 in sync with HEAD"
  // while Pending Changes simultaneously reports N uncommitted edits,
  // which is technically true (index points at HEAD commit) but reads
  // as self-contradictory to anyone scanning the output.
  const changedFiles = classifyChangedFiles(cg);
  appendFreshness(lines, cg.stats.getFreshness(), changedFiles);
  appendDegradedEdges(lines, cg);
  appendPendingChanges(lines, changedFiles);
  appendStaleArtifacts(lines, cg);
  appendParseCacheStatus(lines, cg);
  appendFeatureReadiness(lines, cg, { summaryBreakdown });
  await appendToolRegistryDrift(lines);
  await appendLlmProviders(lines, cg);
  appendServerConfig(lines, ctx);
  // Inline rollups go AFTER the readiness/server sections so an agent
  // scanning the top of the response always sees the freshness/health
  // banners first; rollups are bonus context, not the lead story.
  appendInlineHotspots(lines, cg, topHotspots);
  appendInlineBiomarkers(lines, cg, topBiomarkers);
  appendNodesByKind(lines, stats, cg);
  appendLanguages(lines, stats);
  appendOtherProjects(lines, ctx, projectRoot);

  return ok(textResult(lines.join('\n')));
}

/** Single source of truth for `topHotspots` / `topBiomarkers` coercion
 *  across the MCP and CLI surfaces. Documented contract:
 *
 *    - undefined / null / non-numeric  → 0 (suppressed)
 *    - negative / 0 / NaN              → 0 (suppressed)
 *    - fractional                      → floored
 *    - positive                        → clamped to [1, MAX_INLINE_TOP_N]
 *
 *  The MCP path arrives here AFTER Zod has validated `topHotspots:
 *  z.number()` so `raw` is a JS number; the `Number()` coercion is the
 *  CLI path's load-bearing branch (Commander hands us raw strings from
 *  argv). Both surfaces share this function so the agent sees one
 *  consistent contract regardless of transport — closes the prior
 *  MCP-vs-CLI drift where the CLI rejected `0` / `-5` / `1.5` while the
 *  MCP silently coerced them. The schema description on `topHotspots`
 *  / `topBiomarkers` documents this contract verbatim; CLI help text
 *  mirrors it. */
export function parseInlineTopN(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'number' ? Math.floor(raw) : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clamp(n, 1, MAX_INLINE_TOP_N);
}

export interface StatusRollupInput {
  readonly verbose?: boolean | undefined;
  readonly topHotspots?: unknown;
  readonly topBiomarkers?: unknown;
  readonly summaryBreakdown?: boolean | undefined;
}

export interface ResolvedStatusRollups {
  readonly topHotspots: number;
  readonly topBiomarkers: number;
  readonly summaryBreakdown: boolean;
}

/**
 * Resolve the status rollup switches shared by MCP `cartograph_status`
 * and CLI `cartograph status`. `verbose: true` supplies onboarding
 * defaults, while explicit caller values still win.
 */
export function resolveStatusRollups(input: StatusRollupInput): ResolvedStatusRollups {
  const verbose = input.verbose === true;
  const rawTopHotspots = parseInlineTopN(input.topHotspots);
  const rawTopBiomarkers = parseInlineTopN(input.topBiomarkers);
  return {
    topHotspots: verbose && rawTopHotspots === 0 ? 5 : rawTopHotspots,
    topBiomarkers: verbose && rawTopBiomarkers === 0 ? 5 : rawTopBiomarkers,
    summaryBreakdown: typeof input.summaryBreakdown === 'boolean' ? input.summaryBreakdown : verbose,
  };
}

/**
 * Phrase a rollup heading's count segment so it never reads as the
 * awkward "Top 1 findings".
 *
 * `requestedTopN` is the cap the caller asked for; `shown` is how many
 * rows actually came back. When fewer rows exist than the cap, the
 * rollup is the COMPLETE set — "Top N" would imply "the worst N of
 * many" and mislead. Three corrections in one place:
 *   - `shown < requestedTopN` → "all N" (this is everything), else
 *     "Top N" (a genuine cap-limited slice).
 *   - a complete set of exactly one drops the lead word entirely —
 *     "all 1 finding" reads oddly, plain "1 finding" does not.
 *   - `noun` pluralised on `shown` so a 1-row rollup says "1 finding".
 *
 * Examples (`noun = 'biomarker finding'`):
 *   shown=1,  cap=30 → "1 biomarker finding"
 *   shown=5,  cap=30 → "all 5 biomarker findings"
 *   shown=30, cap=30 → "Top 30 biomarker findings"
 *   shown=1,  cap=1  → "Top 1 biomarker finding" (a genuine top-1 ask)
 */
function rollupCountPhrase(shown: number, requestedTopN: number, noun: string): string {
  const plural = shown === 1 ? noun : `${noun}s`;
  if (shown < requestedTopN) {
    return shown === 1 ? `1 ${noun}` : `all ${shown} ${plural}`;
  }
  return `Top ${shown} ${plural}`;
}

/** Hotspots rollup — top N by composite risk score (centrality × churn).
 *  Skips silently on a non-git repo or empty hotspots table. The agent
 *  still sees the rest of the status response.
 *
 *  Exported so the CLI `status` command (a deliberate CLI-side direct
 *  implementation) can render the SAME rollup as the MCP tool without
 *  duplicating the query + formatting logic. */
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
  // F#51 (2026-05-26): when the rollup renders entirely from a shallow
  // clone, every row shows `commits: 0` and `risk: 0.0000` — looks
  // identical to a "no churn" project. Surface the cause so the agent
  // doesn't misread the rollup as "no risk anywhere". Mirrors the same
  // banner the dedicated `cartograph_hotspots` tool emits.
  const banner = statusShallowCloneBanner(cg.projectRoot, rows);
  if (banner) {
    lines.push('', banner);
  }
}

/**
 * Shallow-clone diagnostic for {@link appendInlineHotspots}. Returns an
 * informational banner only when (a) the repo is a shallow clone AND
 * (b) ≥ half of the rendered rows have `commitCount === 0`. Lenient
 * threshold so a partial unshallow doesn't suppress the hint.
 *
 * Distinct from the dedicated `cartograph_hotspots` tool's same-purpose
 * helper (`shallowCloneBanner` in `hotspots.ts`) — kept in this file to
 * avoid coupling the lightweight status inline-rollup to the heavier
 * hotspots tool, and so the wording can phrase the action differently
 * for the status onboarding context.
 */
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

/** Decimal precision for centrality + risk score columns in the
 *  inline-hotspots / inline-biomarkers rollups. Matches the
 *  pre-migration `.toFixed(4)` literal so the byte-output stays
 *  identical. Hoisted ABOVE the first spec builder so it appears
 *  before its formatRow-closure capture site (cleaner read order
 *  than the post-declaration form even though closures evaluate
 *  captures at call time). */
const ROLLUP_SCORE_DECIMALS = 4;

/**
 * Build the H3 inline-hotspots rollup spec for `cartograph_status`'s
 * `topHotspots:` flag. H3 heading-level — composes under the main
 * `## Cartograph Status` H2. The trailing footer points at the
 * dedicated tool's filter knobs so the agent knows where to drill
 * in. Lint-walkable via `bulletListSpecStrings`.
 */
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

/** Biomarker findings rollup — worst-severity first, defaulting to
 *  `warning+` so info-level noise doesn't crowd the rollup.
 *
 *  When the caller explicitly asked for the rollup (`topN > 0`) but
 *  there are no warning+ findings, emit an explicit empty-state line
 *  instead of silently rendering nothing — otherwise a caller can't
 *  tell "honoured, empty" from "ignored". Matches the digest tool's
 *  4-state taxonomy:
 *   - `pending` → cross-file pass hasn't completed for this index
 *     generation (e.g. post-hook killed by budget on a large repo, or
 *     transient window after `index --force`). Detected via
 *     {@link areBiomarkersPending}. Render the "⏳ pending" note —
 *     surfacing "Project clean ✓" here would be confidently wrong.
 *   - 0 findings of ANY severity AND pass complete → "project clean".
 *   - 0 warning+ but N info-level present → say so, and point at the
 *     dedicated tool's `minSeverity` knob to see them.
 *   - populated → normal severity-ranked table.
 *  Still skips silently on a pre-migration DB where the findings table
 *  doesn't exist (the `catch` path) — that's a no-data state, not a
 *  clean one, and the Feature Readiness section already owns it.
 *
 *  Exported for the CLI `status` direct implementation — see
 *  {@link appendInlineHotspots}. */
export function appendInlineBiomarkers(lines: string[], cg: Cartograph, topN: number): void {
  if (topN <= 0) return;
  let rows: ReturnType<typeof getFindingsRanked>;
  try {
    rows = getFindingsRanked(cg.queries, { limit: topN, minSeverity: 'warning' });
  } catch {
    return;
  }
  if (rows.length === 0) {
    // No warning+ findings — distinguish three sub-states:
    //  (a) cross-file pass pending for this index generation,
    //  (b) genuinely clean (pass complete, 0 findings),
    //  (c) 0 warning+ but N info-level present.
    // `getFindingsStats` is wrapped: on a pre-migration DB it throws
    // and we stay silent (no-data, not clean).
    let totalFindings: number;
    try {
      totalFindings = getFindingsStats(cg.queries).totalFindings;
    } catch {
      return;
    }
    // Fail-open on the pending check: if metadata is unreadable, fall
    // through to the existing clean/info-level branch rather than
    // suppressing the rollup. Matches the predicate's own catch-block
    // contract.
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

/** Run a boolean-returning thunk, swallowing any throw and returning
 *  `null`. Used to keep the inline-rollup paths fail-open against
 *  metadata-query errors (pre-migration DB, etc.). */
function safeBoolean(fn: () => boolean): boolean | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Args for {@link buildStatusInlineBiomarkersSpec}. Bundled so the
 *  builder stays under the 4-param `long_parameter_list` info floor.
 *  `totalFindings` is the absolute project-wide count used to
 *  distinguish the "0 findings" vs "0 warning+ but N info" empty
 *  shapes; pass `-1` when `rows` is non-empty (the populated path
 *  ignores it). `pending` is the {@link areBiomarkersPending} verdict;
 *  when `true` AND the rollup is empty, render the "⏳ pending" note
 *  instead of "Project clean ✓" — see {@link appendInlineBiomarkers}
 *  for the cross-file pass / kill-by-budget cases that trigger it. */
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

/**
 * Build the H3 inline-biomarkers rollup spec for `cartograph_status`'s
 * `topBiomarkers:` flag. Four states:
 *
 * 1. `rows.length > 0` → populated table with severity-ranked findings.
 * 2. `rows.length === 0 && pending` → "⏳ pending" empty-state. The
 *    cross-file pass hasn't completed for the current index
 *    generation (post-hook still in flight, killed by budget, or
 *    transient window after `index --force`).
 * 3. `rows.length === 0 && !pending && totalFindings === 0` →
 *    "Project clean ✓" empty-state.
 * 4. `rows.length === 0 && !pending && totalFindings > 0` → "No
 *    warning+ findings — N info-level finding(s) present" empty-state,
 *    with a pointer at the dedicated tool's `minSeverity: 'info'` knob.
 *
 * The populated path's trailing footer points at
 * `cartograph_biomarkers mode=ranked`. Lint-walkable; empty-state
 * copy is conditional so the lint must inspect all three empty cases.
 */
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

/** Clean-state copy for the status inline-biomarkers rollup —
 *  exported as a constant so the wording-lint walks the same string
 *  the empty-state path emits. */
export const STATUS_BIOMARKERS_CLEAN_NOTE = '_Project clean ✓ — 0 biomarker findings across all detectors._';

/** Pending-state copy for the status inline-biomarkers rollup. Fires
 *  when {@link areBiomarkersPending} reports `true` AND the rollup
 *  itself is empty — i.e. the cross-file pass hasn't completed for
 *  this index generation, so "0 findings" reflects "no data yet",
 *  not "verified clean". Mirrors `DIGEST_BIOMARKER_STATE_NOTES.pending`
 *  so the two surfaces stay in lockstep. Exported alongside the
 *  clean-state copy so the wording-lint walks both empty-states. */
export const STATUS_BIOMARKERS_PENDING_NOTE =
  '_⏳ Biomarker pass pending — re-run after `cartograph admin sync` completes._';

/**
 * Show whether the MCP server has a default project bound, and warn
 * when it doesn't. User-suggested 2026-05-03: even if the operator
 * missed the stderr warning at startup, calling cartograph_status
 * surfaces the misconfig. Three shapes:
 *   - Has default + matches the queried root: "✅ ... (this query)"
 *   - Has default + queried via different projectPath: "✅ ... — querying <other>"
 *   - No default: "⚠ NONE — server has no default project. ..." +
 *     restart hint.
 */
function appendDefaultProjectSection(lines: string[], ctx: ToolCtx, queriedRoot: string): void {
  if (ctx.defaultCg) {
    const defaultRoot = (() => {
      try {
        return ctx.defaultCg.projectRoot;
      } catch {
        return null;
      }
    })();
    if (!defaultRoot) return;
    const sameProject = defaultRoot === queriedRoot;
    lines.push('', '### 🏠 Default project');
    if (sameProject) {
      lines.push(`- ✅ \`${defaultRoot}\` — auto-sync via file watcher is active for this project.`);
    } else {
      lines.push(
        `- ✅ Server default: \`${defaultRoot}\` (auto-synced).`,
        `- ℹ This status is for the queried project \`${queriedRoot}\` (loaded via \`projectPath\`).`,
      );
    }
    return;
  }
  // No default — surface the warning + actionable hint.
  lines.push(
    '',
    '### ⚠ Default project: NONE',
    `- The MCP server has no default project bound. Every tool call must pass \`projectPath\` ` +
      `explicitly, and auto-sync via the file watcher only kicks in after the first query to a project ` +
      `(capped at 16 active projects).`,
    `- To fix: restart the MCP server with \`--project-path "${queriedRoot}"\` so this project becomes ` +
      `the default and gets auto-sync from session start. (In an MCP client config, add \`--project-path\` ` +
      `to the cartograph entry's \`args\`.)`,
  );
}

/**
 * Tell the agent *which* project this status is for and how it was
 * selected. Friction this addresses: when an MCP server's default
 * project doesn't match what the user wants, the agent can't tell
 * from any other tool's output whether to start passing
 * `projectPath`. Surfacing the project root here makes the mismatch
 * visible on the very first call.
 */
interface AppendHeaderAndCountsArgs {
  lines: string[];
  projectRoot: string;
  sourceLabel: string;
  stats: ReturnType<Cartograph['stats']['getStats']>;
}

function appendHeaderAndCounts(args: AppendHeaderAndCountsArgs): void {
  const { lines, projectRoot, sourceLabel, stats } = args;
  lines.push(
    '## Cartograph Status',
    '',
    `**Project root:** \`${projectRoot}\` ${sourceLabel}`,
    `**Files indexed:** ${stats.fileCount}` + (stats.testFileCount > 0 ? ` (${stats.testFileCount} test)` : ''),
    `**Total nodes:** ${stats.nodeCount}`,
    `**Total edges:** ${stats.edgeCount}`,
    `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  );
}

/**
 * Surface the active SQLite backend. node:sqlite is the default
 * (Node 22.5+ built-in, no native compile, no platform binaries).
 * better-sqlite3 is reported when the user has installed it
 * explicitly for the perf opt-in (~1.5× faster indexing). Per-instance
 * via cg.db.getBackend() so explicit-project queries report the right
 * backend.
 */
function appendBackendStatus(lines: string[], cg: Cartograph, hnswAvailable: boolean): void {
  const vec = cg.db.hasVecExtension();
  const vecSuffix = vec ? ' + sqlite-vec (indexed similarity) ✅' : ' ⚠ no sqlite-vec';
  // cartograph is Bun-only now — bun:sqlite is the sole backend.
  lines.push(`**Backend:** bun:sqlite${vecSuffix}`);
  // Surface a degraded vector-search path so an operator on a platform
  // without a prebuilt binary knows they're on a slow fallback (and
  // how to fix it) instead of silently getting worse latency.
  if (!vec) {
    lines.push(
      '  ⚠ `sqlite-vec` did not load — vector search runs on the slow in-memory ' +
        'brute-force path. sqlite-vec ships prebuilt binaries for darwin/linux ' +
        '(x64+arm64) and windows-x64; other platforms hit this fallback.',
    );
  } else if (!hnswAvailable) {
    lines.push(
      '  ℹ USearch unavailable — `similar_to` edge builds use the vec0 brute-force ' +
        'path (O(N²) at scale). Optional; `bun install` re-fetches the `usearch` ' +
        'accelerator for large repos.',
    );
  }
}

/**
 * Module format (ESM / CJS / mixed) read from package.json + tsconfig.
 * Surfaces upfront context for migration-style tasks where knowing
 * "this project compiles to CommonJS" changes the agent's plan.
 */
function appendModuleFormat(lines: string[], projectRoot: string): void {
  const modFmt = formatModuleFormatLine(detectModuleFormat(projectRoot));
  if (modFmt) lines.push(modFmt);
}

/** True content-modified count for a `ChangedFiles` snapshot — added,
 *  removed, and heal-only entries are EXCLUDED because they are not
 *  "content-changed since index" in the same sense as
 *  `cartograph_changed_since`'s content-hash bucket. */
function changedTotal(changes: ChangedFiles | null): number {
  if (!changes) return 0;
  return realModifiedCount(changes);
}

/** Format the commit-count-drift status line. Pulled out of
 *  {@link appendFreshness} so the parent's branching stays shallow
 *  and the wording lives in one place. */
function formatStaleLine(freshness: NonNullable<ReturnType<Cartograph['stats']['getFreshness']>>): string {
  const sev = freshness.severity;
  // very_stale = 🔴, stale = 🟠, recent = 🟡.
  let icon = '🟡';
  if (sev === 'very_stale') {
    icon = '🔴';
  } else if (sev === 'stale') {
    icon = '🟠';
  }
  let commitsSeg = 'commits landed since index';
  if (freshness.commitsAhead != null && freshness.commitsAhead > 0) {
    commitsSeg = `${freshness.commitsAhead} commit${freshness.commitsAhead === 1 ? '' : 's'} ahead of indexed HEAD`;
  }
  const fileCountLabel = freshness.filesChanged === 1 ? 'file' : 'files';
  const filesSeg =
    freshness.filesChanged == null ? '' : ` (${freshness.filesChanged} ${fileCountLabel} touched per \`git diff\`)`;
  return `**Status:** ${icon} stale — ${commitsSeg}${filesSeg} (severity: \`${sev}\`) — run \`cartograph admin sync\``;
}

/** Format the content-hash-drift status line. The "(at HEAD)" suffix
 *  is gated on no commits having landed AND a SHA being present, so
 *  non-git projects get a cleaner phrasing. */
function formatContentDriftLine(
  freshness: NonNullable<ReturnType<Cartograph['stats']['getFreshness']>>,
  uncommittedCount: number,
): string {
  const atHead = !freshness.isStale && freshness.indexedSha ? ' (index at HEAD)' : '';
  return (
    `**Status:** 🟡 ${uncommittedCount} file${uncommittedCount === 1 ? '' : 's'} content-changed ` +
    `since index${atHead} — run \`cartograph admin sync\` to refresh`
  );
}

function formatPendingPathDriftLine(
  freshness: NonNullable<ReturnType<Cartograph['stats']['getFreshness']>>,
  count: number,
): string {
  const atHead = !freshness.isStale && freshness.indexedSha ? ' (index at HEAD)' : '';
  return (
    `**Status:** 🟡 ${count} file${count === 1 ? '' : 's'} added/removed since index${atHead} — ` +
    `run \`cartograph admin sync\` to refresh`
  );
}

/** Format the git-independent index-drift status line — tracked files
 *  whose on-disk content hash no longer matches the indexed
 *  `content_hash`, detected by a direct per-file re-hash rather than
 *  via `git status`. Renders only when the git-side `uncommittedCount`
 *  did NOT already surface the drift (see {@link appendFreshness}), so
 *  the wording calls out that the index lags disk despite git being
 *  quiet — the false-"in sync" case this guards against. */
function formatIndexDriftLine(driftedCount: number): string {
  return (
    `**Status:** 🟡 ${driftedCount} file${driftedCount === 1 ? '' : 's'} drifted from the index ` +
    `(on-disk content differs from indexed \`content_hash\`; not surfaced by \`git status\`) — ` +
    `run \`cartograph admin sync\` to refresh`
  );
}

/** Format the heal-flagged-drift status line. Distinct from
 *  {@link formatContentDriftLine} because the on-disk content is in
 *  sync — only the index needs to re-walk these files so the new
 *  extractor emit-set (EXTRACTION_LOGIC_VERSION bump) takes effect.
 *  FRICTION-A 2026-05-14: rendering this as "content-changed" was
 *  factually wrong and disagreed with `cartograph_changed_since`'s
 *  per-file SHA recompute. */
function formatHealFlaggedLine(healFlaggedCount: number): string {
  return (
    `**Status:** 🔵 ${healFlaggedCount} file${healFlaggedCount === 1 ? '' : 's'} flagged for ` +
    `re-extraction by extraction-logic-version drift — run \`cartograph admin sync\` to refresh`
  );
}

/** Indexed-at / indexed-HEAD / staleness section with severity-based
 *  status icon. The banner unifies two orthogonal drift facets so the
 *  reader never sees "🟢 in sync" next to "N files drifted":
 *   - Index SHA vs current HEAD (freshness.isStale) — commits landed
 *     since the last index pass; renders as "N commits ahead of indexed
 *     HEAD (M files in `git diff`)" so the source of the count is
 *     unambiguous.
 *   - On-disk content vs indexed content (uncommittedCount) —
 *     uncommitted edits in the working tree, measured by per-file
 *     content-hash comparison.
 *  Either can be true independently; the banner reports whichever drift
 *  is active (or both — when commits landed AND there are uncommitted
 *  edits, both lines render).
 *
 *  Cross-reference (FRICTION-status-changed_since-semantic-disagreement):
 *  `cartograph_changed_since` uses on-disk content_hash vs indexed
 *  `files.content_hash` to define "changed", which can disagree with
 *  the git-side count rendered here. We surface a one-liner pointing
 *  at the other tool so a reader who sees "581 commits ahead, 581
 *  files in git diff" alongside "1 modified" in `changed_since` can
 *  resolve the apparent contradiction immediately. */
function appendFreshness(
  lines: string[],
  freshness: ReturnType<Cartograph['stats']['getFreshness']>,
  changedFiles: ChangedFiles | null,
): void {
  if (!freshness) return;
  lines.push(`**Indexed at:** ${new Date(freshness.indexedAt).toISOString()}`);
  if (freshness.indexedSha) {
    lines.push(`**Indexed HEAD:** \`${shortSha(freshness.indexedSha)}\``);
  }
  const uncommittedCount = changedTotal(changedFiles);
  const pendingPathDriftCount = changedFiles ? changedFiles.added.length + changedFiles.removed.length : 0;
  const healFlaggedCount = changedFiles?.healOnly.length ?? 0;
  // Three orthogonal drift facets — render each that's active so signals
  // never crowd or contradict each other:
  //   - commit-count drift (git-side, large): "N commits ahead of indexed HEAD"
  //   - on-disk content drift (per-file, what changed_since reports): "N files content-changed"
  //   - extraction-logic-version heal pressure (no on-disk drift, but the
  //     extractor's emit-set changed so the index needs to re-walk):
  //     "N files flagged for re-extraction by extraction-logic-version drift"
  // FRICTION-A 2026-05-14: heal-flagged paths used to be folded into the
  // content-drift count, which meant a clean tree with heal pending
  // reported "615 files content-changed" while `cartograph_changed_since`
  // simultaneously reported "1 file content-changed (deleted)" — two
  // tools that claim to share a definition disagreeing by 615×. Split
  // here so the wording matches the semantic in each case.
  let rendered = false;
  if (freshness.isStale) {
    lines.push(formatStaleLine(freshness));
    rendered = true;
  }
  if (uncommittedCount > 0) {
    lines.push(formatContentDriftLine(freshness, uncommittedCount));
    rendered = true;
  }
  if (pendingPathDriftCount > 0) {
    lines.push(formatPendingPathDriftLine(freshness, pendingPathDriftCount));
    rendered = true;
  }
  if (healFlaggedCount > 0) {
    lines.push(formatHealFlaggedLine(healFlaggedCount));
    rendered = true;
  }
  // Git-independent per-file content-hash drift. `classifyChangedFiles`
  // (the source of `uncommittedCount`) derives its view from `git
  // status` / `git diff`, so it misses files whose indexed
  // `content_hash` lags disk without git noticing — e.g. a file the
  // last sync skipped. `freshness.contentDriftedFiles` re-hashes every
  // tracked file directly. Render it ONLY when the git-side count
  // didn't already cover the drift, so a working tree with ordinary
  // uncommitted edits doesn't print two near-identical lines.
  //
  // `freshness.contentDriftedFiles` is computed by `countContentDriftedFiles`
  // which calls the same `getStaleFiles` primitive that `ChangeOracle.contentDrift`
  // wraps. The cross-tool invariant
  //   `Oracle.contentDrift.size === getFreshnessInfo().contentDriftedFiles`
  // in `__tests__/change-oracle.test.ts` pins their equivalence — if a
  // future maintainer changes one path, that test breaks. No separate
  // Oracle call is needed here.
  const contentDrifted = contentDriftCount(freshness);
  if (contentDrifted > 0 && uncommittedCount === 0) {
    lines.push(formatIndexDriftLine(contentDrifted));
    rendered = true;
  }
  if (!rendered && freshness.indexedSha) {
    lines.push('**Status:** 🟢 in sync with HEAD');
  }
  // Cross-reference: any non-green state could have callers wondering
  // why the count in `cartograph_changed_since` disagrees. Phrased as a
  // passive `_…_` markdown italic so it doesn't compete with the
  // actionable sync hint. Skipped when the only signal is heal-flag
  // pressure: `cartograph_changed_since` won't show those files (they
  // have no on-disk drift), so pointing the reader at it would be
  // misleading.
  if (rendered && (hasFreshnessRisk(freshness) || uncommittedCount > 0 || pendingPathDriftCount > 0)) {
    lines.push(
      '_For the per-file content-hash list (path-by-path drift, not ' +
        'commit-count), run `cartograph_changed_since`._',
    );
  }
}

/**
 * Append the resolved-reference-edges integrity line when the index is
 * in the "calls/imports edges collapsed but `unresolved_refs` still has
 * heavy work pending" degraded state.
 *
 * The classic 🟢 freshness banner only checks HEAD / content drift / heal
 * flags — it cannot tell a healthy graph apart from one whose resolved-
 * reference layer has been wiped. An agent reading "🟢 in sync" while
 * every `cartograph_graph direction:callers` query returns empty is being
 * actively misled (the "Index in sync — empty result is a true negative,
 * not a freshness gap" footers compound the harm). This line surfaces
 * the gap explicitly and points at the recovery action.
 *
 * Uses the shared {@link DEGENERATE_EDGE_UREF_FLOOR} so this banner
 * fires in EXACTLY the same window the safety-net drain in
 * `cgSyncResolveReferences` fires — defining the threshold twice would
 * silently drift over time.
 */
function appendDegradedEdges(lines: string[], cg: Cartograph): void {
  const row = safeCall(
    () =>
      cg.queries.db
        .prepare(
          `SELECT
       (SELECT COUNT(*) FROM edges WHERE kind = 'calls') AS calls,
       (SELECT COUNT(*) FROM edges WHERE kind = 'imports') AS imports,
       (SELECT COUNT(*) FROM unresolved_refs) AS uref`,
        )
        .get() as { calls: number; imports: number; uref: number } | undefined,
  );
  if (!row) return;
  if (row.calls === 0 && row.imports === 0 && row.uref >= DEGENERATE_EDGE_UREF_FLOOR) {
    lines.push(
      `**Edges:** 🔴 reference resolution incomplete — ${row.uref.toLocaleString()} ` +
        'unresolved refs but 0 `calls` / 0 `imports` edges. Call-graph queries ' +
        '(`cartograph_graph`, `cartograph_affected`, `cartograph_node({includeCallers})`) ' +
        'will return empty until the stranded refs drain; run `cartograph admin sync` ' +
        'to trigger the safety-net resolver pass.',
    );
  }
}

/**
 * Pending Changes breakdown (B14). The freshness banner above owns the
 * total count + actionable sync hint; this section adds the
 * add/modify/remove split so the agent knows which kind of drift it's
 * facing — adds usually need a fresh sync, modifies might be okay to
 * query stale, removes need attention because dangling references
 * could be lurking.
 *
 * Skipped entirely when the only signal would be the count (the
 * freshness banner already carries that). When a single bucket
 * accounts for every drift entry AND that bucket is "modified", we
 * also skip — modified-only drift is the dull case and the banner's
 * "N files content-changed since index" already implies it.
 * Mixed-bucket drift (any `added` or `removed`) keeps the section
 * since add/remove are the categories worth a per-bucket callout.
 */
function appendPendingChanges(lines: string[], changes: ChangedFiles | null): void {
  if (!changes) return;
  // Heal-only entries shouldn't show up in the per-bucket breakdown
  // (no on-disk drift); the freshness banner's heal-flagged line owns
  // that signal.
  const realModified = realModifiedCount(changes);
  if (changes.added.length === 0 && changes.removed.length === 0) return;
  const segs: string[] = [];
  if (changes.added.length > 0) segs.push(`+${changes.added.length} added`);
  if (realModified > 0) segs.push(`~${realModified} modified`);
  if (changes.removed.length > 0) segs.push(`-${changes.removed.length} removed`);
  lines.push('', '### 📂 Pending changes', `- Breakdown: ${segs.join(', ')}.`);
}

/**
 * Surface pre-computed artifacts (LLM summaries, embeddings, biomarker
 * findings) whose stored content_hash no longer matches the source.
 * These don't trigger the regular freshness banner because the
 * underlying files ARE in sync; only the LLM-derived layer is behind.
 */
function appendStaleArtifacts(lines: string[], cg: Cartograph): void {
  try {
    const stale = getStaleArtifactsCount(cg.queries);
    if (stale.total === 0) return;
    const segs: string[] = [];
    if (stale.summaries) segs.push(`${stale.summaries} summaries`);
    if (stale.embeddings) segs.push(`${stale.embeddings} embeddings`);
    if (stale.findings) segs.push(`${stale.findings} biomarker findings`);
    lines.push(
      `**Out-of-date artifacts:** ${stale.total} (${segs.join(', ')}) — ` +
        `source files changed since these were generated. Run \`cartograph admin sync\` ` +
        `to refresh, or use \`cartograph_summaries({action: 'pending'})\` to drive regeneration ` +
        `from the agent. Existing artifacts remain readable until refreshed.`,
    );
  } catch {
    // pre-migration-020 DB or missing tables — not worth surfacing.
  }
}

/**
 * Surface the parse-cache state. Populated by extraction; replays
 * unchanged files on `--force` reindex without re-parsing. The agent
 * needs to see this because:
 *   - When `staleVersionRows > 0` after a fresh build, the
 *     PAYLOAD_VERSION envelope just got bumped (extractor semantics
 *     changed) — those rows are inert and will get LRU-evicted.
 *   - When `currentVersionRows == 0` on a freshly-indexed project,
 *     the cache is empty (e.g. after a manual `clearParseCache`) and
 *     the next `indexAll` will pay full parse cost. (`--force`
 *     intentionally preserves the cache — the lever is `admin index
 *     --clear-parse-cache`.)
 *   - A persistently large `staleVersionRows` count after several
 *     reindexes suggests the LRU isn't catching up; consider a
 *     deliberate cache wipe.
 */
function appendParseCacheStatus(lines: string[], cg: Cartograph): void {
  let stats: ReturnType<typeof getParseCacheStats>;
  try {
    stats = getParseCacheStats(cg.queries);
  } catch {
    return; /* pre-migration-026 DB — table doesn't exist */
  }
  if (stats.rows === 0) return;
  const sizeMB = stats.sizeBytes / 1024 / 1024;
  const staleNote =
    stats.staleVersionRows > 0 ? ` (${stats.staleVersionRows} stale from earlier _v — inert, will LRU out)` : '';
  lines.push(
    `**Parse cache:** ${stats.currentVersionRows} replayable entries, ` +
      `${sizeMB.toFixed(1)} MB — schema _v${stats.currentVersion}${staleNote}.`,
  );
}

/**
 * Surface the case where new tool source files exist on disk but
 * weren't loaded into the running process's tool registry. The
 * MCP server's `ALL_TOOLS` is built from static imports at module
 * load time, so a tool added in a later commit (after the server
 * started) is invisible until restart. Detect by reading each
 * candidate tool file in this directory and counting those that
 * actually declare a `_TOOL: ToolModule` export, then comparing
 * against the loaded `getToolModules().length`. A delta means:
 * pull happened, restart needed (B18 friction).
 *
 * The on-disk count uses content sniffing (not just filename
 * pattern matching) because the directory holds a mix of registered
 * tools and per-tool helper modules — checking the export is the
 * only correct discriminator without maintaining a hand-edited
 * exclusion list.
 */
async function appendToolRegistryDrift(lines: string[]): Promise<void> {
  let onDisk: number;
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    onDisk = (await readdir(dir)).filter((f) => isToolFile(dir, f)).length;
  } catch {
    return; // Best-effort diagnostic — silent when fs access fails (sandboxed envs).
  }
  // `registry.ts` is imported DYNAMICALLY here, not at module top level:
  // registry.ts statically imports every tool module (including this
  // one), so a static `import { getToolModules }` creates a load-order
  // cycle that throws a TDZ error when status.ts happens to be the
  // module that initialises the graph first (e.g. the CLI dynamically
  // importing status.ts for its rollup helpers).
  let loaded: number;
  try {
    const { getToolModules } = await import('./registry.js');
    loaded = getToolModules().length;
  } catch {
    return; // registry unavailable (e.g. CLI context with no live server) — skip the drift check.
  }
  if (onDisk <= loaded) return; // Equal or "loaded > on-disk" both mean "in sync"; the latter shouldn't happen but is harmless.
  lines.push(
    '',
    '### ⚠ Tool registry drift',
    `- ${onDisk - loaded} tool file${onDisk - loaded === 1 ? '' : 's'} on disk are NOT loaded ` +
      `into this MCP server's registry (${loaded} loaded vs ${onDisk} on disk). New tools added ` +
      `since startup require a server restart to become callable.`,
  );
}

/** Regex used by `isToolFile` to confirm a tool-module export. */
const TOOL_EXPORT_PATTERN = /export\s+const\s+[A-Z][A-Z0-9_]*_TOOL\s*:\s*ToolModule\b/;

/**
 * "This file in src/mcp/tools/ is a registered tool module."
 * Cheap pre-filter on filename, then a targeted file read to
 * confirm the `_TOOL: ToolModule` export. Helper modules
 * (env-refs, explore-budget, result-formatters, sql-refs,
 * symbol-resolver, etc.) live alongside the tools but don't
 * declare `_TOOL` exports — content-sniffing keeps the count
 * accurate as new helpers land without touching this file.
 */
function isToolFile(dir: string, filename: string): boolean {
  if (filename.startsWith('_')) return false;
  if (!/\.(ts|js)$/.test(filename)) return false;
  if (filename.endsWith('.d.ts')) return false;
  if (filename.endsWith('.test.ts') || filename.endsWith('.test.js')) return false;
  const base = filename.replace(/\.(ts|js)$/, '');
  if (['registry', 'types', 'shared', 'tool-types'].includes(base)) return false;
  try {
    const body = fs.readFileSync(path.join(dir, filename), 'utf-8');
    return TOOL_EXPORT_PATTERN.test(body);
  } catch {
    return false; // Treat unreadable as non-tool (conservative).
  }
}

/** Per-lens time budget. Lenses are sync (bun:sqlite calls), so
 *  we can't interrupt one mid-flight; this threshold is for LOGGING
 *  the slow path so the next runaway is self-identifying instead of
 *  appearing as a silent 99%-CPU spin. Mid-2026: I clobbered an MCP
 *  server because a `cartograph status` invocation had been pegged at
 *  99% CPU since Friday with no log line; this is the prevention. */
const SLOW_LENS_LOG_MS = 1_000;
/** Total budget across all lenses. When exceeded, remaining lenses
 *  are skipped (their reading becomes `{ present: false }`). Aggregate
 *  time before this point goes into the log. */
const APPEND_FEATURE_READINESS_BUDGET_MS = 30_000;

/** Run a getter that may throw (pre-migration DB / missing table) AND
 *  log when it takes longer than {@link SLOW_LENS_LOG_MS}. Sync — we
 *  can't interrupt bun:sqlite mid-call, but the log makes a future
 *  runaway debuggable in seconds instead of days. */
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

/** Traffic-light icon for empty / partial / full readiness states. */
function trafficLight(state: 'empty' | 'partial' | 'full' | 'info'): string {
  if (state === 'full') return '🟢';
  if (state === 'partial') return '🟡';
  if (state === 'info') return '🔵';
  return '⚪';
}

// 'info' (🔵) renders for purely informational disclosures whose
// "high count" does NOT indicate feature-readiness — e.g. the
// unresolved_refs lens, which surfaces an intentional metric the
// agent should NOT try to "fix". Distinct from 'full' (🟢 = feature
// is ready and working) so a skimming agent doesn't misread a green
// icon as "this is good, working as expected".
type LensState = 'empty' | 'partial' | 'full' | 'info';
type LensReading = { present: false } | { present: true; state: LensState; line: string };
/** Per-lens options bag. Today only `readSummariesLens` consumes a
 *  flag; future lenses can pluck their own keys without forcing every
 *  lens signature to grow.
 *
 *  Exported so the CLI `status` direct implementation can call
 *  {@link appendFeatureReadiness} with a typed opts bag. */
export interface LensOpts {
  summaryBreakdown: boolean;
}
type ReadinessLens = (cg: Cartograph, opts: LensOpts) => LensReading;

/**
 * Count rows in `<table>` whose `body_hash` is NOT referenced by
 * `<refsTable>` — the "reuse-cached" tier introduced by the staleness
 * redesign (Phase 3/4, migrations 049/050). These rows survive node
 * deletion / rename / move so the LLM/embed cost can be reclaimed on
 * revert. Reported separately from the live count so the lens reflects
 * the raw-store size while still answering "is this feature ready".
 *
 * Best-effort: returns 0 on any error (pre-migration DB, etc.) so the
 * lens stays diagnostic.
 */
function countReuseCachedRows(cg: Cartograph, storeTable: string, refsTable: string): number {
  try {
    const row = cg.db
      .getDb()
      .prepare(`SELECT COUNT(*) AS c FROM ${storeTable} WHERE body_hash NOT IN (SELECT body_hash FROM ${refsTable})`)
      .get() as { c: number };
    return row.c ?? 0;
  } catch {
    return 0;
  }
}

function readSummariesLens(cg: Cartograph, opts: { summaryBreakdown: boolean }): LensReading {
  const sumCov = safeCall(() => getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  if (!sumCov || sumCov.total === 0) return { present: false };
  const pct = Math.round((sumCov.summarised / sumCov.total) * 100);
  // Phase 3 (migration 049) split summaries into per-node refs + a
  // content-addressed store. Rows orphaned by node deletion / rename
  // remain in `summary_store` for free reuse on revert/rename — surface
  // them so the displayed count matches the raw-store total. Friction F-W.
  const summaryReuseCached = countReuseCachedRows(cg, 'summary_store', 'summary_refs');
  // Pending = candidate set per the kind + body-line + docstring filter
  // MINUS nodes already linked in `summary_refs`. The earlier
  // implementation used `getSummarizableNodes(...).length` directly, but
  // that returns the full candidate set including already-summarised
  // nodes (summarize iterates them and Tier-1-cache-hit no-ops), so
  // the badge stayed 🟡 partial even when there was nothing for
  // summarize to actually generate.
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
    action =
      " — run `cartograph summarize` (or `cartograph_summaries({action: 'pending'})` + `cartograph_summaries({action: 'save'})`)";
  } else if (state === 'partial') {
    action = ` — ${pending} pending; run \`cartograph summarize\` to complete`;
  }
  // Centrality-weighted view: complements the raw count with a quality
  // signal — agents read centrality-weighted as "is the SPINE covered",
  // which matters more than tail coverage. Skipped silently when
  // centrality hasn't been computed yet (totalWeight=0 → ratio=null).
  const weighted = safeCall(() => getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  const weightedSuffix =
    weighted && weighted.weightedRatio !== null
      ? ` _(centrality-weighted: ${Math.round(weighted.weightedRatio * 100)}%)_`
      : '';
  const reuseSuffix = summaryReuseCached > 0 ? ` — ${summaryReuseCached} reuse-cached` : '';
  let line = `**Summaries:** ${sumCov.summarised} / ${sumCov.total} (${pct}%)${weightedSuffix}${reuseSuffix}${action}`;
  // Background-pass indicator — tells the agent the coverage figure is
  // still climbing, so a partial number means "check back", not
  // "final". Two sources: the in-process `bgCtrl` pass (this long-lived
  // MCP server kicked it off after `index`/`sync`) and a detached
  // summarizer spawned by the CLI `admin index` (separate process,
  // tracked via `.cartograph/summarize.pid`).
  const bgProgress = cg.llm.bgCtrl.progress;
  if (bgProgress) {
    line += `\n    ⏳ summarization running in the background — ${bgProgress.phase} ${bgProgress.done}/${bgProgress.total}; re-check coverage shortly`;
  } else {
    const detached = safeCall(() => getDetachedSummarizeState(cg.projectRoot));
    if (detached?.running) {
      line += `\n    ⏳ detached summarizer running (pid ${detached.pid}) — coverage is still climbing; re-check shortly`;
    }
  }
  // Optional per-phase breakdown so agents can tell whether the gap is
  // pending LLM work vs by-design floor. Cheap query — one GROUP-BY +
  // one COUNT — but gated behind a flag to keep the default response
  // compact for the "is the index there?" use case.
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

/** Render the per-phase breakdown block under the Summaries lens line.
 *  Indented two spaces beyond the bullet so the block visually nests
 *  under the parent line in the rendered markdown. */
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

function readEmbeddingsLens(cg: Cartograph): LensReading {
  const embTotal = safeCall(() => getEmbeddingsTotal(cg.queries));
  if (embTotal === undefined) return { present: false };
  const state: LensState = embTotal === 0 ? 'empty' : 'full';
  const action =
    embTotal === 0
      ? " — run `cartograph embed`; needed for `cartograph_find({by: 'name', mode: 'semantic'})` + hybrid retrieval"
      : '';
  // Phase 4 (migration 050) split embeddings into per-node refs + a
  // content-addressed store. Rows orphaned by node deletion / rename
  // remain in `embedding_store` for free reuse on revert/rename — surface
  // them so the displayed count matches the raw-store total. Friction F-W.
  // Wording keeps the historical "rows" suffix so `Embeddings.*\d+ rows`
  // assertions in adjacent test files don't regress on the new wording.
  const reuseCached = countReuseCachedRows(cg, 'embedding_store', 'embedding_refs');
  const reuseSuffix = reuseCached > 0 ? ` (+ ${reuseCached} reuse-cached)` : '';
  return { present: true, state, line: `**Embeddings:** ${embTotal} rows${reuseSuffix}${action}` };
}

function readCoverageLens(cg: Cartograph): LensReading {
  const covStats = safeCall(() => getCoverageStats(cg.queries));
  if (covStats === undefined) return { present: false };
  const state: LensState = covStats.symbolsWithCoverage === 0 ? 'empty' : 'full';
  const action = formatCoverageAction(covStats);
  return { present: true, state, line: `**Coverage:** ${covStats.symbolsWithCoverage} symbols${action}` };
}

/** Render the trailing-text suffix for the coverage status line: a
 *  load-hint when no coverage rows exist, else a sources summary. */
function formatCoverageAction(covStats: { symbolsWithCoverage: number; sources: string[] }): string {
  if (covStats.symbolsWithCoverage === 0) {
    return ' — run `cartograph coverage --mode load --report-path <lcov>`; needed for `cartograph_coverage`';
  }
  const sourceCount = covStats.sources.length;
  const plural = sourceCount === 1 ? '' : 's';
  return ` (${sourceCount} source${plural}: ${covStats.sources.join(', ')})`;
}

function readRolesLens(cg: Cartograph): LensReading {
  const roleCounts = safeCall(() => getRoleCounts(cg.queries));
  if (roleCounts === undefined) return { present: false };
  const roleTotal = Array.from(roleCounts.values()).reduce((a, b) => a + b, 0);
  const state: LensState = roleTotal === 0 ? 'empty' : 'full';
  const action =
    roleTotal === 0
      ? ' — run `cartograph summarize` (classification runs as a side-effect of the summarisation pipeline); needed for `cartograph_role`'
      : '';
  return { present: true, state, line: `**Roles:** ${roleTotal} classified${action}` };
}

function readDirectorySummariesLens(cg: Cartograph): LensReading {
  const dirSummaries = safeCall(() => getAllDirectorySummaries(cg.queries).length);
  if (dirSummaries === undefined) return { present: false };
  const state: LensState = dirSummaries === 0 ? 'empty' : 'full';
  const action =
    dirSummaries === 0 ? ' — needs ≥3 summarised symbols per dir; run `cartograph summarize --directories`' : '';
  return { present: true, state, line: `**Directory summaries:** ${dirSummaries}${action}` };
}

// F-X disclosure (2026-05-11): unresolved_refs counts in the low-five-digit
// range are normal for a healthy index — cross-language stdlib calls,
// framework hooks, and dynamic dispatch sites that the resolver
// intentionally can't pin to a single target. Only surface the line when
// the count crosses a notable threshold so an agent reading status doesn't
// get curious about a non-bug.
//
// Intentionally separate from `DEGENERATE_EDGE_UREF_FLOOR` (the corruption
// detector in `appendDegradedEdges` above). They share a numeric value
// today by coincidence; the disclosures fire on different shapes — this
// one is "the legitimately-external tail is large" (info), the other is
// "every resolved-reference edge is missing AND the table is heavy"
// (corruption). A future tune to one is not a tune to the other.
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

/**
 * Tier-3 (LLM-mediated) feature readiness. Without this block, agents
 * hit empty `cartograph_search({mode: 'semantic'})` / `cartograph_role` / `cartograph_module`
 * results and don't know whether the tool is broken or just unpopulated.
 * Each line answers: "is this feature usable, and if not, what do I run?"
 *
 * Each lens is wrapped individually (via `safeCall` inside) so a
 * missing table from a pre-migration DB on one query doesn't suppress
 * the others.
 *
 * Exported so the CLI `status` direct implementation renders the SAME
 * Feature Readiness section as the MCP tool — see
 * {@link appendInlineHotspots}.
 */
export function appendFeatureReadiness(lines: string[], cg: Cartograph, opts: LensOpts): void {
  const rendered: string[] = [];
  // Total wallclock budget across all lenses. If we cross it, skip the
  // remainder so a single hung lens can't pin the whole status call
  // forever. Per-lens timing is logged via safeCall — once a future
  // user reports a slow status call, the warn log identifies which
  // lens to fix.
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

/**
 * Surface LLM provider routing. Without this an agent has no way to
 * verify split-provider configs (e.g. local Qwen for chat, Sonnet via
 * claude-bridge for ask) without reading config.json out-of-band.
 * Skipped when no LLM is configured.
 */
async function appendLlmProviders(lines: string[], cg: Cartograph): Promise<void> {
  let llmCfg: Awaited<ReturnType<typeof cg.llm.config.getEffectiveLlmConfig>> | undefined;
  try {
    llmCfg = await cg.llm.config.getEffectiveLlmConfig();
  } catch {
    // Config errors aren't this tool's responsibility to surface.
    return;
  }
  if (!llmCfg) {
    // B14: surface the no-LLM state so the agent knows why
    // semantic-search / ask / summarize would fail. The CLI
    // status already does this; bringing parity to MCP.
    lines.push(
      '',
      '### 🤖 LLM providers',
      `- _No LLM configured. Set \`config.llm\` in \`.cartograph/config.json\` (run \`cartograph admin install-models --write-config\` for the recommended stack — llama-server HTTP for every tier — or configure \`provider: "claude-bridge"\` / \`"anthropic-api"\` for Claude). Required for \`cartograph_ask\`, \`cartograph_admin({action: "summarize"})\`, \`cartograph_find({by: "name", mode: "semantic"})\`._`,
    );
    return;
  }

  const llmLines: string[] = [];
  const chatModel = getChatModel(llmCfg);
  const askModel = getAskModel(llmCfg);
  const embModel = getEmbeddingModel(llmCfg);

  const chatLine = formatLlmLine({
    label: 'Summarize model',
    provider: llmCfg.summarizeLlm?.provider,
    model: chatModel,
  });
  if (chatLine) llmLines.push(chatLine);

  // Only render the ask line when it routes somewhere different from
  // summarizeLlm — single-provider configs would otherwise duplicate.
  if (askModel && askModel !== chatModel) {
    const askLine = formatLlmLine({ label: 'Ask model', provider: llmCfg.askLlm?.provider, model: askModel });
    if (askLine) llmLines.push(askLine);
  }

  const embLine = formatLlmLine({ label: 'Embedding model', provider: llmCfg.embeddingLlm?.provider, model: embModel });
  if (embLine) llmLines.push(embLine);

  // Per-tier feature availability — make it explicit which MCP tools
  // each unconfigured tier disables, so a user (or their agent) sees
  // exactly what's lost without grepping the source. We emit this
  // section even when SOME tiers are wired, since partial coverage is
  // the common case (e.g. only embedding configured, no chat tier).
  const featureWarnings = collectMissingTierWarnings({
    summarizeWired: chatModel !== undefined && chatModel.length > 0,
    askWired: askModel !== undefined && askModel.length > 0,
    embeddingWired: embModel !== undefined && embModel.length > 0,
    rerankerWired:
      llmCfg.rerankerLlm != null && typeof llmCfg.rerankerLlm.model === 'string' && llmCfg.rerankerLlm.model.length > 0,
  });
  for (const w of featureWarnings) {
    llmLines.push(w);
  }

  // Hardware-aware tuning summary — shows the auto-detected
  // recommendation per tier + any user override in the config block.
  // Pulled in here so status is the one-stop "what's my LLM stack +
  // is it tuned right?" surface. Same source of truth as
  // `cartograph doctor` + the `cartograph_admin({action: 'llm-tune'})`
  // MCP entry point.
  llmLines.push(...renderTuningSection(llmCfg));

  // Per-tier backend reachability — probe each configured
  // openai-compat endpoint at status time so the calling agent (any
  // agent — Claude Code, Cursor, Windsurf, Codex CLI, opencode)
  // can tell the user "your embed config says :8080 but
  // llama-server isn't responding there RIGHT NOW" without a
  // separate doctor call. Adds ~1s worst-case (parallel HTTP
  // probes with 1.5s timeout). Skipped when no openai-compat tier
  // is configured (claude-bridge / anthropic-api don't ping
  // localhost ports). Distinct endpoints are deduped — a
  // single-Ollama setup (every tier on :11434) probes ONE URL.
  const reachLines = await renderReachabilitySection(llmCfg);
  if (reachLines.length > 0) llmLines.push(...reachLines);

  if (llmLines.length > 0) {
    lines.push('', '### 🤖 LLM providers', ...llmLines);
  }
}

async function renderReachabilitySection(
  llmCfg: NonNullable<Awaited<ReturnType<Cartograph['llm']['config']['getEffectiveLlmConfig']>>>,
): Promise<string[]> {
  const endpoints: Array<{ tier: string; endpoint: string }> = [];
  const collect = (tier: string, block: { provider?: string; endpoint?: string } | null | undefined): void => {
    if (block?.provider === 'openai-compat' && typeof block.endpoint === 'string' && block.endpoint.length > 0) {
      endpoints.push({ tier, endpoint: block.endpoint });
    }
  };
  collect('embed', llmCfg.embeddingLlm);
  collect('chat', llmCfg.summarizeLlm);
  collect('ask', llmCfg.askLlm);
  collect('reranker', llmCfg.rerankerLlm);
  if (endpoints.length === 0) return [];

  // One probe per distinct URL — many configs route every tier at
  // the same endpoint (single-Ollama setups), so dedup before the
  // network round-trip.
  const distinctEndpoints = [...new Set(endpoints.map((e) => e.endpoint))];
  const probes = await Promise.all(
    distinctEndpoints.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const probeUrl = `${url.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`;
        const res = await fetch(probeUrl, { signal: controller.signal });
        return { url, ok: res.ok };
      } catch {
        return { url, ok: false };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const reachMap = new Map<string, boolean>(probes.map((p) => [p.url, p.ok]));

  const out: string[] = ['', '**Backend reachability** _(probed now)_:'];
  for (const { tier, endpoint } of endpoints) {
    const ok = reachMap.get(endpoint) ?? false;
    out.push(
      `- ${ok ? '✓' : '✗'} **${tier}** → \`${endpoint}\` ${ok ? 'reachable' : '**NOT reachable** — start the backend or fix the endpoint URL'}`,
    );
  }
  return out;
}

function renderTuningSection(
  llmCfg: NonNullable<Awaited<ReturnType<Cartograph['llm']['config']['getEffectiveLlmConfig']>>>,
): string[] {
  // Pull effective per-tier concurrency: explicit user override (when
  // the *Llm.concurrency field is set) > hardware-aware default.
  const { describeHardware, recommendedTuning } =
    require('../../installer/hardware-tuning.js') as typeof import('../../installer/hardware-tuning.js');
  const hw = describeHardware();
  const t = recommendedTuning();
  const readConc = (block: { concurrency?: number } | null | undefined): number | null =>
    typeof block?.concurrency === 'number' ? block.concurrency : null;
  const overrides = {
    embed: readConc(llmCfg.embeddingLlm),
    chat: readConc(llmCfg.summarizeLlm),
    ask: readConc(llmCfg.askLlm),
    reranker: readConc(llmCfg.rerankerLlm),
  };
  const fmt = (rec: number, override: number | null): string =>
    override === null ? `${rec} (auto)` : `**${override}** (manual override; auto would be ${rec})`;
  return [
    '',
    `**Tuning** _(detected ${hw}; override per tier via \`cartograph_admin({action: "llm-tune", tier, concurrency})\` or hand-edit \`*Llm.concurrency\` in config.json)_`,
    `- embed:    ${fmt(t.embed.cartographConcurrency, overrides.embed)}`,
    `- chat:     ${fmt(t.chat.cartographConcurrency, overrides.chat)}`,
    `- ask:      ${fmt(t.ask.cartographConcurrency, overrides.ask)}`,
    `- reranker: ${fmt(t.reranker.cartographConcurrency, overrides.reranker)}`,
  ];
}

/** Per-tier × feature-impact mapping. Each tier the user fails to
 *  wire degrades a specific subset of MCP tools / behaviours; status
 *  surfaces the impact in plain terms so the user knows exactly what
 *  they lose by skipping a tier. Source of truth — both `status`
 *  rendering and any future doctor / setup-wizard surface should
 *  reference this constant. */
interface TierImpact {
  /** Display label for the tier ("Summarize chat") shown when warning. */
  readonly label: string;
  /** User-visible features that go away when this tier is unwired. */
  readonly missingDisables: ReadonlyArray<string>;
}

const TIER_FEATURE_IMPACT: Record<'summarize' | 'ask' | 'embedding' | 'reranker', TierImpact> = {
  summarize: {
    label: 'Summarize chat',
    missingDisables: [
      "`cartograph_admin({action: 'summarize'})` — bulk symbol summarisation pass",
      "`cartograph_admin({action: 'classify'})` — LLM role classification (structural fallback still runs)",
      "`cartograph_dead_code({via: 'llm' | 'auto'})` — LLM judge over dead-code candidates (graph-only `via: 'rule'` still works)",
      "`cartograph_find({by: 'name', mode: 'intent'})` — when summaries are absent, intent search falls back to docstrings + test descriptions only",
    ],
  },
  ask: {
    label: 'Ask chat',
    missingDisables: ['`cartograph_ask` — RAG Q&A over the indexed codebase (falls back to `summarizeLlm` if unset)'],
  },
  embedding: {
    label: 'Embedding',
    missingDisables: [
      "`cartograph_find({by: 'name', mode: 'semantic'})` — semantic peer / concept search (falls back to FTS-only via `mode: 'exact'`)",
      "`cartograph_graph({direction: 'similar'})` — embedding-cosine peers",
      "`cartograph_admin({action: 'embed' | 'embed-only'})` — vec0 population",
      "`cartograph_admin({action: 'build-similarity-edges'})` — `similar_to` edge population",
    ],
  },
  reranker: {
    label: 'Reranker',
    missingDisables: [
      'Cross-encoder rescore on semantic search top-K (semantic search still returns cosine top-K, just without the precision boost on disambiguation-heavy queries)',
    ],
  },
};

function collectMissingTierWarnings(opts: {
  summarizeWired: boolean;
  askWired: boolean;
  embeddingWired: boolean;
  rerankerWired: boolean;
}): string[] {
  const out: string[] = [];
  const missing: Array<keyof typeof TIER_FEATURE_IMPACT> = [];
  if (!opts.summarizeWired) missing.push('summarize');
  if (!opts.askWired && opts.summarizeWired) {
    // ask falls back to summarize, so the warning is only "not strictly missing —
    // ask routes through summarizeLlm". Don't show a missing warning.
  } else if (!opts.askWired) {
    missing.push('ask');
  }
  if (!opts.embeddingWired) missing.push('embedding');
  if (!opts.rerankerWired) missing.push('reranker');
  if (missing.length === 0) return out;
  out.push('', '**Feature impact of unwired tiers:**');
  for (const tier of missing) {
    const impact = TIER_FEATURE_IMPACT[tier];
    out.push(`- ✗ **${impact.label}** unwired — these features are unavailable:`);
    for (const f of impact.missingDisables) {
      out.push(`  - ${f}`);
    }
  }
  out.push(
    '',
    '_Run `cartograph_admin({action: "llm-plan"})` to see setup presets; then `cartograph_admin({action: "llm-apply", preset: "<id>"})` to wire any missing tier._',
  );
  return out;
}

/** Render one provider/model pair, omitting any missing parts. Returns null when no model is set. */
interface FormatLlmLineArgs {
  label: string;
  provider: string | undefined;
  model: string | undefined;
}

function formatLlmLine(args: FormatLlmLineArgs): string | null {
  const { label, provider, model } = args;
  if (!model) return null;
  const parts: string[] = [`\`${model}\``];
  if (provider) parts.push(`provider \`${provider}\``);
  return `- **${label}:** ${parts.join(' ')}`;
}

/**
 * Server-level MCP config flags (when set). Lets a sandboxed
 * operator verify the running server actually applied the intended
 * `--no-write-tools` / `--disable-tool` / etc. flags — the *effect*
 * shows up in tools/list and resolved LLM config, but without this
 * readback there's no direct way to confirm the source of the
 * defaults.
 */
function appendServerConfig(lines: string[], ctx: ToolCtx): void {
  const serverLines: string[] = [`- **Profile:** \`${resolveMcpServerProfile(ctx.options.profile)}\``];
  if (ctx.options.disableWriteTools) {
    serverLines.push('- **Write tools:** disabled (`--no-write-tools`)');
  }
  if (ctx.options.disabledTools && ctx.options.disabledTools.size > 0) {
    const list = [...ctx.options.disabledTools].sort((a, b) => a.localeCompare(b)).join(', ');
    serverLines.push(`- **Disabled tools:** ${list}`);
  }
  if (ctx.options.allowStaleDefault) {
    serverLines.push('- **Default `allowStale`:** true (`--allow-stale-default`)');
  }
  if (ctx.options.disableStartupSync) {
    serverLines.push('- **Startup sync:** disabled (`--no-startup-sync`)');
  }
  lines.push('', '### 🔧 Server config', ...serverLines);
}

/** Per-kind node count breakdown — lists every kind that has at least one node.
 *  When 2+ languages contribute to a kind, inline the per-language tally
 *  so polyglot repos don't surprise the agent with seemingly impossible
 *  counts (e.g. "102 class nodes in a pure-Go project" turns out to be
 *  74 cpp + 27 typescript + 1 tsx). */
function appendNodesByKind(lines: string[], stats: ReturnType<Cartograph['stats']['getStats']>, cg: Cartograph): void {
  lines.push('', '### Nodes by Kind:');
  // Build kind → [(lang, count), ...] (already ORDER BY count DESC in SQL).
  const byKindLang = new Map<string, Array<[string, number]>>();
  for (const row of getStatsNodesByKindLanguage(cg.queries)) {
    const list = byKindLang.get(row.kind) ?? [];
    list.push([row.language, row.count]);
    byKindLang.set(row.kind, list);
  }
  for (const [kind, count] of Object.entries(stats.nodesByKind)) {
    if (count <= 0) continue;
    const langs = byKindLang.get(kind);
    if (langs && langs.length > 1) {
      const inline = langs.map(([l, c]) => `${l} ${c}`).join(', ');
      lines.push(`- ${kind}: ${count} (${inline})`);
    } else {
      lines.push(`- ${kind}: ${count}`);
    }
  }
}

/** Per-language file count breakdown. */
function appendLanguages(lines: string[], stats: ReturnType<Cartograph['stats']['getStats']>): void {
  lines.push('', '### Languages:');
  for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
    if (count > 0) {
      lines.push(`- ${lang}: ${count}`);
    }
  }
}

/**
 * List other projects the server already has open. Helpful when an
 * agent is working across a monorepo or several adjacent repos —
 * they can pick a `projectPath` from a known-good list instead of
 * guessing. Path equality is strict-string here; on case-insensitive
 * filesystems a client-supplied projectPath with different
 * capitalisation will be treated as a distinct project, but that
 * mirrors how the server caches them.
 */
function appendOtherProjects(lines: string[], ctx: ToolCtx, projectRoot: string): void {
  const defaultRoot = ctx.defaultCg?.projectRoot ?? null;
  const otherRoots = new Set<string>();
  if (defaultRoot && defaultRoot !== projectRoot) otherRoots.add(defaultRoot);
  for (const cached of ctx.projectCache.values()) {
    const root = cached.projectRoot;
    if (root !== projectRoot) otherRoots.add(root);
  }
  if (otherRoots.size === 0) return;
  lines.push('', '### Other projects this server has open');
  for (const root of otherRoots) lines.push(`- \`${root}\``);
}

export const STATUS_TOOL = defineTool({
  name: 'cartograph_status',
  description:
    'Index status — project root, counts, languages, feature-readiness. Call first when unsure which project the MCP defaults to.\n\n' +
    '`topHotspots: N` / `topBiomarkers: N` fold in top-N rollups (capped at ' +
    MAX_INLINE_TOP_N +
    '). `summaryBreakdown: true` splits Summaries into structural/neighbor-prop/llm + body-floor skips. ' +
    '`verbose: true` enables all three rollups at sensible defaults. ' +
    'Drift banner shows commit-drift and uncommitted-edit signals together; re-extraction-flagged files get a separate 🔵 line.',
  schema: statusSchema,
  handle: handleStatus,
  bypassFreshnessGate: true,
  // Diagnostic surface — must remain reachable when the B4 schema
  // guard is blocking other tools, so the operator can still see the
  // version numbers + project info needed to act on the mismatch.
  bypassSchemaGuard: true,
});
