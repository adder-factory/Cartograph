/**
 * Coverage ingestion orchestrator. Parses an external CI report
 * (lcov today; cobertura/jacoco TBD), maps each report file onto
 * an indexed file in the graph, then rolls coverage up into each
 * symbol's [start_line, end_line] span and upserts into
 * `node_coverage`.
 *
 * Path matching is three-tier (see {@link matchIndexedPath}): when the
 * report lives under a package (`packages/b/coverage/lcov.info`), its
 * package prefix is tried first so a package-relative `SF:src/foo.ts`
 * resolves to `packages/b/src/foo.ts` (#19); then exact match against
 * the indexed path; then longest-suffix match for the reverse monorepo
 * case where the report's path includes a workspace prefix the project
 * doesn't (report says `packages/api/src/foo.ts`, indexed path is
 * `src/foo.ts`).
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { QueryBuilder } from '../db/queries.js';
import { qbTransaction } from '../db/queries.js';
import { clearCoverageSource, upsertNodeCoverage } from '../db/queries-coverage.js';
import { getAllFilePaths } from '../db/queries-files.js';
import { appendFindings, clearFindingsByKind } from '../db/queries-findings.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { findLowCoverage } from '../biomarkers/low-coverage.js';
import { logDebug } from '../errors.js';
import { asJsonObject, type JsonObject } from '../json-object.js';
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
  /** Package-root prefix of THIS report, e.g. `packages/b` for a report
   *  at `packages/b/coverage/lcov.info`; '' for a repo-root report. Lets
   *  package-relative `SF:` paths resolve to the right workspace. */
  pathPrefix: string;
}

/** The indexed file paths, in both lookup shapes — a set for exact hits
 *  and the list for the longest-suffix scan. Always built together. */
interface IndexedPaths {
  set: ReadonlySet<string>;
  all: readonly string[];
}

/**
 * Conventional report locations relative to a *package* root, longest
 * first so the package prefix is recovered correctly (a
 * `.../coverage/lcov-report/lcov.info` must not match the shorter
 * `coverage/lcov.info` / `lcov.info` suffixes first).
 */
const CONVENTIONAL_REPORT_SUFFIXES = [
  'coverage/lcov-report/lcov.info',
  'coverage/lcov.info',
  'coverage.lcov',
  'lcov.info',
] as const;

/**
 * Recover a report's package-root prefix from where it lives on disk:
 * `packages/b/coverage/lcov.info` → `packages/b`; a repo-root report
 * (or any path outside the project / unknown layout) → `''`.
 *
 * Monorepo reporters (vitest/v8) often emit package-relative source
 * paths (`SF:src/foo.ts`) instead of repo-root-relative
 * (`SF:packages/b/src/foo.ts`). Knowing the report's package lets
 * {@link matchIndexedPath} prepend the prefix so those paths land on
 * the right indexed file instead of matching nothing — or worse, a
 * same-named file in a different package (#19).
 */
export function coveragePathPrefix(projectRoot: string, reportPath: string): string {
  const abs = path.isAbsolute(reportPath) ? reportPath : path.resolve(projectRoot, reportPath);
  const rel = normalisePath(path.relative(projectRoot, abs));
  if (rel === '' || rel.startsWith('../')) return ''; // outside the project — nothing to derive
  for (const suffix of CONVENTIONAL_REPORT_SUFFIXES) {
    if (rel === suffix) return ''; // repo-root report — no prefix
    if (rel.endsWith('/' + suffix)) return rel.slice(0, rel.length - suffix.length - 1);
  }
  return '';
}

/** Kinds whose first line is a declaration/signature line, eligible for
 *  the structural signature-line fold in {@link summariseSpan}. Matches
 *  the `low_coverage` biomarker's eligible kinds (arrow-consts are
 *  indexed as `function`), so the fold lines up with what gets flagged. */
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'component']);

