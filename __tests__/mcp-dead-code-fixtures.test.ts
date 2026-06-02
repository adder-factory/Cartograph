/**
 * Tests for cartograph_dead_code excludeFixtures parameter.
 *
 * Covers:
 *   - excludeFixtures: true (default) — fixture-path candidates removed
 *   - excludeFixtures: false — fixture-path candidates included
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { QueryBuilder } from '../src/db/queries.js';
import type { NodeRow } from '../src/db/queries.js';
import { DEAD_CODE_TOOL } from '../src/mcp/tools/dead-code.js';

const candidateStream: { candidates: NodeRow[] } = { candidates: [] };

function fakeNode(name: string, filePath: string): NodeRow {
  return {
    id: `function:${filePath}:${name}`,
    name,
    kind: 'function',
    qualified_name: name,
    file_path: filePath,
    language: filePath.endsWith('.rb') ? 'ruby' : 'typescript',
    start_line: 1,
    end_line: 5,
    start_column: 0,
    end_column: 0,
    docstring: null,
    signature: null,
    visibility: null,
    is_exported: 0,
    is_async: 0,
    is_static: 0,
    decorators: null,
    decorator_args: null,
    updated_at: 0,
    centrality: null,
    betweenness: null,
    body_hash: '',
  };
}

function fakeQueries(): QueryBuilder {
  return {
    queries: {
      findOrphanedSymbols: {
        all: ({ limit, offset }: { limit: number; offset: number }) => candidateStream.candidates.slice(offset, offset + limit),
      },
    },
  } as unknown as QueryBuilder;
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
      queries: fakeQueries(),
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
      queries: fakeQueries(),
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
      queries: fakeQueries(),
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
      queries: fakeQueries(),
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
