import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectGitHooksLiveness,
  installGitHooks,
  parseGitHooksOption,
  renderGitHookBlock,
  runInstallHooksCommand,
  validateGitHookCommand,
} from '../src/features/git-hooks/index.js';

let projectPath: string;
const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');

function initGitProject(): void {
  execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
  fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
}

function hookPath(name: string): string {
  return path.join(projectPath, '.git', 'hooks', name);
}

describe('git hooks feature', () => {
  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-hooks-'));
    initGitProject();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('installs managed hook blocks idempotently', () => {
    const result = installGitHooks({ projectPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((change) => `${change.hook}:${change.status}`)).toEqual([
      'post-merge:installed',
      'post-checkout:installed',
      'post-rewrite:installed',
    ]);

    const postMerge = fs.readFileSync(hookPath('post-merge'), 'utf-8');
    expect(postMerge).toContain('#!/bin/sh');
    expect(postMerge).toContain('cartograph_command=');
    expect(postMerge).toContain('"$cartograph_command" admin sync "$cartograph_root" --quiet');

    const second = installGitHooks({ projectPath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changes.every((change) => change.status === 'unchanged')).toBe(true);
  });

  it('preserves existing hook content and removes only the managed block', () => {
    const existing = '#!/bin/sh\necho custom\n';
    fs.writeFileSync(hookPath('post-merge'), existing, 'utf-8');

    const installed = installGitHooks({ projectPath, hooks: 'post-merge', command: '/opt/cartograph/bin/cartograph' });
    expect(installed.ok).toBe(true);
    expect(fs.readFileSync(hookPath('post-merge'), 'utf-8')).toContain('echo custom');

    const removed = installGitHooks({ projectPath, hooks: 'post-merge', remove: true });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.changes[0]?.status).toBe('removed');
    expect(fs.readFileSync(hookPath('post-merge'), 'utf-8')).toBe(existing);
  });

  it('supports dry-run without writing hooks', () => {
    const result = installGitHooks({ projectPath, hooks: 'post-merge', dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes[0]?.status).toBe('installed');
    expect(fs.existsSync(hookPath('post-merge'))).toBe(false);
  });

  it('validates hook names and command shape', () => {
    expect(parseGitHooksOption('post-merge,post-checkout')).toEqual({
      ok: true,
      hooks: ['post-merge', 'post-checkout'],
    });
    expect(parseGitHooksOption('pre-commit').ok).toBe(false);
    expect(validateGitHookCommand(' \n ').ok).toBe(false);
    expect(renderGitHookBlock("cartograph's bin")).toContain("cartograph'\\''s bin");
  });

  it('managed hook block calls a registered quiet admin sync command', () => {
    const block = renderGitHookBlock('cartograph');
    expect(block).toContain('"$cartograph_command" admin sync "$cartograph_root" --quiet');

    const help = execFileSync('bun', [cliEntry, 'admin', 'sync', '--help'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(help).toContain('Sync changes since last index');
    expect(help).toContain('--quiet');
  });

  it('registers a CLI adapter that renders hook changes', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    runInstallHooksCommand(
      projectPath,
      { hooks: 'post-merge', dryRun: true },
      {
        resolveProjectPath: (pathArg?: string) => pathArg ?? projectPath,
        error: (message: string) => stderr.push(message),
        writeStdout: (message = '') => stdout.push(message),
      },
    );
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('post-merge: installed');
  });

  function setHooksPath(value: string): void {
    execFileSync('git', ['config', 'core.hooksPath', value], { cwd: projectPath, stdio: 'ignore' });
  }

  it('writes to the tracked .husky/ files when husky owns core.hooksPath', () => {
    fs.mkdirSync(path.join(projectPath, '.husky', '_'), { recursive: true });
    setHooksPath('.husky/_');

    const result = installGitHooks({ projectPath, hooks: 'post-merge' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hooksDirSource).toBe('husky');
    expect(result.note).toContain('husky');

    const huskyHook = path.join(projectPath, '.husky', 'post-merge');
    expect(fs.readFileSync(huskyHook, 'utf-8')).toContain('cartograph_command=');
    expect(fs.existsSync(path.join(projectPath, '.husky', '_', 'post-merge'))).toBe(false);
    expect(fs.existsSync(hookPath('post-merge'))).toBe(false);

    const removed = installGitHooks({ projectPath, hooks: 'post-merge', remove: true });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.changes[0]?.status).toBe('removed');
    expect(fs.readFileSync(huskyHook, 'utf-8')).not.toContain('cartograph_command=');
  });

  it('refuses to write when core.hooksPath escapes the worktree', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-outside-hooks-'));
    try {
      setHooksPath(outsideDir);

      const result = installGitHooks({ projectPath, hooks: 'post-merge' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('hooks-path-outside-worktree');
      expect(result.error.remediation).toContain('cartograph_command=');
      expect(fs.existsSync(path.join(outsideDir, 'post-merge'))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('writes to a custom core.hooksPath directory instead of .git/hooks', () => {
    setHooksPath('githooks');

    const result = installGitHooks({ projectPath, hooks: 'post-merge' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hooksDirSource).toBe('core.hooksPath');

    const customHook = path.join(projectPath, 'githooks', 'post-merge');
    expect(fs.readFileSync(customHook, 'utf-8')).toContain('cartograph_command=');
    expect(fs.existsSync(hookPath('post-merge'))).toBe(false);
  });

  it('heals blocks stranded in .git/hooks once core.hooksPath redirects execution', () => {
    const first = installGitHooks({ projectPath, hooks: 'post-merge' });
    expect(first.ok).toBe(true);
    expect(fs.readFileSync(hookPath('post-merge'), 'utf-8')).toContain('cartograph_command=');

    setHooksPath('githooks');
    const dead = inspectGitHooksLiveness(projectPath);
    expect(dead?.dead).toEqual(['post-merge']);
    expect(dead?.live).toEqual([]);

    const second = installGitHooks({ projectPath, hooks: 'post-merge' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const statuses = second.changes.map((change) => `${path.basename(path.dirname(change.path))}:${change.status}`);
    expect(statuses).toContain('githooks:installed');
    expect(statuses).toContain('hooks:removed');
    expect(fs.readFileSync(hookPath('post-merge'), 'utf-8')).not.toContain('cartograph_command=');

    const alive = inspectGitHooksLiveness(projectPath);
    expect(alive?.live).toEqual(['post-merge']);
    expect(alive?.dead).toEqual([]);
  });
});
