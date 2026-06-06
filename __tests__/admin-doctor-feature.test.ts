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
});

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
