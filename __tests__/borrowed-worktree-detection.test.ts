/**
 * F#58 — Borrowed git-worktree index detection.
 *
 * When an agent runs from a worktree nested inside the main checkout
 * (e.g. tools that place worktrees under `.claude/worktrees/<name>/`),
 * the `.cartograph/` lookup walks UP to the main checkout's index and
 * queries silently reflect that tree's branch — symbols changed only
 * in the worktree are invisible and nothing tells the user.
 *
 * Detection runs `git rev-parse --show-toplevel` from both the caller's
 * directory and the resolved index root; a mismatch produces a banner
 * that ToolHandler prepends to read-tool responses. Best-effort: no
 * git, not a repo, or a plain-ancestor index → no warning, no breakage.
 *
 * These tests drive REAL `git` against real temp worktrees — no
 * mocking — so the same code path production uses is the one under
 * test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectBorrowedWorktreeIndex, gitWorktreeRoot, borrowedWorktreeBanner } from '../src/git-utils.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** realpath so macOS /var → /private/var doesn't break equality. */
function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

describe('detectBorrowedWorktreeIndex (F#58)', () => {
  let mainRepo: string; // main checkout — owns the .cartograph index
  let worktree: string; // a linked worktree nested INSIDE the main checkout
  let nonGit: string; // a directory outside any git repo

  beforeEach(() => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-main-'));
    nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-plain-'));

    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# main\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    // Nest the worktree under the main checkout — mirroring the agent
    // pattern that places worktrees in gitignored `.claude/worktrees/<n>/`.
    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  });

  afterEach(() => {
    try {
      git(mainRepo, 'worktree', 'remove', '--force', worktree);
    } catch {
      /* best effort */
    }
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(nonGit, { recursive: true, force: true });
  });

  it('flags a worktree borrowing the main checkout index', () => {
    const m = detectBorrowedWorktreeIndex(worktree, mainRepo);
    expect(m).not.toBeNull();
    expect(m!.worktreeRoot).toBe(real(worktree));
    expect(m!.indexRoot).toBe(real(mainRepo));
  });

  it('returns null when the index lives in the same working tree', () => {
    expect(detectBorrowedWorktreeIndex(mainRepo, mainRepo)).toBeNull();
    expect(detectBorrowedWorktreeIndex(worktree, worktree)).toBeNull();
  });

  it('returns null for a subdirectory of the same working tree', () => {
    // A request from `mainRepo/src/` against the main checkout's index
    // is the canonical correct configuration — must NOT warn.
    const sub = path.join(mainRepo, 'src');
    fs.mkdirSync(sub);
    expect(detectBorrowedWorktreeIndex(sub, mainRepo)).toBeNull();
  });

  it('returns null when startPath is not in a git repo', () => {
    // No git → no warning. Best-effort policy.
    expect(detectBorrowedWorktreeIndex(nonGit, mainRepo)).toBeNull();
  });

  it('returns null when the index root is a plain (non-worktree) directory', () => {
    // startPath IS a real worktree, but the "index" sits in an
    // unrelated non-git dir — that's "index in an ancestor", not
    // "borrowed another worktree". Don't conflate the two.
    expect(detectBorrowedWorktreeIndex(worktree, nonGit)).toBeNull();
  });

  it('gitWorktreeRoot reports each tree distinctly', () => {
    expect(gitWorktreeRoot(worktree)).toBe(real(worktree));
    expect(gitWorktreeRoot(mainRepo)).toBe(real(mainRepo));
    expect(gitWorktreeRoot(nonGit)).toBeNull();
  });

  it('banner text names both trees and the fix', () => {
    const m = detectBorrowedWorktreeIndex(worktree, mainRepo)!;
    const msg = borrowedWorktreeBanner(m);
    expect(msg).toContain(real(worktree));
    expect(msg).toContain(real(mainRepo));
    expect(msg).toContain('cartograph admin init');
  });
});

/**
 * Detection above only helps if it reaches the agent. The fork's
 * ToolHandler.execute() runs a centralized banner-prepend in
 * `toolHandlerPreFlightCheck`; this test exercises that real path
 * against a real ToolHandler wrapping a real Cartograph whose project
 * root is the MAIN checkout, with the tool call made from a nested
 * worktree. Without F#58 the response would silently return the
 * main branch's code with no warning.
 */
describe('borrowed-worktree banner surfaces on ToolHandler.execute (F#58)', () => {
  let mainRepo: string;
  let worktree: string;

  beforeEach(() => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-exec-'));
    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(mainRepo, 'src'));
    fs.writeFileSync(path.join(mainRepo, 'src', 'a.ts'), 'export function mainOnly() { return 1; }\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  });

  afterEach(() => {
    try {
      git(mainRepo, 'worktree', 'remove', '--force', worktree);
    } catch {
      /* best effort */
    }
    fs.rmSync(mainRepo, { recursive: true, force: true });
  });

  it('prepends the borrowed-worktree banner when args.projectPath resolves to a different tree', async () => {
    // The MAIN repo holds the index. The TOOL CALL passes `projectPath: worktree`
    // — but the project cache resolves that to the main checkout's `.cartograph/`
    // via the upward walk, so cg.projectRoot will be mainRepo while args.projectPath
    // is the nested worktree. That's exactly the borrowed-index condition.
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const cg = await Cartograph.init(mainRepo, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'mainOnly',
      projectPath: worktree,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('different git worktree');
    expect(text).toContain(real(worktree));
    expect(text).toContain(real(mainRepo));

    cg.close();
  });

  it('no banner when projectPath and index live in the same tree', async () => {
    const { Cartograph } = await import('../src/index.js');
    const { ToolHandler } = await import('../src/mcp/tools.js');
    const cg = await Cartograph.init(mainRepo, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'mainOnly',
      projectPath: mainRepo,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('different git worktree');

    cg.close();
  });
});
