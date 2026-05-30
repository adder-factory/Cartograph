/**
 * F#75 — `defineQuery` registry side-effect.
 *
 * Pins the contract that the bench script `bench/probe-explain-query-plan.mts`
 * depends on: every `defineQuery(...)` call across the codebase
 * appends one record to `getDefinedQueryRegistry()` at module-load
 * time. The bench iterates that registry — a future refactor that
 * removes the side-effect would silently break the EQP audit by
 * shrinking the result list, so this test fails loudly in that case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { defineQuery, getDefinedQueryRegistry } from '../src/db/typed-query.js';

// The registry side-effect is env-gated so the production hot path
// + the parallel test runner don't pay the per-call stack-trace
// cost. Tests that exercise the registry must flip the gate on
// before the `defineQuery` calls they care about.
let priorRegistryEnv: string | undefined;
beforeAll(() => {
  priorRegistryEnv = process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'];
  process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] = '1';
});
afterAll(() => {
  if (priorRegistryEnv === undefined) {
    delete process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'];
  } else {
    process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] = priorRegistryEnv;
  }
});

describe('F#75 defineQuery registry', () => {
  it('captures the SQL of every defineQuery call', () => {
    const before = getDefinedQueryRegistry().length;
    defineQuery({
      sql: 'SELECT 1 AS one',
      params: z.object({}),
      row: z.object({ one: z.number() }),
    });
    const after = getDefinedQueryRegistry();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.sql).toBe('SELECT 1 AS one');
  });

  it('captures the caller source as `src/...:<line>` when invoked from /src/', () => {
    // This test file lives in __tests__/, NOT under /src/. The
    // caller-source capture falls back to the basename of this file
    // in that case. The contract is: source is non-empty and points
    // to a file the operator can grep for.
    defineQuery({
      sql: 'SELECT 2 AS two',
      params: z.object({}),
      row: z.object({ two: z.number() }),
    });
    const last = getDefinedQueryRegistry().at(-1)!;
    expect(last.source.length).toBeGreaterThan(0);
    expect(last.source).not.toBe('<unknown>');
    // Either `__tests__/<file>.ts:<line>` shape OR the test runner
    // reports a different absolute path; just assert a colon-line
    // suffix and a `.ts` extension to keep the test robust against
    // runner-specific paths.
    expect(last.source).toMatch(/\.ts:\d+$/);
  });

  it('preserves insertion order — the most recent call lives at the end of the array', () => {
    const before = getDefinedQueryRegistry().length;
    defineQuery({
      sql: 'SELECT 3 AS three',
      params: z.object({}),
      row: z.object({ three: z.number() }),
    });
    defineQuery({
      sql: 'SELECT 4 AS four',
      params: z.object({}),
      row: z.object({ four: z.number() }),
    });
    const after = getDefinedQueryRegistry();
    expect(after.length).toBe(before + 2);
    expect(after[after.length - 2]!.sql).toBe('SELECT 3 AS three');
    expect(after[after.length - 1]!.sql).toBe('SELECT 4 AS four');
  });

  it('captures multi-line SQL template literals verbatim', () => {
    // Many queries-*.ts files use backtick template-literal SQL with
    // embedded newlines (CLAUDE.md "JSON columns" + "Dynamic SQL"
    // sections). The registry must store the SQL as-is so EXPLAIN
    // QUERY PLAN doesn\'t mis-parse stripped whitespace.
    const multiLineSql = `SELECT id, name
                          FROM nodes
                          WHERE kind = @kind
                          LIMIT @limit`;
    defineQuery({
      sql: multiLineSql,
      params: z.object({ kind: z.string(), limit: z.number() }),
      row: z.object({ id: z.string(), name: z.string() }),
    });
    const last = getDefinedQueryRegistry().at(-1)!;
    expect(last.sql).toBe(multiLineSql);
    // Sanity — embedded newlines preserved.
    expect(last.sql).toContain('\n');
  });
});
