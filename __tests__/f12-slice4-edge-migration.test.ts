/**
 * F#12 slice 4 — intra-fn edge + unresolved_ref migration on promotion.
 *
 * After a manifest row is promoted to a real Node, edges/refs that the
 * body walker attributed to the parent fn at extraction time (because
 * the nested fn wasn't a real Node yet) need to be re-anchored to the
 * promoted node so callees / refs / field-accesses out of the promoted
 * fn surface from the right source.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { lookupNestedFnsByName } from '../src/db/queries-nested-functions.js';

const SAVED_LFT = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
const SAVED_NPT = process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'];

// `target` and `helperA`/`helperB`/`outOfRangeCall` give us a fixture
// where the parent (`createTypeChecker`) emits edges across multiple
// line ranges — some inside the to-be-promoted nested fn, some not.
const MIGRATION_FIXTURE = `
export function helperA(a) { return a; }
export function helperB(b) { return b; }
export function createTypeChecker() {
  function getTypeOfSymbol(s) {
    return helperA(s.type);
  }
  helperB(getTypeOfSymbol({}));
  return helperA(1);
}
`;

interface Harness {
  dir: string;
  cg: Cartograph;
  handler: ToolHandler;
}

async function setupHarness(opts: { threshold: number; fixture?: string }): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-f12-slice4-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'checker.ts'), opts.fixture ?? MIGRATION_FIXTURE);
  const cg = await Cartograph.init(dir, {
    config: {
      llm: { endpoint: '' },
      largeFunctionThreshold: 3,
      nestedPromotionThreshold: opts.threshold,
    },
  });
  await cg.indexAll({ summarize: false });
  const handler = new ToolHandler(cg);
  return { dir, cg, handler };
}

function teardown(h: Harness | null): void {
  if (h) {
    h.handler.closeAll();
    h.cg.close();
    if (fs.existsSync(h.dir)) fs.rmSync(h.dir, { recursive: true, force: true });
  }
}

describe('F#12 slice 4 — promoted-fn edge migration', () => {
  let h: Harness | null = null;

  afterEach(() => {
    teardown(h);
    h = null;
    if (SAVED_LFT === undefined) delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
    else process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = SAVED_LFT;
    if (SAVED_NPT === undefined) delete process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'];
    else process.env['CARTOGRAPH_NESTED_PROMOTION_THRESHOLD'] = SAVED_NPT;
  });

  it('intra-fn calls migrate from parent to promoted node', async () => {
    h = await setupHarness({ threshold: 1 });
    // Manifest mining ran during indexAll; promotion fires on first sync
    // after a deep call bumps the row past threshold=1.
    await h.handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol', deep: true });
    await h.cg.sync();

    const rows = lookupNestedFnsByName(h.cg.queries, 'getTypeOfSymbol');
    const promotedId = rows[0]!.promotedNodeId!;
    expect(promotedId).not.toBeNull();

    // The call `helperA(s.type)` inside `getTypeOfSymbol`'s body lives
    // at line 5 — inside the promoted fn's range. Pre-slice-4 the
    // edge had source = createTypeChecker; post-slice-4 it must be
    // re-anchored to the promoted node.
    const helperANode = h.cg.queries.db
      .prepare("SELECT id FROM nodes WHERE name = 'helperA' AND kind = 'function'")
      .get() as { id: string };
    const edges = h.cg.queries.db
      .prepare("SELECT source FROM edges WHERE target = ? AND kind = 'calls'")
      .all(helperANode.id) as Array<{ source: string }>;
    // Two calls: one from inside getTypeOfSymbol (now promoted), one
    // from outside (createTypeChecker line 10). The promoted node
    // should appear at least once as a caller of helperA.
    const callers = new Set(edges.map((e) => e.source));
    expect(callers.has(promotedId)).toBe(true);
  });

  it('edges OUTSIDE the promoted range stay sourced from the parent', async () => {
    h = await setupHarness({ threshold: 1 });
    await h.handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol', deep: true });
    await h.cg.sync();

    const rows = lookupNestedFnsByName(h.cg.queries, 'getTypeOfSymbol');
    const promotedId = rows[0]!.promotedNodeId!;
    const parentId = rows[0]!.parentNodeId;

    // The `helperB(...)` call lives at line 8 in MIGRATION_FIXTURE,
    // OUTSIDE getTypeOfSymbol's body range (lines 5-7). Its calls edge
    // must STILL be sourced from createTypeChecker.
    const helperBNode = h.cg.queries.db
      .prepare("SELECT id FROM nodes WHERE name = 'helperB' AND kind = 'function'")
      .get() as { id: string };
    const edges = h.cg.queries.db
      .prepare("SELECT source FROM edges WHERE target = ? AND kind = 'calls'")
      .all(helperBNode.id) as Array<{ source: string }>;
    const callers = new Set(edges.map((e) => e.source));
    expect(callers.has(parentId)).toBe(true);
    expect(callers.has(promotedId)).toBe(false);
  });

  it('cartograph_graph direction:callees returns the promoted fn`s callees', async () => {
    h = await setupHarness({ threshold: 1 });
    await h.handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol', deep: true });
    await h.cg.sync();

    // Now the user-facing callees query should surface `helperA` as a
    // callee of the promoted `getTypeOfSymbol` — pre-slice-4 the answer
    // would be empty even after promotion.
    const result = await h.handler.execute('cartograph_graph', {
      direction: 'callees',
      start: 'getTypeOfSymbol',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('helperA');
  });

  it('unresolved_refs migrate just like resolved edges', async () => {
    // Insert a ref that the resolver can't bind by hand-writing it
    // directly — bypasses any per-language heuristic that might
    // already-resolve the call to a stub. The ref's from_node_id is
    // the parent (createTypeChecker), its line falls inside the
    // promoted fn's range; slice 4 must re-anchor it.
    h = await setupHarness({ threshold: 1 });
    const parentNode = h.cg.queries.db.prepare("SELECT id FROM nodes WHERE name = 'createTypeChecker'").get() as {
      id: string;
    };
    h.cg.queries.db
      .prepare(
        `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
         VALUES (?, 'definitelyNoSuchSymbol_xyz123', 'calls', 5, 4, 'src/checker.ts', 'typescript')`,
      )
      .run(parentNode.id);

    await h.handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol', deep: true });
    await h.cg.sync();

    const rows = lookupNestedFnsByName(h.cg.queries, 'getTypeOfSymbol');
    const promotedId = rows[0]!.promotedNodeId!;
    const refs = h.cg.queries.db
      .prepare("SELECT from_node_id FROM unresolved_refs WHERE reference_name = 'definitelyNoSuchSymbol_xyz123'")
      .all() as Array<{ from_node_id: string }>;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]!.from_node_id).toBe(promotedId);
  });

  it('cross-file edges are not touched (same line numbers in another file)', async () => {
    h = await setupHarness({ threshold: 1 });
    // Add another file that ALSO has code at line 5 (the line where
    // `getTypeOfSymbol`'s body lives in checker.ts) — but referencing
    // helperA. Migration must NOT pull this edge into the promoted node.
    fs.writeFileSync(
      path.join(h.dir, 'src', 'other.ts'),
      `// padding\n// padding\n// padding\n// padding\nexport function otherFn() { return /* line 5 */ helperA(2); }\n`,
    );
    await h.cg.sync();
    await h.handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol', deep: true });
    await h.cg.sync();

    const rows = lookupNestedFnsByName(h.cg.queries, 'getTypeOfSymbol');
    const promotedId = rows[0]!.promotedNodeId!;
    const otherFn = h.cg.queries.db
      .prepare("SELECT id FROM nodes WHERE name = 'otherFn' AND kind = 'function'")
      .get() as { id: string };
    const helperANode = h.cg.queries.db
      .prepare("SELECT id FROM nodes WHERE name = 'helperA' AND kind = 'function'")
      .get() as { id: string };
    // otherFn`s call to helperA should NOT have been re-anchored.
    const edges = h.cg.queries.db
      .prepare("SELECT source FROM edges WHERE target = ? AND kind = 'calls'")
      .all(helperANode.id) as Array<{ source: string }>;
    const callers = new Set(edges.map((e) => e.source));
    expect(callers.has(otherFn.id)).toBe(true);
    // And the promoted node should STILL have its in-range call.
    expect(callers.has(promotedId)).toBe(true);
  });
});
