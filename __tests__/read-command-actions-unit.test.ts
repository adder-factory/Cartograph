import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const actions = new Map<string, (...args: any[]) => unknown>();
const calls: Array<{ tool: string; args: unknown; projectPath?: string }> = [];
const stdout: string[] = [];
let projectPath: string;

class FakeCommand {
  constructor(private readonly name = 'program') {}

  command(name: string): FakeCommand {
    return new FakeCommand(name);
  }

  description(): this {
    return this;
  }

  argument(): this {
    return this;
  }

  option(): this {
    return this;
  }

  action(fn: (...args: any[]) => unknown): this {
    actions.set(this.name, fn);
    return this;
  }
}

const fakeCg = {
  queries: {},
  internals: { graphManager: {} },
  stats: {
    getStats: () => ({
      fileCount: 1,
      nodeCount: 2,
      edgeCount: 3,
      dbSizeBytes: 1024,
      nodesByKind: { function: 1 },
      filesByLanguage: { typescript: 1 },
    }),
    getFreshness: () => null,
  },
  db: { getBackend: () => 'bun:sqlite', hasVecExtension: () => true },
  llm: { config: { getEffectiveLlmConfig: async () => null } },
  close: vi.fn(),
};

vi.mock('../src/bin/_cli-core.js', () => ({
  program: new FakeCommand(),
  error: vi.fn((message: string) => stdout.push(`error:${message}`)),
  success: vi.fn((message: string) => stdout.push(`success:${message}`)),
  info: vi.fn((message: string) => stdout.push(`info:${message}`)),
  warn: vi.fn((message: string) => stdout.push(`warn:${message}`)),
  chalk: { bold: (s: string) => s, cyan: (s: string) => s, dim: (s: string) => s },
  resolveProjectPath: vi.fn((pathArg?: string) => pathArg ?? projectPath),
  loadCartograph: vi.fn(async () => ({ default: { open: vi.fn(async () => fakeCg) } })),
  assignIntArg: vi.fn(({ args, key, raw }) => {
    if (raw !== undefined) args[key] = Number(raw);
    return true;
  }),
  formatNumber: (n: number) => String(n),
  runViaMCP: vi.fn(async (tool: string, args: unknown, projectPath?: string) =>
    calls.push({ tool, args, projectPath }),
  ),
}));

vi.mock('../src/mcp/tools/ask.js', () => ({
  RETRIEVE_K_DEFAULT: 12,
  RETRIEVE_K_MIN: 4,
  RETRIEVE_K_MAX: 40,
}));

vi.mock('../src/db/queries-files.js', () => ({
  getAllFilesWithSymbolCount: vi.fn(() => [
    { path: 'src/a.ts', language: 'typescript', nodeCount: 2, size: 10 },
    { path: 'test/a.test.ts', language: 'typescript', nodeCount: 1, size: 8 },
  ]),
}));

vi.mock('../src/db/queries-file-summaries.js', () => ({
  getFileSummaries: vi.fn(() => new Map([['src/a.ts', 'source file summary']])),
}));

vi.mock('../src/affected-core.js', () => ({
  DEFAULT_DEPTH: 5,
  buildIndexedPathSets: vi.fn(() => ({
    allIndexedPaths: new Set(['src/a.ts', 'test/a.test.ts']),
    testPaths: new Set(['test/a.test.ts']),
  })),
  findAffectedTests: vi.fn(() => ({
    affectedTests: new Set(['test/a.test.ts']),
    totalDependents: 2,
    barrelsReached: ['src/index.ts'],
  })),
}));

vi.mock('../src/mcp/tools/files.js', () => ({
  filterFilesByDir: vi.fn((files: any[], dir: string) => files.filter((f) => f.path.startsWith(dir))),
  buildDirRollup: vi.fn(() => ({ totalFiles: 1, totalSymbols: 2, rows: [{ dir: 'src', files: 1, symbols: 2 }] })),
}));

vi.mock('../src/db/queries-summaries.js', () => ({
  getSummaryCoverage: vi.fn(() => null),
  getWeightedSummaryCoverage: vi.fn(() => null),
}));

vi.mock('../src/llm/summarizer.js', () => ({
  SUMMARIZABLE_KINDS: ['function'],
}));

vi.mock('../src/embeddings/hnsw-index.js', () => ({
  isHnswAvailable: vi.fn(async () => false),
}));

vi.mock('../src/git-utils.js', () => ({
  listChangedFilesSince: vi.fn(() => ['src/a.ts']),
}));

await import('../src/bin/commands/read.js');

describe('read command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    stdout.length = 0;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    fakeCg.close.mockClear();
  });

  afterEach(() => {
    if (projectPath && fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('routes at-range, find, and digest actions through MCP payloads', async () => {
    await actions.get('at-range [file] [startLine] [endLine]')!('src/a.ts', '2', '4', {
      limit: '3',
      compact: true,
      fields: 'name,path',
      projectPath,
    });
    await actions.get('find [query]')!('needle', {
      by: 'content',
      limit: '7',
      caseSensitive: true,
      projectPath,
    });
    await actions.get('digest')!({ projectPath });

    expect(calls).toEqual([
      {
        tool: 'cartograph_at_range',
        projectPath,
        args: { file: 'src/a.ts', startLine: 2, endLine: 4, limit: 3, compact: true, fields: ['name', 'path'] },
      },
      {
        tool: 'cartograph_find',
        projectPath,
        args: { by: 'content', query: 'needle', limit: 7, caseSensitive: true },
      },
      { tool: 'cartograph_digest', projectPath, args: {} },
    ]);
  });

  it('runs files and affected actions against opened Cartograph data', async () => {
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await actions.get('files [dir]')!(undefined, {
        projectPath,
        dir: 'src',
        format: 'flat',
        metadata: true,
      });
      await actions.get('affected [files...]')!(['src/a.ts'], {
        projectPath,
        depth: '3',
        json: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const text = stdout.join('');
    expect(text).toContain('Files (1)');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('source file summary');
    expect(text).toContain('"affectedTests":');
    expect(text).toContain('test/a.test.ts');
    expect(fakeCg.close).toHaveBeenCalled();
  });
});
