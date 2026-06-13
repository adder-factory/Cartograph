/**
 * @internal — handler for `cartograph_coverage({mode: 'refresh'})`.
 * Discovers coverage reports under the project root and ingests them.
 *
 * Two discovery tiers:
 *  - ROOT conventional paths (`coverage/lcov.info`, …) are competing
 *    default locations for the SAME root report, so only the freshest
 *    one is ingested.
 *  - PER-PACKAGE reports (`packages/*​/coverage/lcov.info` and deeper)
 *    each cover a different workspace, so every one is unioned under the
 *    same source label — the upsert max-merges per symbol (#18), so
 *    well-tested code in sub-packages stops surfacing as false
 *    `low_coverage` (#19). All ingested paths persist, so the
 *    coverage-reapply hook re-unions them after a later sync.
 *
 * When no per-package report exists (the common single-package case)
 * the handler keeps its original single-report behaviour and output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errMsg } from '../../errors.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type Cartograph from '../../index.js';
import { detectTestRunner, testCoverageHint } from './_coverage-tips.js';

/** Conventional ROOT locations checked, in declaration order. The chosen
 *  report is the one with the newest mtime; declaration order is only
 *  used to render the "considered" list deterministically. */
const CONVENTIONAL_PATHS: readonly string[] = [
  'coverage/lcov.info',
  'coverage/lcov-report/lcov.info',
  'lcov.info',
  'coverage.lcov',
];

/** Conventional report locations checked under each NESTED package dir.
 *  Restricted to the `coverage/` convention so the walk can't pick up
 *  stray `lcov.info` fixtures committed elsewhere in the tree. */
const PACKAGE_REPORT_SUFFIXES: readonly string[] = ['coverage/lcov.info', 'coverage/lcov-report/lcov.info'];

/** Directories never descended into when globbing for per-package
 *  reports — build output, dependencies, VCS, and test fixtures that
 *  may contain sample lcov files. `coverage` is here so we don't walk
 *  INTO a report dir (its `lcov.info` is still found from the parent). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cartograph',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'vendor',
  'coverage',
  '__tests__',
  '__fixtures__',
  '__snapshots__',
  '.venv',
  'venv',
]);

/** Max directory depth below the project root to search — covers
 *  `apps/<name>/<pkg>` layouts without an unbounded walk. */
const MAX_WALK_DEPTH = 6;
/** Hard cap on directories visited, a backstop against pathological trees. */
const MAX_DIRS_VISITED = 4000;
/** Hard cap on per-package reports discovered, bounding output + ingest. */
const MAX_PACKAGE_REPORTS = 128;

interface Candidate {
  /** Path relative to projectRoot, for display. */
  relPath: string;
  absPath: string;
  mtimeMs: number;
}

/** Stat a project-relative path and return a candidate when it is a
 *  non-empty file, else null. */
function candidateAt(projectRoot: string, rel: string): Candidate | null {
  const abs = path.resolve(projectRoot, rel);
  try {
    const st = fs.statSync(abs);
    if (st.isFile() && st.size > 0) return { relPath: rel, absPath: abs, mtimeMs: st.mtimeMs };
  } catch {
    // not present — fine, just skip
  }
  return null;
}

/** The ROOT conventional candidates (existing behaviour). */
function discoverRootCandidates(projectRoot: string): Candidate[] {
  const found: Candidate[] = [];
  for (const rel of CONVENTIONAL_PATHS) {
    const c = candidateAt(projectRoot, rel);
    if (c) found.push(c);
  }
  return found;
}

/** Directory entries of `dir`, or `[]` when it can't be read. */
function readSubdirs(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable dir — skip
  }
}

/** A directory not worth descending into: not a directory, a known
 *  build/dep/fixture dir, or a dotdir. */
function isSkippableDir(ent: fs.Dirent): boolean {
  return !ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.');
}

