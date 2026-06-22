/**
 * Tests for cartograph_dead_code excludeFixtures parameter.
 *
 * Covers:
 *   - excludeFixtures: true (default) — fixture-path candidates removed
 *   - excludeFixtures: false — fixture-path candidates included
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NodeRow } from '../src/db/queries.js';
import type { TypedQuery } from '../src/db/typed-query.js';
import Cartograph from '../src/index.js';
import { DEAD_CODE_TOOL } from '../src/mcp/tools/dead-code.js';
import { CallIdCache } from '../src/mcp/tools/_call-id-cache.js';
import { RefIdCache } from '../src/mcp/tools/_id-cache.js';
import type { ToolCtx } from '../src/mcp/tools/types.js';

const candidateStream: { candidates: NodeRow[] } = { candidates: [] };

interface FindOrphanedSymbolsParams {
  livenessKinds: string;
  pathLike: string;
  limit: number;
  offset: number;
}

interface DeadCodeHarness {
  ctx: ToolCtx;
  close: () => void;
}

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

function fakeOrphanedSymbolsQuery(cg: Cartograph): TypedQuery<FindOrphanedSymbolsParams, NodeRow> {
  const stmt = cg.queries.db.prepare('SELECT 1');
  return {
    stmt,
    sql: 'test fake findOrphanedSymbols',
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    runBatch: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: ({ limit, offset }) => candidateStream.candidates.slice(offset, offset + limit).at(0),
    all: ({ limit, offset }) => candidateStream.candidates.slice(offset, offset + limit),
    *iterate({ limit, offset }) {
      yield* candidateStream.candidates.slice(offset, offset + limit);
    },
  };
}

function makeToolCtx(cg: Cartograph): ToolCtx {
  return {
    getCartograph: () => cg,
    options: {},
    defaultCg: cg,
    projectCache: new Map<string, Cartograph>(),
    closeProjectsMatching: () => {},
    refIds: new RefIdCache(),
    callIds: new CallIdCache(),
    evictCachedProject: () => {},
  };
}

function createDeadCodeHarness(): DeadCodeHarness {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dead-code-fixtures-'));
  const cg = Cartograph.initSync(testDir);
  cg.queries.queries.findOrphanedSymbols = fakeOrphanedSymbolsQuery(cg);
  return {
    ctx: makeToolCtx(cg),
    close: () => {
      cg.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    },
  };
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

    const harness = createDeadCodeHarness();

    try {
      const handler = DEAD_CODE_TOOL.handle;
      const result = await handler(harness.ctx, {
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
    } finally {
      harness.close();
    }
  });

  it('excludeFixtures: false — includes fixture-path candidates', async () => {
    // Mix of fixture and non-fixture candidates
    candidateStream.candidates = [
      fakeNode('helperA', 'docs/test-beds/box.ts'),
      fakeNode('realFunc', 'src/feature.ts'),
      fakeNode('helperB', '__tests__/fixtures/mock.ts'),
    ];

    const harness = createDeadCodeHarness();

    try {
      const handler = DEAD_CODE_TOOL.handle;
      const result = await handler(harness.ctx, {
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
    } finally {
      harness.close();
    }
  });

  it('spec/fixtures/ pattern is also filtered', async () => {
    candidateStream.candidates = [
      fakeNode('specHelper', 'spec/fixtures/test-helper.ts'),
      fakeNode('realFunc', 'src/main.ts'),
    ];

    const harness = createDeadCodeHarness();

    try {
      const handler = DEAD_CODE_TOOL.handle;
      const result = await handler(harness.ctx, {
        mode: 'static',
        maxCandidates: 50,
        excludeFixtures: true,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('realFunc');
      expect(text).not.toContain('specHelper');
    } finally {
      harness.close();
    }
  });
});

describe('cartograph_dead_code — via:rule footer wording', () => {
  it("recommends the non-deprecated `via: 'llm'`, not the deprecated `mode=judge`", async () => {
    candidateStream.candidates = [fakeNode('orphanFunc', 'src/main.ts')];

    const harness = createDeadCodeHarness();

    try {
      const result = await DEAD_CODE_TOOL.handle(harness.ctx, { via: 'rule', maxCandidates: 50 });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';

      // The footer must steer the agent at the canonical `via` param.
      expect(text).toContain("via: 'llm'");
      // It must NOT recommend the deprecated `mode=judge` alias.
      expect(text).not.toMatch(/mode\s*=\s*judge/);
    } finally {
      harness.close();
    }
  });
});
