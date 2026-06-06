import { describe, expect, it } from 'vitest';
import { registerPlaybookCommand } from '../src/features/playbook/index.js';

describe('playbook feature CLI', () => {
  it('executes the MCP playbook tool and closes the handler', async () => {
    let action: (() => Promise<void>) | undefined;
    const calls: string[] = [];
    const stdout: string[] = [];

    registerPlaybookCommand({
      program: {
        command(name: string) {
          calls.push(`command:${name}`);
          return this;
        },
        description(text: string) {
          calls.push(`description:${text}`);
          return this;
        },
        action(fn: () => Promise<void>) {
          action = fn;
          return this;
        },
      },
      writeStdout: (message = '') => stdout.push(message),
      loadToolHandler: async () => ({
        ToolHandler: class {
          async execute(tool: string, args: Record<string, unknown>) {
            calls.push(`execute:${tool}:${JSON.stringify(args)}`);
            return { content: [{ text: 'playbook body' }], isError: false };
          }

          closeAll() {
            calls.push('closeAll');
          }
        },
      }),
    });

    expect(action).toBeDefined();
    await action!();

    expect(calls).toEqual([
      'command:playbook',
      'description:Print the cartograph tool playbook (mirrors cartograph_playbook MCP tool)',
      'execute:cartograph_playbook:{}',
      'closeAll',
    ]);
    expect(stdout).toEqual(['playbook body']);
  });
});
