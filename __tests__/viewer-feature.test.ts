import { describe, expect, it } from 'vitest';
import { parseViewerPort, registerViewerCommand, type ViewerCommandDeps } from '../src/features/viewer/index.js';
import { clampInt } from '../src/features/viewer/server/http.js';

interface ViewerCliActionOptions {
  port?: string;
  open?: boolean;
  session?: string;
  allowConfigEdit?: boolean;
}

type ViewerCliAction = (pathArg: string | undefined, options: ViewerCliActionOptions) => Promise<void>;
type ViewerShutdownListener = () => Promise<void>;

describe('viewer feature runtime', () => {
  it('parses the optional HTTP port as an explicit result', () => {
    expect(parseViewerPort(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseViewerPort('0')).toEqual({ ok: true, value: 0 });
    expect(parseViewerPort('8765')).toEqual({ ok: true, value: 8765 });
    expect(parseViewerPort('abc')).toEqual({
      ok: false,
      error: 'Invalid value for --port: "abc" is not a number',
    });
    expect(parseViewerPort('8765x')).toEqual({
      ok: false,
      error: 'Invalid value for --port: "8765x" is not a number',
    });
    expect(parseViewerPort('1e3')).toEqual({
      ok: false,
      error: 'Invalid value for --port: "1e3" is not a number',
    });
  });

  it('clamps HTTP integer query params only after exact decimal parsing', () => {
    const bound = { min: 1, max: 10, default: 4 };
    expect(clampInt('8', bound)).toBe(8);
    expect(clampInt('-2', bound)).toBe(1);
    expect(clampInt('99', bound)).toBe(10);
    expect(clampInt('8x', bound)).toBe(4);
    expect(clampInt('1e2', bound)).toBe(4);
  });
});

describe('viewer feature CLI', () => {
  it('starts the viewer server and opens the browser by default', async () => {
    let action: ViewerCliAction | undefined;
    const calls: string[] = [];
    const shutdownListeners: ViewerShutdownListener[] = [];

    registerViewerCommand({
      program: fakeProgram((fn) => {
        action = fn;
      }, calls),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      error: (message) => calls.push(`error:${message}`),
      info: (message) => calls.push(`info:${message}`),
      loadViewerServer: async () => ({
        startViewerServer: async (projectPath, opts) => {
          calls.push(`start:${projectPath}:${JSON.stringify(opts)}`);
          return { url: `http://localhost:${opts?.port ?? 8765}`, close: async () => undefined };
        },
        openInBrowser: (url) => calls.push(`open:${url}`),
      }),
      registerShutdownSignal: (_signal, listener) => {
        shutdownListeners.push(listener);
      },
    });

    expect(action).toBeDefined();
    await action!('/repo', { port: '0' });

    expect(calls).toEqual([
      'command:viewer [path]',
      'description:Open the local web viewer (graph visualization, impact tools, system overview) for the indexed graph',
      'option:-p, --port <n>',
      'option:--no-open',
      'option:--session <idOrLabel>',
      'option:--allow-config-edit',
      'start:/repo:{"port":0}',
      'info:Viewer running at http://localhost:0',
      'info:  project: /repo',
      'info:  press Ctrl+C to stop',
      'open:http://localhost:0',
    ]);
    expect(shutdownListeners).toHaveLength(1);
  });

  it('reports an invalid port without loading the server', async () => {
    let action: ViewerCliAction | undefined;
    const calls: string[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    let exitCodeAfterAction: string | number | undefined;

    registerViewerCommand({
      program: fakeProgram((fn) => {
        action = fn;
      }, calls),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      error: (message) => calls.push(`error:${message}`),
      info: (message) => calls.push(`info:${message}`),
      loadViewerServer: async () => {
        calls.push('load-server');
        throw new Error('server should not load');
      },
    });

    try {
      await action!('/repo', { port: 'many' });
      exitCodeAfterAction = process.exitCode;
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
    expect(exitCodeAfterAction).toBe(1);
    expect(calls).toContain('error:Invalid value for --port: "many" is not a number');
    expect(calls).not.toContain('load-server');
  });

  it('reports an uninitialized project without calling process.exit or loading the server', async () => {
    const { action, calls } = registerViewerHarness({ initialized: false });

    const exitCode = await withProcessExitGuard(async () => {
      await action('/repo', {});
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:No Cartograph index at /repo. Run `cartograph index /repo` first.');
    expect(calls).not.toContain('load-server');
    expect(calls.find((call) => call.startsWith('start:'))).toBeUndefined();
  });

  it('reports server start failures without calling process.exit', async () => {
    const { action, calls } = registerViewerHarness({ startError: new Error('start boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await action('/repo', { port: '0', open: false });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:Failed to start viewer: start boom');
  });

  it('closes the viewer on SIGINT without calling process.exit', async () => {
    const { action, calls, shutdownListeners } = registerViewerHarness();

    const exitCode = await withProcessExitGuard(async () => {
      await action('/repo', { port: '0', open: false });
      expect(shutdownListeners).toHaveLength(1);
      await shutdownListeners[0]!();
    });

    expect(exitCode ?? 0).toBe(0);
    expect(calls).toContain('close');
  });
});

function fakeProgram(setAction: (fn: ViewerCliAction) => void, calls: string[]): ViewerCommandDeps['program'] {
  return {
    command(name: string) {
      calls.push(`command:${name}`);
      return this;
    },
    description(text: string) {
      calls.push(`description:${text}`);
      return this;
    },
    option(...args: unknown[]) {
      calls.push(`option:${String(args[0])}`);
      return this;
    },
    action(fn: ViewerCliAction) {
      setAction(fn);
      return this;
    },
  };
}

function registerViewerHarness(options: { initialized?: boolean; startError?: Error; closeError?: Error } = {}): {
  action: ViewerCliAction;
  calls: string[];
  shutdownListeners: ViewerShutdownListener[];
} {
  let action: ViewerCliAction | undefined;
  const calls: string[] = [];
  const shutdownListeners: ViewerShutdownListener[] = [];

  registerViewerCommand({
    program: fakeProgram((fn) => {
      action = fn;
    }, calls),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    isInitialized: () => options.initialized ?? true,
    error: (message) => calls.push(`error:${message}`),
    info: (message) => calls.push(`info:${message}`),
    loadViewerServer: async () => {
      calls.push('load-server');
      return {
        startViewerServer: async (projectPath, opts) => {
          calls.push(`start:${projectPath}:${JSON.stringify(opts)}`);
          if (options.startError) throw options.startError;
          return {
            url: `http://localhost:${opts?.port ?? 8765}`,
            close: async () => {
              calls.push('close');
              if (options.closeError) throw options.closeError;
            },
          };
        },
        openInBrowser: (url) => calls.push(`open:${url}`),
      };
    },
    registerShutdownSignal: (_signal, listener) => {
      shutdownListeners.push(listener);
    },
  });

  if (!action) throw new Error('viewer action was not registered');
  return { action, calls, shutdownListeners };
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<string | number | undefined> {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const originalExit = process.exit;
  process.exit = (code?: string | number | null | undefined): never => {
    throw new Error(`process.exit(${String(code)})`);
  };
  try {
    await run();
    return process.exitCode;
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode ?? 0;
  }
}
