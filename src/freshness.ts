import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { QueryBuilder } from './db/queries.js';
import { getMetadata } from './db/queries-metadata.js';
import { getAllFiles } from './db/queries-files.js';
import type { FileRecord } from './types.js';
import { validatePathWithinRootReal } from './utils.js';
import { logWarn } from './errors.js';
import { getCurrentHeadSha, getChangeBreakdownSince, countCommitsAhead, type ChangeBreakdown } from './git-utils.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * File-count threshold escalating freshness to `very_stale`. Reflects
 * a project-wide drift wide enough that the index almost certainly
 * mis-resolves edges.
 */
const VERY_STALE_FILES_CHANGED = 100;

/**
 * Commits-ahead threshold escalating freshness to `very_stale`. Caps
 * how far the indexed sha can lag HEAD before we treat the index as
 * effectively unrelated to current code.
 */
const VERY_STALE_COMMITS_AHEAD = 20;

/**
 * Age (in days) past which an *already-stale* index escalates to
 * `very_stale`. An in-sync but old index stays `recent` regardless.
 */
const VERY_STALE_AGE_DAYS = 7;

/**
 * File-count threshold for the `stale` (vs `recent`) bucket. One order
 * of magnitude below VERY_STALE_FILES_CHANGED.
 */
const STALE_FILES_CHANGED = 10;

/**
 * Bucketed staleness severity. Saves callers from re-deriving the
 * thresholds at every site.
 *
 *   fresh       — in sync with HEAD, indexed within ~1h
 *   recent      — small drift (≤1d AND ≤10 files changed) OR in-sync but old
 *   stale       — >1d AND isStale, OR >10 files changed
 *   very_stale  — >7d AND isStale, OR >100 files changed, OR >20 commits ahead
 *
 * The age-based escalations (>1d, >7d) ONLY fire when isStale is true.
 * An in-sync repo whose index is old is still correct — `recent` (or
 * `fresh` if very young), never `stale` / `very_stale`.
 */
type FreshnessSeverity = 'fresh' | 'recent' | 'stale' | 'very_stale';

export interface FreshnessInfo {
  isStale: boolean;
  indexedSha: string | null;
  currentSha: string | null;
  indexedAt: number;
  filesChanged: number | null;
  /** Breakdown of changed files by category. Null when git is unavailable. */
  breakdown: ChangeBreakdown | null;
  /** Number of commits between the indexed sha and HEAD. */
  commitsAhead: number | null;
  banner: string | null;
  /** Bucketed staleness — see FreshnessSeverity. */
  severity: FreshnessSeverity;
  /**
   * Count of tracked files whose on-disk content hash no longer matches
   * the indexed `files.content_hash` — a git-INDEPENDENT per-file drift
   * scan ({@link getStaleFiles}). Distinct from `filesChanged`, which on
   * the in-sync branch reflects the git-side view (`0` when HEAD matches).
   *
   * The git-side view alone produces a false "🟢 in sync" verdict
   * whenever the index lags the working tree without git noticing: an
   * indexed file edited+committed but skipped by a partial sync, or any
   * drift git doesn't surface. Populated only on the HEAD-matches branch
   * (where the false positive lives); `null` elsewhere — when SHAs
   * diverge the regular stale path already owns the drift signal.
   */
  contentDriftedFiles: number | null;
}

/**
 * Bucket an `(age, filesChanged, commitsAhead)` triple. Pure;
 * exported so the bin/CLI status command can re-use the same
 * thresholds without going through the queries layer.
 */
export function classifyFreshness(opts: {
  ageMs: number;
  filesChanged: number | null;
  commitsAhead: number | null;
  isStale: boolean;
}): FreshnessSeverity {
  const fc = opts.filesChanged ?? 0;
  const ca = opts.commitsAhead ?? 0;
  // Heavy-drift escalations: file/commit counts dominate regardless of
  // age. The >7d age bucket only fires when the index actually IS
  // stale — an old-but-in-sync repo is still correct, not very_stale.
  if (fc > VERY_STALE_FILES_CHANGED || ca > VERY_STALE_COMMITS_AHEAD) return 'very_stale';
  if (opts.isStale && opts.ageMs > VERY_STALE_AGE_DAYS * DAY_MS) return 'very_stale';
  if (!opts.isStale && opts.ageMs <= HOUR_MS && fc === 0 && ca === 0) return 'fresh';
  if (fc > STALE_FILES_CHANGED) return 'stale';
  if (opts.isStale && opts.ageMs > DAY_MS) return 'stale';
  return 'recent';
}

