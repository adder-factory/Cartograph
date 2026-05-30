/**
 * Regression test for the `cartograph_find({mode: 'intent'})` null-crash:
 *   `Cannot read properties of null (reading 'length')`
 *
 * Reproduces the production-state crash where a docstring FTS5 row points to
 * a node whose `nodes.docstring` column has since been nulled (the AFTER-
 * UPDATE-OF-docstring trigger should clear the stale FTS row, but legacy /
 * partially-migrated DBs can have a dangling FTS5 entry). The JOIN then
 * returns a row with `text === null`, which crashed the renderer at
 * `row.text.length` in `_search-intent.ts`.
 *
 * Fix: drop null-text rows at the merge boundary (mergeSymbolResults).
 *
 * The test seeds a node + FTS entry, then nulls the docstring on `nodes`
 * directly (bypassing the trigger via raw SQL — emulates a state where the
 * trigger didn't run for whatever reason). Without the fix, the call throws;
 * with the fix, it returns a "no results" message gracefully.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find mode=intent — null-text crash regression', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-intent-null-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'dead-code.ts'),
      [
        '/** Score the probability that a symbol is dead code. */',
        'export function scoreDeadCode(symbolId: string): number { return 0; }',
        '/** Compute the probability score for an arbitrary candidate symbol. */',
        'export function computeProbability(candidate: string): number { return 0; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Drive the dangling-FTS5-rowid state: after indexing seeds a docstring +
   * triggers add to docstring_fts, we wipe `nodes.docstring` directly via a
   * write that doesn't go through the column-targeted trigger. `UPDATE nodes
   * SET docstring = NULL` would normally fire `docstring_fts_au` and delete
   * the stale FTS row, so we instead disable triggers for the write.
   */
  function corruptDocstringFtsState(db: ReturnType<typeof cg.db.getDb>): void {
    // Drop the AFTER-UPDATE trigger temporarily so the docstring column can
    // be nulled WITHOUT the FTS5 mirror being cleaned up. Reproduces a state
    // observed in older databases where a trigger was missing or dropped
    // mid-migration.
    db.exec('DROP TRIGGER IF EXISTS docstring_fts_au');
    db.prepare(`UPDATE nodes SET docstring = NULL WHERE name = 'scoreDeadCode'`).run();
  }

  it('does not crash when the FTS5 corpus has a stale row pointing to a NULL docstring', async () => {
    // First, sanity-check: the seeded docstring should match the reproducer
    // query before we corrupt state.
    const before = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'score probability that a symbol is dead code',
      limit: 10,
    });
    expect(before.isError).toBeFalsy();

    // Now create the null-text condition that triggered the original crash.
    corruptDocstringFtsState(cg.db.getDb());

    // The reproducer call from the bug report — must NOT throw.
    const after = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'score probability that a symbol is dead code',
      limit: 10,
    });
    const text = after.content[0]?.text ?? '';
    // Should produce a graceful "no results" or empty-but-rendered response.
    // The exact branch (no-hit message vs empty-symbol-section) depends on
    // whether any docstring/summary survives — in this seeded test it's the
    // only one, so the no-hit branch fires.
    expect(text).toMatch(/no summaries, docstrings, or test names matched|Intent search results/);
    // The diagnostic string from the original crash MUST NOT appear.
    expect(text).not.toMatch(/Cannot read properties of null/);
  });
});
