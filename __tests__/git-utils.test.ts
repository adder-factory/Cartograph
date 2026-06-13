/**
 * git-utils — `hasUncommittedChanges`.
 *
 * The freshness hint on an empty query result claims a "true negative"
 * only when the working tree is clean; `hasUncommittedChanges` is the
 * working-tree-drift signal the HEAD-SHA freshness check (`isStale`)
 * deliberately omits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { hasUncommittedChanges, getUncommittedSourcePaths } from '../src/git-utils.js';
import { detectLanguage, isLanguageSupported } from '../src/extraction/grammars.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A git repo with one committed file and a clean working tree. */
function initRepo(dir: string): void {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
}

describe('hasUncommittedChanges', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-git-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is false for a clean working tree', () => {
    initRepo(dir);
    expect(hasUncommittedChanges(dir)).toBe(false);
  });

  it('is true with an untracked file (the new-file friction case)', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  it('is true with a modified tracked file', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 99;\n');
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  it('ignores changes confined to the .cartograph/ index directory', () => {
    initRepo(dir);
    fs.mkdirSync(path.join(dir, '.cartograph'));
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db'), 'index');
    expect(hasUncommittedChanges(dir)).toBe(false);
  });

  it('is false (best-effort) for a non-git directory', () => {
    expect(hasUncommittedChanges(dir)).toBe(false);
  });

  // F#32 — `cartograph_admin init` appends a `.cartograph/` exclusion to
  // the project root's `.gitignore`. Without this filter, every fresh
  // init forever-poisons the freshness warning with a phantom
  // "uncommitted changes" banner that the user can't clear without
  // committing cartograph's own edit.
  it('ignores a .gitignore diff whose only addition is the cartograph init append', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, ['add', '.gitignore']);
    git(dir, ['commit', '-m', 'add gitignore']);
    // Simulate cartograph's init-time append (the exact two-line block).
    fs.appendFileSync(
      path.join(dir, '.gitignore'),
      '# Cartograph index directory (machine-local; do not commit)\n.cartograph/\n',
    );
    expect(hasUncommittedChanges(dir)).toBe(false);
  });

  it('still reports dirty when .gitignore has user edits alongside the cartograph append', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, ['add', '.gitignore']);
    git(dir, ['commit', '-m', 'add gitignore']);
    // Cartograph append + a user addition on the same diff.
    fs.appendFileSync(
      path.join(dir, '.gitignore'),
      '# Cartograph index directory (machine-local; do not commit)\n.cartograph/\ndist/\n',
    );
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  it('ignores an UNTRACKED .gitignore whose entire content is cartograph init append', () => {
    initRepo(dir);
    // Init writes EXACTLY this two-line block when no prior .gitignore existed.
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      '# Cartograph index directory (machine-local; do not commit)\n.cartograph/\n',
    );
    expect(hasUncommittedChanges(dir)).toBe(false);
  });

  it('still reports dirty when an UNTRACKED .gitignore has any non-cartograph content', () => {
    initRepo(dir);
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      '# Cartograph index directory (machine-local; do not commit)\n.cartograph/\nnode_modules/\n',
    );
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  it('still reports dirty when .gitignore is modified AND another file changed', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, ['add', '.gitignore']);
    git(dir, ['commit', '-m', 'add gitignore']);
    fs.appendFileSync(
      path.join(dir, '.gitignore'),
      '# Cartograph index directory (machine-local; do not commit)\n.cartograph/\n',
    );
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 999;\n');
    expect(hasUncommittedChanges(dir)).toBe(true);
  });
});

describe('getUncommittedSourcePaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-git-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the dirty paths, excluding cartograph metadata', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');
    fs.mkdirSync(path.join(dir, '.cartograph'));
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db'), 'index');
    expect(new Set(getUncommittedSourcePaths(dir))).toEqual(new Set(['b.ts', 'notes.md']));
  });

  it('lets the freshness hedge ignore a sole untracked non-indexed file (issue #6)', () => {
    // A stray untracked markdown doc is the only dirty path. The index
    // is in sync with HEAD and `sync` can never clear it, so an
    // indexable-only filter (the freshness hedge) must see nothing to
    // warn about — while a real source edit is still flagged.
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'AUDIT.md'), '# audit\n');

    const indexableDirty = (root: string) =>
      getUncommittedSourcePaths(root).some((p) => isLanguageSupported(detectLanguage(p)));

    // The markdown doc is dirty, but not of an indexable type.
    expect(getUncommittedSourcePaths(dir)).toEqual(['docs/AUDIT.md']);
    expect(indexableDirty(dir)).toBe(false);

    // Add an untracked .ts file — now there IS an indexable dirty path.
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');
    expect(indexableDirty(dir)).toBe(true);
  });
});
