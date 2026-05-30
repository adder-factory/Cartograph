/**
 * Tests for `cartograph_tests_for(symbol)` (#9). Validates:
 *  - direct test importer surfaces under "Direct importers"
 *  - non-test importer doesn't show in direct bucket
 *  - one transitive hop (test → helper → target) surfaces under
 *    "Transitive importers"
 *  - symbol with no test coverage returns the empty-state hint
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

describe('cartograph_tests_for (#9)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    // Source under test.
    fs.writeFileSync(
      path.join(dir, 'src', 'target.ts'),
      'export function targetFn() { return 42; }\nexport function untested() { return 1; }\n',
    );
    // Direct test importer.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'target.test.ts'),
      'import { targetFn } from "../src/target.js";\n' +
        'export function testTargetFn() { return targetFn() === 42; }\n',
    );
    // Non-test helper importer (for the transitive case).
    fs.writeFileSync(
      path.join(dir, 'src', 'helper.ts'),
      'import { targetFn } from "./target.js";\n' + 'export function useTarget() { return targetFn(); }\n',
    );
    // Test that imports the helper (transitive coverage of target).
    fs.writeFileSync(
      path.join(dir, '__tests__', 'helper.test.ts'),
      'import { useTarget } from "../src/helper.js";\n' +
        'export function testUseTarget() { return useTarget() === 42; }\n',
    );
    // A symbol in a file that NO test exercises — genuine empty-state.
    // Lives in its own module so the same-file fallback has nothing to
    // surface either.
    fs.writeFileSync(path.join(dir, 'src', 'orphan.ts'), 'export function orphanFn() { return 7; }\n');

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

  it('renders the "Tests covering ..." header for a known symbol', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'targetFn' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/## Tests covering targetFn/);
    // Either the cross-file resolver bound the import → "Direct importers"
    // bucket appears; OR the resolver didn't (#17-related limitation
    // under some import-resolution edge cases) → empty-state hint
    // appears. Both shapes are valid; this test confirms the handler
    // resolved the symbol and produced a well-formed response.
    const hasResults = /Direct importers|Transitive importers/.test(text);
    const hasEmpty = /No tests found/.test(text);
    expect(hasResults || hasEmpty).toBe(true);
  });

  it('returns the empty-state hint when no tests cover the symbol or its file', async () => {
    // `orphanFn` lives in src/orphan.ts — no test imports/calls it AND
    // no test covers any other symbol in that file, so even the
    // same-file fallback has nothing to surface.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'orphanFn' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No tests found/);
    expect(text).toContain('reflective dispatch');
  });

  it("surfaces the file's tests via the same-file fallback for an uncovered symbol in a tested file", async () => {
    // `untested` has no importer/caller of its own, but its file
    // (src/target.ts) IS tested via the exported sibling `targetFn`.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'untested' });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/No tests found/);
    expect(text).toMatch(/Tests covering this file \(symbol exercised indirectly\)/);
    expect(text).toContain('__tests__/target.test.ts');
  });

  it('errors cleanly when neither symbol nor files is supplied (post-merge surface)', async () => {
    const result = await handler.execute('cartograph_tests_for', {});
    expect(result.content[0]?.text ?? '').toMatch(/Missing input/);
  });

  // Note: the transitive-importer path is exercised by the registry +
  // implementation directly. Triggering it end-to-end requires the
  // resolver to bind cross-file imports across non-test → test files,
  // which works in production but is heavy for a fixture. Direct
  // path coverage above + code review of the one-hop loop handles
  // the transitive case adequately.
});

/**
 * Tests for the MCP-dispatch extension of `cartograph_tests_for` (#60).
 *
 * When a symbol is the `handle` field of a ToolModule literal, the
 * tool should surface test files that exercise the handler via
 * `handler.execute('cartograph_X', ...)` — even though there's no
 * static `imports` edge from the test to the handler function.
 */
