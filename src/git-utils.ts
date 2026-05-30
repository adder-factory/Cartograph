import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARTOGRAPH_DIR, PROJECT_GITIGNORE_COMMENT, PROJECT_GITIGNORE_ENTRY } from './directory.js';

const GIT_EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  timeout: 5000,
  stdio: ['pipe', 'pipe', 'pipe'] as ('pipe' | 'inherit' | 'ignore')[],
};

/** First valid 1-based line number — anything lower is rejected as input. */
const FIRST_LINE_NUMBER = 1;

/**
 * True when `filePath` is inside the `.cartograph/` index directory.
 * Anything under it (`cartograph.db`, WAL/SHM sidecars, `config.json`,
 * `cache/`, logs) is cartograph's own metadata, never project source —
 * a fresh repo that hasn't gitignored `.cartograph/` would otherwise
 * surface the index DB as an untracked "change" in every git-derived
 * changed-file set.
 *
 * Path-segment match (not substring) so a legitimate source file like
 * `src/.cartograph-helper.ts` or `docs/dot-cartograph.md` is never
 * dropped. Accepts both `/`- and `\`-separated paths. Robust to a
 * gitignore-less repo — the filter is structural, not gitignore-driven.
 */
export function isCartographMetaPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/);
  return segments.includes(CARTOGRAPH_DIR);
}

/** Abbreviate a commit SHA for display. Default 12 chars — long enough
 *  to stay unambiguous in any realistic repo, short enough to scan.
 *  Tolerant of already-short or empty input (returns it unchanged). */
export function shortSha(sha: string, len = 12): string {
  return sha.slice(0, len);
}
/** Buffer cap for git log output — 5 MB covers any realistic line-history scan. */
const GIT_LOG_BUFFER_BYTES = 5 * 1024 * 1024;
/** ASCII Unit Separator — used inside `--format` so field text can contain spaces / pipes. */
const GIT_FORMAT_FIELD_SEP = '\x1f';
/** Per-commit format spec for the line-history scan: sha | shortSha | author | iso-date | subject. */
const LINE_HISTORY_FORMAT_SPEC = `%H${GIT_FORMAT_FIELD_SEP}%h${GIT_FORMAT_FIELD_SEP}%an${GIT_FORMAT_FIELD_SEP}%aI${GIT_FORMAT_FIELD_SEP}%s`;
/** Number of fields produced by {@link LINE_HISTORY_FORMAT_SPEC}. */
const LINE_HISTORY_EXPECTED_FIELDS = 5;

export function getCurrentHeadSha(rootDir: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    }).trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Absolute, symlink-resolved toplevel of the git working tree that
 * `dir` belongs to, or `null` when `dir` isn't inside a git repo (or
 * git is missing). `git rev-parse --show-toplevel` returns the
 * per-worktree root: the main checkout and each linked worktree
 * report their own distinct directory — the property F#58
 * `detectBorrowedWorktreeIndex` relies on.
 *
 * F#58 (2026-05-26 — upstream issue #155). Co-located with the
 * other git helpers rather than spun out into its own file: it's
 * the same `git rev-parse` shape and shares `GIT_EXEC_OPTIONS`.
 */
export function gitWorktreeRoot(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      ...GIT_EXEC_OPTIONS,
      cwd: dir,
    }).trim();
    return out ? safeRealpath(out) : null;
  } catch {
    return null;
  }
}

/** Resolve symlinks where possible so tmp-dir realpath quirks (macOS
 *  `/var` ↔ `/private/var`) don't break worktree-root equality. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export interface BorrowedWorktreeIndex {
  /** The git working tree the request originated from. */
  worktreeRoot: string;
  /** The (different) working tree whose `.cartograph` index is being used. */
  indexRoot: string;
}

