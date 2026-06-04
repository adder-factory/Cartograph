/**
 * Regression tests for input-validation hardening on MCP handlers.
 *
 * Adversarial pass against the ollama index surfaced two crashes
 * caused by inputs that slipped past the `as string` TS escape hatch:
 *  - a 100 KB symbol string blew past SQLite's LIKE-pattern limit and
 *    threw "LIKE or GLOB pattern too complex"
 *  - an object with a custom `toString` was passed straight into a
 *    prepared statement, throwing "Too few parameter values"
 * `validateString` now bounds length (4 KB) and `handleBiomarkers`
 * mode='symbol' uses it instead of the bare cast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

let dir: string;
let cg: Cartograph;
let handler: ToolHandler;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validate-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function f(): number { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0' }));
  cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  handler = new ToolHandler(cg, { profile: 'full' });
});

afterEach(() => {
  handler.closeAll();
  try {
    cg.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('handler input validation', () => {
  it('rejects oversize symbol on biomarkers symbol-mode (was: SQLite LIKE-pattern crash)', async () => {
    const huge = 'a'.repeat(102_400);
    const r = await handler.execute('cartograph_biomarkers', { mode: 'symbol', symbol: huge });
    expect(r.isError).toBe(true);
    // cartograph_biomarkers is Zod-backed (P4 wave 2): the 4096-char
    // bound is `.max(4096)` on the `symbol` field; over-length input is
    // rejected at the dispatch boundary with the Zod-formatted message.
    expect(r.content[0]?.text).toMatch(/symbol: must be at most 4096 character/);
  });

  it('rejects non-string symbol with toString trick (was: prepared-statement crash)', async () => {
    // Cast to any — the test deliberately violates the typed shape to
    // simulate a misbehaving MCP client that sends a JSON object where
    // a string is expected. The Zod schema's `safeParse` catches the
    // type mismatch before the handler runs.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const fakeStringy: any = { toString: () => 'fake' };
    const r = await handler.execute('cartograph_biomarkers', { mode: 'symbol', symbol: fakeStringy });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/symbol: expected string, received object/);
  });

  it('rejects number passed where string expected', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const r = await handler.execute('cartograph_biomarkers', { mode: 'symbol', symbol: 42 as any });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/symbol: expected string, received number/);
  });

  it('rejects oversize query on search', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', query: 'a'.repeat(5000) });
    expect(r.content[0]?.text).toMatch(/query must be at most 4096 characters/);
  });

  it('rejects oversize symbol on node-lookup (defends every validateString caller)', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'a'.repeat(5000) });
    expect(r.content[0]?.text).toMatch(/symbols must be at most 4096 characters/);
  });

  it('rejects a whitespace-only query (slips past length===0 but is never legitimate)', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', query: '   ' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/query must be a non-empty string/);
  });

  it('accepts a whitespace-only query on by:content (a valid grep pattern for indentation)', async () => {
    const r = await handler.execute('cartograph_find', { by: 'content', query: '  ' });
    // A pure-whitespace regex is legitimate for by:content — it must not
    // be rejected as "non-empty string" (allowWhitespaceOnly carve-out).
    expect(r.content[0]?.text ?? '').not.toMatch(/query must be a non-empty string/);
  });

  it('still rejects a genuinely empty query on by:content', async () => {
    const r = await handler.execute('cartograph_find', { by: 'content', query: '' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/query must be a non-empty string/);
  });

  it('rejects a whitespace-only symbol on node-lookup', async () => {
    const r = await handler.execute('cartograph_node', { symbol: '\t\n  ' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/symbols must be a non-empty string/);
  });

  it('rejects oversize symbol on coverage symbol-mode (mirrors biomarkers fix)', async () => {
    const r = await handler.execute('cartograph_coverage', { mode: 'symbol', symbol: 'a'.repeat(102_400) });
    expect(r.content[0]?.text).toMatch(/symbol must be at most 4096 characters/);
  });

  it('rejects non-string symbol on coverage symbol-mode', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const r = await handler.execute('cartograph_coverage', { mode: 'symbol', symbol: { toString: () => 'x' } as any });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/`symbol` must be of type string|symbol: expected string/);
  });

  it('still accepts a normal-length identifier and actually executes the query', async () => {
    // 3.5 KB — under cap. The handler must NOT short-circuit on
    // validation; it must reach the FTS layer and produce a real
    // result envelope (either a hit list or "No results"), proving
    // the query actually ran.
    const r = await handler.execute('cartograph_find', { by: 'name', query: 'f'.repeat(3500) });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).not.toMatch(/at most 4096/);
    expect(r.content[0]?.text).toMatch(/Search Results|No results found/);
  });

  it('handleReviewContext accepts diffs above the default 4 KB cap (up to 1 MB)', async () => {
    // A synthetic 200 KB diff — well above the default validateString
    // cap, well under handleReviewContext's bumped 1 MB ceiling.
    const big = '+ added line\n'.repeat(20_000); // ~260 KB
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,${20_001} @@\n${big}`;
    const r = await handler.execute('cartograph_review', { mode: 'context', diff });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).not.toMatch(/at most/);
  });

  it('handleReviewContext still rejects pathologically large diffs (> 1 MB)', async () => {
    const monster = '+ x\n'.repeat(300_000); // ~1.2 MB body
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,300001 @@\n${monster}`;
    const r = await handler.execute('cartograph_review', { mode: 'context', diff });
    expect(r.content[0]?.text).toMatch(/diff must be at most 1048576/);
  });
});
