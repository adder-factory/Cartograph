import { errMsg } from '../../errors.js';
import {
  installerRunOptions,
  printConfigLocation,
  validateInstallCommand,
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
    getTarget: (
      id: string,
    ) => { printConfig: (location: string, options?: { command?: string | undefined }) => string } | null | undefined;
    listTargetIds: () => string[];
  }>;
  loadInstaller: () => Promise<{ runInstallerWithOptions: (opts: InstallerRunOptions) => Promise<void> }>;
}

export function registerInstallCommand(deps: InstallCommandDeps): void {
  const { program } = deps;
  const install = program
    .command('install')
    .description(
      'Configure cartograph for one or more agents (MCP config; local installs also init + index + git hooks). One-command agent setup: --yes --location=local.',
    )
    .option(
      '-t, --target <ids>',
      'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Known ids include claude,cursor,codex,copilot,codebuddy,codewhale,zed,opencode,hermes,gemini,antigravity,kiro,factory,rovo,qoder,bob,kimi,pi,reasonix. Default with --yes: auto.',
    )
    .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
    .option('-y, --yes', 'Non-interactive for agents/CI: defaults to --location=global --target=auto, auto-allow on')
    .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code and Qoder CLI)')
    .option('--no-hooks', 'Skip installing managed git hooks on local installs')
    .option(
      '--command <path>',
      'Command/path to write into MCP config entries. Default: "cartograph", or a pinned absolute path when cartograph is not on PATH',
    )
    .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
    .action((opts: InstallOptions) => runInstallCommand(opts, deps));

  install.addHelpText?.(
    'after',
    `
Examples:
  cartograph install                          # interactive
  cartograph install --yes --location=local   # one-command agent setup: MCP + init + index + git hooks
  cartograph install --yes --location=global  # MCP config only, available in all projects
  cartograph install --yes --target=all --command /absolute/path/to/cartograph
  cartograph install --print-config codex
`,
  );

  program
    .command('uninstall')
    .description(
      'Remove cartograph MCP entries from installed agents (default: global). The package preuninstall hook is not run by npm v7+/bun, so the source/standalone uninstall paths call this.',
    )
    .option('-l, --location <where>', 'Which entries to remove: "global" or "local". Default: global', 'global')
    .action((opts: { location?: string }) => runUninstallCommand(opts, deps));
}

async function runUninstallCommand(options: { location?: string }, deps: InstallCommandDeps): Promise<void> {
  const location = options.location === 'local' ? 'local' : 'global';
  try {
    const { ALL_TARGETS } = await import('../../installer/targets/registry.js');
    let removed = 0;
    for (const target of ALL_TARGETS) {
      if (!target.supportsLocation(location)) continue;
      try {
        target.uninstall(location);
        removed++;
      } catch {
        // Each target is independently safe-to-skip.
      }
    }
    deps.writeStdout(`Removed cartograph ${location} MCP entries from ${removed} agent target(s).`);
  } catch (err) {
    deps.error(`uninstall failed: ${errMsg(err)}`);
  }
}

async function runInstallCommand(options: InstallOptions, deps: InstallCommandDeps): Promise<void> {
  const { error, loadInstaller, loadInstallerTargets, writeStdout } = deps;
  const command = validateInstallCommand(options.command);
  if (!command.ok) {
    error(command.error);
    process.exit(1);
  }

  if (options.printConfig) {
    const { getTarget, listTargetIds } = await loadInstallerTargets();
    const target = getTarget(options.printConfig);
    if (!target) {
      const known = listTargetIds().join(', ');
      error(`Unknown target "${options.printConfig}". Known: ${known}.`);
      process.exit(1);
    }
    writeStdout(target.printConfig(printConfigLocation(options.location), { command: command.command }));
    return;
  }

  const location = validateInstallLocation(options.location);
  if (!location.ok) {
    error(location.error);
    process.exit(1);
  }

  const { runInstallerWithOptions } = await loadInstaller();
  try {
    await runInstallerWithOptions(installerRunOptions({ ...options, command: command.command }));
  } catch (err) {
    error(errMsg(err));
    process.exit(1);
  }
}
