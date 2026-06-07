import { describe, expect, it } from 'vitest';
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

  it('uninitializes with force without prompting', async () => {
    const { actions, calls } = registerTestCommands(true);

    await actions.get('uninit [path]')!('/repo', { force: true });

    expect(calls).toEqual(['openSync:/repo', 'uninitialize', 'success:Removed Cartograph from /repo']);
  });
});

function registerTestCommands(initialized: boolean) {
  const actions = new Map<string, (...args: any[]) => Promise<void>>();
  const calls: string[] = [];
  const fakeCg = {
    indexAll: async (opts: Record<string, unknown>) => {
      calls.push(`indexAll:${JSON.stringify(opts)}`);
      return { success: true };
    },
    uninitialize: async () => calls.push('uninitialize'),
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
          initialized = true;
          return fakeCg;
        },
        openSync: (projectPath) => {
          calls.push(`openSync:${projectPath}`);
          return fakeCg;
        },
      },
    }),
    loadClack: async () =>
      ({
        intro: (message: string) => calls.push(`intro:${message}`),
        outro: (message: string) => calls.push(`outro:${message}`),
        log: {
          success: (message: string) => calls.push(`clack.success:${message}`),
          info: (message: string) => calls.push(`clack.info:${message}`),
          warn: (message: string) => calls.push(`clack.warn:${message}`),
          error: (message: string) => calls.push(`clack.error:${message}`),
        },
      }) as any,
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
    private readonly actions: Map<string, (...args: any[]) => Promise<void>>,
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

  action(fn: (...args: any[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
