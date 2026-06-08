import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitWorktreeRoot } from '../../git-utils.js';

export const SUPPORTED_GIT_HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'] as const;
export const DEFAULT_GIT_HOOKS = SUPPORTED_GIT_HOOKS;

export type SupportedGitHook = (typeof SUPPORTED_GIT_HOOKS)[number];
export type GitHooksMode = 'install' | 'remove';
export type GitHookStatus = 'installed' | 'updated' | 'unchanged' | 'removed' | 'missing';

export interface InstallGitHooksOptions {
  projectPath: string;
  hooks?: string | undefined;
  command?: string | undefined;
  remove?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface GitHookChange {
  hook: SupportedGitHook;
  path: string;
  status: GitHookStatus;
}

export interface InstallGitHooksSuccess {
  ok: true;
  mode: GitHooksMode;
  dryRun: boolean;
  projectPath: string;
  hooksDir: string;
  changes: GitHookChange[];
}

export interface GitHooksError {
  code: 'invalid-hooks' | 'invalid-command' | 'git-root-not-found' | 'git-hooks-dir-not-found' | 'hook-write-failed';
  message: string;
  remediation?: string;
}

export type InstallGitHooksResult = InstallGitHooksSuccess | { ok: false; error: GitHooksError; exitCode: 1 };

const BEGIN_MARKER = '# >>> cartograph install-hooks >>>';
const END_MARKER = '# <<< cartograph install-hooks <<<';

const OWNER_READ_WRITE_EXECUTE_MODE = 0o700;
const SHELL_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

function uniqueHooks(hooks: readonly SupportedGitHook[]): SupportedGitHook[] {
  return [...new Set(hooks)];
}

export function parseGitHooksOption(
  raw: string | undefined,
): { ok: true; hooks: SupportedGitHook[] } | { ok: false; error: GitHooksError } {
  if (raw === undefined || raw.trim().length === 0) return { ok: true, hooks: uniqueHooks(DEFAULT_GIT_HOOKS) };
  const supported = new Set<string>(SUPPORTED_GIT_HOOKS);
  const values = raw
    .split(',')
    .map((hook) => hook.trim())
    .filter((hook) => hook.length > 0);
  const invalid = values.filter((hook) => !supported.has(hook));
  if (invalid.length > 0 || values.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-hooks',
        message: `--hooks must be a comma-separated subset of ${SUPPORTED_GIT_HOOKS.join(', ')}.`,
      },
    };
  }
  return { ok: true, hooks: uniqueHooks(values as SupportedGitHook[]) };
}

export function validateGitHookCommand(
  raw: string | undefined,
): { ok: true; command: string } | { ok: false; error: GitHooksError } {
  if (raw === undefined) return { ok: true, command: 'cartograph' };
  const command = raw.trim();
  if (command.length === 0 || /[\r\n]/.test(command)) {
    return {
      ok: false,
      error: {
        code: 'invalid-command',
        message: '--command must be a single executable name or path.',
      },
    };
  }
  return { ok: true, command };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", SHELL_SINGLE_QUOTE_ESCAPE)}'`;
}

export function renderGitHookBlock(command: string): string {
  return [
    BEGIN_MARKER,
    `cartograph_command=${shellQuote(command)}`,
    'cartograph_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"',
    'if [ -n "$cartograph_root" ] && [ -d "$cartograph_root/.cartograph" ]; then',
    '  "$cartograph_command" admin sync "$cartograph_root" --quiet >/dev/null 2>&1 &',
    'fi',
    END_MARKER,
  ].join('\n');
}

function trimHookBoundaryEnd(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
  if (end > 0 && value[end - 1] === '\n') end--;
  return value.slice(0, end);
}

function trimSingleLeadingNewline(value: string): string {
  return value.startsWith('\n') ? value.slice(1) : value;
}

function stripManagedHookBlock(content: string): { content: string; removed: boolean } {
  let current = content;
  let removed = false;
  while (true) {
    const start = current.indexOf(BEGIN_MARKER);
    if (start === -1) break;
    const end = current.indexOf(END_MARKER, start);
    if (end === -1) break;
    const blockEnd = end + END_MARKER.length;
    const before = trimHookBoundaryEnd(current.slice(0, start));
    const after = trimSingleLeadingNewline(current.slice(blockEnd));
    current = [before, after].filter((part) => part.length > 0).join('\n');
    removed = true;
  }
  return { content: current, removed };
}

function composeHookContent(existing: string | undefined, command: string): string {
  const stripped = stripManagedHookBlock(existing ?? '').content.trimEnd();
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '#!/bin/sh\n\n';
  return `${prefix}${renderGitHookBlock(command)}\n`;
}

