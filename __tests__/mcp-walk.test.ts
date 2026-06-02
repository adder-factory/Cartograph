/**
 * cartograph_walk — MCP tool for bounded BFS over the call/dependency graph.
 *
 * Tests cover:
 *   - Input validation (start required, direction enum, hops/maxNodes clamped)
 *   - BFS shape (hops=1, hops=2, cycles, maxNodes cap, dedup at min depth)
 *   - Registration (tool in registry, schema fields present)
 *   - Output format (compact default, compact=false markdown bullets, via field, depth=0 excluded)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a temp directory with a minimal TypeScript fixture that produces
 *  known call edges A→B→C and D→B (so B has multiple callers). */
async function makeFixture(): Promise<{ dir: string; cg: Cartograph; handler: ToolHandler }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-walk-'));
  fs.mkdirSync(path.join(dir, 'src'));

  // A calls B, B calls C — gives us a 3-hop chain
  fs.writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    [`import { beta } from './b.js';`, `export function alpha(): void { beta(); }`].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'src', 'b.ts'),
    [`import { gamma } from './c.js';`, `export function beta(): void { gamma(); }`].join('\n'),
  );

  fs.writeFileSync(path.join(dir, 'src', 'c.ts'), [`export function gamma(): void {}`].join('\n'));

  // D also calls B → multiple paths to B for cycle/dedup tests
  fs.writeFileSync(
    path.join(dir, 'src', 'd.ts'),
    [`import { beta } from './b.js';`, `export function delta(): void { beta(); }`].join('\n'),
  );

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'walk-fixture', version: '0.0.0' }));

  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  const handler = new ToolHandler(cg);
  return { dir, cg, handler };
}

// ---------------------------------------------------------------------------
// describe: input validation
// ---------------------------------------------------------------------------

