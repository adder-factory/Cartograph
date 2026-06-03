/**
 * `buildGeneratedCommand` — the Zod-schema → commander `Command`
 * generator (structural campaign P8 infrastructure).
 *
 * Verifies the generated command's option surface, the CLI-input
 * coercion layer (`z.coerce` parse-then-validate), and the family
 * discriminator-as-positional path. The generator is the friction
 * category-3 fix: one schema drives both the MCP `inputSchema` and
 * the CLI option list, so they cannot drift.
 */
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/mcp/tools/_define-tool.js';
import { buildGeneratedCommand, buildCoercionSchema, type RunViaMcp } from '../src/bin/_command-generator.js';
import { zodSchemaToCliOptions } from '../src/mcp/tools/_zod-to-cli.js';

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

afterAll(() => {
  process.exitCode = 0;
});

/** A minimal flat-arg tool for option-surface tests. */
const flatTool = defineTool({
  name: 'cartograph_flat_demo',
  description: 'flat demo tool',
  schema: z.object({
    query: z.string().describe('the query'),
    limit: z.number().int().min(1).max(100).default(20).describe('row cap'),
    verbose: z.boolean().optional().describe('chatty'),
    projectPath: z.string().optional().describe('project path'),
  }),
  handle: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
});

/** A family tool — `action` enum discriminator. */
const familyTool = defineTool({
  name: 'cartograph_family_demo',
  description: 'family demo tool',
  schema: z.object({
    action: z.enum(['add', 'list', 'delete']).describe('what to do'),
    text: z.string().optional().describe('note body'),
    id: z.number().int().min(1).optional().describe('row id'),
    projectPath: z.string().optional().describe('project path'),
  }),
  handle: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
});

/** Parse a command in test mode (no process.exit on error). */
async function parse(cmd: ReturnType<typeof buildGeneratedCommand>, argv: string[]): Promise<void> {
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

describe('buildGeneratedCommand — option surface', () => {
  it('derives the command name from the tool name', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn());
    expect(cmd.name()).toBe('flat-demo');
  });

  it('registers a long option for every non-projectPath field', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn());
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--query');
    expect(longs).toContain('--limit');
    expect(longs).toContain('--verbose');
    // projectPath is special-cased to `-p, --project-path`.
    expect(longs).toContain('--project-path');
  });

  it('registers a boolean field as a value-less flag', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn());
    const verbose = cmd.options.find((o) => o.long === '--verbose');
    expect(verbose?.required).toBe(false);
    expect(verbose?.optional).toBe(false); // value-less, not optional-arg
  });

  it('throws for a non-Zod-backed (legacy) module', () => {
    const legacy = {
      definition: {
        name: 'cartograph_legacy',
        description: 'x',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      handle: async () => ({ content: [] }),
    };
    expect(() => buildGeneratedCommand(legacy, vi.fn())).toThrow(/not Zod-backed/);
  });
});

describe('buildGeneratedCommand — forwarding + coercion', () => {
  it('forwards parsed args and routes projectPath to the 3rd argument', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run);
    await parse(cmd, ['--query', 'hello', '--limit', '5', '--project-path', '/tmp/proj']);
    expect(run).toHaveBeenCalledWith('cartograph_flat_demo', { query: 'hello', limit: 5 }, '/tmp/proj');
  });

  it('coerces a numeric CLI string to a number', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run);
    await parse(cmd, ['--query', 'q', '--limit', '42']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ limit: 42 });
    expect(typeof (run.mock.calls[0]?.[1] as { limit: unknown }).limit).toBe('number');
  });

  it('rejects an out-of-range number with a non-zero exit code', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    // reportCoercionFailure writes directly to process.stderr.write (not
    // console.error) so it can render its red ✗ ANSI prefix without going
    // through console formatting. Spy on the actual sink the impl uses.
    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const prevExit = process.exitCode;
    const cmd = buildGeneratedCommand(flatTool, run);
    await parse(cmd, ['--query', 'q', '--limit', '999']); // max is 100
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join(' ')).toMatch(/limit/);
    process.exitCode = prevExit;
    stderrSpy.mockRestore();
  });

  it('rejects a non-numeric value for a number field', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const prevExit = process.exitCode;
    const cmd = buildGeneratedCommand(flatTool, run);
    await parse(cmd, ['--query', 'q', '--limit', 'abc']);
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
    stderrSpy.mockRestore();
  });
});

