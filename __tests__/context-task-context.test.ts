import { describe, expect, it } from 'vitest';
import type { Node, Subgraph } from '../src/types.js';
import { buildTaskContext, extractCodeBlocks } from '../src/context/task-context.js';

interface TestNodeArgs {
  id: string;
  name: string;
  kind: Node['kind'];
  filePath?: string;
}

function node(args: TestNodeArgs): Node {
  const { id, name, kind, filePath = `src/${id}.ts` } = args;
  return {
    id,
    name,
    kind,
    filePath,
    startLine: 1,
    endLine: 3,
    language: 'typescript',
  };
}

function subgraph(nodes: Node[], roots: string[]): Subgraph {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [{ source: roots[0]!, target: nodes.at(-1)!.id, kind: 'calls' }],
    roots,
  };
}

describe('buildTaskContext', () => {
  it('assembles entry points, related files, summary, and stats from a subgraph', () => {
    const root = node({ id: 'root', name: 'RootService', kind: 'class', filePath: 'src/root.ts' });
    const helper = node({ id: 'helper', name: 'helperFn', kind: 'function', filePath: 'src/lib/helper.ts' });
    const ctx = buildTaskContext({
      query: 'RootService helper',
      subgraph: subgraph([root, helper], ['root']),
      codeBlocks: [
        {
          content: 'export class RootService {}',
          filePath: root.filePath,
          startLine: root.startLine,
          endLine: root.endLine,
          language: root.language,
          node: root,
        },
      ],
    });

    expect(ctx.entryPoints.map((entry) => entry.name)).toEqual(['RootService']);
    expect(ctx.relatedFiles).toEqual(['src/lib/helper.ts', 'src/root.ts']);
    expect(ctx.summary).toBe(
      'Found 2 relevant code symbols across 2 files. Key entry points: RootService. 1 relationships identified.',
    );
    expect(ctx.stats).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      fileCount: 2,
      codeBlockCount: 1,
      totalCodeSize: 'export class RootService {}'.length,
    });
  });
});

describe('extractCodeBlocks', () => {
  it('prioritizes roots, then functions, then classes, and truncates oversized blocks', async () => {
    const root = node({ id: 'root', name: 'RootService', kind: 'class', filePath: 'src/root.ts' });
    const helper = node({ id: 'helper', name: 'helperFn', kind: 'function', filePath: 'src/helper.ts' });
    const model = node({ id: 'model', name: 'Model', kind: 'class', filePath: 'src/model.ts' });
    const field = node({ id: 'field', name: 'fieldValue', kind: 'field', filePath: 'src/model.ts' });
    const blocks = await extractCodeBlocks(
      subgraph([field, model, helper, root], ['root']),
      {
        maxBlocks: 3,
        maxBlockSize: 8,
      },
      async (candidate) => `${candidate.name}-implementation`,
    );

    expect(blocks.map((block) => block.node?.name)).toEqual(['RootService', 'helperFn', 'Model']);
    expect(blocks[0]?.content).toBe('RootServ\n// ... truncated ...');
  });

  it('skips nodes when the loader cannot provide source', async () => {
    const root = node({ id: 'root', name: 'RootService', kind: 'class' });
    const helper = node({ id: 'helper', name: 'helperFn', kind: 'function' });
    const blocks = await extractCodeBlocks(
      subgraph([root, helper], ['root']),
      {
        maxBlocks: 2,
        maxBlockSize: 100,
      },
      async (candidate) => (candidate.id === 'root' ? null : 'export function helperFn() {}'),
    );

    expect(blocks.map((block) => block.node?.id)).toEqual(['helper']);
  });
});
