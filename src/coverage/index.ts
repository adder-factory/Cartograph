/**
 * Coverage ingestion orchestrator. Parses an external CI report
 * (lcov today; cobertura/jacoco TBD), maps each report file onto
 * an indexed file in the graph, then rolls coverage up into each
 * symbol's [start_line, end_line] span and upserts into
 * `node_coverage`.
 *
 * Path matching is two-tier: exact match against the indexed path
 * first, then longest-suffix match for monorepo cases where the
 * report's path includes a workspace prefix the project doesn't
 * (e.g. report says `packages/api/src/foo.ts`, indexed path is
 * `src/foo.ts`).
 */

import { readFile } from 'node:fs/promises';
import * as path from 'path';
import type { QueryBuilder } from '../db/queries.js';
import { qbTransaction } from '../db/queries.js';
import { clearCoverageSource, upsertNodeCoverage } from '../db/queries-coverage.js';
import { getAllFilePaths } from '../db/queries-files.js';
import { appendFindings, clearFindingsByKind } from '../db/queries-findings.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { findLowCoverage } from '../biomarkers/low-coverage.js';
import { logDebug } from '../errors.js';
import { parseLcov, summariseSpan } from './lcov.js';

export interface IngestResult {
  /** Files in the report that mapped onto an indexed file. */
  filesMatched: number;
  /** Files in the report with no indexed counterpart. */
  filesUnmatched: number;
  /** Symbols that received a `node_coverage` row this run (rendered as
   *  "Symbols with coverage" in CLI/MCP output). Excludes
   *  no-overlap symbols — those land in `symbolsEmpty`. */
  symbolsUpdated: number;
  /** Symbols whose span had no executable lines in the report and were
   *  SKIPPED rather than written as 0/0 rows (rendered as
   *  "Symbols skipped (no overlap)" in CLI/MCP output). Common causes:
   *  top-level statements, class-body initialisers, closures inside
   *  other functions — the lcov line ranges miss the symbol's body. */
  symbolsEmpty: number;
  /** Wall-clock duration of the ingestion in milliseconds. */
  durationMs: number;
}

interface IngestOptions {
  format?: 'lcov';
  /** Source key written into `node_coverage.source`. Defaults to `'lcov'`. */
  source?: string;
  /** Drop every existing row for this source before ingesting. */
  clearSource?: boolean;
}

interface IngestCoverageArgs {
  queries: QueryBuilder;
  /** Project root path. Accepted for forward compatibility (absolute-path
   *  relativisation in cobertura/jacoco reports). Unused by the lcov
   *  path because suffix-match already handles longer report paths. */
  projectRoot: string;
  reportPath: string;
  options?: IngestOptions;
}

interface IngestTotals {
  filesMatched: number;
  filesUnmatched: number;
  symbolsUpdated: number;
  symbolsEmpty: number;
}

interface IngestCtx {
  queries: QueryBuilder;
  source: string;
  ingestedAt: number;
  totals: IngestTotals;
}

function applyFileCoverage(ctx: IngestCtx, fc: import('./lcov.js').FileCoverage, matchedPath: string): void {
  const nodes = ctx.queries.getNodesByFile(matchedPath);
  for (const node of nodes) {
    const startLine = node.startLine;
    const endLine = node.endLine;
    if (!startLine || !endLine) continue;
    const span = summariseSpan(fc, startLine, endLine);
    // Invariant: never write a `node_coverage` row whose denominator
    // is zero. Lcov reports executable lines, but many indexed symbols
    // (top-level statements, class-body initialiser blocks, arrow
    // functions assigned to constants, closures-inside-closures) have
    // bodies whose [start_line, end_line] span contains no
    // intersecting `DA:` records. Writing a 0/0 row contributes
    // nothing to weighted-coverage rollups, ranking queries, or
    // `low_coverage` biomarker — and bloats the table with rows that
    // can't be divided by (NULLIF(total_lines, 0) returns NULL → row
    // dropped from ranked output anyway). Skip-and-count is cleaner
    // than write-and-ignore.
    if (span.totalLines === 0) {
      ctx.totals.symbolsEmpty += 1;
      continue;
    }
    upsertNodeCoverage(ctx.queries, {
      nodeId: node.id,
      source: ctx.source,
      coveredLines: span.coveredLines,
      totalLines: span.totalLines,
      coveredBranches: span.totalBranches > 0 ? span.coveredBranches : null,
      totalBranches: span.totalBranches > 0 ? span.totalBranches : null,
      ingestedAt: ctx.ingestedAt,
    });
    ctx.totals.symbolsUpdated += 1;
  }
}