describe('buildGeneratedCommand — family discriminator as positional', () => {
  it('renders the discriminator as a positional argument', () => {
    const cmd = buildGeneratedCommand(familyTool, vi.fn(), { discriminatorAsPositional: true });
    expect(cmd.usage()).toContain('<action>');
    // `action` is NOT also an option.
    expect(cmd.options.map((o) => o.long)).not.toContain('--action');
  });

  it('forwards the positional discriminator value into args', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(familyTool, run, { discriminatorAsPositional: true });
    await parse(cmd, ['list', '--id', '7']);
    expect(run).toHaveBeenCalledWith('cartograph_family_demo', { action: 'list', id: 7 }, undefined);
  });

  it('validates an enum discriminator supplied as a positional before dispatch', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const cmd = buildGeneratedCommand(familyTool, run, { discriminatorAsPositional: true });
    await parse(cmd, ['sideways']);
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('--action');
  });

  it('renders the discriminator as a --flag when discriminatorAsPositional is off', () => {
    const cmd = buildGeneratedCommand(familyTool, vi.fn());
    expect(cmd.options.map((o) => o.long)).toContain('--action');
    expect(cmd.usage()).not.toContain('<action>');
  });
});

/** A tool exercising the P8-wave generator extensions. */
const wideTool = defineTool({
  name: 'cartograph_wide_demo',
  description: 'wide demo tool',
  schema: z.object({
    dirPath: z.string().optional().describe('a positional dir'),
    names: z.array(z.string()).optional().describe('variadic positional'),
    limit: z.number().int().min(1).max(100).default(20).describe('row cap'),
    compact: z.boolean().default(true).describe('compact rows (default on)'),
    includeTests: z.boolean().optional().describe('include test files'),
    verbose: z.boolean().default(false).describe('chatty (default off)'),
    projectPath: z.string().optional().describe('project path'),
  }),
  handle: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
});

describe('buildGeneratedCommand — short-flag aliases', () => {
  it('registers a short alias alongside the long flag', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn(), { shortFlags: { limit: '-l' } });
    const limit = cmd.options.find((o) => o.long === '--limit');
    expect(limit?.short).toBe('-l');
  });

  it('parses a value passed via the short alias', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run, { shortFlags: { limit: '-l' } });
    await parse(cmd, ['--query', 'q', '-l', '7']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ limit: 7 });
  });
});

describe('buildGeneratedCommand — non-discriminator positionals', () => {
  it('renders an optional scalar field as a [positional]', () => {
    const cmd = buildGeneratedCommand(wideTool, vi.fn(), { positionalFields: ['dirPath'] });
    expect(cmd.usage()).toContain('[dirPath]');
    expect(cmd.options.map((o) => o.long)).not.toContain('--dir-path');
  });

  it('renders a string-list field as a variadic [positional...]', () => {
    const cmd = buildGeneratedCommand(wideTool, vi.fn(), { positionalFields: ['names'] });
    expect(cmd.usage()).toContain('[names...]');
  });

  it('forwards positional values into args by declared order', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run, { positionalFields: ['dirPath'] });
    await parse(cmd, ['src/sync', '--limit', '5']);
    expect(run).toHaveBeenCalledWith('cartograph_wide_demo', { dirPath: 'src/sync', limit: 5 }, undefined);
  });

  it('forwards a variadic positional as a collected array', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run, { positionalFields: ['names'] });
    await parse(cmd, ['a', 'b', 'c']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ names: ['a', 'b', 'c'] });
  });

  it('omits an unset optional positional from args', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run, { positionalFields: ['dirPath'] });
    await parse(cmd, ['--limit', '9']);
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('dirPath');
  });

  it('throws for a positionalFields entry with no matching schema field', () => {
    expect(() => buildGeneratedCommand(wideTool, vi.fn(), { positionalFields: ['nope'] })).toThrow(/no field `nope`/);
  });
});

