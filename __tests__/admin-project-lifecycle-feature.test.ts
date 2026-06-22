import { describe, expect, it, vi } from 'vitest';
import {
  registerAdminProjectLifecycleCommands,
  resolveInitProjectPath,
  shouldConfirmUninit,
} from '../src/features/admin-project-lifecycle/index.js';

describe('admin project lifecycle feature runtime', () => {
  it('resolves init paths and confirmation answers', () => {
    expect(resolveInitProjectPath(undefined, '/repo')).toBe('/repo');
    expect(shouldConfirmUninit('y')).toBe(true);
    expect(shouldConfirmUninit('Y')).toBe(true);
    expect(shouldConfirmUninit('yes')).toBe(false);
  });
});

describe('admin project lifecycle feature CLI', () => {
  it('initializes and indexes a project with progress cleanup', async () => {
    const { actions, calls } = registerTestCommands(false);

    await actions.get('init [path]')!('/repo', { index: true, verbose: false });

    expect(calls).toEqual([
      'intro:Initializing Cartograph',
      'init:/repo:{"index":false}',
      'clack.success:Initialized in /repo',
      'stdout:dim│reset\n',
      'indexAll:{}',
      'progress.stop',
      'printIndexResult:/repo',
      'outro:Done',
      'close',
    ]);
  });

  it('initializes max-file-size config and applies it to the first index', async () => {
    const { actions, calls } = registerTestCommands(false);

    await actions.get('init [path]')!('/repo', { index: true, verbose: false, maxFileSize: '4096' });

    expect(calls).toEqual([
      'intro:Initializing Cartograph',
      'init:/repo:{"index":false,"config":{"maxFileSize":4096}}',
      'clack.success:Initialized in /repo',
      'stdout:dim│reset\n',
      'indexAll:{"maxFileSize":4096}',
      'progress.stop',
      'printIndexResult:/repo',
      'outro:Done',
      'close',
    ]);
  });

  it('reports invalid init max-file-size without calling process.exit or initializing', async () => {
    const { actions, calls } = registerTestCommands(false);

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('init [path]')!('/repo', { maxFileSize: 'abc' });
    });

    expect(exitCode).toBe(1);
    expect(calls[0]).toBe('intro:Initializing Cartograph');
    expect(calls[1]).toContain('clack.error:--max-file-size must be between');
    expect(calls.some((call) => call.startsWith('init:'))).toBe(false);
  });

  it('reports init failures without calling process.exit', async () => {
    const { actions, calls } = registerTestCommands(false, { initError: new Error('init boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('init [path]')!('/repo', {});
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([
      'intro:Initializing Cartograph',
      'init:/repo:{"index":false}',
      'clack.error:Failed: init boom',
    ]);
  });

  it('uninitializes with force without prompting', async () => {
    const { actions, calls } = registerTestCommands(true);

    await actions.get('uninit [path]')!('/repo', { force: true });

    expect(calls).toEqual(['openSync:/repo', 'uninitialize', 'success:Removed Cartograph from /repo']);
  });

  it('reports uninit failures without calling process.exit', async () => {
    const { actions, calls } = registerTestCommands(true, { uninitializeError: new Error('uninit boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('uninit [path]')!('/repo', { force: true });
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual(['openSync:/repo', 'uninitialize', 'error:Failed to uninitialize: uninit boom']);
  });
});

interface RegisterTestCommandOptions {
  initError?: Error;
  uninitializeError?: Error;
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<string | number | undefined> {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await run();
    return process.exitCode;
  } finally {
    exitSpy.mockRestore();
    process.exitCode = originalExitCode ?? 0;
  }
}

function registerTestCommands(initialized: boolean, options: RegisterTestCommandOptions = {}) {
  const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
  const calls: string[] = [];
  const fakeCg = {
    indexAll: async (opts: Record<string, unknown>) => {
      calls.push(`indexAll:${JSON.stringify(opts)}`);
      return { success: true };
    },
    uninitialize: async () => {
      calls.push('uninitialize');
      if (options.uninitializeError) throw options.uninitializeError;
    },
    close: () => calls.push('close'),
  };

  registerAdminProjectLifecycleCommands({
    adminCmd: new FakeCommand(actions),
    colors: { dim: 'dim', reset: 'reset' },
    chalk: { yellow: (message) => message },
    createShimmerProgress: () => ({
      onProgress: () => undefined,
      stop: async () => calls.push('progress.stop'),
    }),
    createVerboseProgress: () => () => undefined,
    isInitialized: () => initialized,
    loadCartograph: async () => ({
      default: {
        init: async (projectPath, opts) => {
          calls.push(`init:${projectPath}:${JSON.stringify(opts)}`);
          if (options.initError) throw options.initError;
          initialized = true;
          return fakeCg;
        },
        openSync: (projectPath) => {
          calls.push(`openSync:${projectPath}`);
          return fakeCg;
        },
      },
    }),
    loadClack: async () => ({
      intro: (message: string) => calls.push(`intro:${message}`),
      outro: (message: string) => calls.push(`outro:${message}`),
      note: (message: string, title?: string) => calls.push(`clack.note:${title}:${message}`),
      log: {
        success: (message: string) => calls.push(`clack.success:${message}`),
        info: (message: string) => calls.push(`clack.info:${message}`),
        warn: (message: string) => calls.push(`clack.warn:${message}`),
        error: (message: string) => calls.push(`clack.error:${message}`),
      },
    }),
    loadReadline: async () => ({
      createInterface: () => ({
        question: (_message: string, resolve: (answer: string) => void) => resolve('y'),
        close: () => calls.push('readline.close'),
      }),
    }),
    printIndexResult: (_clack, _result, projectPath) => calls.push(`printIndexResult:${projectPath}`),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    writeStdout: (message) => calls.push(`stdout:${message}`),
    success: (message) => calls.push(`success:${message}`),
    info: (message) => calls.push(`info:${message}`),
    warn: (message) => calls.push(`warn:${message}`),
    error: (message) => calls.push(`error:${message}`),
  });

  return { actions, calls };
}

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (...args: unknown[]) => Promise<void>>,
    private readonly name = 'admin',
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

  action(fn: (...args: unknown[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