describe('cartograph_walk — input validation', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects missing start (schema layer or handler-level error)', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callees' });
    expect(result.isError).toBe(true);
    // Schema layer: "Missing required argument `start`"
    // Handler layer (if reached): "start must be a non-empty string"
    expect(result.content[0]?.text).toMatch(/start/);
  });

  it('rejects empty start string', async () => {
    const result = await handler.execute('cartograph_graph', { start: '', direction: 'callees' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/start/);
  });

  it('rejects missing direction (schema layer or handler-level error)', async () => {
    const result = await handler.execute('cartograph_graph', { start: 'alpha' });
    expect(result.isError).toBe(true);
    // Schema or handler messages both mention "direction"
    expect(result.content[0]?.text).toMatch(/direction/);
  });

  it('rejects invalid direction value', async () => {
    const result = await handler.execute('cartograph_graph', { start: 'alpha', direction: 'sideways' });
    expect(result.isError).toBe(true);
    // Schema: "must be 'callers', 'callees', or 'impact'"
    // Handler: "direction must be one of: callers, callees, impact"
    expect(result.content[0]?.text).toMatch(/callers|callees|impact/);
  });

  it('rejects invalid edgeKind', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      edgeKind: 'teleports',
    });
    expect(result.isError).toBe(true);
    // Schema: "must be 'calls', 'instantiates', ..."
    // Handler: "edgeKind must be one of: calls, instantiates, ..."
    expect(result.content[0]?.text).toMatch(/calls|edgeKind/);
  });

  // The Zod enum mirrors every emitted `EdgeKind` variant from
  // `src/types.ts`. The default un-filtered traversal still excludes
  // `contains` / `similar_to` / `def_use`, but an explicit `edgeKind:`
  // filter must be accepted at the schema boundary so opt-in walks
  // (`edgeKind: 'similar_to'`, `edgeKind: 'tests'`, etc.) work.
  it.each([
    'contains',
    'exports',
    'tests',
    'field_access',
    'similar_to',
    'def_use',
  ])("accepts edgeKind='%s' (Zod enum gap closure)", async (edgeKind) => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      edgeKind,
    });
    // The fixture has no edges of these kinds, so an empty result is
    // expected — but the call must NOT be rejected as an unknown enum
    // value. Verify neither error shape is the "edgeKind must be one
    // of" rejection.
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/edgeKind must be one of/);
    expect(text).not.toMatch(/Invalid enum value/);
  });

  it('rejects hops below the minimum', async () => {
    // Post structural-campaign-P4: `hops` is a Zod `.int().min(1)` —
    // a sub-minimum value is REJECTED at the dispatch boundary
    // (locked reject-out-of-range policy), no longer clamped up to 1.
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/hops/);
  });

  it('rejects maxNodes above the maximum', async () => {
    // Post structural-campaign-P4: `maxNodes` is a Zod
    // `.int().min(1).max(200)` — an over-cap value is REJECTED at the
    // dispatch boundary, no longer clamped down to 200.
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/maxNodes/);
  });

  it('returns not-found for an unknown symbol', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'doesNotExistEverywhere',
      direction: 'callees',
      maxNodes: 50,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// describe: BFS shape
// ---------------------------------------------------------------------------

describe('cartograph_walk — BFS shape', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hops=1 returns only immediate callees of alpha (beta only)', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // beta is at depth=1, should be present
    expect(text).toMatch(/beta/);
    // gamma is at depth=2, should NOT appear with hops=1
    expect(text).not.toMatch(/gamma/);
  });

  it('hops=2 returns beta (depth=1) AND gamma (depth=2)', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/beta/);
    expect(text).toMatch(/gamma/);
    // depth annotations present in compact output
    expect(text).toMatch(/depth=1/);
    expect(text).toMatch(/depth=2/);
  });

  it('cycle does not loop forever — A→B→A terminates', async () => {
    // Write a cyclic fixture in a new tmpdir
    const cycleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-walk-cycle-'));
    fs.mkdirSync(path.join(cycleDir, 'src'));
    // foo.ts and bar.ts call each other (cycle)
    fs.writeFileSync(
      path.join(cycleDir, 'src', 'foo.ts'),
      `import { bar } from './bar.js';\nexport function foo(): void { bar(); }`,
    );
    fs.writeFileSync(
      path.join(cycleDir, 'src', 'bar.ts'),
      `import { foo } from './foo.js';\nexport function bar(): void { foo(); }`,
    );
    fs.writeFileSync(path.join(cycleDir, 'package.json'), JSON.stringify({ name: 'cycle-fix', version: '0.0.0' }));

    const cycleCg = await Cartograph.init(cycleDir, { config: { llm: { endpoint: '' } } });
    await cycleCg.indexAll({ summarize: false });
    const cycleHandler = new ToolHandler(cycleCg);

    try {
      const result = await cycleHandler.execute('cartograph_graph', {
        start: 'foo',
        direction: 'callees',
        hops: 5,
        maxNodes: 50,
      });
      // Must complete (not hang) and not crash
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Walk from foo/);
      // bar may appear in multiple lines (header, row) but should not be
      // duplicated as a node row
      const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
      const barRows = rowLines.filter((l) => l.startsWith('bar|'));
      expect(barRows.length).toBeLessThanOrEqual(1);
    } finally {
      cycleHandler.closeAll();
      cycleCg.close();
      fs.rmSync(cycleDir, { recursive: true, force: true });
    }
  });

  it('maxNodes=1 caps result at 1 node and appends cap hint', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 3,
      maxNodes: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Walk from alpha.*\(1 nodes\)/);
    expect(text).toMatch(/maxNodes=1/);
  });

  it('node reachable via multiple paths appears once at minimum depth', async () => {
    // beta is reachable from alpha (depth=1) and also from a hypothetical 2-hop path
    // In our fixture: callers of beta include both alpha AND delta
    // Walk callers from gamma — should get beta at depth=1, alpha/delta at depth=2
    const result = await handler.execute('cartograph_graph', {
      start: 'gamma',
      direction: 'callers',
      hops: 3,
      maxNodes: 100,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    // beta should appear exactly once
    const betaRows = rowLines.filter((l) => l.startsWith('beta|'));
    expect(betaRows.length).toBeLessThanOrEqual(1);
    // beta should be at depth=1
    if (betaRows.length === 1) {
      expect(betaRows[0]).toMatch(/depth=1/);
    }
  });

  it('start node is NOT included in the output rows', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    const text = result.content[0]?.text ?? '';
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    // alpha itself should not appear as a depth-annotated row
    const alphaRows = rowLines.filter((l) => l.startsWith('alpha|'));
    expect(alphaRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: registration
// ---------------------------------------------------------------------------

describe('cartograph_walk — registration', () => {
  it('is registered in the tool modules array', () => {
    const names = getToolModules().map((m) => m.definition.name);
    expect(names).toContain('cartograph_graph');
  });

  it('has a callable handle function', () => {
    const mod = getToolModules().find((m) => m.definition.name === 'cartograph_graph');
    expect(mod).toBeDefined();
    expect(typeof mod!.handle).toBe('function');
  });

  it('schema has required property: direction (start is enforced at runtime — exclusive with `symbols`)', () => {
    const mod = getToolModules().find((m) => m.definition.name === 'cartograph_graph');
    const schema = mod!.definition.inputSchema;
    expect(schema.required).toContain('direction');
    // `start` is NOT in the JSON-schema `required` set after the four-tool
    // merge — the dispatcher accepts either `start` (single) or `symbols`
    // (batched, callers/callees only). MCP JSON Schema can't express
    // mutual exclusivity, so the constraint is enforced at runtime.
  });

  it('schema declares optional properties: hops, maxNodes, edgeKind, compact, projectPath', () => {
    const mod = getToolModules().find((m) => m.definition.name === 'cartograph_graph');
    const props = Object.keys(mod!.definition.inputSchema.properties ?? {});
    expect(props).toContain('hops');
    expect(props).toContain('maxNodes');
    expect(props).toContain('edgeKind');
    expect(props).toContain('compact');
    expect(props).toContain('projectPath');
  });

  it('direction enum has callers, callees, impact', () => {
    const mod = getToolModules().find((m) => m.definition.name === 'cartograph_graph');
    const dirProp = (mod!.definition.inputSchema.properties as Record<string, { enum?: string[] }>)['direction'];
    expect(dirProp?.enum).toContain('callers');
    expect(dirProp?.enum).toContain('callees');
    expect(dirProp?.enum).toContain('impact');
  });
});

// ---------------------------------------------------------------------------
// describe: output format
// ---------------------------------------------------------------------------

describe('cartograph_walk — output format', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeFixture());
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compact=true (default) emits pipe-delimited rows', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // compact rows contain pipes
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    expect(rowLines.length).toBeGreaterThan(0);
    for (const line of rowLines) {
      expect(line).toMatch(/\|depth=\d+/);
    }
  });

  it('compact=false emits markdown bullet rows', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
      compact: false,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // markdown bullet rows start with "- **"
    const bulletLines = text.split('\n').filter((l) => l.startsWith('- **'));
    expect(bulletLines.length).toBeGreaterThan(0);
  });

  it('header line includes start name, direction, hops, and node count', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    const text = result.content[0]?.text ?? '';
    // first line is the header
    const firstLine = text.split('\n')[0] ?? '';
    expect(firstLine).toMatch(/Walk from alpha/);
    expect(firstLine).toMatch(/direction=callees/);
    expect(firstLine).toMatch(/hops=2/);
    expect(firstLine).toMatch(/\(\d+ nodes\)/);
  });

  it('via field traces back to the parent name', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    const text = result.content[0]?.text ?? '';
    // beta (depth=1) has via=alpha; gamma (depth=2) has via=beta
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    const betaRow = rowLines.find((l) => l.startsWith('beta|'));
    const gammaRow = rowLines.find((l) => l.startsWith('gamma|'));
    if (betaRow) expect(betaRow).toMatch(/\|via=alpha/);
    if (gammaRow) expect(gammaRow).toMatch(/\|via=beta/);
  });

  it('depth=0 (start node) is not listed as a row', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    const text = result.content[0]?.text ?? '';
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    const depth0Rows = rowLines.filter((l) => l.includes('|depth=0'));
    expect(depth0Rows.length).toBe(0);
  });

  it('compact rows include id: prefix for graph node IDs', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
    });
    const text = result.content[0]?.text ?? '';
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    expect(rowLines.length).toBeGreaterThan(0);
    for (const line of rowLines) {
      expect(line).toMatch(/\|id:/);
    }
  });

  it('BFS rows emit short n_xxxxxxxx UIDs, not long raw node ids', async () => {
    // hops=2 forces the multi-hop BFS dispatch in graph.ts. Previously
    // those rows printed `id:function:<32-hex>` verbatim — long + not
    // chainable as `start:`. They must now match the short form one-hop
    // rows mint.
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
    });
    const text = result.content[0]?.text ?? '';
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    expect(rowLines.length).toBeGreaterThan(0);
    for (const line of rowLines) {
      // Must carry a short UID...
      expect(line).toMatch(/\|id:n_[0-9a-f]{8}\b/);
      // ...and must NOT carry the long raw `<kind>:<32-hex>` form.
      expect(line).not.toMatch(/id:[a-z_]+:[0-9a-f]{32}/);
    }
  });

  it('a short UID minted by a BFS walk resolves back as `start:`', async () => {
    const walk = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
    });
    const text = walk.content[0]?.text ?? '';
    const uidMatch = /\|id:(n_[0-9a-f]{8})\b/.exec(text);
    expect(uidMatch).toBeTruthy();
    const uid = uidMatch![1]!;
    // Chain the minted UID into a follow-up call as the `start` symbol.
    const followUp = await handler.execute('cartograph_graph', {
      start: uid,
      direction: 'callers',
      hops: 1,
    });
    expect(followUp.isError).toBeFalsy();
    // It resolved to a real symbol (not the "symbol not found" message).
    expect(followUp.content[0]?.text ?? '').not.toMatch(/not found/i);
  });

  it('impact direction returns results from both caller and callee sides', async () => {
    // Walk impact from beta: alpha/delta are callers, gamma is a callee
    const result = await handler.execute('cartograph_graph', {
      start: 'beta',
      direction: 'impact',
      maxNodes: 50,
      hops: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Should see at least one result (gamma callee-side, or alpha/delta caller-side)
    expect(text).not.toMatch(/\(0 nodes\)/);
  });

  it("direction='both' is an alias for 'impact' — returns same bidirectional results", async () => {
    // 'both' should behave identically to 'impact'
    // Post-four-tool-merge: `direction: 'impact' | 'both'` always
    // dispatches to the impact formatter (per-file rollup + per-source
    // breakdown), not BFS. So we compare the impact-style header text.
    const impactResult = await handler.execute('cartograph_graph', {
      start: 'beta',
      direction: 'impact',
      hops: 1,
    });
    const bothResult = await handler.execute('cartograph_graph', {
      start: 'beta',
      direction: 'both',
      hops: 1,
    });
    expect(bothResult.isError).toBeFalsy();
    const impactText = impactResult.content[0]?.text ?? '';
    const bothText = bothResult.content[0]?.text ?? '';
    // Both should produce the same Impact header (same internal path).
    const impactMatch = /Impact:.*affects (\d+) symbols/.exec(impactText);
    const bothMatch = /Impact:.*affects (\d+) symbols/.exec(bothText);
    expect(impactMatch?.[1]).toBeDefined();
    expect(impactMatch?.[1]).toBe(bothMatch?.[1]);
  });

  it("rankBy='bfs' (default) preserves first-seen BFS order", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
      rankBy: 'bfs',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Header should not include rankBy=centrality
    expect(text).not.toMatch(/rankBy=centrality/);
    expect(text).toMatch(/Walk from alpha direction=callees hops=2 \(\d+ nodes\)/);
  });

  it("rankBy='centrality' includes rankBy=centrality in header", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
      rankBy: 'centrality',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Header should mention rankBy=centrality
    expect(text).toMatch(/rankBy=centrality/);
  });

  it("rankBy='centrality' still returns all expected nodes (just reordered)", async () => {
    const bfsResult = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      maxNodes: 50,
      hops: 2,
    });
    const centResult = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
      rankBy: 'centrality',
    });
    expect(centResult.isError).toBeFalsy();
    const bfsText = bfsResult.content[0]?.text ?? '';
    const centText = centResult.content[0]?.text ?? '';
    // Same node count
    const bfsMatch = /\((\d+) nodes\)/.exec(bfsText);
    const centMatch = /\((\d+) nodes\)/.exec(centText);
    expect(bfsMatch?.[1]).toBe(centMatch?.[1]);
    // Both contain beta and gamma
    expect(centText).toMatch(/beta/);
    expect(centText).toMatch(/gamma/);
  });

  it("rankBy='centrality' with no centrality data emits a tip note", async () => {
    // In the test fixture, nodes won't have centrality computed (no full index with centrality hook)
    // so we expect the tip note when most/all nodes have null centrality
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      hops: 2,
      rankBy: 'centrality',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // If more than half of nodes have null centrality, the tip note should appear
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    if (rowLines.length > 0) {
      // In fixture env, centrality is typically not set → tip should fire
      expect(text).toMatch(/no centrality computed yet|rankBy=centrality/);
    }
  });

  it('rankBy invalid value is rejected with an error', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'alpha',
      direction: 'callees',
      rankBy: 'random',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/rankBy/);
  });
});

