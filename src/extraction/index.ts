/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Language, ExtractionResult, ExtractionError, CartographConfig } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getFilesNeedingReextract } from '../db/queries-files.js';
import { evictParseCacheIfOversized } from '../db/queries-parse-cache.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { deferNodeDerivedIndexes, finalizeDeferredNodeIndexes } from '../db/deferred-index.js';
import { extractFromSource } from './tree-sitter.js';
import { detectLanguage, isLanguageSupported, initGrammars } from './grammars.js';
import { logDebug, logWarn, errMsg } from '../errors.js';
import { validatePathWithinRootReal, normalizePath, stripBom, compact } from '../utils.js';
import { ParseWorkerPool } from './parse-worker-pool.js';
import { getCurrentHeadSha, isCartographMetaPath } from '../git-utils.js';
import { matchesGlob as globMatches } from '../glob.js';
import {
  type EoIndexCounters,
  eoScanFilesForIndex,
  eoAbortIndexResult,
  eoRunIndexParseAndStorePhase,
  eoRunIndexRetryPhase,
  eoStampPostIndexBaseline,
  eoFinalIndexResult,
  eoStoreExtractionResult,
  eoApplySyncChanges,
  eoApplyExtractionEnvFromConfig,
  eoIndexChangedFiles,
  eoStampFreshness,
  eoCollectGitChanges,
  eoCollectFullScanChanges,
  isMinifiedJsFamily,
} from './extraction-phases.js';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
export const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

// Per-file parse timeout moved to ParseWorkerPool; see
// `BASE_PARSE_TIMEOUT_MS` and the per-100KB extension there.

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
export const WORKER_RECYCLE_INTERVAL = 250;

/** Hard ceiling (16) on caller-supplied pool size — bounds memory cost in the face of hostile inputs. */
export const POOL_SIZE_MAX = 16;

// git invocation timeouts and buffer sizes shared by getGitVisibleFiles
// + unionDiffSinceLastSync. Probes that should return immediately
// (rev-parse, check-ignore, cat-file) get the short timeout; commands
// that may scan the whole work tree (ls-files, diff) get the long one.
const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_LIST_TIMEOUT_MS = 30_000;
/** 50 MB — comfortably above any real-world `git ls-files` / `git diff` output. */
const GIT_LIST_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

/**
 * Default size of the parse-worker pool. Each worker holds its own
 * tree-sitter WASM heap (~50-100MB per loaded grammar), so pool size
 * trades memory for parallelism. Sized to `os.cpus().length - 1` — one
 * core reserved for the main thread (DB writes, I/O batching) — and
 * floored at 1, so it auto-scales from a single-core CI runner to a
 * many-core workstation. `POOL_SIZE_MAX` caps memory cost on big
 * machines. Override via `IndexOptions.parseWorkers` (or the
 * `--parse-workers` CLI flag on `admin index`).
 *
 * Note: on small/medium TypeScript corpora the parse+store phase is
 * store-bound (serial main-thread SQLite writes), so workers past ~4
 * are headroom for parse-heavy corpora (huge files, slow grammars)
 * rather than a guaranteed speedup — benchmark before tuning.
 */
export const DEFAULT_PARSE_POOL_SIZE = (() => {
  // os import is at the top of the file; size from hardware concurrency.
  // Math.min is safe with NaN (returns NaN) which we coerce to 1.
  const hc = typeof os !== 'undefined' && typeof os.cpus === 'function' ? Math.max(1, os.cpus().length) : 4;
  // Reserve one core for the main thread; floor at 1 so a single-core
  // box still gets a worker; POOL_SIZE_MAX bounds memory on big-core
  // machines.
  return Math.max(1, Math.min(hc - 1, POOL_SIZE_MAX));
})();

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Per-phase timings for `--profile`. All values are wall-clock
 * milliseconds. Filled opportunistically — phases not run (e.g.
 * resolve when no files changed) report 0. Filled by both
 * `ExtractionOrchestrator.indexAll` (orchestrator-internal phases)
 * and `Cartograph.indexAll` (coordinator phases).
 */
