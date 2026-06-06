import { describe, expect, it } from 'vitest';
import {
  doctorRunOptions,
  finalDoctorStatus,
  registerDoctorCommand,
  resolveSkipProjectChecks,
} from '../src/features/doctor/index.js';

describe('doctor feature runtime', () => {
  it('resolves aliases, run options, and post-fix status', () => {
    expect(resolveSkipProjectChecks({})).toBe(false);
    expect(resolveSkipProjectChecks({ projectChecks: false })).toBe(true);
    expect(resolveSkipProjectChecks({ skipProjectChecks: true })).toBe(true);
    expect(doctorRunOptions('/repo', { skipProjectChecks: true, fix: true })).toEqual({
      projectPath: '/repo',
      skipProjectChecks: true,
      fix: true,
    });
    expect(doctorRunOptions(undefined, {})).toEqual({ skipProjectChecks: false, fix: false });
    expect(finalDoctorStatus({ overallStatus: 'fail', afterFix: { overallStatus: 'pass' } })).toBe('pass');
  });
});

describe('doctor feature CLI', () => {
  it('runs doctor and renders JSON through injected dependencies', async () => {
    const actions = new Map<string, (...args: any[]) => Promise<void>>();
    const calls: string[] = [];

    registerDoctorCommand({
      program: new FakeCommand(actions),
      loadDoctor: async () => ({
        runDoctor: async (opts) => {
          calls.push(`doctor:${JSON.stringify(opts)}`);
          return { overallStatus: 'pass' };
        },
        formatDoctorReport: () => 'doctor report',
        formatDoctorJson: () => '{"overallStatus":"pass"}',
      }),
      writeStdout: (message = '') => calls.push(`stdout:${message}`),
    });

    await actions.get('doctor [path]')!('/repo', { skipProjectChecks: true, json: true });

    expect(calls).toEqual([
      'doctor:{"projectPath":"/repo","skipProjectChecks":true,"fix":false}',
      'stdout:{"overallStatus":"pass"}',
    ]);
  });
});

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (...args: any[]) => Promise<void>>,
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

  action(fn: (...args: any[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