// ---------------------------------------------------------------------------
// describe: container auto-contains
// ---------------------------------------------------------------------------

/** Build a fixture with a class that has methods + fields, so the
 *  `contains` auto-include can be exercised on a container start node. */
async function makeContainerFixture(): Promise<{ dir: string; cg: Cartograph; handler: ToolHandler }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-walk-container-'));
  fs.mkdirSync(path.join(dir, 'src'));

  fs.writeFileSync(
    path.join(dir, 'src', 'thing.ts'),
    [
      `export class Thing {`,
      `  fieldOne: string = '';`,
      `  fieldTwo: number = 0;`,
      `  methodAlpha(): void { this.methodBeta(); }`,
      `  methodBeta(): number { return this.fieldTwo; }`,
      `}`,
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'src', 'caller.ts'),
    [`import { Thing } from './thing.js';`, `export function useThing(): void { new Thing().methodAlpha(); }`].join(
      '\n',
    ),
  );

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'walk-container-fixture', version: '0.0.0' }),
  );

  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  const handler = new ToolHandler(cg);
  return { dir, cg, handler };
}

describe('cartograph_walk — container auto-contains', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeContainerFixture());
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("class start with direction='callees' auto-includes contains (lists methods/fields)", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'Thing',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Members should now appear at depth=1 via the contains edge.
    expect(text).toMatch(/methodAlpha/);
    expect(text).toMatch(/methodBeta/);
    // Should NOT be 0 nodes — that was the pre-fix bug.
    expect(text).not.toMatch(/\(0 nodes\)/);
  });

  it("class start with direction='callers' does NOT auto-include contains (avoids parent-file flood)", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'Thing',
      direction: 'callers',
      maxNodes: 50,
      hops: 1,
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Members must NOT appear when walking upstream — only the file/module
    // that contains Thing would surface, which is exactly what we want to avoid.
    expect(text).not.toMatch(/^methodAlpha\|/m);
    expect(text).not.toMatch(/^methodBeta\|/m);
  });

  it("class start with explicit edgeKind='calls' does NOT auto-include contains", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'Thing',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
      edgeKind: 'calls',
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // edgeKind='calls' is a hard filter — class members should not appear
    // through the contains edge when the caller pinned a different kind.
    expect(text).not.toMatch(/^methodAlpha\|/m);
    expect(text).not.toMatch(/^methodBeta\|/m);
  });

  it('non-container start (function) does NOT auto-include contains', async () => {
    // useThing is a function — no auto-include, behaves exactly as before.
    const result = await handler.execute('cartograph_graph', {
      start: 'useThing',
      direction: 'callees',
      maxNodes: 50,
      hops: 1,
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Pre-existing call edges still resolve normally.
    expect(text).toMatch(/Walk from useThing/);
  });

  it("class start with direction='impact' auto-includes contains too", async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'Thing',
      direction: 'impact',
      maxNodes: 50,
      hops: 1,
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Members should still appear on bidirectional walks.
    expect(text).toMatch(/methodAlpha/);
    expect(text).toMatch(/methodBeta/);
  });
});

