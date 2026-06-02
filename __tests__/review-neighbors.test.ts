/**
 * Tests for `cartograph_review_neighbors` (Stage 4 #7) — semantic
 * lookalike finder for PR review.
 *
 * Covers the input-validation paths and the resolve-then-rank pipeline.
 * Synthetic deterministic embeddings (no live LLM) so the tests are
 * cheap and deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { vectorToBytes } from '../src/llm/embeddings.js';
import { getToolModules } from '../src/mcp/tools/registry.js';
import { isTrivialConstant } from '../src/mcp/tools/review-neighbors.js';
import type { ToolCtx } from '../src/mcp/tool-types.js';

const DIM = 16;
const MODEL = 'stub-embed-model';

function unitVec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 7 + i * 13);
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < DIM; i++) v[i]! /= n;
  return v;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rn-'));
}

interface Fixture {
  cg: InstanceType<typeof Cartograph>;
  dir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    'export function alpha() { return 1; }\nexport function beta() { return 2; }\n',
  );
  fs.writeFileSync(
    path.join(dir, 'b.ts'),
    'export function gamma() { return 3; }\nexport function delta() { return 4; }\n',
  );
  await Cartograph.init(dir, { index: false });
  const cg = await Cartograph.open(dir);
  await cg.indexAll({ summarize: false });
  return {
    cg,
    dir,
    cleanup: () => {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function getReviewNeighborsTool() {
  // After the cartograph_review tool merge (Stage 8), neighbors lives
  // under `cartograph_review` with `mode: 'neighbors'`. The handler
  // dispatches by mode; tests pass `mode: 'neighbors'` in args.
  const tool = getToolModules().find((m) => m.definition.name === 'cartograph_review');
  if (!tool) throw new Error('cartograph_review not registered');
  return tool;
}

/** Minimal ToolCtx shim — the tool only reads `getCartograph`. */
function makeCtx(cg: InstanceType<typeof Cartograph>): ToolCtx {
  return {
    getCartograph: () => cg,
  } as unknown as ToolCtx;
}

function getNodeIdByName(cg: InstanceType<typeof Cartograph>, name: string): string | null {
  const row = cg.db
    .getDb()
    .prepare(`SELECT id FROM nodes WHERE name = ? AND kind NOT IN ('file', 'import', 'export') LIMIT 1`)
    .get(name) as { id?: string } | undefined;
  return row?.id ?? null;
}

function seedEmbeddingForNode(cg: InstanceType<typeof Cartograph>, nodeId: string, vec: Float32Array): void {
  upsertSymbolEmbedding({
    qb: cg.queries,
    nodeId,
    embedding: vectorToBytes(vec),
    model: MODEL,
    summaryHashAtEmbed: '',
  });
}

describe('cartograph_review_neighbors — input validation', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setupFixture();
  });
  afterEach(() => f.cleanup());

  it('returns an error when neither files nor symbols are provided', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/files|symbols/i);
    expect(text).toMatch(/at least one/i);
  });

  it('returns "no symbols resolved" when files match no indexed paths', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), {
      mode: 'neighbors',
      files: ['nonexistent/path.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no symbols resolved/i);
  });

  it('returns "no embedding model" when symbols resolve but no embeddings exist', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', files: ['a.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no embedding model|no embeddings/i);
  });
});

