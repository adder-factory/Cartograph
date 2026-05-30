/**
 * `defineTool` — the Zod-backed `ToolModule` factory (structural
 * campaign P3 infrastructure).
 *
 * Locks: JSON-Schema generation shape, the parsed-args handler
 * contract, reject-out-of-range numeric policy, error formatting, and
 * the `getZodSchema` discriminator that lets Zod / legacy modules
 * coexist.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  getZodSchema,
  reattachZodSchema,
  toJsonSchema,
  formatZodError,
} from '../src/mcp/tools/_define-tool.js';
import type { ToolCtx } from '../src/mcp/tools/types.js';
import type { ToolModule } from '../src/mcp/tools/types.js';

/** A throwaway ctx — the test handlers below never touch it. */
const fakeCtx = {} as ToolCtx;

describe('toJsonSchema', () => {
  it('produces an object-root JSON Schema with properties + required', () => {
    const js = toJsonSchema(
      z.object({
        name: z.string().describe('the name'),
        count: z.number().int().min(1).max(5).optional(),
      }),
    );
    expect(js.type).toBe('object');
    expect(js.properties).toHaveProperty('name');
    expect(js.properties).toHaveProperty('count');
    expect(js.required).toEqual(['name']);
  });

  it('strips $schema and additionalProperties', () => {
    const js = toJsonSchema(z.object({ x: z.string() })) as Record<string, unknown>;
    expect(js['$schema']).toBeUndefined();
    expect(js['additionalProperties']).toBeUndefined();
  });

  it('carries .describe() text into property descriptions', () => {
    const js = toJsonSchema(z.object({ x: z.string().describe('hello') }));
    expect(js.properties['x']?.description).toBe('hello');
  });

  it('omits required[] entirely when every field is optional', () => {
    const js = toJsonSchema(z.object({ a: z.string().optional(), b: z.number().optional() }));
    expect(js.required).toBeUndefined();
  });
});

describe('defineTool — module shape', () => {
  const mod = defineTool({
    name: 'cartograph_fake',
    description: 'a fake tool for testing the defineTool factory',
    schema: z.object({ q: z.string().describe('query') }),
    handle: async (_ctx, args) => ({ content: [{ type: 'text', text: `got:${args.q}` }] }),
  });

  it('produces a ToolModule with definition + handle', () => {
    expect(mod.definition.name).toBe('cartograph_fake');
    expect(typeof mod.handle).toBe('function');
    expect(mod.definition.inputSchema.type).toBe('object');
  });

  it('getZodSchema returns the schema for a Zod module', () => {
    expect(getZodSchema(mod)).toBeDefined();
    expect(typeof getZodSchema(mod)!.safeParse).toBe('function');
  });

  it('getZodSchema returns undefined for a legacy module', () => {
    const legacy: ToolModule = {
      definition: { name: 'cartograph_legacy', description: 'x', inputSchema: { type: 'object', properties: {} } },
      handle: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    expect(getZodSchema(legacy)).toBeUndefined();
    expect(getZodSchema(undefined)).toBeUndefined();
  });

  it('the __zodSchema marker is non-enumerable', () => {
    // The registry's `withAllowStale` spreads the module; a
    // non-enumerable marker keeps the spread clean.
    expect(Object.keys(mod)).not.toContain('__zodSchema');
  });

  it('survives the withAllowStale spread+reattach roundtrip', () => {
    // The critical invariant for every P4 migration that does NOT set
    // bypassFreshnessGate: `registry.ts`'s `withAllowStale` does
    // `{ ...mod }`, which drops the non-enumerable marker — so a naked
    // spread loses it, and `reattachZodSchema` must restore it or the
    // dispatcher silently falls through to the legacy validator.
    const sourceSchema = getZodSchema(mod);
    expect(sourceSchema).toBeDefined();

    const nakedClone = { ...mod };
    expect(getZodSchema(nakedClone)).toBeUndefined(); // spread drops it

    const reattached = reattachZodSchema({ ...mod }, sourceSchema);
    expect(getZodSchema(reattached)).toBe(sourceSchema);
    expect(Object.keys(reattached)).not.toContain('__zodSchema');
  });

  it('passes the spec flags through to the module', () => {
    const m = defineTool({
      name: 'cartograph_fake2',
      description: 'another fake tool for flag-passthrough testing',
      schema: z.object({}),
      handle: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      bypassFreshnessGate: true,
      isWriteTool: true,
    });
    expect(m.bypassFreshnessGate).toBe(true);
    expect(m.isWriteTool).toBe(true);
  });
});

describe('defineTool — write-time schema-shape validation', () => {
  // These tests lock in the two write-time guards added to defineTool.
  // If a later refactor removes either check, these tests fail loudly —
  // the guards exist precisely to surface authoring footguns at
  // module-load instead of at first call.

  const noopHandle = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: '' }] });

  it('rejects a tool with an empty top-level description', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeNoToolDoc',
        description: '',
        schema: z.object({ q: z.string().describe('query') }),
        handle: noopHandle,
      }),
    ).toThrow(/missing a non-empty top-level description/);
  });

  it('rejects a tool whose top-level description is whitespace-only', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeWhitespaceToolDoc',
        description: '   \t  ',
        schema: z.object({ q: z.string().describe('query') }),
        handle: noopHandle,
      }),
    ).toThrow(/missing a non-empty top-level description/);
  });

  it('rejects a non-camelCase top-level field name', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeBadCase',
        description: 'fake tool — capitalised arg name should fail at definition time',
        schema: z.object({ MaxNodes: z.number().describe('mis-cased') }),
        handle: noopHandle,
      }),
    ).toThrow(/non-camelCase field name\(s\): MaxNodes/);
  });

  it('rejects a top-level field with no .describe()', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeUndocumented',
        description: 'fake tool — missing field description should fail at definition time',
        schema: z.object({ depth: z.number() }),
        handle: noopHandle,
      }),
    ).toThrow(/missing or empty \.describe\(\) on field\(s\): depth/);
  });

  it('rejects a field whose .describe() is whitespace-only', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeWhitespaceDoc',
        description: 'fake tool — whitespace-only description should also fail',
        schema: z.object({ name: z.string().describe('   ') }),
        handle: noopHandle,
      }),
    ).toThrow(/missing or empty \.describe\(\)/);
  });

  it('accepts a well-formed schema (camelCase + described)', () => {
    expect(() =>
      defineTool({
        name: 'cartograph_fakeOk',
        description: 'fake tool — both fields camelCase and described',
        schema: z.object({
          maxNodes: z.number().describe('cap'),
          verbose: z.boolean().optional().describe('flag'),
        }),
        handle: noopHandle,
      }),
    ).not.toThrow();
  });
});

