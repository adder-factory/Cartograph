import { describe, expect, it } from 'vitest';
import {
  installerRunOptions,
  printConfigLocation,
  registerInstallCommand,
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
    expect(installerRunOptions({ target: 'auto', location: 'global', yes: true, permissions: true })).toEqual({
      target: 'auto',
      location: 'global',
      autoAllow: true,
      yes: true,
    });
    expect(installerRunOptions({ permissions: false })).toEqual({ autoAllow: false });
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
        getTarget: (id) => (id === 'claude' ? { printConfig: (location: string) => `config:${location}` } : null),
        listTargetIds: () => ['claude', 'cursor'],
      }),
      loadInstaller: async () => ({
        runInstallerWithOptions: async (opts) => calls.push(`install:${JSON.stringify(opts)}`),
      }),
    });

    await actions.get('install')!({ printConfig: 'claude', location: 'local' });
    await actions.get('install')!({ target: 'auto', location: 'global', yes: true, permissions: true });

    expect(calls).toEqual([
      'stdout:config:local',
      'install:{"target":"auto","location":"global","autoAllow":true,"yes":true}',
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