describe('cartograph_review_neighbors — resolution + ranking', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setupFixture();
    // Seed embeddings: alpha + beta point in the same direction (they
    // should be each other's neighbors), gamma + delta point in a
    // different direction.
    const idAlpha = getNodeIdByName(f.cg, 'alpha');
    const idBeta = getNodeIdByName(f.cg, 'beta');
    const idGamma = getNodeIdByName(f.cg, 'gamma');
    const idDelta = getNodeIdByName(f.cg, 'delta');
    if (!idAlpha || !idBeta || !idGamma || !idDelta) {
      throw new Error('fixture symbols missing from index');
    }
    seedEmbeddingForNode(f.cg, idAlpha, unitVec(1));
    seedEmbeddingForNode(f.cg, idBeta, unitVec(1)); // identical direction → most similar to alpha
    seedEmbeddingForNode(f.cg, idGamma, unitVec(99));
    seedEmbeddingForNode(f.cg, idDelta, unitVec(99));
  });
  afterEach(() => f.cleanup());

  it('resolves a file → returns lookalikes for its symbols', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', files: ['a.ts'], k: 3 });
    const text = result.content[0]?.text ?? '';
    // alpha + beta come from a.ts so they are the changed set;
    // their neighbors gamma + delta should NOT appear since they're in a
    // different direction. But the tool should at least mention the
    // changed symbols and not error.
    expect(text).toMatch(/alpha|beta/i);
  });

  it('resolves a symbol name → finds its semantic peer in another file', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', symbols: ['alpha'], k: 5 });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/alpha/i);
    // beta should be the top peer (same direction); skip the assertion
    // when sqlite-vec extension isn't loaded — findSimilarViaVec returns
    // [] without it, surfacing a "no neighbors" message instead.
    if (f.cg.db.hasVecExtension()) {
      expect(text).toMatch(/beta/i);
      // gamma/delta point in a different direction; if they appear
      // they should rank below beta.
      const betaIdx = text.toLowerCase().indexOf('beta');
      const gammaIdx = text.toLowerCase().indexOf('gamma');
      if (gammaIdx >= 0) expect(betaIdx).toBeLessThan(gammaIdx);
    }
  });

  it('excludes the changed-symbol set itself from the lookalike output', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', files: ['a.ts'], k: 5 });
    const text = result.content[0]?.text ?? '';
    // The lookalikes section (the part AFTER the "## Top N lookalikes"
    // sub-header, not the H1 banner) should not list alpha or beta —
    // they're in the changed set, the tool excludes them by design.
    const lookalikesSection = text.split(/##\s*Top\s+\d+\s+lookalikes/i)[1] ?? '';
    if (f.cg.db.hasVecExtension() && lookalikesSection.length > 0) {
      expect(lookalikesSection.toLowerCase()).not.toContain('alpha');
      expect(lookalikesSection.toLowerCase()).not.toContain('beta');
    }
  });

  it('rejects k above the documented maximum', async () => {
    const tool = getReviewNeighborsTool();
    // cartograph_review is Zod-backed (P4 wave 2): `k` carries the
    // documented `.max(50)` bound, so an over-max value is REJECTED at
    // the dispatch boundary (locked reject-out-of-range policy) rather
    // than silently clamped to 50.
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', symbols: ['alpha'], k: 999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/k: must be ≤ 50/);
  });

  it('accepts k within the documented maximum', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), { mode: 'neighbors', symbols: ['alpha'], k: 50 });
    expect(result.isError).not.toBe(true);
  });
});

// ============================================================================
// FRICTION-30 — dedupeByName: boilerplate-constant clones shouldn't dominate
// the top-K. When the codebase has N identical-looking constants (e.g.
// `requireCjs = createRequire(import.meta.url)` repeated across files), their
// embeddings are near-identical and historically swept the top-K, crowding
// out the domain-relevant peer.
// ============================================================================

