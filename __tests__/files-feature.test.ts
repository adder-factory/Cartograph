import { describe, expect, it } from 'vitest';
import {
  buildEffectiveFilesOptions,
  buildFilesJsonRows,
  filterFilesForCli,
  parseFilesOutputOptions,
  renderFilesOutput,
} from '../src/features/files/runtime.js';

const files = [
  { path: 'src/a.ts', language: 'typescript', nodeCount: 2, size: 10 },
  { path: 'src/nested/b.ts', language: 'typescript', nodeCount: 3, size: 20 },
  { path: 'README.md', language: 'markdown', nodeCount: 1, size: 5 },
];

describe('files feature runtime', () => {
  it('normalizes positional dir and parses output options as values', () => {
    expect(buildEffectiveFilesOptions('src', {})).toEqual({ dir: 'src' });
    expect(buildEffectiveFilesOptions('src', { dir: 'test' })).toEqual({ dir: 'test' });
    expect(parseFilesOutputOptions({ lowTokens: true })).toEqual({ ok: true, format: 'summary', maxDepth: 3 });
    expect(parseFilesOutputOptions({ format: 'flat', maxDepth: '2' })).toEqual({
      ok: true,
      format: 'flat',
      maxDepth: 2,
    });
    expect(parseFilesOutputOptions({ format: 'wide' })).toEqual({
      ok: false,
      error: 'Invalid value for --format: "wide" — valid values: tree, flat, grouped, summary',
    });
    expect(parseFilesOutputOptions({ maxDepth: '0' })).toEqual({
      ok: false,
      error: 'Invalid value for --max-depth: must be >= 1',
    });
  });

  it('filters files by directory and glob without throwing on expected misses', () => {
    const result = filterFilesForCli({
      files,
      options: { dir: 'src', pattern: '**/*.ts' },
      filterFilesByDir: testFilterFilesByDir,
    });
    expect(result).toEqual({ ok: true, files: [files[0], files[1]] });

    expect(filterFilesForCli({ files: [], options: {}, filterFilesByDir: testFilterFilesByDir })).toEqual({
      ok: false,
      reason: 'empty-index',
      message: 'No files indexed. Run "cartograph quickstart" first.',
    });
    expect(filterFilesForCli({ files, options: { dir: 'missing' }, filterFilesByDir: testFilterFilesByDir })).toEqual({
      ok: false,
      reason: 'no-matches',
      message: 'No files found matching the criteria.',
    });
  });

  it('renders json rows and human output lines', () => {
    expect(buildFilesJsonRows(files)).toEqual(files);

    const flat = renderFilesOutput({
      files,
      format: 'flat',
      includeMetadata: true,
      maxDepth: undefined,
      dir: undefined,
      summaries: new Map([['src/a.ts', 'source summary']]),
      buildDirRollup: testBuildDirRollup,
    }).join('\n');
    expect(flat).toContain('Files (3)');
    expect(flat).toContain('src/a.ts (typescript, 2 symbols)');
    expect(flat).toContain('source summary');

    const summary = renderFilesOutput({
      files,
      format: 'summary',
      includeMetadata: true,
      maxDepth: 1,
      dir: 'src',
      buildDirRollup: testBuildDirRollup,
    }).join('\n');
    expect(summary).toContain('Subtree Summary — src/');
    expect(summary).toContain('src/');
  });
});

function testFilterFilesByDir<T extends { path: string }>(rows: ReadonlyArray<T>, dir: string): T[] {
  const normDir = dir.replace(/\/+$/, '');
  return rows.filter((row) => row.path === normDir || row.path.startsWith(`${normDir}/`));
}

function testBuildDirRollup(rows: ReadonlyArray<{ path: string; nodeCount: number }>) {
  return {
    rows: [{ dir: 'src', files: rows.length, symbols: rows.reduce((sum, row) => sum + row.nodeCount, 0) }],
    totalFiles: rows.length,
    totalSymbols: rows.reduce((sum, row) => sum + row.nodeCount, 0),
  };
}