describe('buildGeneratedCommand — joined variadic positional', () => {
  it('renders a required string field as a variadic <positional...>', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn(), { joinedVariadicPositional: 'query' });
    expect(cmd.usage()).toContain('<query...>');
    // The field is rendered as a positional, not a --query option.
    expect(cmd.options.map((o) => o.long)).not.toContain('--query');
  });

  it('renders an optional string field as a variadic [positional...]', () => {
    const cmd = buildGeneratedCommand(wideTool, vi.fn(), { joinedVariadicPositional: 'dirPath' });
    expect(cmd.usage()).toContain('[dirPath...]');
  });

  it('joins the collected tokens with a space into one forwarded string', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run, { joinedVariadicPositional: 'query' });
    await parse(cmd, ['Auth', 'login', 'session', '--limit', '5']);
    expect(run).toHaveBeenCalledWith('cartograph_flat_demo', { query: 'Auth login session', limit: 5 }, undefined);
  });

  it('throws for a non-string field', () => {
    expect(() => buildGeneratedCommand(wideTool, vi.fn(), { joinedVariadicPositional: 'names' })).toThrow(
      /only a plain string field/,
    );
  });

  it('throws for a field name with no matching schema field', () => {
    expect(() => buildGeneratedCommand(flatTool, vi.fn(), { joinedVariadicPositional: 'nope' })).toThrow(
      /no field `nope`/,
    );
  });
});

describe('buildGeneratedCommand — negatable booleans', () => {
  it('registers a default-true boolean as the --no- form', () => {
    const cmd = buildGeneratedCommand(wideTool, vi.fn());
    const longs = cmd.options.map((o) => o.long);
    // `compact` defaults true → negatable: `--no-compact`.
    expect(longs).toContain('--no-compact');
    // `verbose` defaults false → plain opt-in.
    expect(longs).toContain('--verbose');
  });

  it('does not forward a negatable boolean when the user passes nothing', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run);
    await parse(cmd, ['--limit', '5']);
    // `compact` left to the schema default — NOT forwarded.
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('compact');
  });

  it('forwards compact:false when --no-compact is passed', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run);
    await parse(cmd, ['--no-compact']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ compact: false });
  });

  it('forwards compact:true when the positive --compact is passed', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run);
    await parse(cmd, ['--compact']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ compact: true });
  });

  it('can force an optional boolean to expose a --no- flag', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run, { negatableFields: ['includeTests'] });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--no-include-tests');
    await parse(cmd, ['--no-include-tests']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ includeTests: false });
  });

  it('describes --no flags as setting the field false', () => {
    const cmd = buildGeneratedCommand(wideTool, vi.fn());
    const noCompact = cmd.options.find((o) => o.long === '--no-compact');
    const compact = cmd.options.find((o) => o.long === '--compact');
    expect(noCompact?.description).toBe('Set compact to false.');
    expect(compact?.description).toBe('compact rows (default on)');
  });

  it('rejects boolean-looking values swallowed as optional positionals', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const cmd = buildGeneratedCommand(wideTool, run, {
      positionalFields: ['dirPath'],
      negatableFields: ['includeTests'],
    });
    await parse(cmd, ['--include-tests', 'false']);
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('Boolean CLI flags are value-less');
  });

  it('allows boolean-looking optional positionals when no boolean flag was passed', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(wideTool, run, {
      positionalFields: ['dirPath'],
      negatableFields: ['includeTests'],
    });
    await parse(cmd, ['false']);
    expect(run).toHaveBeenCalledWith('cartograph_wide_demo', { dirPath: 'false', limit: 20 }, undefined);
  });
});

