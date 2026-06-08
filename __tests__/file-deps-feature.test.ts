import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAllFilesWithSymbolCount } from '../src/db/queries-files.js';
import { runFileDepsCommand } from '../src/features/file-deps/index.js';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_file_deps', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-deps-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'dep.ts'), 'export function dep(input: string): number { return 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.ts'),
      [
        "import { dep } from './dep';",
        'export class BillingService {',
        '  run(accountId: string): number {',
        '    return dep(accountId);',
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'consumer.ts'),
      [
        "import { BillingService } from './service';",
        'export function boot(): number {',
        '  return new BillingService().run("acct_1");',
        '}',
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

  it('is registered as an MCP tool', () => {
    expect(getToolModules().map((mod) => mod.definition.name)).toContain('cartograph_file_deps');
  });

  it('shows dependencies, dependents, and defined symbols for one file', async () => {
    const text = textOf(await handler.execute('cartograph_file_deps', { file: 'src/service.ts' }));
    expect(text).toContain('File dependencies for `src/service.ts`');
    expect(text).toContain('### Depends On (1)');
    expect(text).toContain('`src/dep.ts`');
    expect(text).toContain('### Depended On By (1)');
    expect(text).toContain('`src/consumer.ts`');
    expect(text).toContain('### Defines');
    expect(text).toContain('class BillingService');
    expect(text).toContain('method run');
  });

  it('can restrict output to dependencies only', async () => {
    const text = textOf(
      await handler.execute('cartograph_file_deps', { file: 'src/service.ts', direction: 'dependencies' }),
    );
    expect(text).toContain('### Depends On (1)');
    expect(text).not.toContain('### Depended On By');
  });

  it('uses compact rows with lowTokens', async () => {
    const text = textOf(await handler.execute('cartograph_file_deps', { file: 'src/service.ts', lowTokens: true }));
    expect(text).toContain('deps src/service.ts');
    expect(text).toContain('dep src/dep.ts');
    expect(text).toContain('by src/consumer.ts');
    expect(text).toContain('def class BillingService');
  });

  it('accepts an absolute path inside the project', async () => {
    const text = textOf(
      await handler.execute('cartograph_file_deps', { file: path.join(tempDir, 'src', 'service.ts') }),
    );
    expect(text).toContain('File dependencies for `src/service.ts`');
  });

  it('returns a clean empty message when the file is not indexed', async () => {
    const text = textOf(await handler.execute('cartograph_file_deps', { file: 'src/missing.ts' }));
    expect(text).toContain('No indexed file matched "src/missing.ts"');
    expect(text).toContain('cartograph_files');
  });

  it('CLI command renders JSON through the same runtime', async () => {
    const lines: string[] = [];
    await runFileDepsCommand(
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
        writeLine: (message = '') => lines.push(message),
      },
      'src/service.ts',
      { json: true },
    );
    const parsed = JSON.parse(lines.at(-1)!) as {
      dependencies: string[];
      dependents: string[];
      symbols: Array<{ name: string }>;
    };
    expect(parsed.dependencies).toContain('src/dep.ts');
    expect(parsed.dependents).toContain('src/consumer.ts');
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain('BillingService');
  });
});
