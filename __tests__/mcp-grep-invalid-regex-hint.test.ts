/**
 * Regression: `cartograph_find({by: 'content', query: 'foo('})` returned
 * "Invalid regex `foo(`: Unterminated group" with no guidance. Agents
 * searching for literal substrings containing regex metacharacters had no
 * indication that by:'content' is regex-based or how to fix it.
 *
 * `_grep.ts` now appends an escape hint to the compile-failure message:
 * "cartograph_find by:'content' treats the query as a regex — escape
 * metacharacters (e.g. `\(`, `\[`) to match them literally."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_find by=content invalid-regex escape hint', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-invalid-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function stripJsComments(src: string) { return src; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'grep-invalid-regex', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns isError with "Invalid regex" and escape-metacharacters hint on unbalanced paren', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'foo(',
    });
    expect(result.isError).toBeTruthy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Invalid regex');
    expect(text).toMatch(/escape metacharacters/);
  });

  it('includes the hint when query has an unbalanced bracket', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'arr[0',
    });
    expect(result.isError).toBeTruthy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Invalid regex');
    expect(text).toMatch(/escape metacharacters/);
  });

  it('does NOT return an error for a valid regex pattern', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: 'stripJsComments',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('Invalid regex');
    expect(text).toMatch(/stripJsComments/);
  });

  it('includes the escape hint on unterminated non-capturing group', async () => {
    // `(?:` is an invalid regex — useful e.g. when an agent pastes a
    // raw function-call fragment like `stripJsComments(?:`.
    const result = await handler.execute('cartograph_find', {
      by: 'content',
      query: '(?:',
    });
    expect(result.isError).toBeTruthy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Invalid regex');
    expect(text).toMatch(/escape metacharacters/);
  });
});
