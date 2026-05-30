/**
 * Unit tests for `ToolOutcome` — the typed `Result<Ok, Err>` handler
 * return (structural campaign P6).
 *
 * Two layers under test:
 *
 *   1. `_outcome.ts` itself — the `ok` / `err` constructors and the
 *      `outcomeToResult` adapter.
 *   2. the `defineTool` wrapper's P6 integration — a handler returning
 *      a `ToolOutcome` is mapped to a `ToolResult`; the `err` arm goes
 *      through `errorResult` (CLI exit 1); a legacy bare-`ToolResult`
 *      handler still passes through unchanged; and a `safeParse`
 *      failure is itself rendered as an error arm.
 *
 * THE GUARANTEE these tests pin: the ONLY way a `defineTool` handler
 * emits `isError: true` is the `err(...)` arm. The success arm is
 * `isError`-free by construction.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok, err, outcomeToResult, type ToolOutcome } from '../src/mcp/tools/_outcome.js';
import { defineTool } from '../src/mcp/tools/_define-tool.js';
import { textResult } from '../src/mcp/tools/shared.js';
import { errorResult } from '../src/mcp/tools/_error-result.js';
import type { ToolCtx } from '../src/mcp/tools/types.js';
import type { ToolResult } from '../src/mcp/tool-types.js';

/** A throwaway ctx — the test handlers below never touch it. */
const fakeCtx = {} as ToolCtx;

const textOf = (r: ToolResult): string => {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return r.content[0]!.text;
};

describe('ok / err constructors', () => {
  it('ok() builds the success arm carrying the ToolResult verbatim', () => {
    const tr = textResult('hello');
    const outcome = ok(tr);
    expect(outcome.ok).toBe(true);
    // Discriminated-union narrowing: the `ok` branch exposes `value`.
    if (outcome.ok) expect(outcome.value).toBe(tr);
  });

  it('err() builds the error arm carrying the message string', () => {
    const outcome = err('something broke');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('something broke');
  });
});

describe('outcomeToResult', () => {
  it('passes the success arm value straight through', () => {
    const tr = textResult('body text');
    const result = outcomeToResult(ok(tr), errorResult);
    expect(result).toBe(tr);
    expect(result.isError).toBeUndefined();
  });

  it('renders the error arm through the injected toError', () => {
    const result = outcomeToResult(err('boom'), errorResult);
    expect(result.isError).toBe(true);
    // errorResult prefixes `Error: ` — the adapter must not double it.
    expect(textOf(result)).toBe('Error: boom');
  });

  it('uses exactly the injected toError, not a hard-coded one', () => {
    // Proves `errorResult` is injected, not imported inside the module
    // — the seam that keeps `_outcome.ts` free of the shared.ts cycle.
    const customError = (m: string): ToolResult => ({
      content: [{ type: 'text', text: `CUSTOM:${m}` }],
      isError: true,
    });
    const result = outcomeToResult(err('x'), customError);
    expect(textOf(result)).toBe('CUSTOM:x');
  });
});

describe('defineTool — P6 outcome adapter', () => {
  it('maps an ok(...) handler return to the success ToolResult', async () => {
    const mod = defineTool({
      name: 'cartograph_fake_ok',
      description: 'a fake tool whose handler returns the ok arm',
      schema: z.object({ q: z.string().describe('query') }),
      handle: async (_ctx, args): Promise<ToolOutcome> => ok(textResult(`got:${args.q}`)),
    });
    const result = await mod.handle(fakeCtx, { q: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('got:hi');
  });

  it('maps an err(...) handler return to an isError:true ToolResult', async () => {
    const mod = defineTool({
      name: 'cartograph_fake_err',
      description: 'a fake tool whose handler returns the err arm',
      schema: z.object({ q: z.string().describe('query') }),
      handle: async (): Promise<ToolOutcome> => err('handler said no'),
    });
    const result = await mod.handle(fakeCtx, { q: 'hi' });
    // THE GUARANTEE: the err arm — and only the err arm — produces
    // isError:true. The handler never imported errorResult.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: handler said no');
  });

  it('passes a legacy bare-ToolResult handler return through unchanged', async () => {
    // The P6 wave converts handlers one file at a time — an
    // unconverted handler still returns a bare ToolResult and the
    // wrapper must not touch it.
    const mod = defineTool({
      name: 'cartograph_fake_legacy',
      description: 'a fake tool whose handler still returns a bare ToolResult',
      schema: z.object({ q: z.string().describe('query') }),
      handle: async (_ctx, args): Promise<ToolResult> => textResult(`legacy:${args.q}`),
    });
    const result = await mod.handle(fakeCtx, { q: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('legacy:hi');
  });

  it('passes a legacy bare error ToolResult through unchanged', async () => {
    const mod = defineTool({
      name: 'cartograph_fake_legacy_err',
      description: 'a fake tool whose handler returns a bare error ToolResult',
      schema: z.object({}),
      handle: async (): Promise<ToolResult> => errorResult('legacy error'),
    });
    const result = await mod.handle(fakeCtx, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: legacy error');
  });

  it('accepts a synchronous (non-Promise) outcome return', async () => {
    // `DefineToolSpec.handle` allows a sync return — a handler with no
    // await (e.g. playbook) can return a `ToolOutcome` directly.
    const mod = defineTool({
      name: 'cartograph_fake_sync',
      description: 'a fake tool whose handler returns a sync outcome',
      schema: z.object({}),
      handle: (): ToolOutcome => ok(textResult('sync ok')),
    });
    const result = await mod.handle(fakeCtx, {});
    expect(textOf(result)).toBe('sync ok');
  });

  it('renders a safeParse failure as an error ToolResult', async () => {
    // The schema-validation failure path is itself expressed as an
    // error arm and funnels through the same adapter.
    const mod = defineTool({
      name: 'cartograph_fake_validated',
      description: 'a fake tool with a required arg',
      schema: z.object({ required: z.string().describe('a required arg') }),
      handle: async (): Promise<ToolOutcome> => ok(textResult('unreachable')),
    });
    const result = await mod.handle(fakeCtx, {}); // missing `required`
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for `cartograph_fake_validated`');
    expect(textOf(result)).toContain('required');
  });
});

describe('isToolOutcome discrimination — boundary shapes', () => {
  // The discriminator keys off a boolean `ok` field. A ToolResult has
  // no such field, so these adversarial shapes must not be misread.
  it('a ToolResult-shaped success return is treated as a bare result', async () => {
    const mod = defineTool({
      name: 'cartograph_fake_disc',
      description: 'returns a plain content envelope',
      schema: z.object({}),
      // No `ok` field — must pass through as a bare ToolResult.
      handle: async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'plain' }] }),
    });
    const result = await mod.handle(fakeCtx, {});
    expect(textOf(result)).toBe('plain');
    expect(result.isError).toBeUndefined();
  });
});