function resolveGitRoot(projectPath: string): string | null {
  return gitWorktreeRoot(projectPath);
}

function readGitDir(projectPath: string): string | null {
  const dotGit = path.join(projectPath, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(dotGit, 'utf-8').trim();
    const prefix = 'gitdir:';
    if (!content.toLowerCase().startsWith(prefix)) return null;
    const rawGitDir = content.slice(prefix.length).trim();
    if (!rawGitDir) return null;
    return path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(projectPath, rawGitDir);
  } catch {
    return null;
  }
}

function readCommonGitDir(gitDir: string): string {
  const commonDirFile = path.join(gitDir, 'commondir');
  try {
    const rawCommonDir = fs.readFileSync(commonDirFile, 'utf-8').trim();
    if (!rawCommonDir) return gitDir;
    return path.isAbsolute(rawCommonDir) ? rawCommonDir : path.resolve(gitDir, rawCommonDir);
  } catch {
    return gitDir;
  }
}

function resolveGitHooksDir(projectPath: string): string | null {
  const gitDir = readGitDir(projectPath);
  if (!gitDir) return null;
  return path.join(readCommonGitDir(gitDir), 'hooks');
}

function hookPath(hooksDir: string, hook: SupportedGitHook): string {
  return path.join(hooksDir, hook);
}

function readExistingHook(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function installOneHook(args: {
  hook: SupportedGitHook;
  hooksDir: string;
  command: string;
  dryRun: boolean;
}): GitHookChange {
  const filePath = hookPath(args.hooksDir, args.hook);
  const existing = readExistingHook(filePath);
  const next = composeHookContent(existing, args.command);
  let status: GitHookStatus = 'updated';
  if (existing === undefined) status = 'installed';
  else if (existing === next) status = 'unchanged';
  if (!args.dryRun && existing !== next) {
    fs.mkdirSync(args.hooksDir, { recursive: true });
    fs.writeFileSync(filePath, next, 'utf-8');
    fs.chmodSync(filePath, OWNER_READ_WRITE_EXECUTE_MODE);
  }
  return { hook: args.hook, path: filePath, status };
}

function removeOneHook(args: { hook: SupportedGitHook; hooksDir: string; dryRun: boolean }): GitHookChange {
  const filePath = hookPath(args.hooksDir, args.hook);
  const existing = readExistingHook(filePath);
  if (existing === undefined) return { hook: args.hook, path: filePath, status: 'missing' };
  const stripped = stripManagedHookBlock(existing);
  if (!stripped.removed) return { hook: args.hook, path: filePath, status: 'missing' };
  if (!args.dryRun) fs.writeFileSync(filePath, `${stripped.content.trimEnd()}\n`, 'utf-8');
  return { hook: args.hook, path: filePath, status: 'removed' };
}

export function installGitHooks(options: InstallGitHooksOptions): InstallGitHooksResult {
  const hookList = parseGitHooksOption(options.hooks);
  if (!hookList.ok) return { ok: false, error: hookList.error, exitCode: 1 };
  const command = validateGitHookCommand(options.command);
  if (!command.ok) return { ok: false, error: command.error, exitCode: 1 };

  const projectPath = resolveGitRoot(options.projectPath);
  if (!projectPath) {
    return {
      ok: false,
      exitCode: 1,
      error: {
        code: 'git-root-not-found',
        message: `No git repository found for ${options.projectPath}.`,
        remediation: 'Run this from inside a git working tree.',
      },
    };
  }

  const hooksDir = resolveGitHooksDir(projectPath);
  if (!hooksDir) {
    return {
      ok: false,
      exitCode: 1,
      error: {
        code: 'git-hooks-dir-not-found',
        message: `Could not resolve the git hooks directory for ${projectPath}.`,
      },
    };
  }

  try {
    const dryRun = options.dryRun === true;
    const mode: GitHooksMode = options.remove ? 'remove' : 'install';
    const changes = hookList.hooks.map((hook) =>
      mode === 'remove'
        ? removeOneHook({ hook, hooksDir, dryRun })
        : installOneHook({ hook, hooksDir, command: command.command, dryRun }),
    );
    return { ok: true, mode, dryRun, projectPath, hooksDir, changes };
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      error: {
        code: 'hook-write-failed',
        message: `Failed to write git hooks: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

export function formatGitHooksResult(result: InstallGitHooksSuccess): string {
  let verb = 'installed';
  if (result.dryRun) verb = 'would change';
  else if (result.mode === 'remove') verb = 'updated';
  const lines = [`Git hooks ${verb} for ${result.projectPath}:`];
  for (const change of result.changes) {
    lines.push(`- ${change.hook}: ${change.status} (${change.path})`);
  }
  return lines.join('\n');
}
