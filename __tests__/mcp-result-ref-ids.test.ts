/**
 * Result-reference IDs (#15): tabular tools mint short `n_xxxxxxxx`
 * UIDs per row; symbol-resolving tools accept the same UID as a
 * shortcut for `symbol=<full name>`. Saves the agent from re-passing
 * 30-character qualified names on chained investigations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('Result-reference IDs (#15)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-refids-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/lib.ts'),
      [
        'export function target(): number { return 42; }',
        'export function callerOne(): number { return target(); }',
        'export function callerTwo(): number { return target() + 1; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  it('callers output stamps each row with `[id: n_xxxxxxxx]`', async () => {
    const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'target' });
    const text = textOf(r);
    expect(text).toContain('callerOne');
    expect(text).toContain('callerTwo');
    expect(text).toMatch(/`\[id: n_[0-9a-f]{8}\]`/);
  });

  it('UID returned by callers resolves on a follow-up node call', async () => {
    const callersText = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'target' }));
    const m = /callerOne[\s\S]*?`\[id: (n_[0-9a-f]{8})\]`/.exec(callersText);
    expect(m).not.toBeNull();
    const uid = m![1]!;

    const nodeText = textOf(await handler.runHandler('cartograph_node', { symbol: uid }));
    expect(nodeText).toContain('callerOne');
    expect(nodeText).toContain('Location:');
  });

  it('UID also resolves on callees (chained-tool roundtrip)', async () => {
    const callersText = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'target' }));
    const m = /callerOne[\s\S]*?`\[id: (n_[0-9a-f]{8})\]`/.exec(callersText);
    const uid = m![1]!;
    const calleesText = textOf(await handler.runHandler('cartograph_graph', { direction: 'callees', start: uid }));
    expect(calleesText).toContain('target');
  });

  it('same node always mints the same UID across calls (deterministic short hash)', async () => {
    const t1 = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'target' }));
    const t2 = textOf(await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'target' }));
    const id1 = /callerOne[\s\S]*?`\[id: (n_[0-9a-f]{8})\]`/.exec(t1)![1];
    const id2 = /callerOne[\s\S]*?`\[id: (n_[0-9a-f]{8})\]`/.exec(t2)![1];
    expect(id1).toBe(id2);
  });
});