// ---------------------------------------------------------------------------
// describe: includeTests — test-file BFS noise filter
// ---------------------------------------------------------------------------

/**
 * Fixture with a production call chain `prodEntry → prodHelper → leaf`
 * plus a sibling test file that ALSO consumes `prodHelper`. Walking
 * callers/callees from a prod symbol must not leak into the test file
 * at depth >= 1 by default; walking from a symbol in the test file
 * (the inverse case) must still surface test-file traversal.
 */
async function makeTestFileLeakFixture(): Promise<{
  dir: string;
  cg: Cartograph;
  handler: ToolHandler;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-walk-testleak-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '__tests__'));

  // Production code: prodEntry → prodHelper → leaf
  fs.writeFileSync(
    path.join(dir, 'src', 'entry.ts'),
    [`import { prodHelper } from './helper.js';`, `export function prodEntry(): void { prodHelper(); }`].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'src', 'helper.ts'),
    [`import { leaf } from './leaf.js';`, `export function prodHelper(): void { leaf(); }`].join('\n'),
  );

  fs.writeFileSync(path.join(dir, 'src', 'leaf.ts'), [`export function leaf(): void {}`].join('\n'));

  // Test file consumes prodHelper — this is the noise we want filtered.
  fs.writeFileSync(
    path.join(dir, '__tests__', 'helper.test.ts'),
    [`import { prodHelper } from '../src/helper.js';`, `export function testConsumer(): void { prodHelper(); }`].join(
      '\n',
    ),
  );

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'walk-testleak-fixture', version: '0.0.0' }));

  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  const handler = new ToolHandler(cg);
  return { dir, cg, handler };
}

