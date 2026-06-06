import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __readCommandInternals as read } from '../src/bin/commands/read.js';
import {
  parseFilesOutputOptions,
  renderFileSummary,
  renderFileTree,
  renderFilesOutput,
  renderGroupedFiles,
} from '../src/features/files/runtime.js';
import { buildFindMcpArgs } from '../src/features/find/runtime.js';

function captureOutput(fn: () => unknown): string {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.join(' '));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return chunks.join('\n');
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  return text.replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

describe('read command internals', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it('normalizes at-range positional, ranges, file diff, and inline diff inputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-diff-'));
    const diffPath = path.join(dir, 'change.diff');
    fs.writeFileSync(diffPath, 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n');
    try {
      await expect(
        read.buildAtRangeArgs({
          file: 'src/a.ts',
          startLine: '10',
          endLine: '12',
          options: { limit: '5', compact: true, fields: 'name,path' },
        }),
      ).resolves.toMatchObject({
        file: 'src/a.ts',
        startLine: 10,
        endLine: 12,
        limit: 5,
        compact: true,
        fields: ['name', 'path'],
      });
      await expect(
        read.buildAtRangeArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { ranges: 'src/a.ts:1-2,src/b.ts:3-4' },
        }),
      ).resolves.toMatchObject({
        ranges: [
          { file: 'src/a.ts', startLine: 1, endLine: 2 },
          { file: 'src/b.ts', startLine: 3, endLine: 4 },
        ],
      });
      await expect(
        read.buildAtRangeArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { diff: diffPath },
        }),
      ).resolves.toMatchObject({
        diff: expect.stringContaining('+new'),
      });
      await expect(
        read.buildAtRangeArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { diff: '@@ -1 +1 @@\n-old\n+new' },
        }),
      ).resolves.toMatchObject({ diff: expect.stringContaining('-old') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates ask and find option primitives before expensive project work', () => {
    expect(read.validateAskQuestion('How does status work?')).toBe(true);
    expect(read.validateAskQuestion('   ')).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    expect(read.parseRetrieveK(undefined)).toBe(12);
    expect(read.parseRetrieveK('4')).toBe(4);
    expect(read.parseRetrieveK('0')).toBeNull();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    expect(read.parseFieldsOption(' name, kind,,path ')).toEqual(['name', 'kind', 'path']);
    expect(read.parseFieldsOption(undefined)).toBeUndefined();
    expect(read.isValidFindAxis('name')).toBe(true);
    expect(read.isValidFindAxis('content')).toBe(true);
    expect(read.isValidFindAxis('bogus')).toBe(false);
  });

  it('builds MCP payloads for find content, env/sql, exact, fuzzy, and semantic modes', () => {
    const payloads = [
      buildFindMcpArgs('needle', {
        by: 'content',
        limit: '7',
        caseSensitive: true,
        pathFilter: 'src',
        language: 'typescript',
        since: 'c_1',
        allowStale: true,
        projectPath: '/repo',
      }),
      buildFindMcpArgs(undefined, {
        by: 'env',
        limit: '3',
        key: 'API_KEY',
        includeTests: false,
        projectPath: '/repo',
      }),
      buildFindMcpArgs(undefined, {
        by: 'sql',
        limit: '4',
        key: 'users',
        op: 'read',
        includeTests: true,
        allowStale: true,
      }),
      buildFindMcpArgs('Widget', {
        by: 'name',
        mode: 'exact',
        limit: '9',
        kind: 'class',
        compact: true,
        fields: 'name,path,id',
        since: 'c_2',
        allowStale: true,
      }),
      buildFindMcpArgs('render', {
        by: 'name',
        mode: 'fuzzy',
        limit: '5',
        kind: 'function',
        sameLanguage: true,
        languageFilter: 'typescript',
        pathFilter: 'src/ui',
      }),
      buildFindMcpArgs(undefined, {
        by: 'name',
        mode: 'semantic',
        symbol: 'Button',
        differentLanguage: true,
        limit: '6',
        allowStale: true,
        projectPath: '/repo',
      }),
    ];

    expect(payloads).toEqual([
      {
        ok: true,
        args: {
          by: 'content',
          query: 'needle',
          limit: 7,
          caseSensitive: true,
          pathFilter: 'src',
          language: 'typescript',
          since: 'c_1',
          allowStale: true,
        },
      },
      { ok: true, args: { by: 'env', limit: 3, key: 'API_KEY', includeTests: false } },
      { ok: true, args: { by: 'sql', limit: 4, key: 'users', op: 'read', includeTests: true, allowStale: true } },
      {
        ok: true,
        args: {
          by: 'name',
          mode: 'exact',
          query: 'Widget',
          limit: 9,
          kind: 'class',
          compact: true,
          fields: ['name', 'path', 'id'],
          since: 'c_2',
          allowStale: true,
        },
      },
      {
        ok: true,
        args: {
          by: 'name',
          mode: 'fuzzy',
          query: 'render',
          limit: 5,
          kind: 'function',
          sameLanguage: true,
          languageFilter: 'typescript',
          pathFilter: 'src/ui',
        },
      },
      {
        ok: true,
        args: {
          by: 'name',
          mode: 'semantic',
          limit: 6,
          symbol: 'Button',
          differentLanguage: true,
          allowStale: true,
        },
      },
    ]);
  });

  it('prints uninitialized status and initialized JSON status with rollup lines', () => {
    const uninitialized = stripAnsi(captureOutput(() => read.printUninitializedStatus('/repo', {})));
    expect(uninitialized).toContain('Cartograph Status');
    expect(uninitialized).toContain('Project: /repo');
    expect(uninitialized).toContain('Not initialized');

    const json = stripAnsi(
      captureOutput(() =>
        read.printStatusJson({
          cg: fakeCg(),
          projectPath: '/repo',
          stats: fakeStats(),
          changes: { added: ['src/new.ts'], removed: [], healOnly: [] },
          healOnly: [],
          realModifiedCount: 1,
          hnswAvailable: true,
          rollups: fakeRollups(),
        }),
      ),
    );
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      initialized: true,
      projectPath: '/repo',
      fileCount: 3,
      pendingChanges: { added: 1, modified: 1, removed: 0, healFlagged: 0 },
    });
    expect(parsed.rollups).toEqual(expect.arrayContaining(['ready', 'hotspots:2', 'biomarkers:1']));
  });

  it('prints status sections, pending change states, and LLM summary coverage', () => {
    const out = stripAnsi(
      captureOutput(() => {
        read.printStatusIndexStats(fakeStats(), fakeCg(), false);
        read.printCountBreakdown('Nodes by Kind:', { function: 2, class: 1, file: 0 });
        read.printPendingChanges({ added: ['src/a.ts'], removed: ['src/old.ts'] }, 2, ['src/heal.ts']);
        read.printStatusRollups(fakeCg(), fakeRollups());
      }),
    );

    expect(out).toContain('Index Statistics');
    expect(out).toContain('Files:     3');
    expect(out).toContain('Nodes by Kind:');
    expect(out).toContain('Pending Changes');
    expect(out).toContain('Heal-flagged');
    expect(out).toContain('Readiness');
    expect(out).toContain('hotspots:2');
  });

  it('normalizes status rollup options and renders no-LLM status without provider work', async () => {
    const verboseRollups = await read.buildStatusRollupConfig({
      verbose: true,
      topHotspots: '0',
      topBiomarkers: '0',
      summaryBreakdown: false,
    });
    expect(verboseRollups.topHotspots).toBe(5);
    expect(verboseRollups.topBiomarkers).toBe(5);
    expect(verboseRollups.summaryBreakdown).toBe(false);

    const cappedRollups = await read.buildStatusRollupConfig({ topHotspots: '999', topBiomarkers: '-2' });
    expect(cappedRollups.topHotspots).toBe(30);
    expect(cappedRollups.topBiomarkers).toBe(0);

    const out = stripAnsi(
      await captureAsyncOutput(() =>
        read.printLlmStatus(
          {
            llm: {
              config: {
                getEffectiveLlmConfig: async () => null,
              },
            },
          },
          '/repo',
        ),
      ),
    );
    expect(out).toContain('LLM Enrichment');
    expect(out).toContain('No LLM configured');
  });

  it('renders affected-test output for json, quiet, human, empty, and barrel-warning modes', () => {
    const base = {
      changedFiles: ['src/a.ts'],
      sortedTests: ['__tests__/a.test.ts'],
      totalDependents: 3,
      barrelsReached: ['src/index.ts'],
      derivedFromGit: true,
    };

    const json = stripAnsi(captureOutput(() => read.printAffectedOutput({ ...base, options: { json: true } })));
    expect(JSON.parse(json)).toMatchObject({ changedFiles: ['src/a.ts'], affectedTests: ['__tests__/a.test.ts'] });

    const quiet = stripAnsi(captureOutput(() => read.printAffectedOutput({ ...base, options: { quiet: true } })));
    expect(quiet).toContain('__tests__/a.test.ts');

    const human = stripAnsi(captureOutput(() => read.printAffectedOutput({ ...base, options: {} })));
    expect(human).toContain('Changed set derived from `git diff HEAD`');
    expect(human).toContain('Affected test files (1)');
    expect(human).toContain('Traversed 3 dependents total');
    expect(human).toContain('src/index.ts');

    const empty = stripAnsi(captureOutput(() => read.printAffectedTestList([])));
    expect(empty).toContain('No test files affected');

    const many = Array.from({ length: 42 }, (_, i) => `__tests__/${String(i).padStart(2, '0')}.test.ts`);
    const limited = stripAnsi(captureOutput(() => read.printAffectedTestList(many)));
    expect(limited).toContain('Affected test files (42)');
    expect(limited).toContain('showing first 40 of 42');

    const noBarrel = stripAnsi(captureOutput(() => read.printBarrelWarning([])));
    expect(noBarrel).toBe('');
  });

  it('validates affected paths and builds safe filters', async () => {
    const regex = read.buildAffectedFilter('src/*.ts');
    expect(regex?.test('src/a.ts')).toBe(true);
    expect(read.buildAffectedFilter(undefined)).toBeNull();

    const closeCalls: string[] = [];
    read.validateAffectedIndexedPaths({
      changedFiles: ['src/a.ts', 'missing.ts'],
      derivedFromGit: false,
      coreInput: { allIndexedPaths: new Set(['src/a.ts']) },
      cg: { close: () => closeCalls.push('close') },
    });
    expect(closeCalls).toEqual([]);

    read.validateAffectedIndexedPaths({
      changedFiles: ['missing.ts'],
      derivedFromGit: true,
      coreInput: { allIndexedPaths: new Set<string>() },
      cg: { close: () => closeCalls.push('derived') },
    });
    expect(closeCalls).toEqual([]);

    expect(read.parseAffectedDepth({ depth: '3' }, { close: () => closeCalls.push('depth') })).toBe(3);
    expect(read.parseAffectedDepth({ depth: 'abc' }, { close: () => closeCalls.push('bad-depth') })).toBeNull();
    expect(read.parseAffectedDepth({ depth: '0' }, { close: () => closeCalls.push('zero-depth') })).toBeNull();
    expect(closeCalls).toEqual(['bad-depth', 'zero-depth']);

    await expect(read.collectAffectedChangedFiles(['src/a.ts'], { files: ['src/b.ts'] }, '/repo')).resolves.toEqual({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      derivedFromGit: false,
    });

    const json = stripAnsi(captureOutput(() => read.printNoDerivedChanges({ json: true })));
    expect(JSON.parse(json)).toMatchObject({ changedFiles: [], affectedTests: [] });
    expect(stripAnsi(captureOutput(() => read.printNoDerivedChanges({ quiet: true })))).toBe('');
  });

  it('renders file listings in grouped, summary, and tree modes', () => {
    const files = [
      { path: 'src/a.ts', language: 'typescript', nodeCount: 2, size: 10 },
      { path: 'src/nested/b.ts', language: 'typescript', nodeCount: 3, size: 20 },
      { path: 'README.md', language: 'markdown', nodeCount: 1, size: 5 },
    ];

    const grouped = stripAnsi(renderGroupedFiles(files, true).join('\n'));
    expect(grouped).toContain('typescript (2)');
    expect(grouped).toContain('src/a.ts');

    const summary = stripAnsi(
      renderFileSummary({ files, maxDepth: 1, dir: 'src', buildDirRollup: fakeBuildDirRollup }).join('\n'),
    );
    expect(summary).toContain('Subtree Summary');
    expect(summary).toContain('src/');

    const tree = stripAnsi(renderFileTree({ files, includeMetadata: true, maxDepth: 3 }).join('\n'));
    expect(tree).toContain('src');
    expect(tree).toContain('a.ts');

    const flatFiles = Array.from({ length: 81 }, (_, i) => ({
      path: `src/${String(i).padStart(2, '0')}.ts`,
      language: 'typescript',
      nodeCount: i,
      size: i,
    }));
    const flat = stripAnsi(
      renderFilesOutput({
        files: flatFiles,
        format: 'flat',
        includeMetadata: true,
        maxDepth: undefined,
        dir: undefined,
        buildDirRollup: fakeBuildDirRollup,
      }).join('\n'),
    );
    expect(flat).toContain('Files (81)');
    expect(flat).toContain('src/00.ts');
    expect(flat).toContain('(typescript, 0 symbols)');

    const parsed = parseFilesOutputOptions({ format: 'summary', maxDepth: '2' });
    expect(parsed).toEqual({ ok: true, format: 'summary', maxDepth: 2 });
  });
});