/** Record any conventional per-package report under `pkgDir` into `found`
 *  (keyed by absPath, dedup). */
function collectPackageReports(projectRoot: string, pkgDir: string, found: Map<string, Candidate>): void {
  for (const suffix of PACKAGE_REPORT_SUFFIXES) {
    const rel = path.relative(projectRoot, path.join(pkgDir, suffix)).replaceAll('\\', '/');
    const c = candidateAt(projectRoot, rel);
    if (c && !found.has(c.absPath)) found.set(c.absPath, c);
  }
}

/**
 * Walk nested directories (bounded depth, skipping build/dep/fixture
 * dirs) and collect per-package coverage reports — `packages/*​/coverage/
 * lcov.info` and deeper. The repo-root `coverage/` is intentionally NOT
 * collected here; that is {@link discoverRootCandidates}' job.
 */
function discoverPackageCandidates(projectRoot: string): Candidate[] {
  const found = new Map<string, Candidate>(); // keyed by absPath (dedup)
  const stack: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && found.size < MAX_PACKAGE_REPORTS && visited < MAX_DIRS_VISITED) {
    const { dir, depth } = stack.pop()!;
    visited += 1;
    for (const ent of readSubdirs(dir)) {
      if (isSkippableDir(ent)) continue;
      const sub = path.join(dir, ent.name);
      collectPackageReports(projectRoot, sub, found);
      if (depth + 1 < MAX_WALK_DEPTH) stack.push({ dir: sub, depth: depth + 1 });
    }
  }
  return [...found.values()];
}

/** Freshest-first. Equal-mtime ties break by ROOT declaration order
 *  (so the "considered" footer is deterministic), then by path — the
 *  latter keeps per-package reports (absent from `CONVENTIONAL_PATHS`,
 *  so both score -1) in a stable, reproducible order. */
function sortFreshest(candidates: Candidate[]): void {
  candidates.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const byDecl = CONVENTIONAL_PATHS.indexOf(a.relPath) - CONVENTIONAL_PATHS.indexOf(b.relPath);
    if (byDecl !== 0) return byDecl;
    return a.relPath.localeCompare(b.relPath);
  });
}

/** Render the "Considered" footer from the ROOT candidate snapshot. We
 *  re-stat NOTHING here — if the snapshot says a path was present, we
 *  render ☑️ even if it has since been deleted, so the footer always
 *  agrees with the ingestion result above it. */
function renderConsidered(candidates: readonly Candidate[], picked: Candidate | null): string {
  const presentByPath = new Map(candidates.map((c) => [c.relPath, c]));
  const lines: string[] = ['', '_Considered:_'];
  for (const rel of CONVENTIONAL_PATHS) {
    const present = presentByPath.get(rel);
    let mark = '  - ❌';
    let suffix = '';
    if (present) {
      const isPicked = picked?.absPath === present.absPath;
      mark = isPicked ? '  - ✅' : '  - ☑️';
      suffix = isPicked ? ' (chosen — freshest)' : '';
    }
    lines.push(`${mark} \`${rel}\`${suffix}`);
  }
  return lines.join('\n');
}

function noCandidatesMessage(cg: Cartograph): string {
  const runner = detectTestRunner(cg.projectRoot);
  const runnerLine = runner
    ? `Detected **${runner.name}**. To generate one:\n\n${testCoverageHint(runner)}`
    : 'Run your test suite with a coverage reporter that emits lcov, then call this tool again.';
  const considered = renderConsidered([], null);
  return [
    '## No coverage report found',
    '',
    'No lcov report exists at any of the conventional paths under the project root.',
    '',
    runnerLine,
    considered,
  ].join('\n');
}

/** Shared inputs for the two ingest paths. */
interface IngestArgs {
  cg: Cartograph;
  /** Reports to ingest — the ROOT candidate set for {@link ingestSingle},
   *  the union set (freshest root + per-package) for {@link ingestUnion}. */
  reports: Candidate[];
  source: string;
  clearSource: boolean;
}

