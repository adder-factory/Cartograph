/**
 * Tests for `cartograph_history` file-level fallback (#22).
 *
 * The symbol-level co-change path requires `Fixes #N` / `Closes #N` /
 * `Resolves #N` commit messages — the issue-history miner only
 * attributes hunks from those commits. Conventional-commit repos
 * (most modern OSS) have no such refs, so the symbol-level path
 * returns empty.
 *
 * The fallback reports file-level co-change for the symbol's
 * enclosing file, mined from `git log --name-only` (no issue-tag
 * requirement). These tests exercise the fallback path explicitly
 * with a git fixture using conventional commits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_GIT)('cartograph_history file-level fallback (#22)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-history-fallback-'));
    fs.mkdirSync(path.join(dir, 'src'));

    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function beta(): number { return 2; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export function gamma(): number { return 3; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');

    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feat: initial three modules');

    // Conventional-commit history: touch a.ts + b.ts together a few
    // times, never tagging an issue. Emulates a typical OSS repo.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return ${i + 2}; }\n`);
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return ${i + 3}; }\n`);
      git(dir, 'add', 'src/a.ts', 'src/b.ts');
      git(dir, 'commit', '-q', '-m', `feat: tweak alpha+beta together (${i})`);
    }

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to file-level co-change when no issue-tagged commits exist', async () => {
    const result = await handler.execute('cartograph_history', { symbol: 'alpha', minCount: 2 });
    const text = result.content[0]?.text ?? '';
    // Header signals fallback was used.
    expect(text).toMatch(/File-level co-change/);
    // The body explicitly notes the no-issue-tagged-commits cause.
    expect(text).toMatch(/no issue-tagged.*commits in this repo/);
    // src/b.ts co-changed with src/a.ts in every commit (1 init + 3
    // tweaks = 4 shared commits), well above minCount=2.
    expect(text).toContain('src/b.ts');
    expect(text).toMatch(/4 shared commits/);
    // src/c.ts only appeared in the init commit. At minCount=2 it
    // shouldn't appear under src/a.ts (init is shared, but c.ts
    // wasn't co-changed with a.ts in any of the tweak commits).
    // 1 shared commit < minCount=2 so it's filtered out.
    expect(text).not.toContain('src/c.ts');
    // No "↳ top symbols" subline on the file-level fallback path
    // (FRICTION-S). The file-level co-change miner stores only an
    // aggregate `count` in `co_changes` — it discards which commits
    // formed each pair, and `symbol_issues` is empty for this anchor.
    // With no per-symbol commit set to intersect, any "top symbols"
    // line would show the file's globally-most-central symbols, NOT
    // the symbols touched in the shared commits — misleading noise.
    expect(text).not.toMatch(/↳ top symbols/);
  });

  it("does not leak a partner file's globally-central symbols into the fallback (FRICTION-S)", async () => {
    // src/b.ts contains both `beta` (touched in every shared commit
    // with a.ts) and a second, never-co-changed symbol. The old
    // "↳ top symbols" line sourced symbols by global centrality, so a
    // high-centrality symbol unrelated to the shared commits could
    // surface as misleading noise. Assert no such subline exists and
    // therefore no unrelated symbol can leak.
    const result = await handler.execute('cartograph_history', { symbol: 'alpha', minCount: 2 });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/File-level co-change/);
    expect(text).toContain('src/b.ts');
    // The subline is gone entirely on the file-level fallback path.
    expect(text).not.toMatch(/↳ top symbols/);
    expect(text).not.toMatch(/top symbols:/);
  });

  // Audit #23: when the queried name is ambiguous (>1 exact match),
  // findSymbol picks one candidate and the file-level fallback covers
  // ONLY that pick's file. The fallback body must say so — otherwise
  // the agent reads a single-file answer as project-wide.
  it('warns the file-level fallback covers only the picked file when the name is ambiguous', async () => {
    // Add a second `alpha` in a different file, co-changed with c.ts so
    // the symbol-level path is still empty (no issue-tagged commits)
    // and the file-level fallback fires for whichever file is picked.
    fs.mkdirSync(path.join(dir, 'src', 'sub'));
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'a2.ts'), 'export function alpha(): string { return "x"; }\n');
    git(dir, 'add', 'src/sub/a2.ts');
    git(dir, 'commit', '-q', '-m', 'feat: second alpha');
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'sub', 'a2.ts'), `export function alpha(): string { return "${i}"; }\n`);
      fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return ${i + 10}; }\n`);
      git(dir, 'add', 'src/sub/a2.ts', 'src/c.ts');
      git(dir, 'commit', '-q', '-m', `feat: tweak second alpha + gamma (${i})`);
    }
    // Re-index in place — `.cartograph/` already exists, so re-init
    // would throw; a fresh full index picks up the new file + commits.
    await cg.indexAll({ summarize: false });

    const result = await handler.execute('cartograph_history', { symbol: 'alpha', minCount: 2 });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/File-level co-change/);
    // The new ambiguity warning must appear.
    expect(text).toMatch(/`alpha` is an ambiguous name/);
    expect(text).toMatch(/file-level fallback covers only/);
    // The disambiguation note from findSymbol still appends too.
    expect(text).toMatch(/symbols named "alpha"/);
  });

  it('renders the empty diagnostic when both symbol- and file-level have no hits at the threshold', async () => {
    // gamma is in c.ts which has zero post-init churn. minCount=2
    // forces both symbol- and file-level to return empty.
    const result = await handler.execute('cartograph_history', { symbol: 'gamma', minCount: 2 });
    const text = result.content[0]?.text ?? '';
    // Diagnostic distinguishes the convention-commit case from "miner
    // never ran" — the text should mention 0 issue-tagged commits.
    expect(text).toMatch(/issue-tagged.*commits/);
    // `gamma` in c.ts has no co-change partners at minCount=2.
    expect(text).toMatch(/no co-change history|no other symbol|file-level fallback for/i);
  });
});

/**
 * Friction fix (c): when the repo HAS issue-tagged commits but a
 * specific symbol was never touched by one, the report must not say
 * the symbol "has no recorded modifications" (reads as "never
 * changed"). It must make explicit that this means "no ISSUE-TAGGED
 * modifications" — the symbol may have changed many times in untagged
 * commits.
 */
