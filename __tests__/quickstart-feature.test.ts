import { describe, expect, it } from 'bun:test';
import { registerQuickstartCommand, type QuickstartCommandDeps } from '../src/features/quickstart/index.js';
import type { CliOptionCommand } from '../src/features/shared/cli-command.js';
import type { QuickstartRunResult } from '../src/features/quickstart/runtime.js';

type QuickstartCliAction = (pathArg: string | undefined) => Promise<void>;
type QuickstartIndexResult = QuickstartRunResult['index'];

function isQuickstartCliAction(value: unknown): value is QuickstartCliAction {
  return typeof value === 'function';
}

function captureQuickstartAction(): { program: CliOptionCommand; action: () => QuickstartCliAction } {
  let registeredAction: unknown;
  const command: CliOptionCommand = {
    command() {
      return command;
    },
    alias() {
      return command;
    },
    description() {
      return command;
    },
    option() {
      return command;
    },
    action<Args extends unknown[]>(fn: (...args: Args) => unknown) {
      registeredAction = fn;
      return command;
    },
  };

  return {
    program: command,
    action() {
      if (!isQuickstartCliAction(registeredAction)) throw new Error('quickstart CLI action was not registered');
      return registeredAction;
    },
  };
}

function indexResult(overrides: Partial<QuickstartIndexResult> = {}): QuickstartIndexResult {
  return {
    success: true,
    filesIndexed: 2,
    filesSkipped: 0,
    filesErrored: 0,
    nodesCreated: 3,
    edgesCreated: 4,
    durationMs: 5,
    ...overrides,
  };
}

function registerAction(overrides: Partial<QuickstartCommandDeps> = {}) {
  const { program, action } = captureQuickstartAction();
  const calls: string[] = [];
  const stdout: string[] = [];
  const errors: string[] = [];

  registerQuickstartCommand({
    program,
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    isInitialized: () => false,
    info: (message) => calls.push(`info:${message}`),
    error: (message) => errors.push(message),
    writeStdout: (message = '') => stdout.push(message),
    loadCartograph: async () => ({
      default: {
        init: async () => ({
          indexAll: async () => indexResult(),
          close: () => calls.push('close'),
        }),
        open: async () => ({
          indexAll: async () => indexResult(),
          close: () => calls.push('close'),
        }),
      },
    }),
    loadDoctor: async () => ({
      runDoctor: async () => ({ overallStatus: 'ok' }),
    }),
    ...overrides,
  });

  return { action: action(), calls, stdout, errors };
}

describe('quickstart feature CLI', () => {
  it('reports index failures with exitCode instead of hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls, stdout, errors } = registerAction({
        loadCartograph: async () => ({
          default: {
            init: async (projectPath, opts) => {
              calls.push(`init:${projectPath}:${JSON.stringify(opts)}`);
              return {
                indexAll: async (options) => {
                  calls.push(`indexAll:${JSON.stringify(options)}`);
                  return indexResult({
                    success: false,
                    filesErrored: 1,
                    durationMs: 1234,
                    errors: [{ filePath: 'src/broken.ts', message: 'parse failed' }],
                  });
                },
                close: () => calls.push('close'),
              };
            },
            open: async () => {
              throw new Error('open should not run');
            },
          },
        }),
      });

      await action('/repo');

      expect(process.exitCode).toBe(1);
      expect(stdout.join('\n')).toContain('✗ Indexed: failed after 1.2s');
      expect(stdout.join('\n')).toContain('- src/broken.ts: parse failed');
      expect(errors).toEqual([]);
      expect(calls).toContain('close');
    });
  });

  it('reports runtime failures, closes the graph, and does not hard-exit', async () => {
    await withProcessExitGuard(async () => {
      const { action, calls, stdout, errors } = registerAction({
        isInitialized: () => true,
        loadCartograph: async () => ({
          default: {
            init: async () => {
              throw new Error('init should not run');
            },
            open: async (projectPath, opts) => {
              calls.push(`open:${projectPath}:${JSON.stringify(opts)}`);
              return {
                indexAll: async () => {
                  calls.push('indexAll');
                  throw new Error('disk unavailable');
                },
                close: () => calls.push('close'),
              };
            },
          },
        }),
        loadDoctor: async () => {
          throw new Error('doctor should not run');
        },
      });

      await action('/repo');

      expect(process.exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(errors).toEqual(['index failed: disk unavailable']);
      expect(calls).toContain('close');
    });
  });
});

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
