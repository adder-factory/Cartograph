/**
 * cartograph_graph(direction: 'path') — shortest X→Y dependency path.
 *
 * Exposes the previously-unwired GraphTraverser.findPath BFS. The fixture is a
 * deterministic call chain alpha→beta→gamma plus a disconnected `lonely`, so
 * each test pins a distinct behaviour:
 *  - a real multi-hop path is found and rendered as an ordered hop chain;
 *  - two real-but-unconnected symbols report "no path" (a true negative, not
 *    an error envelope);
 *  - `edgeKind` filtering can turn a found path into no-path (only `calls`
 *    edges connect them, so `imports` yields nothing);
 *  - a missing / same-symbol target is handled explicitly;
 *  - an unresolvable endpoint is a typed error (CLI exit 1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_graph direction:path', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-graph-path-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // alpha -> beta -> gamma is a 2-hop calls chain; lonely is reachable from
    // nothing in alpha's outgoing closure.
    fs.writeFileSync(
      path.join(tempDir, 'src/chain.ts'),
      [
        'export function alpha(): number { return beta(); }',
        'export function beta(): number { return gamma(); }',
        'export function gamma(): number { return 1; }',
        'export function lonely(): number { return 42; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  it('finds and renders the shortest path across a multi-hop call chain', async () => {
    const r = await handler.runHandler('cartograph_graph', { direction: 'path', start: 'alpha', to: 'gamma' });
    const text = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(text).toContain('## Path: `alpha` → `gamma`');
    expect(text).toContain('2 hops');
    // ordered chain with all three nodes and the calls connectors
    expect(text).toContain('1. `alpha`');
    expect(text).toContain('`beta`');
    expect(text).toContain('3. `gamma`');
    expect(text).toContain('↓ calls');
    expect(text).toContain('chain.ts:'); // node locations rendered
  });

  it('reports a true negative (not an error) when two real symbols are unconnected', async () => {
    const r = await handler.runHandler('cartograph_graph', { direction: 'path', start: 'alpha', to: 'lonely' });
    expect(r.isError).toBeFalsy(); // no-path is a real answer, not a failure
    expect(textOf(r)).toContain('No path found');
  });

  it('edgeKind filter can turn a found path into no-path', async () => {
    // alpha→gamma exists over `calls`, but there are no `imports` edges, so
    // restricting to imports must yield no path.
    const r = await handler.runHandler('cartograph_graph', {
      direction: 'path',
      start: 'alpha',
      to: 'gamma',
      edgeKind: 'imports',
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('No path found');
    expect(textOf(r)).toContain('imports');
  });

  it('treats start === to as a no-op (same symbol)', async () => {
    const r = await handler.runHandler('cartograph_graph', { direction: 'path', start: 'alpha', to: 'alpha' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('same symbol');
  });

  it('errors when the target is missing or unresolvable', async () => {
    const missing = await handler.runHandler('cartograph_graph', { direction: 'path', start: 'alpha' });
    expect(missing.isError).toBeTruthy();
    expect(textOf(missing)).toMatch(/to must be a non-empty string/i);

    const unresolvable = await handler.runHandler('cartograph_graph', {
      direction: 'path',
      start: 'alpha',
      to: 'no_such_symbol_xyz',
    });
    expect(unresolvable.isError).toBeTruthy();
    expect(textOf(unresolvable)).toMatch(/not found/i);
  });
});
