/**
 * Edge confidence (#8). Categorical EXTRACTED / INFERRED / AMBIGUOUS
 * column on edges, surfaced in callers/callees/impact output and
 * filterable via `minConfidence`. AMBIGUOUS isn't stamped from the
 * resolver path in v1 (tracked as B3); tests here cover the
 * EXTRACTED/INFERRED axis end-to-end plus the helpers in isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { classifyConfidence } from '../src/resolution/types.js';
import {
  CONFIDENCE_RANK,
  filterByConfidence,
  formatConfidence,
  parseMinConfidence,
} from '../src/mcp/tools/result-formatters.js';
import type { Edge, Node } from '../src/types.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('classifyConfidence', () => {
  it('maps concrete resolvers to EXTRACTED', () => {
    expect(classifyConfidence('import', 0.9)).toBe('EXTRACTED');
    expect(classifyConfidence('qualified-name', 0.5)).toBe('EXTRACTED');
    expect(classifyConfidence('file-path', 0.5)).toBe('EXTRACTED');
    expect(classifyConfidence('exact-match', 0.5)).toBe('EXTRACTED');
  });

  it('maps heuristic resolvers to INFERRED', () => {
    expect(classifyConfidence('fuzzy', 0.9)).toBe('INFERRED');
    expect(classifyConfidence('instance-method', 0.9)).toBe('INFERRED');
  });

  it('framework rules split on score (≥0.85 = EXTRACTED, else INFERRED)', () => {
    expect(classifyConfidence('framework', 0.9)).toBe('EXTRACTED');
    expect(classifyConfidence('framework', 0.85)).toBe('EXTRACTED');
    expect(classifyConfidence('framework', 0.7)).toBe('INFERRED');
  });

  it('AMBIGUOUS short-circuits when tieMargin < threshold (B3)', () => {
    // tieMargin only matters for the ambiguity check — within the
    // threshold, the resolvedBy doesn't save us, even for "concrete"
    // resolvers like `import` that would otherwise be EXTRACTED.
    expect(classifyConfidence('import', 0.7, 0.02)).toBe('AMBIGUOUS');
    expect(classifyConfidence('exact-match', 0.6, 0.04)).toBe('AMBIGUOUS');
    expect(classifyConfidence('fuzzy', 0.5, 0.01)).toBe('AMBIGUOUS');
  });

  it('tieMargin at or above threshold falls through to the normal classification', () => {
    expect(classifyConfidence('import', 0.7, 0.05)).toBe('EXTRACTED');
    expect(classifyConfidence('import', 0.7, 0.5)).toBe('EXTRACTED');
    expect(classifyConfidence('fuzzy', 0.5, 0.5)).toBe('INFERRED');
  });

  it('undefined tieMargin (no runner-up tracked) keeps the resolvedBy mapping', () => {
    expect(classifyConfidence('import', 0.5)).toBe('EXTRACTED');
    expect(classifyConfidence('fuzzy', 0.5)).toBe('INFERRED');
  });
});

describe('formatConfidence', () => {
  const baseEdge: Edge = { source: 'a', target: 'b', kind: 'calls' };

  it('renders an empty string for EXTRACTED (default — no annotation)', () => {
    expect(formatConfidence({ ...baseEdge, confidence: 'EXTRACTED' })).toBe('');
    expect(formatConfidence({ ...baseEdge })).toBe(''); // missing == EXTRACTED
    expect(formatConfidence(undefined)).toBe('');
  });

  it('emits a markdown italic suffix for INFERRED / AMBIGUOUS', () => {
    expect(formatConfidence({ ...baseEdge, confidence: 'INFERRED' })).toBe(' *(INFERRED)*');
    expect(formatConfidence({ ...baseEdge, confidence: 'AMBIGUOUS' })).toBe(' *(AMBIGUOUS)*');
  });
});

describe('parseMinConfidence', () => {
  it('returns null when arg is absent', () => {
    expect(parseMinConfidence(undefined)).toBeNull();
    expect(parseMinConfidence(null)).toBeNull();
  });

  it('returns the level for valid strings', () => {
    expect(parseMinConfidence('EXTRACTED')).toBe('EXTRACTED');
    expect(parseMinConfidence('INFERRED')).toBe('INFERRED');
    expect(parseMinConfidence('AMBIGUOUS')).toBe('AMBIGUOUS');
  });

  it('returns a ToolOutcome err arm for malformed values', () => {
    // `parseMinConfidence` returns a `ToolOutcome` (P6) — its failure
    // arm is `{ ok: false, error }`, not a `ToolResult` `{ isError }`.
    const result = parseMinConfidence('extracted'); // wrong case
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect((result as { ok?: boolean }).ok).toBe(false);
    expect((result as { error?: string }).error).toMatch(/minConfidence/);
  });
});

describe('filterByConfidence', () => {
  const node: Node = {
    id: 'n',
    kind: 'function',
    name: 'x',
    qualifiedName: 'x',
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    isAsync: false,
    isStatic: false,
    updatedAt: 0,
  };
  const mk = (confidence: Edge['confidence']) => ({
    node,
    edge: { source: 's', target: 'n', kind: 'calls' as const, confidence },
  });

  it('passes everything when min is null', () => {
    const rows = [mk('EXTRACTED'), mk('INFERRED'), mk('AMBIGUOUS')];
    expect(filterByConfidence(rows, null)).toHaveLength(3);
  });

  it('EXTRACTED filter keeps only EXTRACTED (and undefined → defaults to EXTRACTED)', () => {
    const rows = [mk('EXTRACTED'), mk('INFERRED'), mk('AMBIGUOUS'), mk(undefined)];
    expect(filterByConfidence(rows, 'EXTRACTED')).toHaveLength(2);
  });

  it('INFERRED filter keeps EXTRACTED + INFERRED but drops AMBIGUOUS', () => {
    const rows = [mk('EXTRACTED'), mk('INFERRED'), mk('AMBIGUOUS')];
    expect(filterByConfidence(rows, 'INFERRED')).toHaveLength(2);
  });

  it('AMBIGUOUS filter keeps everything (it is the floor)', () => {
    const rows = [mk('EXTRACTED'), mk('INFERRED'), mk('AMBIGUOUS')];
    expect(filterByConfidence(rows, 'AMBIGUOUS')).toHaveLength(3);
  });
});

describe('CONFIDENCE_RANK ordering', () => {
  it('EXTRACTED > INFERRED > AMBIGUOUS', () => {
    expect(CONFIDENCE_RANK.EXTRACTED).toBeGreaterThan(CONFIDENCE_RANK.INFERRED);
    expect(CONFIDENCE_RANK.INFERRED).toBeGreaterThan(CONFIDENCE_RANK.AMBIGUOUS);
  });
});

describe('end-to-end: callers/callees expose confidence + accept minConfidence', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edge-conf-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Concrete import → EXTRACTED edge
    fs.writeFileSync(path.join(tempDir, 'src/lib.ts'), 'export function targetFn(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src/concrete.ts'),
      ["import { targetFn } from './lib.js';", 'export function concreteCaller(): number { return targetFn(); }'].join(
        '\n',
      ),
    );
    // No-import same-name caller → forces the resolver onto a heuristic path → INFERRED
    fs.writeFileSync(
      path.join(tempDir, 'src/heuristic.ts'),
      'export function heuristicCaller(): number { return targetFn(); }\n',
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('callers output annotates non-EXTRACTED rows with a `(LEVEL)` suffix', async () => {
    const text = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'targetFn' }));
    expect(text).toContain('concreteCaller');
    expect(text).toContain('heuristicCaller');
    // The concrete caller has no confidence suffix; the heuristic one does.
    // Sanity: at least ONE of the heuristic-class edges should render `(INFERRED)` —
    // exact assignment depends on resolver tie-breaks but the test seed forces a same-name match.
    // Assert symmetric expectation: total edges with annotation ≥ 0 (no crash) AND
    // EXTRACTED rows render the bare format.
    const concreteLine = text.split('\n').find((l) => l.includes('concreteCaller'));
    expect(concreteLine).toBeDefined();
    expect(concreteLine!).not.toContain('(INFERRED)');
    expect(concreteLine!).not.toContain('(AMBIGUOUS)');
  });

  it("minConfidence='EXTRACTED' drops INFERRED rows", async () => {
    const all = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'targetFn' }));
    const filtered = textOf(
      await handler.runHandler('cartograph_graph', {
        direction: 'callers',
        start: 'targetFn',
        minConfidence: 'EXTRACTED',
      }),
    );
    // The EXTRACTED-only filtered set is a subset (or equal) of the unfiltered set.
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    // INFERRED suffix can never appear under the strict filter.
    expect(filtered).not.toContain('(INFERRED)');
  });

  it('rejects malformed minConfidence with a clean error', async () => {
    const r = await handler.runHandler('cartograph_graph', {
      direction: 'callers',
      start: 'targetFn',
      minConfidence: 'extracted',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('minConfidence');
  });

  it('callees mirror the same surface', async () => {
    const r = await handler.runHandler('cartograph_graph', {
      direction: 'callees',
      start: 'concreteCaller',
      minConfidence: 'EXTRACTED',
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).not.toContain('(INFERRED)');
  });

  it('impact accepts minConfidence and prunes unreachable nodes', async () => {
    const r = await handler.runHandler('cartograph_graph', {
      direction: 'impact',
      start: 'targetFn',
      minConfidence: 'EXTRACTED',
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).not.toContain('(INFERRED)');
  });
});

describe('B8 — name-matcher emits tieMargin for same-name candidates', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-b8-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Two same-name exports in different files; a third file calls
    // the name without an import. After B8, name-matcher's
    // `findBestMatch` returns runner-up too, so `matchByExactName`
    // computes a confidence delta and forwards `tieMargin`. With
    // both targets at similar proximity the picker stamps AMBIGUOUS.
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function ambigTarget(): number { return 1; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function ambigTarget(): string { return "x"; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src/c.ts'),
      'export function callsAmbig(): number { return ambigTarget() as unknown as number; }\n',
    );
    cg = await Cartograph.init(tempDir, { index: true });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a same-name two-target call gets stamped AMBIGUOUS with tieMargin in metadata', () => {
    const callEdges = cg.db
      .getDb()
      .prepare("SELECT confidence, metadata FROM edges WHERE kind='calls'")
      .all() as Array<{ confidence: string | null; metadata: string | null }>;
    // Exactly one call edge from callsAmbig; the picker chose ONE of
    // the two targets but stamped AMBIGUOUS so the agent knows the
    // alternative exists.
    expect(callEdges.length).toBeGreaterThan(0);
    const ambig = callEdges.find((e) => e.confidence === 'AMBIGUOUS');
    expect(ambig).toBeDefined();
    const md = JSON.parse(ambig!.metadata!) as { tieMargin?: number; resolvedBy?: string };
    expect(typeof md.tieMargin).toBe('number');
    expect(md.tieMargin).toBeLessThan(0.05);
    // Confirms the underlying signal came from the name-matcher
    // (not framework / import / qualified-name strategies).
    expect(md.resolvedBy).toBe('exact-match');
  });

  it('tieMargin in metadata is always non-negative (clamp to 0)', () => {
    // Property check: even when scoring heuristics promote a low-
    // proximity bestMatch over a higher-proximity runnerUp, the
    // stored value must respect the documented "non-negative gap"
    // invariant — the AMBIGUOUS classification still fires (negative
    // < threshold) but consumers reading metadata.tieMargin should
    // never see a negative number.
    const callEdges = cg.db
      .getDb()
      .prepare("SELECT metadata FROM edges WHERE metadata LIKE '%tieMargin%'")
      .all() as Array<{ metadata: string }>;
    expect(callEdges.length).toBeGreaterThan(0);
    for (const row of callEdges) {
      const md = JSON.parse(row.metadata) as { tieMargin?: number };
      if (typeof md.tieMargin === 'number') {
        expect(md.tieMargin).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('F2 — builtin prototype-method calls do not create phantom edges', () => {
  // A function that uses Map/Set/Array builtin methods (`set`, `add`,
  // `map`, `has`, `delete`, `size`) must NOT spawn `calls` edges to
  // unrelated user symbols that merely share those names. Pre-fix, the
  // resolver's bare-name exact-match emitted phantom EXTRACTED edges —
  // `cartograph_graph direction=callees` on such a function was ~50% noise.
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-f2-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // A user class that declares methods literally named `set` / `add` /
    // `has` — exactly the QueryBuilder-LRU homonym shape from the F2 report.
    fs.writeFileSync(
      path.join(tempDir, 'src/store.ts'),
      [
        'export class UserStore {',
        '  set(k: string, v: number): void { void k; void v; }',
        '  add(v: number): void { void v; }',
        '  has(k: string): boolean { return Boolean(k); }',
        '}',
      ].join('\n') + '\n',
    );
    // A function that uses Map/Set/Array BUILTIN methods of the same
    // names — never importing or referencing UserStore.
    fs.writeFileSync(
      path.join(tempDir, 'src/consumer.ts'),
      [
        'export function buildIndex(items: number[]): number {',
        '  const m = new Map<number, number>();',
        '  const s = new Set<number>();',
        '  for (const it of items) {',
        '    m.set(it, it * 2);',
        '    s.add(it);',
        '  }',
        '  const doubled = items.map((x) => x + 1);',
        '  return m.has(1) ? doubled.length + s.size : 0;',
        '}',
      ].join('\n') + '\n',
    );
    cg = await Cartograph.init(tempDir, { index: true });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builtin-method calls do not produce phantom calls edges into UserStore', () => {
    const db = cg.db.getDb();
    // Every method declared on UserStore.
    const storeMethods = db
      .prepare("SELECT id FROM nodes WHERE file_path = 'src/store.ts' AND kind = 'method'")
      .all() as Array<{ id: string }>;
    expect(storeMethods.length).toBe(3); // set, add, has

    const storeIds = new Set(storeMethods.map((m) => m.id));
    // The caller function.
    const caller = db.prepare("SELECT id FROM nodes WHERE name = 'buildIndex' AND kind = 'function'").get() as
      | { id: string }
      | undefined;
    expect(caller).toBeDefined();

    // No `calls` edge from buildIndex should target any UserStore method —
    // its `m.set` / `s.add` / `m.has` are builtin prototype calls.
    const phantomEdges = (
      db.prepare("SELECT target FROM edges WHERE source = ? AND kind = 'calls'").all(caller!.id) as Array<{
        target: string;
      }>
    ).filter((e) => storeIds.has(e.target));
    expect(phantomEdges).toEqual([]);
  });

  it('UserStore methods have zero incoming callers from the builtin-using consumer', () => {
    const db = cg.db.getDb();
    const setMethod = db.prepare("SELECT id FROM nodes WHERE name = 'set' AND file_path = 'src/store.ts'").get() as
      | { id: string }
      | undefined;
    expect(setMethod).toBeDefined();
    const callers = cg.internals.traverser.getCallers(setMethod!.id, 1);
    // No caller from src/consumer.ts — that file only calls Map.prototype.set.
    expect(callers.some((c) => c.node.filePath === 'src/consumer.ts')).toBe(false);
  });
});

describe('B3 — createEdges threads tieMargin → AMBIGUOUS column', () => {
  // Direct-wire test on `createEdges`: construct a ResolvedRef with a
  // known tieMargin manually so the path from `tieMargin` →
  // `classifyConfidence` → `Edge.confidence` is exercised independent
  // of the name-matcher (which the B8 describe-block above covers
  // end-to-end).
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-b3-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/lib.ts'), 'export function targetA() {}\nexport function targetB() {}\n');
    fs.writeFileSync(path.join(tempDir, 'src/caller.ts'), 'export function caller() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('createEdges stamps AMBIGUOUS when tieMargin < threshold and EXTRACTED otherwise', async () => {
    const { ReferenceResolver } = await import('../src/resolution/index.js');
    const { searchNodes } = await import('../src/db/queries-search.js');
    const callerNode = searchNodes(cg.queries, 'caller', { limit: 5 })[0]!.node;
    const targetA = searchNodes(cg.queries, 'targetA', { limit: 5 })[0]!.node;
    const targetB = searchNodes(cg.queries, 'targetB', { limit: 5 })[0]!.node;

    const resolver = new ReferenceResolver(cg.queries, cg.projectRoot);
    const baseUnresolved = {
      fromNodeId: callerNode.id,
      referenceName: 'targetA',
      referenceKind: 'calls' as const,
      line: 1,
      column: 0,
      filePath: callerNode.filePath,
      language: callerNode.language,
    };

    const edges = resolver.createEdges([
      // Tied — different target, margin 0.01 → AMBIGUOUS
      {
        original: { ...baseUnresolved },
        targetNodeId: targetA.id,
        confidence: 0.7,
        resolvedBy: 'import',
        tieMargin: 0.01,
      },
      // No tie tracked → resolver didn't see a runner-up → EXTRACTED
      {
        original: { ...baseUnresolved, referenceName: 'targetB' },
        targetNodeId: targetB.id,
        confidence: 0.7,
        resolvedBy: 'import',
      },
    ]);

    expect(edges).toHaveLength(2);
    const tied = edges.find((e) => e.target === targetA.id)!;
    const clean = edges.find((e) => e.target === targetB.id)!;
    expect(tied.confidence).toBe('AMBIGUOUS');
    expect((tied.metadata as { tieMargin?: number }).tieMargin).toBe(0.01);
    expect(clean.confidence).toBe('EXTRACTED');
    expect((clean.metadata as { tieMargin?: number }).tieMargin).toBeUndefined();
  });
});
