import { describe, expect, it } from 'vitest';
import type { Node, SearchResult } from '../src/types.js';
import {
  accumulateTermResults,
  applyBehaviorBias,
  applyCentralityBoost,
  applyMultiTermBoost,
  colocationScore,
  countTermGroupMatches,
  groupSubstringStemVariants,
  mergeSearchChannels,
} from '../src/context/scoring.js';

interface TestNodeArgs {
  id: string;
  name: string;
  kind?: Node['kind'];
  filePath?: string;
  centrality?: number;
}

function node(args: TestNodeArgs): Node {
  const { id, name, kind = 'function', filePath = `src/${id}.ts`, centrality } = args;
  return {
    id,
    name,
    kind,
    filePath,
    startLine: 1,
    endLine: 1,
    language: 'typescript',
    centrality,
  };
}

function result(args: TestNodeArgs & { score: number }): SearchResult {
  return { node: node(args), score: args.score };
}

describe('context scoring helpers', () => {
  it('accumulates weighted term results and preserves the max score per node', () => {
    const acc = new Map<string, { result: SearchResult; termHits: number }>();
    accumulateTermResults(acc, [result({ id: 'a', name: 'Alpha', score: 10 })], 0.5);
    accumulateTermResults(acc, [result({ id: 'a', name: 'Alpha', score: 3 })], 1);

    expect(acc.get('a')?.termHits).toBe(2);
    expect(acc.get('a')?.result.score).toBe(5);
  });

  it('merges search channels by id using the strongest score', () => {
    const merged = mergeSearchChannels(
      [result({ id: 'a', name: 'Alpha', score: 4 })],
      [result({ id: 'a', name: 'Alpha', score: 9 }), result({ id: 'b', name: 'Beta', score: 3 })],
    );

    expect(merged.map((r) => [r.node.id, r.score])).toEqual([
      ['a', 9],
      ['b', 3],
    ]);
  });

  it('applies centrality and behavior bias score adjustments', () => {
    const entries = [
      result({ id: 'fn', name: 'runTask', kind: 'function', centrality: 0.25, score: 10 }),
      result({ id: 'shape', name: 'TaskShape', kind: 'interface', score: 10 }),
    ];

    applyCentralityBoost(entries, 2);
    applyBehaviorBias(entries);

    expect(entries[0]?.score).toBeCloseTo(28);
    expect(entries[1]?.score).toBeCloseTo(7);
  });

  it('groups stem variants and counts name or directory matches', () => {
    const groups = groupSubstringStemVariants(['search', 'searching', 'index']);
    const matchCount = countTermGroupMatches(
      node({ id: 'searcher', name: 'SearchIndexer', filePath: 'src/search/indexer.ts' }),
      groups,
    );

    expect(groups).toEqual([['searching', 'search'], ['index']]);
    expect(matchCount).toBe(2);
  });

  it('boosts multi-term matches and damps incidental non-exact matches', () => {
    const multi = result({ id: 'multi', name: 'SearchIndexer', score: 10 });
    applyMultiTermBoost({ result: multi, matchCount: 2, exactMatchIds: new Set(), extraIds: new Set() });

    const incidental = result({ id: 'one', name: 'SearchOnly', score: 10 });
    applyMultiTermBoost({ result: incidental, matchCount: 1, exactMatchIds: new Set(), extraIds: new Set() });

    const exact = result({ id: 'exact', name: 'SearchOnly', score: 10 });
    applyMultiTermBoost({ result: exact, matchCount: 1, exactMatchIds: new Set(['exact']), extraIds: new Set() });

    expect(multi.score).toBe(20);
    expect(incidental.score).toBe(6);
    expect(exact.score).toBe(10);
  });

  it('adds co-location score only when multiple symbols share a file', () => {
    expect(colocationScore(7, 1)).toBe(7);
    expect(colocationScore(7, 3)).toBe(47);
  });
});
