export type InstallLocation = 'global' | 'local';

export interface InstallOptions {
  target?: string;
  location?: string;
  yes?: boolean;
  permissions?: boolean;
  printConfig?: string;
}

export interface InstallerRunOptions {
  target?: string;
  location?: InstallLocation;
  autoAllow?: boolean;
  yes?: boolean;
}

export type InstallLocationResult = { ok: true; location: InstallLocation | undefined } | { ok: false; error: string };

export function printConfigLocation(raw: string | undefined): InstallLocation {
  return raw === 'local' ? 'local' : 'global';
}

export function validateInstallLocation(raw: string | undefined): InstallLocationResult {
  if (raw === undefined) return { ok: true, location: undefined };
  if (raw === 'global' || raw === 'local') return { ok: true, location: raw };
  return { ok: false, error: `--location must be "global" or "local" (got "${raw}").` };
}

export function installerRunOptions(options: InstallOptions): InstallerRunOptions {
  const runOptions: InstallerRunOptions = {};
  if (options.target !== undefined) runOptions.target = options.target;
  const location = validateInstallLocation(options.location);
  if (location.ok && location.location !== undefined) runOptions.location = location.location;

  // Commander's `--no-permissions` makes `permissions === false`;
  // omitting the flag leaves it true. Only an explicit false or --yes
  // should become an orchestrator auto-allow value.
  if (options.permissions === false) runOptions.autoAllow = false;
  else if (options.yes) runOptions.autoAllow = true;

  if (options.yes !== undefined) runOptions.yes = options.yes;
  return runOptions;
}