function formatRelativeAge(ms: number): string {
  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) {
    const min = Math.floor(ms / MINUTE_MS);
    return `${min}m ago`;
  }
  if (ms < DAY_MS) {
    const hr = Math.floor(ms / HOUR_MS);
    return `${hr}h ago`;
  }
  const days = Math.floor(ms / DAY_MS);
  return `${days}d ago`;
}

/** Format the trailing `+5/~3/-1 files` segment of the staleness
 *  banner. Returns `null` when the breakdown is empty so the caller
 *  can decide whether to include the segment at all. */
function formatBreakdownSegment(breakdown: FreshnessInfo['breakdown']): string | null {
  if (!breakdown || breakdown.total <= 0) return null;
  const segs: string[] = [];
  if (breakdown.added) segs.push(`+${breakdown.added}`);
  if (breakdown.modified) segs.push(`~${breakdown.modified}`);
  if (breakdown.deleted) segs.push(`-${breakdown.deleted}`);
  return `${segs.join('/')} files`;
}

/** Build the comma-joined `parts` body of the staleness banner from
 *  the per-aspect summaries. */
function buildBannerParts(age: string, commitsAhead: number | null, breakdown: FreshnessInfo['breakdown']): string[] {
  const parts = [`index ${age}`];
  if (commitsAhead != null && commitsAhead > 0) {
    parts.push(`${commitsAhead} commit${commitsAhead === 1 ? '' : 's'} ahead`);
  }
  const breakdownSeg = formatBreakdownSegment(breakdown);
  if (breakdownSeg) parts.push(breakdownSeg);
  parts.push(`run \`cartograph sync\``);
  return parts;
}

/** Bundle for `buildStaleInfo` to keep its arity under 4. */
interface StaleInfoCtx {
  rootDir: string;
  indexedAt: number;
  indexedSha: string;
  currentSha: string;
}

/**
 * Build the stale-index FreshnessInfo (banner + breakdown + severity)
 * for the case where the indexed and current HEAD SHAs disagree.
 */
function buildStaleInfo(ctx: StaleInfoCtx): FreshnessInfo {
  const { rootDir, indexedAt, indexedSha, currentSha } = ctx;
  const breakdown = getChangeBreakdownSince(rootDir, indexedSha);
  const commitsAhead = countCommitsAhead(rootDir, indexedSha);
  const age = formatRelativeAge(Date.now() - indexedAt);
  const banner = `> ⚠ Index out of date — ${buildBannerParts(age, commitsAhead, breakdown).join(', ')}.`;
  const filesChanged = breakdown?.total ?? null;
  const ageMs = Date.now() - indexedAt;
  return {
    isStale: true,
    indexedSha,
    currentSha,
    indexedAt,
    filesChanged,
    breakdown,
    commitsAhead,
    banner,
    severity: classifyFreshness({ ageMs, filesChanged, commitsAhead, isStale: true }),
    // SHAs diverge — the regular stale path's banner already owns the
    // drift signal; the git-independent per-file scan is reserved for
    // the in-sync branch where the false-positive lives.
    contentDriftedFiles: null,
  };
}

export function getFreshnessInfo(queries: QueryBuilder, rootDir: string): FreshnessInfo | null {
  const indexedAtRaw = getMetadata(queries, 'index_timestamp');
  if (!indexedAtRaw) return null;

  const indexedAt = Number(indexedAtRaw);
  if (!Number.isFinite(indexedAt)) return null;

  const indexedShaRaw = getMetadata(queries, 'index_head_sha');
  const indexedSha = indexedShaRaw && indexedShaRaw.length === 40 ? indexedShaRaw : null;

  // Non-git project (or pre-freshness index) — surface nothing.
  // We can't compute drift without a sha to compare against.
  if (!indexedSha) return baseInfo({ indexedAt });

  const currentSha = getCurrentHeadSha(rootDir);
  if (!currentSha) {
    // Was a git repo when indexed, isn't now — shouldn't happen often, no banner.
    return baseInfo({ indexedAt, indexedSha });
  }

  if (currentSha === indexedSha) {
    // Same HEAD — the index is in sync at the project (commit) level.
    // But "HEAD matches" is NOT "the index matches disk": a file edited
    // (and even committed) but skipped by a partial / interrupted sync
    // leaves `files.content_hash` stale while git sees nothing. Run a
    // git-independent per-file content-hash scan so the freshness
    // verdict can't render a false "🟢 in sync" over real drift.
    const contentDriftedFiles = countContentDriftedFiles(queries, rootDir);
    return baseInfo({ indexedAt, indexedSha, currentSha, filesChanged: 0, contentDriftedFiles });
  }

  return buildStaleInfo({ rootDir, indexedAt, indexedSha, currentSha });
}

