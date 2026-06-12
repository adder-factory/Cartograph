/**
 * Unified `cartograph_biomarkers` MCP tool — static-analysis findings +
 * Code Health score, dispatched by `mode` to symbol / ranked / stats.
 *
 * STRUCTURAL CAMPAIGN P4 (Zod migration)
 * --------------------------------------
 * A `mode`-discriminator family tool. The schema is a FLAT `z.object`
 * where `mode` is a `z.enum` and every per-mode field is `.optional()`
 * — it mirrors the previous hand-written JSON `inputSchema` (nothing
 * was required there). It is NOT a strict `z.discriminatedUnion`;
 * per-mode validation (e.g. `symbol`/`symbols` mutual exclusion) stays
 * in the handler.
 *
 * `limit` carries a documented bound (`mode='ranked'`, default 30, cap
 * 200) so it migrates to `.int().min(1).max(200)` — out-of-range
 * values are now rejected at the dispatch boundary (locked
 * reject-out-of-range policy). The handler's prior defensive `clampInt`
 * + sub-1 reject + `limitCappedNotice` (P1 / audit-4 additions) are all
 * dead once Zod enforces the bound and have been removed. The
 * score-type thresholds (`minCentrality`, `minMetric`, `maxMetric`) are
 * legitimately fractional so they stay `.number()` without `.int()`.
 */

import { z } from 'zod';
import { projectPathField, batchedSymbols, BATCHED_SYMBOLS_MAX, lowTokensField } from './_common-fields.js';
import {
  getFindingsForNode,
  getFindingsRanked,
  getFindingsStats,
  severityFilterCase,
  countFindingsRanked,
} from '../../db/queries-findings.js';
import { escapeLike } from '../../db/sql-like.js';
import { getMetadata } from '../../db/queries-metadata.js';
import { codeHealthScore } from '../../biomarkers/index.js';
import { BIOMARKER_NAMES } from '../../biomarkers/types.js';
import { areBiomarkersPending } from '../../biomarkers/pending.js';
import { compact } from '../../utils.js';
import { textResult, truncateOutput } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import { defineTool } from './_define-tool.js';
import type { ToolCtx } from './types.js';
import type { RefIdCache } from './_id-cache.js';
import { resolveSymbolToNode, symbolNotFound } from './symbol-resolver.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
export { areBiomarkersPending } from '../../biomarkers/pending.js';

type BiomarkerSeverity = 'info' | 'warning' | 'error';

const fmtSev = (s: BiomarkerSeverity): string => {
  if (s === 'error') return '🔴 error';
  if (s === 'warning') return '🟡 warning';
  return '🔵 info';
};

/** Upper bound on `limit` from agent input on `mode='ranked'`. */
const RANKED_LIMIT_MAX = 200;

/** Default `limit` when caller doesn't pass one. */
const RANKED_LIMIT_DEFAULT = 30;

/**
 * Centrality is the secondary sort key on `mode='ranked'` findings
 * (after severity, before metric — see `getFindingsRanked` in
 * `src/db/queries-findings.ts`). The renderer needs enough decimal
 * places that adjacent rows look distinguishable; otherwise the
 * displayed order is correct but reads as arbitrary.
 *
 * `MIN` is the baseline used when every row has unique centrality at
 * 4 dp (the common case on small / spread distributions).
 *
 * `MAX` is the cap when centralities cluster tightly. Values above
 * 8 dp would widen the column without helping — long-tail leaves
 * routinely sit at 0.0001-ish and the eighth digit is the noise
 * floor of the centrality computation in practice.
 *
 * The adaptive width is picked once per response by
 * `chooseCentralityDecimals`. Closes friction #65.
 */
const CENTRALITY_DECIMALS_MIN = 4;
const CENTRALITY_DECIMALS_MAX = 8;

/**
 * Smallest `toFixed(dp)` where no two adjacent rendered rows tie on
 * centrality. Rows with NULL centrality break the adjacency chain
 * (they render as `—` regardless of dp). When rows truly share the
 * same centrality value the loop falls through to MAX — the SQL
 * order is then driven by `metric DESC` and the column is
 * accurately reporting equality.
 *
 * Exported for direct unit-testing without any DB plumbing.
 *
 * @internal
 */
export function chooseCentralityDecimals(rows: ReadonlyArray<{ centrality: number | null }>): number {
  for (let dp = CENTRALITY_DECIMALS_MIN; dp <= CENTRALITY_DECIMALS_MAX; dp++) {
    let prev: string | null = null;
    let collision = false;
    for (const r of rows) {
      if (r.centrality == null) {
        prev = null;
        continue;
      }
      const s = r.centrality.toFixed(dp);
      if (prev !== null && s === prev) {
        collision = true;
        break;
      }
      prev = s;
    }
    if (!collision) return dp;
  }
  return CENTRALITY_DECIMALS_MAX;
}

