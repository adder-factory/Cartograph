import { describe, expect, it } from 'vitest';
import {
  installerRunOptions,
  printConfigLocation,
  registerInstallCommand,
  type InstallCommandDeps,
  type InstallOptions,
  validateInstallCommand,
  validateInstallLocation,
} from '../src/features/install/index.js';

type InstallAction = (opts: InstallOptions) => Promise<void>;

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
    const actions = new Map<string, InstallAction>();
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

  it('reports invalid command input without hard-exiting or loading installers', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls } = registerInstallAction();

      await action({ command: '   ' });

      expect(process.exitCode).toBe(1);
      expect(calls).toEqual(['error:--command must not be blank.']);
    });
  });

  it('reports unknown print-config targets without hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls } = registerInstallAction();

      await action({ printConfig: 'missing', command: '/bin/cartograph' });

      expect(process.exitCode).toBe(1);
      expect(calls).toEqual(['loadTargets', 'error:Unknown target "missing". Known: claude, cursor.']);
    });
  });

  it('reports invalid install locations without hard-exiting or running the installer', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls } = registerInstallAction();

      await action({ location: 'project' });

      expect(process.exitCode).toBe(1);
      expect(calls).toEqual(['error:--location must be "global" or "local" (got "project").']);
    });
  });

  it('reports installer failures without hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls } = registerInstallAction({
        loadInstaller: async () => {
          calls.push('loadInstaller');
          return {
            runInstallerWithOptions: async (opts) => {
              calls.push(`run:${JSON.stringify(opts)}`);
              throw new Error('installer exploded');
            },
          };
        },
      });

      await action({ target: 'auto', location: 'local', yes: true });

      expect(process.exitCode).toBe(1);
      expect(calls).toEqual([
        'loadInstaller',
        'run:{"target":"auto","location":"local","autoAllow":true,"yes":true}',
        'error:installer exploded',
      ]);
    });
  });
});

class FakeCommand {
  constructor(
    private readonly actions: Map<string, InstallAction>,
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

  action(fn: InstallAction): this {
    this.actions.set(this.name, fn);
    return this;
  }
}

function registerInstallAction(overrides: Partial<InstallCommandDeps> = {}): {
  action: InstallAction;
  calls: string[];
} {
  const actions = new Map<string, InstallAction>();
  const calls: string[] = [];
  registerInstallCommand({
    program: new FakeCommand(actions),
    error: (message) => calls.push(`error:${message}`),
    writeStdout: (message) => calls.push(`stdout:${message}`),
    loadInstallerTargets: async () => {
      calls.push('loadTargets');
      return {
        getTarget: () => null,
        listTargetIds: () => ['claude', 'cursor'],
      };
    },
    loadInstaller: async () => {
      calls.push('loadInstaller');
      return {
        runInstallerWithOptions: async (opts) => calls.push(`install:${JSON.stringify(opts)}`),
      };
    },
    ...overrides,
  });
  const action = actions.get('install');
  if (!action) throw new Error('install action was not registered');
  return { action, calls };
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<void> {
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  let exitCalled = false;
  process.exitCode = 0;
  process.exit = (code?: string | number | null | undefined): never => {
    exitCalled = true;
    throw new Error(`process.exit(${String(code)})`);
  };

  try {
    await run();
    expect(exitCalled).toBe(false);
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode ?? 0;
  }
}