/**
 * Count tracked files whose on-disk content hash differs from the
 * indexed `files.content_hash`. Git-independent — drives the freshness
 * verdict's per-file drift signal on the HEAD-matches branch, where the
 * git-side `filesChanged: 0` would otherwise mask real index lag.
 *
 * Cheap on a clean tree: {@link isFileStale} is two-stage (mtime
 * fast-path, hash only when mtime moved), so an unchanged file costs a
 * single `stat`. Best-effort — returns 0 if the file list can't be
 * read so freshness stays diagnostic.
 */
function countContentDriftedFiles(queries: QueryBuilder, rootDir: string): number {
  try {
    return getStaleFiles(rootDir, getAllFiles(queries)).length;
  } catch {
    return 0;
  }
}

function baseInfo(opts: {
  indexedAt: number;
  indexedSha?: string;
  currentSha?: string;
  filesChanged?: number;
  contentDriftedFiles?: number;
}): FreshnessInfo {
  const ageMs = Date.now() - opts.indexedAt;
  const filesChanged = opts.filesChanged ?? null;
  return {
    isStale: false,
    indexedSha: opts.indexedSha ?? null,
    currentSha: opts.currentSha ?? null,
    indexedAt: opts.indexedAt,
    filesChanged,
    breakdown: null,
    commitsAhead: null,
    banner: null,
    severity: classifyFreshness({ ageMs, filesChanged, commitsAhead: null, isStale: false }),
    contentDriftedFiles: opts.contentDriftedFiles ?? null,
  };
}

/**
 * Check whether a single tracked file has drifted from its indexed state.
 *
 * Two-stage:
 *   1. Compare on-disk mtime to recorded `modifiedAt` — fast, avoids reads.
 *   2. Only if mtime moved, recompute SHA256 and compare to `contentHash`.
 *
 * mtime can change without content changing (e.g. `touch`); the hash check
 * keeps us from crying wolf in that case. Returns false (not stale) when
 * the file can't be read — assume the indexer will catch it next sync.
 */
export function isFileStale(rootDir: string, file: FileRecord): boolean {
  const fullPath = validatePathWithinRootReal(rootDir, file.path);
  if (!fullPath) {
    // Defense-in-depth: a DB row whose path now resolves outside the
    // root means either an old (pre-validation) write or a between-
    // operation symlink swap — both are anomalous, so log them.
    logWarn('Path traversal blocked in isFileStale', { filePath: file.path });
    return false;
  }
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(fullPath).mtimeMs;
  } catch {
    return false;
  }
  if (Math.floor(mtimeMs) === Math.floor(file.modifiedAt)) {
    return false;
  }
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return false;
  }
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return hash !== file.contentHash;
}

/**
 * Filter a list of indexed file records to those that have drifted on disk.
 * Used by symbol-level handlers to flag stale results.
 */
export function getStaleFiles(rootDir: string, files: FileRecord[]): string[] {
  const stale: string[] = [];
  for (const file of files) {
    if (isFileStale(rootDir, file)) {
      stale.push(file.path);
    }
  }
  return stale;
}

/**
 * Indexed file paths whose disk file no longer exists.
 *
 * Shared by `eoFindVanishedFiles` (extraction's sync apply + detect
 * sides) and `ChangeOracle.vanished` (the typed entry point exposed to
 * MCP tools). Keeping the "what counts as vanished" rule in one place
 * here — at the same primitive layer as {@link getStaleFiles} — means a
 * future change (e.g. broadening to handle dangling symlinks) only has
 * to happen once.
 */
export function findVanishedFiles(rootDir: string, files: ReadonlyArray<Pick<FileRecord, 'path'>>): string[] {
  const vanished: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(path.join(rootDir, f.path))) vanished.push(f.path);
  }
  return vanished;
}
