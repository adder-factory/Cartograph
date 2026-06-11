export type InstallLocation = 'global' | 'local';

export interface InstallOptions {
  target?: string;
  location?: string;
  yes?: boolean;
  permissions?: boolean;
  printConfig?: string;
  command?: string | undefined;
  hooks?: boolean;
}

export interface InstallerRunOptions {
  target?: string;
  location?: InstallLocation;
  autoAllow?: boolean;
  yes?: boolean;
  command?: string | undefined;
  hooks?: boolean;
}

export type InstallLocationResult = { ok: true; location: InstallLocation | undefined } | { ok: false; error: string };
export type InstallCommandResult = { ok: true; command: string | undefined } | { ok: false; error: string };

export function printConfigLocation(raw: string | undefined): InstallLocation {
  return raw === 'local' ? 'local' : 'global';
}

export function validateInstallLocation(raw: string | undefined): InstallLocationResult {
  if (raw === undefined) return { ok: true, location: undefined };
  if (raw === 'global' || raw === 'local') return { ok: true, location: raw };
  return { ok: false, error: `--location must be "global" or "local" (got "${raw}").` };
}

export function validateInstallCommand(raw: string | undefined): InstallCommandResult {
  if (raw === undefined) return { ok: true, command: undefined };
  const command = raw.trim();
  if (command.length > 0) return { ok: true, command };
  return { ok: false, error: '--command must not be blank.' };
}

export function installerRunOptions(options: InstallOptions): InstallerRunOptions {
  const runOptions: InstallerRunOptions = {};
  if (options.target !== undefined) runOptions.target = options.target;
  const location = validateInstallLocation(options.location);
  if (location.ok && location.location !== undefined) runOptions.location = location.location;
  const command = validateInstallCommand(options.command);
  if (command.ok && command.command !== undefined) runOptions.command = command.command;

  // Commander's `--no-permissions` makes `permissions === false`;
  // omitting the flag leaves it true. Only an explicit false or --yes
  // should become an orchestrator auto-allow value.
  if (options.permissions === false) runOptions.autoAllow = false;
  else if (options.yes) runOptions.autoAllow = true;

  // Same negated-flag shape: only an explicit `--no-hooks` opts out.
  if (options.hooks === false) runOptions.hooks = false;

  if (options.yes !== undefined) runOptions.yes = options.yes;
  return runOptions;
}
