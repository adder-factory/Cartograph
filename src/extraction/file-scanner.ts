import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CartographConfig } from '../types.js';
import { logDebug } from '../errors.js';
import { normalizePath } from '../utils.js';
import { getCurrentHeadSha, isCartographMetaPath } from '../git-utils.js';
import { matchesGlob as globMatches } from '../glob.js';
import { parseStrictOctalInteger } from '../strict-numeric.js';
import {
  GIT_LIST_MAX_BUFFER_BYTES,
  GIT_LIST_TIMEOUT_MS,
  GIT_PROBE_TIMEOUT_MS,
  GIT_BINARY,
  applyLocalIgnoreOverridesInto,
  collectEmbeddedRepoFilesInto,
  collectSubmoduleFilesInto,
  findCartographIgnoredDirs,
  findEmbeddedGitRepositories,
  getGitSubmodules,
  getNestedGitRepoFiles,
  hasCartographIgnoreMarker,
  isDirExcluded,
  isUnderCartographIgnoredDir,
  parseGitNulToPaths,
  safeReaddir,
  safeRealpath,
} from './file-discovery-policy.js';

function matchesGlob(filePath: string, pattern: string): boolean {
  return globMatches(normalizePath(filePath), pattern);
}

/**
 * Check if a file should be included based on config
 */
