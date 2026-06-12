import { CARTOGRAPH_PACKAGE_VERSION } from '../../package-version.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import {
  checkUpgrade,
  fetchLatestPublishedVersion,
  type InstallMethodKind,
  type UpgradeCheckResult,
} from './runtime.js';
import { detectInstallMethod, runSourceUpgrade } from './source-update.js';

export interface UpgradeCommandDeps {
  program: CliOptionCommand;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
}

interface UpgradeOptions {
  apply?: boolean;
  json?: boolean;
}

export function registerUpgradeCommand(deps: UpgradeCommandDeps): void {
  const command = deps.program
    .command('upgrade')
    .description('Check for a newer Cartograph and update a source checkout in place');
  command.alias?.('update');
  command
    .option('--apply', 'Fast-forward a source checkout and reinstall dependencies (plan-only for other installs)')
    .option('-j, --json', 'Output JSON')
    .action(async (options: UpgradeOptions) => {
      const apply = options.apply === true;
      const method = detectInstallMethod();
      const result =
        method.kind === 'source'
          ? await runSourceUpgrade({ root: method.root, currentVersion: CARTOGRAPH_PACKAGE_VERSION, apply })
          : await checkUpgrade({
              currentVersion: CARTOGRAPH_PACKAGE_VERSION,
              fetchLatestVersion: fetchLatestPublishedVersion,
              apply,
              method: method.kind,
            });
      // A blocked apply is a failed operation for automation purposes.
      if (result.status === 'blocked') process.exitCode = 1;
      if (options.json) {
        deps.writeStdout(JSON.stringify(result, null, 2));
        return;
      }
      deps.writeStdout(renderUpgradeCheck(result));
    });
}

const INSTALL_METHOD_LABELS: Record<InstallMethodKind, string> = {
  source: 'source checkout',
  standalone: 'standalone binary',
  package: 'package manager',
  unknown: 'unknown',
};

export function renderUpgradeCheck(result: UpgradeCheckResult): string {
  const lines = [
    '## Cartograph Upgrade',
    '',
    `- **current:** ${result.currentVersion}`,
    `- **latest:** ${result.latestVersion ?? 'unknown'}`,
    ...(result.method ? [`- **install:** ${INSTALL_METHOD_LABELS[result.method]}`] : []),
    `- **status:** ${result.status}`,
    '',
    result.message,
  ];
  if (result.warning) lines.push('', `Warning: ${result.warning}`);
  if (result.nextSteps.length > 0) {
    lines.push('', '### Next steps', '');
    for (const step of result.nextSteps) lines.push(`- ${step}`);
  }
  return lines.join('\n');
}