/**
 * Render the stored `index_timestamp` metadata (epoch-ms string) as an
 * ISO date — matching `cartograph_status`. Falls back to the raw value
 * when it isn't a finite number, so a malformed metadata row degrades
 * gracefully instead of throwing a RangeError from `toISOString()`.
 *
 * @internal Exported for direct unit-testing. Always call inside an
 * `if (indexedAt)` guard: `Number('')` is `0` (finite), so an empty
 * string would render as the epoch date `1970-01-01T00:00:00.000Z`.
 */
export function formatIndexedAt(raw: string): string {
  const ms = Number(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

/** mode=stats — project-wide biomarker rollup with per-biomarker severity breakdown. */
function handleStatsMode(cg: import('../../index.js').default, format?: 'markdown' | 'json'): ToolOutcome {
  const stats = getFindingsStats(cg.queries);
  if (format === 'json') {
    return ok(textResult(JSON.stringify({ mode: 'stats', ...stats }, null, 2)));
  }
  if (stats.totalFindings === 0) {
    // Affirmative empty result — distinguishes "biomarkers ran and the
    // project is clean" from "biomarkers never ran". Presence of an
    // `indexed_at` timestamp means the index has been built; absent
    // means the project genuinely hasn't been indexed.
    const indexedAt = getMetadata(cg.queries, 'index_timestamp');
    if (indexedAt) {
      // Guard against the "cross-file findings are stale" state — two triggers:
      // (1) the transient-empty window after `index --force` (FK ON DELETE
      // CASCADE wipes code_health_findings; postHook may not have repopulated);
      // (2) steady-state partial syncs that bump `index_timestamp` without
      // re-running cross-file rules. Either way, surface "pending" rather
      // than a misleading "clean" result.
      if (areBiomarkersPending(cg)) {
        return ok(
          textResult(
            `⏳ Cross-file biomarkers are stale for this index generation. Incremental syncs only re-run per-file rules — cross-file findings (god_class, unused_export, duplicate_code, feature_envy, illegal_import, low_coverage) reflect the prior full pass. Run \`cartograph_admin({action: 'index'})\` for a full refresh; alternatively, a \`cartograph_admin({action: 'sync'})\` with no files changed since the last sync also clears it (zero-change syncs take the full-pass branch).`,
          ),
        );
      }
      return ok(
        textResult(
          `Project clean ✓ — 0 biomarker findings across ${BIOMARKER_NAMES.length} detectors (last indexed ${formatIndexedAt(indexedAt)}). If you suspect the analysis didn't run, re-check with \`cartograph_status\` or set \`enableBiomarkers\` in config.`,
        ),
      );
    }
    return ok(
      textResult(
        `No biomarker findings — the project doesn't appear to have been indexed yet. Run \`cartograph_admin({action: 'index'})\` first, or set \`enableBiomarkers\` in config if biomarkers are disabled.`,
      ),
    );
  }
  // Per-biomarker rows include the severity breakdown so the agent
  // doesn't need to fire N follow-up `mode=ranked` queries to learn
  // which categories have actionable warning+ density.
  const biomarkerRows: BiomarkerStatsByBiomarkerRow[] = Object.entries(stats.byBiomarker)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => {
      const sev = stats.byBiomarkerSeverity[name] ?? { info: 0, warning: 0, error: 0 };
      return { name, total, breakdown: formatSeverityBreakdown(sev) };
    });
  const severityRows: BiomarkerStatsBySeverityRow[] = Object.entries(stats.bySeverity)
    .sort((a, b) => b[1] - a[1])
    .map(([severity, count]) => ({ severity, count }));
  // Surface-reason rollup — tells the agent how many findings are
  // partial-rescan-surfaced (potentially edit-induced) vs the steady
  // full-pass / cached state.
  const surface = stats.bySurfaceReason;
  const surfaceRows: BiomarkerStatsBySurfaceRow[] = [
    { surface: 'full-pass', count: surface['full-pass'] },
    { surface: 'partial-rescan', count: surface['partial-rescan'] },
    { surface: 'cached', count: surface.cached },
  ];
  // Freshness footer — same data the clean-state branch above shows,
  // mirrored here so the non-zero case also tells the agent WHEN the
  // underlying findings were computed. Cross-file biomarkers
  // (god_class, unused_export, low_coverage, …) only recompute on a
  // full pass; the indexed-at timestamp is the freshness baseline. If
  // files were edited after this, cross-file rows may be stale until
  // the next `cartograph_admin({action: 'sync'})` re-runs them.
  const indexedAt = getMetadata(cg.queries, 'index_timestamp');
  const freshnessFooter = indexedAt
    ? [
        '',
        `_Indexed at ${formatIndexedAt(indexedAt)} — cross-file rules (god_class / unused_export / low_coverage / feature_envy / illegal_import / duplicate_code) recompute on sync; files edited since may carry stale cross-file rows until the next sync._`,
      ]
    : [];
  return ok(
    textResult(
      [
        '## Code Health rollup',
        '',
        `- **Total findings:** ${stats.totalFindings}`,
        `- **Symbols with findings:** ${stats.nodesWithFindings}`,
        '',
        renderMarkdownTable(buildBiomarkerStatsByBiomarkerSpec(biomarkerRows)),
        '',
        renderMarkdownTable(buildBiomarkerStatsBySeveritySpec(severityRows)),
        '',
        renderMarkdownTable(buildBiomarkerStatsBySurfaceSpec(surfaceRows)),
        ...freshnessFooter,
      ].join('\n'),
    ),
  );
}

/**
 * One row of the `By biomarker` sub-rollup table. Exported alongside
 * {@link buildBiomarkerStatsByBiomarkerSpec} so the wording lint can
 * construct an instance without a real Cartograph.
 *
 * `breakdown` is the pre-formatted `'error: N, warning: N, info: N'`
 * string produced by {@link formatSeverityBreakdown} (empty when all
 * three slots are zero — never displayed in that case).
 */
export interface BiomarkerStatsByBiomarkerRow {
  name: string;
  total: number;
  breakdown: string;
}

/**
 * Build the typed `ResultSpec` for the `### By biomarker` sub-rollup
 * inside `cartograph_biomarkers mode='stats'`. H3 heading-level so
 * the composing handler can render it under the top-level `##` Code
 * Health rollup title. Two-column shape: Biomarker | Count (with
 * embedded severity breakdown). The wording-alignment lint pins the
 * sub-section title to the biomarker rollup vocabulary.
 */
export function buildBiomarkerStatsByBiomarkerSpec(
  rows: ReadonlyArray<BiomarkerStatsByBiomarkerRow>,
): MarkdownTableSpec<BiomarkerStatsByBiomarkerRow> {
  return {
    title: 'By biomarker',
    headingLevel: 3,
    emptyState: '_No biomarker breakdown available._',
    columns: [
      { header: 'Biomarker', cell: (r) => r.name },
      {
        header: 'Count',
        align: 'right',
        cell: (r) => (r.breakdown ? `${r.total} (${r.breakdown})` : String(r.total)),
      },
    ],
    rows,
  };
}

/** One row of the `By severity` sub-rollup table. */
export interface BiomarkerStatsBySeverityRow {
  severity: string;
  count: number;
}

/**
 * Build the `### By severity` sub-rollup spec. H3 heading-level.
 * Two columns — Severity | Count.
 */
export function buildBiomarkerStatsBySeveritySpec(
  rows: ReadonlyArray<BiomarkerStatsBySeverityRow>,
): MarkdownTableSpec<BiomarkerStatsBySeverityRow> {
  return {
    title: 'By severity',
    headingLevel: 3,
    emptyState: '_No severity breakdown available._',
    columns: [
      { header: 'Severity', cell: (r) => r.severity },
      { header: 'Count', align: 'right', cell: (r) => String(r.count) },
    ],
    rows,
  };
}

/** One row of the `By surface reason` sub-rollup table. */
export interface BiomarkerStatsBySurfaceRow {
  surface: string;
  count: number;
}

/**
 * Build the `### By surface reason` sub-rollup spec. H3 heading-level
 * + preamble explaining the three surface categories (full-pass /
 * partial-rescan / cached). Two columns — Surface | Count.
 */
export function buildBiomarkerStatsBySurfaceSpec(
  rows: ReadonlyArray<BiomarkerStatsBySurfaceRow>,
): MarkdownTableSpec<BiomarkerStatsBySurfaceRow> {
  return {
    title: 'By surface reason',
    headingLevel: 3,
    preamble: [
      "Where each finding came from: `full-pass` (last full project scan), `partial-rescan` (per-file rescan triggered by an edit since the last full pass — may surface latent findings), or `cached` (carried over from the last full pass; file content unchanged so rules weren't re-run).",
    ],
    emptyState: '_No surface-reason breakdown available._',
    columns: [
      { header: 'Surface', cell: (r) => r.surface },
      { header: 'Count', align: 'right', cell: (r) => String(r.count) },
    ],
    rows,
  };
}

/** Render the non-zero severity slots as `error: N, warning: N, info: N`. */
function formatSeverityBreakdown(sev: { info: number; warning: number; error: number }): string {
  const parts: string[] = [];
  if (sev.error > 0) parts.push(`error: ${sev.error}`);
  if (sev.warning > 0) parts.push(`warning: ${sev.warning}`);
  if (sev.info > 0) parts.push(`info: ${sev.info}`);
  return parts.join(', ');
}

/** Bundled args for {@link renderSymbolSection}. */
interface RenderSymbolSectionArgs {
  /** The Cartograph instance to query findings from. */
  readonly cg: import('../../index.js').default;
  /** The resolved node id. */
  readonly nodeId: string;
  /** Display label for the rendered section. */
  readonly label: string;
  /** Non-empty when the name resolved only via FTS guess — prepended
   *  so the agent never reads a "Code Health 10/10" for a symbol that
   *  doesn't actually exist under the queried name. */
  readonly fuzzyBanner: string;
}

/** Render findings + health for a single resolved node into lines.
 *  `fuzzyBanner` (non-empty when the name resolved only via FTS guess)
 *  is prepended so the agent never reads a "Code Health 10/10" for a
 *  symbol that doesn't actually exist under the queried name. */
function renderSymbolSection(args: RenderSymbolSectionArgs): string[] {
  const { cg, nodeId, label, fuzzyBanner } = args;
  const banner = fuzzyBanner ? [fuzzyBanner, ''] : [];
  const findings = getFindingsForNode(cg.queries, nodeId);
  if (findings.length === 0) {
    return [...banner, `\`${label}\` has no biomarker findings — Code Health 10/10 for this symbol.`];
  }
  const lines = [
    ...banner,
    `### ${label}`,
    '',
    `- **Code Health:** ${codeHealthScore(findings)}/10`,
    '',
    '| Biomarker | Severity | Metric |',
    '|-----------|----------|-------:|',
  ];
  for (const f of findings) {
    lines.push(`| ${f.biomarker} | ${fmtSev(f.severity)} | ${f.metric} |`);
  }
  return lines;
}

/**
 * mode=symbol batched — findings + Code Health score for up to 20 nodes
 * in one call. Returns one ### section per symbol; non-resolved entries
 * get a graceful "no symbol matched" note instead of a 404.
 */
function handleSymbolModeBatch(
  cg: import('../../index.js').default,
  symbols: string[],
  refIds: RefIdCache | undefined,
): ToolOutcome {
  const sections: string[] = [`## Findings for ${symbols.length} symbols`, ''];
  for (const sym of symbols) {
    const resolved = resolveSymbolToNode(cg, sym, refIds);
    if (resolved === null) {
      sections.push(`### ${sym}`, '', `_no symbol matched "${sym}"_`, '');
    } else {
      sections.push(
        ...renderSymbolSection({ cg, nodeId: resolved.node.id, label: sym, fuzzyBanner: resolved.fuzzyBanner }),
        '',
      );
    }
  }
  return ok(textResult(truncateOutput(sections.join('\n'))));
}

/**
 * mode=symbol — findings + Code Health score for one node. Resolves
 * the `symbol` arg by node id first, then falls back to FTS search.
 * Rejects inputs containing punctuation never in real identifiers
 * — the FTS fallback tokenises on those, so `"; DROP TABLE nodes; --`
 * would otherwise match a node literally named `node` and mis-report
 * health 10/10 for an unrelated symbol.
 */
function handleSymbolMode(
  cg: import('../../index.js').default,
  symbol: string,
  refIds: RefIdCache | undefined,
): ToolOutcome {
  const resolved = resolveSymbolToNode(cg, symbol, refIds);
  // A missing symbol is an error, not a normal result — return the
  // typed `err` arm so the CLI exits non-zero on a typo'd / stale name.
  if (!resolved) return err(symbolNotFound(cg, symbol));
  const nodeId = resolved.node.id;
  const bannerPrefix = resolved.fuzzyBanner ? `${resolved.fuzzyBanner}\n\n` : '';
  const findings = getFindingsForNode(cg.queries, nodeId);
  if (findings.length === 0) {
    return ok(
      textResult(`${bannerPrefix}\`${symbol}\` has no biomarker findings — Code Health 10/10 for this symbol.`),
    );
  }
  const lines = [
    `${bannerPrefix}## Findings for \`${symbol}\``,
    '',
    `- **Code Health:** ${codeHealthScore(findings)}/10`,
    '',
    '| Biomarker | Severity | Metric |',
    '|-----------|----------|-------:|',
  ];
  for (const f of findings) {
    lines.push(`| ${f.biomarker} | ${fmtSev(f.severity)} | ${f.metric} |`);
  }
  return ok(textResult(truncateOutput(lines.join('\n'))));
}

interface RankedModeArgs {
  limit?: number | undefined;
  biomarker?: string | undefined;
  minSeverity?: BiomarkerSeverity | undefined;
  minCentrality?: number | undefined;
  minMetric?: number | undefined;
  maxMetric?: number | undefined;
  excludeFile?: string | undefined;
  lowTokens?: boolean | undefined;
  format?: 'markdown' | 'json' | undefined;
}

/**
 * JSON arm of mode=ranked (field report #2 items 10/11). Handles the
 * zero-row case itself — a machine consumer must get the same shape
 * for an empty result (reviewer catch: the markdown empty-hint broke
 * the format contract), with the honest counts still present (every
 * finding can be orphaned while `shown` is 0); the hint that the
 * markdown empty state renders rides along as `hint`.
 */
function renderRankedJson(
  cg: import('../../index.js').default,
  rows: ReturnType<typeof getFindingsRanked>,
  f: {
    biomarker: string | undefined;
    minSeverity: BiomarkerSeverity;
    minCentrality: number | undefined;
    minMetric: number | undefined;
    maxMetric: number | undefined;
    excludeFile: string | undefined;
    limit: number;
  },
): ToolOutcome {
  const { biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile, limit } = f;
  const counts = countFindingsRanked(
    cg.queries,
    compact({ biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile }),
  );
  const hint =
    rows.length === 0
      ? buildEmptyRankedHint(cg, { biomarker, minSeverity, minMetric, maxMetric, excludeFile, minCentrality })
      : undefined;
  return ok(
    textResult(
      JSON.stringify(
        {
          mode: 'ranked',
          filters: compact({ biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile, limit }),
          shown: rows.length,
          total: counts.total,
          orphaned: counts.orphaned,
          ...(hint === undefined ? {} : { hint }),
          findings: rows.map((r) => ({
            nodeId: r.nodeId,
            name: r.name,
            kind: r.kind,
            filePath: r.filePath,
            biomarker: r.biomarker,
            severity: r.severity,
            metric: r.metric,
            centrality: r.centrality,
            surfaceReason: r.surfaceReason,
            detail: r.detail,
          })),
        },
        null,
        2,
      ),
    ),
  );
}

/**
 * mode=ranked — worst-severity-first findings across the project,
 * optionally filtered by biomarker / minSeverity / minCentrality.
 * Centrality is NULL until the centrality hook runs; warn the user
 * when a `minCentrality` filter would silently match nothing for
 * that reason.
 *
 * `limit` is `.int().min(1).max(200)` in the schema — Zod rejects
 * anything out of range at the dispatch boundary, so no defensive
 * clamp / sub-1 reject / cap notice is needed here.
 */
function handleRankedMode(cg: import('../../index.js').default, args: RankedModeArgs): ToolOutcome {
  const limit = args.limit ?? RANKED_LIMIT_DEFAULT;
  const biomarker = args.biomarker;
  const minSeverity = args.minSeverity ?? 'warning';
  const minCentrality = args.minCentrality;
  const minMetric = args.minMetric;
  const maxMetric = args.maxMetric;
  const excludeFile = args.excludeFile;
  const rows = getFindingsRanked(
    cg.queries,
    compact({ biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile, limit }),
  );
  if (args.format === 'json') {
    return renderRankedJson(cg, rows, { biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile, limit });
  }
  if (rows.length === 0) {
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: buildEmptyRankedHint(cg, {
            biomarker,
            minSeverity,
            minMetric,
            maxMetric,
            excludeFile,
            minCentrality,
          }),
        },
      }),
    );
  }
  const lines = renderRankedFindingsTable(rows, { biomarker, minSeverity, lowTokens: args.lowTokens === true });
  // Honesty footer (field report #2): exact totals under the SAME
  // filters, including findings whose node id no longer resolves —
  // ranked INNER JOINs nodes, so stale ids silently vanished while
  // `stats` counted them, and the mismatch read as a bug. Note: under
  // a minCentrality filter, error-severity orphans still count in the
  // total (the error-tier centrality bypass applies in the LEFT JOIN
  // too) — they surface in the `orphaned` part of the footer.
  const counts = countFindingsRanked(
    cg.queries,
    compact({ biomarker, minSeverity, minCentrality, minMetric, maxMetric, excludeFile }),
  );
  const notShown = Math.max(0, counts.total - rows.length);
  const footerParts: string[] = [];
  if (notShown > 0) {
    const beyondLimit = notShown - counts.orphaned;
    if (beyondLimit > 0) footerParts.push(`${beyondLimit} beyond the limit — pass a higher \`limit\``);
    if (counts.orphaned > 0) {
      footerParts.push(
        `${counts.orphaned} attached to symbol ids that no longer resolve — run \`cartograph_admin({action: 'biomarkers-refresh'})\` to re-attach them`,
      );
    }
  }
  // The chokepoint truncates the table BODY first, then appends the
  // cap footer — so a wide findings table can't push the "pass a
  // higher limit" hint off the budget (the audit-4 biomarkers bug).
  return ok(
    renderToolResponse({
      body: lines.join('\n'),
      footers: [notShown > 0 ? `> ${notShown} finding(s) not shown: ${footerParts.join('; ')}.` : undefined],
    }),
  );
}

