/**
 * .cartographignore Tests
 *
 * Regression test for the bug where the .cartographignore marker file was
 * honored by the filesystem-walk fallback (`scanDirectoryWalk`) but
 * silently ignored by the git fast path (`getGitVisibleFiles` and
 * `getGitChangedFiles`). Same project gave different file sets depending
 * on whether `.git` existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanDirectory } from '../src/extraction/index.js';
import { getFileByPath } from '../src/db/queries-files.js';
import { DEFAULT_CONFIG, type CartographConfig } from '../src/types.js';
import Cartograph from '../src/index.js';
import { defaultLogger, setLogger, silentLogger } from '../src/errors.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const config: CartographConfig = {
  ...DEFAULT_CONFIG,
  include: ['**/*.ts'],
  exclude: [],
};

describe('.cartographignore marker (bug #3)', () => {
  describe('git fast path', () => {
    let dir: string;

    beforeEach(() => {
      dir = tempDir('cartograph-ignore-git-');
      git(dir, 'init');
      git(dir, 'config', 'user.email', 'test@test.com');
      git(dir, 'config', 'user.name', 'Test');
      // Pin branch name for determinism across git defaults
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.mkdirSync(path.join(dir, 'vendor', 'lib'));
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(dir, 'vendor', 'pkg.ts'), 'export const v = 1;');
      fs.writeFileSync(path.join(dir, 'vendor', 'lib', 'sub.ts'), 'export const s = 1;');
      // Mark vendor/ as ignored
      fs.writeFileSync(path.join(dir, 'vendor', '.cartographignore'), '');

      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'initial');
    });

    afterEach(() => {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('scanDirectory honors .cartographignore on the git fast path', () => {
      const files = scanDirectory(dir, config);
      expect(files).toContain('src/app.ts');
      expect(files).not.toContain('vendor/pkg.ts');
      expect(files).not.toContain('vendor/lib/sub.ts');
    });

    it('marker at project root excludes everything', () => {
      fs.writeFileSync(path.join(dir, '.cartographignore'), '');
      // Need to add it to git so ls-files sees it (or rely on -o)
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'add root marker');
      const files = scanDirectory(dir, config);
      expect(files).toEqual([]);
    });

    it('marker in nested subdir does not affect siblings', () => {
      // Add another sibling subdir without a marker
      fs.mkdirSync(path.join(dir, 'libs'));
      fs.writeFileSync(path.join(dir, 'libs', 'util.ts'), 'export const u = 1;');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'add libs');

      const files = scanDirectory(dir, config);
      expect(files).toContain('src/app.ts');
      expect(files).toContain('libs/util.ts');
      expect(files).not.toContain('vendor/pkg.ts');
    });

    it('respects marker added after initial commit (untracked marker)', () => {
      // The marker file itself need not be committed — it can be a local
      // override. Add marker AFTER commit, do not commit it.
      fs.mkdirSync(path.join(dir, 'generated'));
      fs.writeFileSync(path.join(dir, 'generated', 'gen.ts'), 'export const g = 1;');
      fs.writeFileSync(path.join(dir, 'generated', '.cartographignore'), '');
      // The .ts file is untracked but visible via `git ls-files -o`.
      // The marker is also untracked — we still detect it via fs check.

      const files = scanDirectory(dir, config);
      expect(files).not.toContain('generated/gen.ts');
    });

    it('root .ignore negation re-includes a gitignored source directory', () => {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'customer/\n');
      fs.writeFileSync(path.join(dir, '.ignore'), '!customer/\n');
      fs.mkdirSync(path.join(dir, 'customer'));
      fs.writeFileSync(path.join(dir, 'customer', 'adapter.ts'), 'export const c = 1;');

      const files = scanDirectory(dir, config);
      expect(files).toContain('src/app.ts');
      expect(files).toContain('customer/adapter.ts');
    });

    it('root .ignore can exclude a git-visible source file locally', () => {
      fs.writeFileSync(path.join(dir, 'src', 'local-only.ts'), 'export const local = 1;');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'add local-only');
      fs.writeFileSync(path.join(dir, '.ignore'), 'src/local-only.ts\n');

      const files = scanDirectory(dir, config);
      expect(files).toContain('src/app.ts');
      expect(files).not.toContain('src/local-only.ts');
    });

    it('skips binary root .ignore overrides with a path-bearing warning', () => {
      const warningContexts: Array<Record<string, unknown> | undefined> = [];
      setLogger({
        ...silentLogger,
        warn: (_message, context) => warningContexts.push(context),
      });

      try {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'customer/\n');
        fs.writeFileSync(path.join(dir, '.ignore'), Buffer.from([0xff, 0xfe, 0x00, 0x5b]));
        fs.mkdirSync(path.join(dir, 'customer'));
        fs.writeFileSync(path.join(dir, 'customer', 'adapter.ts'), 'export const c = 1;');

        const files = scanDirectory(dir, config);
        expect(files).toContain('src/app.ts');
        expect(files).not.toContain('customer/adapter.ts');
        expect(warningContexts.some((context) => context?.['path'] === path.join(dir, '.ignore'))).toBe(true);
      } finally {
        setLogger(defaultLogger);
      }
    });
  });

  describe('parity with non-git fallback (filesystem walk)', () => {
    let dir: string;

    beforeEach(() => {
      dir = tempDir('cartograph-ignore-walk-');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(dir, 'vendor', 'pkg.ts'), 'export const v = 1;');
      fs.writeFileSync(path.join(dir, 'vendor', '.cartographignore'), '');
    });

    afterEach(() => {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('non-git project also honors the marker (sanity / pre-existing behavior)', () => {
      const files = scanDirectory(dir, config);
      expect(files).toContain('src/app.ts');
      expect(files).not.toContain('vendor/pkg.ts');
    });
  });

  describe('sync git path (getGitChangedFiles)', () => {
    let dir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      dir = tempDir('cartograph-ignore-sync-');
      git(dir, 'init');
      git(dir, 'config', 'user.email', 'test@test.com');
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(dir, 'vendor', '.cartographignore'), '');

      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'initial');

      cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sync ignores changes inside marker dirs', async () => {
      // Add a new file under vendor/ — should NOT be picked up by sync.
      fs.writeFileSync(path.join(dir, 'vendor', 'leaked.ts'), 'export const x = 1;');
      // Also add a real change to confirm sync still runs.
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 2;');

      const result = await cg.sync();
      expect(result.changedFilePaths).toContain('src/app.ts');
      expect(result.changedFilePaths ?? []).not.toContain('vendor/leaked.ts');
    });
  });

  describe('root .ignore override sync path', () => {
    let dir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      dir = tempDir('cartograph-local-ignore-sync-');
      git(dir, 'init');
      git(dir, 'config', 'user.email', 'test@test.com');
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      fs.writeFileSync(path.join(dir, '.gitignore'), 'customer/\n');
      fs.writeFileSync(path.join(dir, '.ignore'), '!customer/\n');
      fs.mkdirSync(path.join(dir, 'customer'));
      fs.writeFileSync(path.join(dir, 'customer', 'client.ts'), 'export const client = 1;');
      fs.writeFileSync(path.join(dir, 'main.ts'), 'export const main = 1;');

      git(dir, 'add', '.gitignore', '.ignore', 'main.ts');
      git(dir, 'commit', '-m', 'initial');

      cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sync detects changed and new files under re-included gitignored dirs', async () => {
      expect(getFileByPath(cg.queries, 'customer/client.ts')).not.toBeNull();

      fs.writeFileSync(path.join(dir, 'customer', 'client.ts'), 'export const client = 2;');
      fs.writeFileSync(path.join(dir, 'customer', 'extra.ts'), 'export const extra = 1;');

      const result = await cg.sync();
      expect(result.changedFilePaths).toContain('customer/client.ts');
      expect(result.changedFilePaths).toContain('customer/extra.ts');
      expect(getFileByPath(cg.queries, 'customer/extra.ts')).not.toBeNull();
    });
  });
});
