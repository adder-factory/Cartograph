/**
 * Tests for `collectUnknownArgWarnings` — the dispatch-boundary scan
 * that nudges an agent when it passes a tool arg the schema doesn't
 * declare (Zod's `safeParse` strips such keys silently).
 *
 * Extracted from the retired `_schema-validate.ts` test suite: the
 * type / enum / required / nested-object cases that file also covered
 * are now Zod's job and exercised via `define-tool.test.ts` + the
 * per-tool family tests.
 */

import { describe, expect, it } from 'vitest';
import { collectUnknownArgWarnings } from '../src/mcp/tools/_unknown-arg-warnings.js';
import type { ToolDefinition } from '../src/mcp/tool-types.js';

function schema(s: ToolDefinition['inputSchema']): ToolDefinition['inputSchema'] {
  return s;
}

describe('collectUnknownArgWarnings', () => {
  it('emits no warnings when every arg is declared', () => {
    const w = collectUnknownArgWarnings(
      { mode: 'exact', query: 'foo' },
      schema({
        type: 'object',
        properties: { mode: { type: 'string' }, query: { type: 'string' } },
      }),
    );
    expect(w).toEqual([]);
  });

  it('emits no warnings for underscore-prefixed MCP metadata keys', () => {
    // MCP clients commonly add tracing keys; rejecting OR warning on
    // them would be noise. Only non-underscore unknown keys warn.
    const w = collectUnknownArgWarnings(
      { mode: 'exact', _trace_id: 'abc123', __progress_token: 42 },
      schema({ type: 'object', properties: { mode: { type: 'string' } } }),
    );
    expect(w).toEqual([]);
  });

  it('skips an unknown key whose value is `undefined` (equivalent to "not provided")', () => {
    const w = collectUnknownArgWarnings(
      { surprise: undefined },
      schema({ type: 'object', properties: { query: { type: 'string' } } }),
    );
    expect(w).toEqual([]);
  });

  it('warns on a non-underscore unknown key, suggesting a plausible declared name', () => {
    // `path` is not declared; `pathFilter` is.
    const w = collectUnknownArgWarnings(
      { path: '/some/file.ts' },
      schema({ type: 'object', properties: { pathFilter: { type: 'string' } } }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('path');
    expect(w[0]).toContain('pathFilter');
  });

  it('warns without a suggestion when no declared name plausibly matches', () => {
    const w = collectUnknownArgWarnings(
      { file: 'foo.ts' },
      schema({ type: 'object', properties: { query: { type: 'string' } } }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('file');
    expect(w[0]).not.toContain('Did you mean');
  });

  it('warns once per unknown key', () => {
    const w = collectUnknownArgWarnings(
      { path: '/a', nope: 1 },
      schema({ type: 'object', properties: { pathFilter: { type: 'string' } } }),
    );
    expect(w.length).toBe(2);
  });

  // ── Short unknown keys must not over-match (Reviewer finding) ──────────

  it('does not produce substring-based false suggestions for a 1-char unknown key', () => {
    // `a` is a single char — substring inclusion would match `action`,
    // `pathFilter`, etc. Substring matching is gated on keyLength >= 3;
    // Levenshtein <= 2 cannot reach any key longer than 3 chars here.
    const w = collectUnknownArgWarnings(
      { a: 'x' },
      schema({
        type: 'object',
        properties: {
          action: { type: 'string' },
          pathFilter: { type: 'string' },
          mode: { type: 'string' },
          query: { type: 'string' },
        },
      }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('`a`');
    expect(w[0]).not.toContain('Did you mean');
  });

  it('does not produce substring-based false suggestions for a 2-char unknown key', () => {
    // `id` is contained in `nodeId` / `buildId` — the length guard
    // prevents those substring matches.
    const w = collectUnknownArgWarnings(
      { id: 42 },
      schema({
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          buildId: { type: 'string' },
          pathFilter: { type: 'string' },
          mode: { type: 'string' },
        },
      }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('`id`');
    expect(w[0]).not.toContain('nodeId');
    expect(w[0]).not.toContain('buildId');
    expect(w[0]).not.toContain('Did you mean');
  });

  it('still suggests via Levenshtein for a 2-char key with a close match', () => {
    // Levenshtein('ot', 'of') = 1 — close enough to suggest.
    const w = collectUnknownArgWarnings(
      { ot: 'v' },
      schema({ type: 'object', properties: { of: { type: 'string' } } }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('Did you mean');
    expect(w[0]).toContain('`of`');
  });

  it('still produces substring suggestions for a 3-char-or-longer unknown key', () => {
    // `pat` (3 chars) is contained in `pathFilter` → still suggested.
    const w = collectUnknownArgWarnings(
      { pat: '/some/path' },
      schema({
        type: 'object',
        properties: { pathFilter: { type: 'string' }, mode: { type: 'string' } },
      }),
    );
    expect(w.length).toBe(1);
    expect(w[0]).toContain('Did you mean');
    expect(w[0]).toContain('pathFilter');
  });
});
