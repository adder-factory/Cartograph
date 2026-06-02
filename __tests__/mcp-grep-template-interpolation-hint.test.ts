/**
 * Friction: `cartograph_find({by: 'content', query: '\\(\\+\\d+ more'})`
 * returned "No matches" with the `Index in sync — empty result is a true
 * negative` footer. But the substring DOES exist — built via template
 * literal `` `(+${cappedExtra} more)` ``, so the literal `(+\d+` never
 * appears as one continuous char range. The "true negative" claim was
 * misleading.
 *
 * `_grep.ts` now emits a "template-literal interpolation may have split
 * your match" hint when the regex contains a `\d` class AND zero hits
 * came back. Only fires on `\d` (digit) — `\w` / `\s` would be too broad.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find by=content template-literal interpolation hint', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-interp-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Source that uses a template-literal interpolation. The literal
    // `(+\d+ more` doesn't exist as one continuous char range — the
    // digits are produced by `${cappedExtra}` at runtime.
    fs.writeFileSync(
      path.join(dir, 'src', 'interp.ts'),
      [
        'export function renderTail(cappedExtra: number): string {',
        '  return `(+${cappedExtra} more, capped)`;',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'grep-interp', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it(String.raw`emits the interpolation hint when query contains \d and matches zero`, async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: String.raw`\(\+\d+ more`,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No matches for');
    expect(text).toContain('template-literal interpolations split the source');
    expect(text).toContain('cartograph_find by:name');
  });

  it('does NOT emit the interpolation hint when a match is found', async () => {
    // Match one SIDE of the interpolation — should succeed without hint.
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'cappedExtra',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('template-literal interpolations');
    expect(text).toMatch(/cappedExtra/);
  });

  it(String.raw`does NOT emit the interpolation hint when query has no \d`, async () => {
    // Empty result on a pattern with no numeric class — bare empty
    // message should NOT carry the interpolation footnote.
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'genuinelyNotInCodebase',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No matches for');
    expect(text).not.toContain('template-literal interpolations');
  });

  it(String.raw`fires on \d+ (quantified) — common shape of the original friction`, async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: String.raw`\d+ more`,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No matches for');
    expect(text).toContain('template-literal interpolations split the source');
  });
});
