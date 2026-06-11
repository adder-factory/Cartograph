export type InstallMethodKind = 'source' | 'standalone' | 'package' | 'unknown';

export interface UpgradeCheckOptions {
  currentVersion: string;
  latestVersion?: string | undefined;
  fetchLatestVersion?: (() => Promise<string> | string) | undefined;
  apply?: boolean | undefined;
  /** Non-source install kind, used to tailor the printed update steps.
   *  Source checkouts route through `runSourceUpgrade` instead. */
  method?: Exclude<InstallMethodKind, 'source'> | undefined;
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
const NPM_VERSION_FETCH_TIMEOUT_MS = 10_000;

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
      nextSteps: updateStepsForMethod(options.method),
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

  return {
    status: 'update_available',
    method: options.method,
    currentVersion: options.currentVersion,
    latestVersion,
    applyRequested,
    applied: false,
    message: `Cartograph ${latestVersion} is available (current ${options.currentVersion}).`,
    nextSteps: [
      ...(applyRequested ? ['In-place `--apply` is only available for source checkouts.'] : []),
      ...updateStepsForMethod(options.method),
    ],
  };
}

/** Update steps for installs that cannot be fast-forwarded in place. */
function updateStepsForMethod(method: UpgradeCheckOptions['method']): string[] {
  if (method === 'standalone') {
    return [
      `Re-run the standalone installer: \`curl -fsSL ${STANDALONE_INSTALLER_URL} | sh\`.`,
      'Restart any running MCP server/client sessions so they load the updated code.',
    ];
  }
  if (method === 'package') {
    return [
      'Update via your package manager, e.g. `bun update -g @adder-factory/cartograph` or `npm install -g @adder-factory/cartograph@latest`.',
      'Restart any running MCP server/client sessions so they load the updated code.',
    ];
  }
  return [
    'Update with your install method (`git pull && bun install` in a source checkout, or reinstall the package).',
    'Restart any running MCP server/client sessions so they load the updated code.',
  ];
}

export async function fetchLatestNpmVersion(packageName = '@adder-factory/cartograph'): Promise<string> {
  const response = await fetch(latestPackageUrl(packageName), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(NPM_VERSION_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const parsed = (await response.json()) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error('npm registry response did not include a version');
  }
  return parsed.version.trim();
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
