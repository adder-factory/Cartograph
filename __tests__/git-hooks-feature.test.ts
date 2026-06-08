import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installGitHooks,
  parseGitHooksOption,
  renderGitHookBlock,
  runInstallHooksCommand,
  validateGitHookCommand,
} from '../src/features/git-hooks/index.js';

let projectPath: string;

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
});
