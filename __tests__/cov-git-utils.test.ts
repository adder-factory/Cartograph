/**
 * Coverage suite for `src/git-utils.ts`.
 *
 * Two flavours of test here:
 *   - Pure helpers (`isCartographMetaPath`, `shortSha`, `resolveGitBinary`,
 *     `borrowedWorktreeBanner`) are exercised directly with constructed input.
 *   - Every git-backed helper is driven against a REAL temporary git repo
 *     (`git init` + commits) so the assertions are over real `git` output,
 *     not mocks. Each repo is created under the OS tmp dir and removed in a
 *     `finally` / `afterEach`.
 *
 * The module's option-injection guard is `--end-of-options`: user-controlled
 * ref / sha values (e.g. `${sha}..HEAD`, `${ref}`, `${sha}^{commit}`) are
 * passed AFTER `--end-of-options`, so a value that begins with `-` is parsed
 * as an operand, never as a git flag. The dedicated tests below assert that a
 * `--malicious`-shaped ref does not execute an unexpected git option and is
 * handled as "not found" rather than altering behaviour.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  borrowedWorktreeBanner,
  countCommitsAhead,
  detectBorrowedWorktreeIndex,
  fileWasEverRenamed,
  getChangeBreakdownSince,
  getCommitSubjects,
  getCurrentHeadSha,
  getFileAtRef,
  getFileFollowEarliestTs,
  getLineRangeHistory,
  getUncommittedSourcePaths,
  gitCommitCount,
  gitCoreHooksPath,
  gitWorktreeRoot,
  hasUncommittedChanges,
  isCartographMetaPath,
  isShaReachable,
  isShallowClone,
  listChangedFilesSince,
  resolveGitBinary,
  shortSha,
} from '../src/git-utils.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A git repo with one committed file (`a.ts`) and a clean working tree. */
function initRepo(dir: string): string {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return git(dir, 'rev-parse', 'HEAD');
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cov-git-'));
}

// ---------------------------------------------------------------------------
// Pure helpers — no git process needed.
// ---------------------------------------------------------------------------

describe('isCartographMetaPath', () => {
  it('matches a path-segment, not a substring', () => {
    expect(isCartographMetaPath('.cartograph/cartograph.db')).toBe(true);
    expect(isCartographMetaPath('sub/dir/.cartograph/cache/x')).toBe(true);
    // Backslash-separated (Windows-style) input is also segmented.
    expect(isCartographMetaPath('a\\b\\.cartograph\\config.json')).toBe(true);
  });

  it('does not drop a legit source file that merely contains the literal', () => {
    expect(isCartographMetaPath('src/.cartograph-helper.ts')).toBe(false);
    expect(isCartographMetaPath('docs/dot-cartograph.md')).toBe(false);
    expect(isCartographMetaPath('src/index.ts')).toBe(false);
  });
});

describe('shortSha', () => {
  it('truncates to 12 chars by default', () => {
    const full = '0123456789abcdef0123456789abcdef01234567';
    expect(shortSha(full)).toBe('0123456789ab');
    expect(shortSha(full).length).toBe(12);
  });

  it('honours a custom length and tolerates already-short / empty input', () => {
    expect(shortSha('abcdef0123', 4)).toBe('abcd');
    expect(shortSha('abc')).toBe('abc'); // shorter than 12 → unchanged
    expect(shortSha('')).toBe('');
  });
});

describe('resolveGitBinary', () => {
  it('returns an absolute /usr/bin/git or a bare git fallback (never git.exe off-win32)', () => {
    const bin = resolveGitBinary();
    if (process.platform === 'win32') {
      expect(bin).toBe('git.exe');
    } else {
      expect(['/usr/bin/git', 'git']).toContain(bin);
      // When /usr/bin/git exists the pinned absolute path must be chosen.
      if (fs.existsSync('/usr/bin/git')) expect(bin).toBe('/usr/bin/git');
    }
  });
});

describe('borrowedWorktreeBanner', () => {
  it('names both worktrees and the remediation command', () => {
    const banner = borrowedWorktreeBanner({ worktreeRoot: '/work/here', indexRoot: '/other/index' });
    expect(banner).toContain('/other/index');
    expect(banner).toContain('/work/here');
    expect(banner).toContain('cartograph admin init');
  });
});

