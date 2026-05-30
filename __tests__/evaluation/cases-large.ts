/**
 * Large-fixture eval cases — run against a synthesised 1000-file
 * project so latency regressions on real-scale projects surface in
 * the gate (B7). The generator script
 * `__tests__/evaluation/gen-large-fixture.ts` builds the fixture
 * lazily under `__tests__/evaluation/fixtures/large/`; runner picks
 * it up via `--cases large` (or `EVAL_CASES=large`).
 *
 * Symbol naming is deterministic: file `mod-N.ts` exports a function
 * `funcN`, a class `ClassN`, and an interface `IfaceN`. Cases below
 * pick targets from the high (popular) end of the corpus and the
 * low (sparse) end so the gate catches both the "small symbol set,
 * fast path" and "many symbols, ranking" branches of the search
 * pipeline.
 */
import type { EvalTestCase } from './types.js';

export const largeTestCases: EvalTestCase[] = [
  // === searchNodes — exact name on a 1000-file fixture ===

  {
    id: 'large-search-func0',
    query: 'func0',
    api: 'searchNodes',
    expectedSymbols: ['func0'],
    kinds: ['function'],
  },
  {
    id: 'large-search-func500',
    query: 'func500',
    api: 'searchNodes',
    expectedSymbols: ['func500'],
    kinds: ['function'],
  },
  {
    id: 'large-search-Class999',
    query: 'Class999',
    api: 'searchNodes',
    expectedSymbols: ['Class999'],
    kinds: ['class'],
  },
  {
    id: 'large-search-Iface250',
    query: 'Iface250',
    api: 'searchNodes',
    expectedSymbols: ['Iface250'],
    kinds: ['interface'],
  },

  // === fuzzy fallback on a 1000-file fixture ===

  {
    id: 'large-fuzzy-func750-typo',
    query: 'fnc750', // missing 'u'
    api: 'searchNodes',
    expectedSymbols: ['func750'],
  },

  // === findRelevantContext — exploration cost on a large corpus ===

  {
    id: 'large-explore-mid-cluster',
    // Concept query that hits a generated symbol; tests cascade ranking
    // cost when the corpus has 1000+ functions of similar shape.
    query: 'func500 calls peers',
    api: 'findRelevantContext',
    expectedSymbols: ['func500'],
    options: { searchLimit: 8, traversalDepth: 2, maxNodes: 60, minScore: 0.2 },
  },
];
