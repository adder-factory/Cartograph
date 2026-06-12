import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitCoreHooksPath, gitWorktreeRoot } from '../../git-utils.js';

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

/** Where the effective hooks directory came from. `husky` means
 *  core.hooksPath pointed at husky's generated `.husky/_` runner dir
 *  and the managed blocks went to the tracked `.husky/` siblings. */
export type HooksDirSource = 'default' | 'core.hooksPath' | 'husky';

export interface InstallGitHooksSuccess {
  ok: true;
  mode: GitHooksMode;
  dryRun: boolean;
  projectPath: string;
  hooksDir: string;
  hooksDirSource: HooksDirSource;
  changes: GitHookChange[];
  /** One-line explanation when blocks were NOT written to `.git/hooks`
   *  (a hook manager owns `core.hooksPath`) — surfaced by the CLI. */
  note?: string;
}

export interface GitHooksError {
  code:
    | 'invalid-hooks'
    | 'invalid-command'
    | 'git-root-not-found'
    | 'git-hooks-dir-not-found'
    | 'hooks-path-outside-worktree'
    | 'hook-write-failed';
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

interface HooksTarget {
  dir: string;
  source: HooksDirSource;
  note?: string;
}

/**
 * Where git will actually EXECUTE hooks for this repo, honoring
 * `core.hooksPath` (issue #4 — hook managers set it and git then
 * ignores `.git/hooks` entirely).
 *
 * Husky special case: husky v9 points core.hooksPath at its generated
 * `.husky/_` runner directory (gitignored, regenerated by `husky` on
 * prepare); its shims execute the TRACKED `.husky/<hook>` siblings, so
 * the managed block belongs in the parent directory, not in `_`.
 */
function resolveHooksTarget(projectPath: string): HooksTarget | null {
  const configured = gitCoreHooksPath(projectPath);
  if (!configured) {
    const dir = resolveGitHooksDir(projectPath);
    return dir ? { dir, source: 'default' } : null;
  }
  const absolute = path.isAbsolute(configured) ? configured : path.resolve(projectPath, configured);
  if (path.basename(absolute) === '_' && path.basename(path.dirname(absolute)) === '.husky') {
    const huskyDir = path.dirname(absolute);
    return {
      dir: huskyDir,
      source: 'husky',
      note: `core.hooksPath=${configured} (husky) — managed blocks written to ${huskyDir}, which husky's runner executes.`,
    };
  }
  return {
    dir: absolute,
    source: 'core.hooksPath',
    note: `core.hooksPath=${configured} — managed blocks written there; git ignores .git/hooks while it is set.`,
  };
}

function hookPath(hooksDir: string, hook: SupportedGitHook): string {
  return path.join(hooksDir, hook);
}

/** Lexical containment check — `dir` is `root` itself or below it. */
function isInsideWorktree(root: string, dir: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Refuse to WRITE to a core.hooksPath that escapes the worktree: a
 * cloned repo's config would otherwise steer executable shell content
 * to an attacker-chosen absolute path (`~/Library/LaunchAgents`,
 * `/etc/cron.d`, …). The default `.git/hooks` location is exempt —
 * linked worktrees legitimately keep it outside.
 */
function hooksPathEscapeError(target: HooksTarget, projectPath: string, command: string): GitHooksError | null {
  if (target.source === 'default' || isInsideWorktree(projectPath, target.dir)) return null;
  return {
    code: 'hooks-path-outside-worktree',
    message: `core.hooksPath resolves to ${target.dir}, outside this repository — refusing to write hooks there.`,
    remediation: `If that hooks directory is intentional, append Cartograph's managed block to its post-merge / post-checkout / post-rewrite files yourself:\n${renderGitHookBlock(command)}`,
  };
}

/**
 * Run the per-hook install/remove over the effective target dir. When
 * core.hooksPath redirects execution away from `.git/hooks`, also
 * strip any managed blocks stranded there by a pre-hooksPath-aware
 * install — they will never fire and would mislead a reader. The
 * cleanup entries are distinguishable from the primary changes by
 * their `.git/hooks` path; they run in BOTH modes (install heals,
 * remove leaves nothing behind).
 */
function applyHookChanges(args: {
  hooks: SupportedGitHook[];
  target: HooksTarget;
  projectPath: string;
  command: string;
  mode: GitHooksMode;
  dryRun: boolean;
}): GitHookChange[] {
  const { hooks, target, projectPath, command, mode, dryRun } = args;
  const changes = hooks.map((hook) =>
    mode === 'remove'
      ? removeOneHook({ hook, hooksDir: target.dir, dryRun })
      : installOneHook({ hook, hooksDir: target.dir, command, dryRun }),
  );
  const defaultDir = target.source === 'default' ? null : resolveGitHooksDir(projectPath);
  if (defaultDir && defaultDir !== target.dir) {
    for (const hook of hooks) {
      const cleaned = removeOneHook({ hook, hooksDir: defaultDir, dryRun });
      if (cleaned.status === 'removed') changes.push(cleaned);
    }
  }
  return changes;
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

  const target = resolveHooksTarget(projectPath);
  if (!target) {
    return {
      ok: false,
      exitCode: 1,
      error: {
        code: 'git-hooks-dir-not-found',
        message: `Could not resolve the git hooks directory for ${projectPath}.`,
      },
    };
  }

  const escapeError = hooksPathEscapeError(target, projectPath, command.command);
  if (escapeError) return { ok: false, exitCode: 1, error: escapeError };

  try {
    const dryRun = options.dryRun === true;
    const mode: GitHooksMode = options.remove ? 'remove' : 'install';
    const changes = applyHookChanges({
      hooks: hookList.hooks,
      target,
      projectPath,
      command: command.command,
      mode,
      dryRun,
    });
    return {
      ok: true,
      mode,
      dryRun,
      projectPath,
      hooksDir: target.dir,
      hooksDirSource: target.source,
      changes,
      ...(target.note ? { note: target.note } : {}),
    };
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
  if (result.note) lines.push(`Note: ${result.note}`);
  return lines.join('\n');
}

export interface GitHooksLiveness {
  /** Directory whose hook files git will actually execute (husky:
   *  the tracked `.husky/` dir its runner delegates to). */
  effectiveDir: string;
  source: HooksDirSource;
  /** Hooks whose managed block sits in the effective location. */
  live: SupportedGitHook[];
  /** Hooks whose managed block sits ONLY in `.git/hooks` while
   *  core.hooksPath redirects execution elsewhere — they never fire. */
  dead: SupportedGitHook[];
}

function hasManagedBlock(hooksDir: string, hook: SupportedGitHook): boolean {
  try {
    return fs.readFileSync(hookPath(hooksDir, hook), 'utf-8').includes(BEGIN_MARKER);
  } catch {
    return false; // missing or unreadable — not a live hook either way
  }
}

/**
 * Doctor-facing inspection: where would hooks fire, and are any
 * managed blocks stranded in a location git no longer reads? Returns
 * null when the project is not a git worktree.
 */
export function inspectGitHooksLiveness(projectPath: string): GitHooksLiveness | null {
  const root = resolveGitRoot(projectPath);
  if (!root) return null;
  const target = resolveHooksTarget(root);
  if (!target) return null;
  const live = SUPPORTED_GIT_HOOKS.filter((hook) => hasManagedBlock(target.dir, hook));
  let dead: SupportedGitHook[] = [];
  if (target.source !== 'default') {
    const defaultDir = resolveGitHooksDir(root);
    if (defaultDir && defaultDir !== target.dir) {
      dead = SUPPORTED_GIT_HOOKS.filter((hook) => hasManagedBlock(defaultDir, hook));
    }
  }
  return { effectiveDir: target.dir, source: target.source, live, dead };
}
