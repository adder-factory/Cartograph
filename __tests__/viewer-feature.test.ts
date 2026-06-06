import { describe, expect, it } from 'vitest';
import { parseViewerPort, registerViewerCommand } from '../src/features/viewer/index.js';

describe('viewer feature runtime', () => {
  it('parses the optional HTTP port as an explicit result', () => {
    expect(parseViewerPort(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseViewerPort('0')).toEqual({ ok: true, value: 0 });
    expect(parseViewerPort('8765')).toEqual({ ok: true, value: 8765 });
    expect(parseViewerPort('abc')).toEqual({
      ok: false,
      error: 'Invalid value for --port: "abc" is not a number',
    });
  });
});

describe('viewer feature CLI', () => {
  it('starts the viewer server and opens the browser by default', async () => {
    let action:
      | ((pathArg: string | undefined, options: { port?: string; open?: boolean }) => Promise<void>)
      | undefined;
    const calls: string[] = [];

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
    });

    expect(action).toBeDefined();
    await action!('/repo', { port: '0' });

    expect(calls).toEqual([
      'command:viewer [path]',
      'description:Open the local web viewer for the indexed graph',
      'option:-p, --port <n>',
      'option:--no-open',
      'start:/repo:{"port":0}',
      'info:Viewer running at http://localhost:0',
      'info:  project: /repo',
      'info:  press Ctrl+C to stop',
      'open:http://localhost:0',
    ]);
  });

  it('reports an invalid port without loading the server', async () => {
    let action:
      | ((pathArg: string | undefined, options: { port?: string; open?: boolean }) => Promise<void>)
      | undefined;
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
});

function fakeProgram(
  setAction: (fn: (pathArg: string | undefined, options: { port?: string; open?: boolean }) => Promise<void>) => void,
  calls: string[],
) {
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
    action(fn: (pathArg: string | undefined, options: { port?: string; open?: boolean }) => Promise<void>) {
      setAction(fn);
      return this;
    },
  };
}