export async function ingestCoverage(args: IngestCoverageArgs): Promise<IngestResult> {
  const { queries, reportPath } = args;
  const options: IngestOptions = args.options ?? {};
  const start = Date.now();
  const source = options.source ?? 'lcov';

  if (options.clearSource) clearCoverageSource(queries, source);

  const body = await readFile(reportPath, 'utf8');
  const fileCoverages = parseLcov(body);
  const indexedPaths = getAllFilePaths(queries).map(normalisePath);
  const indexedSet = new Set(indexedPaths);

  const totals: IngestTotals = { filesMatched: 0, filesUnmatched: 0, symbolsUpdated: 0, symbolsEmpty: 0 };
  const ctx: IngestCtx = { queries, source, ingestedAt: Date.now(), totals };

  for (const fc of fileCoverages) {
    const matchedPath = matchIndexedPath(normalisePath(fc.filePath), indexedSet, indexedPaths);
    if (!matchedPath) {
      totals.filesUnmatched += 1;
      continue;
    }
    totals.filesMatched += 1;
    applyFileCoverage(ctx, fc, matchedPath);
  }

  // The `low_coverage` cross-file biomarker is silent until coverage
  // rows exist, and the biomarker pass that owns it only re-runs on
  // index/sync — so without this refresh, `cartograph_biomarkers
  // ({mode: 'stats'})` keeps reporting the pre-coverage rollup until
  // the next edit triggers a sync. Coverage is the SOLE upstream for
  // this rule, so re-running just this rule here (rather than the
  // whole biomarker pass) keeps stats consistent with what
  // `cartograph_review({mode: 'risk'})` reads from `node_coverage`.
  refreshLowCoverageFindings(queries);

  // Record where this report came from so the coverage-reapply index
  // hook can re-derive `node_coverage` after a later sync re-extracts
  // files (re-extraction mints new node ids; the old nodes' coverage
  // rows cascade-delete, so without this the data silently erodes).
  persistReportPath({ queries, projectRoot: args.projectRoot, source, reportPath });

  return { ...totals, durationMs: Date.now() - start };
}

/** Args bundle for {@link persistReportPath}. */
interface PersistReportPathArgs {
  queries: QueryBuilder;
  projectRoot: string;
  source: string;
  reportPath: string;
}

/**
 * Record the absolute report path under the `coverage_report_paths`
 * metadata key — a `{ [source]: absPath }` JSON map keyed by source
 * label, so multiple coverage sources (unit / e2e) each survive.
 * Best-effort: a failure here must never fail the ingest itself.
 */
function persistReportPath(args: PersistReportPathArgs): void {
  const { queries, projectRoot, source, reportPath } = args;
  try {
    const abs = path.isAbsolute(reportPath) ? reportPath : path.resolve(projectRoot, reportPath);
    const raw = getMetadata(queries, 'coverage_report_paths');
    let map: Record<string, string> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>;
      } catch {
        // Corrupt value — overwrite with a fresh single-entry map.
      }
    }
    map[source] = abs;
    setMetadata(queries, 'coverage_report_paths', JSON.stringify(map));
  } catch (err) {
    logDebug('Coverage: persistReportPath failed', { err: String(err) });
  }
}

/**
 * Read back the `{ [source]: absPath }` map persisted by
 * {@link persistReportPath}. Returns an empty map when coverage has
 * never been loaded or the stored value is unreadable.
 */
export function getCoverageReportPaths(queries: QueryBuilder): Record<string, string> {
  const raw = getMetadata(queries, 'coverage_report_paths');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // fall through
  }
  return {};
}

/**
 * Re-run the `low_coverage` cross-file biomarker rule against the
 * just-updated `node_coverage` rows and rewrite its findings in
 * `code_health_findings`. Mirrors the clear-then-append shape used by
 * `runCrossFileRule` in `src/biomarkers/index.ts` so stats and ranked
 * output see a consistent view.
 *
 * `passKind` is intentionally `'full-pass'` because this re-evaluates
 * the rule over the entire `node_coverage` table (not a per-file
 * delta) — same semantics as the rule running inside an `indexAll`.
 */
function refreshLowCoverageFindings(queries: QueryBuilder): void {
  try {
    const findings = findLowCoverage(queries);
    qbTransaction(queries, () => {
      clearFindingsByKind(queries, 'low_coverage');
      appendFindings(queries, findings, 'full-pass');
    });
  } catch (err) {
    logDebug('Coverage: low_coverage refresh failed', { err: String(err) });
  }
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a report path to one of the indexed paths. Exact match
 * wins; otherwise the longest indexed path that the report path
 * ends with (preceded by `/`) wins. Returns `null` when nothing
 * matches.
 */
function matchIndexedPath(
  reportPath: string,
  indexedSet: ReadonlySet<string>,
  indexedPaths: readonly string[],
): string | null {
  if (indexedSet.has(reportPath)) return reportPath;

  let best: string | null = null;
  for (const ip of indexedPaths) {
    if (reportPath.endsWith('/' + ip)) {
      if (!best || ip.length > best.length) best = ip;
    }
  }
  return best;
}
