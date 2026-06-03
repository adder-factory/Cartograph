/**
 * cartograph_node — multi-symbol input + inline expansions
 * (round-trip-reduction items #1 + #2).
 *
 * Locks in:
 *  - Backwards compatibility: single-symbol path renders the same
 *    card it always did, no header, no horizontal rule.
 *  - `symbols: [a, b]` returns both cards joined by a horizontal rule
 *    under a count header.
 *  - Duplicate symbol names that resolve to the same node dedup.
 *  - A mix of found / not-found symbols renders found cards plus an
 *    inline "not found" stub per missing name AND the count header
 *    surfaces the not-found tally.
 *  - Both `symbol` and `symbols` set is rejected.
 *  - `symbols` over the cap is rejected.
 *  - Non-string entry in `symbols` is rejected (boundary validator).
 *  - `includeCallers` folds a callers section.
 *  - `includeCallees` folds a callees section.
 *  - `includeBiomarkers` reports a Code Health score (10/10 on a
 *    pristine fixture — exercises the no-findings path).
 *  - `includeTests` folds a tests section (empty when no test file
 *    imports — exercises the empty-state branch).
 *  - All four flags compose in one call.
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

describe('cartograph_node — multi-symbol + inline expansions', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-multi-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Two source symbols and one caller — gives us a realistic
    // callers/callees fan-out for the inline-expansion tests.
    fs.writeFileSync(
      path.join(dir, 'src', 'core.ts'),
      [
        'export function alpha(): number { return 1; }',
        'export function beta(): number { return 2; }',
        'export function longBody(): number {',
        ...Array.from({ length: 45 }, (_, i) => `  const value${i} = ${i};`),
        '  return value44;',
        '}',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'caller.ts'),
      ['import { alpha, beta } from "./core.js";', 'export function gamma(): number { return alpha() + beta(); }'].join(
        '\n',
      ) + '\n',
    );
    fs.writeFileSync(path.join(dir, 'src', 'sync-a.ts'), 'export function sync(): string { return "a"; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'sync-b.ts'), 'export function sync(): string { return "b"; }\n');
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

  // ---------------------------------------------------------------
  // Multi-symbol input shape
  // ---------------------------------------------------------------

  it('single-symbol path still renders one card with no count header', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'alpha' });
    const text = result.content[0]?.text ?? '';
    // Card header present.
    expect(text).toMatch(/## alpha/);
    // No multi-symbol count header.
    expect(text).not.toMatch(/^# \d+ symbol/m);
    // No horizontal rule (single card).
    expect(text).not.toMatch(/^---$/m);
  });

  it('ambiguous sync node lookup lists stable candidate ids and a follow-up example', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'sync' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('2 symbols named "sync"');
    expect(text).toContain('**Candidates:**');
    expect(text).toMatch(/\[id: `n_[0-9a-f]{8}`\] `sync` \(function\) — `src\/sync-a\.ts:1`/);
    expect(text).toMatch(/\[id: `n_[0-9a-f]{8}`\] `sync` \(function\) — `src\/sync-b\.ts:1`/);
    expect(text).toMatch(/cartograph_node\(\{symbol: "n_[0-9a-f]{8}"\}\)/);
  });

  it('ambiguous sync graph lookup surfaces the same candidate ids', async () => {
    const result = await handler.execute('cartograph_graph', { start: 'sync', direction: 'callers' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('"sync" resolves to multiple symbols');
    expect(text).toContain('Aggregated results across 2 symbols named "sync"');
    expect(text).toContain('**Candidates:**');
    expect(text).toMatch(/\[id: `n_[0-9a-f]{8}`\] `sync` \(function\) — `src\/sync-a\.ts:1`/);
    expect(text).toMatch(/\[id: `n_[0-9a-f]{8}`\] `sync` \(function\) — `src\/sync-b\.ts:1`/);
    expect(text).toMatch(/cartograph_node\(\{symbol: "n_[0-9a-f]{8}"\}\)/);
  });

  it('code preview truncates long bodies and full detail renders the complete body', async () => {
    const preview = await handler.execute('cartograph_node', { symbol: 'longBody', code: true });
    const previewText = preview.content[0]?.text ?? '';
    expect(previewText).toContain('## longBody');
    expect(previewText).toContain('```typescript');
    expect(previewText).toContain('const value25 = 25;');
    expect(previewText).not.toContain('const value44 = 44;');
    expect(previewText).toContain('Showing first 30 of');
    expect(previewText).toContain('Pass `detail: "full"`');

    const full = await handler.execute('cartograph_node', { symbol: 'longBody', code: true, detail: 'full' });
    const fullText = full.content[0]?.text ?? '';
    expect(fullText).toContain('const value44 = 44;');
    expect(fullText).not.toContain('Showing first 30');
  });

  it('code output warns when the source file changed after indexing', async () => {
    fs.appendFileSync(path.join(dir, 'src', 'core.ts'), '\nexport const changedAfterIndex = true;\n');

    const result = await handler.execute('cartograph_node', { symbol: 'alpha', code: true, allowStale: true });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('source from indexed snapshot');
    expect(text).toContain('modified since last index');
    expect(text).toContain('Run `cartograph admin sync`');
    expect(text).toContain('return 1');
  });

  it('symbols: [alpha, beta] returns both cards under a count header', async () => {
    const result = await handler.execute('cartograph_node', { symbols: ['alpha', 'beta'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^# 2 symbols resolved/m);
    expect(text).toMatch(/## alpha/);
    expect(text).toMatch(/## beta/);
    // Cards separated by a horizontal rule.
    expect(text).toMatch(/^---$/m);
  });

  it('symbols: [alpha, alpha] dedups (one card, header reflects merge)', async () => {
    const result = await handler.execute('cartograph_node', { symbols: ['alpha', 'alpha'] });
    const text = result.content[0]?.text ?? '';
    // One card emitted.
    const cardMatches = text.match(/^## alpha/gm) ?? [];
    expect(cardMatches.length).toBe(1);
    // Count header acknowledges the merge.
    expect(text).toMatch(/duplicate input/);
  });

  it('symbols: [alpha, doesNotExist] renders the found card + a not-found stub', async () => {
    const result = await handler.execute('cartograph_node', {
      symbols: ['alpha', 'doesNotExist'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/## alpha/);
    expect(text).toMatch(/## doesNotExist/);
    expect(text).toMatch(/not found|No symbol/i);
    expect(text).toMatch(/1 not found/);
  });

  it('batched freshness note is call-scoped — under a "Batch note" rule, not flush to the last card (#15)', async () => {
    // A batch with one unresolved symbol emits a freshness hint. It must
    // render under a `---` rule + a "Batch note" lead-in so it reads as a
    // note about the whole call — not as an explanation for why the last
    // (not-found) symbol missed.
    const result = await handler.execute('cartograph_node', {
      symbols: ['alpha', 'doesNotExist'],
    });
    const text = result.content[0]?.text ?? '';
    // The footer is present and explicitly call-scoped.
    expect(text).toMatch(/\*\*Batch note\*\* \(applies to the whole call/);
    // The freshness line is NOT flush against the not-found card's
    // "Did you mean" / "no symbol" block — the "Batch note" lead-in
    // separates them.
    const lines = text.split('\n');
    const noteIdx = lines.findIndex((l) => l.includes('**Batch note**'));
    expect(noteIdx).toBeGreaterThan(0);
    // A `---` rule precedes the Batch note section.
    const ruleBefore = lines.slice(0, noteIdx).some((l) => l.trim() === '---');
    expect(ruleBefore).toBe(true);
    // The freshness banner line itself comes AFTER the lead-in.
    const freshnessIdx = lines.findIndex((l) => /Index (in sync|lagging)|Uncommitted changes/.test(l));
    if (freshnessIdx !== -1) {
      expect(freshnessIdx).toBeGreaterThan(noteIdx);
    }
  });

  it('all-resolved batch emits no Batch-note footer', async () => {
    const result = await handler.execute('cartograph_node', { symbols: ['alpha', 'beta'] });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/\*\*Batch note\*\*/);
  });

  it('rejects when both symbol and symbols are set', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'alpha',
      symbols: ['beta'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/either `symbol` .* or `symbols`/);
  });

  it('rejects empty symbols array', async () => {
    // batchedSymbols enforces `.min(1)` so an empty array is rejected at
    // the Zod boundary with the standard array-min message. Pre-structural-
    // fix-A the message read "non-empty"; the shared schema now produces
    // "must have at least 1 item(s)" uniformly across every batched tool.
    const result = await handler.execute('cartograph_node', { symbols: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at least 1 item/);
  });

  it('rejects oversized symbols array', async () => {
    // Generate 21 distinct names — over the MAX_SYMBOLS=20 cap.
    const overflow = Array.from({ length: 21 }, (_, i) => `s${i}`);
    const result = await handler.execute('cartograph_node', { symbols: overflow });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at most 20/);
  });

  it('rejects non-string entries in symbols (boundary validator)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handler.execute('cartograph_node', { symbols: ['alpha', 42 as any] });
    expect(result.isError).toBe(true);
    // Boundary validator catches the type mismatch before the handler
    // sees the input — the message names the offending index.
    expect(result.content[0]?.text).toMatch(/symbols\[1\]/);
  });

  // ---------------------------------------------------------------
  // Inline expansions
  // ---------------------------------------------------------------

  it('includeCallers folds a callers section', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'alpha',
      includeCallers: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\*\*Callers\*\*/);
    // gamma calls alpha, so gamma should appear in the callers list.
    expect(text).toContain('gamma');
  });

  it('includeCallees folds a callees section', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'gamma',
      includeCallees: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\*\*Callees\*\*/);
    // gamma calls alpha and beta.
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  it('includeBiomarkers reports Code Health (no findings on a clean function)', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'alpha',
      includeBiomarkers: true,
    });
    const text = result.content[0]?.text ?? '';
    // The "no findings" branch uses `**Biomarkers:** _...._`; the
    // populated branch uses `**Biomarkers** Code Health N/10 (...)`.
    // Anchor the assertion so it matches either form.
    expect(text).toMatch(/\*\*Biomarkers/);
    // alpha is a one-liner with no findings — score 10/10.
    expect(text).toMatch(/Code Health 10\/10/);
  });

  it('includeTests folds a tests section (empty on this fixture)', async () => {
    // Fixture has no `*.test.ts` file, so the empty-state branch fires.
    const result = await handler.execute('cartograph_node', {
      symbol: 'alpha',
      includeTests: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\*\*Tests:\*\*/);
    expect(text).toMatch(/no direct test callers or importers/i);
  });

  it('all four expansion flags compose in one call', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'alpha',
      includeCallers: true,
      includeCallees: true,
      includeBiomarkers: true,
      includeTests: true,
    });
    const text = result.content[0]?.text ?? '';
    // Empty-state and populated-state sections render with slightly
    // different bold markers (`**X**` vs `**X:**`); anchor on the
    // section name without closing asterisks so either form matches.
    expect(text).toMatch(/\*\*Callers/);
    expect(text).toMatch(/\*\*Callees/);
    expect(text).toMatch(/\*\*Biomarkers/);
    expect(text).toMatch(/\*\*Tests/);
  });

  it('expansions apply per symbol in multi-symbol mode', async () => {
    const result = await handler.execute('cartograph_node', {
      symbols: ['alpha', 'beta'],
      includeCallers: true,
    });
    const text = result.content[0]?.text ?? '';
    // Two callers sections — one per card. Anchor on the section
    // name (handles both empty-state and populated-state forms).
    const matches = text.match(/\*\*Callers/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

// ---------------------------------------------------------------
// Task #20 — class-node callers include instantiates edges
// ---------------------------------------------------------------
/**
 * Regression suite for the fix in `renderCallersSection` (node.ts):
 *
 * For class / interface / type_alias / struct / enum / trait / protocol /
 * component / module kinds the section now merges `instantiates` +
 * `type_of` + `returns` + `extends` + `implements` incoming edges
 * alongside the regular call-predecessor edges returned by
 * `traverser.getCallers`. This ensures `new Foo(...)` construction
 * sites surface under "Callers" in the node card — matching the
 * standalone `cartograph_callers` tool behaviour.
 *
 * Fixture:
 *  - `Widget` class (class.ts)
 *  - `makeWidget()` and `makeAnotherWidget()` both do `new Widget()`
 *  - `onlyImports.ts` imports Widget but never calls `new Widget()`
 *
 * The two instantiating functions MUST appear in the callers section.
 * The import-only file may or may not appear (it contributes a plain
 * `imports` edge which the traverser already returns); we assert on the
 * instantiating functions, not the import-only file, to keep the test
 * behaviour-focused rather than tied to edge-kind enumeration details.
 */
describe('cartograph_node — class callers include instantiates edges (task #20)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-class-callers-'));
    fs.mkdirSync(path.join(dir, 'src'));

    // The class under test.
    fs.writeFileSync(
      path.join(dir, 'src', 'class.ts'),
      [
        'export class Widget {',
        '  constructor(public value: number) {}',
        '  render(): string { return `widget:${this.value}`; }',
        '}',
      ].join('\n') + '\n',
    );

    // Two functions that construct a Widget — these should appear in
    // "Callers" when includeCallers is true on the Widget node.
    fs.writeFileSync(
      path.join(dir, 'src', 'factory.ts'),
      [
        'import { Widget } from "./class.js";',
        'export function makeWidget(): Widget { return new Widget(1); }',
        'export function makeAnotherWidget(): Widget { return new Widget(2); }',
      ].join('\n') + '\n',
    );

    // A file that only imports Widget but never instantiates it.
    // It contributes a plain `imports` edge (not `instantiates`).
    // We deliberately don't assert on it so the test stays robust
    // across future changes to how import-only edges are handled.
    fs.writeFileSync(
      path.join(dir, 'src', 'onlyImports.ts'),
      [
        'import { Widget } from "./class.js";',
        'export function describeWidget(w: Widget): string { return w.render(); }',
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

  it('class node with includeCallers: true shows instantiating functions', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'Widget',
      includeCallers: true,
    });
    const text = result.content[0]?.text ?? '';
    // The Callers section must be present.
    expect(text).toMatch(/\*\*Callers/);
    // Both construction-site functions must appear (via instantiates edge).
    expect(text).toContain('makeWidget');
    expect(text).toContain('makeAnotherWidget');
    // Each row must be annotated with the edge kind so the caller can
    // distinguish "instantiated by" from "imported by".
    expect(text).toContain('via instantiates');
  });

  it('function node with includeCallers: true is unchanged (regression guard)', async () => {
    // makeWidget is a plain function — its callers come from call edges,
    // NOT instantiates/type-usage edges. The output must NOT contain
    // "via instantiates" rows (nothing instantiates a function).
    const result = await handler.execute('cartograph_node', {
      symbol: 'makeWidget',
      includeCallers: true,
    });
    const text = result.content[0]?.text ?? '';
    // Callers section present (even if empty, the label renders).
    expect(text).toMatch(/\*\*Callers/);
    // No spurious instantiates rows for a plain function node.
    expect(text).not.toContain('via instantiates');
  });
});