/**
 * Detect when a tool call runs from one git worktree but the resolved
 * `.cartograph/` index belongs to a *different* working tree. Common
 * trigger: agent tools that place worktrees under gitignored paths
 * like `.claude/worktrees/<name>/` — the `findNearestCartographRoot`
 * upward walk silently resolves the MAIN checkout's index instead of
 * the nested worktree's, and queries reflect that tree's branch
 * (usually different) — symbols changed only in the worktree are
 * invisible and nothing surfaces the mismatch.
 *
 * Best-effort. Returns `null` ("nothing to warn about") when:
 *   - `startPath` isn't in a git repo (or git is missing),
 *   - the index already lives in `startPath`'s own working tree,
 *   - `indexRoot` isn't itself a real working-tree root (an
 *     unrelated ancestor that merely happens to contain a
 *     `.cartograph/`) — keeps non-git and plain-ancestor layouts from
 *     producing false warnings, OR
 *   - `indexRoot` is not an ancestor of `startPath`. The F#58
 *     "borrowed" scenario by definition has the index living ABOVE
 *     the caller's working directory (the upward-walk finds it).
 *     A completely unrelated `indexRoot` (e.g. a test temp dir with
 *     its own git init, while `process.cwd()` is the cartograph dev
 *     repo) is not a "borrowed" situation — the caller explicitly
 *     targeted a foreign project, typically via an injected
 *     `Cartograph` instance or an explicit `projectPath`. Suppress.
 */
export function detectBorrowedWorktreeIndex(startPath: string, indexRoot: string): BorrowedWorktreeIndex | null {
  const worktreeRoot = gitWorktreeRoot(startPath);
  if (!worktreeRoot) return null;

  const resolvedIndexRoot = safeRealpath(indexRoot);
  if (worktreeRoot === resolvedIndexRoot) return null;

  // Index dir must itself be a working-tree root, otherwise it's an
  // unrelated ancestor and the "borrowed" framing doesn't apply.
  if (gitWorktreeRoot(resolvedIndexRoot) !== resolvedIndexRoot) return null;

  // F#58 by construction: the index was found via upward walk from
  // `startPath`, so its directory MUST be an ancestor of `startPath`.
  // When it isn't, the caller explicitly targeted a foreign project
  // (injected `Cartograph` instance, explicit `projectPath` arg pointing
  // elsewhere) — suppress the banner, since the F#58 "I didn't realize
  // I borrowed my parent's index" surprise isn't what's happening.
  if (!isAncestorPath(resolvedIndexRoot, safeRealpath(startPath))) return null;

  return { worktreeRoot, indexRoot: resolvedIndexRoot };
}

/** True when `ancestor` is `descendant` or a prefix path of it
 *  (separator-aware so `/a/bcd` doesn't count as a child of `/a/b`). */
function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return descendant.startsWith(prefix);
}

/** Compact, single-line banner naming the borrowed index and the fix.
 *  Prepended to every read-tool response when a mismatch is detected
 *  so the agent learns which worktree's code it's actually seeing. */
export function borrowedWorktreeBanner(mismatch: BorrowedWorktreeIndex): string {
  return (
    `⚠ Cartograph results come from a different git worktree (${mismatch.indexRoot}), ` +
    `not where you're working (${mismatch.worktreeRoot}) — they may reflect another branch, ` +
    `and symbols changed only here are missing. Run \`cartograph admin init\` here for a ` +
    `worktree-local index.`
  );
}

/** Return the total number of commits reachable from HEAD, or `null`
 *  when not in a git repo. Used by cochange/churn hooks to short-
 *  circuit on shallow clones (commit_count = 1) where the miners
 *  would do work that produces no meaningful output. B23
 *  (2026-05-24). */
export function gitCommitCount(rootDir: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Per-process cache for {@link isShallowClone}. Keyed by absolute
 * projectRoot. Safe to cache for the process lifetime: a shallow
 * clone becomes a full clone only via `git fetch --unshallow`, which
 * requires a deliberate user action outside of cartograph.
 */
const shallowCloneCache = new Map<string, boolean>();

/**
 * Returns `true` when `projectRoot` is a shallow git clone
 * (`git clone --depth N`). In a shallow clone the local history
 * is truncated, so churn mining produces `commit_count = 0` for
 * every file — not because the files are unchanged, but because
 * git doesn't have the history to count commits.
 *
 * Uses `git rev-parse --is-shallow-repository` (exits 0, prints
 * "true" or "false"). Returns `false` on any git error or when
 * the directory is not a git repo. Result is cached per projectRoot
 * for the process lifetime.
 */
export function isShallowClone(projectRoot: string): boolean {
  const cached = shallowCloneCache.get(projectRoot);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      ...GIT_EXEC_OPTIONS,
      cwd: projectRoot,
    }).trim();
    const result = out === 'true';
    shallowCloneCache.set(projectRoot, result);
    return result;
  } catch {
    shallowCloneCache.set(projectRoot, false);
    return false;
  }
}