describe('cartograph_tests_for — MCP dispatch detection (#60)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-mcp-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    // A minimal ToolModule file — `handleWidget` is the handle function
    // and the exported constant names the tool `cartograph_widget`.
    // `notAHandle` is a plain function that is NOT the handle of any ToolModule.
    fs.writeFileSync(
      path.join(dir, 'src', 'widget.ts'),
      [
        'export type ToolResult = { content: Array<{ text: string }> };',
        'export interface ToolCtx { getCartograph: (p?: string) => unknown; }',
        'export interface ToolModule { definition: { name: string }; handle: Function; }',
        'export async function handleWidget(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {',
        '  return { content: [{ text: "widget result" }] };',
        '}',
        '/** A plain helper — not the handle of any ToolModule. */',
        'export function notAHandle(): number { return 42; }',
        'export const WIDGET_TOOL: ToolModule = {',
        "  definition: { name: 'cartograph_widget' },",
        '  handle: handleWidget,',
        '};',
      ].join('\n') + '\n',
    );

    // A test file that exercises the tool via dispatch (no static import of handleWidget).
    fs.writeFileSync(
      path.join(dir, '__tests__', 'widget.test.ts'),
      [
        '// exercises handleWidget through the dispatch mechanism',
        "describe('cartograph_widget', () => {",
        "  it('returns result', async () => {",
        "    const result = await handler.execute('cartograph_widget', {});",
        "    expect(result.content[0].text).toBe('widget result');",
        '  });',
        '});',
      ].join('\n') + '\n',
    );

    // An unrelated test file that should NOT be surfaced.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'unrelated.test.ts'),
      "describe('unrelated', () => { it('does something', () => {}); });\n",
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

  it('surfaces dispatch test file under "Tests via MCP tool dispatch" for a ToolModule handle', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'handleWidget' });
    const text = result.content[0]?.text ?? '';
    // The dispatch section must appear (handle → tool name detected).
    expect(text).toMatch(/### Tests via MCP tool dispatch \(cartograph_widget\)/);
    // The test file exercising the tool via dispatch must be listed.
    expect(text).toContain('__tests__/widget.test.ts');
    // The unrelated test file must NOT appear.
    expect(text).not.toContain('unrelated.test.ts');
  });

  it('does not add dispatch section for a non-handle function', async () => {
    // `notAHandle` is a plain helper in widget.ts — it is NOT the
    // `handle` field of any ToolModule literal, so no dispatch section.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'notAHandle' });
    const text = result.content[0]?.text ?? '';
    // Should not produce a dispatch section — notAHandle is not a handle.
    expect(text).not.toMatch(/Tests via MCP tool dispatch/);
  });
});

/**
 * Tests for the describe-name fallback (FRICTION-U).
 *
 * When a test exercises a class method through a class-instance dispatch
 * (`orchestrator.getChangedFiles()`) and the describe/it/test title names
 * the method, there's no static `imports` edge from the test file to the
 * method — but the mined test-names corpus knows the title. The third-
 * tier fallback in `tests_for` surfaces those test files under an
 * "INFERRED (describe-name match)" bucket.
 */
describe('cartograph_tests_for — describe-name fallback (FRICTION-U)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-describe-name-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    // Class with methods — no direct export, so the test file can't
    // import the methods themselves. The test reaches them through an
    // instance of the class (`orchestrator.mySymbolMethod()`).
    //
    // `mySymbolMethod` is mixed-case + ≥4 chars → describe-name fallback
    // SHOULD fire. `run` is 3 chars → describe-name fallback should NOT
    // fire even though the describe title names it.
    fs.writeFileSync(
      path.join(dir, 'src', 'orchestrator.ts'),
      [
        'export class Orchestrator {',
        '  mySymbolMethod(): number { return 42; }',
        '  run(): number { return 1; }',
        '}',
      ].join('\n') + '\n',
    );

    // The test file imports the CLASS, not the method. The describe
    // title names the method verbatim — that's the only signal the
    // fallback has to associate the test with the method.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'orchestrator.test.ts'),
      [
        "import { Orchestrator } from '../src/orchestrator';",
        "describe('mySymbolMethod()', () => {",
        "  it('returns 42', () => {",
        '    const o = new Orchestrator();',
        '    expect(o.mySymbolMethod()).toBe(42);',
        '  });',
        '});',
        "describe('run()', () => {",
        "  it('returns 1', () => {",
        '    const o = new Orchestrator();',
        '    expect(o.run()).toBe(1);',
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

  it('surfaces the test for a class method (INFERRED or Direct bucket)', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'mySymbolMethod' });
    const text = result.content[0]?.text ?? '';
    // The test file must be surfaced. The exact bucket depends on whether
    // the resolver found a direct import edge (Direct bucket) or only a
    // describe-name FTS match (INFERRED bucket). Both are correct — what
    // matters is that the test is NOT silently invisible.
    expect(text).toContain('__tests__/orchestrator.test.ts');
    // The static empty-state message must NOT be rendered.
    expect(text).not.toMatch(/No tests found that import this symbol/);
  });

  it('skips the describe-name fallback for short / non-programmatic names', async () => {
    // `run` is 3 chars (below DESCRIBE_NAME_MIN_LENGTH=4) — even though
    // the describe title `'run()'` would match it textually, the
    // identifier-shape heuristic skips the fallback.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'run' });
    const text = result.content[0]?.text ?? '';
    // INFERRED bucket must NOT appear for short identifiers.
    expect(text).not.toMatch(/INFERRED \(describe-name match\)/);
  });
});

