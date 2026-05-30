/**
 * cartograph_blame — symbol-level history via `git log -L`.
 *
 * Validates the line-range timeline (earliest + most-recent + author
 * rollup) on a real temp git repo, plus the issue-tagged co-touched
 * peer trail when the issue-history miner has run.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import * as gitUtils from '../src/git-utils.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env['GIT_AUTHOR_NAME'] ?? 'Test Author',
      GIT_AUTHOR_EMAIL: process.env['GIT_AUTHOR_EMAIL'] ?? 't@t',
      GIT_COMMITTER_NAME: process.env['GIT_COMMITTER_NAME'] ?? 'Test Author',
      GIT_COMMITTER_EMAIL: process.env['GIT_COMMITTER_EMAIL'] ?? 't@t',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('cartograph_blame', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blame-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(): number {\n  return 1;\n}\nexport function beta(): number {\n  return 2;\n}\n`,
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-blame', version: '0.0.0' }));
    git(dir, 'init', '-q');
    git(dir, 'config', 'commit.gpgsign', 'false');
    process.env['GIT_AUTHOR_NAME'] = 'Alice';
    process.env['GIT_AUTHOR_EMAIL'] = 'alice@example.com';
    process.env['GIT_COMMITTER_NAME'] = 'Alice';
    process.env['GIT_COMMITTER_EMAIL'] = 'alice@example.com';
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'introduce alpha + beta');

    // Touch alpha twice as Bob (referencing an issue once so we get
    // the symbol_issues co-touched trail).
    process.env['GIT_AUTHOR_NAME'] = 'Bob';
    process.env['GIT_AUTHOR_EMAIL'] = 'bob@example.com';
    process.env['GIT_COMMITTER_NAME'] = 'Bob';
    process.env['GIT_COMMITTER_EMAIL'] = 'bob@example.com';
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(): number {\n  return 11;\n}\nexport function beta(): number {\n  return 22;\n}\n`,
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'tune values — fixes #42');

    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function alpha(): number {\n  return 111;\n}\nexport function beta(): number {\n  return 22;\n}\n`,
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'bump alpha only');

    delete process.env['GIT_AUTHOR_NAME'];
    delete process.env['GIT_AUTHOR_EMAIL'];
    delete process.env['GIT_COMMITTER_NAME'];
    delete process.env['GIT_COMMITTER_EMAIL'];

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    // Defensive: if a beforeEach git command threw before the inline
    // delete reached, env vars would leak into the next test. Always
    // clear here so cross-test isolation holds even on setup errors.
    delete process.env['GIT_AUTHOR_NAME'];
    delete process.env['GIT_AUTHOR_EMAIL'];
    delete process.env['GIT_COMMITTER_NAME'];
    delete process.env['GIT_COMMITTER_EMAIL'];
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the line-range timeline with earliest, most-recent, and author rollup', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'alpha' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Blame for `alpha`/);
    expect(text).toMatch(/Earliest known/);
    expect(text).toMatch(/Most recent/);
    expect(text).toMatch(/Recent activity/);
    // Both authors should be in the rollup.
    expect(text).toMatch(/Alice/);
    expect(text).toMatch(/Bob/);
    // Bob authored 2 commits affecting alpha; Alice authored 1.
    expect(text).toMatch(/Bob.*2 commits/);
    expect(text).toMatch(/Alice.*1 commit/);
  });

  it('reports no history for a symbol whose line range is untouched', async () => {
    // Add an untracked file with a fresh symbol; sync so the index
    // sees it. git log -L on its lines returns nothing because it's
    // never been committed → "no history" branch.
    fs.writeFileSync(path.join(dir, 'src', 'fresh.ts'), `export function brandNew(): number {\n  return 99;\n}\n`);
    await cg.sync({ summarize: false });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'brandNew' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No commit history/);
  });

  it('respects perCommitPeers=0 to disable the per-commit peer trail', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'alpha', perCommitPeers: 0 });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/co-touched/);
  });

  it('returns "not found" when the symbol does not exist', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'doesNotExist' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    // notFoundMessage from symbol-resolver
    expect(text.toLowerCase()).toMatch(/not found|did you mean|no symbol/);
  });

  it('appends rename warning when --follow shows older history than the line-range timeline', async () => {
    // `git log -L` does NOT reliably follow renames across all git versions
    // and content-change combinations, so we cannot construct a git-native
    // fixture that guarantees truncation. Instead, we stub both
    // `fileWasEverRenamed` (to confirm a rename exists) and
    // `getFileFollowEarliestTs` (to simulate the rename predating the
    // symbol's timeline) — the exact two conditions detectRenameWarning checks.
    //
    // The main fixture (dir / cg) has `alpha` with its earliest timeline
    // commit at ~today (the "introduce alpha + beta" commit). We override
    // the follow-history response to report a timestamp well BEFORE that
    // commit, as if the file once lived under a different name.

    const renameSpy = vi.spyOn(gitUtils, 'fileWasEverRenamed').mockReturnValue(true);
    const tsSpy = vi
      .spyOn(gitUtils, 'getFileFollowEarliestTs')
      // Return a date far in the past — older than the earliest line-range commit.
      .mockReturnValue('2000-01-01T00:00:00+00:00');

    try {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_blame', { symbol: 'alpha' });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';

      expect(result.isError).toBeFalsy();
      expect(text).toMatch(/Timeline truncated at file rename/);
      expect(text).toMatch(/git log --follow/);
      expect(text).toMatch(/src\/a\.ts/);
    } finally {
      renameSpy.mockRestore();
      tsSpy.mockRestore();
    }
  });

  it('prints a fuzzy-fallback banner when the query resolves approximately', async () => {
    // `alph` has no exact symbol — FTS fuzzy-resolves it to `alpha`.
    // `matchesSymbol` rejects the approximate hit, so `resolveSymbolToNode`
    // flags it `fuzzy` and blame must surface the banner so the agent
    // knows the L-range belongs to a guessed symbol, not `alph` (#20).
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'alph' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    // `alph` fuzzy-resolves to `alpha`, which has committed history —
    // so blame renders a real report AND the fuzzy-fallback banner.
    expect(text).toMatch(/Blame for/);
    expect(text).toMatch(/Fuzzy fallback/);
    expect(text).toMatch(/no symbol exactly named "alph"/);
  });

  it('does NOT print a fuzzy-fallback banner on an exact symbol match', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'alpha' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Blame for `alpha`/);
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  it('does NOT append rename warning when file has never been renamed', async () => {
    // The main fixture (dir / cg) has no renames — alpha has always
    // been in src/a.ts. Blame should not emit a rename warning.
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_blame', { symbol: 'alpha' });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).not.toMatch(/Timeline truncated at file rename/);
  });

  it('does NOT append rename warning for a function added AFTER file creation (no rename)', async () => {
    // Regression for the false-positive friction: a function introduced in a
    // later commit has a -L timeline that starts after the file's creation
    // commit. Without the rename-detection guard, --follow's oldest timestamp
    // (= file creation) < symbol's -L oldest timestamp (= function intro),
    // which used to trip the warning even though no rename ever occurred.
    //
    // Build the scenario in a fresh sub-directory so it doesn't interfere with
    // the main fixture:
    //   commit 1 — create src/b.ts with only `fileHeader()` (not the target)
    //   commit 2 — add `lateAddition()` to src/b.ts
    // File was never renamed → warning must NOT appear for `lateAddition`.

    const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blame-late-'));
    let subCg: typeof cg | null = null;
    try {
      fs.mkdirSync(path.join(subDir, 'src'));
      fs.writeFileSync(path.join(subDir, '.gitignore'), '.cartograph/\n');
      fs.writeFileSync(path.join(subDir, 'package.json'), JSON.stringify({ name: 'cg-blame-late', version: '0.0.0' }));

      // Commit 1: file with a placeholder function only.
      fs.writeFileSync(path.join(subDir, 'src', 'b.ts'), `export function fileHeader(): string {\n  return 'v1';\n}\n`);
      git(subDir, 'init', '-q');
      git(subDir, 'config', 'commit.gpgsign', 'false');
      git(subDir, 'add', '.');
      git(subDir, 'commit', '-q', '-m', 'initial: add fileHeader');

      // Commit 2: add lateAddition — this is the function we will blame.
      fs.writeFileSync(
        path.join(subDir, 'src', 'b.ts'),
        `export function fileHeader(): string {\n  return 'v1';\n}\nexport function lateAddition(): number {\n  return 42;\n}\n`,
      );
      git(subDir, 'add', '.');
      git(subDir, 'commit', '-q', '-m', 'add lateAddition');

      subCg = await Cartograph.init(subDir, { config: { llm: { endpoint: '' } } });
      await subCg.indexAll({ summarize: false });

      const handler = new ToolHandler(subCg);
      const result = await handler.execute('cartograph_blame', { symbol: 'lateAddition' });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';

      expect(result.isError).toBeFalsy();
      // lateAddition exists in git history — should have blame output.
      expect(text).toMatch(/Blame for `lateAddition`/);
      // The file was never renamed → no warning, even though --follow's
      // oldest timestamp (commit 1) precedes lateAddition's -L timestamp (commit 2).
      expect(text).not.toMatch(/Timeline truncated at file rename/);
    } finally {
      if (subCg) subCg.destroy();
      if (fs.existsSync(subDir)) fs.rmSync(subDir, { recursive: true, force: true });
    }
  });
});