/**
 * Probe the joined findings/nodes table for the lowest centrality among
 * findings that survive the user's other filters. Lets the empty-hint
 * distinguish "filter was set too high" (most common — findings DO
 * exist below the threshold) from "centrality genuinely NULL" (rare —
 * the centrality hook hasn't run). Returns `null` when no rows have a
 * non-null centrality under the other filters.
 *
 * Mirrors the WHERE clause shape from `buildFindingsRankedWhere` so the
 * probe answers "what's the lowest centrality among findings the
 * caller would have seen WITHOUT the minCentrality clamp?". Keeps the
 * SQL inlined here (rather than threading through queries-findings.ts)
 * because the probe is purely diagnostic for the empty-result path —
 * shared queries are off-limits for this fix and the cost is one
 * indexed scan.
 */
interface MinCentralityProbeArgs {
  biomarker: string | undefined;
  minSeverity: BiomarkerSeverity;
  minMetric: number | undefined;
  maxMetric: number | undefined;
  excludeFile: string | undefined;
}

function probeLowestCentralityForFilters(
  cg: import('../../index.js').default,
  args: MinCentralityProbeArgs,
): { lowest: number | null; matchCount: number } {
  const where: string[] = ['n.centrality IS NOT NULL'];
  const params: Record<string, unknown> = {};
  if (args.biomarker !== undefined) {
    where.push('f.biomarker = @biomarker');
    params['biomarker'] = args.biomarker;
  }
  where.push(`${severityFilterCase('f.severity')} >= ${severityFilterCase('@minSev')}`);
  params['minSev'] = args.minSeverity;
  if (args.minMetric !== undefined) {
    where.push('f.metric >= @minMetric');
    params['minMetric'] = args.minMetric;
  }
  if (args.maxMetric !== undefined) {
    where.push('f.metric <= @maxMetric');
    params['maxMetric'] = args.maxMetric;
  }
  if (args.excludeFile !== undefined && args.excludeFile.length > 0) {
    where.push(String.raw`n.file_path NOT LIKE @excludeLike ESCAPE '\'`);
    params['excludeLike'] = `${escapeLike(args.excludeFile)}%`;
  }
  const whereClause = where.join(' AND ');
  const sql = `
    SELECT MIN(n.centrality) AS lowest, COUNT(*) AS matchCount
    FROM code_health_findings f
    JOIN nodes n ON n.id = f.node_id
    WHERE ${whereClause}
  `;
  try {
    const row = cg.db.getDb().prepare(sql).get(params) as { lowest: number | null; matchCount: number };
    return { lowest: row.lowest, matchCount: row.matchCount };
  } catch {
    return { lowest: null, matchCount: 0 };
  }
}

