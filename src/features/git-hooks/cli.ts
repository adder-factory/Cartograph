import { installGitHooks, formatGitHooksResult } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

export interface InstallHooksCommandDeps {
  program: CliOptionCommand;
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
}

export interface InstallHooksCommandOptions {
  hooks?: string | undefined;
  command?: string | undefined;
  remove?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export function registerInstallHooksCommand(deps: InstallHooksCommandDeps): void {
  deps.program
    .command('install-hooks [path]')
    .description('Install managed git hooks that keep the Cartograph index fresh after git updates')
    .option('--hooks <names>', 'Comma-separated hooks to manage: post-merge,post-checkout,post-rewrite. Default: all.')
    .option('--command <path>', 'Cartograph executable to call from hooks. Default: cartograph')
    .option('--remove', 'Remove only the managed Cartograph hook block')
    .option('--dry-run', 'Print planned hook changes without writing files')
    .action((pathArg: string | undefined, options: InstallHooksCommandOptions) =>
      runInstallHooksCommand(pathArg, options, deps),
    );
}

export function runInstallHooksCommand(
  pathArg: string | undefined,
  options: InstallHooksCommandOptions,
  deps: InstallHooksCommandDeps,
): void {
  const result = installGitHooks({
    projectPath: deps.resolveProjectPath(pathArg),
    hooks: options.hooks,
    command: options.command,
    remove: options.remove,
    dryRun: options.dryRun,
  });

  if (!result.ok) {
    deps.error(result.error.remediation ? `${result.error.message} ${result.error.remediation}` : result.error.message);
    process.exitCode = result.exitCode;
    return;
  }

  deps.writeStdout(formatGitHooksResult(result));
}
