import { describe, expect, it } from 'vitest';
import {
  installerRunOptions,
  printConfigLocation,
  registerInstallCommand,
  validateInstallCommand,
  validateInstallLocation,
} from '../src/features/install/index.js';

describe('install feature runtime', () => {
  it('validates locations and builds sparse installer options', () => {
    expect(printConfigLocation(undefined)).toBe('global');
    expect(printConfigLocation('local')).toBe('local');
    expect(validateInstallLocation('global')).toEqual({ ok: true, location: 'global' });
    expect(validateInstallLocation('bad')).toEqual({
      ok: false,
      error: '--location must be "global" or "local" (got "bad").',
    });
    expect(validateInstallCommand('  /bin/cartograph  ')).toEqual({ ok: true, command: '/bin/cartograph' });
    expect(validateInstallCommand('  ')).toEqual({ ok: false, error: '--command must not be blank.' });
    expect(installerRunOptions({ target: 'auto', location: 'global', yes: true, permissions: true })).toEqual({
      target: 'auto',
      location: 'global',
      autoAllow: true,
      yes: true,
    });
    expect(installerRunOptions({ command: '  /bin/cartograph  ' })).toEqual({ command: '/bin/cartograph' });
    expect(installerRunOptions({ permissions: false })).toEqual({ autoAllow: false });
    // Only an explicit --no-hooks travels; the default true stays sparse.
    expect(installerRunOptions({ hooks: false })).toEqual({ hooks: false });
    expect(installerRunOptions({ hooks: true })).toEqual({});
  });
});

describe('install feature CLI', () => {
  it('prints target config and runs installer through injected dependencies', async () => {
    const actions = new Map<string, (opts: Record<string, unknown>) => Promise<void>>();
    const calls: string[] = [];
    registerInstallCommand({
      program: new FakeCommand(actions),
      error: (message) => calls.push(`error:${message}`),
      writeStdout: (message) => calls.push(`stdout:${message}`),
      loadInstallerTargets: async () => ({
        getTarget: (id) =>
          id === 'claude'
            ? {
                printConfig: (location: string, options?: { command?: string }) =>
                  `config:${location}:${options?.command}`,
              }
            : null,
        listTargetIds: () => ['claude', 'cursor'],
      }),
      loadInstaller: async () => ({
        runInstallerWithOptions: async (opts) => calls.push(`install:${JSON.stringify(opts)}`),
      }),
    });

    await actions.get('install')!({ printConfig: 'claude', location: 'local', command: '/bin/cartograph' });
    await actions.get('install')!({
      target: 'auto',
      location: 'global',
      yes: true,
      permissions: true,
      command: '/bin/cartograph',
    });

    expect(calls).toEqual([
      'stdout:config:local:/bin/cartograph',
      'install:{"target":"auto","location":"global","command":"/bin/cartograph","autoAllow":true,"yes":true}',
    ]);
  });
});

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (opts: Record<string, unknown>) => Promise<void>>,
    private readonly name = 'program',
  ) {}

  command(name: string): FakeCommand {
    return new FakeCommand(this.actions, name);
  }

  description(): this {
    return this;
  }

  option(): this {
    return this;
  }

  action(fn: (opts: Record<string, unknown>) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