export function shouldIncludeFile(filePath: string, config: CartographConfig): boolean {
  // Cartograph's own index directory is never project source. Drop it
  // unconditionally — a fresh repo that hasn't gitignored `.cartograph/`
  // would otherwise surface the index DB / WAL / config in every
  // git-derived changed-file set (and in raw directory scans).
  if (isCartographMetaPath(filePath)) {
    return false;
  }

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesGlob(filePath, pattern)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesGlob(filePath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if rootDir is gitignored by a parent repository (nested repo case).
 * Returns true if gitignored, false if not gitignored or git command fails.
 */
function checkGitignoredByParentRepo(rootDir: string, gitRoot: string): boolean {
  if (path.resolve(gitRoot) === path.resolve(rootDir)) {
    return false; // rootDir is the git root, not nested
  }
  return isGitignoredByParentRepo(rootDir);
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and recurses
 * into active git submodules plus standalone embedded repositories hidden
 * by parent ignore rules. `git ls-files` itself does not enter nested
 * repositories, so each one is enumerated separately and prefixed back into
 * the parent path namespace. Pass `indexSubmodules: false` to skip all
 * nested-repo walks; pass `indexEmbeddedRepos: false` to keep submodules but
 * skip standalone embedded repositories.
 * Returns null on failure (non-git project) so callers can fall back.
 */
function getGitVisibleFiles(rootDir: string, config: CartographConfig): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(GIT_BINARY, ['rev-parse', '--show-toplevel'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_PROBE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (checkGitignoredByParentRepo(rootDir, gitRoot)) {
      return null;
    }

    // -c = cached (tracked), -o = others (untracked), --exclude-standard = respect .gitignore
    const output = execFileSync(GIT_BINARY, ['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: rootDir,
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const files = new Set<string>(parseGitNulToPaths(output));

    if (config.indexSubmodules !== false) {
      const submodules = new Set(getGitSubmodules(rootDir));
      collectSubmoduleFilesInto(files, rootDir, submodules);
      if (config.indexEmbeddedRepos !== false) {
        collectEmbeddedRepoFilesInto(files, { rootDir, config, submodules });
      }
    }

    applyLocalIgnoreOverridesInto(files, rootDir, config);
    return files;
  } catch {
    return null;
  }
}

/**
 * Probe `git check-ignore -q` to determine whether `targetDir` is
 * gitignored by an enclosing git repo. Returns true on exit 0 (path
 * IS ignored), false on exit 1 OR error. Used as the gate for
 * "should we fall back to a filesystem walk instead of trusting
 * `git ls-files`?".
 */
function isGitignoredByParentRepo(targetDir: string): boolean {
  try {
    execFileSync(GIT_BINARY, ['check-ignore', '-q', path.resolve(targetDir)], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: GIT_PROBE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[]; // M, MM, AM — files to re-hash + re-index
  added: string[]; // ?? — new untracked files to index
  deleted: string[]; // D — files to remove from DB
}

/**
 * Project-metadata key holding the HEAD SHA the index was last synced against.
 * Used to detect HEAD-moving operations (merge, pull, checkout, rebase,
 * reset, post-commit) that leave the working tree clean — which `git status`
 * alone cannot see.
 */
export const LAST_SYNCED_HEAD_KEY = 'last_synced_head';

interface GitChangesResult {
  changes: GitChanges;
  /** Current HEAD SHA, or null if not in a git repo or repo has no commits yet. */
  currentHead: string | null;
  /**
   * True when the previously-synced HEAD is no longer reachable from current
   * HEAD (e.g., after a force-push, history rewrite, or `git gc`). Caller
   * should treat this as "git history is unreliable here" and fall back to
   * a full filesystem scan.
   */
  needsFullReindex: boolean;
}

/** Maximum digits (3) in a C-style octal escape (`\377` = byte 255). */
const MAX_OCTAL_ESCAPE_DIGITS = 3;
/** Base for octal escape parsing. */
/**
 * C-style backslash-letter escape map → ASCII byte values (BEL, BS,
 * TAB, LF, VT, FF, CR, double-quote, backslash). Anything outside
 * this map falls through to the literal character's char code.
 */
const C_ESCAPE_BYTE_MAP: Readonly<Record<string, number>> = {
  a: 0x07, // BEL
  b: 0x08, // BS
  t: 0x09, // HT
  n: 0x0a, // LF
  v: 0x0b, // VT
  f: 0x0c, // FF
  r: 0x0d, // CR
  '"': 0x22, // "
  '\\': 0x5c, // \
};

/**
 * Parse C-style octal escape sequence starting at position i in body.
 * Returns [bytesConsumed, codePoint].
 */
function parseOctalEscape(body: string, i: number): [number, number] {
  const next = body[i];
  if (!next || !(next >= '0' && next <= '7')) {
    return [0, -1];
  }
  let octal = next;
  let j = i + 1;
  let peek = body[j];
  while (octal.length < MAX_OCTAL_ESCAPE_DIGITS && peek !== undefined && peek >= '0' && peek <= '7') {
    octal += peek;
    j++;
    peek = body[j];
  }
  return [octal.length - 1, parseStrictOctalInteger(octal) ?? -1];
}

/**
 * Decode the C-style-quoted path that `git status --porcelain` emits when
 * a path contains spaces, control chars, or non-ASCII bytes.
 */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(body.codePointAt(i) ?? 0);
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const [consumed, codePoint] = parseOctalEscape(body, i);
    if (codePoint >= 0) {
      bytes.push(codePoint);
      i += consumed;
    } else {
      bytes.push(C_ESCAPE_BYTE_MAP[next] ?? next.codePointAt(0) ?? 0);
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Classify one `git status --porcelain` line into the candidates /
 * deletions maps. Shared between the parent-repo scan and each
 * submodule scan — the two loops were byte-identical before this
 * extraction.
 */
/**
 * Shared accumulator threaded through every porcelain-line classifier
 * and the diff-merge step. Bundles the include-filter config with
 * the two parallel tracking maps (candidates that may need indexing
 * vs deletions). Mutated in place by helpers — no helper is expected
 * to construct one of these.
 */
interface PorcelainScanCtx {
  config: CartographConfig;
  candidates: Map<string, '??' | 'modified'>;
  deletions: Set<string>;
}

function applyPorcelainStatusEntry(code: string, filePath: string, ctx: PorcelainScanCtx): void {
  if (!shouldIncludeFile(filePath, ctx.config)) return;
  if (code === '??') {
    if (!ctx.candidates.has(filePath)) ctx.candidates.set(filePath, '??');
  } else if (code.includes('D')) {
    ctx.deletions.add(filePath);
  } else {
    ctx.candidates.set(filePath, 'modified');
  }
}

/**
 * Detect changed files using git, combining two sources:
 *
 *   1. `git status --porcelain` — uncommitted edits in the working tree.
 *   2. `git diff <lastSyncedHead>..HEAD` — committed changes since last
 *      sync. This catches operations that move HEAD without dirtying the
 *      working tree (merge, pull, checkout, rebase, reset, post-commit).
 *
 * Without (2), a `git merge` (etc.) would silently leave the index stale
 * because the working tree is clean and `git status` reports nothing.
 *
 * Returns null when git is unavailable (non-git project or status failure)
 * so the caller falls back to a full filesystem scan. Returns
 * `needsFullReindex: true` when the last-synced HEAD is unreachable
 * (force-push, gc), which also calls for a full scan.
 */
export function getGitChangedFiles(
  rootDir: string,
  config: CartographConfig,
  lastSyncedHead: string | null,
): GitChangesResult | null {
  const statusOutput = runGitStatusPorcelain(rootDir);
  if (statusOutput === null) return null;

  const currentHead = getCurrentHeadSha(rootDir);

  // Two parallel maps: candidates (files that exist or may exist on disk
  // and need an index check) and deletions (files git says were removed).
  // Origin distinguishes untracked-add (skip hash compare) from
  // modified/committed (do hash compare).
  const candidates = new Map<string, '??' | 'modified'>();
  const deletions = new Set<string>();

  const ctx: PorcelainScanCtx = { config, candidates, deletions };
  parsePorcelainOutput(statusOutput, '', ctx);

  // Union committed changes since last sync.
  if (currentHead && lastSyncedHead && currentHead !== lastSyncedHead) {
    if (!unionDiffSinceLastSync({ rootDir, lastSyncedHead, currentHead }, ctx)) {
      return { changes: { modified: [], added: [], deleted: [] }, currentHead, needsFullReindex: true };
    }
  }

  if (config.indexSubmodules !== false) {
    const submodules = new Set(getGitSubmodules(rootDir));
    mergeSubmoduleStatuses(rootDir, ctx, submodules);
    if (config.indexEmbeddedRepos !== false) {
      mergeEmbeddedRepoStatuses(rootDir, ctx, submodules);
    }
  }
  mergeLocalIgnoreOverrideStatuses(rootDir, ctx);

  // A file present in both sets exists on disk now (working tree wins over
  // recorded deletion — e.g., file deleted in commit, then re-created
  // uncommitted).
  for (const filePath of candidates.keys()) deletions.delete(filePath);

  const changes = partitionCandidates(rootDir, candidates, deletions);
  return { changes, currentHead, needsFullReindex: false };
}

/** Run `git status --porcelain --no-renames` in `cwd`. Returns null on error. */
function runGitStatusPorcelain(cwd: string): string | null {
  try {
    return execFileSync(GIT_BINARY, ['status', '--porcelain', '--no-renames'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Minimum length (4 chars) of a meaningful `git status --porcelain`
 * line — a 2-char status code, a space, and at least one character of
 * path.
 */
const PORCELAIN_MIN_LINE_LENGTH = 4;

/**
 * Column at which the path begins in a `git status --porcelain` line
 * — character 3 (after the 2-char status code and the separator
 * space).
 */
const PORCELAIN_PATH_OFFSET = 3;

/** Apply each porcelain line to candidates/deletions, prefixing paths with `pathPrefix` (use `${subPath}/` for submodules). */
function parsePorcelainOutput(output: string, pathPrefix: string, ctx: PorcelainScanCtx): void {
  for (const line of output.split('\n')) {
    if (line.length < PORCELAIN_MIN_LINE_LENGTH) continue;
    const code = line.substring(0, 2);
    const raw = unquoteGitPath(line.substring(PORCELAIN_PATH_OFFSET));
    const filePath = normalizePath(pathPrefix + raw);
    applyPorcelainStatusEntry(code, filePath, ctx);
  }
}

/**
 * Verify that lastSyncedHead is still reachable in git history.
 * Returns true if reachable, false if history was rewritten or pruned.
 */
function verifyLastSyncedHeadReachable(rootDir: string, lastSyncedHead: string, currentHead: string): boolean {
  try {
    execFileSync(GIT_BINARY, ['cat-file', '-e', `${lastSyncedHead}^{commit}`], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_PROBE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    logDebug('Last-synced HEAD unreachable, falling back to full reindex', { lastSyncedHead, currentHead });
    return false;
  }
}

/**
 * Run git diff between two commits and return the output.
 * Returns null if diff fails (history issue).
 */
function getDiffOutput(rootDir: string, lastSyncedHead: string, currentHead: string): string | null {
  try {
    // -z: NUL-delimited fields/records, robust against arbitrary path chars.
    // --no-renames: keep semantics consistent with the status call above.
    return execFileSync(
      GIT_BINARY,
      ['diff', '--name-status', '--no-renames', '-z', `${lastSyncedHead}..${currentHead}`],
      {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: GIT_LIST_TIMEOUT_MS,
        maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch {
    logDebug('git diff against last-synced HEAD failed, falling back to full reindex', { lastSyncedHead, currentHead });
    return null;
  }
}

/**
 * Merge a diff entry (status/path pair) into candidates/deletions.
 */
function applyDiffEntry(code: string, filePath: string, ctx: PorcelainScanCtx): void {
  if (!shouldIncludeFile(filePath, ctx.config)) return;
  if (code.startsWith('D')) {
    ctx.deletions.add(filePath);
  } else if (!ctx.candidates.has(filePath)) {
    // A/M/T (and C with --no-renames) — caller will read+hash and let
    // the DB lookup decide whether it's truly an add or a modify.
    ctx.candidates.set(filePath, 'modified');
  }
}

/** Arg bundle for `unionDiffSinceLastSync`. */
interface DiffSinceArgs {
  rootDir: string;
  lastSyncedHead: string;
  currentHead: string;
}

/**
 * Diff `lastSyncedHead..currentHead` and merge committed changes into
 * candidates/deletions. Returns false when the diff cannot run (history
 * rewritten or pruned), signalling the caller to fall back to a full
 * reindex.
 */
function unionDiffSinceLastSync(diffArgs: DiffSinceArgs, ctx: PorcelainScanCtx): boolean {
  const { rootDir, lastSyncedHead, currentHead } = diffArgs;
  if (!verifyLastSyncedHeadReachable(rootDir, lastSyncedHead, currentHead)) {
    return false;
  }

  const diffOutput = getDiffOutput(rootDir, lastSyncedHead, currentHead);
  if (!diffOutput) {
    return false;
  }

  // With -z + --name-status the stream is: status \0 path \0 status \0 path \0 ...
  const tokens = diffOutput.split('\0').filter((t) => t.length > 0);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i]!;
    const filePath = normalizePath(tokens[i + 1]!);
    applyDiffEntry(code, filePath, ctx);
  }
  return true;
}

/**
 * Parent-repo `git status` only emits a directory-level entry per
 * submodule. Run status inside each active submodule and merge the
 * file-level results back, dropping the bare directory entries
 * candidates picked up from the parent. Errors are non-fatal — a
 * broken submodule shouldn't block the rest of the sync.
 */
function mergeSubmoduleStatuses(rootDir: string, ctx: PorcelainScanCtx, submodules: ReadonlySet<string>): void {
  for (const subPath of submodules) {
    ctx.candidates.delete(subPath);
  }
  for (const subPath of submodules) {
    const subStatus = runGitStatusPorcelain(path.join(rootDir, subPath));
    if (subStatus === null) continue;
    parsePorcelainOutput(subStatus, `${subPath}/`, ctx);
  }
}

function mergeEmbeddedRepoStatuses(rootDir: string, ctx: PorcelainScanCtx, submodules: ReadonlySet<string>): void {
  for (const repoPath of findEmbeddedGitRepositories(rootDir, ctx.config, submodules)) {
    ctx.candidates.delete(repoPath);
    for (const filePath of getNestedGitRepoFiles(rootDir, repoPath)) {
      if (shouldIncludeFile(filePath, ctx.config) && !ctx.candidates.has(filePath)) {
        ctx.candidates.set(filePath, 'modified');
      }
    }
    const repoStatus = runGitStatusPorcelain(path.join(rootDir, repoPath));
    if (repoStatus !== null) parsePorcelainOutput(repoStatus, `${repoPath}/`, ctx);
  }
}

function mergeLocalIgnoreOverrideStatuses(rootDir: string, ctx: PorcelainScanCtx): void {
  const files = new Set<string>();
  applyLocalIgnoreOverridesInto(files, rootDir, ctx.config);
  for (const filePath of files) {
    if (shouldIncludeFile(filePath, ctx.config) && !ctx.candidates.has(filePath)) {
      ctx.candidates.set(filePath, 'modified');
    }
    ctx.deletions.delete(filePath);
  }
}

/**
 * Apply `.cartographignore` filtering across both candidates and deletions
 * (the marker is per-directory, so build the ignored-dir set from the
 * union of all paths we're considering), then split candidates into
 * modified/added by their origin marker.
 */
function partitionCandidates(
  rootDir: string,
  candidates: Map<string, '??' | 'modified'>,
  deletions: Set<string>,
): { modified: string[]; added: string[]; deleted: string[] } {
  const allConsidered = [...candidates.keys(), ...deletions];
  const ignoredDirs = findCartographIgnoredDirs(rootDir, allConsidered);

  const modified: string[] = [];
  const added: string[] = [];
  for (const [filePath, origin] of candidates) {
    if (isUnderCartographIgnoredDir(filePath, ignoredDirs)) continue;
    if (origin === '??') added.push(filePath);
    else modified.push(filePath);
  }
  const deleted = Array.from(deletions).filter((p) => !isUnderCartographIgnoredDir(p, ignoredDirs));
  return { modified, added, deleted };
}

/**
 * Recursively scan directory for source files.
 *
 * In git repos, uses `git ls-files` to get the file list (inherently
 * respects .gitignore at all levels), then filters by config include patterns.
 * Falls back to filesystem walk for non-git projects.
 */
export function scanDirectory(
  rootDir: string,
  config: CartographConfig,
  onProgress?: (current: number, file: string) => void,
): string[] {
  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir, config);
  if (!gitFiles) {
    // Fallback: walk filesystem for non-git projects
    return scanDirectoryWalk(rootDir, config, onProgress);
  }
  const ignoredDirs = findCartographIgnoredDirs(rootDir, gitFiles);
  const visibleFiles = Array.from(gitFiles);
  const files: string[] = [];
  let count = 0;
  for (const filePath of visibleFiles) {
    if (isUnderCartographIgnoredDir(filePath, ignoredDirs)) continue;
    if (!shouldIncludeFile(filePath, config)) continue;
    files.push(filePath);
    count++;
    onProgress?.(count, filePath);
  }
  return files;
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  config: CartographConfig,
  onProgress?: (current: number, file: string) => void,
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir, config);
  if (!gitFiles) return scanDirectoryWalk(rootDir, config, onProgress);

  const ignoredDirs = findCartographIgnoredDirs(rootDir, gitFiles);
  const files: string[] = [];
  const visibleFiles = Array.from(gitFiles);
  let index = 0;
  while (index < visibleFiles.length) {
    const filePath = visibleFiles[index++]!;
    if (isUnderCartographIgnoredDir(filePath, ignoredDirs)) continue;
    if (!shouldIncludeFile(filePath, config)) continue;
    files.push(filePath);
    onProgress?.(files.length, filePath);
    // Yield every 100 files so worker threads can render progress.
    if (files.length % 100 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  return files;
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  config: CartographConfig,
  onProgress?: (current: number, file: string) => void,
): string[] {
  const files: string[] = [];
  const ctx: ScanWalkCtx = {
    rootDir,
    config,
    onProgress,
    files,
    visitedDirs: new Set<string>(),
  };
  walkDirRecursive(ctx, rootDir);
  return files;
}

/** Per-call context for the recursive directory walk — avoids closures in the body. */
interface ScanWalkCtx {
  rootDir: string;
  config: CartographConfig;
  onProgress: ((current: number, file: string) => void) | undefined;
  files: string[];
  visitedDirs: Set<string>;
}

/** Add a file to the result if config includes it. */
function addFileIfIncluded(ctx: ScanWalkCtx, relativePath: string): void {
  if (!shouldIncludeFile(relativePath, ctx.config)) return;
  ctx.files.push(relativePath);
  ctx.onProgress?.(ctx.files.length, relativePath);
}

/** Recurse into a directory unless it matches the exclude list. */
function walkDirIfNotExcluded(ctx: ScanWalkCtx, fullPath: string, relativePath: string): void {
  if (!isDirExcluded(relativePath, ctx.config.exclude)) walkDirRecursive(ctx, fullPath);
}

/** Resolve a symlink and route to the dir / file handler. */
function handleSymlinkEntry(ctx: ScanWalkCtx, fullPath: string, relativePath: string): void {
  try {
    const realTarget = fs.realpathSync(fullPath);
    const stat = fs.statSync(realTarget);
    if (stat.isDirectory()) walkDirIfNotExcluded(ctx, fullPath, relativePath);
    else if (stat.isFile()) addFileIfIncluded(ctx, relativePath);
  } catch {
    logDebug('Skipping broken symlink', { path: fullPath });
  }
}

/** Route one directory entry to the appropriate handler. */
function dispatchScanEntry(ctx: ScanWalkCtx, entry: fs.Dirent, relativePath: string): void {
  const fullPath = path.join(ctx.rootDir, relativePath);
  if (entry.isSymbolicLink()) handleSymlinkEntry(ctx, fullPath, relativePath);
  else if (entry.isDirectory()) walkDirIfNotExcluded(ctx, fullPath, relativePath);
  else if (entry.isFile()) addFileIfIncluded(ctx, relativePath);
}

/**
 * Recursive directory walker — symlink-cycle-safe and `.cartographignore`-aware.
 * Top-level helper (not nested) so its decision points don't roll up into
 * the parent's complexity.
 */
function walkDirRecursive(ctx: ScanWalkCtx, dir: string): void {
  const realDir = safeRealpath(dir);
  if (!realDir) return;
  if (ctx.visitedDirs.has(realDir)) {
    logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
    return;
  }
  ctx.visitedDirs.add(realDir);

  // .cartographignore marker file opts a directory out of indexing entirely.
  if (hasCartographIgnoreMarker(dir)) {
    logDebug('Skipping directory due to .cartographignore marker', { dir });
    return;
  }

  const entries = safeReaddir(dir);
  if (!entries) return;
  for (const entry of entries) {
    const relativePath = normalizePath(path.relative(ctx.rootDir, path.join(dir, entry.name)));
    dispatchScanEntry(ctx, entry, relativePath);
  }
}
