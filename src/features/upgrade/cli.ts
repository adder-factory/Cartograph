import { CARTOGRAPH_PACKAGE_VERSION } from '../../package-version.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import { checkUpgrade, fetchLatestNpmVersion, type UpgradeCheckResult } from './runtime.js';

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
  deps.program
    .command('upgrade')
    .description('Check whether a newer Cartograph release is available and print update steps')
    .option('--apply', 'Print guarded update steps for the detected install method')
    .option('-j, --json', 'Output JSON')
    .action(async (options: UpgradeOptions) => {
      const result = await checkUpgrade({
        currentVersion: CARTOGRAPH_PACKAGE_VERSION,
        fetchLatestVersion: fetchLatestNpmVersion,
        apply: options.apply === true,
      });
      if (options.json) {
        deps.writeStdout(JSON.stringify(result, null, 2));
        return;
      }
      deps.writeStdout(renderUpgradeCheck(result));
    });
}

export function renderUpgradeCheck(result: UpgradeCheckResult): string {
  const lines = [
    '## Cartograph Upgrade',
    '',
    `- **current:** ${result.currentVersion}`,
    `- **latest:** ${result.latestVersion ?? 'unknown'}`,
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
