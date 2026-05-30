/**
 * symbol-resolver parity — cartograph_node ↔ cartograph_biomarkers.
 *
 * Friction (2026-05-14): `cartograph_node` resolves a bare name via
 * `findSymbol` (FTS top-N → `matchesSymbol` strict filter → fuzzy
 * fallback). `cartograph_biomarkers mode=symbol` resolves the same name
 * via `resolveSymbolToNodeId` (FTS top-1, no exact-match filter).
 *
 * The asymmetry: when FTS top-N is saturated by populous lowercase
 * variants of a token, the bare target name can be ranked past the
 * `findSymbol` cap. `matchesSymbol` filters the top-N to ZERO exact
 * matches and surfaces a fuzzy fallback note — meanwhile a raw
 * `getNodesByName(symbol)` lookup would return the row directly.
 *
 * The fix landed both resolvers on a `getNodesByName` shortcut BEFORE
 * the FTS round-trip (mirroring the `findAllSymbols` pattern). This
 * suite locks in the symmetric resolution contract so the two
 * surfaces can't drift again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { findSymbol, resolveSymbolToNodeId, resolveSymbolToNode } from '../src/mcp/tools/symbol-resolver.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('symbol-resolver — cartograph_node ↔ cartograph_biomarkers parity', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolver-parity-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Three distinct symbol names — the exact case the friction tracker
    // flagged on 2026-05-14 (handle*-style names live alongside many
    // populous `handler` / `handle` tokens in MCP-tool files).
    fs.writeFileSync(
      path.join(dir, 'src', 'review-context.ts'),
      [
        'export async function handleReviewContext(): Promise<number> { return 1; }',
        'export function buildReviewContext(): string { return "ctx"; }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'review-neighbors.ts'),
      ['export async function handleReviewNeighbors(): Promise<number> { return 2; }'].join('\n') + '\n',
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

  // ---------------------------------------------------------------
  // Resolver-level parity — direct calls into symbol-resolver.ts
  // ---------------------------------------------------------------

  it('findSymbol and resolveSymbolToNodeId agree on real names', () => {
    const names = ['handleReviewContext', 'handleReviewNeighbors', 'buildReviewContext'];
    for (const name of names) {
      const viaNode = findSymbol(cg, name);
      const viaBiomarkers = resolveSymbolToNodeId(cg, name, undefined);
      expect(viaNode, `findSymbol should resolve "${name}"`).not.toBeNull();
      expect(viaBiomarkers, `resolveSymbolToNodeId should resolve "${name}"`).not.toBeNull();
      // Both surfaces must agree on the same node id — no silent drift.
      expect(viaNode!.node.id).toBe(viaBiomarkers);
    }
  });

  it('findSymbol returns null on a genuinely missing symbol (no regression)', () => {
    expect(findSymbol(cg, 'definitelyNotARealSymbol')).toBeNull();
    expect(resolveSymbolToNodeId(cg, 'definitelyNotARealSymbol', undefined)).toBeNull();
  });

  it('#34: findSymbol resolves a raw `kind:hash` node id passed verbatim', () => {
    // Grab a real node id (`${kind}:${32-hex}`) for a known symbol,
    // then feed it straight back into findSymbol the way a caller that
    // pasted an id from a prior tool result would.
    const byName = findSymbol(cg, 'buildReviewContext');
    expect(byName).not.toBeNull();
    const rawId = byName!.node.id;
    expect(rawId).toMatch(/^[a-z_]+:[0-9a-f]{32}$/);
    const byId = findSymbol(cg, rawId);
    expect(byId, `findSymbol should resolve raw node id "${rawId}"`).not.toBeNull();
    expect(byId!.node.id).toBe(rawId);
  });

  // ---------------------------------------------------------------
  // Fuzzy-fallback flagging — audit Group 2 #6 / Group 5 #1.
  // A name with no exact match must NOT be presented as an
  // authoritative resolution: `resolveSymbolToNode` flags `fuzzy`
  // and carries a visible banner so biomarkers / note callers can
  // surface "resolved X to Y" instead of silently picking a wrong
  // (often `import`-kind) node.
  // ---------------------------------------------------------------

  it('resolveSymbolToNode marks an exact name match as NOT fuzzy', () => {
    for (const name of ['handleReviewContext', 'handleReviewNeighbors', 'buildReviewContext']) {
      const r = resolveSymbolToNode(cg, name, undefined);
      expect(r, `should resolve "${name}"`).not.toBeNull();
      expect(r!.fuzzy, `"${name}" is an exact match — not fuzzy`).toBe(false);
      expect(r!.fuzzyBanner).toBe('');
    }
  });

  it('resolveSymbolToNode flags an FTS-only guess as fuzzy with a visible banner', () => {
    // A camel-cased near-miss the FTS index will rank a real node for,
    // but which exactly-matches no symbol name in the fixture.
    const r = resolveSymbolToNode(cg, 'reviewContextHandler', undefined);
    // Either it found no FTS hit at all (null) — also acceptable — or it
    // returned a guess that MUST be flagged fuzzy.
    if (r !== null) {
      expect(r.fuzzy, 'an FTS guess for a non-exact name must be flagged fuzzy').toBe(true);
      expect(r.fuzzyBanner).toMatch(/Fuzzy fallback/);
      expect(r.fuzzyBanner).toMatch(/reviewContextHandler/);
    }
  });

  it('cartograph_biomarkers mode=symbol surfaces a fuzzy-fallback banner for a non-existent name', async () => {
    // The audit's `runIndex` scenario: a name no symbol literally has,
    // which FTS would resolve to an unrelated node. Biomarkers must NOT
    // render a bare "Code Health 10/10" — it must show the banner.
    const r = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: 'reviewContextHandler',
    });
    const text = r.content[0]?.text ?? '';
    // Whatever it resolved to, the response must either say not-found OR
    // carry the fuzzy banner — never a silent clean 10/10.
    const isNotFound = /not found/i.test(text);
    const hasBanner = /Fuzzy fallback/.test(text);
    expect(isNotFound || hasBanner, 'must flag the non-exact resolution').toBe(true);
  });

  it('cartograph_biomarkers mode=symbol does NOT add a banner for a real symbol', async () => {
    const r = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: 'handleReviewContext',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  // Audit #40 — coverage / role mode=symbol must surface the same
  // fuzzy-fallback banner as biomarkers / note. They previously called
  // the id-only `resolveSymbolToNodeId`, so a fuzzy FTS match silently
  // picked the wrong node.

  it('cartograph_coverage mode=symbol surfaces a fuzzy-fallback banner for a non-existent name', async () => {
    const r = await handler.execute('cartograph_coverage', {
      mode: 'symbol',
      symbol: 'reviewContextHandler',
    });
    const text = r.content[0]?.text ?? '';
    const isNotFound = /not found/i.test(text);
    const hasBanner = /Fuzzy fallback/.test(text);
    expect(isNotFound || hasBanner, 'coverage must flag the non-exact resolution').toBe(true);
  });

  it('cartograph_coverage mode=symbol does NOT add a banner for a real symbol', async () => {
    const r = await handler.execute('cartograph_coverage', {
      mode: 'symbol',
      symbol: 'handleReviewContext',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  it('cartograph_role mode=symbol surfaces a fuzzy-fallback banner for a non-existent name', async () => {
    const r = await handler.execute('cartograph_role', { symbol: 'reviewContextHandler' });
    const text = r.content[0]?.text ?? '';
    const isNotFound = /not found/i.test(text);
    const hasBanner = /Fuzzy fallback/.test(text);
    expect(isNotFound || hasBanner, 'role must flag the non-exact resolution').toBe(true);
  });

  it('cartograph_role mode=symbol does NOT add a banner for a real symbol', async () => {
    const r = await handler.execute('cartograph_role', { symbol: 'handleReviewContext' });
    const text = r.content[0]?.text ?? '';
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  // ---------------------------------------------------------------
  // Tool-level parity — cartograph_node ↔ cartograph_biomarkers
  // ---------------------------------------------------------------

  it('cartograph_node resolves all 3 bare names (single)', async () => {
    for (const sym of ['handleReviewContext', 'handleReviewNeighbors', 'buildReviewContext']) {
      const r = await handler.execute('cartograph_node', { symbol: sym });
      const text = r.content[0]?.text ?? '';
      expect(text, `cartograph_node should resolve "${sym}"`).toMatch(new RegExp(`## ${sym}`));
      expect(text, `cartograph_node should not return Symbol-not-found on "${sym}"`).not.toMatch(/Symbol .* not found/);
    }
  });

  it('cartograph_node resolves all 3 names in a batch', async () => {
    const r = await handler.execute('cartograph_node', {
      symbols: ['handleReviewContext', 'handleReviewNeighbors', 'buildReviewContext'],
    });
    const text = r.content[0]?.text ?? '';
    // Header reflects 3 resolved + 0 not-found.
    expect(text).toMatch(/# 3 symbols resolved/);
    expect(text).not.toMatch(/not found/);
    // All three card headers present.
    expect(text).toMatch(/## handleReviewContext/);
    expect(text).toMatch(/## handleReviewNeighbors/);
    expect(text).toMatch(/## buildReviewContext/);
  });

  it('cartograph_biomarkers mode=symbol resolves the same names', async () => {
    for (const sym of ['handleReviewContext', 'handleReviewNeighbors', 'buildReviewContext']) {
      const r = await handler.execute('cartograph_biomarkers', { mode: 'symbol', symbol: sym });
      const text = r.content[0]?.text ?? '';
      // Biomarkers either renders findings OR a "no findings — 10/10" line,
      // both of which name the symbol. What it must NOT do is return
      // `No symbol matched "..."` — that would be the parity failure.
      expect(text, `cartograph_biomarkers should resolve "${sym}"`).not.toMatch(/No symbol matched/);
    }
  });

  it('cartograph_node returns Symbol-not-found on a missing symbol (no regression)', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'definitelyNotARealSymbol' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/not found/i);
  });

  // ---------------------------------------------------------------
  // Multi-defined name — exact-name shortcut still uses
  // pickFromMultipleExactMatches with the centrality / non-fixture
  // tie-breaker.
  // ---------------------------------------------------------------

  it('multi-defined name resolves via the exact-name shortcut without losing the disambiguation note', async () => {
    // Add a second file that defines the same plain name in a different file.
    // The shortcut should detect the multi-match and call
    // `pickFromMultipleExactMatches`, which emits an "X symbols named ..." note.
    fs.writeFileSync(
      path.join(dir, 'src', 'review-context-alt.ts'),
      'export function buildReviewContext(): string { return "alt"; }\n',
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second def');
    await cg.sync({ summarize: false });
    const r = findSymbol(cg, 'buildReviewContext');
    expect(r).not.toBeNull();
    // Note should mention the 2-symbol disambiguation.
    expect(r!.note).toMatch(/2 symbols named "buildReviewContext"/);
  });
});
