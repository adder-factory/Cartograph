import { describe, expect, it } from 'vitest';
import {
  buildConceptHintIfNeeded,
  describeRemainingFilters,
  detectMultiNameQuery,
  detectMultiNameQueryWithOperatorStrip,
  runCentralityOnlySearch,
} from '../src/mcp/tools/_search.js';
import type { NodeRow } from '../src/db/queries.js';
import type { SearchResult } from '../src/types.js';

function nodeRow(overrides: Partial<NodeRow>): NodeRow {
  return {
    id: 'n1',
    kind: 'function',
    name: 'alpha',
    qualified_name: 'alpha',
    file_path: 'src/a.ts',
    language: 'typescript',
    start_line: 1,
    end_line: 2,
    start_column: 0,
    end_column: 0,
    docstring: null,
    signature: 'function alpha(): void',
    visibility: null,
    is_exported: 1,
    is_async: 0,
    is_static: 0,
    decorators: null,
    decorator_args: null,
    updated_at: 0,
    centrality: 0.5,
    betweenness: null,
    body_hash: 'h',
    ...overrides,
  };
}

function searchResult(name: string, text: string): SearchResult {
  return {
    node: {
      id: name,
      kind: 'function',
      name,
      qualifiedName: name,
      filePath: `src/${text}.ts`,
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 0,
      signature: `function ${text}(): void`,
      docstring: '',
      visibility: undefined,
      isExported: true,
      isAsync: false,
      isStatic: false,
      decorators: [],
      decoratorArgs: undefined,
      updatedAt: 0,
      centrality: 0.1,
      betweenness: null,
      bodyHash: 'h',
    },
    score: 1,
  };
}

describe('_search query helper units', () => {
  it('describes remaining non-kind filters in query order', () => {
    expect(describeRemainingFilters('getNode kind:function lang:go path:src/ name:get sig:Node')).toBe(
      'lang:go, path:src/, name:get, sig:Node',
    );
    expect(describeRemainingFilters('getNode kind:function')).toBeNull();
  });

  it('builds concept hints only from non-qualified multi-token query words', () => {
    const noConcept = buildConceptHintIfNeeded('getAllImports kind:function', [searchResult('getAllImports', 'imports')]);
    expect(noConcept.preResult).toBe('');
    expect(noConcept.postResult).toBe('');

    const multi = buildConceptHintIfNeeded('edges kind constraint', [searchResult('edgesOnly', 'edges')]);
    expect(multi.preResult).toContain('Multi-token query detected');
    expect(multi.postResult).toBe('');
  });

  it('detects bare multi-name queries and rejects richer FTS syntax', () => {
    expect(detectMultiNameQuery('handleRole handleGraph handleRole')).toEqual(['handleRole', 'handleGraph']);
    expect(detectMultiNameQuery('singleName')).toBeNull();
    expect(detectMultiNameQuery('name:handleRole handleGraph')).toBeNull();
    expect(detectMultiNameQuery('handle-role handleGraph')).toBeNull();
  });

  it('recovers uppercase boolean disjunctions into a multi-name union', () => {
    expect(detectMultiNameQueryWithOperatorStrip('Alpha OR Beta AND Gamma')).toEqual({
      tokens: ['Alpha', 'Beta', 'Gamma'],
      strippedOperators: ['AND', 'OR'],
    });
    expect(detectMultiNameQueryWithOperatorStrip('Alpha or Beta')).toEqual({
      tokens: ['Alpha', 'or', 'Beta'],
      strippedOperators: [],
    });
    expect(detectMultiNameQueryWithOperatorStrip('Alpha OR name:Beta')).toBeNull();
  });

  it('pushes centrality-only searches into SQL with kind and language filters', () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const cg = {
      queries: {
        db: {
          prepare(sql: string) {
            return {
              all(...params: unknown[]) {
                calls.push({ sql, params });
                return [
                  nodeRow({ id: 'n-high', name: 'high', qualified_name: 'high', centrality: 0.9 }),
                  nodeRow({ id: 'n-mid', name: 'mid', qualified_name: 'mid', centrality: 0.4 }),
                ];
              },
            };
          },
        },
      },
    };

    const results = runCentralityOnlySearch({
      cg: cg as never,
      cf: { op: '>=', value: 0.25 },
      kinds: ['function', 'method'],
      languages: ['typescript'],
      limit: 2,
      sortByCentrality: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('centrality >= ?');
    expect(calls[0]!.sql).toContain('kind IN (?,?)');
    expect(calls[0]!.sql).toContain('language IN (?)');
    expect(calls[0]!.sql).toContain('ORDER BY centrality DESC LIMIT ?');
    expect(calls[0]!.params).toEqual([0.25, 'function', 'method', 'typescript', 2]);
    expect(results.map((r) => [r.node.name, r.score])).toEqual([
      ['high', 0.9],
      ['mid', 0.4],
    ]);
  });

  it('uses every supported centrality comparison operator', () => {
    const seenSql: string[] = [];
    const cg = {
      queries: {
        db: {
          prepare(sql: string) {
            seenSql.push(sql);
            return { all: () => [] };
          },
        },
      },
    };

    for (const op of ['>', '>=', '<', '<='] as const) {
      runCentralityOnlySearch({
        cg: cg as never,
        cf: { op, value: 0.1 },
        kinds: undefined,
        languages: undefined,
        limit: 1,
        sortByCentrality: false,
      });
    }

    expect(seenSql).toEqual([
      expect.stringContaining('centrality > ?'),
      expect.stringContaining('centrality >= ?'),
      expect.stringContaining('centrality < ?'),
      expect.stringContaining('centrality <= ?'),
    ]);
  });
});
