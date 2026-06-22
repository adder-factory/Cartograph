import { describe, expect, it } from 'vitest';
import {
  finalDoctorStatus,
  registerAdminDoctorCommand,
  resolveSkipProjectChecks,
} from '../src/features/admin-doctor/index.js';

describe('admin doctor feature runtime', () => {
  it('resolves option aliases and post-fix status', () => {
    expect(resolveSkipProjectChecks({})).toBe(false);
    expect(resolveSkipProjectChecks({ projectChecks: false })).toBe(true);
    expect(resolveSkipProjectChecks({ skipProjectChecks: true })).toBe(true);

    expect(finalDoctorStatus({ overallStatus: 'fail' })).toBe('fail');
    expect(finalDoctorStatus({ overallStatus: 'fail', afterFix: { overallStatus: 'pass' } })).toBe('pass');
  });
});

describe('admin doctor feature CLI', () => {
  it('runs doctor with resolved options and renders JSON output', async () => {
    let action:
      | ((
          pathArg: string | undefined,
          options: { fix?: boolean; projectChecks?: boolean; skipProjectChecks?: boolean; json?: boolean },
        ) => Promise<void>)
      | undefined;
    const calls: string[] = [];
    const stdout: string[] = [];

    registerAdminDoctorCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      writeStdout: (message) => stdout.push(message),
      error: (message) => calls.push(`error:${message}`),
      loadDoctor: async () => ({
        runDoctor: async (opts) => {
          calls.push(`runDoctor:${JSON.stringify(opts)}`);
          return { overallStatus: 'fail', afterFix: { overallStatus: 'pass' } };
        },
        formatDoctorReport: () => '# Doctor',
        formatDoctorJson: () => '{"overallStatus":"fail","afterFix":{"overallStatus":"pass"}}',
      }),
    });

    expect(action).toBeDefined();
    await action!('/repo', { fix: true, projectChecks: false, json: true });

    expect(calls).toEqual(['runDoctor:{"projectPath":"/repo","fix":true,"skipProjectChecks":true}']);
    expect(stdout).toEqual(['{"overallStatus":"fail","afterFix":{"overallStatus":"pass"}}\n']);
  });

  it('sets exitCode instead of hard-exiting when doctor reports failure', async () => {
    const stdout: string[] = [];
    const errors: string[] = [];
    const action = captureAdminDoctorAction({
      writeStdout: (message) => stdout.push(message),
      error: (message) => errors.push(message),
      loadDoctor: async () => ({
        runDoctor: async () => ({ overallStatus: 'fail' }),
        formatDoctorReport: () => '# Doctor\n\nInstall state failed.',
        formatDoctorJson: () => '{"overallStatus":"fail"}',
      }),
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
      await action('/repo', {});
      observedExitCode = process.exitCode;
    } finally {
      process.exit = originalExit;
      // `?? 0`: under Bun, `process.exitCode = undefined` does NOT clear a
      // previously-set code, so restoring the (undefined) original would leak
      // the SUT's exitCode=1 to the test process — passing tests, exit 1.
      process.exitCode = originalExitCode ?? 0;
    }

    expect(exitCalled).toBe(false);
    expect(observedExitCode).toBe(1);
    expect(stdout).toEqual(['# Doctor\n\nInstall state failed.\n']);
    expect(errors).toEqual([]);
  });
});

function captureAdminDoctorAction({
  error = () => {},
  loadDoctor,
  writeStdout = () => {},
}: {
  error?: Parameters<typeof registerAdminDoctorCommand>[0]['error'];
  loadDoctor: Parameters<typeof registerAdminDoctorCommand>[0]['loadDoctor'];
  writeStdout?: Parameters<typeof registerAdminDoctorCommand>[0]['writeStdout'];
}) {
  let action:
    | ((
        pathArg: string | undefined,
        options: { fix?: boolean; projectChecks?: boolean; skipProjectChecks?: boolean; json?: boolean },
      ) => Promise<void>)
    | undefined;

  registerAdminDoctorCommand({
    adminCmd: fakeCommand((fn) => {
      action = fn;
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    writeStdout,
    error,
    loadDoctor,
  });

  if (!action) throw new Error('admin doctor action was not registered');
  return action;
}

function fakeCommand(
  setAction: (
    fn: (
      pathArg: string | undefined,
      options: { fix?: boolean; projectChecks?: boolean; skipProjectChecks?: boolean; json?: boolean },
    ) => Promise<void>,
  ) => void,
) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(
      fn: (
        pathArg: string | undefined,
        options: { fix?: boolean; projectChecks?: boolean; skipProjectChecks?: boolean; json?: boolean },
      ) => Promise<void>,
    ) {
      setAction(fn);
      return this;
    },
  };
}
