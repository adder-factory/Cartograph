/**
 * Friction: agents (and humans) routinely paste host-relative paths
 * like `cartograph/src/mcp/` into `cartograph_find by:content` —
 * `pathFilter`, but the index stores project-relative paths
 * (`src/mcp/`). The bare "no indexed files match" message is correct
 * but silent — no nudge toward the fix. Six sub-agents in the
 * 2026-05-14 session hit this in parallel.
 *
 * `_grep.ts` now emits a "Did you mean ...?" hint when the supplied
 * prefix starts with the project-root basename and stripping it
 * WOULD have matched. `imports.ts` adopts the same shim (FRICTION-25
 * added pathFilter there in the same arc).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find by=content pathFilter strip hint', () => {
  let dir: string;
  let rootBasename: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pf-strip-'));
    rootBasename = path.basename(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'mcp'));
    fs.writeFileSync(path.join(dir, 'src', 'mcp', 'handler.ts'), `export function handleSync() { return 42; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'other.ts'), `export function other() { return 7; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pf-strip', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits hint when prefix starts with project-root basename and strip would match', async () => {
    const pathFilter = `${rootBasename}/src/mcp/`;
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'handleSync',
      pathFilter,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No indexed files match the filters');
    expect(text).toContain('Did you mean');
    expect(text).toContain('"src/mcp/"');
    expect(text).toContain(`project root is "${rootBasename}"`);
  });

  it('normal results when pathFilter is already index-relative', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'handleSync',
      pathFilter: 'src/mcp/',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('Did you mean');
    expect(text).toMatch(/handleSync/);
  });

  it('no false suggestion when prefix is genuinely wrong (strip would not match)', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'handleSync',
      pathFilter: 'nonexistent/',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No indexed files match the filters');
    expect(text).not.toContain('Did you mean');
  });

  it('no hint when pathFilter lacks a slash (single-segment prefix)', async () => {
    // A prefix without `/` can't be a host-relative leak — skip the probe.
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'handleSync',
      pathFilter: rootBasename,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('Did you mean');
  });

  it('no hint when basename matches but strip still produces zero matches', async () => {
    // `${rootBasename}/totallyMissing/` strips to `totallyMissing/`,
    // which doesn't match anything either — keep the bare message.
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'handleSync',
      pathFilter: `${rootBasename}/totallyMissing/`,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No indexed files match the filters');
    expect(text).not.toContain('Did you mean');
  });
});
