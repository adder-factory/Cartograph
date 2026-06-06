import { describe, expect, it } from 'vitest';
import { registerLlmSetupCommand } from '../src/features/llm-setup/index.js';

describe('llm setup feature CLI', () => {
  it('routes setup to the injected interactive setup runner', async () => {
    const actions = new Map<string, (pathArg?: string) => Promise<void>>();
    const calls: string[] = [];

    registerLlmSetupCommand({
      llmCmd: new FakeCommand(actions),
      loadLlmSetupCli: async () => ({
        runLlmSetupCli: async (pathArg) => calls.push(`setup:${pathArg ?? ''}`),
      }),
    });

    await actions.get('setup [path]')!('/repo');

    expect(calls).toEqual(['setup:/repo']);
  });
});

class FakeCommand {
  constructor(
    private readonly actions: Map<string, (pathArg?: string) => Promise<void>>,
    private readonly name = 'llm',
  ) {}

  command(name: string): FakeCommand {
    return new FakeCommand(this.actions, name);
  }

  description(): this {
    return this;
  }

  action(fn: (pathArg?: string) => Promise<void>): this {
    this.actions.set(this.name, fn);
    return this;
  }
}
