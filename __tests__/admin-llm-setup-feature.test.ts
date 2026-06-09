import { describe, expect, it } from 'vitest';
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
    const actions = new Map<string, (...args: any[]) => unknown>();
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
        planLlmSetup: async () => ({
          recommendedPresetId: 'install-ollama',
          detectedBackends: [{ label: 'Ollama', endpoint: TEST_ENDPOINT, models: ['qwen'] }],
          presets: [{ id: 'install-ollama', summary: 'Ollama local' }],
        }),
        applyLlmSetupChoice: async (opts) => {
          calls.push(`apply:${JSON.stringify(opts)}`);
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

    await actions.get('llm-plan')!();
    await actions.get('llm-apply')!({ preset: 'install-ollama', projectPath: '/repo' });
    await actions.get('llm-tune [path]')!('/repo', {});
    await actions.get('llm-tune [path]')!('/repo', { tier: 'chat', concurrency: '4' });

    expect(Array.from(actions.keys()).sort()).toEqual(['llm-apply', 'llm-plan', 'llm-tune [path]']);
    expect(stdout.join('')).toContain('Recommended preset: install-ollama');
    expect(stdout.join('')).toContain(`- Ollama at ${TEST_ENDPOINT} (1 model)`);
    expect(stdout.join('')).toContain('- install-ollama — Ollama local');
    expect(stdout.join('')).toContain('Detected: 8-core test host');
    expect(calls).toContain('success:Applied preset install-ollama: /repo/.cartograph/config.json');
    expect(calls).toContain('apply:{"projectRoot":"/repo","preset":"install-ollama"}');
    expect(calls).toContain('tune:{"projectRoot":"/repo","tier":"chat","concurrency":4}');
    expect(calls).toContain('info:llm.summarizeLlm.concurrency: 2 → 4');
  });
});

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (...args: any[]) => unknown>,
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

  action(fn: (...args: any[]) => unknown): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