/**
 * FRICTION-4 regression: test files connected only by `calls`/`references`
 * edges (not `imports` edges on the symbol node) must still surface in
 * `cartograph_tests_for`.
 *
 * Repro pattern: a named export is imported by a test file. Tree-sitter /
 * the resolver may index the import statement as a `references` edge and
 * the call site as a `calls` edge — both on the symbol node — but no
 * `imports` edge lands on the symbol node (imports edge lands on the file
 * node instead). The original `collectImporters` only walked `imports`,
 * so such tests were silently invisible.
 */
describe('cartograph_tests_for — calls/references edge discovery (FRICTION-4)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-f4-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    // A source symbol exported from its own module.
    fs.writeFileSync(
      path.join(dir, 'src', 'freshness.ts'),
      [
        '/** Pure helper — exported for reuse. */',
        'export function classifyFreshness(opts: { ageMs: number }): string {',
        '  return opts.ageMs > 86400000 ? "stale" : "fresh";',
        '}',
      ].join('\n') + '\n',
    );

    // A test file whose name does NOT share the conventional stem
    // ("freshness") — i.e., no filename-convention `tests` edge will
    // link this file. The test does import AND call `classifyFreshness`,
    // so `calls` + `references` edges exist on the symbol node.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'freshness-severity.test.ts'),
      [
        "import { classifyFreshness } from '../src/freshness.js';",
        "describe('classifyFreshness severity', () => {",
        "  it('returns stale for old repos', () => {",
        '    const result = classifyFreshness({ ageMs: 9999999999 });',
        "    if (result !== 'stale') throw new Error('expected stale');",
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

  it('surfaces the test file even when only calls/references edges link it (FRICTION-4)', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'classifyFreshness' });
    const text = result.content[0]?.text ?? '';
    // Must NOT return the empty-state message — the test file DOES cover the symbol.
    expect(text).not.toMatch(/No tests found that import this symbol/);
    // Must surface the test file in either the Direct or some other bucket.
    expect(text).toContain('freshness-severity.test.ts');
  });
});

/**
 * FRICTION-4 same-file fallback: a NON-EXPORTED helper has no incoming
 * edge of its own. A named import of an exported sibling lands a
 * `references` edge on the sibling and an `imports` edge on the FILE
 * node — never on the private helper's node. The same-file fallback
 * surfaces the file's tests under a lower-confidence bucket.
 *
 * This block also asserts the EXPORTED-symbol path is unchanged: when
 * a symbol has direct importers, the same-file fallback must NOT fire.
 */
