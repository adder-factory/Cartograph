import { errMsg } from '../../errors.js';

export type InstallMethodKind = 'source' | 'standalone' | 'package' | 'unknown';

/** Package + GitHub coordinates for the printed re-pin commands. */
export const CARTOGRAPH_PACKAGE_NAME = '@adder-factory/cartograph';
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

const STANDALONE_INSTALLER_URL = 'https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh';

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
 *  the version is unknown. */
function bunGlobalRef(latestVersion: string | null): string {
  if (latestVersion) return `${GITHUB_INSTALL_REF}#v${latestVersion}`;
  return `${GITHUB_INSTALL_REF}#<latest tag — see https://github.com/adder-factory/cartograph/releases>`;
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
  const parsed = (await response.json()) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error('npm registry response did not include a version');
  }
  return parsed.version.trim();
}

export async function fetchLatestGithubReleaseVersion(): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE}${GITHUB_RELEASES_LATEST_PATH}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  const parsed = (await response.json()) as { tag_name?: unknown };
  if (typeof parsed.tag_name !== 'string' || parsed.tag_name.trim() === '') {
    throw new Error('GitHub releases response did not include a tag name');
  }
  const tag = parsed.tag_name.trim();
  // Guard the shape: a non-version tag (e.g. `nightly-2026-06-12`)
  // would silently compare as 0.0.0 and report the user as current.
  if (!/^v?\d+\.\d+/.test(tag)) {
    throw new Error(`GitHub release tag "${tag}" is not a version tag`);
  }
  return tag.replace(/^v/, '');
}

/**
 * Latest published version, GitHub releases first: GitHub Releases is
 * Cartograph's canonical release channel (binaries + install.sh), and
 * the package is not on npm — npm-only lookups always 404'd for
 * package/standalone installs. npm stays as the fallback so a future
 * npm publish needs no code change here.
 */
export async function fetchLatestPublishedVersion(): Promise<string> {
  try {
    return await fetchLatestGithubReleaseVersion();
  } catch (githubError) {
    try {
      return await fetchLatestNpmVersion();
    } catch (npmError) {
      const githubMessage = githubError instanceof Error ? githubError.message : String(githubError);
      const npmMessage = npmError instanceof Error ? npmError.message : String(npmError);
      throw new Error(`${githubMessage}; ${npmMessage}`);
    }
  }
}

function latestPackageUrl(packageName: string): string {
  const packagePath = encodeURIComponent(packageName).replace('%2F', '/');
  const url = new URL(`${packagePath}/latest`, `${NPM_REGISTRY_PROTOCOL}//${NPM_REGISTRY_HOST}`);
  return url.toString();
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
