/**
 * Regression coverage for FRICTION-D (2026-05-14): `cartograph_graph
 * direction:callers` used to render test-file callers as a single
 * `kind=file` row pointing at line 1 of the test file. The agent then
 * had to do a follow-up `cartograph_at_range` to find which `it()` /
 * `describe()` block actually contained the call.
 *
 * After the fix:
 *   - When a caller resolves to a `kind=file` node AND the file is a
 *     test path (`isTestPath`), the renderer expands the row into one
 *     row per call site.
 *   - Each per-site row is anchored on the enclosing `it/describe`
 *     descriptor line (mined into `test_names` by the index hook). The
 *     row name carries the descriptor string so the agent can tell
 *     which test exercises the symbol without a follow-up call.
 *   - When the call sits before the first descriptor (module-scope
 *     import / setup), the row anchors on the call-site line itself —
 *     NEVER on file:1.
 *   - The (3 call sites: 60, 74, 85) subscript is suppressed on the
 *     per-site rows (we've already fanned the row out).
 *   - Non-test-file callers are unchanged (changing those would be
 *     invasive).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('callers — test-file row expansion (FRICTION-D)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callers-testfile-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'src', 'core.ts'),
      [
        'export function exercisedSymbol(): number { return 1; }',
        'export function unrelatedSymbol(): number { return 2; }',
      ].join('\n') + '\n',
    );

    // Test file with two `it` blocks calling exercisedSymbol from
    // inside their callbacks. The test_names index hook stamps
    // line 4 (describe), line 5 (first it) and line 9 (second it).
    fs.writeFileSync(
      path.join(dir, '__tests__', 'core.test.ts'),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { exercisedSymbol } from '../src/core.js';",
        '',
        "describe('exercisedSymbol behavior', () => {",
        "  it('exercises X path', () => {",
        '    const r = exercisedSymbol();',
        '    expect(r).toBe(1);',
        '  });',
        "  it('exercises Y path', () => {",
        '    const r = exercisedSymbol();',
        '    expect(r).toBe(1);',
        '  });',
        '});',
      ].join('\n') + '\n',
    );

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

  it('expands a test-file caller into one row per call site, anchored on the it/describe descriptor', async () => {
    const result = await handler.execute('cartograph_graph', {
      direction: 'callers',
      start: 'exercisedSymbol',
    });
    const text = result.content[0]?.text ?? '';

    // The OLD (broken) shape was a single row of the form:
    //   - core.test.ts (file) - __tests__/core.test.ts:1 (2 call sites: 6, 10)
    // Assert we don't see the file anchored at line 1 anymore.
    expect(text).not.toMatch(/core\.test\.ts:1\b/);

    // Each call site got its own row anchored on an `it/describe`
    // descriptor line. The two `it` blocks start at lines 5 and 9
    // (call sites at 6 and 10 sit inside them).
    expect(text).toMatch(/core\.test\.ts:5\b/);
    expect(text).toMatch(/core\.test\.ts:9\b/);

    // The descriptor strings ride along on the row label so the agent
    // can tell which test exercises the symbol without a follow-up
    // at_range / node call.
    expect(text).toMatch(/exercises X path/);
    expect(text).toMatch(/exercises Y path/);

    // The "(N call sites: ...)" subscript should NOT appear on the
    // per-site rows — we already fanned the row out, the count would
    // be redundant.
    expect(text).not.toMatch(/\d+ call sites:/);
  });
});
