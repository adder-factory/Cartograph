import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errMsg } from '../../errors.js';

const execFileAsync = promisify(execFile);

export type InstallMethodKind = 'source' | 'standalone' | 'package' | 'unknown';

/** Package + GitHub coordinates for the printed re-pin commands. */
export const CARTOGRAPH_PACKAGE_NAME = '@adder-factory/cartograph';

/**
 * The Bun-global install spec.
 *
 * `git+https://….git` (a real `git clone`) rather than the `github:org/repo`
 * shorthand on purpose: bun resolves the shorthand through GitHub's tarball
 * API (`api.github.com/repos/.../tarball/<ref>` → codeload), which has been
 * returning `504` consistently for this repo (issue #23). The `git+https`
 * form clones via git instead, reusing the user's existing git credential
 * helper, and sidesteps the tarball API entirely. This is the string every
 * re-pin/plan step emits.
 */
export const GIT_CLONE_INSTALL_REF = 'git+https://github.com/adder-factory/cartograph.git';
/** Canonical human-facing release index used by install and repair guidance. */
export const CARTOGRAPH_RELEASES_URL = 'https://github.com/adder-factory/cartograph/releases';

/**
 * Legacy `github:` shorthand. Retained ONLY so {@link
 * canRepinBunGlobal} still recognises installs pinned with the old form
 * as re-pinnable — a re-pin then migrates them to {@link
 * GIT_CLONE_INSTALL_REF}. Never emit this in a new install command.
 */
export const GITHUB_INSTALL_REF = 'github:adder-factory/cartograph';

/**
 * Restart reminder, surfaced after every successful update and in the
 * plan-only steps. Emphatic on purpose: a running MCP server keeps
 * serving the OLD code until restarted, and an old server + a new CLI on
 * one index can thrash the re-extract heal (issue #13).
 */
export const RESTART_STEP =
  '⚠ Restart your MCP server / client session now — the running process keeps serving the OLD code until restarted, and an old server + new CLI on the same index can thrash re-extraction (issue #13).';

export interface UpgradeCheckOptions {
  currentVersion: string;
  latestVersion?: string | undefined;
  fetchLatestVersion?: (() => Promise<string> | string) | undefined;
  apply?: boolean | undefined;
  /** Non-source install kind, used to tailor the printed update steps.
   *  Source checkouts route through `runSourceUpgrade` instead. */
  method?: Exclude<InstallMethodKind, 'source'> | undefined;
  /**
   * Executor that performs an in-place update for a re-pinnable package
   * install (a Bun global pinned to a GitHub tag). Given the resolved
   * latest version; throws on failure. Injected by the CLI only when the
   * install is actually re-pinnable, so `--apply` does real work instead
   * of being plan-only. Omitted ⇒ `--apply` stays plan-only.
   */
  applyPackage?: ((latestVersion: string) => void | Promise<void>) | undefined;
}

export interface UpgradeCheckResult {
  status: 'current' | 'update_available' | 'updated' | 'blocked' | 'unknown';
  method?: InstallMethodKind | undefined;
  currentVersion: string;
  latestVersion: string | null;
  applyRequested: boolean;
  applied: boolean;
  message: string;
  nextSteps: string[];
  warning?: string | undefined;
}

const NPM_REGISTRY_PROTOCOL = 'https:';
const NPM_REGISTRY_HOST = 'registry.npmjs.org';
const VERSION_FETCH_TIMEOUT_MS = 10_000;

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RELEASES_LATEST_PATH = '/repos/adder-factory/cartograph/releases/latest';

/** Git transport endpoint for tag listing. The same host `git+https`
 *  installs clone from — and, critically, a DIFFERENT service from
 *  `api.github.com`, which has been intermittently 504-ing for this repo
 *  (issue #23 follow-up). `git ls-remote` here stays up when the REST API
 *  does not. */
const GIT_REMOTE_URL = 'https://github.com/adder-factory/cartograph.git';
const GIT_LS_REMOTE_TIMEOUT_MS = 15_000;
const GIT_LS_REMOTE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