/**
 * Build the "no findings match" hint string. Splits the
 * `minCentrality`-set case into the two failure modes (most common:
 * findings exist below the threshold; rare: centrality NULL) so the
 * agent's next action is "lower the threshold" instead of the
 * misdirected "re-run index". See friction F-D.
 *
 * @internal — exported for direct unit-testing without firing a
 * full handler call.
 */
function buildEmptyRankedHint(
  cg: import('../../index.js').default,
  args: MinCentralityProbeArgs & { minCentrality: number | undefined },
): string {
  const stats = getFindingsStats(cg.queries);
  // Affirmative empty result on a clean baseline — no filters narrowed
  // a non-empty set; there genuinely aren't any findings to surface.
  if (stats.totalFindings === 0) {
    const indexedAt = getMetadata(cg.queries, 'index_timestamp');
    if (indexedAt) {
      // Guard against the cross-file-stale state (see handleStatsMode for the full rationale).
      if (areBiomarkersPending(cg)) {
        return `⏳ Cross-file biomarkers are stale for this index generation. Run \`cartograph_admin({action: 'index'})\` for a full refresh — incremental syncs skip cross-file rules by design.`;
      }
      return `Project clean ✓ — 0 biomarker findings across ${BIOMARKER_NAMES.length} detectors (last indexed ${formatIndexedAt(indexedAt)}). Use \`mode: 'stats'\` for the per-biomarker rollup.`;
    }
    return "No biomarker findings — the project doesn't appear to have been indexed yet. Run `cartograph_admin({action: 'index'})` first.";
  }

  const hints = buildEmptyRankedHints(cg, args);
  hints.push('Drop minSeverity to "info" or lower other filters to see info-tier findings.');
  return `No findings match those filters (${stats.totalFindings} total findings exist project-wide).\n\n- ${hints.join('\n- ')}`;
}