// ---------------------------------------------------------------------------
// getCurrentHeadSha
// ---------------------------------------------------------------------------

describe('getCurrentHeadSha', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns a 40-char sha matching rev-parse HEAD', () => {
    dir = mkTmp();
    const head = initRepo(dir);
    const got = getCurrentHeadSha(dir);
    expect(got).toBe(head);
    expect(got).toHaveLength(40);
  });

  it('returns null in a non-git directory', () => {
    dir = mkTmp();
    expect(getCurrentHeadSha(dir)).toBeNull();
  });

  it('returns null in an initialized repo with no commits (HEAD unborn)', () => {
    dir = mkTmp();
    git(dir, 'init', '-q');
    expect(getCurrentHeadSha(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gitWorktreeRoot / gitCoreHooksPath / detectBorrowedWorktreeIndex
// ---------------------------------------------------------------------------

describe('gitWorktreeRoot', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the realpath-resolved toplevel from a nested dir', () => {
    dir = mkTmp();
    initRepo(dir);
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const root = gitWorktreeRoot(nested);
    expect(root).toBe(fs.realpathSync(dir));
  });

  it('returns null outside a git repo', () => {
    dir = mkTmp();
    expect(gitWorktreeRoot(dir)).toBeNull();
  });
});

describe('gitCoreHooksPath', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns null when core.hooksPath is unset', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(gitCoreHooksPath(dir)).toBeNull();
  });

  it('returns the configured value verbatim (relative kept as-is)', () => {
    dir = mkTmp();
    initRepo(dir);
    git(dir, 'config', 'core.hooksPath', '.husky');
    expect(gitCoreHooksPath(dir)).toBe('.husky');
  });

  it('returns null outside a git repo', () => {
    dir = mkTmp();
    expect(gitCoreHooksPath(dir)).toBeNull();
  });
});

describe('detectBorrowedWorktreeIndex', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns null for a non-git startPath', () => {
    dir = mkTmp();
    expect(detectBorrowedWorktreeIndex(dir, dir)).toBeNull();
  });

  it('returns null when the index lives in the same worktree as startPath', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(detectBorrowedWorktreeIndex(dir, dir)).toBeNull();
  });

  it('returns null when indexRoot is an unrelated ancestor that is not a worktree root', () => {
    // Parent dir is a plain (non-git) directory containing a git repo child.
    const parent = mkTmp();
    dir = parent; // for cleanup
    const child = path.join(parent, 'repo');
    fs.mkdirSync(child);
    initRepo(child);
    // startPath is inside the git repo, but the "index" is the non-git parent.
    expect(detectBorrowedWorktreeIndex(child, parent)).toBeNull();
  });

  it('flags a genuine borrowed index: a linked worktree whose index points at the main checkout', () => {
    dir = mkTmp();
    initRepo(dir);
    // Create a linked worktree under the main checkout (the F#58 shape:
    // nested worktree, index found by upward walk = the main checkout root).
    const wt = path.join(dir, 'nested-wt');
    git(dir, 'worktree', 'add', '-q', wt, 'HEAD');
    try {
      const mismatch = detectBorrowedWorktreeIndex(wt, dir);
      expect(mismatch).not.toBeNull();
      expect(mismatch!.worktreeRoot).toBe(fs.realpathSync(wt));
      expect(mismatch!.indexRoot).toBe(fs.realpathSync(dir));
      // The banner should then render with the detected mismatch.
      expect(borrowedWorktreeBanner(mismatch!)).toContain(fs.realpathSync(wt));
    } finally {
      git(dir, 'worktree', 'remove', '--force', wt);
    }
  });

  it('returns null when indexRoot is a real worktree but NOT an ancestor of startPath (foreign project)', () => {
    dir = mkTmp();
    initRepo(dir);
    // A completely separate repo elsewhere — real worktree root, but not an
    // ancestor of `dir`. This is the "explicitly targeted a foreign project"
    // suppression branch.
    const foreign = mkTmp();
    try {
      initRepo(foreign);
      expect(detectBorrowedWorktreeIndex(dir, foreign)).toBeNull();
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// gitCommitCount / isShallowClone / countCommitsAhead
// ---------------------------------------------------------------------------

describe('gitCommitCount', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts commits reachable from HEAD', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(gitCommitCount(dir)).toBe(1);
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    expect(gitCommitCount(dir)).toBe(2);
  });

  it('returns null in a non-git directory', () => {
    dir = mkTmp();
    expect(gitCommitCount(dir)).toBeNull();
  });
});

