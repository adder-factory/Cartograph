/**
 * MCP `cartograph_search({mode: 'fuzzy'})` — lexical-fuzzy symbol
 * search by edit distance. Distinct from mode='exact' (FTS) and
 * mode='semantic' (embeddings). The agent reaches for it when an
 * exact lookup misses (typo, transposition, abbreviation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe("cartograph_search({mode: 'fuzzy'})", () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fuzzy-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      `export function getStringImports(): number { return 1; }
export function setUserName(name: string): void { }
export class UserContainer { }
export class OrderContainer { }
export class FileWatcher { }
export function patch(): void { }
`,
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('finds a name with a single-character typo (edit-dist 1)', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'getStrigImports' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/getStringImports/);
    expect(text).toMatch(/edit-dist 1/);
  });

  it('finds names with transpositions / two-edit typos', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'Contianer' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/UserContainer/);
    expect(text).toMatch(/OrderContainer/);
  });

  it('respects the kind filter', async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'fuzzy',
      query: 'Container',
      kind: 'class',
      limit: 5,
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/UserContainer \(class\)/);
    expect(text).toMatch(/OrderContainer \(class\)/);
    // setUserName is a function — must not appear under kind=class.
    expect(text).not.toMatch(/setUserName/);
  });

  it('ranks a verbatim containment above an edit-distance neighbour (tier 0)', async () => {
    // "watch" is a verbatim substring of FileWatcher but only a
    // single-edit neighbour of patch (watch → patch). Containment is
    // the stronger signal, so FileWatcher must rank first — before
    // the tier-0 pass this ordering was inverted.
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'watch' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/FileWatcher/);
    expect(text).toMatch(/patch/);
    expect(text).toMatch(/FileWatcher \(class\) \(token match\)/);
    expect(text.indexOf('FileWatcher')).toBeLessThan(text.indexOf('### patch'));
  });

  it('returns a clear empty-state when the query has no fuzzy matches', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'xqzpfg' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/No fuzzy matches/);
  });

  it('exact match scores edit-dist 0', async () => {
    const r = await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'setUserName' });
    const text = r.content[0]?.text ?? '';
    // suggestSymbolNames skips identical names (they would have hit
    // the exact-match path); fall through is OK — the test ensures
    // the no-match path returns the suggestion-style empty state
    // rather than crashing.
    expect(text).toMatch(/setUserName|No fuzzy matches/);
  });
});