function buildEmptyRankedHints(
  cg: import('../../index.js').default,
  args: MinCentralityProbeArgs & { minCentrality: number | undefined },
): string[] {
  if (args.minCentrality === undefined) return [];
  const probe = probeLowestCentralityForFilters(cg, args);
  if (probe.lowest === null || probe.matchCount === 0) {
    return [
      'A `minCentrality` filter was set, but findings exist that have no centrality computed yet. Try without `minCentrality` or run a fresh `cartograph index` so the centrality hook fires.',
    ];
  }
  const lowestFixed = probe.lowest.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
  return [
    `${probe.matchCount} finding${probe.matchCount === 1 ? '' : 's'} exist${probe.matchCount === 1 ? 's' : ''} with centrality < ${args.minCentrality} — pass \`minCentrality=${lowestFixed}\` (lowest observed) or omit \`minCentrality\` entirely to see them.`,
  ];
}

/**
 * Render the ranked-findings markdown table. When `biomarker` is set every row
 * shares that kind, so the redundant column is dropped from the table and
 * surfaced in the header instead.
 *
 * Every row carries a `Surface` cell with the `surfaceReason` — one of
 * `full-pass`, `partial-rescan`, `cached`. The legend above the table
 * explains the difference; `partial-rescan` rows are findings that
 * came from a per-file rescan since the last full pass (potentially
 * latent until the edit re-exposed them).
 */
