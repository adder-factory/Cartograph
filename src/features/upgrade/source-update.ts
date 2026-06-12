/**
 * In-place self-update for source checkouts.
 *
 * Cartograph's primary install path is `git clone` + `bun install` +
 * `bun link` (it is not published to npm), so "update" means updating
 * the checkout the running CLI was loaded from. This module detects
 * how the process was installed and, for source checkouts, performs a
 * guarded fast-forward: fetch the tracked remote, refuse anything that
 * could lose local work (dirty tree, local commits, detached HEAD),
 * `git merge --ff-only`, then `bun install` for dependency changes.
 *
 * Expected failures are encoded in the returned `UpgradeCheckResult`
 * (`status: 'blocked'` + remediation steps), not thrown.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBunStandalonePath } from '../../bun-standalone.js';
import { errMsg } from '../../errors.js';
import { gitWorktreeRoot, hasUncommittedChanges } from '../../git-utils.js';
import type { UpgradeCheckResult } from './runtime.js';

export type InstallMethod =
  | { kind: 'source'; root: string }
  | { kind: 'standalone' }
  | { kind: 'package'; root: string }
  | { kind: 'unknown' };

const CARTOGRAPH_PACKAGE_NAME = '@adder-factory/cartograph';

const GIT_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const LOCAL_GIT_OPTIONS = {
  encoding: 'utf-8' as const,
  timeout: 10_000,
  maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
  stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
};

/** `git fetch` hits the network; give it far more headroom than local
 *  plumbing calls before declaring the remote unreachable. */
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** `bun install` may download packages and rebuild native deps. */
const INSTALL_TIMEOUT_MS = 600_000;

const RESTART_STEP = 'Restart any running MCP server/client sessions so they load the updated code.';

/**
 * Classify how the running Cartograph was installed, from the on-disk
 * location of this module: a Bun standalone binary (virtual `/$bunfs/`
 * path), a git source checkout (package root IS a git worktree root),
 * or a package-manager install (package root inside someone else's
 * tree, e.g. `node_modules/`, or not a git worktree at all).
 */
export function detectInstallMethod(moduleUrl: string = import.meta.url): InstallMethod {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return { kind: 'unknown' };
  }
  if (isBunStandalonePath(modulePath)) return { kind: 'standalone' };
  const packageRoot = findOwnPackageRoot(path.dirname(realpathOrSelf(modulePath)));
  if (!packageRoot) return { kind: 'unknown' };
  const worktree = gitWorktreeRoot(packageRoot);
  if (worktree && worktree === realpathOrSelf(packageRoot)) return { kind: 'source', root: packageRoot };
  return { kind: 'package', root: packageRoot };
}

export interface RunSourceUpgradeOptions {
  root: string;
  currentVersion: string;
  apply: boolean;
  /** Injectable for tests; defaults to running `bun install` in `root`. */
  runInstall?: ((root: string) => void) | undefined;
}

/** Shared fields of every result a source upgrade can produce. */
interface SourceResultBase {
  method: 'source';
  currentVersion: string;
  applyRequested: boolean;
  applied: false;
}

/** Freshness of an ff-able checkout that is strictly behind upstream. */
interface BehindUpstream {
  upstream: string;
  behind: number;
  upstreamVersion: string | null;
  behindSummary: string;
  warning: string | undefined;
}

/**
 * Check a source checkout against its tracked remote and, with
 * `apply: true`, fast-forward it and reinstall dependencies. All
 * git/network/install failures come back as `blocked`/`unknown`
 * results with remediation steps.
 */
export async function runSourceUpgrade(options: RunSourceUpgradeOptions): Promise<UpgradeCheckResult> {
  const base: SourceResultBase = {
    method: 'source',
    currentVersion: options.currentVersion,
    applyRequested: options.apply === true,
    applied: false,
  };
  const freshness = assessFreshness(options.root, base);
  if (isResult(freshness)) return freshness;

  if (!base.applyRequested) {
    return {
      ...base,
      status: 'update_available',
      latestVersion: freshness.upstreamVersion,
      message: freshness.behindSummary,
      nextSteps: [
        'Run `cartograph upgrade --apply` to fast-forward the checkout and reinstall dependencies.',
        RESTART_STEP,
      ],
      warning: freshness.warning,
    };
  }

  return applyFastForward(options, freshness, base);
}

