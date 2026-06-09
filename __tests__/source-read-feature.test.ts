import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('source-read line windows', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-source-read-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'sample.ts'),
      [
        'export function sample(): string {',
        "  const first = 'alpha';",
        "  const second = 'bravo';",
        "  const third = 'charlie';",
        '  return [first, second, third].join(",");',
        '}',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a line window through cartograph_files format=read', async () => {
    const text = textOf(
      await handler.execute('cartograph_files', {
        format: 'read',
        file: 'src/sample.ts',
        lineOffset: 1,
        lineLimit: 2,
      }),
    );

    expect(text).toContain('Source `src/sample.ts`');
    expect(text).toContain('lines:');
    expect(text).toContain("const first = 'alpha'");
    expect(text).toContain("const second = 'bravo'");
    expect(text).not.toContain("const third = 'charlie'");
    expect(text).toContain('more available with `lineOffset: 3`');
  });

  it('pages source returned by cartograph_node', async () => {
    const text = textOf(
      await handler.execute('cartograph_node', {
        symbol: 'sample',
        code: true,
        detail: 'full',
        lineOffset: 2,
        lineLimit: 2,
      }),
    );

    expect(text).toContain('Showing source window 3-4');
    expect(text).toContain("const second = 'bravo'");
    expect(text).toContain("const third = 'charlie'");
    expect(text).not.toContain("const first = 'alpha'");
  });

  it('rejects non-integer line controls at the schema boundary', async () => {
    const result = await handler.execute('cartograph_files', {
      format: 'read',
      file: 'src/sample.ts',
      lineOffset: 1.5,
    });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain('lineOffset');
  });
});