function renderRankedFindingsTable(
  rows: ReadonlyArray<{
    name: string;
    kind: string;
    filePath: string;
    biomarker: string;
    severity: BiomarkerSeverity;
    metric: number;
    centrality: number | null;
    surfaceReason: 'full-pass' | 'partial-rescan' | 'cached';
  }>,
  opts: { biomarker: string | undefined; minSeverity: BiomarkerSeverity; lowTokens?: boolean },
): string[] {
  const { biomarker, minSeverity, lowTokens = false } = opts;
  if (lowTokens) {
    // Compact pipe rows — no markdown table or multi-paragraph preamble.
    // Columns: name|kind|biomarker|severity|metric|centrality|path
    const biomarkerTag = biomarker ? ` [${biomarker}]` : '';
    const out = [`# code-health ranked (${minSeverity}+, top ${rows.length})${biomarkerTag}`];
    const dp = chooseCentralityDecimals(rows);
    for (const r of rows) {
      const cen = r.centrality == null ? '-' : r.centrality.toFixed(dp);
      out.push(`${r.name}|${r.kind}|${r.biomarker}|${r.severity}|${r.metric}|${cen}|${r.filePath}`);
    }
    return out;
  }
  const headerNote = biomarker ? ` — \`${biomarker}\` only` : '';
  const tableHeader = biomarker
    ? '| # | Symbol | Kind | File | Severity | Metric | Centrality | Surface |'
    : '| # | Symbol | Kind | File | Biomarker | Severity | Metric | Centrality | Surface |';
  const tableSep = biomarker
    ? '|---|--------|------|------|----------|-------:|-----------:|---------|'
    : '|---|--------|------|------|-----------|----------|-------:|-----------:|---------|';
  const centralityDp = chooseCentralityDecimals(rows);
  const lines: string[] = [
    `## Code Health findings — ${minSeverity}+ severity (top ${rows.length})${headerNote}`,
    '',
    'Worst-severity first. The agent angle: pair this with `cartograph_graph({direction: "callers"})` on a flagged symbol to gauge how much code touches the unhealthy region before deciding whether to refactor it.',
    '',
    'Why ranked here: rows are ordered by severity, detector metric, and centrality. Use `minSeverity`, `biomarker`, `minMetric`/`maxMetric`, or `minCentrality` to slice the signal.',
    '',
    'Surface column: `full-pass` = re-evaluated by the last full project scan; `partial-rescan` = surfaced by a per-file rescan triggered by an edit since the last full pass (may be latent findings the edit re-exposed); `cached` = carried over from the last full pass, not re-evaluated this pass (file content unchanged).',
    '',
    tableHeader,
    tableSep,
  ];
  rows.forEach((r, i) => {
    const biomarkerCell = biomarker ? '' : ` ${r.biomarker} |`;
    lines.push(
      `| ${i + 1} | \`${r.name}\` | ${r.kind} | \`${r.filePath}\` |${biomarkerCell} ${fmtSev(r.severity)} | ${r.metric} | ${r.centrality == null ? '—' : r.centrality.toFixed(centralityDp)} | ${r.surfaceReason} |`,
    );
  });
  return lines;
}