const STANDALONE_INSTALLER_URL = 'https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh';

const npmRegistryLatestResponseSchema = z.object({
  version: z.string(),
});
const githubLatestReleaseResponseSchema = z.object({
  tag_name: z.string(),
});

type NpmRegistryLatestResponse = z.infer<typeof npmRegistryLatestResponseSchema>;
type GithubLatestReleaseResponse = z.infer<typeof githubLatestReleaseResponseSchema>;

export async function checkUpgrade(options: UpgradeCheckOptions): Promise<UpgradeCheckResult> {
  const applyRequested = options.apply === true;
  let latestVersion: string | null = options.latestVersion ?? null;
  let warning: string | undefined;
  if (!latestVersion && options.fetchLatestVersion) {
    try {
      latestVersion = await Promise.resolve(options.fetchLatestVersion());
    } catch (error) {
      warning = `Unable to check latest version: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (!latestVersion) {
    return {
      status: 'unknown',
      method: options.method,
      currentVersion: options.currentVersion,
      latestVersion: null,
      applyRequested,
      applied: false,
      message: 'Latest Cartograph version is unknown.',
      nextSteps: updateStepsForMethod(options.method, null),
      warning,
    };
  }

  const cmp = compareVersions(options.currentVersion, latestVersion);
  if (cmp >= 0) {
    return {
      status: 'current',
      method: options.method,
      currentVersion: options.currentVersion,
      latestVersion,
      applyRequested,
      applied: false,
      message: `Cartograph is current (${options.currentVersion}).`,
      nextSteps: ['No upgrade action is needed.'],
    };
  }

  // `--apply` with a re-pinnable package install (Bun global on a GitHub
  // tag): do the update in place instead of only printing steps.
  if (applyRequested && options.applyPackage) {
    try {
      await Promise.resolve(options.applyPackage(latestVersion));
      return {
        status: 'updated',
        method: options.method,
        currentVersion: options.currentVersion,
        latestVersion,
        applyRequested,
        applied: true,
        message: `Upgraded ${options.currentVersion} → ${latestVersion}.`,
        nextSteps: ['Run `cartograph status` to confirm index and feature readiness.'],
        warning: RESTART_STEP,
      };
    } catch (error) {
      return {
        status: 'blocked',
        method: options.method,
        currentVersion: options.currentVersion,
        latestVersion,
        applyRequested,
        applied: false,
        message: `In-place upgrade to ${latestVersion} failed: ${errMsg(error)}.`,
        nextSteps: [
          `Retry the re-pin — \`bun remove -g ${CARTOGRAPH_PACKAGE_NAME}\` then \`bun add -g ${bunGlobalRef(latestVersion)}\`.`,
          `If it keeps failing (e.g. offline, or the rollback also failed), install from GitHub Releases instead: \`curl -fsSL ${STANDALONE_INSTALLER_URL} | sh\`.`,
          RESTART_STEP,
        ],
      };
    }
  }

  return {
    status: 'update_available',
    method: options.method,
    currentVersion: options.currentVersion,
    latestVersion,
    applyRequested,
    applied: false,
    message: `Cartograph ${latestVersion} is available (current ${options.currentVersion}).`,
    nextSteps: [
      ...(applyRequested
        ? [
            '`--apply` can upgrade a source checkout or a Bun global install in place; for this install, run the steps below.',
          ]
        : []),
      ...updateStepsForMethod(options.method, latestVersion),
    ],
  };
}

/** The `bun add -g` ref for a given version, or a releases pointer when
 *  the version is unknown. Always the `git+https` clone form — see
 *  {@link GIT_CLONE_INSTALL_REF} for why not `github:`. */
function bunGlobalRef(latestVersion: string | null): string {
  if (latestVersion) return `${GIT_CLONE_INSTALL_REF}#v${latestVersion}`;
  return `${GIT_CLONE_INSTALL_REF}#<latest tag — see ${CARTOGRAPH_RELEASES_URL}>`;
}

