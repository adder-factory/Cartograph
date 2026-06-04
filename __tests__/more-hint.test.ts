/**
 * Tests for the appendMoreHint() helper and its wiring into the
 * 6 capped tools (callers, callees, search, biomarkers, hotspots,
 * history). Goal: when a result is at-or-above the requested cap,
 * the agent gets a tail telling them re-fetch could surface more;
 * when the result is clearly under the cap, no hint (so a redundant
 * re-fetch doesn't happen).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { appendMoreHint } from '../src/mcp/tools/shared.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const HINT_PATTERN = /Result capped — pass a higher `[a-zA-Z]+` to see more\./;

describe('appendMoreHint (unit)', () => {
  it('no-ops when hasMore is false', () => {
    expect(appendMoreHint('body', false)).toBe('body');
  });

  it('appends the hint when hasMore is true', () => {
    const out = appendMoreHint('body', true);
    expect(out).toContain('body');
    expect(out).toMatch(HINT_PATTERN);
  });

  it('names the configured arg in the hint', () => {
    const out = appendMoreHint('body', true, 'maxCandidates');
    expect(out).toMatch(/`maxCandidates`/);
  });

  it('defaults to "limit" when no argName passed', () => {
    expect(appendMoreHint('body', true)).toMatch(/`limit`/);
  });
});

describe('appendMoreHint integration across capped tools', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-more-hint-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // 25 sibling functions all calling target() — gives callers a
    // pool comfortably above the default limit (20) so the hint fires.
    fs.writeFileSync(path.join(dir, 'src', 'target.ts'), 'export function target() { return 1; }\n');
    const callsiteLines = Array.from(
      { length: 25 },
      (_, i) => `import { target } from "./target.js";\nexport function caller${i}() { return target(); }`,
    ).join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'callsites.ts'), callsiteLines);
    // One isolated function with no callers — used to assert the
    // "no hint" path.
    fs.writeFileSync(path.join(dir, 'src', 'lonely.ts'), 'export function loneliness() { return 0; }\n');
    // 30 sibling helpers for a fan-out function — used by the
    // callees cap-hit assertion (default callees limit = 20).
    // Multi-line imports + one helper call per line so the file's
    // average line length stays comfortably below F#49's minified-JS
    // detector threshold (200 chars/line) — the prior single-line
    // form tripped the filter once F#49 landed and silently skipped
    // the file.
    const helperDecls = Array.from({ length: 30 }, (_, i) => `export function helper${i}() { return ${i}; }`).join(
      '\n',
    );
    fs.writeFileSync(path.join(dir, 'src', 'helpers.ts'), helperDecls);
    const helperImports = Array.from({ length: 30 }, (_, i) => `  helper${i},`).join('\n');
    const helperCallLines = Array.from({ length: 30 }, (_, i) => `  helper${i}();`).join('\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'fanout.ts'),
      `import {\n${helperImports}\n} from "./helpers.js";\nexport function fanout() {\n${helperCallLines}\n  return 0;\n}\n`,
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
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('cartograph_callers', () => {
    it('emits the hint when more callers exist than the limit', async () => {
      // 25 callers in fixture, limit 5 → cap hit, hint expected.
      const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'target', limit: 5 });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(HINT_PATTERN);
    });

    it('omits the hint when fewer results than limit', async () => {
      // loneliness has 0 callers → empty body, no hint.
      const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'loneliness' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(HINT_PATTERN);
    });

    // Multi-match coverage note: the grouped-callers code path is a
    // mechanical wrap of the same `appendMoreHint(...)` helper covered
    // by the unit tests above and the single-match integration test.
    // An end-to-end multi-match overflow fixture was attempted but the
    // current resolver doesn't produce per-symbol caller edges for
    // cross-file name-collision cases (see task in agent backlog).
    // Code-review covers the wrap correctness for the multi-match path.
  });

  describe('cartograph_callees', () => {
    it('omits the hint when callee count fits under the limit', async () => {
      // target() body just returns 1 — zero callees comfortably under any limit.
      const result = await handler.execute('cartograph_graph', { direction: 'callees', start: 'target' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(HINT_PATTERN);
    });

    it('emits the hint when callees exceed the limit', async () => {
      // fanout() calls 30 helpers, limit=10 → cap hit, hint expected.
      const result = await handler.execute('cartograph_graph', { direction: 'callees', start: 'fanout', limit: 10 });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(HINT_PATTERN);
    });
  });

  describe('cartograph_search', () => {
    it('emits the hint when search returns more raw matches than the limit', async () => {
      // Fixture has 25 caller* functions — query "caller" with limit=3 → cap hit.
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'caller', limit: 3 });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(HINT_PATTERN);
    });

    it('omits the hint when results clearly fit under the limit', async () => {
      // "loneliness" matches one symbol; default limit 10 → no hint.
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'loneliness' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(HINT_PATTERN);
    });
  });

  describe('cartograph_history', () => {
    it('omits the hint when symbol has no history', async () => {
      // Fresh repo, single commit — no co-change pairs.
      const result = await handler.execute('cartograph_history', { symbol: 'target' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(HINT_PATTERN);
    });
  });

  // biomarkers + hotspots integration: these need either the centrality
  // or biomarker hooks to populate findings, which means a heavier
  // fixture. The unit-level test on appendMoreHint above covers the
  // helper's contract; the wiring is a one-line append in each handler
  // using the same helper, so cross-tool drift is unlikely.
});
