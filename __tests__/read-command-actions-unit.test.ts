import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerReadCommands } from '../src/bin/commands/read.js';
import type { FileRecord, Node } from '../src/types.js';

const actions = new Map<string, (...args: any[]) => unknown>();
const calls: Array<{ tool: string; args: unknown; projectPath?: string }> = [];
const stdout: string[] = [];
let projectPath: string;

function projectHasCartographDb(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.cartograph', 'cartograph.db'));
}

const SOURCE_NODE_COUNT = 2;
const TEST_NODE_COUNT = 1;
const SOURCE_FILE_SIZE = 10;
const TEST_FILE_SIZE = 8;
const FIXTURE_TIMESTAMP = 1;

const indexedFiles: FileRecord[] = [
  {
    path: 'src/a.ts',
    contentHash: 'source-hash',
    language: 'typescript',
    nodeCount: SOURCE_NODE_COUNT,
    size: SOURCE_FILE_SIZE,
    modifiedAt: FIXTURE_TIMESTAMP,
    indexedAt: FIXTURE_TIMESTAMP,
  },
  {
    path: 'test/a.test.ts',
    contentHash: 'test-hash',
    language: 'typescript',
    nodeCount: TEST_NODE_COUNT,
    size: TEST_FILE_SIZE,
    modifiedAt: FIXTURE_TIMESTAMP,
    indexedAt: FIXTURE_TIMESTAMP,
  },
];

const exportNodes: Node[] = [
  {
    id: 'function:a',
    kind: 'function',
    name: 'a',
    qualifiedName: 'a',
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: FIXTURE_TIMESTAMP,
    endLine: 3,
    startColumn: 0,
    endColumn: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  },
];

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
  get projectRoot() {
    return projectPath;
  },
  internals: {
    graphManager: {},
    orchestrator: {
      getChangedFiles: () => ({ added: [], modified: [], removed: [] }),
    },
  },
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

function loadReadCommandActions(): void {
  actions.clear();
  registerReadCommands({
    program: new FakeCommand(),
    error: (message: string) => stdout.push(`error:${message}`),
    info: (message: string) => stdout.push(`info:${message}`),
    resolveProjectPath: (pathArg?: string) => pathArg ?? projectPath,
    loadCartograph: async () => ({ default: { open: async () => fakeCg } }),
    runViaMCP: async (tool: string, args: unknown, projectPath?: string) => calls.push({ tool, args, projectPath }),
    isInitialized: projectHasCartographDb,
    getAllFilesWithSymbolCount: () => indexedFiles,
    getAllNodes: () => exportNodes,
    getAllEdges: () => [],
    getAllFiles: () => [indexedFiles[0]!],
    getFileSummaries: () => new Map([['src/a.ts', 'source file summary']]),
    filterFilesByDir: (files, dir) => files.filter((f) => f.path.startsWith(dir)),
    buildDirRollup: () => ({ totalFiles: 1, totalSymbols: 2, rows: [{ dir: 'src', files: 1, symbols: 2 }] }),
    buildIndexedPathSets: () => ({
      allIndexedPaths: new Set(['src/a.ts', 'test/a.test.ts']),
      isTestByIndex: new Set(['test/a.test.ts']),
      filesWithTestCases: new Set(['test/a.test.ts']),
    }),
    findAffectedTests: () => ({
      affectedTests: new Set(['test/a.test.ts']),
      totalDependents: 2,
      barrelsReached: ['src/index.ts'],
    }),
    loadGitUtils: async () => ({
      listChangedFilesSince: () => ['src/a.ts'],
      getCurrentHeadSha: () => 'HEAD',
    }),
  });
}

describe('read command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    stdout.length = 0;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    fakeCg.close.mockClear();
    loadReadCommandActions();
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

  it('runs status, files, export, and affected actions against opened Cartograph data', async () => {
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await actions.get('status [path]')!(projectPath, { json: true });
      await actions.get('files [target]')!(undefined, {
        projectPath,
        dir: 'src',
        format: 'flat',
        metadata: true,
      });
      await actions.get('export [path]')!(projectPath, {
        format: 'json',
        limit: '5',
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
    expect(text).toContain('"initialized":true');
    expect(text).toContain('"fileCount":1');
    expect(text).toContain('Files (1)');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('source file summary');
    expect(text).toContain('"formatVersion": 1');
    expect(text).toContain('"exportedNodes": 1');
    expect(text).toContain('"affectedTests":');
    expect(text).toContain('test/a.test.ts');
    expect(fakeCg.close).toHaveBeenCalled();
  });
});
