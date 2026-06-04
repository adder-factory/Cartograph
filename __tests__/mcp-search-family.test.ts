/**
 * Tests for the consolidated `cartograph_find({by, mode})` family,
 * specifically the `by: 'name'` axis (formerly `cartograph_search`
 * pre-2026-05-11-three-tool-merge; before that the
 * `cartograph_search({mode})` consolidation of agentic-backlog #7-3).
 *
 * The fuzzy mode is exercised by `mcp-search-fuzzy.test.ts` and
 * the semantic mode by `mcp-llm-visibility.test.ts`. This file covers:
 *  - registry surfaces the consolidated tool name and no longer
 *    carries the legacy `cartograph_search` / `cartograph_search_fuzzy`
 *  - `mode='exact'` is the default for `by:'name'` and behaves as before
 *  - invalid `mode` returns a clean error
 *  - the family handler dispatches to the fuzzy branch when
 *    `mode='fuzzy'` (positive smoke; depth covered elsewhere)
 *  - semantic mode without `symbol` or `query` errors with a
 *    discoverable message
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_find by=name family (post-2026-05-11 merge)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-fam-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function alpha(): number { return 1; }\nexport class Apex { value = 1; }\n',
    );
    fs.writeFileSync(path.join(dir, 'lib', 'a.ts'), 'export function alpha(): number { return 2; }\n');
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

  it('registry surfaces cartograph_find; legacy cartograph_search / cartograph_search_fuzzy are gone', () => {
    const names = getToolModules().map((m) => m.definition.name);
    expect(names).toContain('cartograph_find');
    expect(names).not.toContain('cartograph_search');
    expect(names).not.toContain('cartograph_search_fuzzy');
    expect(names).not.toContain('cartograph_grep');
    expect(names).not.toContain('cartograph_string_refs');
    // Note: `cartograph_similar` was folded into `cartograph_graph` as
    // `direction: 'similar'` on 2026-05-14 (FRICTION-46), freeing one
    // slot against the 45-tool registry cap. The standalone tool name
    // must no longer appear in the registry; the handler logic is now
    // reached via `cartograph_graph({direction: 'similar'})`.
    expect(names).not.toContain('cartograph_similar');
    expect(names).toContain('cartograph_graph');
  });

  it("default mode (no `mode` arg) behaves as 'exact' — FTS results", async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    const text = result.content[0]?.text ?? '';
    // Header is the existing exact-search shape.
    expect(text).toMatch(/^## Search Results/);
    expect(text).toContain('alpha');
  });

  it("explicit mode='exact' matches the default", async () => {
    const def = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    const exact = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', mode: 'exact' });
    expect(exact.content[0]?.text ?? '').toBe(def.content[0]?.text ?? '');
  });

  it("mode='exact' honors top-level pathFilter", async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'alpha',
      mode: 'exact',
      pathFilter: 'lib/',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('lib/a.ts');
    expect(text).not.toContain('src/a.ts');
  });

  it("mode='exact' treats top-level pathFilter as a prefix, not a substring", async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'alpha',
      mode: 'exact',
      pathFilter: 'a.ts',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('lib/a.ts');
    expect(text).not.toContain('src/a.ts');
  });

  it('keeps inline rich-query path: as a substring filter', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'alpha path:a.ts',
      mode: 'exact',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('lib/a.ts');
    expect(text).toContain('src/a.ts');
  });

  it('invalid `mode` returns a discoverable error', async () => {
    // Post structural-campaign-P4: `mode` is a Zod `z.enum`, so an
    // unknown value is rejected at the dispatch boundary with the
    // shared `formatZodError` wording — still discoverable (names the
    // valid modes and echoes the bad value).
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', mode: 'banana' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/mode: must be one of 'exact', 'fuzzy', 'semantic', 'intent'/);
    expect(text).toContain('"banana"');
  });

  it("mode='fuzzy' dispatches to the fuzzy branch (smoke)", async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alfa', mode: 'fuzzy' });
    const text = result.content[0]?.text ?? '';
    // Fuzzy header shape, NOT the exact-search header.
    expect(text).toMatch(/^## Fuzzy search/);
  });

  it("mode='semantic' without symbol/query returns the per-mode validation error", async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', mode: 'semantic' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/mode=semantic/);
    expect(text).toMatch(/either `symbol`.*or `query`/);
  });

  it('OR-disjunction over bare identifiers auto-recovers to the union view', async () => {
    // Standalone `AND/OR/NOT/NEAR` are stripped by the dispatcher and the
    // bare-token residue routes through the per-token union view, with a
    // one-line note flagging the recovery. Same outcome whether the
    // underlying symbols exist or not — here neither does, so both
    // groups render with 0 hits.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'totallyAbsentSymbol OR alsoAbsent',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Detected boolean operator \(OR\)/);
    expect(text).toMatch(/Stripped and routed to the per-token union view/);
    expect(text).toMatch(/^## Exact match union \(2 queries/m);
    expect(text).toMatch(/### totallyAbsentSymbol \(0 hits\)/);
    expect(text).toMatch(/### alsoAbsent \(0 hits\)/);
  });

  it('compact + fields emits pipe-delimited rows with only the requested columns', async () => {
    // Default markdown shape uses `## Search Results` header and `### name`
    // per-row. Compact mode replaces both with a single header line and
    // pipe-delimited rows. `fields: ['name', 'kind']` restricts further:
    // no path / signature / id columns.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'alpha',
      compact: true,
      fields: ['name', 'kind'],
    });
    const text = result.content[0]?.text ?? '';
    // No markdown headers — compact mode drops the `##` / `###` decoration.
    expect(text).not.toMatch(/^## Search Results/);
    expect(text).not.toMatch(/^### alpha/m);
    // Should contain the compact header line + a pipe-delimited row.
    expect(text).toMatch(/^Search Results \(/);
    expect(text).toMatch(/alpha\|function/);
    // path was excluded by `fields` — make sure src/a.ts is NOT in the row.
    expect(text).not.toMatch(/alpha\|function\|src\/a\.ts/);
  });

  it('compact mode with no explicit `fields` includes `kind` in every row (F-S)', async () => {
    // F-S regression guard: mode='exact' is FTS-backed and can return
    // non-function rows (imports, file nodes, type aliases). Without
    // `kind` in the default compact field set, the agent has no way
    // to disambiguate. The tool description promises
    // 'name|kind|path:line|sig:...|id:...' — confirm the implementation
    // honours that default when the caller doesn't pass `fields` at all.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'alpha',
      compact: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^Search Results \(/);
    // The `alpha` symbol is a function — the second column on every row
    // must be `function` because `kind` is in the default field set.
    expect(text).toMatch(/alpha\|function/);
  });

  it('default (no compact) shape is unchanged when fields is passed alone', async () => {
    // `fields` without `compact:true` is silently ignored — the default
    // markdown shape must be byte-identical to the no-args call.
    const defaultCall = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    const withFields = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', fields: ['name'] });
    expect(withFields.content[0]?.text ?? '').toBe(defaultCall.content[0]?.text ?? '');
  });

  it('default (no compact) shape also ignores fields that omit name', async () => {
    const defaultCall = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    const withFields = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', fields: ['kind'] });
    expect(withFields.isError).toBeFalsy();
    expect(withFields.content[0]?.text ?? '').toBe(defaultCall.content[0]?.text ?? '');
  });
});

// Multi-name union path: a query like `handleRole handleGraph handleStatus`
// used to be treated as one FTS phrase and returned 0 hits with a "did you
// mean" hint. The dispatch in `_search.ts:handleFindByName` now detects
// 2+ bare identifier tokens (no `:` qualifiers, no parens, no AND/OR/NOT)
// and resolves each via `getNodesByName`, rendering a grouped union.
describe('cartograph_find by=name mode=exact — multi-name batch union', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-find-multi-name-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Three real symbols + a 4th name that doesn't exist, so we can
    // assert the "no exact match" placeholder rendering in mixed mode.
    fs.writeFileSync(
      path.join(dir, 'src', 'handlers.ts'),
      `export function handleRole(): string { return 'r'; }\n` +
        `export function handleGraph(): string { return 'g'; }\n` +
        `export function handleSql(): string { return 's'; }\n`,
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

  it('two-name query returns both grouped by token', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole handleGraph',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union \(2 queries/);
    expect(text).toMatch(/### handleRole \(1 hit\)/);
    expect(text).toMatch(/### handleGraph \(1 hit\)/);
    expect(text).toContain('handleRole (function)');
    expect(text).toContain('handleGraph (function)');
    expect(text).toContain('src/handlers.ts');
  });

  it('four-name query returns all four grouped, including missing-name placeholder', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole handleGraph handleStatus handleSql',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union \(4 queries/);
    expect(text).toMatch(/### handleRole \(1 hit\)/);
    expect(text).toMatch(/### handleGraph \(1 hit\)/);
    expect(text).toMatch(/### handleStatus \(0 hits\)/);
    expect(text).toMatch(/### handleSql \(1 hit\)/);
    // Missing-name placeholder under the 0-hit group.
    expect(text).toMatch(/_no exact match — try mode:fuzzy_/);
  });

  it('single-name query falls through to legacy FTS path (back-compat)', async () => {
    // Single token → no multi-name detection → standard search header.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Search Results/);
    expect(text).not.toMatch(/## Exact match union/);
    expect(text).toContain('handleRole');
  });

  it('field-qualified query (name:foo path:src/) keeps legacy FTS phrase behavior', async () => {
    // The `:` in `name:` is the discriminator — multi-name detector
    // bails so the deliberate field-qualified syntax stays untouched.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'name:handleRole path:src/',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/## Exact match union/);
    // Field-qualified still resolves the real symbol via the FTS path.
    expect(text).toMatch(/## Search Results/);
    expect(text).toContain('handleRole');
  });

  it('compact mode preserves grouped headers + emits pipe-delimited rows', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole handleGraph',
      compact: true,
      fields: ['name', 'kind'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union /);
    // Group headers keep `(N)` shape in compact mode.
    expect(text).toMatch(/### handleRole \(1\)/);
    expect(text).toMatch(/### handleGraph \(1\)/);
    // Pipe-delimited rows; `path` excluded by `fields`.
    expect(text).toMatch(/handleRole\|function/);
    expect(text).toMatch(/handleGraph\|function/);
    expect(text).not.toMatch(/handleRole\|function\|src\/handlers\.ts/);
  });

  it('kind filter applies per-group — drops hits whose kind does not match', async () => {
    // `handleRole` is a function; `kind:class` filter should produce a
    // 0-hit group for it (and the union header reports `kind=class`).
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole handleGraph',
      kind: 'class',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union .*\(kind=class\)/);
    expect(text).toMatch(/### handleRole \(0 hits\)/);
    expect(text).toMatch(/### handleGraph \(0 hits\)/);
  });

  it('multi-name with AND boolean auto-recovers to the union view + flags the strip', async () => {
    // `Foo AND Bar` reads as FTS5 boolean syntax but cartograph_find
    // by:name doesn't parse it — historically the operator was
    // stripped and the query collapsed to a first-token-only match.
    // The dispatcher now strips standalone uppercase boolean operators
    // (`AND`/`OR`/`NOT`/`NEAR`) and routes the bare-token residue
    // through the union view, prepending a one-line note flagging
    // the recovery so the agent learns the shape.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole AND handleGraph',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Detected boolean operator \(AND\)/);
    expect(text).toMatch(/Stripped and routed to the per-token union view/);
    expect(text).toMatch(/^## Exact match union \(2 queries/m);
    // Both tokens get their own group, same shape as the bare
    // `handleRole handleGraph` query.
    expect(text).toMatch(/### handleRole /);
    expect(text).toMatch(/### handleGraph /);
  });

  it('multi-name with OR disjunction auto-recovers to the union view', async () => {
    // The exact friction case: `Foo OR Bar` is the most common shape
    // an agent types when it wants a disjunction. Same auto-recovery
    // as the AND case above — semantically identical to the bare
    // multi-token query.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole OR handleGraph',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Detected boolean operator \(OR\)/);
    expect(text).toMatch(/^## Exact match union \(2 queries/m);
    expect(text).toMatch(/### handleRole /);
    expect(text).toMatch(/### handleGraph /);
  });

  it('mixed-operator disjunction (OR + NOT) lists every stripped operator', async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'handleRole OR handleGraph NOT handleStatus',
    });
    const text = result.content[0]?.text ?? '';
    // Operators rendered in sorted order — confirms set semantics in the prefix.
    expect(text).toMatch(/Detected boolean operators \(NOT, OR\)/);
    expect(text).toMatch(/^## Exact match union \(3 queries/m);
  });

  it('field-qualified query with OR still falls through to FTS + probe (no auto-recovery)', async () => {
    // `name:foo OR name:bar` carries `:` qualifiers that survive the
    // strip — the residue still fails the bare-identifier check, so
    // auto-recovery declines and the standard boolean-operator probe
    // fires through the empty-result hint chain. Documents the
    // intentional limit: auto-recovery is for bare-identifier OR
    // disjunctions only, not field-qualified ones.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'name:nope_zzz OR name:also_nope_zzz',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/## Exact match union/);
    expect(text).toMatch(/Detected boolean operator/);
  });
});

// Friction fix (a): a multi-token exact query routes to the "Exact
// match union" view; very short query tokens (1-2 chars) exact-match a
// swarm of single-letter throwaway locals the indexer records as their
// own `variable` / `constant` nodes. Those rows are noise — the
// short-token filter drops them while keeping genuine short symbols
// (exported constants, structural kinds).
describe('cartograph_find by=name mode=exact — multi-name union short-token noise filter', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-find-short-token-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // `noisy.ts` declares throwaway single-letter locals `t` and `d`
    // (the indexer records each as its own `variable`/`constant` node).
    fs.writeFileSync(
      path.join(dir, 'src', 'noisy.ts'),
      `export function findSemanticClones(): number {\n` +
        `  const t = 1;\n` +
        `  const d = 2;\n` +
        `  return t + d;\n` +
        `}\n`,
    );
    // `real.ts` declares a genuine EXPORTED 2-char constant `id` plus a
    // genuine real symbol with a long name — these must survive.
    fs.writeFileSync(
      path.join(dir, 'src', 'real.ts'),
      `export const id = 'real-public-constant';\n` + `export function CloneType(): number { return 1; }\n`,
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

  it('drops single-letter throwaway-local rows from a short-token union group', async () => {
    // Query includes the real symbol plus bare short tokens `t` / `d`.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'findSemanticClones t d',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union/);
    // The real symbol's group still resolves.
    expect(text).toMatch(/### findSemanticClones \(1 hit\)/);
    // The `t` / `d` groups exist but contain ZERO rows — the
    // throwaway single-letter locals were filtered out.
    expect(text).toMatch(/### t \(0 hits\)/);
    expect(text).toMatch(/### d \(0 hits\)/);
  });

  it('keeps a genuine EXPORTED short symbol in a short-token union group', async () => {
    // `id` is an exported 2-char constant — a legitimate short-but-real
    // symbol. The short-token filter must NOT drop it.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'CloneType id',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## Exact match union/);
    expect(text).toMatch(/### CloneType \(1 hit\)/);
    // The exported `id` constant survives the short-token filter.
    expect(text).toMatch(/### id \(1 hit\)/);
    expect(text).toContain('src/real.ts');
  });

  it('long tokens are untouched by the short-token filter', async () => {
    // `findSemanticClones` is ≥3 chars — the filter never runs on it.
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'exact',
      query: 'findSemanticClones CloneType',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/### findSemanticClones \(1 hit\)/);
    expect(text).toMatch(/### CloneType \(1 hit\)/);
  });
});

// Friction #9 regression: agent searches for the canonical MCP tool
// name (e.g. `cartograph_demo`) and expects to land on the registered
// XXX_TOOL constant. nodes_fts already weights `signature` (bm25=2),
// so the existing FTS path picks up `name: 'cartograph_demo'` substring
// in DEMO_TOOL's signature column. No bridge needed; just guard.
describe('cartograph_find by=name — canonical MCP-tool-name lookup (friction #9 regression)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-find-tool-name-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'demo-tool.ts'),
      `function handleDemo() { return { ok: true }; }
export const DEMO_TOOL = {
  definition: { name: 'cartograph_demo', description: 'demo tool' },
  handle: handleDemo,
};
`,
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the XXX_TOOL constant when the query is the canonical 'cartograph_X' name", async () => {
    const result = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'cartograph_demo',
      mode: 'exact',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Search Results/);
    expect(text).toContain('DEMO_TOOL');
    expect(text).toContain('src/demo-tool.ts');
  });
});
