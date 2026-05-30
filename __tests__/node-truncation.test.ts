/**
 * cartograph_node smart-truncation behavior (agentic-backlog item #2).
 *
 * Locks in:
 *  - `**Lines:** N` is always present when the indexed range is known,
 *    independent of whether `code: true` was passed.
 *  - `code: true` on a small body returns the full body (no preview
 *    overhead on bodies that already fit).
 *  - `code: true` on a large body with default `detail: preview`
 *    returns only the first PREVIEW_LINE_LIMIT lines plus a tail
 *    marker that names the override.
 *  - `code: true, detail: full` on a large body always returns the
 *    complete body verbatim.
 *  - `code: false` ignores `detail` (no body, no truncation, no
 *    tail marker).
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

/** Generate a body that produces the requested LOC count when emitted. */
function makeBody(loc: number): string {
  // `loc` lines BETWEEN the function-open and function-close. Add the
  // signature line + closing brace and the indexed range becomes
  // `loc + 2`.
  const inner = Array.from({ length: loc }, (_, i) => `  const v${i} = ${i};`).join('\n');
  return `export function bigFn() {\n${inner}\n}\n`;
}

describe('cartograph_node smart truncation', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-trunc-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Small body — well under the 40-line preview threshold.
    fs.writeFileSync(path.join(dir, 'src', 'small.ts'), 'export function smallFn() {\n  return 1;\n}\n');
    // Large body — 60 inner lines, range ~62 → comfortably above 40.
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), makeBody(60));
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

  it('emits **Lines:** N when range is known, even without code', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'smallFn' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\*\*Lines:\*\* \d+/);
    // No body when code:false.
    expect(text).not.toContain('return 1;');
  });

  it('code:true on small body returns full body, no truncation marker', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'smallFn', code: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('return 1;');
    expect(text).not.toMatch(/Showing first \d+ of \d+ lines/);
  });

  it('code:true + default preview on large body truncates with a tail marker', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'bigFn', code: true });
    const text = result.content[0]?.text ?? '';
    // First-window line is present; far-tail line is not.
    expect(text).toContain('const v0 = 0;');
    expect(text).not.toContain('const v59 = 59;');
    // Tail marker names the override.
    expect(text).toMatch(/Showing first \d+ of \d+ lines/);
    expect(text).toContain('detail: "full"');
    // **Lines:** count still present and reflects the full range, not the preview.
    expect(text).toMatch(/\*\*Lines:\*\* \d+/);
  });

  it('code:true + detail:full on large body returns the complete body, no marker', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'bigFn',
      code: true,
      detail: 'full',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('const v0 = 0;');
    expect(text).toContain('const v59 = 59;');
    expect(text).not.toMatch(/Showing first \d+ of \d+ lines/);
  });

  it('code:false ignores detail (no body regardless of mode)', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'bigFn',
      detail: 'full', // should be a no-op without code:true
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('const v0 = 0;');
    expect(text).not.toMatch(/Showing first \d+ of \d+ lines/);
  });

  it('rejects unknown detail value (Zod schema enforces enum)', async () => {
    // Pre-D1 the handler used a forgiving `=== 'full' ? 'full' : 'preview'`
    // ternary, so `detail: 'banana'` silently fell through to preview.
    // The P4 Zod migration makes `detail` a `z.enum(['preview', 'full'])`,
    // so `safeParse` rejects the typo at the dispatch boundary and the
    // formatted error names the bad field + the allowed values.
    const result = await handler.execute('cartograph_node', {
      symbol: 'bigFn',
      code: true,
      detail: 'banana',
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toMatch(/detail: must be one of 'preview', 'full'/);
  });
});