function applyFileCoverage(ctx: IngestCtx, fc: import('./lcov.js').FileCoverage, matchedPath: string): void {
  const nodes = ctx.queries.getNodesByFile(matchedPath);
  for (const node of nodes) {
    const startLine = node.startLine;
    const endLine = node.endLine;
    if (!startLine || !endLine) continue;
    const span = summariseSpan(fc, { startLine, endLine, isCallable: CALLABLE_KINDS.has(node.kind) });
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
    // than write-and-ignore. `symbolsEmpty` now also counts the #21 case
    // where a multi-line callable's ONLY in-span DA was its folded (and
    // uncovered) signature line — same skip, avoids a false 0%.
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
  const indexedList = getAllFilePaths(queries).map(normalisePath);
  const indexed: IndexedPaths = { set: new Set(indexedList), all: indexedList };

  // Where this report lives tells us its workspace, so a per-package
  // report's package-relative `SF:` paths resolve to the right files.
  const pathPrefix = coveragePathPrefix(args.projectRoot, reportPath);

  const totals: IngestTotals = { filesMatched: 0, filesUnmatched: 0, symbolsUpdated: 0, symbolsEmpty: 0 };
  const ctx: IngestCtx = { queries, source, ingestedAt: Date.now(), totals, pathPrefix };

  for (const fc of fileCoverages) {
    const matchedPath = matchIndexedPath(normalisePath(fc.filePath), indexed, ctx.pathPrefix);
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
  // `replace` mirrors clearSource: a full refresh resets the source's
  // report list to just this report; a plain load APPENDS so every
  // report feeding one label is re-unioned after a sync (#18).
  persistReportPath({
    queries,
    projectRoot: args.projectRoot,
    source,
    reportPath,
    replace: options.clearSource === true,
  });

  return { ...totals, durationMs: Date.now() - start };
}

/** Args bundle for {@link persistReportPath}. */
interface PersistReportPathArgs {
  queries: QueryBuilder;
  projectRoot: string;
  source: string;
  reportPath: string;
  /** When true (a clearSource refresh), reset the source's report list
   *  to just this report instead of appending. */
  replace: boolean;
}

/** Upper bound on report paths retained per source — generous for any
 *  real monorepo (a handful of workspaces); drops the oldest beyond it
 *  so the metadata value can't grow without bound under churn. */
const MAX_REPORTS_PER_SOURCE = 64;

const coverageReportPathValueSchema = z.union([z.string(), z.array(z.unknown())]);

type CoverageReportPathValue = z.infer<typeof coverageReportPathValueSchema>;

/**
 * Record the absolute report path under the `coverage_report_paths`
 * metadata key — a `{ [source]: absPath[] }` JSON map keyed by source
 * label. Storing a LIST (not a single path) lets the coverage-reapply
 * hook re-union every report that fed a label after a sync, so
 * same-label multi-report coverage survives re-extraction (#18).
 * Best-effort: a failure here must never fail the ingest itself.
 */
function persistReportPath(args: PersistReportPathArgs): void {
  const { queries, projectRoot, source, reportPath, replace } = args;
  try {
    const abs = path.isAbsolute(reportPath) ? reportPath : path.resolve(projectRoot, reportPath);
    const map = readReportPathMap(queries);
    const prior = replace ? [] : (map[source] ?? []);
    // Dedup by abs path (re-loading the same report is idempotent), put
    // the freshest last, then cap to the most recent N.
    const next = [...prior.filter((p) => p !== abs), abs].slice(-MAX_REPORTS_PER_SOURCE);
    map[source] = next;
    setMetadata(queries, 'coverage_report_paths', JSON.stringify(map));
  } catch (err) {
    logDebug('Coverage: persistReportPath failed', { err: String(err) });
  }
}

/**
 * Forget every persisted report path for a source. Called when a
 * source is dropped so a later sync's coverage-reapply doesn't
 * resurrect rows the user explicitly removed. Best-effort.
 */
export function removeCoverageReportPath(queries: QueryBuilder, source: string): void {
  try {
    const map = readReportPathMap(queries);
    if (!(source in map)) return;
    delete map[source];
    setMetadata(queries, 'coverage_report_paths', JSON.stringify(map));
  } catch (err) {
    logDebug('Coverage: removeCoverageReportPath failed', { err: String(err) });
  }
}

/**
 * Read back the `{ [source]: absPath[] }` map persisted by
 * {@link persistReportPath}. Returns an empty map when coverage has
 * never been loaded or the stored value is unreadable. Tolerates the
 * legacy `{ [source]: absPath }` single-string shape by promoting each
 * value to a one-element array.
 */
export function getCoverageReportPaths(queries: QueryBuilder): Record<string, string[]> {
  return readReportPathMap(queries);
}

/** Shared reader for the persisted map, normalising the legacy
 *  single-string-per-source shape into the current list shape. */
function readReportPathMap(queries: QueryBuilder): Record<string, string[]> {
  const raw = getMetadata(queries, 'coverage_report_paths');
  if (!raw) return createReportPathMap();
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = asJsonObject(parsed);
    if (!root) return createReportPathMap();
    return normalizeReportPathMap(root);
  } catch {
    return createReportPathMap();
  }
}

function createReportPathMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  Object.setPrototypeOf(map, null);
  return map;
}

function normalizeReportPathMap(parsed: JsonObject): Record<string, string[]> {
  const out = createReportPathMap();
  for (const [source, value] of Object.entries(parsed)) {
    const result = coverageReportPathValueSchema.safeParse(value);
    if (!result.success) continue;
    const entry = normalizeReportPathValue(result.data);
    if (entry.length > 0) {
      out[source] = entry;
    }
  }
  return out;
}

function normalizeReportPathValue(value: CoverageReportPathValue): string[] {
  return typeof value === 'string' ? [value] : value.filter((entry): entry is string => typeof entry === 'string');
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
  return p.replaceAll('\\', '/');
}

/**
 * Resolve a report path to one of the indexed paths. Resolution order:
 *   1. When the report carries a package prefix (it lives under
 *      `<pkg>/coverage/…`), try `<pkg>/<reportPath>` first. This
 *      disambiguates a package-relative `SF:src/foo.ts` to THIS
 *      workspace before it can collide with another package's
 *      `src/foo.ts` via the suffix fallback below.
 *   2. Exact match against an indexed path (a repo-root-relative
 *      reporter, or the prefix not applying).
 *   3. Longest indexed path the report path ends with (preceded by
 *      `/`) — the original monorepo case where the report path is a
 *      superset of the indexed path.
 * Returns `null` when nothing matches.
 */
function matchIndexedPath(reportPath: string, indexed: IndexedPaths, pathPrefix: string): string | null {
  if (pathPrefix) {
    const prefixed = `${pathPrefix}/${reportPath}`;
    if (indexed.set.has(prefixed)) return prefixed;
  }
  if (indexed.set.has(reportPath)) return reportPath;

  let best: string | null = null;
  for (const ip of indexed.all) {
    if (reportPath.endsWith('/' + ip)) {
      if (!best || ip.length > best.length) best = ip;
    }
  }
  return best;
}
