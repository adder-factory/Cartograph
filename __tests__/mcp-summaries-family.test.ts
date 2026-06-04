/**
 * Tests for the consolidated `cartograph_summaries({action})` family
 * tool (agentic-backlog #7-1). Exercises:
 *  - registry surfaces the consolidated tool name
 *  - registry no longer carries the retired legacy tool names
 *  - missing/invalid `action` returns a clean error pointing at the
 *    valid set
 *  - `action: 'pending'` returns a JSON batch (or the empty-batch sentinel)
 *  - `action: 'save'` validates input shape (missing `items` → error)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_summaries family (#7-1)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sum-fam-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registry surfaces cartograph_summaries; the legacy names are gone', () => {
    const names = getToolModules().map((m) => m.definition.name);
    expect(names).toContain('cartograph_summaries');
    // Shims removed (per user policy — single-user codebase, hard cut-over).
    expect(names).not.toContain('cartograph_pending_summaries');
    expect(names).not.toContain('cartograph_save_summaries');
  });

  it('errors with a helpful message when `action` is missing or invalid', async () => {
    // Post-Zod-migration `action` is a required enum; `safeParse`
    // rejects a missing or out-of-set value at the dispatch boundary.
    const missing = await handler.execute('cartograph_summaries', {});
    expect(missing.content[0]?.text ?? '').toMatch(/action: required/);

    const bogus = await handler.execute('cartograph_summaries', { action: 'banana' });
    expect(bogus.content[0]?.text ?? '').toMatch(/action: must be one of 'pending', 'save'/);
    expect(bogus.content[0]?.text ?? '').toContain('"banana"');
  });

  it("action: 'pending' returns the agent-bridge JSON envelope", async () => {
    const result = await handler.execute('cartograph_summaries', { action: 'pending' });
    const text = result.content[0]?.text ?? '';
    // Either "no pending summaries" sentinel OR the JSON batch envelope.
    const looksLikeBatch = text.startsWith('{') && text.includes('"items"');
    const isEmptySentinel = text.startsWith('No pending summaries');
    expect(looksLikeBatch || isEmptySentinel).toBe(true);
  });

  it("action: 'pending' splits total into staleCount + neverSummarisedCount (bug #16)", async () => {
    // Bug #16 regression guard: the JSON envelope MUST surface both
    // `staleCount` (drifted from disk — matches `cartograph_status`'s
    // out-of-date count) and `neverSummarisedCount` (long tail) so an
    // agent reading a 1669-total isn't misled into thinking all 1669 are
    // urgent stale work. On a freshly-indexed project every candidate is
    // never-summarised, so staleCount === 0 and neverSummarisedCount >= 1.
    const result = await handler.execute('cartograph_summaries', { action: 'pending' });
    const text = result.content[0]?.text ?? '';
    if (text.startsWith('No pending summaries')) {
      // No candidates at all — nothing to assert, the bucket fields are
      // only meaningful with a non-empty candidate pool.
      return;
    }
    const envelope = JSON.parse(text) as {
      total: number;
      staleCount: number;
      neverSummarisedCount: number;
      items: unknown[];
    };
    expect(typeof envelope.staleCount).toBe('number');
    expect(typeof envelope.neverSummarisedCount).toBe('number');
    expect(envelope.staleCount + envelope.neverSummarisedCount).toBe(envelope.total);
    // Freshly indexed, never summarised — drift-stale count should be 0.
    expect(envelope.staleCount).toBe(0);
    expect(envelope.neverSummarisedCount).toBeGreaterThanOrEqual(envelope.items.length);
  });

  it("action: 'save' validates the items array", async () => {
    // A missing `items` is per-action — the flat Zod schema marks it
    // `.optional()`, so the `_summaries-save.ts` sub-handler's own
    // "items must be an array" check still fires.
    const noItems = await handler.execute('cartograph_summaries', { action: 'save' });
    expect(noItems.content[0]?.text ?? '').toMatch(/items must be an array/);

    const badItem = await handler.execute('cartograph_summaries', {
      action: 'save',
      items: [{ nodeId: 'x' /* missing contentHash + summary */ }],
    });
    // Post-Zod-migration the per-item object schema rejects a missing
    // required key at the dispatch boundary; the formatted error names
    // the first missing key under its array path.
    expect(badItem.content[0]?.text ?? '').toMatch(/items\[0\]\.contentHash: required/);
  });

  it("action: 'save' with an empty items array returns an empty-batch notice", async () => {
    const result = await handler.execute('cartograph_summaries', {
      action: 'save',
      items: [],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No summaries to save/);
  });
});
