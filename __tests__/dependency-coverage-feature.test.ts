import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { insertUnresolvedRefsBatch } from '../src/db/queries-unresolved-refs.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_dependency_coverage', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dep-coverage-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'dep.ts'), 'export function dep(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src', 'main.ts'),
      [
        "import { dep } from './dep';",
        'export function run(): number {',
        '  dep();',
        '  missingCall();',
        '  return 1;',
        '}',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    const runNode = getNodesByKind(cg.queries, 'function').find((node) => node.name === 'run');
    expect(runNode).toBeDefined();
    insertUnresolvedRefsBatch(cg.queries, [
      {
        fromNodeId: runNode!.id,
        referenceName: 'missingCall',
        referenceKind: 'calls',
        line: 4,
        column: 3,
        filePath: 'src/main.ts',
        language: 'typescript',
      },
    ]);
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('is registered and reports resolved plus unresolved dependency counts', async () => {
    const names = getToolModules().map((mod) => mod.definition.name);
    expect(names).toContain('cartograph_dependency_coverage');

    const text = textOf(await handler.execute('cartograph_dependency_coverage', { limit: 10 }));
    expect(text).toContain('Dependency Coverage');
    expect(text).toContain('typescript/calls');
    expect(text).toContain('missingCall');
  });

  it('renders a compact low-token form', async () => {
    const text = textOf(await handler.execute('cartograph_dependency_coverage', { lowTokens: true }));
    expect(text).toContain('coverage resolved=');
    expect(text).toContain('typescript|calls');
  });
});