describe('cartograph_review_neighbors — dedupeByName', () => {
  let f: Fixture;

  async function setupClonesFixture(): Promise<Fixture> {
    // Build a fixture with: one CHANGED file containing `alpha`, plus
    // three clone-named neighbours `dup` across three files (identical
    // direction) and one unique-named neighbour `unique_peer`.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'changed.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'clone1.ts'), 'export const dup = 1;\n');
    fs.writeFileSync(path.join(dir, 'clone2.ts'), 'export const dup = 2;\n');
    fs.writeFileSync(path.join(dir, 'clone3.ts'), 'export const dup = 3;\n');
    fs.writeFileSync(path.join(dir, 'unique.ts'), 'export function unique_peer() { return 42; }\n');
    await Cartograph.init(dir, { index: false });
    const cg = await Cartograph.open(dir);
    await cg.indexAll({ summarize: false });
    return {
      cg,
      dir,
      cleanup: () => {
        cg.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  beforeEach(async () => {
    f = await setupClonesFixture();
    const idAlpha = getNodeIdByName(f.cg, 'alpha');
    if (!idAlpha) throw new Error('alpha missing from index');

    // dup × 3 in nearby direction (max-similar)
    const dupIds: string[] = [];
    const dupRows = f.cg.db
      .getDb()
      .prepare(`SELECT id FROM nodes WHERE name = 'dup' AND kind NOT IN ('file', 'import', 'export')`)
      .all() as Array<{ id: string }>;
    for (const r of dupRows) dupIds.push(r.id);

    const idUnique = getNodeIdByName(f.cg, 'unique_peer');
    if (!idUnique) throw new Error('unique_peer missing from index');

    // alpha + dup × 3 all point in the SAME direction → identical similarity.
    // unique_peer slightly off-axis (still high similarity) so it lands
    // just below the clones in the global ranking.
    seedEmbeddingForNode(f.cg, idAlpha, unitVec(1));
    for (const dupId of dupIds) seedEmbeddingForNode(f.cg, dupId, unitVec(1));
    seedEmbeddingForNode(f.cg, idUnique, unitVec(2));
  });
  afterEach(() => f.cleanup());

  it('default dedupeByName=true: top-3 contains AT MOST ONE `dup` instance', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), {
      mode: 'neighbors',
      files: ['changed.ts'],
      k: 3,
    });
    if (!f.cg.db.hasVecExtension()) return; // skip when sqlite-vec missing
    const text = result.content[0]?.text ?? '';
    // Count `### dup ` occurrences in the lookalikes section. With dedupe,
    // at most one should appear; with `unique_peer` still embedded it
    // should occupy one of the remaining slots.
    const lookalikesSection = text.split(/##\s*Top\s+\d+\s+lookalikes/i)[1] ?? '';
    const dupCount = (lookalikesSection.match(/^###\s+dup\b/gm) ?? []).length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });

  it('dedupeByName=false: top-3 may contain MULTIPLE `dup` instances (legacy)', async () => {
    const tool = getReviewNeighborsTool();
    const result = await tool.handle(makeCtx(f.cg), {
      mode: 'neighbors',
      files: ['changed.ts'],
      k: 3,
      dedupeByName: false,
    });
    if (!f.cg.db.hasVecExtension()) return;
    const text = result.content[0]?.text ?? '';
    const lookalikesSection = text.split(/##\s*Top\s+\d+\s+lookalikes/i)[1] ?? '';
    const dupCount = (lookalikesSection.match(/^###\s+dup\b/gm) ?? []).length;
    // With dedupe disabled the same name can repeat; on this fixture we
    // expect all 3 dup clones to occupy the top slots.
    expect(dupCount).toBeGreaterThan(1);
  });
});

describe('cartograph_review (mode=neighbors) — registration', () => {
  it('is registered with the expected schema', () => {
    const tool = getReviewNeighborsTool();
    expect(tool.definition.name).toBe('cartograph_review');
    expect(tool.definition.description.length).toBeGreaterThan(50);
    const props = tool.definition.inputSchema.properties as Record<string, unknown>;
    expect(props['mode']).toBeDefined();
    expect(props['files']).toBeDefined();
    expect(props['symbols']).toBeDefined();
    expect(props['k']).toBeDefined();
  });

  it('dedupeByName schema text describes only same-name dedupe, not constant filtering (friction-23)', () => {
    const tool = getReviewNeighborsTool();
    const props = tool.definition.inputSchema.properties as Record<string, { description?: string }>;
    const desc = props['dedupeByName']?.description ?? '';
    // The corrected text must NOT over-promise constant-clone prevention.
    expect(desc).not.toMatch(/prevents boilerplate-constant clones from crowding/i);
    // It should describe same-name dedupe and point at the separate
    // trivial-constant filter.
    expect(desc).toMatch(/same-named/i);
    expect(desc).toMatch(/trivial-constant filter|single-literal/i);
  });
});

describe('isTrivialConstant — friction-23 trivial-constant filter', () => {
  it('flags constants/variables bound to a single literal', () => {
    expect(isTrivialConstant('constant', '= 1')).toBe(true);
    expect(isTrivialConstant('constant', '= 3.5')).toBe(true);
    expect(isTrivialConstant('constant', '= 0xff')).toBe(true);
    expect(isTrivialConstant('constant', '= -42')).toBe(true);
    expect(isTrivialConstant('constant', '= 1_000')).toBe(true);
    expect(isTrivialConstant('constant', '= true')).toBe(true);
    expect(isTrivialConstant('constant', '= null')).toBe(true);
    expect(isTrivialConstant('variable', "= 'small'")).toBe(true);
    expect(isTrivialConstant('constant', '= 5;')).toBe(true);
  });

  it('flags a constant with no recorded signature (bare one-liner)', () => {
    expect(isTrivialConstant('constant', null)).toBe(true);
    expect(isTrivialConstant('constant', '')).toBe(true);
  });

  it('keeps constants with structured initializers', () => {
    // Identifier alias — carries reference structure, not trivial.
    expect(isTrivialConstant('constant', '= ANALYSABLE_MIN_LOC')).toBe(false);
    expect(isTrivialConstant('constant', '= { a: 1 }')).toBe(false);
    expect(isTrivialConstant('constant', '= [1, 2, 3]')).toBe(false);
    expect(isTrivialConstant('constant', '= computeDefault()')).toBe(false);
    expect(isTrivialConstant('constant', '= `tpl ${x}`')).toBe(false);
  });

  it('never flags non-constant kinds', () => {
    expect(isTrivialConstant('function', '= 1')).toBe(false);
    expect(isTrivialConstant('method', null)).toBe(false);
    expect(isTrivialConstant('interface', '')).toBe(false);
    expect(isTrivialConstant('class', '= 1')).toBe(false);
  });
});