/**
 * Flat Zod schema for `cartograph_biomarkers`. `mode` selects the
 * branch; every per-mode field is optional (matches the legacy JSON
 * schema). `limit` carries the documented [1, 200] integer bound so
 * Zod rejects out-of-range values; the score-type thresholds are
 * fractional so they omit `.int()`.
 */
const biomarkersSchema = z.object({
  mode: z
    .enum(['symbol', 'ranked', 'stats'])
    .optional()
    .describe(
      "Query mode (default 'ranked'). 'symbol': findings on one node; 'ranked': worst-severity-first across the project; 'stats': project-wide rollup with per-biomarker counts.",
    ),
  symbol: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("For mode='symbol': node id, qualified name, or plain name. Mutually exclusive with `symbols`."),
  symbols: batchedSymbols
    .optional()
    .describe(
      `For mode='symbol': up to ${BATCHED_SYMBOLS_MAX} symbols at once; returns findings + Code Health grouped by symbol. Mutually exclusive with \`symbol\`. Over-cap inputs are rejected, not truncated.`,
    ),
  biomarker: z
    .enum(BIOMARKER_NAMES as unknown as [string, ...string[]])
    .optional()
    .describe(
      "For mode='ranked': filter by biomarker (default: any). Cross-file biomarkers (unused_export, god_class, feature_envy) only fire on a full project pass.",
    ),
  minSeverity: z
    .enum(['info', 'warning', 'error'])
    .optional()
    .describe("For mode='ranked': only findings of this severity or worse (default 'warning')."),
  format: z
    .enum(['markdown', 'json'])
    .optional()
    .describe(
      "Output format for mode='ranked'/'stats' (default 'markdown'). 'json' returns machine-readable rows including each finding's `detail` payload plus the not-shown counts — parse this instead of the markdown table or the DB schema.",
    ),
  minCentrality: z
    .number()
    .min(0)
    .optional()
    .describe(
      "For mode='ranked': only nodes with centrality >= this. Killer query: `minSeverity: 'warning', minCentrality: 0.001` surfaces high-impact code with structural problems.",
    ),
  minMetric: z
    .number()
    .optional()
    .describe(
      "For mode='ranked': only findings with metric >= this. Slices the noise floor — e.g. `biomarker: 'complex_method', minMetric: 15`.",
    ),
  maxMetric: z
    .number()
    .optional()
    .describe(
      "For mode='ranked': only findings with metric <= this. Pair with `minMetric` to slice a band — e.g. `minMetric: 50, maxMetric: 100`.",
    ),
  excludeFile: z
    .string()
    .optional()
    .describe(
      "For mode='ranked' only: drop findings whose file_path starts with this literal prefix (e.g. `src/legacy/` for a directory, `src/foo.ts` for one file).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RANKED_LIMIT_MAX)
    .optional()
    .describe(
      `For mode='ranked': max rows (default ${RANKED_LIMIT_DEFAULT}; integer in [1, ${RANKED_LIMIT_MAX}], out-of-range rejected).`,
    ),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type BiomarkersArgs = z.infer<typeof biomarkersSchema>;

async function handleBiomarkers(ctx: ToolCtx, args: BiomarkersArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const mode = args.mode ?? 'ranked';
  if (mode === 'symbol') {
    const hasSingle = args.symbol != null;
    const hasBatch = Array.isArray(args.symbols);
    if (hasSingle && hasBatch) {
      return err('Pass either `symbol` or `symbols`, not both.');
    }
    if (hasBatch) {
      const capped = (args.symbols ?? []).slice(0, 20);
      return handleSymbolModeBatch(cg, capped, ctx.refIds);
    }
    if (!hasSingle) {
      return err(
        "biomarkers mode='symbol' requires `symbol` (a node id, qualified name, or plain name) or `symbols: [...]`.",
      );
    }
    return handleSymbolMode(cg, args.symbol!, ctx.refIds);
  }
  if (mode === 'stats') return handleStatsMode(cg, args.format);
  // mode === 'ranked' (also the default). The parsed args already
  // carry exactly the `RankedModeArgs` optional shape.
  return handleRankedMode(cg, args);
}

export const BIOMARKERS_TOOL = defineTool({
  name: 'cartograph_biomarkers',
  description:
    'Static-analysis findings + Code Health score (1-10) — "is this risky to change?" before editing.\n\n' +
    'Modes: `symbol` (one or `symbols: [...]` up to 20) | `ranked` (worst-first; filter by biomarker/severity/centrality/metric range) | `stats`. ' +
    `${BIOMARKER_NAMES.length} detectors; cross-file ones (god_class, unused_export, feature_envy, illegal_import, low_coverage, duplicate_code) only refresh on a full \`index\`/\`sync\`. ` +
    "Killer pre-refactor query: `minSeverity: 'warning', minCentrality: 0.001`.",
  schema: biomarkersSchema,
  handle: handleBiomarkers,
});
