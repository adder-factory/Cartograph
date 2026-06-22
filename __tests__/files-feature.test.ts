import { describe, expect, it } from 'vitest';
import {
  buildEffectiveFilesOptions,
  buildFilesJsonRows,
  filterFilesForCli,
  parseFilesOutputOptions,
  renderFilesOutput,
} from '../src/features/files/runtime.js';
import { runFilesCommand, type FilesCommandDeps } from '../src/features/files/index.js';

const files = [
  { path: 'src/a.ts', language: 'typescript', nodeCount: 2, size: 10 },
  { path: 'src/nested/b.ts', language: 'typescript', nodeCount: 3, size: 20 },
  { path: 'README.md', language: 'markdown', nodeCount: 1, size: 5 },
];

function makeUnusedProgram(): FilesCommandDeps['program'] {
  let command: FilesCommandDeps['program'];
  command = {
    command() {
      return command;
    },
    description() {
      return command;
    },
    option() {
      return command;
    },
    action() {
      return command;
    },
  };
  return command;
}

function makeFilesCommandDeps(args: { initialized: boolean; projectPath: string }): {
  deps: FilesCommandDeps;
  errors: string[];
  lines: string[];
} {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    deps: {
      program: makeUnusedProgram(),
      error: (message) => errors.push(message),
      info: (message) => lines.push(`info:${message}`),
      resolveProjectPath: () => args.projectPath,
      loadCartograph: async () => ({
        default: {
          open: async (): Promise<never> => {
            throw new Error('open exploded');
          },
        },
      }),
      isInitialized: () => args.initialized,
      getAllFilesWithSymbolCount: () => files,
      getFileSummaries: () => new Map(),
      filterFilesByDir: testFilterFilesByDir,
      buildDirRollup: testBuildDirRollup,
      runViaMCP: async () => undefined,
      writeLine: (message = '') => lines.push(message),
    },
  };
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<void> {
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  let exitCalled = false;
  process.exitCode = 0;
  process.exit = (code?: string | number | null | undefined): never => {
    exitCalled = true;
    throw new Error(`process.exit(${String(code)})`);
  };
  try {
    await run();
    expect(exitCalled).toBe(false);
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode ?? 0;
  }
}

describe('files feature runtime', () => {
  it('normalizes positional dir and parses output options as values', () => {
    expect(buildEffectiveFilesOptions('src', {})).toEqual({ dir: 'src' });
    expect(buildEffectiveFilesOptions('src', { dir: 'test' })).toEqual({ dir: 'test' });
    expect(buildEffectiveFilesOptions('src/a.ts', { format: 'symbols' })).toEqual({
      format: 'symbols',
      file: 'src/a.ts',
    });
    expect(buildEffectiveFilesOptions('src/a.ts', { format: 'deps' })).toEqual({
      format: 'deps',
      file: 'src/a.ts',
    });
    expect(buildEffectiveFilesOptions('src', { format: 'module' })).toEqual({
      format: 'module',
      dirPath: 'src',
    });
    expect(parseFilesOutputOptions({ lowTokens: true })).toEqual({ ok: true, format: 'summary', maxDepth: 3 });
    expect(parseFilesOutputOptions({ format: 'flat', maxDepth: '2' })).toEqual({
      ok: true,
      format: 'flat',
      maxDepth: 2,
    });
    expect(parseFilesOutputOptions({ format: 'wide' })).toEqual({
      ok: false,
      error:
        'Invalid value for --format: "wide" — valid values: tree, flat, grouped, summary, symbols, deps, module, read',
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
      message: 'No files indexed. Run "cartograph index" first.',
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

describe('files feature CLI', () => {
  it('reports an uninitialized project without calling process.exit', async () => {
    const projectPath = '/tmp/cartograph-files-uninitialized';
    const { deps, errors } = makeFilesCommandDeps({ initialized: false, projectPath });

    await withProcessExitGuard(async () => {
      await runFilesCommand(deps, undefined, {});
      expect(process.exitCode).toBe(1);
    });

    expect(errors).toEqual([`Cartograph not initialized in ${projectPath}`]);
  });

  it('reports list failures without calling process.exit', async () => {
    const projectPath = '/tmp/cartograph-files-open-fails';
    const { deps, errors } = makeFilesCommandDeps({ initialized: true, projectPath });

    await withProcessExitGuard(async () => {
      await runFilesCommand(deps, undefined, {});
      expect(process.exitCode).toBe(1);
    });

    expect(errors).toEqual(['Failed to list files: open exploded']);
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
