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

import { describe, expect, it } from 'vitest';
import type { Node, SearchResult } from '../src/types.js';
import { buildSearchSemanticConceptSpec } from '../src/mcp/tools/_search-semantic.js';
import { renderMarkdownCardList } from '../src/mcp/tools/_result-spec.js';

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

function renderConceptResults(results: SearchResult[], query = 'some concept'): string {
  return renderMarkdownCardList(buildSearchSemanticConceptSpec(query, results)).trimEnd();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('FRICTION-1: semantic concept score format', () => {
  it('renders "score X.XXX" without a "%" suffix for a normal [0,1] score', async () => {
    const text = renderConceptResults(
      [{ node: fakeNode('detectStaleness'), score: 0.701 }],
      'detect index staleness against git HEAD',
    );
    expect(text).toContain('score 0.701');
    expect(text).not.toMatch(/\d+%\s*similar/);
  });

  it('renders "score X.XXX" even when score > 1 (dot-product from un-normalised cache)', async () => {
    // The in-memory EmbeddingCache path (topKByCosineMatrix) computes raw dot
    // products without L2 normalisation. Scores > 1 were previously displayed
    // as e.g. "12439% similar" (score 124.39 * 100 = 12439).
    const text = renderConceptResults([{ node: fakeNode('handleSomething'), score: 124.39 }], 'handle something');
    // Must render the raw score, not a multiplied percentage.
    expect(text).toContain('score 124.390');
    expect(text).not.toMatch(/12439.*%/);
    expect(text).not.toMatch(/\d+%\s*similar/);
  });

  it('shows multiple results in score-descending order', async () => {
    const text = renderConceptResults([
      { node: fakeNode('alpha'), score: 0.9 },
      { node: fakeNode('beta'), score: 0.5 },
    ]);
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