/**
 * True when the git working tree has any uncommitted or untracked
 * change to project source. The `.cartograph/` index directory is
 * excluded — it is cartograph's own metadata (often not gitignored),
 * never a real source change. Modifications to the project root's
 * `.gitignore` that ONLY add cartograph's own append (the comment +
 * `.cartograph/` entry that `init` wrote) are also excluded — F#32,
 * without this filter every fresh init poisons every subsequent
 * empty-result freshness warning with a phantom "uncommitted changes"
 * banner that the user can't clear without committing cartograph's
 * own edit.
 *
 * Used to hedge "true negative" claims on empty query results:
 * {@link getFreshnessInfo} compares only the indexed-vs-current HEAD
 * SHA and deliberately ignores working-tree drift, so a just-created
 * or just-edited file (or one the file watcher has not synced yet) is
 * invisible to its `isStale` signal. Best-effort — returns false for a
 * non-git directory or on any git error.
 */
export function hasUncommittedChanges(rootDir: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    });
    const dirtyPaths: string[] = [];
    for (const line of out.split('\n')) {
      if (line.trim().length === 0) continue;
      // Porcelain v1 line: "XY <path>" (or "XY <old> -> <new>" for a
      // rename). Imperfect path extraction errs toward "dirty" — the
      // safe direction for a freshness hedge.
      const filePath = line.slice(3).trim();
      if (filePath.length > 0 && !isCartographMetaPath(filePath)) dirtyPaths.push(filePath);
    }
    if (dirtyPaths.length === 0) return false;
    if (dirtyPaths.length === 1 && dirtyPaths[0] === '.gitignore' && isCartographOnlyGitignoreDiff(rootDir)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when the project's `.gitignore` is either:
 *   - A modified-but-tracked file whose working-tree diff consists
 *     EXCLUSIVELY of cartograph's init-time append (the comment + the
 *     `.cartograph/` entry, with no removals and no other additions), OR
 *   - An untracked file whose ENTIRE content is exactly the two-line
 *     block `init` writes when no prior `.gitignore` existed.
 *
 * Used to suppress F#32's phantom-uncommitted-changes freshness warning.
 * Safe direction on parse failure is "not cartograph-only" so the warning
 * stays on; we'd rather over-warn than hide a real uncommitted edit.
 */
function isCartographOnlyGitignoreDiff(rootDir: string): boolean {
  let diff: string;
  try {
    diff = execFileSync('git', ['diff', '--no-color', '-U0', '--', '.gitignore'], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    });
  } catch {
    return false;
  }
  // Diff is empty on untracked files. Init writes exactly the
  // two-line block when creating `.gitignore` from scratch; verify
  // the file's whole content matches.
  if (diff.length === 0) {
    try {
      const content = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf-8');
      return content === `${PROJECT_GITIGNORE_COMMENT}\n${PROJECT_GITIGNORE_ENTRY}\n`;
    } catch {
      return false;
    }
  }
  let sawCartographAdd = false;
  for (const line of diff.split('\n')) {
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@')
    ) {
      continue;
    }
    if (line.startsWith('-')) return false; // any removal disqualifies
    if (line.startsWith('+')) {
      const added = line.slice(1).trim();
      if (added === '' || added === PROJECT_GITIGNORE_COMMENT || added === PROJECT_GITIGNORE_ENTRY) {
        sawCartographAdd = true;
        continue;
      }
      return false; // any other addition disqualifies
    }
  }
  return sawCartographAdd;
}

export interface ChangeBreakdown {
  added: number;
  modified: number;
  deleted: number;
  total: number;
}

/**
 * Count distinct files that differ between the indexed sha and the
 * current working tree, broken down by change type. Includes:
 *   - committed changes since `sha` (sha..HEAD) — git's tree diff is
 *     already revert-aware (a file changed then reverted has no entry).
 *   - staged + unstaged modifications (working-tree state vs HEAD)
 *   - untracked files (always counted as `added`)
 *
 * Paths from all sources are merged so a file edited locally and also
 * touched in a later commit doesn't double-count; the worst-impact
 * category wins (deleted > added > modified) so the breakdown reflects
 * what would surprise the indexer most.
 *
 * Returns null if git is unavailable.
 */
type ChangeKind = 'added' | 'modified' | 'deleted';
const CHANGE_RANK: Record<ChangeKind, number> = { modified: 0, added: 1, deleted: 2 };