describe('defineTool — handler receives parsed, typed args', () => {
  it('applies defaults before the handler runs', async () => {
    const mod = defineTool({
      name: 'cartograph_fake3',
      description: 'fake tool exercising default application',
      schema: z.object({ depth: z.number().int().default(4).describe('recursion depth') }),
      handle: async (_ctx, args) => ({ content: [{ type: 'text', text: `depth=${args.depth}` }] }),
    });
    const result = await mod.handle(fakeCtx, {});
    expect(result.content[0]?.text).toBe('depth=4');
  });

  it('the handler-level safeParse rejects bad args with a formatted error', async () => {
    const mod = defineTool({
      name: 'cartograph_fake4',
      description: 'fake tool exercising the handler-level reparse guard',
      schema: z.object({ q: z.string().describe('query string') }),
      handle: async (_ctx, args) => ({ content: [{ type: 'text', text: args.q }] }),
    });
    // `runHandler`-style direct call with a missing required arg.
    const result = await mod.handle(fakeCtx, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Invalid arguments/);
    expect(result.content[0]?.text).toMatch(/q: required/);
  });
});

describe('formatZodError — readable single-line messages', () => {
  function errFor<S extends z.ZodTypeAny>(schema: S, value: unknown): string {
    const parsed = schema.safeParse(value);
    if (parsed.success) throw new Error('expected a parse failure');
    // Pass the raw value as the dispatcher does — Zod 4 issues no
    // longer carry the received value, so `formatZodError` resolves it
    // from the args to keep the `expected X, received Y` / `(got …)`
    // diagnostics.
    return formatZodError(parsed.error, value as Record<string, unknown>);
  }

  it('formats a missing required field as `field: required`', () => {
    expect(errFor(z.object({ q: z.string() }), {})).toBe('q: required');
  });

  it('formats a wrong type', () => {
    expect(errFor(z.object({ n: z.number() }), { n: 'x' })).toMatch(/n: expected number, received string/);
  });

  it('formats an over-maximum number (reject, not clamp)', () => {
    expect(errFor(z.object({ d: z.number().int().min(1).max(10) }), { d: 999 })).toBe('d: must be ≤ 10');
  });

  it('formats a sub-minimum number (reject, not clamp)', () => {
    expect(errFor(z.object({ d: z.number().int().min(1).max(10) }), { d: 0 })).toBe('d: must be ≥ 1');
  });

  it('formats a non-integer float on an .int() field', () => {
    const msg = errFor(z.object({ d: z.number().int() }), { d: 3.7 });
    expect(msg).toMatch(/^d: /);
    expect(msg.toLowerCase()).toMatch(/integer/);
  });

  it('formats an enum miss with the allowed values', () => {
    const msg = errFor(z.object({ m: z.enum(['a', 'b']) }), { m: 'z' });
    expect(msg).toMatch(/m: must be one of 'a', 'b'/);
  });

  it('joins multiple issues with a semicolon', () => {
    const msg = errFor(z.object({ a: z.string(), b: z.number() }), { b: 'x' });
    expect(msg).toContain('a: required');
    expect(msg).toContain('b: expected number');
    expect(msg).toContain('; ');
  });
});