function isResult(value: UpgradeCheckResult | BehindUpstream): value is UpgradeCheckResult {
  return 'status' in value;
}

interface BlockedResultArgs {
  base: SourceResultBase;
  message: string;
  nextSteps: string[];
  latestVersion?: string | null;
}

function blockedResult(args: BlockedResultArgs): UpgradeCheckResult {
  return {
    ...args.base,
    status: 'blocked',
    latestVersion: args.latestVersion ?? null,
    message: args.message,
    nextSteps: args.nextSteps,
  };
}

/**
 * Resolve tracking state, fetch, and compare. Returns a final result
 * for every state except "strictly behind and fast-forwardable", which
 * comes back as `BehindUpstream` data for the caller to act on.
 */
function assessFreshness(root: string, base: SourceResultBase): UpgradeCheckResult | BehindUpstream {
  const branch = currentBranch(root);
  if (!branch) {
    return blockedResult({
      base,
      message: `The checkout at ${root} is on a detached HEAD, so there is no branch to fast-forward.`,
      nextSteps: ['Check out a branch (e.g. `git checkout main`), then re-run `cartograph upgrade --apply`.'],
    });
  }
  const remote = trackedRemote(root, branch);
  const upstream = upstreamRef(root);
  if (!remote || !upstream) {
    return blockedResult({
      base,
      message: `Branch '${branch}' at ${root} has no upstream to update from.`,
      nextSteps: [
        `Set one with \`git branch --set-upstream-to=origin/${branch} ${branch}\`, then re-run \`cartograph upgrade\`.`,
      ],
    });
  }

  const fetchError = fetchRemote(root, remote);
  const warning = fetchError
    ? `git fetch ${remote} failed (${fetchError}); comparing against the last fetched state.`
    : undefined;

  const counts = aheadBehind(root);
  if (!counts) {
    return {
      ...base,
      status: 'unknown',
      latestVersion: null,
      message: `Could not compare the checkout at ${root} with ${upstream}.`,
      nextSteps: [`Inspect the checkout manually: \`git -C ${root} status\`.`],
      warning,
    };
  }

  const upstreamVersion = packageVersionAtUpstream(root);
  if (counts.behind === 0) {
    return {
      ...base,
      status: 'current',
      latestVersion: upstreamVersion,
      message: `The checkout is current with ${upstream}${currentNote(counts.ahead, base.currentVersion)}.`,
      nextSteps: ['No update action is needed.'],
      warning,
    };
  }

  const delta = versionDelta(base.currentVersion, upstreamVersion);
  const behindSummary = `The checkout is ${counts.behind} commit(s) behind ${upstream} (${delta}).`;
  if (counts.ahead > 0) {
    return blockedResult({
      base,
      message: `${behindSummary} It also has ${counts.ahead} local commit(s), so a fast-forward is not possible.`,
      nextSteps: [
        `Reconcile manually: \`git -C ${root} pull --rebase\`, then \`bun install\` in the checkout.`,
        RESTART_STEP,
      ],
      latestVersion: upstreamVersion,
    });
  }
  return { upstream, behind: counts.behind, upstreamVersion, behindSummary, warning };
}

function currentNote(ahead: number, currentVersion: string): string {
  if (ahead > 0) return ` with ${ahead} local commit(s) on top — nothing to pull`;
  return ` (${currentVersion})`;
}

function versionDelta(currentVersion: string, upstreamVersion: string | null): string {
  if (upstreamVersion && upstreamVersion !== currentVersion) return `${currentVersion} → ${upstreamVersion}`;
  return `version unchanged: ${currentVersion}`;
}

