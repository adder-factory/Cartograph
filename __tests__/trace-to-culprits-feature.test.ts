import { describe, expect, it } from 'vitest';
import { registerTraceToCulpritsCommand } from '../src/features/trace-to-culprits/index.js';
import type { CliOptionCommand } from '../src/features/shared/cli-command.js';

interface TraceToCulpritsCliOptions {
  readonly projectPath?: string;
  readonly limit?: string;
  readonly trace?: string;
}

type TraceToCulpritsCliAction = (options: TraceToCulpritsCliOptions) => Promise<void>;

function isTraceToCulpritsCliAction(value: unknown): value is TraceToCulpritsCliAction {
  return typeof value === 'function';
}

function captureTraceToCulpritsAction(): {
  program: CliOptionCommand;
  action: () => TraceToCulpritsCliAction;
} {
  let registeredAction: unknown;
  const command: CliOptionCommand = {
    command() {
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
      if (!isTraceToCulpritsCliAction(registeredAction)) {
        throw new Error('trace-to-culprits CLI action was not registered');
      }
      return registeredAction;
    },
  };
}

describe('trace-to-culprits feature CLI', () => {
  it('sets exitCode instead of hard-exiting when no trace is provided', async () => {
    const { program, action } = captureTraceToCulpritsAction();
    const stderr: string[] = [];
    let assignIntCalled = false;
    let runViaMcpCalled = false;

    registerTraceToCulpritsCommand({
      program,
      assignIntArg: () => {
        assignIntCalled = true;
        return true;
      },
      runViaMCP: async () => {
        runViaMcpCalled = true;
      },
      writeStderr: (message = '') => stderr.push(message),
      readStdin: async () => '   \n',
    });

    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    let exitCalled = false;
    let observedExitCode: string | number | undefined;
    process.exitCode = 0;
    process.exit = (code?: string | number | null | undefined): never => {
      exitCalled = true;
      throw new Error(`process.exit(${String(code)})`);
    };

    try {
      await action()({ projectPath: '/repo' });
      observedExitCode = process.exitCode;
    } finally {
      process.exit = originalExit;
      process.exitCode = originalExitCode ?? 0;
    }

    expect(exitCalled).toBe(false);
    expect(observedExitCode).toBe(2);
    expect(stderr).toEqual(['No trace provided. Pipe a stack trace to stdin or pass --trace "<text>".']);
    expect(assignIntCalled).toBe(false);
    expect(runViaMcpCalled).toBe(false);
  });
});
