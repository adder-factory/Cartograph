import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __readCommandInternals as read } from '../src/bin/commands/read.js';
import {
  buildAffectedFilter,
  collectExplicitChangedFiles,
  parseAffectedDepth,
  renderAffectedOutput,
  renderAffectedTestList,
  renderBarrelWarning,
  renderNoDerivedChanges,
  validateAffectedIndexedPaths,
} from '../src/features/affected/runtime.js';
import { parseRetrieveK, validateAskQuestion } from '../src/features/ask/runtime.js';
import { resolveDiffOption } from '../src/features/at-range/cli.js';
import { buildAtRangeMcpArgs } from '../src/features/at-range/runtime.js';
import {
  parseFilesOutputOptions,
  renderFileSummary,
  renderFileTree,
  renderFilesOutput,
  renderGroupedFiles,
} from '../src/features/files/runtime.js';
import { buildFindMcpArgs } from '../src/features/find/runtime.js';

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
      expect(
        buildAtRangeMcpArgs({
          file: 'src/a.ts',
          startLine: '10',
          endLine: '12',
          options: { limit: '5', compact: true, fields: 'name,path' },
        }),
      ).toEqual({
        ok: true,
        args: {
          file: 'src/a.ts',
          startLine: 10,
          endLine: 12,
          limit: 5,
          compact: true,
          fields: ['name', 'path'],
        },
      });
      expect(
        buildAtRangeMcpArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { ranges: 'src/a.ts:1-2,src/b.ts:3-4' },
        }),
      ).toEqual({
        ok: true,
        args: {
          limit: 20,
          ranges: [
            { file: 'src/a.ts', startLine: 1, endLine: 2 },
            { file: 'src/b.ts', startLine: 3, endLine: 4 },
          ],
        },
      });
      const fileDiff = await resolveDiffOption(diffPath, { warn: () => undefined });
      expect(
        buildAtRangeMcpArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { diff: diffPath },
          diffText: fileDiff,
        }),
      ).toEqual({
        ok: true,
        args: { limit: 20, diff: expect.stringContaining('+new') },
      });
      expect(
        buildAtRangeMcpArgs({
          file: undefined,
          startLine: undefined,
          endLine: undefined,
          options: { diff: '@@ -1 +1 @@\n-old\n+new' },
          diffText: '@@ -1 +1 @@\n-old\n+new',
        }),
      ).toEqual({ ok: true, args: { limit: 20, diff: expect.stringContaining('-old') } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates ask and find option primitives before expensive project work', () => {
    expect(validateAskQuestion('How does status work?')).toEqual({ ok: true });
    expect(validateAskQuestion('   ')).toEqual({ ok: false, error: 'ask: the question must not be empty.' });

    expect(parseRetrieveK(undefined)).toEqual({ ok: true, value: 12 });
    expect(parseRetrieveK('4')).toEqual({ ok: true, value: 4 });
    expect(parseRetrieveK('0')).toEqual({ ok: false, error: 'Invalid value for --retrieve-k: must be >= 4' });

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

  it('renders affected-test output for json, quiet, human, empty, and barrel-warning modes', () => {
    const base = {
      changedFiles: ['src/a.ts'],
      sortedTests: ['__tests__/a.test.ts'],
      totalDependents: 3,
      barrelsReached: ['src/index.ts'],
      derivedFromGit: true,
      projectPath: '/repo',
    };

    const json = stripAnsi(renderAffectedOutput({ ...base, options: { json: true } }).join('\n'));
    expect(JSON.parse(json)).toMatchObject({ changedFiles: ['src/a.ts'], affectedTests: ['__tests__/a.test.ts'] });

    const quiet = stripAnsi(renderAffectedOutput({ ...base, options: { quiet: true } }).join('\n'));
    expect(quiet).toContain('__tests__/a.test.ts');

    const human = stripAnsi(renderAffectedOutput({ ...base, options: {} }).join('\n'));
    expect(human).toContain('Changed set derived from `git diff HEAD`');
    expect(human).toContain('Affected test files (1)');
    expect(human).toContain('Traversed 3 dependents total');
    expect(human).toContain('src/index.ts');

    const empty = stripAnsi(renderAffectedTestList([]).join('\n'));
    expect(empty).toContain('No test files affected');

    const many = Array.from({ length: 42 }, (_, i) => `__tests__/${String(i).padStart(2, '0')}.test.ts`);
    const limited = stripAnsi(renderAffectedTestList(many).join('\n'));
    expect(limited).toContain('Affected test files (42)');
    expect(limited).toContain('showing first 40 of 42');

    const noBarrel = stripAnsi(renderBarrelWarning([]).join('\n'));
    expect(noBarrel).toBe('');
  });

  it('validates affected paths and builds safe filters', async () => {
    const regex = buildAffectedFilter('src/*.ts');
    expect(regex?.test('src/a.ts')).toBe(true);
    expect(buildAffectedFilter(undefined)).toBeNull();

    expect(
      validateAffectedIndexedPaths({
        changedFiles: ['src/a.ts', 'missing.ts'],
        derivedFromGit: false,
        allIndexedPaths: new Set(['src/a.ts']),
      }),
    ).toEqual({ ok: true, missing: ['missing.ts'] });

    expect(
      validateAffectedIndexedPaths({
        changedFiles: ['missing.ts'],
        derivedFromGit: true,
        allIndexedPaths: new Set<string>(),
      }),
    ).toEqual({ ok: true, missing: [] });

    expect(
      validateAffectedIndexedPaths({
        changedFiles: ['missing.ts'],
        derivedFromGit: false,
        allIndexedPaths: new Set<string>(),
      }),
    ).toEqual({
      ok: false,
      error: 'None of the 1 input file match indexed paths: missing.ts',
    });

    expect(parseAffectedDepth({ depth: '3' })).toEqual({ ok: true, depth: 3 });
    expect(parseAffectedDepth({ depth: 'abc' })).toEqual({
      ok: false,
      error: 'Invalid value for --depth: "abc" is not a number',
    });
    expect(parseAffectedDepth({ depth: '0' })).toEqual({
      ok: false,
      error: 'Invalid value for --depth: must be >= 1',
    });

    expect(collectExplicitChangedFiles({ fileArgs: ['src/a.ts'], optionFiles: ['src/b.ts'] })).toEqual({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      derivedFromGit: false,
    });

    const json = stripAnsi(renderNoDerivedChanges({ json: true }).join('\n'));
    expect(JSON.parse(json)).toMatchObject({ changedFiles: [], affectedTests: [] });
    expect(stripAnsi(renderNoDerivedChanges({ quiet: true }).join('\n'))).toBe('');
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