async function captureAsyncOutput(fn: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.join(' '));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return chunks.join('\n');
}

function fakeStats() {
  return {
    fileCount: 3,
    nodeCount: 8,
    edgeCount: 5,
    dbSizeBytes: 4096,
    nodesByKind: { function: 2, class: 1 },
    filesByLanguage: { typescript: 3 },
  };
}

function fakeCg() {
  return {
    db: {
      getBackend: () => 'bun:sqlite',
      hasVecExtension: () => true,
    },
    queries: {},
  };
}

function fakeRollups() {
  return {
    topHotspots: 2,
    topBiomarkers: 1,
    summaryBreakdown: true,
    appendFeatureReadiness: (lines: string[]) => lines.push('### Readiness', 'ready'),
    appendInlineHotspots: (lines: string[], _cg: unknown, topN: number) => lines.push(`hotspots:${topN}`),
    appendInlineBiomarkers: (lines: string[], _cg: unknown, topN: number) => lines.push(`biomarkers:${topN}`),
  };
}

function fakeBuildDirRollup(files: Array<{ path: string; nodeCount: number }>, maxDepth?: number, dir?: string) {
  const scoped = dir ? files.filter((file) => file.path === dir || file.path.startsWith(`${dir}/`)) : files;
  const depth = maxDepth ?? 1;
  const rows = scoped.length > 0 ? [{ dir: dir ?? 'src', files: scoped.length, symbols: depth + scoped.length }] : [];
  return {
    rows,
    totalFiles: scoped.length,
    totalSymbols: scoped.reduce((sum, file) => sum + file.nodeCount, 0),
  };
}