/**
 * Merge a path's change kind into the running map. When a path
 * appears more than once, the worst-impact category wins
 * (deleted > added > modified) so the breakdown reflects what would
 * surprise the indexer most.
 *
 * Paths inside `.cartograph/` are dropped here — it's cartograph's own
 * index metadata and never project source, so it must not pollute any
 * git-derived changed-file set even when the repo hasn't gitignored it.
 */
function bumpChange(byPath: Map<string, ChangeKind>, p: string, kind: ChangeKind): void {
  if (isCartographMetaPath(p)) return;
  const existing = byPath.get(p);
  if (!existing) {
    byPath.set(p, kind);
    return;
  }
  if (CHANGE_RANK[kind] > CHANGE_RANK[existing]) byPath.set(p, kind);
}

/**
 * Parse `git diff --name-status sha..HEAD` into the path → kind map.
 * Returns false on git failure (caller treats this as "git is
 * unavailable" — a missing committed-diff is fatal because the
 * function's whole point is "what changed since `sha`").
 *
 * Format: `STATUS\tpath` for most statuses, `Rxxx\told\tnew` for
 * renames and copies. Codes:
 *   A,C → added
 *   D   → deleted
 *   M,R,T,U,X → modified
 */
/**
 * Classify one `git diff --name-status` line. Format:
 *   `STATUS\tpath` for most statuses
 *   `Rxxx\told\tnew` for renames; `Cxxx\told\tnew` for copies
 * Status codes: A,C → added; D → deleted; everything else (M,R,T,U,X) → modified.
 */
function classifyDiffLine(line: string, byPath: Map<string, ChangeKind>): void {
  if (!line.trim()) return;
  const parts = line.split('\t');
  const code = parts[0]!.charAt(0);
  const isRenameOrCopy = code === 'R' || code === 'C';
  const p = isRenameOrCopy ? parts[2]! : parts[1]!;
  if (!p) return;
  if (code === 'A' || code === 'C') bumpChange(byPath, p, 'added');
  else if (code === 'D') bumpChange(byPath, p, 'deleted');
  else bumpChange(byPath, p, 'modified');
}

function parseGitDiffNameStatus(rootDir: string, sha: string, byPath: Map<string, ChangeKind>): boolean {
  try {
    const committed = execFileSync('git', ['diff', '--name-status', `${sha}..HEAD`], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    });
    for (const line of committed.split('\n')) classifyDiffLine(line, byPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `git status --porcelain -uall` and merge into the running
 * map. Best-effort — failures are swallowed since uncommitted-state
 * data is additive on top of the committed diff.
 *
 * Porcelain v1 minimum line is "XY P" (4 chars). The 4-char guard
 * skips empty lines and (defensively) any malformed truncated
 * output. Single-char filenames still fit because porcelain uses a
 * SPACE separator, not a tab.
 */
/**
 * Classify one `git status --porcelain` line. Skips short / malformed
 * lines defensively. The 4-char minimum guard handles the smallest
 * valid line (`XY P` for a single-char filename); it also drops any
 * truncated output that would otherwise crash the slice.
 */
function classifyPorcelainLine(line: string, byPath: Map<string, ChangeKind>): void {
  if (line.length < 4) return;
  const xy = line.slice(0, 2);
  const p = line.includes(' -> ') ? line.split(' -> ')[1]!.trim() : line.slice(3).trim();
  if (!p) return;
  if (xy === '??') bumpChange(byPath, p, 'added');
  else if (xy.includes('D')) bumpChange(byPath, p, 'deleted');
  else if (xy.includes('A')) bumpChange(byPath, p, 'added');
  else bumpChange(byPath, p, 'modified');
}

function parseGitStatusPorcelain(rootDir: string, byPath: Map<string, ChangeKind>): void {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '-uall'], { ...GIT_EXEC_OPTIONS, cwd: rootDir });
    for (const line of status.split('\n')) classifyPorcelainLine(line, byPath);
  } catch {
    // Status is best-effort.
  }
}

export function getChangeBreakdownSince(rootDir: string, sha: string): ChangeBreakdown | null {
  const byPath = new Map<string, ChangeKind>();
  if (!parseGitDiffNameStatus(rootDir, sha, byPath)) return null;
  parseGitStatusPorcelain(rootDir, byPath);
  let added = 0,
    modified = 0,
    deleted = 0;
  for (const kind of byPath.values()) {
    if (kind === 'added') added++;
    else if (kind === 'deleted') deleted++;
    else modified++;
  }
  return { added, modified, deleted, total: byPath.size };
}

