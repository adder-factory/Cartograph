import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { insertSimilarToEdges } from '../src/db/queries-similarity.js';
import { ToolHandler } from '../src/mcp/tools.js';
import type { Node } from '../src/types.js';

function makeNode(id: string, name: string, language: string, filePath: string, startLine: number): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language,
    startLine,
    endLine: startLine + 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function textOf(result: Awaited<ReturnType<ToolHandler['execute']>>): string {
  return result.content[0]?.text ?? '';
}

describe('cartograph_graph direction=similar with persisted edges', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-similar-persisted-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    cg.queries.db.exec('PRAGMA foreign_keys = OFF');

    cg.queries.insertNode(makeNode('fn:A', 'A', 'typescript', 'src/a.ts', 1));
    cg.queries.insertNode(makeNode('fn:B', 'B', 'typescript', 'src/b.ts', 10));
    cg.queries.insertNode(makeNode('fn:C', 'C', 'python', 'src/c.py', 20));
    cg.queries.insertNode(makeNode('fn:D', 'D', 'typescript', 'src/d.ts', 30));
    insertSimilarToEdges(cg.queries, [
      { source: 'fn:A', target: 'fn:C', score: 0.9 },
      { source: 'fn:A', target: 'fn:B', score: 0.7 },
      { source: 'fn:A', target: 'fn:D', score: 0.2 },
    ]);

    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses persisted similar_to edges, sorts by score, and applies minScore', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', {
        direction: 'similar',
        start: 'A',
        minScore: 0.5,
      }),
    );

    expect(text).toContain('## Similar to `A`');
    expect(text).toContain('Source: persisted similar_to edges');
    expect(text).toContain('**C**');
    expect(text).toContain('score=0.900');
    expect(text).toContain('**B**');
    expect(text).toContain('score=0.700');
    expect(text).not.toContain('**D**');
    expect(text.indexOf('**C**')).toBeLessThan(text.indexOf('**B**'));
  });

  it('filters persisted peers by source language when sameLanguage is true', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', {
        direction: 'similar',
        start: 'A',
        minScore: 0.5,
        sameLanguage: true,
      }),
    );

    expect(text).toContain('**B**');
    expect(text).not.toContain('**C**');
    expect(text).not.toContain('**D**');
  });

  it('renders not-found sections in batched similar queries without dropping valid sources', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', {
        direction: 'similar',
        symbols: ['A', 'MissingSymbol'],
        minScore: 0.5,
      }),
    );

    expect(text).toContain('## Similar peers (2 sources');
    expect(text).toContain('### A (function)');
    expect(text).toContain('**C**');
    expect(text).toContain('### MissingSymbol');
    expect(text).toContain('Symbol "MissingSymbol" not found in the codebase');
  });
});