/** Guarded mutation step: clean-tree check, ff merge, dependency install. */
function applyFastForward(
  options: RunSourceUpgradeOptions,
  freshness: BehindUpstream,
  base: SourceResultBase,
): UpgradeCheckResult {
  const { root } = options;
  const { upstream, behind, upstreamVersion, behindSummary, warning } = freshness;

  if (hasUncommittedChanges(root)) {
    return blockedResult({
      base,
      message: `${behindSummary} The working tree has uncommitted changes, so the update was not applied.`,
      nextSteps: ['Commit or stash your changes, then re-run `cartograph upgrade --apply`.'],
      latestVersion: upstreamVersion,
    });
  }

  const mergeError = fastForward(root);
  if (mergeError) {
    return blockedResult({
      base,
      message: `git merge --ff-only failed: ${mergeError}`,
      nextSteps: [`Inspect the checkout manually: \`git -C ${root} status\`.`],
      latestVersion: upstreamVersion,
    });
  }

  const versionAfter = localPackageVersion(root) ?? upstreamVersion;
  try {
    (options.runInstall ?? runBunInstall)(root);
  } catch (err) {
    return {
      ...base,
      status: 'updated',
      applied: true,
      latestVersion: versionAfter,
      message: `Fast-forwarded ${behind} commit(s) from ${upstream} (now ${versionAfter ?? 'unknown version'}).`,
      nextSteps: [`Run \`bun install\` in ${root} to finish updating dependencies.`, RESTART_STEP],
      warning: `Checkout updated, but \`bun install\` failed: ${errMsg(err)}`,
    };
  }

  return {
    ...base,
    status: 'updated',
    applied: true,
    latestVersion: versionAfter,
    message: `Updated ${base.currentVersion} → ${versionAfter ?? 'unknown version'} (${behind} commit(s) fast-forwarded from ${upstream}).`,
    nextSteps: [RESTART_STEP, 'Run `cartograph status` to confirm index and feature readiness.'],
    warning,
  };
}

// ── git plumbing (best-effort; null/error-string returns, no throws) ──

function currentBranch(root: string): string | null {
  try {
    const out = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function trackedRemote(root: string, branch: string): string | null {
  // `%(upstream:remotename)` instead of `git config branch.<name>.remote`:
  // a dot in the branch name makes the config key ambiguous (subsection
  // parsing), which would falsely report "no upstream" here.
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function upstreamRef(root: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Returns an error message on failure, undefined on success. */
function fetchRemote(root: string, remote: string): string | undefined {
  try {
    execFileSync('git', ['fetch', '--quiet', '--end-of-options', remote], {
      ...LOCAL_GIT_OPTIONS,
      timeout: GIT_FETCH_TIMEOUT_MS,
      cwd: root,
    });
    return undefined;
  } catch (err) {
    return errMsg(err);
  }
}

function aheadBehind(root: string): { ahead: number; behind: number } | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', '--left-right', 'HEAD...@{u}'], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    }).trim();
    const match = /^(\d+)\s+(\d+)$/.exec(out);
    if (!match) return null;
    return { ahead: Number(match[1]), behind: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Returns an error message on failure, undefined on success. */
function fastForward(root: string): string | undefined {
  try {
    execFileSync('git', ['merge', '--ff-only', '--quiet', '@{u}'], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    });
    return undefined;
  } catch (err) {
    return errMsg(err);
  }
}

function packageVersionAtUpstream(root: string): string | null {
  try {
    const raw = execFileSync('git', ['show', '@{u}:package.json'], {
      ...LOCAL_GIT_OPTIONS,
      cwd: root,
    });
    return parsePackageVersion(raw);
  } catch {
    return null;
  }
}

function localPackageVersion(root: string): string | null {
  try {
    return parsePackageVersion(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function parsePackageVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function runBunInstall(root: string): void {
  // Under Bun (the CLI's runtime — see the bin shebang), execPath IS
  // the bun binary; the PATH fallback covers non-Bun harnesses.
  const bun = process.versions.bun ? process.execPath : 'bun';
  execFileSync(bun, ['install'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function findOwnPackageRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (readPackageName(path.join(dir, 'package.json')) === CARTOGRAPH_PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
