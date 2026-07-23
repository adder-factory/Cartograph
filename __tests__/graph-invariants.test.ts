import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: Awaited<ReturnType<ToolHandler['execute']>>): string {
  return result.content[0]?.text ?? '';
}

describe('graph invariants across MCP surfaces', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;
  let targetCallLine: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-invariants-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'src', 'leaf.ts'),
      [
        'export function targetFn(value: number): number {',
        '  return value + 1;',
        '}',
        'export function untestedTarget(): number {',
        '  return 0;',
        '}',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'other.ts'),
      ['export function other(): number {', '  return 10;', '}'].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      ["export { targetFn, untestedTarget } from './leaf.js';", "export { other } from './other.js';"].join('\n') +
        '\n',
    );

    const consumerLines = [
      "import { targetFn } from './leaf.js';",
      'export function useTarget(): number {',
      '  return targetFn(2);',
      '}',
    ];
    targetCallLine = consumerLines.findIndex((line) => line.includes('targetFn(2)')) + 1;
    fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), consumerLines.join('\n') + '\n');

    fs.writeFileSync(path.join(dir, 'src', 'setup.ts'), 'globalThis.__cartographGraphInvariant = true;\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'side.ts'),
      ["import './setup.js';", 'export function side(): number {', '  return 3;', '}'].join('\n') + '\n',
    );

    fs.writeFileSync(
      path.join(dir, 'src', 'consumer.test.ts'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { targetFn } from './leaf.js';",
        "import { useTarget } from './consumer.js';",
        "describe('targetFn path', () => {",
        "  it('uses the leaf and the consumer', () => {",
        '    expect(targetFn(3)).toBe(4);',
        '    expect(useTarget()).toBe(3);',
        '  });',
        '});',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'side.test.ts'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { side } from './side.js';",
        "describe('side effect path', () => {",
        "  it('uses the side effect importer', () => {",
        '    expect(side()).toBe(3);',
        '  });',
        '});',
      ].join('\n') + '\n',
    );

    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `barrel-other-${i}.test.ts`),
        [
          "import { describe, expect, it } from 'vitest';",
          "import { other } from './index.js';",
          `describe('barrel sibling ${i}', () => {`,
          "  it('uses only the sibling export', () => {",
          '    expect(other()).toBe(10);',
          '  });',
          '});',
        ].join('\n') + '\n',
      );
    }

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'graph-invariants', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps affected and tests_for aligned for resolved import paths', async () => {
    const affected = textOf(await handler.execute('cartograph_affected', { files: ['src/leaf.ts'] }));
    const testsFor = textOf(await handler.execute('cartograph_tests_for', { symbol: 'targetFn' }));

    expect(affected).toContain('src/consumer.test.ts');
    expect(testsFor).toContain('src/consumer.test.ts');
    expect(testsFor).not.toMatch(/No tests found/);
  });

  it('preserves side-effect imports as reverse file dependencies', async () => {
    const affected = textOf(await handler.execute('cartograph_affected', { files: ['src/setup.ts'] }));
    const callers = textOf(await handler.execute('cartograph_graph', { start: 'src/setup.ts', direction: 'callers' }));

    expect(affected).toContain('src/side.test.ts');
    expect(callers).toContain('src/side.ts');
  });

  it('keeps barrel fanout in file mode out of symbol-mode tests_for', async () => {
    const affected = textOf(await handler.execute('cartograph_affected', { files: ['src/leaf.ts'] }));
    const testsFor = textOf(await handler.execute('cartograph_tests_for', { symbol: 'targetFn' }));

    expect(affected).toContain('Traversal reached the public-API barrel');
    expect(affected).not.toContain('src/barrel-other-0.test.ts');
    expect(affected).toContain('src/consumer.test.ts');
    expect(testsFor).not.toContain('barrel-other-0.test.ts');
    expect(testsFor).not.toContain('barrel-other-1.test.ts');
    expect(testsFor).not.toContain('barrel-other-2.test.ts');
  });

  it('reports call-site range context without mixing in the callee definition', async () => {
    const text = textOf(
      await handler.execute('cartograph_at_range', {
        file: 'src/consumer.ts',
        startLine: targetCallLine,
        endLine: targetCallLine,
        compact: true,
        fields: ['name', 'kind', 'path', 'line'],
      }),
    );

    expect(text).toContain('useTarget|function|src/consumer.ts:2');
    expect(text).not.toContain('targetFn|function|src/leaf.ts');
    expect(text).not.toContain('src/leaf.ts');
  });
});
