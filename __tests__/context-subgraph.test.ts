import { describe, expect, it } from 'vitest';
import { QueryBuilder } from '../src/db/queries.js';
import type { SqliteDatabase, SqliteStatement } from '../src/db/sqlite-adapter.js';
import { GraphTraverser } from '../src/graph/index.js';
import { finaliseSubgraph } from '../src/context/subgraph.js';
import type { Edge, Node } from '../src/types.js';

function makeQueryBuilder(): QueryBuilder {
  const db: SqliteDatabase = {
    dialect: 'sqlite',
    open: true,
    prepare: (_sql: string): SqliteStatement => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
      iterate: function* () {},
    }),
    exec: () => undefined,
    pragma: () => [],
    transaction: (fn) => fn,
    close: () => undefined,
  };
  return new QueryBuilder(db);
}

function node(id: string, overrides: Partial<Pick<Node, 'kind' | 'filePath'>> = {}): Node {
  return {
    id,
    kind: overrides.kind ?? 'function',
    name: id,
    qualifiedName: id,
    filePath: overrides.filePath ?? `src/${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 0,
  };
}

function finalNodeIds(nodes: Node[], edges: Edge[], maxNodes: number): string[] {
  const queries = makeQueryBuilder();
  const result = finaliseSubgraph(
    { projectRoot: '/project', queries, traverser: new GraphTraverser(queries) },
    {
      nodes: new Map(nodes.map((entry) => [entry.id, entry])),
      edges,
      roots: ['root'],
      maxNodes,
      isTestQuery: false,
    },
  );
  return [...result.nodes.keys()];
}

describe('context subgraph trimming', () => {
  it('keeps every possible direct root neighbor before transitive nodes', () => {
    const nodes = ['root', 'first', 'transitiveA', 'transitiveB', 'second'].map(node);
    const edges: Edge[] = [
      { source: 'root', target: 'first', kind: 'calls', confidence: 'EXTRACTED' },
      { source: 'first', target: 'transitiveA', kind: 'calls', confidence: 'EXTRACTED' },
      { source: 'transitiveA', target: 'transitiveB', kind: 'calls', confidence: 'EXTRACTED' },
      { source: 'root', target: 'second', kind: 'calls', confidence: 'EXTRACTED' },
    ];

    expect(finalNodeIds(nodes, edges, 3)).toEqual(['root', 'first', 'second']);
  });

  it('prefers a concrete call over a containment-only direct neighbor', () => {
    const nodes = ['root', 'container', 'callee'].map(node);
    const edges: Edge[] = [
      { source: 'root', target: 'container', kind: 'contains', confidence: 'EXTRACTED' },
      { source: 'root', target: 'callee', kind: 'calls', confidence: 'EXTRACTED' },
    ];

    expect(finalNodeIds(nodes, edges, 2)).toEqual(['root', 'callee']);
  });

  it('preserves direct-call rank when the per-file diversity cap evicts same-file containers', () => {
    const sharedFile = 'src/large-module.ts';
    const nodes = [
      node('root', { filePath: sharedFile }),
      ...Array.from({ length: 9 }, (_, index) => node(`container-${index}`, { kind: 'class', filePath: sharedFile })),
      node('callee', { filePath: sharedFile }),
    ];
    const edges: Edge[] = [
      ...Array.from({ length: 9 }, (_, index) => ({
        source: 'root',
        target: `container-${index}`,
        kind: 'contains' as const,
        confidence: 'EXTRACTED' as const,
      })),
      { source: 'root', target: 'callee', kind: 'calls', confidence: 'EXTRACTED' },
    ];

    // The global budget deliberately fits every node. The per-file cap must
    // still use graph rank instead of the original insertion order.
    expect(finalNodeIds(nodes, edges, 25)).toContain('callee');
  });
});