/** The two-step Bun-global re-pin (remove first to dodge a Bun
 *  dependency loop when switching tags), as separate copy-pasteable
 *  commands. */
function bunGlobalRepinSteps(latestVersion: string | null): string[] {
  return [
    `Re-pin the Bun global install — \`bun remove -g ${CARTOGRAPH_PACKAGE_NAME}\` then \`bun add -g ${bunGlobalRef(latestVersion)}\`. (The remove avoids a Bun dependency loop when switching tags; or just run \`cartograph upgrade --apply\`.)`,
    RESTART_STEP,
  ];
}

/** Update steps for installs that cannot be fast-forwarded in place.
 *  Cartograph is not on npm — GitHub Releases is the canonical channel —
 *  so package installs are re-pinned from the GitHub tag, never npm. */
function updateStepsForMethod(method: UpgradeCheckOptions['method'], latestVersion: string | null): string[] {
  if (method === 'standalone') {
    return [`Re-run the standalone installer: \`curl -fsSL ${STANDALONE_INSTALLER_URL} | sh\`.`, RESTART_STEP];
  }
  if (method === 'package') {
    return bunGlobalRepinSteps(latestVersion);
  }
  return [
    `Update with your install method — Bun global: \`bun remove -g ${CARTOGRAPH_PACKAGE_NAME}\` then \`bun add -g ${bunGlobalRef(latestVersion)}\`; source checkout: \`git pull && bun install\`.`,
    RESTART_STEP,
  ];
}

export async function fetchLatestNpmVersion(packageName = '@adder-factory/cartograph'): Promise<string> {
  const response = await fetch(latestPackageUrl(packageName), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const parsed = parseNpmRegistryLatestResponse(await response.json());
  return parsed.version.trim();
}

export async function fetchLatestGithubReleaseVersion(): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE}${GITHUB_RELEASES_LATEST_PATH}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  const parsed = parseGithubLatestReleaseResponse(await response.json());
  const tag = parsed.tag_name.trim();
  // Guard the shape: a non-version tag (e.g. `nightly-2026-06-12`)
  // would silently compare as 0.0.0 and report the user as current.
  // Require all three semver components, matching the invariant the git
  // path enforces (pickLatestSemverTag), so the two channels agree on
  // what counts as a release tag.
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) {
    throw new Error(`GitHub release tag "${tag}" is not a version tag`);
  }
  return tag.replace(/^v/, '');
}

function parseNpmRegistryLatestResponse(value: unknown): NpmRegistryLatestResponse {
  const parsed = npmRegistryLatestResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.version.trim() === '') {
    throw new Error('npm registry response did not include a version');
  }
  return parsed.data;
}

function parseGithubLatestReleaseResponse(value: unknown): GithubLatestReleaseResponse {
  const parsed = githubLatestReleaseResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.tag_name.trim() === '') {
    throw new Error('GitHub releases response did not include a tag name');
  }
  return parsed.data;
}

/** Injectable `git ls-remote` runner — returns its raw stdout. Tests pass
 *  canned output so the lookup is exercised without git or the network. */
export type GitLsRemoteRunner = (remoteUrl: string) => Promise<string>;

async function defaultGitLsRemote(remoteUrl: string): Promise<string> {
  // `--refs` drops the peeled `^{}` rows; `--end-of-options` keeps the
  // constant URL from ever being parsed as a flag (option-injection
  // hygiene, matching the rest of the upgrade git plumbing).
  const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', '--refs', '--end-of-options', remoteUrl], {
    timeout: GIT_LS_REMOTE_TIMEOUT_MS,
    maxBuffer: GIT_LS_REMOTE_MAX_BUFFER_BYTES,
  });
  return stdout;
}

