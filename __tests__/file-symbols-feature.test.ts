import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAllFilesWithSymbolCount } from '../src/db/queries-files.js';
import { buildDirRollup, filterFilesByDir, runFilesCommand } from '../src/features/files/index.js';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';
import { collectFileSymbols, renderFileSymbols } from '../src/features/file-symbols/runtime.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_files format=symbols', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-symbols-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.ts'),
      [
        "import { dep } from './dep';",
        'export class BillingService {',
        '  run(accountId: string): number {',
        '    return dep(accountId);',
        '  }',
        '}',
        'export function helper(): string {',
        "  return 'ok';",
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tempDir, 'src', 'dep.ts'), 'export function dep(input: string): number { return 1; }\n');
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('is folded into cartograph_files rather than registered as a standalone MCP tool', () => {
    const names = getToolModules().map((mod) => mod.definition.name);
    expect(names).toContain('cartograph_files');
    expect(names).not.toContain('cartograph_file_symbols');
  });

  it('lists symbols for one indexed file without import or parameter noise by default', async () => {
    const text = textOf(await handler.execute('cartograph_files', { format: 'symbols', file: 'src/service.ts' }));
    expect(text).toContain('Symbols in `src/service.ts`');
    expect(text).toContain('BillingService');
    expect(text).toContain('run');
    expect(text).toContain('helper');
    expect(text).not.toContain('| 1 | import |');
    expect(text).not.toContain('| 3 | parameter | accountId');
  });

  it('can include import/export nodes on request', async () => {
    const text = textOf(
      await handler.execute('cartograph_files', { format: 'symbols', file: 'src/service.ts', includeImports: true }),
    );
    expect(text).toContain('| 1 | import |');
  });

  it('explains when default import filters hide the only requested rows', async () => {
    const importText = textOf(
      await handler.execute('cartograph_files', { format: 'symbols', file: 'src/service.ts', kinds: 'import' }),
    );
    expect(importText).toContain('includeImports: true');
  });

  it('explains when default parameter filters hide the only requested rows', () => {
    const result = collectFileSymbols({
      nodes: [
        {
          id: 'p',
          name: 'accountId',
          qualifiedName: 'BillingService.run.accountId',
          kind: 'parameter',
          language: 'typescript',
          filePath: 'src/service.ts',
          startLine: 3,
          endLine: 3,
          startColumn: 6,
          endColumn: 15,
        } as any,
      ],
      kinds: ['parameter'],
    });
    const parameterText = renderFileSymbols({ filePath: 'src/service.ts', result });
    expect(parameterText).toContain('includeParameters: true');
  });

  it('accepts an absolute path inside the project', async () => {
    const text = textOf(
      await handler.execute('cartograph_files', { format: 'symbols', file: path.join(tempDir, 'src', 'service.ts') }),
    );
    expect(text).toContain('Symbols in `src/service.ts`');
  });

  it('returns a clean empty message when the file is not indexed', async () => {
    const text = textOf(await handler.execute('cartograph_files', { format: 'symbols', file: 'src/missing.ts' }));
    expect(text).toContain('No indexed file matched "src/missing.ts"');
    expect(text).toContain('cartograph_files');
  });

  it('CLI files --format symbols renders JSON through the same runtime', async () => {
    const lines: string[] = [];
    await runFilesCommand(
      {
        program: null as never,
        error: (message) => lines.push(`error:${message}`),
        info: (message) => lines.push(`info:${message}`),
        resolveProjectPath: () => tempDir,
        loadCartograph: async () => ({
          default: {
            open: async () => ({
              projectRoot: cg.projectRoot,
              queries: cg.queries,
              internals: cg.internals,
              close: () => undefined,
            }),
          },
        }),
        isInitialized: () => true,
        getAllFilesWithSymbolCount,
        getFileSummaries: () => new Map(),
        filterFilesByDir,
        buildDirRollup,
        runViaMCP: async () => undefined,
        writeLine: (message = '') => lines.push(message),
      },
      'src/service.ts',
      { format: 'symbols', json: true },
    );
    const parsed = JSON.parse(lines.at(-1)!) as {
      file: string;
      symbols: Array<{ name: string }>;
    };
    expect(parsed.file).toBe('src/service.ts');
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain('BillingService');
  });
});