describe('isShallowClone', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is false for a normal (full) repo', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(isShallowClone(dir)).toBe(false);
  });

  it('is false (best-effort) for a non-git directory, and the result is cached', () => {
    dir = mkTmp();
    expect(isShallowClone(dir)).toBe(false);
    // Second call hits the per-process cache (same answer, no throw).
    expect(isShallowClone(dir)).toBe(false);
  });

  it('detects an actual shallow clone', () => {
    // Build a source repo with 3 commits, then shallow-clone it depth=1.
    const src = mkTmp();
    dir = mkTmp(); // dest, also used for cleanup
    try {
      initRepo(src);
      for (let i = 0; i < 2; i++) {
        fs.writeFileSync(path.join(src, `f${i}.ts`), `export const f${i} = ${i};\n`);
        git(src, 'add', '-A');
        git(src, 'commit', '-q', '-m', `c${i}`);
      }
      const dest = path.join(dir, 'shallow');
      git(dir, 'clone', '-q', '--depth', '1', `file://${fs.realpathSync(src)}`, dest);
      expect(isShallowClone(dest)).toBe(true);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
});

describe('countCommitsAhead', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the number of commits between a baseline sha and HEAD', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    expect(countCommitsAhead(dir, base)).toBe(0);
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    fs.writeFileSync(path.join(dir, 'c.ts'), 'export const c = 3;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'third');
    expect(countCommitsAhead(dir, base)).toBe(2);
  });

  it('returns null for an invalid / unknown baseline sha', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(countCommitsAhead(dir, '0'.repeat(40))).toBeNull();
  });

  it('option-injection guard: a ref starting with - does not run a git flag', () => {
    dir = mkTmp();
    initRepo(dir);
    // `--all` after `--end-of-options` is treated as a revision operand,
    // which does not resolve → null, NOT "count across all refs".
    expect(countCommitsAhead(dir, '--all')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getChangeBreakdownSince
// ---------------------------------------------------------------------------

describe('getChangeBreakdownSince', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('merges committed + working-tree + untracked changes by worst-impact category', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    // Committed change since base: add committed.ts, delete nothing yet.
    fs.writeFileSync(path.join(dir, 'committed.ts'), 'export const x = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add committed');
    // Working-tree: modify a.ts, delete nothing, add an untracked file.
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 99;\n');
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const u = 1;\n');

    const bd = getChangeBreakdownSince(dir, base);
    expect(bd).not.toBeNull();
    // committed.ts (added) + a.ts (modified) + untracked.ts (added) = 3 distinct.
    expect(bd!.total).toBe(3);
    expect(bd!.added).toBe(2);
    expect(bd!.modified).toBe(1);
    expect(bd!.deleted).toBe(0);
    expect(bd!.total).toBe(bd!.added + bd!.modified + bd!.deleted);
  });

  it('records deletions and worst-impact wins (deleted beats added/modified)', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    fs.rmSync(path.join(dir, 'a.ts'));
    const bd = getChangeBreakdownSince(dir, base);
    expect(bd).not.toBeNull();
    expect(bd!.deleted).toBe(1);
    expect(bd!.total).toBe(1);
  });

  it('excludes .cartograph/ index metadata from the breakdown', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    fs.mkdirSync(path.join(dir, '.cartograph'));
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db'), 'index-bytes');
    const bd = getChangeBreakdownSince(dir, base);
    expect(bd).not.toBeNull();
    expect(bd!.total).toBe(0);
  });

  it('returns null when the committed diff fails (non-git directory)', () => {
    dir = mkTmp();
    expect(getChangeBreakdownSince(dir, '0'.repeat(40))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listChangedFilesSince
// ---------------------------------------------------------------------------

describe('listChangedFilesSince', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists committed + modified + untracked paths relative to ref', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    fs.writeFileSync(path.join(dir, 'committed.ts'), 'export const x = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 99;\n'); // modified
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const u = 1;\n'); // untracked

    const changed = listChangedFilesSince(dir, base);
    expect(changed).not.toBeNull();
    expect(new Set(changed!)).toEqual(new Set(['committed.ts', 'a.ts', 'untracked.ts']));
  });

  it('surfaces a rename as delete-of-old + add-of-new (--no-renames)', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    git(dir, 'mv', 'a.ts', 'renamed.ts');
    git(dir, 'commit', '-q', '-m', 'rename');
    const changed = listChangedFilesSince(dir, base);
    expect(changed).not.toBeNull();
    expect(changed).toContain('a.ts'); // old path (deleted)
    expect(changed).toContain('renamed.ts'); // new path (added)
  });

  it('returns an empty array when nothing changed since ref', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    expect(listChangedFilesSince(dir, base)).toEqual([]);
  });

  it('returns null when git diff fails (non-git directory)', () => {
    dir = mkTmp();
    expect(listChangedFilesSince(dir, '0'.repeat(40))).toBeNull();
  });

  it('option-injection guard: a --flag-shaped ref is rejected (null), not executed', () => {
    dir = mkTmp();
    initRepo(dir);
    // After `--end-of-options`, `--output=/tmp/pwned` is parsed as a ref
    // operand which fails to resolve → diff throws → null. The file is NOT
    // written.
    const pwned = path.join(dir, 'pwned');
    expect(listChangedFilesSince(dir, `--output=${pwned}`)).toBeNull();
    expect(fs.existsSync(pwned)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getLineRangeHistory
// ---------------------------------------------------------------------------

describe('getLineRangeHistory', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns newest-first commit metadata touching the line range', () => {
    dir = mkTmp();
    initRepo(dir);
    // Touch line 1 of a.ts in a second commit.
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1234;\nexport const b = 2;\nexport const c = 3;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'edit line 1');

    const hist = getLineRangeHistory({ rootDir: dir, relPath: 'a.ts', startLine: 1, endLine: 1, limit: 10 });
    expect(hist.length).toBeGreaterThanOrEqual(1);
    const top = hist[0]!;
    expect(top.sha).toHaveLength(40);
    expect(top.shortSha.length).toBeGreaterThan(0);
    expect(top.author).toBe('Test User');
    expect(top.subject).toBe('edit line 1'); // newest-first
    expect(top.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects an invalid range without invoking git', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(getLineRangeHistory({ rootDir: dir, relPath: 'a.ts', startLine: 0, endLine: 1, limit: 5 })).toEqual([]);
    expect(getLineRangeHistory({ rootDir: dir, relPath: 'a.ts', startLine: 5, endLine: 2, limit: 5 })).toEqual([]);
  });

  it('returns [] for a bad path / git failure', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(getLineRangeHistory({ rootDir: dir, relPath: 'nope.ts', startLine: 1, endLine: 1, limit: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fileWasEverRenamed / getFileFollowEarliestTs
// ---------------------------------------------------------------------------

describe('fileWasEverRenamed', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is false for a file that has never moved', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(fileWasEverRenamed(dir, 'a.ts')).toBe(false);
  });

  it('is true once the file has lived under a different path', () => {
    dir = mkTmp();
    initRepo(dir);
    git(dir, 'mv', 'a.ts', 'moved.ts');
    git(dir, 'commit', '-q', '-m', 'rename a.ts -> moved.ts');
    expect(fileWasEverRenamed(dir, 'moved.ts')).toBe(true);
  });

  it('is false (fail-safe) outside a git repo', () => {
    dir = mkTmp();
    expect(fileWasEverRenamed(dir, 'a.ts')).toBe(false);
  });
});

describe('getFileFollowEarliestTs', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the ISO timestamp of the earliest commit in the follow history', () => {
    dir = mkTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 7;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'edit');
    const ts = getFileFollowEarliestTs(dir, 'a.ts');
    expect(ts).not.toBeNull();
    expect(ts!).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null for an unknown path / non-repo', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(getFileFollowEarliestTs(dir, 'ghost.ts')).toBeNull();
    const nonRepo = mkTmp();
    try {
      expect(getFileFollowEarliestTs(nonRepo, 'a.ts')).toBeNull();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isShaReachable / getFileAtRef
// ---------------------------------------------------------------------------

describe('isShaReachable', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is true for HEAD and the current commit sha', () => {
    dir = mkTmp();
    const head = initRepo(dir);
    expect(isShaReachable(dir, head)).toBe(true);
    expect(isShaReachable(dir, 'HEAD')).toBe(true);
  });

  it('is false for an unknown sha and outside a repo', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(isShaReachable(dir, '0'.repeat(40))).toBe(false);
    const nonRepo = mkTmp();
    try {
      expect(isShaReachable(nonRepo, 'HEAD')).toBe(false);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('option-injection guard: a --flag-shaped sha is treated as a non-commit (false)', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(isShaReachable(dir, '--batch')).toBe(false);
  });
});

describe('getFileAtRef', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the file contents as they were at a ref', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    // Change a.ts in a later commit; the base ref must still show the old body.
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 999;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    const atBase = getFileAtRef(dir, base, 'a.ts');
    expect(atBase).toBe('export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    const atHead = getFileAtRef(dir, 'HEAD', 'a.ts');
    expect(atHead).toBe('export const a = 999;\n');
  });

  it('returns null when the file did not exist at the ref', () => {
    dir = mkTmp();
    const base = initRepo(dir);
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const n = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add new');
    // new.ts didn't exist at base → null (distinct from empty string).
    expect(getFileAtRef(dir, base, 'new.ts')).toBeNull();
  });

  it('returns null for an invalid ref / non-repo', () => {
    dir = mkTmp();
    initRepo(dir);
    expect(getFileAtRef(dir, 'no-such-ref', 'a.ts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCommitSubjects
// ---------------------------------------------------------------------------

describe('getCommitSubjects', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('maps each known sha to its commit subject', () => {
    dir = mkTmp();
    const c1 = initRepo(dir);
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second subject');
    const c2 = git(dir, 'rev-parse', 'HEAD');

    const subjects = getCommitSubjects(dir, [c1, c2]);
    expect(subjects.get(c1)).toBe('initial');
    expect(subjects.get(c2)).toBe('second subject');
  });

  it('skips unknown shas via --ignore-missing and returns an empty map for an empty input', () => {
    dir = mkTmp();
    const c1 = initRepo(dir);
    const subjects = getCommitSubjects(dir, [c1, '0'.repeat(40)]);
    expect(subjects.get(c1)).toBe('initial');
    expect(subjects.has('0'.repeat(40))).toBe(false);

    expect(getCommitSubjects(dir, []).size).toBe(0);
  });

  it('returns an empty map when git fails entirely (non-git directory)', () => {
    dir = mkTmp();
    expect(getCommitSubjects(dir, ['0'.repeat(40)]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hasUncommittedChanges / getUncommittedSourcePaths — light re-cover of the
// porcelain path plus the rename ` -> ` extraction not hit by git-utils.test.
// ---------------------------------------------------------------------------

describe('uncommitted source paths — rename extraction', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('surfaces a staged rename as its new path (splits on ` -> `)', () => {
    dir = mkTmp();
    initRepo(dir);
    // Stage a rename so porcelain emits `R  a.ts -> renamed.ts`.
    git(dir, 'mv', 'a.ts', 'renamed.ts');
    const paths = getUncommittedSourcePaths(dir);
    // Regression guard: extraction now splits on ` -> ` (matching
    // `classifyPorcelainLine`), so a rename surfaces its destination path
    // rather than the raw `"a.ts -> renamed.ts"` token.
    expect(paths).toEqual(['renamed.ts']);
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  it('returns [] / false for a non-git directory', () => {
    dir = mkTmp();
    expect(getUncommittedSourcePaths(dir)).toEqual([]);
    expect(hasUncommittedChanges(dir)).toBe(false);
  });
});