interface IndexProfile {
  /** File-system scan / glob filtering. */
  scanMs?: number;
  /** Parse + extract + store loop (interleaved per file). */
  parseStoreMs?: number;
  /** Retry pass for WASM-corruption recoveries. */
  retryMs?: number;
  /** Orchestrator total (scanMs + parseStoreMs + retryMs + overhead). */
  extractionMs?: number;
  /** Resolution pass (cross-file name matching → edges). */
  resolveMs?: number;
  /** Post-index hooks: centrality, churn, issue-history, config-refs, sql-refs, cochange. */
  postHooksMs?: number;
  /**
   * Per-hook breakdown of `postHooksMs`. Hook name → wall-clock ms.
   * Populated alongside `postHooksMs` when `profile:true`. Useful for
   * pinpointing which sub-hook dominates the post-index spend.
   */
  postHooksByHook?: Record<string, number>;
  /** SQLite WAL checkpoint + planner stats refresh. */
  maintenanceMs?: number;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
  /** Set when `--profile` (`profile: true`) is requested. */
  profile?: IndexProfile;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
  /**
   * True when sync exited early because another process holds the
   * index file-lock. The caller should distinguish this from a real
   * "no changes" sync — the index may still be stale.
   */
  lockContention?: boolean;
}

/**
 * Mutable run-state threaded through `sync`'s helpers. `filesToIndex`
 * is the queue of paths to extract; `changedFilePaths` is the
 * caller-visible record of what moved this pass; the count fields
 * accumulate into the returned SyncResult.
 */
export interface SyncState {
  filesToIndex: string[];
  changedFilePaths: string[];
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
}

/**
 * Empty `ExtractionResult` shell, used when a file is rejected before
 * extraction (path traversal blocked, oversize, unsupported language)
 * so the caller still gets a fully-typed object back.
 */
function emptyExtractionResult(errors: ExtractionError[] = []): ExtractionResult {
  return { nodes: [], edges: [], unresolvedReferences: [], errors, durationMs: 0 };
}

/** Argument bundle for `storeExtractionResult`. */
export interface StoreExtractionParams {
  filePath: string;
  content: string;
  language: Language;
  stats: fs.Stats;
  result: ExtractionResult;
}

/**
 * Calculate SHA256 hash of file contents.
 *
 * A leading UTF-8 BOM is stripped before hashing so files round-tripped
 * through editors that disagree about BOM handling (VSCode strips by
 * default; some Windows editors preserve it) hash identically and don't
 * appear "modified" on every sync.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(stripBom(content)).digest('hex');
}

/**
 * Check if a path matches any glob pattern (simplified)
 */
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
 * Parse git output as newline-delimited paths, trimmed and normalized.
 * Returns empty array on null input.
 */
function parseGitLinesToPaths(output: string | null): string[] {
  if (!output) return [];
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) paths.push(normalizePath(trimmed));
  }
  return paths;
}

/**
 * Enumerate all initialized submodule paths (recursively), relative to `rootDir`.
 *
 * Uses `git submodule foreach` so we get exactly the submodules git considers
 * active — uninitialized / deinitialized submodules are skipped automatically,
 * which is what we want (we can't ls-files inside a directory with no .git).
 *
 * Returns [] when there are no submodules or when the command fails. Errors
 * here are non-fatal: submodule indexing is a best-effort enhancement on top
 * of the parent-repo file scan.
 */
function getGitSubmodules(rootDir: string): string[] {
  try {
    const output = execFileSync('git', ['submodule', 'foreach', '--recursive', '--quiet', 'echo "$displaypath"'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseGitLinesToPaths(output);
  } catch {
    return [];
  }
}

/**
 * Parse git output as newline-delimited paths, trimmed, normalized, and prefixed.
 * Returns empty array on null input.
 */
function parseGitLinesToPrefixedPaths(output: string | null, prefix: string): string[] {
  if (!output) return [];
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) paths.push(normalizePath(`${prefix}/${trimmed}`));
  }
  return paths;
}

/**
 * Run `git ls-files -co --exclude-standard` inside a submodule and return
 * paths prefixed back into the parent repo's relative-path namespace.
 * Errors are swallowed so one broken submodule doesn't fail the whole scan.
 */