/** Single-report ingest — the original behaviour, used when no
 *  per-package reports exist. Picks the freshest ROOT candidate and
 *  renders the "Considered" footer. */
async function ingestSingle({ cg, reports: rootCandidates, source, clearSource }: IngestArgs): Promise<ToolOutcome> {
  sortFreshest(rootCandidates);
  const picked = rootCandidates[0]!;
  try {
    const result = await cg.ingestCoverage(picked.absPath, { source, clearSource });
    const lines: string[] = [
      `## Refreshed coverage from \`${picked.relPath}\``,
      '',
      `- Source label: \`${source}\``,
      `- Files matched: ${result.filesMatched}`,
      `- Files unmatched: ${result.filesUnmatched}`,
      `- Symbols with coverage: ${result.symbolsUpdated}`,
      `- Symbols skipped (no overlap): ${result.symbolsEmpty}`,
      `- Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
      renderConsidered(rootCandidates, picked),
    ];
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Coverage refresh failed loading \`${picked.relPath}\`: ${errMsg(error_)}`);
  }
}

/** Union ingest — the freshest ROOT report (if any) plus every
 *  per-package report, all merged under one source label. */
async function ingestUnion({ cg, reports, source, clearSource }: IngestArgs): Promise<ToolOutcome> {
  let matched = 0;
  let unmatched = 0;
  let symbols = 0;
  let totalMs = 0;
  const rows: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < reports.length; i += 1) {
    const rep = reports[i]!;
    // Clear the source ONCE, on the first ingest, when asked — otherwise
    // each subsequent report would wipe the prior reports' rows.
    const clearThis = clearSource && i === 0;
    try {
      const result = await cg.ingestCoverage(rep.absPath, { source, clearSource: clearThis });
      matched += result.filesMatched;
      unmatched += result.filesUnmatched;
      symbols += result.symbolsUpdated;
      totalMs += result.durationMs;
      rows.push(`- \`${rep.relPath}\` — files matched ${result.filesMatched}, symbols ${result.symbolsUpdated}`);
    } catch (error_) {
      failures.push(`- \`${rep.relPath}\` — ${errMsg(error_)}`);
    }
  }

  if (rows.length === 0) {
    return err(`Coverage refresh failed: no report ingested.\n${failures.join('\n')}`);
  }

  const lines: string[] = [
    `## Refreshed coverage — unioned ${rows.length} report(s) under source \`${source}\``,
    '',
    ...rows,
    '',
    `**Totals:** ${symbols} symbol${symbols === 1 ? '' : 's'} with coverage · ${matched} file${matched === 1 ? '' : 's'} matched · ${unmatched} unmatched · ${(totalMs / 1000).toFixed(1)}s`,
  ];
  if (failures.length > 0) {
    lines.push('', '_Reports that failed to load:_', ...failures);
  }
  return ok(textResult(lines.join('\n')));
}

export async function handleCoverageRefresh(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const rootCandidates = discoverRootCandidates(cg.projectRoot);
  const packageCandidates = discoverPackageCandidates(cg.projectRoot);

  if (rootCandidates.length === 0 && packageCandidates.length === 0) {
    return ok(textResult(noCandidatesMessage(cg)));
  }

  const source = (args['source'] as string | undefined) ?? 'lcov';
  const clearSource = args['clear'] === true;

  // No per-package reports → keep the original single-report behaviour
  // and output (the common, non-monorepo case).
  if (packageCandidates.length === 0) {
    return ingestSingle({ cg, reports: rootCandidates, source, clearSource });
  }

  // Monorepo: union the freshest root report (if present) with every
  // per-package report.
  sortFreshest(rootCandidates);
  sortFreshest(packageCandidates);
  const reports = [...rootCandidates.slice(0, 1), ...packageCandidates];
  return ingestUnion({ cg, reports, source, clearSource });
}
