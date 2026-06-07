import * as fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { isHnswAvailable } from '../../embeddings/hnsw-index.js';
import { getStaleArtifactsCount } from '../../db/queries-metadata.js';
import { getStatsNodesByKindLanguage } from '../../db/queries.js';
import { getParseCacheStats } from '../../db/queries-parse-cache.js';
import { classifyChangedFiles, realModifiedCount, type ChangedFiles } from '../../changed-files-classify.js';
import { shortSha } from '../../git-utils.js';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { detectModuleFormat, formatModuleFormatLine } from '../../module-format.js';
import type Cartograph from '../../index.js';
import { contentDriftCount, hasFreshnessRisk } from '../../freshness.js';
import { DEGENERATE_EDGE_UREF_FLOOR } from '../../resolution/types.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { resolveMcpServerProfile } from '../profiles.js';
import { appendLlmProviders } from './status-llm.js';
import { STATUS_MAX_INLINE_TOP_N, resolveStatusRollups } from '../../features/status/rollup-options.js';
import { appendFeatureReadiness, appendInlineBiomarkers, appendInlineHotspots } from '../../features/status/rollups.js';
export {
  parseInlineTopN,
  resolveStatusRollups,
  type ResolvedStatusRollups,
  type StatusRollupInput,
} from '../../features/status/rollup-options.js';
export {
  STATUS_BIOMARKERS_CLEAN_NOTE,
  STATUS_BIOMARKERS_PENDING_NOTE,
  appendFeatureReadiness,
  appendInlineBiomarkers,
  appendInlineHotspots,
  buildStatusInlineBiomarkersSpec,
  buildStatusInlineHotspotsSpec,
} from '../../features/status/rollups.js';
export type { BuildStatusInlineBiomarkersSpecArgs, LensOpts } from '../../features/status/rollups.js';

// NOTE: `getToolModules` from './registry.js' is imported DYNAMICALLY
// inside `appendToolRegistryDrift` — a static import here creates a
// load-order cycle (registry.ts statically imports STATUS_TOOL from
// this file). See the comment on that function.

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
      `Inline the top-N hotspots (by risk = centrality × churn). Default 0 (suppressed); values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}.`,
    ),
  topBiomarkers: z
    .number()
    .optional()
    .describe(
      `Inline the top-N biomarker findings (warning+ severity, worst-first). Default 0 (suppressed); values ≥ 1 capped at ${STATUS_MAX_INLINE_TOP_N}. ` +
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
  appendFeatureReadiness(lines, cg, { summaryBreakdown, surface: 'mcp' });
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

/** Surface the active storage backend for this project. */
function appendBackendStatus(lines: string[], cg: Cartograph, hnswAvailable: boolean): void {
  const backend = cg.db.getBackend();
  if (backend === 'postgres') {
    lines.push(
      '**Backend:** postgres',
      '  ℹ PostgreSQL storage active — native GIN/pgvector paths are used when available.',
    );
    return;
  }
  const vec = cg.db.hasVecExtension();
  const vecSuffix = vec ? ' + sqlite-vec (indexed similarity) ✅' : ' ⚠ no sqlite-vec';
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

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
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

/**
 * Server-level MCP config flags (when set). Lets a sandboxed
 * operator verify the running server actually applied the intended
 * `--no-write-tools` / `--disable-tool` / etc. flags — the *effect*
 * shows up in tools/list and resolved LLM config, but without this
 * readback there's no direct way to confirm the source of the
 * defaults.
 */
function appendServerConfig(lines: string[], ctx: ToolCtx): void {
  const profile = resolveMcpServerProfile(ctx.options.profile);
  const serverLines: string[] = [`- **Profile:** \`${profile}\``];
  if (ctx.options.disableWriteTools) {
    serverLines.push('- **Write tools:** disabled (`--no-write-tools`)');
  } else if (profile === 'read-only') {
    serverLines.push('- **Write tools:** disabled (`profile: read-only`)');
  }
  if (ctx.options.disabledTools && ctx.options.disabledTools.size > 0) {
    const list = [...ctx.options.disabledTools].sort((a, b) => a.localeCompare(b)).join(', ');
    serverLines.push(`- **Disabled tools:** ${list}`);
  }
  if (ctx.options.allowStaleDefault) {
    serverLines.push('- **Default `allowStale`:** true (`--allow-stale-default`)');
  }
  if (ctx.options.lowTokensDefault) {
    serverLines.push('- **Default `lowTokens`:** true (`--low-tokens-default`)');
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
    STATUS_MAX_INLINE_TOP_N +
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
