/**
 * Tests for cartograph_dead_code excludeFixtures parameter.
 *
 * Covers:
 *   - excludeFixtures: true (default) — fixture-path candidates removed
 *   - excludeFixtures: false — fixture-path candidates included
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'bun:test';
import type { Node } from '../src/types.js';
import type { QueryBuilder } from '../src/db/queries.js';

// Mock the dead-code helper so we can control the candidate stream
// without needing a real SQLite instance. bun:test's `mock.module`
// is NOT hoisted (unlike vitest's `vi.mock`), so register the mock
// FIRST and import the importer via dynamic `await import(...)`.
const candidateStream: { candidates: Node[] } = { candidates: [] };
mock.module('../src/llm/dead-code.js', () => ({
  // Faithfully model the real `findGraphCandidates` contract: the
  // optional `isExempt` callback drops paths INLINE before the `max`
  // cap, so callers no longer post-filter fixture nodes themselves.
  findGraphCandidates: (args: {
    queries: QueryBuilder;
    max: number;
    isExempt?: (filePath: string) => boolean;
    includeTests?: boolean;
  }): Node[] => {
    return candidateStream.candidates.filter((n) => !args.isExempt?.(n.filePath)).slice(0, args.max);
  },
  // Stub the rest of the public surface so transitive importers
  // (cartograph-llm-service.ts imports `judgeDeadCode`) don't trip a
  // missing-export error at module-load. None of these get called in
  // these tests.
  judgeDeadCode: async () => ({ judged: [], unjudged: [] }),
  parseBatchJudges: () => new Map(),
  truncateReason: (s: string) => s,
}));

const { DEAD_CODE_TOOL } = await import('../src/mcp/tools/dead-code.js');

function fakeNode(name: string, filePath: string): Node {
  return {
    id: `function:${filePath}:${name}`,
    name,
    kind: 'function',
    filePath,
    startLine: 1,
    endLine: 5,
    isExported: false,
  } as Node;
}

beforeEach(() => {
  candidateStream.candidates = [];
});

describe('cartograph_dead_code — excludeFixtures parameter', () => {
  it('excludeFixtures: true (default) — filters out fixture-path candidates', async () => {
    // Mix of fixture and non-fixture candidates
    candidateStream.candidates = [
      fakeNode('helperA', 'docs/test-beds/box.ts'),
      fakeNode('realFunc', 'src/feature.ts'),
      fakeNode('helperB', '__tests__/fixtures/mock.ts'),
      fakeNode('helperC', 'test/fixtures/stub.ts'),
    ];

    // Create a minimal ToolCtx
    const mockCg = {
      projectRoot: '/project',
      queries: {} as QueryBuilder,
      llm: {
        getEffectiveLlmConfig: async () => ({}),
      },
    };

    const ctx = {
      getCartograph: () => mockCg,
      options: {},
      defaultCg: mockCg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const handler = DEAD_CODE_TOOL.handle;
    const result = await handler(ctx, {
      mode: 'static',
      maxCandidates: 50,
      excludeFixtures: true,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    // Should include only the non-fixture candidate
    expect(text).toContain('realFunc');
    // Fixture candidates should be filtered out
    expect(text).not.toContain('helperA');
    expect(text).not.toContain('helperB');
    expect(text).not.toContain('helperC');
  });

  it('excludeFixtures: false — includes fixture-path candidates', async () => {
    // Mix of fixture and non-fixture candidates
    candidateStream.candidates = [
      fakeNode('helperA', 'docs/test-beds/box.ts'),
      fakeNode('realFunc', 'src/feature.ts'),
      fakeNode('helperB', '__tests__/fixtures/mock.ts'),
    ];

    const mockCg = {
      projectRoot: '/project',
      queries: {} as QueryBuilder,
      llm: {
        getEffectiveLlmConfig: async () => ({}),
      },
    };

    const ctx = {
      getCartograph: () => mockCg,
      options: {},
      defaultCg: mockCg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const handler = DEAD_CODE_TOOL.handle;
    const result = await handler(ctx, {
      mode: 'static',
      maxCandidates: 50,
      excludeFixtures: false,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    // All candidates should be included when excludeFixtures is false
    expect(text).toContain('helperA');
    expect(text).toContain('realFunc');
    expect(text).toContain('helperB');
  });

  it('spec/fixtures/ pattern is also filtered', async () => {
    candidateStream.candidates = [
      fakeNode('specHelper', 'spec/fixtures/test-helper.ts'),
      fakeNode('realFunc', 'src/main.ts'),
    ];

    const mockCg = {
      projectRoot: '/project',
      queries: {} as QueryBuilder,
      llm: {
        getEffectiveLlmConfig: async () => ({}),
      },
    };

    const ctx = {
      getCartograph: () => mockCg,
      options: {},
      defaultCg: mockCg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const handler = DEAD_CODE_TOOL.handle;
    const result = await handler(ctx, {
      mode: 'static',
      maxCandidates: 50,
      excludeFixtures: true,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('realFunc');
    expect(text).not.toContain('specHelper');
  });
});

describe('cartograph_dead_code — via:rule footer wording', () => {
  it("recommends the non-deprecated `via: 'llm'`, not the deprecated `mode=judge`", async () => {
    candidateStream.candidates = [fakeNode('orphanFunc', 'src/main.ts')];

    const mockCg = {
      projectRoot: '/project',
      queries: {} as QueryBuilder,
      llm: { getEffectiveLlmConfig: async () => ({}) },
    };
    const ctx = {
      getCartograph: () => mockCg,
      options: {},
      defaultCg: mockCg,
      projectCache: new Map(),
      closeProjectsMatching: () => {},
      refIds: { mint: () => 'n_0', resolve: () => null },
      callIds: { mint: () => 'c_0', resolve: () => null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await DEAD_CODE_TOOL.handle(ctx, { via: 'rule', maxCandidates: 50 });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';

    // The footer must steer the agent at the canonical `via` param.
    expect(text).toContain("via: 'llm'");
    // It must NOT recommend the deprecated `mode=judge` alias.
    expect(text).not.toMatch(/mode\s*=\s*judge/);
  });
});
