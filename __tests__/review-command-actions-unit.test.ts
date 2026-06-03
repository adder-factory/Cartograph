import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReviewCommands } from '../src/bin/commands/review.js';

const actions = new Map<string, (...args: any[]) => unknown>();
const calls: Array<{ tool: string; args: Record<string, unknown>; projectPath?: string }> = [];
const errors: string[] = [];

class FakeCommand {
  constructor(private readonly name = 'review') {}

  command(name: string): FakeCommand {
    return new FakeCommand(name);
  }

  description(): this {
    return this;
  }

  option(): this {
    return this;
  }

  action(fn: (...args: any[]) => unknown): this {
    actions.set(this.name, fn);
    return this;
  }
}

function loadReviewCommandActions(): void {
  actions.clear();
  calls.length = 0;
  errors.length = 0;
  process.exitCode = 0;
  registerReviewCommands({
    program: new FakeCommand('program'),
    reviewCmd: new FakeCommand('review'),
    error: vi.fn((message: string) => errors.push(message)),
    assignIntArg: vi.fn(({ args, key, raw }) => {
      if (raw !== undefined) args[key] = Number(raw);
      return true;
    }),
    assignFloatArg: vi.fn(({ args, key, raw }) => {
      if (raw !== undefined) args[key] = Number(raw);
      return true;
    }),
    runViaMCP: vi.fn(async (tool: string, args: Record<string, unknown>, projectPath?: string) => {
      calls.push({ tool, args, projectPath });
    }),
    installFamilyActionAlias: vi.fn(),
  });
}

describe('review command action bodies', () => {
  beforeEach(() => {
    loadReviewCommandActions();
  });

  it('routes review-family and similar actions through MCP payloads', async () => {
    await actions.get('context [diff-file]')!(undefined, {
      diff: '@@ -1 +1 @@\n-old\n+new',
      maxCallersPerSymbol: '2',
      maxCalleesPerSymbol: '3',
      maxCoChangeWarnings: '4',
      minCoChangeJaccard: '0.5',
      minDiffMagnitude: '6',
      projectPath: '/repo',
    });
    await actions.get('neighbors')!({
      files: 'src/a.ts, src/b.ts',
      symbols: 'alpha,beta',
      k: '7',
      dedupeByName: false,
      projectPath: '/repo',
    });
    await actions.get('risk')!({
      limit: '4',
      topN: '5',
      minCentrality: '0.25',
      coverageSource: 'unit',
      projectPath: '/repo',
    });
    await actions.get('agent-audit')!({
      perDetectorLimit: '8',
      minSeverity: 'warning',
      projectPath: '/repo',
    });
    await actions.get('trust')!({
      projectPath: '/repo',
    });
    await actions.get('similar <symbol>')!('alpha', {
      topK: '6',
      minScore: '0.72',
      sameLanguage: true,
      projectPath: '/repo',
    });

    expect(calls).toEqual([
      {
        tool: 'cartograph_review',
        projectPath: '/repo',
        args: {
          mode: 'context',
          diff: '@@ -1 +1 @@\n-old\n+new',
          maxCallersPerSymbol: 2,
          maxCalleesPerSymbol: 3,
          maxCoChangeWarnings: 4,
          minCoChangeJaccard: 0.5,
          minDiffMagnitude: 6,
        },
      },
      {
        tool: 'cartograph_review',
        projectPath: '/repo',
        args: {
          mode: 'neighbors',
          files: ['src/a.ts', 'src/b.ts'],
          symbols: ['alpha', 'beta'],
          k: 7,
          dedupeByName: false,
        },
      },
      {
        tool: 'cartograph_review',
        projectPath: '/repo',
        args: { mode: 'risk', limit: 4, topN: 5, minCentrality: 0.25, coverageSource: 'unit' },
      },
      {
        tool: 'cartograph_review',
        projectPath: '/repo',
        args: { mode: 'agent-audit', perDetectorLimit: 8, minSeverity: 'warning' },
      },
      {
        tool: 'cartograph_review',
        projectPath: '/repo',
        args: { mode: 'trust' },
      },
      {
        tool: 'cartograph_graph',
        projectPath: '/repo',
        args: { direction: 'similar', start: 'alpha', k: 6, minScore: 0.72, sameLanguage: true },
      },
    ]);
  });

  it('validates neighbors inputs and agent-audit severity before MCP dispatch', async () => {
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`exit:${process.exitCode}`);
    }) as typeof process.exit;
    try {
      await expect(actions.get('neighbors')!({})).rejects.toThrow('exit:1');
    } finally {
      process.exit = originalExit;
    }
    await actions.get('agent-audit')!({ minSeverity: 'critical' });

    expect(errors.join('\n')).toContain('Pass at least one --files or --symbols');
    expect(errors.join('\n')).toContain('--min-severity must be one of');
    expect(calls).toEqual([]);
    process.exitCode = 0;
  });
});
