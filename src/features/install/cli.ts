import { errMsg } from '../../errors.js';
import {
  installerRunOptions,
  printConfigLocation,
  validateInstallLocation,
  type InstallOptions,
  type InstallerRunOptions,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface InstallCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  writeStdout: (message: string) => void;
  loadInstallerTargets: () => Promise<{
    getTarget: (id: string) => { printConfig: (location: string) => string } | null | undefined;
    listTargetIds: () => string[];
  }>;
  loadInstaller: () => Promise<{ runInstallerWithOptions: (opts: InstallerRunOptions) => Promise<void> }>;
}

export function registerInstallCommand(deps: InstallCommandDeps): void {
  const { program } = deps;
  const install = program
    .command('install')
    .description(
      'Install cartograph MCP server into one or more agents. For agent-run setup, use --yes --target=auto --location=local.',
    )
    .option(
      '-t, --target <ids>',
      'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Known ids include claude,cursor,codex,copilot,zed,opencode,hermes,gemini,antigravity,kiro,factory,rovo,qoder.',
    )
    .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
    .option('-y, --yes', 'Non-interactive for agents/CI: defaults to --location=global --target=auto, auto-allow on')
    .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code and Qoder CLI)')
    .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
    .action((opts: InstallOptions) => runInstallCommand(opts, deps));

  install.addHelpText?.(
    'after',
    `
Examples:
  cartograph install
  cartograph install --yes --target=auto --location=local
  cartograph install --yes --target=auto --location=global
  cartograph install --print-config codex
  cartograph install --print-config copilot
  cartograph install --print-config qoder
`,
  );
}

async function runInstallCommand(options: InstallOptions, deps: InstallCommandDeps): Promise<void> {
  const { error, loadInstaller, loadInstallerTargets, writeStdout } = deps;
  if (options.printConfig) {
    const { getTarget, listTargetIds } = await loadInstallerTargets();
    const target = getTarget(options.printConfig);
    if (!target) {
      const known = listTargetIds().join(', ');
      error(`Unknown target "${options.printConfig}". Known: ${known}.`);
      process.exit(1);
    }
    writeStdout(target.printConfig(printConfigLocation(options.location)));
    return;
  }

  const location = validateInstallLocation(options.location);
  if (!location.ok) {
    error(location.error);
    process.exit(1);
  }

  const { runInstallerWithOptions } = await loadInstaller();
  try {
    await runInstallerWithOptions(installerRunOptions(options));
  } catch (err) {
    error(errMsg(err));
    process.exit(1);
  }
}
