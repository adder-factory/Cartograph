import { describe, expect, it, vi } from 'vitest';
import {
  buildGraphExportSnapshot,
  formatGraphExportSnapshot,
  parseGraphExportOptions,
  runGraphExport,
} from '../src/features/graph-export/index.js';
import type { Edge, FileRecord, Node } from '../src/types.js';

const baseNode = (overrides: Partial<Node>): Node => ({
  id: 'node:base',
  kind: 'function',
  name: 'base',
  qualifiedName: 'base',
  filePath: 'src/base.ts',
  language: 'typescript',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 4,
  updatedAt: 1,
  ...overrides,
});

const baseFile = (overrides: Partial<FileRecord>): FileRecord => ({
  path: 'src/base.ts',
  contentHash: 'hash',
  language: 'typescript',
  size: 10,
  modifiedAt: 1,
  indexedAt: 1,
  nodeCount: 1,
  ...overrides,
});

const nodes: Node[] = [
  baseNode({
    id: 'class:app',
    kind: 'class',
    name: 'App',
    qualifiedName: 'App',
    filePath: 'src/app.ts',
    startLine: 1,
    endLine: 8,
  }),
  baseNode({
    id: 'method:run',
    kind: 'method',
    name: 'run',
    qualifiedName: 'App::run',
    filePath: 'src/app.ts',
    startLine: 3,
    endLine: 5,
  }),
  baseNode({
    id: 'function:helper',
    kind: 'function',
    name: 'helper',
    qualifiedName: 'helper',
    filePath: 'src/helper.ts',
    startLine: 2,
    endLine: 4,
  }),
];

const edges: Edge[] = [
  { source: 'class:app', target: 'method:run', kind: 'contains', confidence: 'EXTRACTED' },
  { source: 'method:run', target: 'function:helper', kind: 'calls', line: 4, column: 10, confidence: 'INFERRED' },
];

const files: FileRecord[] = [
  baseFile({ path: 'src/app.ts', nodeCount: 2 }),
  baseFile({ path: 'src/helper.ts', nodeCount: 1 }),
];

describe('graph export feature', () => {
  it('validates formats, limits, and kind filters', () => {
    expect(parseGraphExportOptions({ projectPath: '/repo', format: 'dot', limit: '25', kind: 'class,method' })).toEqual(
      expect.objectContaining({
        ok: true,
        options: expect.objectContaining({ format: 'dot', limit: 25, kinds: ['class', 'method'] }),
      }),
    );

    expect(parseGraphExportOptions({ projectPath: '/repo', format: 'xml' })).toEqual({
      ok: false,
      error: '--format must be one of: json, dot, mermaid, cytoscape; got "xml"',
    });
    expect(parseGraphExportOptions({ projectPath: '/repo', limit: '0' })).toEqual({
      ok: false,
      error: '--limit must be an integer between 1 and 50000 (got "0")',
    });
    expect(parseGraphExportOptions({ projectPath: '/repo', edgeKind: 'calls,nope' })).toEqual({
      ok: false,
      error:
        '--edge-kind must contain only: contains, calls, imports, exports, extends, implements, references, type_of, returns, instantiates, overrides, decorates, tests, field_access, similar_to, def_use; got "nope"',
    });
  });

  it('builds a deterministic capped snapshot and keeps only in-scope edges', () => {
    const snapshot = buildGraphExportSnapshot(
      { nodes, edges, files },
      {
        projectPath: '/repo',
        format: 'json',
        limit: 2,
        kinds: [],
        edgeKinds: [],
        languages: [],
        filePrefix: 'src/',
      },
    );

    expect(snapshot.stats).toEqual({
      totalNodes: 3,
      totalEdges: 2,
      exportedNodes: 2,
      exportedEdges: 1,
      exportedFiles: 1,
      truncatedNodes: 1,
    });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['class:app', 'method:run']);
    expect(snapshot.edges).toEqual([
      { source: 'class:app', target: 'method:run', kind: 'contains', confidence: 'EXTRACTED' },
    ]);
    expect(snapshot.files.map((file) => file.path)).toEqual(['src/app.ts']);
  });

  it('formats JSON, DOT, Mermaid, and Cytoscape artifacts', () => {
    const snapshot = buildGraphExportSnapshot(
      { nodes, edges, files },
      { projectPath: '/repo', format: 'json', limit: 10, kinds: [], edgeKinds: [], languages: [] },
    );

    expect(JSON.parse(formatGraphExportSnapshot(snapshot, 'json')).nodes).toHaveLength(3);
    expect(formatGraphExportSnapshot(snapshot, 'dot')).toContain('"method:run" -> "function:helper" [label="calls"]');
    expect(formatGraphExportSnapshot(snapshot, 'mermaid')).toContain('flowchart LR');
    const cytoscape = JSON.parse(formatGraphExportSnapshot(snapshot, 'cytoscape'));
    expect(cytoscape.elements.nodes).toHaveLength(3);
    expect(cytoscape.elements.edges[1].data).toEqual(
      expect.objectContaining({ source: 'method:run', target: 'function:helper', kind: 'calls' }),
    );
  });

  it('opens and closes the graph through the runtime boundary', async () => {
    const close = vi.fn();
    const result = await runGraphExport(
      { projectPath: '/repo', format: 'json', limit: '10' },
      {
        isInitialized: () => true,
        openCartograph: async () => ({ queries: {} as never, close }),
        getAllNodes: () => nodes,
        getAllEdges: () => edges,
        getAllFiles: () => files,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.stats.exportedNodes).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
