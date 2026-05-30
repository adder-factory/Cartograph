/**
 * Regression: `cartograph_find({by: 'content', query: '.', limit: 500})` returned
 * 117k+ hits with no warning, pure noise to the agent. `_grep.ts` now emits a
 * "your pattern is very broad" hint in two cases:
 *   1. The pattern is trivially broad after stripping anchors / quantifiers
 *      (e.g. `.`, `.*`, `\w`).
 *   2. Total matched lines exceed the soft 5000 threshold.
 *
 * Warn-only — never reject — so legitimate dense queries (`import `,
 * `return null`) still complete. The hint appears once near the top of the
 * output above the per-file sections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find by=content broad-pattern guard', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-broad-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Two small files with a handful of lines each — enough to make `.`
    // match dozens of lines without inflating the test runtime.
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      Array.from({ length: 20 }, (_, i) => `export const A${i} = ${i};`).join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      Array.from({ length: 20 }, (_, i) => `export const B${i} = ${i};`).join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'broad-grep-test', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits a broadness hint when query is `.` (trivially broad)', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: '.',
      limit: 50,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Hint must be near the top — above the per-file sections.
    expect(text).toMatch(/is very broad — it matches almost any line|matched \d+\+ lines — likely too broad/);
    // Suggestion text must point the agent at something useful.
    expect(text).toMatch(/Add context|adding context|pathFilter/);
  });

  it('emits a broadness hint when totalMatched exceeds the 5000 threshold', async () => {
    // `totalMatched` is the sum of per-file match counts, where each
    // file's count is capped by `limit`. To exceed 5000 with limit=500,
    // we need ≥11 files with ≥500 matches each. Create 12 dense files
    // with 600 `let `-bearing lines apiece. Pattern itself is not
    // trivially broad — only the hit count trips the guard.
    for (let f = 0; f < 12; f++) {
      const dense = Array.from({ length: 600 }, (_, i) => `let v${f}_${i} = ${i};`).join('\n');
      fs.writeFileSync(path.join(dir, 'src', `dense${f}.ts`), dense);
    }
    await cg.sync();

    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'let ',
      limit: 500,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/matched \d+\+ lines — likely too broad/);
  });

  it('does NOT emit a broadness hint for legitimate narrow queries', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'const A1 ',
      limit: 50,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/is very broad|likely too broad/);
  });

  it('warns on `.*` (trivially broad after stripping quantifier)', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: '.*',
      limit: 50,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/is very broad|likely too broad/);
  });

  it('warns on single-meta-char patterns like `\\w`', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: '\\w',
      limit: 50,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/is very broad|likely too broad/);
  });
});
