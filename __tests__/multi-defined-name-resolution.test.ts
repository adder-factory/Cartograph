/**
 * Regression test for #17: when a class name has multiple definitions
 * across files, `cartograph_callers` (multi-match grouped path) used to
 * render "_No callers._" for every source even when `instantiates`
 * edges were correctly present in the graph.
 *
 * Root cause: `formatGroupedCallers` only consulted
 * `traverser.getCallers` (filters to call-edge kinds: `calls` /
 * `references` / `imports`) and missed the type-usage edges
 * (`instantiates`/`extends`/`implements`/`type_of`/`returns`) that
 * the SINGLE-match path's `collectTypeUsers` separately handles.
 *
 * Fix: thread type-usage collection into the multi-match per-source
 * caller list via `collectCallersForSource`. Validates here by going
 * through the MCP `cartograph_callers` tool — that's the user-facing
 * surface and confirms the regression is closed end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('multi-defined name resolution (#17)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-multidef-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'dup-a.ts'), 'export class Dup { kind = "a"; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'dup-b.ts'), 'export class Dup { kind = "b"; }\n');
    const callers = Array.from({ length: 12 }, (_, i) => `export function dupCaller${i}() { return new Dup(); }`).join(
      '\n',
    );
    fs.writeFileSync(path.join(dir, 'src', 'dup-callers.ts'), `import { Dup } from "./dup-a.js";\n${callers}\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cartograph_callers surfaces instantiates edges per source on a multi-defined class', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'Dup', limit: 30 });
    const text = result.content[0]?.text ?? '';

    // Multi-match path was triggered (two source definitions).
    expect(text).toContain('source definitions');
    expect(text).toContain('src/dup-a.ts');
    expect(text).toContain('src/dup-b.ts');

    // dup-a's section now lists at least a few of the dupCaller_i
    // functions (was "_No callers._" before the fix).
    expect(text).toContain('dupCaller0 (function)');
    expect(text).toMatch(/dupCaller\d+ \(function\)/);

    // dup-b's section still has no callers — `dup-callers.ts` only
    // imports from `./dup-a.js`. Locate dup-b's section by looking
    // for its ### header and asserting `_No callers._` follows it.
    const bSection = text.split('### Dup (class) — src/dup-b.ts')[1] ?? '';
    expect(bSection).toContain('_No callers._');
  });
});