/** Highest stable `vMAJOR.MINOR.PATCH` tag in `git ls-remote --tags`
 *  output, `v`-prefix stripped — or null when none parse. Pre-release
 *  tags (`v1.2.0-rc1`) and non-semver tags (`nightly-…`) are ignored, so
 *  this mirrors what the GitHub `releases/latest` endpoint would return. */
function pickLatestSemverTag(lsRemoteOutput: string): string | null {
  let best: string | null = null;
  for (const line of lsRemoteOutput.split('\n')) {
    const captured = /refs\/tags\/(v?\d+\.\d+\.\d+)\s*$/.exec(line.trim())?.[1];
    if (!captured) continue;
    const version = captured.replace(/^v/, '');
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Latest released version via the git transport — `git ls-remote --tags`
 * against the repo, picking the highest stable semver tag. This is the
 * PRIMARY lookup (see {@link fetchLatestPublishedVersion}) because it does
 * not touch `api.github.com`, which has been 504-ing for this repo while
 * the git endpoint stays up. Throws when git is missing, the remote is
 * unreachable, or no semver tag is found — the caller then falls back to
 * the REST API.
 */
export async function fetchLatestGitTagVersion(
  runLsRemote: GitLsRemoteRunner = defaultGitLsRemote,
  remoteUrl: string = GIT_REMOTE_URL,
): Promise<string> {
  const version = pickLatestSemverTag(await runLsRemote(remoteUrl));
  if (!version) throw new Error('git ls-remote returned no semver tags');
  return version;
}

/**
 * Latest published version. Tries the git transport first
 * ({@link fetchLatestGitTagVersion}) because `api.github.com` has been
 * intermittently 504-ing for this repo and `git ls-remote` is a separate
 * service that stays up; then the GitHub releases REST API (canonical
 * channel: binaries + install.sh); then npm as a no-op-today fallback so
 * a future npm publish needs no change here. The error aggregates all
 * three failures so a fully-offline check reports every channel it tried.
 */
export async function fetchLatestPublishedVersion(
  fetchGitTag: () => Promise<string> = () => fetchLatestGitTagVersion(),
): Promise<string> {
  const channels: ReadonlyArray<readonly [string, () => Promise<string>]> = [
    ['git ls-remote', fetchGitTag],
    ['GitHub releases API', fetchLatestGithubReleaseVersion],
    ['npm registry', () => fetchLatestNpmVersion()],
  ];
  const errors: string[] = [];
  for (const [label, fetcher] of channels) {
    try {
      return await fetcher();
    } catch (error) {
      errors.push(`${label}: ${errMsg(error)}`);
    }
  }
  throw new Error(`Could not resolve the latest published version — ${errors.join('; ')}`);
}

function latestPackageUrl(packageName: string): string {
  const packagePath = encodeURIComponent(packageName).replace('%2F', '/');
  const url = new URL(`${packagePath}/latest`, `${NPM_REGISTRY_PROTOCOL}//${NPM_REGISTRY_HOST}`);
  return url.toString();
}

export interface VersionSkew {
  /** Version this process loaded at startup (in-memory constant). */
  running: string;
  /** Version currently on disk — strictly newer than `running`. */
  onDisk: string;
}

/**
 * Detect an in-place upgrade the running process has not picked up: the
 * on-disk package version is strictly NEWER than the version this process
 * loaded at startup. Returns null when there is no skew (equal, older, or
 * the disk version is unreadable) — the overwhelmingly common case.
 *
 * Surfaced by `cartograph_status` so an operator who ran `cartograph
 * upgrade` sees a "restart me" hint instead of silently being served the
 * old code (issue #23). A bare `<` (not `≤`) is deliberate: a same or
 * lower on-disk version is normal and must not warn.
 */
export function detectVersionSkew(running: string, onDisk: string | null): VersionSkew | null {
  if (!onDisk) return null;
  if (compareVersions(onDisk, running) <= 0) return null;
  return { running, onDisk };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(value: string): number[] {
  return value
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const match = /^\d+/.exec(part);
      return match ? Number(match[0]) : 0;
    });
}