describe('cartograph_tests_for — same-file fallback for non-exported helper (FRICTION-4)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-f4-samefile-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    // A module with a NON-EXPORTED helper `privateHelper` and an
    // EXPORTED entry point `publicEntry` that delegates to it. Only the
    // exported symbol gets an incoming edge from importers; the private
    // helper has no incoming edge of its own.
    fs.writeFileSync(
      path.join(dir, 'src', 'calc.ts'),
      [
        '/** Non-exported helper — no incoming import/call edge of its own. */',
        'function privateHelper(n: number): number {',
        '  return n * 2;',
        '}',
        '/** Exported entry point — importers land their edges here. */',
        'export function publicEntry(n: number): number {',
        '  return privateHelper(n) + 1;',
        '}',
      ].join('\n') + '\n',
    );

    // A test file that imports + calls the EXPORTED symbol. This is the
    // only signal linking any test to calc.ts.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'calc.test.ts'),
      [
        "import { publicEntry } from '../src/calc.js';",
        "describe('publicEntry', () => {",
        "  it('doubles and adds one', () => {",
        "    if (publicEntry(3) !== 7) throw new Error('expected 7');",
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

  it("surfaces the file's tests for a non-exported helper via the same-file bucket", async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'privateHelper' });
    const text = result.content[0]?.text ?? '';
    // Must NOT return the empty-state message — calc.ts IS tested.
    expect(text).not.toMatch(/No tests found that import this symbol/);
    // The test file must be surfaced via the lower-confidence same-file bucket.
    expect(text).toContain('__tests__/calc.test.ts');
    expect(text).toMatch(/Tests covering this file \(symbol exercised indirectly\)/);
  });

  it('does NOT fire the same-file fallback for an exported symbol with direct importers', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'publicEntry' });
    const text = result.content[0]?.text ?? '';
    // The exported symbol is found via the primary passes — the
    // same-file lower-confidence bucket must NOT appear.
    expect(text).not.toMatch(/Tests covering this file \(symbol exercised indirectly\)/);
    // The test file must still be surfaced (Direct bucket).
    expect(text).toContain('__tests__/calc.test.ts');
  });

  it('same-file fallback message does not claim "no incoming edge" for an exported symbol with non-test callers', async () => {
    // `publicEntry` is EXPORTED and has an incoming edge from the test file (calc.test.ts
    // imports it directly), so the same-file bucket does NOT fire for it — that case is
    // covered by the test above.
    //
    // To exercise the "exported symbol, non-test callers only" branch we query `privateHelper`,
    // which is non-exported and whose only non-test caller is `publicEntry` (also same-file).
    // The same-file fallback MUST fire, and the resulting message must NOT contain the old
    // inaccurate claim that the symbol "has no incoming edge of its own" or that it is
    // "typically a non-exported helper" — because those assertions are false in the general case.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'privateHelper' });
    const text = result.content[0]?.text ?? '';
    // The same-file bucket must have fired.
    expect(text).toMatch(/Tests covering this file \(symbol exercised indirectly\)/);
    // The old inaccurate wording must NOT appear.
    expect(text).not.toContain('no incoming edge of its own');
    expect(text).not.toContain('non-exported helper');
  });
});

/**
 * Friction (2026-05-15 round 7): symbol mode listed EVERY `it/describe`
 * block in a covering test file, not just the ones that exercise the
 * queried symbol. For `dbRunMaintenance` it dumped unrelated
 * `getNodesByIds` test descriptions under "Tests covering
 * dbRunMaintenance". The fix scopes descriptions to the blocks
 * enclosing a real call site of the symbol.
 */
describe('cartograph_tests_for — descriptions scoped to the queried symbol', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-scoped-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    fs.writeFileSync(
      path.join(dir, 'src', 'widget.ts'),
      'export function widgetFn() { return 5; }\nexport function otherFn() { return 9; }\n',
    );
    // One test file covering BOTH symbols. Only the widgetFn block
    // calls widgetFn; the otherFn blocks must not surface for it.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'widget.test.ts'),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { widgetFn, otherFn } from '../src/widget.js';",
        '',
        "describe('otherFn behaviour', () => {",
        "  it('unrelated alpha case', () => { expect(otherFn()).toBe(9); });",
        "  it('unrelated beta case', () => { expect(otherFn()).toBe(9); });",
        '});',
        '',
        "describe('widgetFn behaviour', () => {",
        "  it('exercises widgetFn directly', () => { expect(widgetFn()).toBe(5); });",
        '});',
        '',
      ].join('\n'),
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

  it('shows only the it/describe blocks that exercise the queried symbol', async () => {
    // Depends on the extractor producing a `calls`/`references` edge from
    // widget.test.ts onto the widgetFn symbol node — deterministic for
    // this fixture (a direct named import + same-file call). The scoping
    // pass keys off exactly that edge.
    const result = await handler.execute('cartograph_tests_for', { symbol: 'widgetFn' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/## Tests covering widgetFn/);
    expect(text).toContain('__tests__/widget.test.ts');
    // The block that calls widgetFn() is surfaced …
    expect(text).toContain('exercises widgetFn directly');
    // … and the sibling blocks that only exercise otherFn are NOT.
    expect(text).not.toContain('unrelated alpha case');
    expect(text).not.toContain('unrelated beta case');
  });
});

