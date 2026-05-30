/**
 * Regression guard for FRICTION-1: cartograph_find({by:'name',mode:'semantic'})
 * was rendering similarity as ">100%" (e.g. "12439% similar") because
 * handleSemanticConcept multiplied r.score * 100 even though the score from
 * the in-memory EmbeddingCache path (topKByCosineMatrix) is a raw dot product,
 * not a cosine similarity in [0, 1]. Scores > 1 thus produced absurd
 * percentages.
 *
 * The fix: render `score X.XXX` (matching direction:similar which prints
 * `score=0.701`) — no multiplication, no `%` suffix. This test mocks
 * llmFindImplementations to inject a controlled score (including values > 1
 * which would have triggered the original bug) and verifies the rendered
 * output has the correct format.
 */

import { describe, it, expect } from 'vitest';
import { mock } from 'bun:test';
import type { Node, SearchResult } from '../src/types.js';

// ── Mutable result store + module mock (NOT hoisted under bun:test) ───────
// bun:test's `mock.module(...)` is registered at the call site (not
// hoisted like vitest's `vi.mock`), so we register the mock FIRST
// and import the importer via dynamic `await import(...)` below.
const store: { results: SearchResult[] } = { results: [] };
mock.module('../src/cartograph-llm-service.js', () => ({
  llmFindImplementations: async () => store.results,
  llmFindSimilar: async () => [],
}));

// ── Import after mock registration ────────────────────────────────────────
const { handleSearchSemantic } = await import('../src/mcp/tools/_search-semantic.js');
import type { ToolCtx } from '../src/mcp/tools/types.js';
import type { ToolOutcome } from '../src/mcp/tools/_outcome.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function fakeNode(name: string, filePath = 'src/foo.ts', startLine = 5): Node {
  return {
    id: `function:${filePath}:${name}`,
    name,
    kind: 'function',
    filePath,
    startLine,
    endLine: 10,
    isExported: true,
    language: 'typescript',
  } as Node;
}

/** Minimal ToolCtx — only what handleSearchSemantic actually reads. */
function makeCtx(): ToolCtx {
  const fakeCartograph = {
    llm: {
      getEffectiveLlmConfig: async () => ({}),
    },
    queries: {
      getNodeById: (id: string) => store.results.find((r) => r.node.id === id)?.node ?? null,
      db: { prepare: () => ({ get: () => undefined }) },
    },
  } as unknown;

  return {
    getCartograph: () => fakeCartograph as ReturnType<ToolCtx['getCartograph']>,
    refIds: undefined,
    callIds: undefined as unknown as ToolCtx['callIds'],
  } as ToolCtx;
}

/** Unwrap a `handleSearchSemantic` outcome's success text. `handleSearchSemantic`
 *  returns a `ToolOutcome` (P6) — fail loudly if it produced an `err` arm. */
function textOf(outcome: ToolOutcome): string {
  if (!outcome.ok) throw new Error(`expected an ok outcome, got err: ${outcome.error}`);
  return outcome.value.content[0]!.text;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('FRICTION-1: semantic concept score format', () => {
  it('renders "score X.XXX" without a "%" suffix for a normal [0,1] score', async () => {
    store.results = [{ node: fakeNode('detectStaleness'), score: 0.701 }];
    const ctx = makeCtx();
    const result = await handleSearchSemantic(ctx, {
      mode: 'semantic',
      query: 'detect index staleness against git HEAD',
    });
    const text = textOf(result);
    expect(text).toContain('score 0.701');
    expect(text).not.toMatch(/\d+%\s*similar/);
  });

  it('renders "score X.XXX" even when score > 1 (dot-product from un-normalised cache)', async () => {
    // The in-memory EmbeddingCache path (topKByCosineMatrix) computes raw dot
    // products without L2 normalisation. Scores > 1 were previously displayed
    // as e.g. "12439% similar" (score 124.39 * 100 = 12439).
    store.results = [{ node: fakeNode('handleSomething'), score: 124.39 }];
    const ctx = makeCtx();
    const result = await handleSearchSemantic(ctx, {
      mode: 'semantic',
      query: 'handle something',
    });
    const text = textOf(result);
    // Must render the raw score, not a multiplied percentage.
    expect(text).toContain('score 124.390');
    expect(text).not.toMatch(/12439.*%/);
    expect(text).not.toMatch(/\d+%\s*similar/);
  });

  it('shows multiple results in score-descending order', async () => {
    store.results = [
      { node: fakeNode('alpha'), score: 0.9 },
      { node: fakeNode('beta'), score: 0.5 },
    ];
    const ctx = makeCtx();
    const result = await handleSearchSemantic(ctx, {
      mode: 'semantic',
      query: 'some concept',
    });
    const text = textOf(result);
    const alphaIdx = text.indexOf('alpha');
    const betaIdx = text.indexOf('beta');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    // alpha (0.9) should appear before beta (0.5) since results come in the
    // order returned by llmFindImplementations (caller sorts by score).
    expect(alphaIdx).toBeLessThan(betaIdx);
    // Neither should have "% similar".
    expect(text).not.toMatch(/\d+%\s*similar/);
  });
});
