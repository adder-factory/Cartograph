/**
 * Regression test for the consumed-args runtime tracker (structural
 * fix E). The tracker runs in fail-open mode by default — it logs
 * a warning when a handler ignores a user-provided field. This test
 * flips the strict env var so the same condition THROWS, and uses it
 * to lock down two invariants:
 *
 *   1. A handler that ignores a real user-provided field surfaces the
 *      unread field via a thrown error in strict mode (so a future
 *      regression of the env-refs / sql-refs `includeTests` bug —
 *      Friction #12 — gets caught in CI when strict mode is on).
 *   2. A handler that reads every provided field passes cleanly. This
 *      verifies the tracker isn't a perpetual fail-closed annoyance —
 *      the smoke-test suite is correct when handlers thread their args.
 *
 * Strict mode is opt-in (env var) precisely because the smoke-test
 * framework passes every default value, and action-discriminated
 * tools (cartograph_admin / cartograph_coverage) legitimately ignore
 * the fields that don't apply to the picked action. The warning-only
 * default surfaces the data without breaking those.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/mcp/tools/_define-tool.js';
import { ok } from '../src/mcp/tools/_outcome.js';
import { textResult } from '../src/mcp/tools/shared.js';
import type { ToolCtx } from '../src/mcp/tools/types.js';

const STRICT_ENV = 'CARTOGRAPH_STRICT_UNREAD_ARGS';
const TRACKER_ENV = 'CARTOGRAPH_TRACK_CONSUMED_ARGS';

describe('consumed-args runtime tracker (structural fix E)', () => {
  let originalStrict: string | undefined;
  let originalTracker: string | undefined;

  beforeEach(() => {
    originalStrict = process.env[STRICT_ENV];
    originalTracker = process.env[TRACKER_ENV];
    // The tracker is gated on CARTOGRAPH_TRACK_CONSUMED_ARGS — set by
    // the `test:fast` npm script's outer wrapper but NOT when this
    // file runs under raw `bun test` (the bun:test migration moved
    // the env vars out of the deleted vitest.config.ts into the
    // scripts). Setting it here makes the test invocation-agnostic so
    // `bun test __tests__/consumed-args-tracker.test.ts` passes the
    // same as the sharded suite.
    process.env[TRACKER_ENV] = '1';
  });

  afterEach(() => {
    if (originalStrict === undefined) delete process.env[STRICT_ENV];
    else process.env[STRICT_ENV] = originalStrict;
    if (originalTracker === undefined) delete process.env[TRACKER_ENV];
    else process.env[TRACKER_ENV] = originalTracker;
  });

  it('strict mode throws when a handler ignores a user-provided field', async () => {
    process.env[STRICT_ENV] = '1';
    // Handler reads `query` but ignores `extra` — exactly the shape
    // of the env-refs / sql-refs `includeTests`-when-key-passed bug.
    const tool = defineTool({
      name: 'cartograph_test_unread',
      description: 'Synthetic tool whose handler ignores `extra` to exercise the tracker.',
      schema: z.object({
        query: z.string().describe('query string'),
        extra: z.string().optional().describe('a parameter the handler will ignore'),
      }),
      handle: async (_ctx, args) => ok(textResult(`read query=${args.query}`)),
    });
    const ctx = {} as ToolCtx;
    // Strict mode throws synchronously inside `handle`. The dispatch
    // chokepoint in `_define-tool` runs `assertEveryProvidedArgWasRead`
    // AFTER the user's handler returns but BEFORE the result is
    // adapted, so the throw escapes `tool.handle` itself.
    await expect(tool.handle(ctx, { query: 'foo', extra: 'should-be-read' })).rejects.toThrow(
      /never read provided arg\(s\): extra/,
    );
  });

  it('strict mode lets a handler that reads every provided field through', async () => {
    process.env[STRICT_ENV] = '1';
    const tool = defineTool({
      name: 'cartograph_test_complete',
      description: 'Synthetic tool whose handler reads every field.',
      schema: z.object({
        query: z.string().describe('query string'),
        extra: z.string().optional().describe('a parameter the handler WILL read'),
      }),
      handle: async (_ctx, args) => ok(textResult(`query=${args.query} extra=${args.extra ?? '∅'}`)),
    });
    const ctx = {} as ToolCtx;
    const result = await tool.handle(ctx, { query: 'foo', extra: 'bar' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('query=foo extra=bar');
  });

  it('does not flag omitted optional fields', async () => {
    process.env[STRICT_ENV] = '1';
    const tool = defineTool({
      name: 'cartograph_test_omitted',
      description: 'Synthetic tool — only one field is required and read.',
      schema: z.object({
        query: z.string().describe('query string'),
        optional: z.string().optional().describe('omitted by the caller'),
      }),
      handle: async (_ctx, args) => ok(textResult(`query=${args.query}`)),
    });
    const ctx = {} as ToolCtx;
    // `optional` not present in rawArgs — must not flag.
    const result = await tool.handle(ctx, { query: 'foo' });
    expect(result.isError).toBeFalsy();
  });

  it('warning mode (default) does not break execution when a field is ignored', async () => {
    // Default mode — no STRICT env var. The tracker still runs (VITEST
    // env is set) and emits to stderr, but the handler returns
    // successfully.
    delete process.env[STRICT_ENV];
    const tool = defineTool({
      name: 'cartograph_test_warn_only',
      description: 'Synthetic tool — handler ignores a field; tracker warns.',
      schema: z.object({
        query: z.string().describe('query string'),
        ignored: z.string().optional().describe('handler will not read'),
      }),
      handle: async (_ctx, args) => ok(textResult(`query=${args.query}`)),
    });
    const ctx = {} as ToolCtx;
    const result = await tool.handle(ctx, { query: 'foo', ignored: 'bar' });
    // Default fail-open: handler succeeds (warning goes to stderr).
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('query=foo');
  });
});
