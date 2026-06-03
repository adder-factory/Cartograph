import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/mcp/tools/_define-tool.js';
import { normalizeArgs, normalizeToolArgs } from '../src/mcp/tools/_arg-normalizer.js';

const demoTool = defineTool({
  name: 'cartograph_arg_normalizer_demo',
  description: 'demo tool for shared arg normalization tests',
  schema: z.object({
    mode: z.enum(['ranked', 'symbol']).default('ranked').describe('Data-source axis.'),
    limit: z.number().int().min(1).max(10).default(5).describe('Maximum results.'),
    includeTests: z.boolean().optional().describe('Include test files.'),
  }),
  handle: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
});

describe('normalizeToolArgs', () => {
  it('validates MCP args, applies schema defaults, and reports unknown keys', () => {
    const result = normalizeToolArgs(demoTool, { limit: 3, includeTest: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({ mode: 'ranked', limit: 3 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('includeTest');
    expect(result.warnings[0]).toContain('includeTests');
  });

  it('returns the shared formatted validation error and no warnings on parse failure', () => {
    const result = normalizeToolArgs(demoTool, { mode: 'sideways', includeTest: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid args');
    expect(result.error).toContain('mode');
    expect(result.error).toContain('sideways');
    expect(result.warnings).toEqual([]);
    expect(result.zodError?.issues[0]?.path).toEqual(['mode']);
  });
});

describe('normalizeArgs', () => {
  it('supports the generated CLI coercion schema path', () => {
    const cliSchema = z.object({
      limit: z.coerce.number().int().min(1).max(10),
      includeTests: z.boolean().optional(),
      mode: z.enum(['ranked', 'symbol']).optional(),
    });

    const result = normalizeArgs({
      rawArgs: { limit: '7', includeTests: false, mode: 'symbol' },
      schema: cliSchema,
      warnUnknownArgs: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual({ limit: 7, includeTests: false, mode: 'symbol' });
  });

  it('can disable unknown-key warnings for callers that reject them earlier', () => {
    const result = normalizeArgs({
      rawArgs: { limit: 1, extra: true },
      schema: z.object({ limit: z.number() }),
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
      warnUnknownArgs: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([]);
  });
});
