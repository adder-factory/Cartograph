/**
 * insertEdges drops self-loops on edge kinds where source === target
 * is semantically null (type_of, returns). `calls` self-loops stay —
 * they encode legitimate recursion.
 *
 * Surfaced by the ollama bug-hunt FP3: every Go constructor-style
 * function `func NewClient() *Client` produced a `Client → type_of →
 * Client` edge via the return-type extraction. The self-edge
 * polluted callees / impact queries with semantically null self-
 * references.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { insertEdges } from '../src/db/queries-edges.js';
import type { Edge, Node } from '../src/types.js';

function makeNode(id: string): Node {
  return {
    id,
    kind: 'struct',
    name: id,
    qualifiedName: id,
    filePath: 'fake.go',
    language: 'go',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('insertEdges self-loop filter', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-self-loop-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    // Disable FK so synthetic nodes can be inserted without setting up
    // a `files` row first - this test is about the in-process filter,
    // not the DB schema.
    cg.queries.db.exec('PRAGMA foreign_keys = OFF');
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops a type_of self-loop (constructor return FP)', () => {
    cg.queries.insertNode(makeNode('struct:Client'));
    const edges: Edge[] = [{ source: 'struct:Client', target: 'struct:Client', kind: 'type_of' }];
    const inserted = insertEdges(cg.queries, edges);
    expect(inserted).toHaveLength(0);
  });

  it('drops a returns self-loop', () => {
    cg.queries.insertNode(makeNode('struct:Builder'));
    const edges: Edge[] = [{ source: 'struct:Builder', target: 'struct:Builder', kind: 'returns' }];
    expect(insertEdges(cg.queries, edges)).toHaveLength(0);
  });

  it('KEEPS a calls self-loop (recursion encodes real signal)', () => {
    cg.queries.insertNode({ ...makeNode('fn:recurse'), kind: 'function' });
    const edges: Edge[] = [{ source: 'fn:recurse', target: 'fn:recurse', kind: 'calls' }];
    expect(insertEdges(cg.queries, edges)).toHaveLength(1);
  });

  it('keeps non-self-loop type_of edges', () => {
    cg.queries.insertNode(makeNode('struct:A'));
    cg.queries.insertNode(makeNode('struct:B'));
    const edges: Edge[] = [{ source: 'struct:A', target: 'struct:B', kind: 'type_of' }];
    expect(insertEdges(cg.queries, edges)).toHaveLength(1);
  });
});