/**
 * Count commits between `sha` and HEAD. Useful as a coarser drift signal
 * than file count — survives noise from large refactors.
 */
export function countCommitsAhead(rootDir: string, sha: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${sha}..HEAD`], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface CommitMeta {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
}

/**
 * History of a specific line range within a file, newest-first. Uses
 * `git log -L start,end:file` so the result tracks commits that
 * actually touched the symbol's body — not just the file. Note: `-L`
 * does NOT follow renames; the history terminates at whichever
 * commit first introduced the file at its current path. Acceptable
 * for the MVP blame use case.
 *
 * Returns an empty array when git fails (no repo / bad path / range
 * out of bounds) so the caller can fall back gracefully.
 */
interface GetLineRangeHistoryArgs {
  rootDir: string;
  relPath: string;
  startLine: number;
  endLine: number;
  limit: number;
}

export function getLineRangeHistory(args: GetLineRangeHistoryArgs): CommitMeta[] {
  const { rootDir, relPath, startLine, endLine, limit } = args;
  if (startLine < FIRST_LINE_NUMBER || endLine < startLine) return [];
  try {
    const out = execFileSync(
      'git',
      [
        'log',
        `-L${startLine},${endLine}:${relPath}`,
        '-s',
        `--format=${LINE_HISTORY_FORMAT_SPEC}`,
        `--max-count=${limit}`,
      ],
      { ...GIT_EXEC_OPTIONS, cwd: rootDir, maxBuffer: GIT_LOG_BUFFER_BYTES },
    );
    const result: CommitMeta[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(GIT_FORMAT_FIELD_SEP);
      if (parts.length < LINE_HISTORY_EXPECTED_FIELDS) continue;
      const [sha, shortSha, author, dateIso, subject] = parts;
      result.push({
        sha: sha!,
        shortSha: shortSha!,
        author: author!,
        dateIso: dateIso!,
        subject: subject!,
      });
    }
    return result;
  } catch {
    return [];
  }
}

/** Timeout in milliseconds for the rename-aware follow log call. */
const FILE_FOLLOW_TIMEOUT_MS = 5000;

/**
 * Detect whether a file has ever lived under a different path by walking
 * the rename-aware `git log --follow` history and collecting every distinct
 * filename that appears in the `--name-only` output.
 *
 * Returns true when the file has more than one distinct historical path
 * (i.e. it was renamed at least once). Returns false on git errors / no
 * repo / no commits — fail-safe: an unknown state must not trigger a
 * spurious warning.
 */
export function fileWasEverRenamed(rootDir: string, relPath: string): boolean {
  try {
    const out = execFileSync('git', ['log', '--follow', '--name-only', '--format=', '--', relPath], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
      timeout: FILE_FOLLOW_TIMEOUT_MS,
      maxBuffer: GIT_LOG_BUFFER_BYTES,
    });
    // Each commit emits a blank separator line then the file path it had
    // at that commit. The trailing `-- relPath` pathspec restricts
    // `--name-only` to the followed file itself — sibling files changed
    // in the same commit do NOT appear — so the distinct set contains
    // only the names this one file has been known by.
    const distinctPaths = new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    return distinctPaths.size > 1;
  } catch {
    // Git unavailable, not a repo, or timeout — treat as "no rename known".
    return false;
  }
}

/**
 * Retrieve the rename-aware commit history for a file path using
 * `git log --follow`. Returns the ISO timestamp of the earliest
 * commit in that history, or null when git is unavailable / not a
 * repo / no commits found.
 *
 * This is a secondary, cheap call used by blame to detect whether the
 * line-range timeline was truncated at a rename. We only need the
 * oldest timestamp — just the date field — so output is minimal.
 */
export function getFileFollowEarliestTs(rootDir: string, relPath: string): string | null {
  try {
    const out = execFileSync('git', ['log', '--follow', '--format=%aI', '--', relPath], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
      timeout: FILE_FOLLOW_TIMEOUT_MS,
      maxBuffer: GIT_LOG_BUFFER_BYTES,
    });
    // Output is newest-first ISO dates, one per line. The last non-empty
    // line is the oldest commit.
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify that a stored SHA is still reachable from HEAD. After
 * force-push or `git gc` it can disappear, in which case incremental
 * mining would silently miss commits.
 */
export function isShaReachable(rootDir: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: rootDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file's contents at a specific git ref. Returns null when the
 * file didn't exist at that ref (or git is unavailable / ref invalid)
 * — callers must treat null as "absent at baseline" rather than empty.
 *
 * Buffer cap (5MB) protects against pathological binary blobs; real
 * source files are well under it. Errors are swallowed because every
 * failure mode here ("ref not found", "file not in tree", "git
 * missing") collapses to the same caller-visible signal.
 */
export function getFileAtRef(rootDir: string, ref: string, relPath: string): string | null {
  try {
    const out = execFileSync('git', ['show', `${ref}:${relPath}`], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
      maxBuffer: GIT_LOG_BUFFER_BYTES,
    });
    return out;
  } catch {
    return null;
  }
}

/**
 * List paths (relative to rootDir) that differ between `ref` and the
 * current working tree — including committed `ref..HEAD` changes,
 * staged + unstaged modifications, and untracked files. Used by
 * compareToRef to bound the symbol-diff scan to the files the user
 * actually touched. Returns null when git isn't available; an empty
 * array means "git works, nothing changed".
 *
 * `git diff <ref>` (no commit range) compares `ref` directly to the
 * working tree, so committed + staged + unstaged all surface in one
 * pass; `--no-renames` disables heuristic rename detection so a
 * `git mv old.ts new.ts` shows up as `D old.ts` + `A new.ts`. That's
 * the right shape for compareToRef: the symbol diff then naturally
 * reads "old.ts symbols removed, new.ts symbols added", which is the
 * agent's mental model of a rename. Preserving the rename would let
 * us claim no symbol-level change even though the file's path moved.
 *
 * Untracked files aren't visible to `git diff` and need a second
 * `ls-files --others --exclude-standard` pass.
 */
export function listChangedFilesSince(rootDir: string, ref: string): string[] | null {
  const byPath = new Map<string, ChangeKind>();
  try {
    const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', ref], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    });
    for (const line of diff.split('\n')) classifyDiffLine(line, byPath);
  } catch {
    return null;
  }
  try {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      ...GIT_EXEC_OPTIONS,
      cwd: rootDir,
    });
    for (const line of untracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) bumpChange(byPath, trimmed, 'added');
    }
  } catch {
    // Untracked-file list is best-effort; git diff already covered
    // the tracked + modified set.
  }
  return [...byPath.keys()];
}

/** Per-chunk SHA count for {@link getCommitSubjects} — bounds the
 *  `git log` argv length on a large unknown-residue set. */
const COMMIT_SUBJECT_CHUNK = 500;
/** `git log` subprocess timeout for the subject fetch. */
const GIT_LOG_TIMEOUT_MS = 30_000;
/** Output buffer ceiling for the `git log` subprocess (64 MiB). */
const GIT_LOG_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** A full git SHA-1 is 40 lowercase hex characters. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Fetch the subject line of each given commit SHA via `git log
 * --no-walk`. Feeds the background commit-intent residue pass.
 *
 * SHAs no longer reachable (rebased away) are skipped via
 * `--ignore-missing`; a chunk whose `git log` fails entirely is
 * skipped (those commits just stay `unknown`). Records use `\x1f`
 * (unit sep) / `\x1e` (record sep) — control chars that never appear
 * in a commit subject — so parsing is unambiguous.
 */
export function getCommitSubjects(rootDir: string, shas: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < shas.length; i += COMMIT_SUBJECT_CHUNK) {
    const chunk = shas.slice(i, i + COMMIT_SUBJECT_CHUNK);
    let raw: string;
    try {
      raw = execFileSync('git', ['log', '--no-walk', '--ignore-missing', '--format=tformat:%H%x1f%s%x1e', ...chunk], {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: GIT_LOG_TIMEOUT_MS,
        maxBuffer: GIT_LOG_MAX_BUFFER_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      continue;
    }
    for (const rec of raw.split('\x1e')) {
      const sep = rec.indexOf('\x1f');
      if (sep < 0) continue;
      const sha = rec.slice(0, sep).trim();
      const subject = rec.slice(sep + 1).trim();
      if (FULL_SHA_RE.test(sha) && subject) out.set(sha, subject);
    }
  }
  return out;
}