function getSubmoduleFiles(rootDir: string, submodulePath: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: path.join(rootDir, submodulePath),
      encoding: 'utf-8',
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseGitLinesToPrefixedPaths(output, submodulePath);
  } catch {
    return [];
  }
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
 * into git submodules — `git ls-files` itself does not enter submodules,
 * so each one is enumerated separately and its paths are prefixed.
 * Pass `indexSubmodules: false` in config to skip the submodule walk.
 * Returns null on failure (non-git project) so callers can fall back.
 */
function getGitVisibleFiles(rootDir: string, config: CartographConfig): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_PROBE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (checkGitignoredByParentRepo(rootDir, gitRoot)) {
      return null;
    }

    // -c = cached (tracked), -o = others (untracked), --exclude-standard = respect .gitignore
    const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const files = new Set<string>(parseGitLinesToPaths(output));

    if (config.indexSubmodules !== false) {
      collectSubmoduleFilesInto(files, rootDir);
    }

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
    execFileSync('git', ['check-ignore', '-q', path.resolve(targetDir)], {
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
 * Recurse into every git submodule of `rootDir`, adding each
 * submodule-relative file path into `target` in place. Each
 * submodule has its own git index — the parent's `ls-files` only
 * emits the submodule's directory entry, not the files inside.
 */
function collectSubmoduleFilesInto(target: Set<string>, rootDir: string): void {
  for (const submodulePath of getGitSubmodules(rootDir)) {
    for (const filePath of getSubmoduleFiles(rootDir, submodulePath)) {
      target.add(filePath);
    }
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
const OCTAL_BASE = 8;
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
  return [octal.length - 1, Number.parseInt(octal, OCTAL_BASE)];
}

/**
 * Decode the C-style-quoted path that `git status --porcelain` emits when
 * a path contains spaces, control chars, or non-ASCII bytes.
 */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
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
    mergeSubmoduleStatuses(rootDir, ctx);
  }

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
    return execFileSync('git', ['status', '--porcelain', '--no-renames'], {
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
    const raw = pathPrefix
      ? unquoteGitPath(line.substring(PORCELAIN_PATH_OFFSET))
      : line.substring(PORCELAIN_PATH_OFFSET);
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
    execFileSync('git', ['cat-file', '-e', `${lastSyncedHead}^{commit}`], {
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
    return execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', `${lastSyncedHead}..${currentHead}`], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
function mergeSubmoduleStatuses(rootDir: string, ctx: PorcelainScanCtx): void {
  const submodules = new Set(getGitSubmodules(rootDir));
  for (const subPath of submodules) {
    ctx.candidates.delete(subPath);
  }
  for (const subPath of submodules) {
    const subStatus = runGitStatusPorcelain(path.join(rootDir, subPath));
    if (subStatus === null) continue;
    parsePorcelainOutput(subStatus, `${subPath}/`, ctx);
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
 * Marker file name that indicates a directory (and all children) should be skipped
 */
const CARTOGRAPH_IGNORE_MARKER = '.cartographignore';

/**
 * Walk every parent directory of the given files (relative to rootDir) and
 * return the subset that contain a `.cartographignore` marker. Anything
 * under one of these directories should be excluded.
 *
 * Called by `scanDirectory`, `scanDirectoryAsync`, and `getGitChangedFiles`
 * so the git-driven paths honor the marker the same way the filesystem
 * walk fallback does. Without this the marker had inconsistent behavior:
 * respected on non-git projects, silently ignored on git ones.
 */
function findCartographIgnoredDirs(rootDir: string, files: Iterable<string>): Set<string> {
  const dirs = new Set<string>(['.']);
  for (const file of files) {
    let dir = path.posix.dirname(normalizePath(file));
    while (dir && dir !== '.' && dir !== '/') {
      if (dirs.has(dir)) break; // already enumerated this branch
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }

  const ignored = new Set<string>();
  for (const dir of dirs) {
    const marker =
      dir === '.' ? path.join(rootDir, CARTOGRAPH_IGNORE_MARKER) : path.join(rootDir, dir, CARTOGRAPH_IGNORE_MARKER);
    if (fs.existsSync(marker)) ignored.add(dir);
  }
  return ignored;
}

/**
 * True if `filePath` (relative, forward-slashed) lives under any directory
 * in `ignoredDirs`. Directory `.` matches the project root.
 */
function isUnderCartographIgnoredDir(filePath: string, ignoredDirs: Set<string>): boolean {
  if (ignoredDirs.size === 0) return false;
  if (ignoredDirs.has('.')) return true;
  let dir = path.posix.dirname(filePath);
  while (dir && dir !== '.' && dir !== '/') {
    if (ignoredDirs.has(dir)) return true;
    dir = path.posix.dirname(dir);
  }
  return false;
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
  const files: string[] = [];
  let count = 0;
  for (const filePath of gitFiles) {
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
  for (const filePath of gitFiles) {
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
  if (fs.existsSync(path.join(dir, CARTOGRAPH_IGNORE_MARKER))) {
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

/** `realpath` with debug-log on failure. */
function safeRealpath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    logDebug('Skipping unresolvable directory', { dir });
    return null;
  }
}

/** `readdirSync(withFileTypes)` with debug-log on failure. */
function safeReaddir(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    logDebug('Skipping unreadable directory', { dir, error: String(error) });
    return null;
  }
}

/**
 * Match `relativePath` against the configured exclude patterns. Tests both
 * the bare path and a `${path}/` form so directory-anchored patterns
 * (`node_modules/`) match correctly.
 */
function isDirExcluded(relativePath: string, exclude: readonly string[]): boolean {
  const dirPattern = relativePath + '/';
  for (const pattern of exclude) {
    if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Returned by `eoSetupParseEnvironment` — pool handle (null when no
 * worker available), the parse-request thunk, the worker-recycle
 * thunk, and a flag the retry pass uses to short-circuit when a
 * worker isn't available to retry into.
 */
export interface ParseEnvironment {
  pool: ParseWorkerPool | null;
  requestParse: (filePath: string, content: string) => Promise<ExtractionResult>;
  recycleWorker: () => Promise<void>;
  hasWorker: boolean;
  /** Effective pool size after clamps + caller overrides. 0 when no
   *  worker is available (the in-process fallback path). Consumed by
   *  `eoRunParseAndStoreLoop` to size its inflight cap so the pool
   *  always has prefetched work and never starves. */
  poolSize: number;
  /** Snapshot accessor for files that crossed `SLOW_PARSE_WARN_MS`.
   *  Returns `[]` in the in-process fallback path (no pool). Consumed
   *  by the indexAll log printer to render an end-of-phase summary
   *  table — B13 (2026-05-23). */
  getSlowFiles: () => ReadonlyArray<import('./parse-worker-pool.js').SlowFileRecord>;
}

interface BuildParsePoolArgs {
  WorkerClass: typeof import('worker_threads').Worker;
  parseWorkerPath: string;
  poolSize: number;
  neededLanguages: Language[];
  recycleInterval: number;
  log: (msg: string) => void;
}

/** Construct the parse-worker pool. Pulled out of {@link
 *  eoSetupParseEnvironment} so the conditional doesn't roll up a
 *  complex_conditional finding. */
export function buildParsePool(args: BuildParsePoolArgs): ParseWorkerPool {
  return new ParseWorkerPool({
    WorkerClass: args.WorkerClass,
    parseWorkerPath: args.parseWorkerPath,
    poolSize: args.poolSize,
    neededLanguages: args.neededLanguages,
    recycleInterval: args.recycleInterval,
    log: args.log,
    logWarn,
  });
}

/**
 * Immutable dependencies + mutable cache-hit ref threaded through all
 * module-scope `eo*` helpers. The `cacheHits` object is a shared mutable
 * ref so helpers can increment the counter without returning it — the class
 * instance reads `this.cacheHitsRef.count` directly.
 */
export interface ExtractionOrchestratorState {
  rootDir: string;
  config: CartographConfig;
  queries: QueryBuilder;
  /** Shared mutable counter — same object as `ExtractionOrchestrator.cacheHitsRef`. */
  cacheHits: { count: number };
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private config: CartographConfig;
  private queries: QueryBuilder;
  /** Mutable ref object shared with the `ExtractionOrchestratorState` returned
   *  by `state()`. Module-scope helpers increment `cacheHits.count` directly;
   *  `resetParseCacheHits` / `getParseCacheHits` read/write the same object. */
  private readonly cacheHitsRef = { count: 0 };

  constructor(rootDir: string, config: CartographConfig, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.config = config;
    this.queries = queries;
  }

  /** Snapshot of immutable deps + mutable cache-hit ref, threaded into `eo*` helpers. */
  private state(): ExtractionOrchestratorState {
    return { rootDir: this.rootDir, config: this.config, queries: this.queries, cacheHits: this.cacheHitsRef };
  }

  /** Reset the per-pass parse-cache hit counter. */
  resetParseCacheHits(): void {
    this.cacheHitsRef.count = 0;
  }

  /** Read the per-pass parse-cache hit counter. */
  getParseCacheHits(): number {
    return this.cacheHitsRef.count;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    args: {
      onProgress?: (progress: IndexProgress) => void;
      signal?: AbortSignal;
      verbose?: boolean;
      parseWorkers?: number;
    } = {},
  ): Promise<IndexResult> {
    const { onProgress, signal, verbose, parseWorkers } = args;
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const log = verbose
      ? (msg: string) => {
          process.stdout.write(`[worker] ${msg}\n`);
        }
      : (_msg: string) => {};

    this.resetParseCacheHits();
    const st = this.state();
    // F#12 slice 1: export per-extraction env vars from config BEFORE
    // the worker pool spawns inside eoRunIndexParseAndStorePhase, so
    // workers inherit the right values.
    eoApplyExtractionEnvFromConfig(st);
    const { files, scanMs } = await eoScanFilesForIndex(st, onProgress);
    if (signal?.aborted) return eoAbortIndexResult(startTime, []);

    const counters: EoIndexCounters = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      totalNodes: 0,
      totalEdges: 0,
      processed: 0,
    };
    // Defer per-row FTS5 / R*Tree trigger maintenance for the bulk
    // store. A full indexAll repopulates `nodes` wholesale, so the
    // derived indexes are rebuilt once at the end (see deferred-index.ts)
    // instead of row-by-row — measured ~70% of node-store wall-clock.
    // finalize runs from a `finally` so the triggers are always restored.
    const deferredIndex = deferNodeDerivedIndexes(st.queries.db);
    let aborted = false;
    let parseStoreMs = 0;
    let retryMs = 0;
    try {
      const env = await eoRunIndexParseAndStorePhase(st, {
        files,
        counters,
        errors,
        onProgress,
        signal,
        log,
        parseWorkers,
      });
      parseStoreMs = env.parseStoreMs;
      const { pool } = env;
      if (env.aborted) {
        aborted = true;
        if (pool) await pool.terminate('Aborted');
      } else {
        retryMs = await eoRunIndexRetryPhase(st, { counters, errors, env, signal, log });
        if (pool) await pool.terminate('Indexing complete');
        eoStampPostIndexBaseline(st);

        // LRU eviction once per pass so the cache table can't grow
        // without bound on long-lived projects. Cheap when under the
        // cap (one COUNT(*) probe). When over, drops the oldest 25%.
        const evicted = evictParseCacheIfOversized(st.queries);
        if (st.cacheHits.count > 0 || evicted > 0) {
          logDebug('parse_cache: pass summary', { hits: st.cacheHits.count, evicted });
        }
      }
    } finally {
      finalizeDeferredNodeIndexes(st.queries.db, deferredIndex);
    }

    if (aborted) return eoAbortIndexResult(startTime, errors, counters);
    return eoFinalIndexResult({ counters, errors, totalMs: Date.now() - startTime, scanMs, parseStoreMs, retryMs });
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    // Symlink-aware validation: a regular-looking path that resolves
    // outside the root via symlink (or `..` segments) is rejected here
    // so neither the read below nor the DB write below it can leak
    // off-tree content.
    const fullPath = validatePathWithinRootReal(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Path traversal blocked: ${relativePath}`,
            filePath: relativePath,
            severity: 'error',
            code: 'path_traversal',
          },
        ],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${errMsg(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult> {
    // Symlink-aware traversal check before the path lands in the DB.
    // The content was already read upstream via the parallel batch
    // reader; this is the chokepoint that decides whether a symlink-
    // pointing-outside-root path is allowed to be persisted.
    const fullPath = validatePathWithinRootReal(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return emptyExtractionResult([
        { message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' },
      ]);
    }

    // Check file size
    if (stats.size > this.config.maxFileSize) {
      return emptyExtractionResult([
        {
          message: `File exceeds max size (${stats.size} > ${this.config.maxFileSize})`,
          filePath: relativePath,
          severity: 'warning',
          code: 'size_exceeded',
        },
      ]);
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return emptyExtractionResult();
    }

    // F#49 (2026-05-26): apply the same minification skip the indexAll
    // path uses (see `eoProcessOneFile` in extraction-phases.ts). Without
    // this, a newly-added minified JS file landing through the
    // small-batch sync path would slip through here even though a full
    // reindex would filter it. Reviewer-caught coverage gap.
    if (isMinifiedJsFamily(language, content)) {
      return emptyExtractionResult([
        {
          message: `Skipped likely-minified ${language} file (avg line length > 200 chars)`,
          filePath: relativePath,
          severity: 'warning',
          code: 'minified_skip',
        },
      ]);
    }

    // Extract from source
    const result = extractFromSource(relativePath, content, language);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      eoStoreExtractionResult(this.state(), { filePath: relativePath, content, language, stats, result });
    }

    return result;
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars();
    const startTime = Date.now();
    onProgress?.({ phase: 'scanning', current: 0, total: 0 });

    const state: SyncState = {
      filesToIndex: [],
      changedFilePaths: [],
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: 0,
    };

    const lastSyncedHead = getMetadata(this.queries, LAST_SYNCED_HEAD_KEY);
    const gitResult = getGitChangedFiles(this.rootDir, this.config, lastSyncedHead);
    const currentHead = gitResult?.currentHead ?? null;
    // When the last-synced HEAD is unreachable we drop to the filesystem
    // fallback, which uses on-disk hashes and is correct regardless of git.
    const gitChanges = gitResult && !gitResult.needsFullReindex ? gitResult.changes : null;

    const st = this.state();
    // F#12 slice 1: same env-var export as the indexAll path so any
    // bulk re-extract spawned via `eoIndexChangedFiles` inherits the
    // configured threshold.
    eoApplyExtractionEnvFromConfig(st);
    eoApplySyncChanges(st, gitChanges, state);
    await eoIndexChangedFiles({ orch: this, st, state, ...(onProgress ? { onProgress } : {}) });

    // Persist current HEAD so the next sync can detect HEAD-moving git
    // operations (merge, pull, checkout, rebase, reset, post-commit) even
    // when they leave the working tree clean.
    if (currentHead) setMetadata(st.queries, LAST_SYNCED_HEAD_KEY, currentHead);
    eoStampFreshness(st);

    return compact({
      filesChecked: state.filesChecked,
      filesAdded: state.filesAdded,
      filesModified: state.filesModified,
      filesRemoved: state.filesRemoved,
      nodesUpdated: state.nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: state.changedFilePaths.length > 0 ? state.changedFilePaths : undefined,
    });
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const st = this.state();
    const lastSyncedHead = getMetadata(st.queries, LAST_SYNCED_HEAD_KEY);
    const gitResult = getGitChangedFiles(st.rootDir, st.config, lastSyncedHead);
    // Unreachable last-synced HEAD → drop to the filesystem fallback, which
    // is correct regardless of git history state.
    const gitChanges = gitResult && !gitResult.needsFullReindex ? gitResult.changes : null;

    const changes = gitChanges ? eoCollectGitChanges(st, gitChanges) : eoCollectFullScanChanges(st);
    // Heal-flag union (only meaningful on the git fast-path; the full-scan
    // path already reads needs_reextract via eoClassifyFileChange). The
    // EXTRACTION_LOGIC_VERSION self-heal sets the flag on every file when
    // the extractor's emit-set changes — git reports those files as
    // unchanged because disk content didn't move, so without this union
    // the heal silently no-ops in any git-tracked project.
    if (gitChanges) {
      const flagged = getFilesNeedingReextract(st.queries);
      if (flagged.length > 0) {
        const seen = new Set<string>([...changes.added, ...changes.modified, ...changes.removed]);
        for (const path of flagged) {
          if (!seen.has(path)) changes.modified.push(path);
        }
      }
    }
    return changes;
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter.js';
export {
  detectLanguage,
  isLanguageSupported,
  isGrammarLoaded,
  getSupportedLanguages,
  initGrammars,
  loadGrammarsForLanguages,
  loadAllGrammars,
} from './grammars.js';