describe.skipIf(!HAS_GIT)('cartograph_history — no-issue-tagged wording is unambiguous', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-history-wording-'));
    fs.mkdirSync(path.join(dir, 'src'));

    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function beta(): number { return 2; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export function gamma(): number { return 3; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');

    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feat: initial three modules');

    // ISSUE-TAGGED commits touching only a.ts + b.ts — gives the repo
    // a non-zero issue-tagged-commit count (`repoIssueCount > 0`).
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return ${i + 2}; }\n`);
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return ${i + 3}; }\n`);
      git(dir, 'add', 'src/a.ts', 'src/b.ts');
      git(dir, 'commit', '-q', '-m', `fix: tweak alpha+beta. Fixes #${i + 10}`);
    }
    // UNTAGGED commits touching c.ts — so `gamma` HAS changed, just
    // never in an issue-tagged commit.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return ${i + 4}; }\n`);
      git(dir, 'add', 'src/c.ts');
      git(dir, 'commit', '-q', '-m', `chore: bump gamma (${i})`);
    }

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not claim "no recorded modifications" — wording is scoped to issue-tagged commits', async () => {
    // `gamma` changed 3× in untagged commits but never in a `Fixes #N`
    // commit. The fallback / empty diagnostic must NOT imply it never
    // changed.
    const result = await handler.execute('cartograph_history', { symbol: 'gamma', minCount: 2 });
    const text = result.content[0]?.text ?? '';
    // The misleading bare phrasing must be gone.
    expect(text).not.toMatch(/has no recorded modifications(?! in issue-tagged)/);
    expect(text).not.toMatch(/has no recorded modification history/);
    // The replacement makes the issue-tagged scope explicit.
    expect(text).toMatch(/issue-tagged commits/);
    // ...and tells the reader the symbol may still have changed.
    expect(text).toMatch(/may (still )?have changed|untagged commits/i);
  });
});

/**
 * Bug #10 regression — when `cartograph_history symbol='basename.ts'`
 * matches multiple `kind:'file'` nodes with the same basename, pick
 * the candidate with HIGHER `files.commit_count`. The fix in
 * `pickFromMultipleExactMatches` adds a file-kind-only tier
 * (commit_count DESC → centrality DESC → path ASC) so an ambiguous
 * file-name input resolves to the historically interesting copy
 * instead of a stable-but-low-churn lookalike. The disambiguation
 * note must surface ABOVE the body so the agent sees the pick
 * before reading the timeline.
 */
describe.skipIf(!HAS_GIT)('cartograph_history — ambiguous file name picks the higher-commit candidate (#10)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-history-disambig-'));
    fs.mkdirSync(path.join(dir, 'src', 'busy'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'quiet'), { recursive: true });

    // Two files share the basename `foo.ts`. We arrange the busy copy
    // to be the lexicographically-LATER path so a naive path-sort
    // tiebreaker would pick the quiet copy — only commit_count
    // disambiguation lands on the busy one.
    fs.writeFileSync(path.join(dir, 'src', 'busy', 'foo.ts'), 'export function busy0(): number { return 0; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'quiet', 'foo.ts'), 'export function quiet0(): number { return 0; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');

    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feat: initial two foo.ts copies');

    // Churn the busy copy 6×, quiet copy 0× (it stays at the initial
    // single commit). That's a 7-vs-1 commit_count split.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', 'busy', 'foo.ts'),
        `export function busy${i + 1}(): number { return ${i + 1}; }\n`,
      );
      git(dir, 'add', 'src/busy/foo.ts');
      git(dir, 'commit', '-q', '-m', `chore: busy bump ${i}`);
    }

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('picks the higher-commit `foo.ts` and prepends the disambiguation note', async () => {
    const result = await handler.execute('cartograph_history', { symbol: 'foo.ts', minCount: 1 });
    const text = result.content[0]?.text ?? '';

    // The busy copy under src/busy/ wins on commit_count.
    expect(text).toContain('src/busy/foo.ts');
    // The quiet copy is named as the runner-up in the disambiguation
    // note (so the agent still sees both candidates).
    expect(text).toContain('src/quiet/foo.ts');
    // The picked file's history path is shown at the headline.
    expect(text).toMatch(/Showing results for `src\/busy\/foo\.ts/);

    // The disambiguation note MUST land at the TOP — the bug was that
    // a footer note left the agent reading the wrong file's timeline
    // before noticing the disambiguation. Assert the headline appears
    // BEFORE the report body header.
    const headlineIdx = text.indexOf('symbols named "foo.ts"');
    const bodyIdx = text.indexOf('## ');
    expect(headlineIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(headlineIdx);
  });
});