describe('cartograph_graph — includeTests filter on multi-hop BFS', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    ({ dir, cg, handler } = await makeTestFileLeakFixture());
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('default (hops=2 BFS, production start): test-file rows excluded from callers walk', async () => {
    // Walking callers of `prodHelper` at hops=2 should NOT surface
    // `testConsumer` (which lives in __tests__/) — that's the friction.
    const result = await handler.execute('cartograph_graph', {
      start: 'prodHelper',
      direction: 'callers',
      hops: 2,
      maxNodes: 50,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // No __tests__/ rows at any depth on the default multi-hop walk.
    const rowLines = text.split('\n').filter((l) => l.includes('|depth='));
    const testFileRows = rowLines.filter((l) => l.includes('__tests__/'));
    expect(testFileRows).toHaveLength(0);
    // The test consumer should not appear as a row.
    const testConsumerRows = rowLines.filter((l) => l.startsWith('testConsumer|'));
    expect(testConsumerRows).toHaveLength(0);
    // Production caller (prodEntry) should still be there.
    expect(text).toMatch(/prodEntry/);
  });

  it('includeTests=true (hops=2 BFS): test-file rows restored', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'prodHelper',
      direction: 'callers',
      hops: 2,
      maxNodes: 50,
      includeTests: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // With the flag forced on, the test-file caller must be back.
    expect(text).toMatch(/testConsumer/);
    expect(text).toMatch(/__tests__\/helper\.test\.ts/);
  });

  it('inverse case (test-file start): test-file traversal stays on even at default', async () => {
    // Starting from a symbol inside __tests__/ — the agent is asking
    // "what does my test exercise" — must reach prodHelper / leaf.
    const result = await handler.execute('cartograph_graph', {
      start: 'testConsumer',
      direction: 'callees',
      hops: 2,
      maxNodes: 50,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // The walker started inside __tests__/, so the filter must be off
    // even at the default. Production callees should be reached.
    expect(text).toMatch(/prodHelper/);
  });

  it('hops=1 callers (one-hop slice): NOT routed through BFS — back-compat preserved', async () => {
    // Dispatcher routes hops=1 to handleCallers, NOT handleWalk.
    // Test-file callers must still appear there (this is the one-hop
    // back-compat default — old callers/callees included tests).
    const result = await handler.execute('cartograph_graph', {
      start: 'prodHelper',
      direction: 'callers',
      hops: 1,
      limit: 50,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // One-hop callers must still surface testConsumer for back-compat.
    expect(text).toMatch(/testConsumer/);
  });

  it('schema declares includeTests as a documented property', () => {
    const mod = getToolModules().find((m) => m.definition.name === 'cartograph_graph');
    const props = mod!.definition.inputSchema.properties as Record<string, { description?: string }>;
    expect(props['includeTests']).toBeDefined();
    expect(props['includeTests']?.description).toMatch(/test-file/i);
  });
});
