import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getGitChangedFiles } from '../src/extraction/index.js';
import { DEFAULT_CONFIG, type CartographConfig } from '../src/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-changes-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): string {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'export const tracked = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'remove-me.ts'), 'export const gone = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return git(dir, 'rev-parse', 'HEAD');
}

const config: CartographConfig = {
  ...DEFAULT_CONFIG,
  include: ['src/**/*.ts'],
  exclude: ['src/excluded/**'],
};

describe('getGitChangedFiles', () => {
  it('classifies modified, added, deleted, quoted, and excluded working-tree paths', () => {
    const dir = tempDir();
    try {
      const head = initRepo(dir);
      fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'export const tracked = 2;\n');
      fs.rmSync(path.join(dir, 'src', 'remove-me.ts'));
      fs.writeFileSync(path.join(dir, 'src', 'new file.ts'), 'export const spaced = 1;\n');
      fs.writeFileSync(path.join(dir, 'src', 'unicode-ß.ts'), 'export const unicode = 1;\n');
      fs.mkdirSync(path.join(dir, 'src', 'excluded'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'excluded', 'skip.ts'), 'export const skip = 1;\n');

      const result = getGitChangedFiles(dir, config, head);

      expect(result).not.toBeNull();
      expect(result!.needsFullReindex).toBe(false);
      expect(result!.currentHead).toBe(head);
      expect(result!.changes.modified).toContain('src/tracked.ts');
      expect(result!.changes.added).toContain('src/new file.ts');
      expect(result!.changes.added).toContain('src/unicode-ß.ts');
      expect(result!.changes.added).not.toContain('src/excluded/skip.ts');
      expect(result!.changes.deleted).toContain('src/remove-me.ts');
    } finally {
      cleanup(dir);
    }
  });

  it('unions committed changes since the last synced head', () => {
    const dir = tempDir();
    try {
      const initial = initRepo(dir);
      fs.writeFileSync(path.join(dir, 'src', 'committed.ts'), 'export const committed = 1;\n');
      fs.rmSync(path.join(dir, 'src', 'remove-me.ts'));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'second');

      const result = getGitChangedFiles(dir, config, initial);

      expect(result).not.toBeNull();
      expect(result!.needsFullReindex).toBe(false);
      expect(result!.currentHead).not.toBe(initial);
      expect(result!.changes.modified).toContain('src/committed.ts');
      expect(result!.changes.deleted).toContain('src/remove-me.ts');
    } finally {
      cleanup(dir);
    }
  });

  it('falls back to full reindex when the last synced head is unreachable', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      const missingHead = '0'.repeat(40);

      const result = getGitChangedFiles(dir, config, missingHead);

      expect(result).not.toBeNull();
      expect(result!.needsFullReindex).toBe(true);
      expect(result!.changes.added).toEqual([]);
      expect(result!.changes.modified).toEqual([]);
      expect(result!.changes.deleted).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('returns null outside a git repository', () => {
    const dir = tempDir();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'file.ts'), 'export const x = 1;\n');
      expect(getGitChangedFiles(dir, config, null)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});