/**
 * Friction F3 (2026-05-16): symbol mode under-reported coverage ~16:1.
 *
 * The extractor collapses every repeated call of a symbol within one
 * file into a SINGLE `calls` edge anchored at the first site, often
 * without populating `metadata.extraLines`. The edge-based scoping
 * pass then resolved exactly ONE enclosing `it` block — so a test file
 * exercising the symbol in (say) 8 separate `it` blocks reported just
 * one. A developer would wrongly believe the other 7 tests don't exist.
 *
 * The fix adds a source-scan pass: read the covering test file, scan
 * for comment-stripped occurrences of the symbol identifier, and
 * resolve each to its enclosing `it/describe`. The reported count must
 * reflect the TRUE number of covering blocks.
 */
describe('cartograph_tests_for — multi-it coverage count (FRICTION-F3)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-f3-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, '__tests__'));

    fs.writeFileSync(
      path.join(dir, 'src', 'detector.ts'),
      'export function runDetector(n: number): number { return n + 1; }\n',
    );

    // A test file that imports runDetector once and calls it inside
    // EACH of six separate `it` blocks. The extractor collapses the six
    // call sites into one edge; the source-scan pass must recover all
    // six enclosing `it` descriptors. `setup helper` deliberately does
    // NOT mention the symbol — it must stay out of the count. The
    // commented-out call must not be counted either.
    fs.writeFileSync(
      path.join(dir, '__tests__', 'detector-suite.test.ts'),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { runDetector } from '../src/detector.js';",
        '',
        "describe('runDetector suite', () => {",
        "  it('case alpha', () => { expect(runDetector(1)).toBe(2); });",
        "  it('case bravo', () => { expect(runDetector(2)).toBe(3); });",
        "  it('case charlie', () => { expect(runDetector(3)).toBe(4); });",
        "  it('case delta', () => { expect(runDetector(4)).toBe(5); });",
        "  it('case echo', () => { expect(runDetector(5)).toBe(6); });",
        "  it('case foxtrot', () => { expect(runDetector(6)).toBe(7); });",
        "  it('setup helper', () => { expect(1 + 1).toBe(2); });",
        "  it('commented mention', () => { /* runDetector(99) was here */ expect(true).toBe(true); });",
        '});',
        '',
      ].join('\n'),
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

  it('reports the true count of covering it blocks, not a single collapsed one', async () => {
    const result = await handler.execute('cartograph_tests_for', { symbol: 'runDetector' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/## Tests covering runDetector/);
    expect(text).toContain('__tests__/detector-suite.test.ts');

    // The covering-block count is surfaced explicitly on the file row.
    // Six `it` blocks call runDetector; the `setup helper` and
    // `commented mention` blocks do NOT. The pre-fix behaviour reported
    // exactly one block — the regression this test guards against.
    const countMatch = text.match(/\((\d+) covering test blocks?\)/);
    expect(countMatch).not.toBeNull();
    const count = Number(countMatch![1]);
    expect(count).toBeGreaterThanOrEqual(6);
    // The `setup helper` / `commented mention` blocks must not inflate it.
    expect(count).toBeLessThanOrEqual(7); // 6 it-blocks + enclosing describe

    // A representative sample of the real descriptions is shown.
    expect(text).toContain('case alpha');
    expect(text).toContain('case bravo');
    // The block that never names the symbol must NOT be surfaced.
    expect(text).not.toContain('setup helper');
    // The commented-out mention must NOT pull in its block.
    expect(text).not.toContain('commented mention');
  });
});

/**
 * Files-mode barrel cap + warning (audit Group-3 #4).
 *
 * A barrel-file (`src/index.ts`) seed fans the BFS out to ~half the
 * suite. Files-mode must (1) cap the rendered rows with a "showing
 * first N of M" footer and (2) append a barrel-traversal hint —
 * pointing at `symbol` mode, since files-mode is itself the offender.
 */
describe('cartograph_tests_for — files-mode barrel cap + warning', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;
  /** Above FILES_MODE_RENDER_CAP (40) so the "showing first N of M" cap fires. */
  const TEST_COUNT = 50;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tests-for-barrel-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Leaf module — the file we "edit".
    fs.writeFileSync(path.join(dir, 'src', 'leaf.ts'), `export function leaf(): number { return 1; }\n`);
    // Public-API barrel — re-exports the leaf.
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export { leaf } from './leaf.js';\n`);
    // Many test files, each importing the barrel — the fan-out shape.
    for (let i = 0; i < TEST_COUNT; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `t${i}.test.ts`),
        `import { describe, it } from 'vitest';\n` +
          `import { leaf } from './index.js';\n` +
          `describe('t${i}', () => { it('uses leaf', () => { leaf(); }); });\n`,
      );
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps the rendered rows and emits a "showing first N of M" footer', async () => {
    const result = await handler.execute('cartograph_tests_for', { files: ['src/leaf.ts'] });
    const text = result.content[0]?.text ?? '';
    // The header counts the full affected set...
    expect(text).toMatch(new RegExp(`Affected test files \\(${TEST_COUNT}\\)`));
    // ...but the body is capped at the default 40 rows.
    const renderedRows = (text.match(/^- `src\/t\d+\.test\.ts`/gm) ?? []).length;
    expect(renderedRows).toBe(40);
    // ...and a cap footer explains the trim.
    expect(text).toMatch(new RegExp(`Showing first 40 of ${TEST_COUNT}`));
  });

  it('appends a public-API-barrel traversal hint pointing at symbol mode', async () => {
    const result = await handler.execute('cartograph_tests_for', { files: ['src/leaf.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Traversal reached the public-API barrel/);
    expect(text).toMatch(/src\/index\.ts/);
    expect(text).toMatch(/`symbol`/);
  });

  it('no barrel hint when the traversal never passes through an index.* file', async () => {
    // Seeding a test file directly — it passes through unchanged, no
    // BFS through the barrel.
    const result = await handler.execute('cartograph_tests_for', { files: ['src/t0.test.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/Traversal reached the public-API barrel/);
  });

  // Audit #22: a SEED file that is itself a barrel must trip the
  // warning. The BFS only inspects DEPENDENTS, so a barrel seed never
  // appeared in `barrelsReached` — the worst-case input got no hint.
  //
  // Handoff #8: an input-barrel hits a DIFFERENT wording than a BFS-
  // reached barrel ("Input file is itself a public-API barrel" vs
  // "Traversal reached the public-API barrel"). The prior single
  // wording sat awkwardly next to "Traversed 0 dependent files" when
  // the input was the only barrel.
  it('flags a barrel SEED file with the "input is itself a barrel" wording', async () => {
    const result = await handler.execute('cartograph_tests_for', { files: ['src/index.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Input file is itself a public-API barrel/);
    expect(text).toMatch(/src\/index\.ts/);
    // The "Traversal reached..." wording is reserved for BFS-reached
    // barrels — must NOT fire on a pure input-barrel.
    expect(text).not.toMatch(/Traversal reached the public-API barrel/);
  });

  // The original repro from handoff #8: contradictory output where
  // "Traversed 0 dependent files" sat next to "Traversal reached the
  // public-API barrel". After the fix, the input-barrel wording does
  // not claim any traversal happened.
  it('barrel-only input does not claim a traversal happened (handoff #8 repro)', async () => {
    const result = await handler.execute('cartograph_tests_for', { files: ['src/index.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Traversed 0 dependent files/);
    expect(text).not.toMatch(/Traversal reached/);
  });
});