// ---------------------------------------------------------------
// Friction F-M (2026-05-11) — node vs graph caller-count parity
// ---------------------------------------------------------------
/**
 * Regression guard for the caller-dedup inconsistency caught 2026-05-11:
 *
 * `cartograph_node({includeCallers: true})` was returning the raw rows
 * from `traverser.getCallers` verbatim, so a caller with multiple
 * incoming edges (e.g. one `calls` edge AND one `references` edge from
 * the same source file) appeared TWICE in the Callers list. Meanwhile
 * `cartograph_graph({direction: 'callers'})` dedups by `node.id` in
 * `_callers.ts::collectCallers`, so it reported a smaller count for the
 * same symbol.
 *
 * The fix collapses multi-edge same-source rows into one entry with all
 * edge kinds listed inline (`via calls, references`). After the fix the
 * two tools agree on count and row set for any symbol — confirmed here
 * with a fixture where the test file naturally produces both `calls`
 * and `references` edges to the same target.
 */
describe('cartograph_node ↔ cartograph_graph — caller-count parity (friction F-M)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-graph-parity-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Target function lives in core.ts.
    fs.writeFileSync(
      path.join(dir, 'src', 'core.ts'),
      ['export function helper(): number { return 42; }'].join('\n') + '\n',
    );
    // caller.ts calls helper TWICE — extractor dedups (caller, callee, calls)
    // into one edge with siteCount=2, so this contributes ONE `calls` edge.
    fs.writeFileSync(
      path.join(dir, 'src', 'caller.ts'),
      ['import { helper } from "./core.js";', 'export function gamma(): number { return helper() + helper(); }'].join(
        '\n',
      ) + '\n',
    );
    // refOnly.ts references helper as a value (function-typed local) without
    // calling it — produces a `references` edge to helper from this file.
    fs.writeFileSync(
      path.join(dir, 'src', 'refOnly.ts'),
      ['import { helper } from "./core.js";', 'export const fn: () => number = helper;'].join('\n') + '\n',
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

  it('cartograph_node and cartograph_graph report the same caller count', async () => {
    // Pull both views of "callers of helper".
    const nodeResult = await handler.execute('cartograph_node', {
      symbol: 'helper',
      includeCallers: true,
    });
    const graphResult = await handler.execute('cartograph_graph', {
      direction: 'callers',
      start: 'helper',
    });
    const nodeText = nodeResult.content[0]?.text ?? '';
    const graphText = graphResult.content[0]?.text ?? '';

    // node.ts header: `**Callers** (N total, showing top M):` or `**Callers** (N):`
    const nodeMatch = /\*\*Callers\*\* \((\d+)/.exec(nodeText);
    expect(nodeMatch).not.toBeNull();
    const nodeCount = nodeMatch ? Number.parseInt(nodeMatch[1]!, 10) : Number.NaN;

    // graph header: `## Callers of helper (N found)` or similar.
    const graphMatch = /Callers of helper \((\d+)/.exec(graphText);
    expect(graphMatch).not.toBeNull();
    const graphCount = graphMatch ? Number.parseInt(graphMatch[1]!, 10) : Number.NaN;

    expect(nodeCount).toBe(graphCount);
  });

  it('multi-edge same-source caller appears once with kinds listed inline', async () => {
    // Build a scenario where one source has BOTH a calls edge and a
    // references edge to helper, by manually inserting a `references` edge
    // from gamma → helper alongside the existing `calls` edge.
    const gammaRow = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'gamma' LIMIT 1`).get() as
      | { id: string }
      | undefined;
    const helperRow = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'helper' LIMIT 1`).get() as
      | { id: string }
      | undefined;
    if (!gammaRow || !helperRow) throw new Error('parity fixture: missing nodes');
    // Inject a synthetic `references` edge to simulate the real-world
    // pattern that caused friction F-M.
    cg.queries.db
      .prepare(
        `INSERT OR IGNORE INTO edges (source, target, kind, confidence) VALUES (?, ?, 'references', 'EXTRACTED')`,
      )
      .run(gammaRow.id, helperRow.id);

    const nodeResult = await handler.execute('cartograph_node', {
      symbol: 'helper',
      includeCallers: true,
    });
    const text = nodeResult.content[0]?.text ?? '';

    // gamma must appear EXACTLY once even though it has two incoming
    // edge kinds to helper (`calls` from the source code + the synthetic
    // `references` we just inserted).
    const gammaRows = (text.match(/^- gamma /gm) ?? []).length;
    expect(gammaRows).toBe(1);
    // Both edge kinds must be listed inline.
    expect(text).toMatch(/gamma .* via .*calls.*references|gamma .* via .*references.*calls/);
  });
});
