import { describe, expect, it } from 'vitest';
import { registerSetupCommand, runSetup, type SetupRuntimeDeps } from '../src/features/setup/index.js';
import type { CliOptionCommand } from '../src/features/shared/cli-command.js';

interface SetupCliOptions {
  readonly minimal?: boolean;
  readonly models?: boolean;
}

type SetupCliAction = (pathArg: string | undefined, options: SetupCliOptions) => Promise<void>;

function isSetupCliAction(value: unknown): value is SetupCliAction {
  return typeof value === 'function';
}

function createSetupCommandHarness(): {
  program: CliOptionCommand;
  llmCmd: CliOptionCommand;
  actions: Map<string, unknown>;
} {
  const actions = new Map<string, unknown>();

  function makeCommand(name: string): CliOptionCommand {
    let command: CliOptionCommand;
    command = {
      command(childName: string) {
        return makeCommand(childName);
      },
      description() {
        return command;
      },
      option() {
        return command;
      },
      action<Args extends unknown[]>(fn: (...args: Args) => unknown) {
        actions.set(name, fn);
        return command;
      },
    };
    return command;
  }

  return { program: makeCommand('program'), llmCmd: makeCommand('llm'), actions };
}

describe('setup feature runtime', () => {
  it('initializes the project, skips models when requested, and runs doctor', async () => {
    const calls: string[] = [];
    const deps: SetupRuntimeDeps = {
      isInitialized: () => false,
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
      writeProgress: (message) => calls.push(`progress:${message}`),
      loadCartograph: async () => ({
        default: {
          init: async (projectPath, options) => {
            calls.push(`init:${projectPath}:${JSON.stringify(options)}`);
            return { close: () => calls.push('close') };
          },
        },
      }),
      loadDoctor: async () => ({
        runDoctor: async (opts) => {
          calls.push(`doctor:${JSON.stringify(opts)}`);
          return { overallStatus: 'pass' };
        },
        formatDoctorReport: () => 'doctor report',
      }),
      loadInstallModels: async () => {
        throw new Error('models should be skipped');
      },
      loadRecommendedModels: async () => {
        throw new Error('models should be skipped');
      },
      loadRecommendedConfig: async () => {
        throw new Error('config should not be written');
      },
    };

    const result = await runSetup({ projectPath: '/repo', models: false }, deps);

    expect(result).toEqual({ doctor: { overallStatus: 'pass' }, doctorReport: 'doctor report' });
    expect(calls).toContain('init:/repo:{"index":false}');
    expect(calls).toContain('close');
    expect(calls).toContain('info:Step 2/3: --no-models → skipping models install');
    expect(calls).toContain('doctor:{"projectPath":"/repo"}');
  });

  it('installs the minimal model set and writes minimal LLM config', async () => {
    const calls: string[] = [];
    const deps: SetupRuntimeDeps = {
      isInitialized: () => true,
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
      writeProgress: (message) => calls.push(`progress:${message}`),
      loadCartograph: async () => {
        throw new Error('init should be skipped');
      },
      loadDoctor: async () => ({
        runDoctor: async (opts) => {
          calls.push(`doctor:${JSON.stringify(opts)}`);
          return { overallStatus: 'pass' };
        },
        formatDoctorReport: () => 'doctor report',
      }),
      loadInstallModels: async () => ({
        installRecommendedModels: async ({ models, onProgress }) => {
          calls.push(`install:${JSON.stringify(models)}`);
          onProgress({ model: { filename: 'mini.gguf' }, downloaded: 524_288, total: 1_048_576 });
          return { downloaded: ['mini.gguf'], skipped: ['existing.gguf'] };
        },
      }),
      loadRecommendedModels: async () => ({
        RECOMMENDED_MODELS: ['full.gguf'],
        MINIMAL_MODELS: ['mini.gguf'],
      }),
      loadRecommendedConfig: async () => ({
        writeRecommendedLlmConfig: (opts) => {
          calls.push(`config:${JSON.stringify(opts)}`);
          return { configPath: '/repo/.cartograph/config.json' };
        },
      }),
    };

    await runSetup({ projectPath: '/repo', minimal: true }, deps);

    expect(calls).toContain('install:["mini.gguf"]');
    expect(calls).toContain('config:{"projectRoot":"/repo","includeAsk":false,"includeReranker":false}');
    expect(calls.some((call) => call.includes('mini.gguf') && call.includes('(50%)'))).toBe(true);
    expect(calls).toContain('doctor:{"projectPath":"/repo"}');
  });

  it('passes database config into init', async () => {
    const calls: string[] = [];
    const deps: SetupRuntimeDeps = {
      isInitialized: () => false,
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
      writeProgress: (message) => calls.push(`progress:${message}`),
      loadCartograph: async () => ({
        default: {
          init: async (projectPath, options) => {
            calls.push(`init:${projectPath}:${JSON.stringify(options)}`);
            return { close: () => calls.push('close') };
          },
        },
      }),
      loadDoctor: async () => ({
        runDoctor: async (opts) => {
          calls.push(`doctor:${JSON.stringify(opts)}`);
          return { overallStatus: 'pass' };
        },
        formatDoctorReport: () => 'doctor report',
      }),
      loadInstallModels: async () => {
        throw new Error('models should be skipped');
      },
      loadRecommendedModels: async () => {
        throw new Error('models should be skipped');
      },
      loadRecommendedConfig: async () => {
        throw new Error('config should not be written');
      },
    };

    await runSetup(
      {
        projectPath: '/repo',
        models: false,
        database: { provider: 'postgres', url: 'postgres://localhost/cartograph', schema: 'cartograph' },
      },
      deps,
    );

    expect(calls).toContain(
      'init:/repo:{"index":false,"config":{"database":{"provider":"postgres","url":"postgres://localhost/cartograph","schema":"cartograph"}}}',
    );
  });
});

describe('setup feature CLI', () => {
  it('reports doctor failures with exitCode instead of hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const { program, llmCmd, actions } = createSetupCommandHarness();
      const calls: string[] = [];
      const stdout: string[] = [];

      registerSetupCommand({
        program,
        llmCmd,
        resolveProjectPath: (pathArg) => pathArg ?? '/repo',
        writeStdout: (message = '') => stdout.push(message),
        writeProgress: (message) => calls.push(`progress:${message}`),
        isInitialized: () => true,
        info: (message) => calls.push(`info:${message}`),
        error: (message) => calls.push(`error:${message}`),
        loadCartograph: async () => {
          throw new Error('init should be skipped');
        },
        loadDoctor: async () => ({
          runDoctor: async (opts) => {
            calls.push(`doctor:${JSON.stringify(opts)}`);
            return { overallStatus: 'fail' };
          },
          formatDoctorReport: () => 'doctor failed report',
        }),
        loadInstallModels: async () => {
          throw new Error('models should be skipped');
        },
        loadRecommendedModels: async () => {
          throw new Error('models should be skipped');
        },
        loadRecommendedConfig: async () => {
          throw new Error('config should not be written');
        },
      });

      const action = actions.get('install [path]');
      if (!isSetupCliAction(action)) throw new Error('setup install action was not registered');

      await action('/repo', { models: false });

      expect(process.exitCode).toBe(1);
      expect(stdout).toEqual(['\ndoctor failed report']);
      expect(calls).toContain('doctor:{"projectPath":"/repo"}');
      expect(calls).not.toContain('error:doctor failed report');
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
