import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPlaybookCommand } from '../src/features/playbook/index.js';

describe('playbook feature CLI', () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

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

  it('sets exitCode instead of calling process.exit when the MCP playbook tool returns an error', async () => {
    let action: (() => Promise<void>) | undefined;
    const calls: string[] = [];
    const stdout: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    });

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
            return { content: [{ text: 'playbook error' }], isError: true };
          }

          closeAll() {
            calls.push('closeAll');
          }
        },
      }),
    });

    expect(action).toBeDefined();
    await expect(action!()).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual(['playbook error']);
    expect(calls).toContain('closeAll');
  });
});
