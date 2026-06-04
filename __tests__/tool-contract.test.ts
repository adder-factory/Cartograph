/**
 * ToolContract pilot coverage.
 *
 * `cartograph_coverage` is the first generated command whose CLI
 * presentation metadata lives beside the MCP tool definition instead
 * of in `src/bin/commands/generated.ts`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { Command } from 'commander';
import { getToolModules } from '../src/mcp/tools/registry.js';
import { getToolContract } from '../src/mcp/tools/_tool-contract.js';
import { buildGeneratedCommand, type RunViaMcp } from '../src/bin/_command-generator.js';

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function coverageModule() {
  const mod = getToolModules().find((m) => m.definition.name === 'cartograph_coverage');
  if (!mod) throw new Error('cartograph_coverage module not registered');
  return mod;
}

function findTopLevelCommand(program: Command, name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`CLI command not registered: ${name}`);
  return cmd;
}

function runCliHelp(command: string): string {
  const repoRoot = path.join(__dirname, '..');
  return execFileSync('bun', [path.join(repoRoot, 'src/bin/cartograph.ts'), command, '--help'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

async function parse(cmd: Command, argv: string[]): Promise<void> {
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

describe('ToolContract pilot: cartograph_coverage', () => {
  it('keeps MCP schema and generated CLI metadata attached to the same registered module', () => {
    const mod = coverageModule();
    const contract = getToolContract(mod);

    expect(contract?.name).toBe('cartograph_coverage');
    expect(contract?.schema).toBeDefined();
    expect(contract?.cli?.positionalFields).toEqual(['symbol']);
    expect(contract?.cli?.negatableFields).toEqual(['includeTests']);
    expect(contract?.cli?.shortFlags).toEqual({ limit: '-l' });
    expect(contract?.cli?.flagDefaults).toEqual({ via: 'auto' });

    const props = mod.definition.inputSchema.properties;
    expect(props['mode']?.enum).toContain('ranked');
    expect(props['clear']?.default).toBe(false);
    expect(props['includeTests']?.description).toMatch(/Include test files/);
  });

  it('generates coverage CLI flags, defaults, and help snippets from the contract', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const cmd = findTopLevelCommand(cli.program, 'coverage');

    expect(cmd.usage()).toContain('[symbol]');

    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--mode');
    expect(longs).toContain('--via');
    expect(longs).toContain('--no-include-tests');
    expect(longs).toContain('--include-tests');

    expect(cmd.options.find((o) => o.long === '--limit')?.short).toBe('-l');
    expect(cmd.options.find((o) => o.long === '--via')?.defaultValue).toBe('auto');

    const help = runCliHelp('coverage');
    expect(help).toContain('Examples:');
    expect(help).toContain('cartograph coverage --mode ranked --max-pct 0.5 --min-centrality 0.0001');
    expect(help).toContain('Next steps:');
    expect(help).toContain('cartograph coverage --mode refresh');
  });

  it('normalizes contract CLI booleans, defaults, and explicit overrides before dispatch', async () => {
    const mod = coverageModule();
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(mod, run, getToolContract(mod)?.cli);

    await parse(cmd, ['MySymbol', '--no-include-tests', '--limit', '7']);
    expect(run).toHaveBeenCalledWith(
      'cartograph_coverage',
      { symbol: 'MySymbol', includeTests: false, limit: 7, via: 'auto' },
      undefined,
    );

    await parse(cmd, ['--via', 'rule']);
    expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ via: 'rule' });
  });

  it('rejects invalid enum values and unknown generated CLI options before dispatch', async () => {
    const mod = coverageModule();
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(mod, run, getToolContract(mod)?.cli);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    await parse(cmd, ['--via', 'sideways']);
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('--via');

    process.exitCode = 0;
    await expect(parse(cmd, ['--includeTest'])).rejects.toThrow(/unknown option/i);
  });
});
