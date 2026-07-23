import { describe, expect, it } from 'vitest';
import {
  findAffectedTests,
  type AffectedCoreInput,
  type FileDependentsSource,
} from '../src/features/affected/affected-core.js';

function input(files: string[], testFiles: string[], depth = 5): AffectedCoreInput {
  const allIndexedPaths = new Set([...files, ...testFiles]);
  return {
    files,
    depth,
    customFilter: null,
    allIndexedPaths,
    isTestByIndex: new Set(testFiles),
    filesWithTestCases: new Set(testFiles),
  };
}

function source(entries: ReadonlyArray<readonly [string, readonly string[]]>): FileDependentsSource {
  let calls = 0;
  return {
    getFileDependentIndex() {
      calls++;
      if (calls > 1) throw new Error('dependency index rebuilt more than once');
      return new Map(entries);
    },
  };
}

describe('affected-tests v2 traversal', () => {
  it('builds one dependency index and tiers tests by minimum graph distance', () => {
    const graph = source([
      ['src/a.ts', ['src/a.test.ts', 'src/mid.ts']],
      ['src/mid.ts', ['src/mid.test.ts', 'src/deep.ts']],
      ['src/deep.ts', ['src/deep.test.ts']],
    ]);
    const result = findAffectedTests(
      graph,
      input(['src/a.ts'], ['src/a.test.ts', 'src/mid.test.ts', 'src/deep.test.ts']),
    );

    expect(result.candidates).toEqual([
      { path: 'src/a.test.ts', tier: 'direct', distance: 1, reason: 'direct-dependent' },
      { path: 'src/mid.test.ts', tier: 'likely', distance: 2, reason: 'transitive-dependent' },
      { path: 'src/deep.test.ts', tier: 'broad', distance: 3, reason: 'transitive-dependent' },
    ]);
  });

  it('stops at a public barrel instead of expanding into its entire test fan-out', () => {
    const testFiles = Array.from({ length: 50 }, (_, index) => `src/t${index}.test.ts`);
    const graph = source([
      ['src/leaf.ts', ['src/index.ts']],
      ['src/index.ts', testFiles],
    ]);
    const result = findAffectedTests(graph, input(['src/leaf.ts'], testFiles));

    expect(result.candidates).toEqual([]);
    expect(result.barrelsReached).toEqual(['src/index.ts']);
    expect(result.totalDependents).toBe(1);
  });

  it('keeps the shortest tier when a test is reachable through multiple paths', () => {
    const graph = source([
      ['src/a.ts', ['src/shared.test.ts', 'src/mid.ts']],
      ['src/mid.ts', ['src/shared.test.ts']],
    ]);
    const result = findAffectedTests(graph, input(['src/a.ts'], ['src/shared.test.ts']));

    expect(result.candidates).toEqual([
      { path: 'src/shared.test.ts', tier: 'direct', distance: 1, reason: 'direct-dependent' },
    ]);
  });
});
