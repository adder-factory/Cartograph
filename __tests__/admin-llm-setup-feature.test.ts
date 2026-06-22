import { describe, expect, it, vi } from 'vitest';
import { parseLlmTuneOverride, registerAdminLlmSetupCommands } from '../src/features/admin-llm-setup/index.js';

const TEST_ENDPOINT = 'http://localhost:11434';

describe('admin LLM setup feature runtime', () => {
  it('parses tuning overrides as explicit result values', () => {
    expect(parseLlmTuneOverride({ tier: 'chat', concurrency: '4' })).toEqual({
      ok: true,
      tier: 'chat',
      concurrency: 4,
    });
    expect(parseLlmTuneOverride({ tier: 'bad', concurrency: '4' })).toEqual({
      ok: false,
      error: '--tier must be one of embed, chat, ask, reranker',
    });
    expect(parseLlmTuneOverride({ tier: 'chat', concurrency: '0' })).toEqual({
      ok: false,
      error: '--concurrency must be a positive integer when --tier is set',
    });
    expect(parseLlmTuneOverride({ tier: 'chat', concurrency: '4x' })).toEqual({
      ok: false,
      error: '--concurrency must be a positive integer when --tier is set',
    });
    expect(parseLlmTuneOverride({ tier: 'chat', concurrency: '1e2' })).toEqual({
      ok: false,
      error: '--concurrency must be a positive integer when --tier is set',
    });
  });
});

describe('admin LLM setup feature CLI', () => {
  it('registers plan, apply, and tune commands against injected deps', async () => {
    const { actions, calls, stdout } = registerTestCommands();

    await actions.get('llm-plan [path]')!('/repo');
    await actions.get('llm-apply')!({ preset: 'install-ollama', projectPath: '/repo' });
    await actions.get('llm-tune [path]')!('/repo', {});
    await actions.get('llm-tune [path]')!('/repo', { tier: 'chat', concurrency: '4' });

    expect(Array.from(actions.keys()).sort()).toEqual(['llm-apply', 'llm-plan [path]', 'llm-tune [path]']);
    expect(stdout.join('')).toContain('Recommended preset: install-ollama');
    expect(stdout.join('')).toContain(`- Ollama at ${TEST_ENDPOINT} (1 model)`);
    expect(stdout.join('')).toContain('- install-ollama — Ollama local');
    expect(stdout.join('')).toContain('Detected: 8-core test host');
    expect(calls).toContain('success:Applied preset install-ollama: /repo/.cartograph/config.json');
    expect(calls).toContain('apply:{"projectRoot":"/repo","preset":"install-ollama"}');
    expect(calls).toContain('tune:{"projectRoot":"/repo","tier":"chat","concurrency":4}');
    expect(calls).toContain('info:llm.summarizeLlm.concurrency: 2 → 4');
  });

  it('reports llm-plan failures without calling process.exit', async () => {
    const { actions, calls } = registerTestCommands({ planError: new Error('plan boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('llm-plan [path]')!('/repo');
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('plan:{"projectPath":"/repo"}');
    expect(calls).toContain('error:llm-plan failed: plan boom');
  });

  it('reports llm-apply failures without calling process.exit', async () => {
    const { actions, calls } = registerTestCommands({ applyError: new Error('apply boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('llm-apply')!({ preset: 'install-ollama', projectPath: '/repo' });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('apply:{"projectRoot":"/repo","preset":"install-ollama"}');
    expect(calls).toContain('error:llm-apply failed: apply boom');
  });

  it('reports invalid llm-tune overrides without calling process.exit or writing config', async () => {
    const { actions, calls } = registerTestCommands();

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('llm-tune [path]')!('/repo', { tier: 'bad', concurrency: '4' });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('error:--tier must be one of embed, chat, ask, reranker');
    expect(calls.some((call) => call.startsWith('tune:'))).toBe(false);
  });

  it('reports llm-tune write failures without calling process.exit', async () => {
    const { actions, calls } = registerTestCommands({ tuneError: new Error('tune boom') });

    const exitCode = await withProcessExitGuard(async () => {
      await actions.get('llm-tune [path]')!('/repo', { tier: 'chat', concurrency: '4' });
    });

    expect(exitCode).toBe(1);
    expect(calls).toContain('tune:{"projectRoot":"/repo","tier":"chat","concurrency":4}');
    expect(calls).toContain('error:llm-tune failed: tune boom');
  });
});

interface RegisterTestCommandOptions {
  planError?: Error;
  applyError?: Error;
  tuneError?: Error;
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

function registerTestCommands(options: RegisterTestCommandOptions = {}) {
  const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
  const calls: string[] = [];
  const stdout: string[] = [];

  registerAdminLlmSetupCommands({
    adminCmd: new FakeCommand(actions),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    writeStdout: (message) => stdout.push(message),
    success: (message) => calls.push(`success:${message}`),
    info: (message) => calls.push(`info:${message}`),
    error: (message) => calls.push(`error:${message}`),
    loadLlmSetupPlan: async () => ({
      planLlmSetup: async (opts) => {
        calls.push(`plan:${JSON.stringify(opts)}`);
        if (options.planError) throw options.planError;
        return {
          recommendedPresetId: 'install-ollama',
          detectedBackends: [{ label: 'Ollama', endpoint: TEST_ENDPOINT, models: ['qwen'] }],
          presets: [{ id: 'install-ollama', summary: 'Ollama local' }],
          localBackends: { configured: 0, notRunning: [], llamaServerOnPath: false, startCommand: null },
        };
      },
      applyLlmSetupChoice: async (opts) => {
        calls.push(`apply:${JSON.stringify(opts)}`);
        if (options.applyError) throw options.applyError;
        return {
          applied: true,
          preset: 'install-ollama',
          configPath: '/repo/.cartograph/config.json',
          backupPath: '/repo/.cartograph/config.json.bak',
          notes: ['configured'],
          nextSteps: ['ollama serve'],
        };
      },
      writeLlmTierConcurrencyOverride: async (opts) => {
        calls.push(`tune:${JSON.stringify(opts)}`);
        if (options.tuneError) throw options.tuneError;
        return {
          configPath: '/repo/.cartograph/config.json',
          backupPath: '/repo/.cartograph/config.json.bak',
          configKey: 'summarizeLlm',
          previous: 2,
          concurrency: opts.concurrency,
        };
      },
    }),
    loadHardwareTuning: async () => ({
      describeHardware: () => '8-core test host',
      recommendedTuning: () => ({
        embed: { cartographConcurrency: 2 },
        chat: { cartographConcurrency: 1 },
        ask: { cartographConcurrency: 1 },
        reranker: { cartographConcurrency: 1 },
      }),
    }),
  });

  return { actions, calls, stdout };
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

  requiredOption(): this {
    return this;
  }

  action(fn: (...args: unknown[]) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
