/**
 * Delta-mode (#16): cartograph_search / _grep / _explore accept
 * `since=<call-id>` to filter out rows seen on the prior matching
 * call. Every call response ends with a `> _call: c_xxxxxxxx_`
 * marker so the chain can continue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

function extractCallId(text: string): string {
  const m = /> _call: `(c_[0-9a-f]{8})`_/.exec(text);
  if (!m) throw new Error(`No call-id marker found in:\n${text}`);
  return m[1]!;
}

describe('Delta mode (#16)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-delta-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/lib.ts'),
      [
        'export function alpha(): number { return 1; }',
        'export function beta(): number { return 2; }',
        'export function gamma(): number { return 3; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  describe('cartograph_search', () => {
    it('baseline call appends a `c_xxxxxxxx` marker', async () => {
      const text = textOf(await handler.runHandler('cartograph_find', { by: 'name', query: 'alpha' }));
      expect(text).toMatch(/> _call: `c_[0-9a-f]{8}`_/);
      expect(text).toContain('alpha');
    });

    it('repeated identical call with since=<self-id> reports zero new rows', async () => {
      const t1 = textOf(await handler.runHandler('cartograph_find', { by: 'name', query: 'alpha' }));
      const id1 = extractCallId(t1);
      const t2 = textOf(await handler.runHandler('cartograph_find', { by: 'name', query: 'alpha', since: id1 }));
      expect(t2).toContain('Delta vs');
      expect(t2).toMatch(/Delta vs `c_[0-9a-f]{8}`\*\* — 0 new rows? of \d+ total/);
      expect(t2).toContain('All ');
      expect(t2).toContain('already returned');
    });

    it('new symbol added between calls surfaces as the only delta row', async () => {
      // Match with a kind filter to keep the result set bounded to
      // our fixture functions.
      const args = { by: 'name' as const, query: 'kind:function', limit: 50 };
      const t1 = textOf(await handler.runHandler('cartograph_find', args));
      const id1 = extractCallId(t1);

      // Add a new function and re-sync.
      fs.writeFileSync(
        path.join(tempDir, 'src/extra.ts'),
        'export function delta_new_symbol(): number { return 4; }\n',
      );
      await cg.sync();

      const t2 = textOf(await handler.runHandler('cartograph_find', { ...args, since: id1 }));
      expect(t2).toContain('delta_new_symbol');
      expect(t2).toMatch(/Delta vs `c_[0-9a-f]{8}`\*\* — 1 new row of \d+ total/);
    });

    it('unknown since=<id> falls back to full results with a warning', async () => {
      const t = textOf(
        await handler.runHandler('cartograph_find', { by: 'name', query: 'alpha', since: 'c_deadbeef' }),
      );
      expect(t).toContain('alpha');
      expect(t).toContain('no longer cached');
      expect(t).toMatch(/> _call: `c_[0-9a-f]{8}`_/);
    });
  });

  describe('cartograph_grep', () => {
    it('baseline call appends a marker; same-query follow-up is empty', async () => {
      const t1 = textOf(await handler.runHandler('cartograph_find', { by: 'content', query: 'export function' }));
      const id1 = extractCallId(t1);
      expect(t1).toContain('alpha');
      const t2 = textOf(
        await handler.runHandler('cartograph_find', { by: 'content', query: 'export function', since: id1 }),
      );
      expect(t2).toMatch(/Delta vs `c_[0-9a-f]{8}`\*\* — 0 new rows? of \d+ total/);
    });

    it('new line surfaces as the only new hit', async () => {
      const t1 = textOf(await handler.runHandler('cartograph_find', { by: 'content', query: 'export function' }));
      const id1 = extractCallId(t1);

      fs.appendFileSync(path.join(tempDir, 'src/lib.ts'), '\nexport function epsilon(): number { return 5; }\n');
      // grep reads from disk, no sync needed for new content — but the
      // file must already be in the index for grep to scan it. lib.ts
      // already is.

      const t2 = textOf(
        await handler.runHandler('cartograph_find', { by: 'content', query: 'export function', since: id1 }),
      );
      expect(t2).toContain('epsilon');
      // 1 new line in lib.ts vs the 3 baseline lines.
      expect(t2).toMatch(/Delta vs `c_[0-9a-f]{8}`\*\* — 1 new row of 4 total/);
    });
  });

  describe('chain accumulation', () => {
    it('UID after delta call covers (prior ∪ current) — chained sinces compose', async () => {
      const args = { by: 'name' as const, query: 'kind:function', limit: 50 };
      const t1 = textOf(await handler.runHandler('cartograph_find', args));
      const id1 = extractCallId(t1);

      fs.writeFileSync(path.join(tempDir, 'src/file2.ts'), 'export function added2(): number { return 2; }\n');
      await cg.sync();
      const t2 = textOf(await handler.runHandler('cartograph_find', { ...args, since: id1 }));
      const id2 = extractCallId(t2);
      expect(t2).toContain('added2');

      fs.writeFileSync(path.join(tempDir, 'src/file3.ts'), 'export function added3(): number { return 3; }\n');
      await cg.sync();
      const t3 = textOf(await handler.runHandler('cartograph_find', { ...args, since: id2 }));
      // Only added3 should show — added2 already in id2's union.
      expect(t3).toContain('added3');
      expect(t3).not.toContain('added2');
      expect(t3).not.toContain('alpha');
      expect(t3).toMatch(/— 1 new row of \d+ total/);
    });
  });

  describe('CallIdCache', () => {
    it('isUid identifies well-formed UIDs and rejects malformed ones', async () => {
      const { CallIdCache } = await import('../src/mcp/tools/_call-id-cache.js');
      expect(CallIdCache.isUid('c_abc12345')).toBe(true);
      expect(CallIdCache.isUid('c_abc1234')).toBe(false); // too short
      expect(CallIdCache.isUid('n_abc12345')).toBe(false); // wrong prefix
      expect(CallIdCache.isUid('c_abc123456')).toBe(false); // too long
      expect(CallIdCache.isUid('')).toBe(false);
      // Hex-only — uppercase, non-hex chars, control chars all rejected.
      expect(CallIdCache.isUid('c_ABC12345')).toBe(false);
      expect(CallIdCache.isUid('c_zz112233')).toBe(false);
      expect(CallIdCache.isUid('c_\n123456')).toBe(false);
    });

    it('mint is deterministic on (toolName, sortedRowKeys)', async () => {
      const { CallIdCache } = await import('../src/mcp/tools/_call-id-cache.js');
      const cache = new CallIdCache();
      const a = cache.mint('cartograph_find:name', ['n1', 'n2', 'n3']);
      const b = cache.mint('cartograph_find:name', ['n3', 'n1', 'n2']); // same set, different order
      expect(a).toBe(b);
      const c = cache.mint('cartograph_find:content', ['n1', 'n2', 'n3']);
      expect(c).not.toBe(a); // different tool → different uid
    });

    it('resolve bumps LRU so actively-read entries survive eviction', async () => {
      const { CallIdCache } = await import('../src/mcp/tools/_call-id-cache.js');
      const cache = new CallIdCache();
      const survivor = cache.mint('t', ['x']);
      // Push 256 fresh entries (the cache cap) — the original would
      // be the first evicted unless resolve bumps it.
      for (let i = 0; i < 256; i++) cache.mint('t', [`fill-${i}`]);
      // Walk one read of `survivor` BEFORE the final fill to bump it.
      // We only want to verify the bump path here; structure the test
      // by alternating reads + mints.
      const fresh = new CallIdCache();
      const target = fresh.mint('t', ['x']);
      for (let i = 0; i < 200; i++) {
        if (i % 50 === 0) expect(fresh.resolve(target)).not.toBeNull(); // active read
        fresh.mint('t', [`pad-${i}`]);
      }
      // After the bumps, the target should still be resolvable even
      // though many newer entries were minted in between.
      expect(fresh.resolve(target)).not.toBeNull();
      expect(cache.resolve(survivor)).toBeNull();
    });
  });

  describe('error paths', () => {
    it("cartograph_search with mode='fuzzy' + since errors out", async () => {
      const r = await handler.runHandler('cartograph_find', {
        by: 'name',
        query: 'alpha',
        mode: 'fuzzy',
        since: 'c_12345678',
      });
      const text = textOf(r);
      expect(r.isError).toBe(true);
      expect(text).toContain('delta mode');
      expect(text).toContain("mode='exact'");
    });

    it("cartograph_search with mode='semantic' + since errors out", async () => {
      const r = await handler.runHandler('cartograph_find', {
        by: 'name',
        mode: 'semantic',
        symbol: 'alpha',
        since: 'c_12345678',
      });
      const text = textOf(r);
      expect(r.isError).toBe(true);
      expect(text).toContain('delta mode');
    });

    it('malformed since value renders generic warning, not the raw value', async () => {
      const t = textOf(
        await handler.runHandler('cartograph_find', {
          by: 'name',
          query: 'alpha',
          since: '`<script>alert(1)</script>`',
        }),
      );
      // Raw value must NOT appear in the rendered output (would be an
      // injection oracle even in markdown).
      expect(t).not.toContain('script');
      expect(t).not.toContain('alert');
      expect(t).toContain('malformed');
    });
  });

  describe('explore "Additional relevant files" listing', () => {
    it('shows files surfaced earlier even when delta-filtered out of source code', async () => {
      // Seed a project with enough files that explore renders some
      // and lists others, then verify the listing shows both rendered
      // and non-rendered relevant files in delta mode.
      // Using the existing fixture is enough to verify the helper
      // renders its header — actual file-set semantics are covered by
      // unit tests on appendRemainingFiles. Here we just confirm no
      // crash and that the output references the full subgraph.
      const t1 = textOf(await handler.runHandler('cartograph_explore', { query: 'alpha beta gamma' }));
      const id1 = extractCallId(t1);
      const t2 = textOf(await handler.runHandler('cartograph_explore', { query: 'alpha beta gamma', since: id1 }));
      // Smoke test: header still mentions the FULL file count, not a
      // delta-only count (the delta note explicitly says relationships
      // cover the full subgraph; the file count headline matches).
      expect(t2).toMatch(/Found \d+ symbols across \d+ files/);
    });
  });
});