describe('buildGeneratedCommand — flagDefaults', () => {
  it('registers a CLI-side default for a field whose schema has none', () => {
    // `flatTool.query` is a bare required string — no Zod `.default()`.
    const cmd = buildGeneratedCommand(flatTool, vi.fn(), { flagDefaults: { query: 'all' } });
    const opt = cmd.options.find((o) => o.long === '--query');
    expect(opt?.defaultValue).toBe('all');
  });

  it('forwards the CLI default when the flag is omitted', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run, { flagDefaults: { query: 'all' } });
    await parse(cmd, ['--limit', '5']);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ query: 'all', limit: 5 });
  });

  it('throws for a flagDefaults entry with no matching schema field', () => {
    expect(() => buildGeneratedCommand(flatTool, vi.fn(), { flagDefaults: { nope: 'x' } })).toThrow(
      /flagDefaults entry `nope`/,
    );
  });
});

describe('buildGeneratedCommand — longFlagOverrides', () => {
  it('registers the field under the overridden long flag', () => {
    const cmd = buildGeneratedCommand(flatTool, vi.fn(), { longFlagOverrides: { limit: '--max-rows' } });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--max-rows');
    expect(longs).not.toContain('--limit');
  });

  it('forwards the overridden-flag value under the schema field name', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const cmd = buildGeneratedCommand(flatTool, run, { longFlagOverrides: { limit: '--max-rows' } });
    await parse(cmd, ['--query', 'q', '--max-rows', '7']);
    // Commander stores it as `maxRows`; it is forwarded under `limit`.
    expect(run.mock.calls[0]?.[1]).toMatchObject({ query: 'q', limit: 7 });
  });

  it('throws for a longFlagOverrides entry with no matching schema field', () => {
    expect(() => buildGeneratedCommand(flatTool, vi.fn(), { longFlagOverrides: { nope: '--x' } })).toThrow(
      /longFlagOverrides entry `nope`/,
    );
  });
});

describe('buildGeneratedCommand — alias flag normalization', () => {
  it('validates an alias flag targeting a positional field before dispatch', async () => {
    const run = vi.fn<RunViaMcp>().mockResolvedValue();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    const cmd = buildGeneratedCommand(familyTool, run, {
      discriminatorAsPositional: true,
      aliasFlags: { action: 'action' },
    });

    await parse(cmd, ['--action', 'sideways']);

    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('--action');
  });
});

describe('buildCoercionSchema', () => {
  it('builds a z.coerce schema that parses-then-validates a number', () => {
    const specs = zodSchemaToCliOptions(z.object({ n: z.number().int().min(1).max(10) }));
    const schema = buildCoercionSchema(specs);
    expect(schema.safeParse({ n: '5' }).success).toBe(true);
    expect(schema.parse({ n: '5' })).toEqual({ n: 5 });
    expect(schema.safeParse({ n: '99' }).success).toBe(false); // over max
    expect(schema.safeParse({ n: 'x' }).success).toBe(false); // non-numeric
  });

  it('drops an unset optional field rather than failing', () => {
    const specs = zodSchemaToCliOptions(z.object({ opt: z.string().optional() }));
    const schema = buildCoercionSchema(specs);
    expect(schema.parse({})).toEqual({});
  });

  it('validates an enum choice', () => {
    const specs = zodSchemaToCliOptions(z.object({ m: z.enum(['a', 'b']) }));
    const schema = buildCoercionSchema(specs);
    expect(schema.safeParse({ m: 'a' }).success).toBe(true);
    expect(schema.safeParse({ m: 'z' }).success).toBe(false);
  });
});
