import { describe, expect, it } from 'vitest';
import { handleAffectedCommand, type AffectedCommandDeps } from '../src/features/affected/index.js';
import {
  buildAffectedFilter,
  collectExplicitChangedFiles,
  parseAffectedDepth,
  parseStdinFileList,
  renderAffectedOutput,
  renderNoDerivedChanges,
  validateAffectedIndexedPaths,
} from '../src/features/affected/runtime.js';

describe('affected feature runtime', () => {
  it('normalizes explicit changed files and stdin lists', () => {
    expect(parseStdinFileList(' src/a.ts\n\nsrc/b.ts\n')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(
      collectExplicitChangedFiles({
        fileArgs: ['src/a.ts'],
        optionFiles: ['src/b.ts'],
        stdinFiles: ['src/c.ts'],
        stdinRequested: true,
      }),
    ).toEqual({ changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], derivedFromGit: false });
    expect(collectExplicitChangedFiles({ fileArgs: [] })).toBeNull();
  });

  it('returns validation failures as values', () => {
    expect(parseAffectedDepth({ depth: '2' })).toEqual({ ok: true, depth: 2 });
    expect(parseAffectedDepth({ depth: 'abc' })).toEqual({
      ok: false,
      error: 'Invalid value for --depth: "abc" is not a number',
    });

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
        derivedFromGit: false,
        allIndexedPaths: new Set<string>(),
      }),
    ).toEqual({ ok: false, error: 'None of the 1 input file match indexed paths: missing.ts' });
  });

  it('renders affected output surfaces', () => {
    const filter = buildAffectedFilter('src/*.ts');
    expect(filter?.test('src/a.ts')).toBe(true);

    const output = renderAffectedOutput({
      changedFiles: ['src/a.ts'],
      sortedTests: ['__tests__/a.test.ts'],
      candidates: [
        {
          path: '__tests__/a.test.ts',
          tier: 'direct',
          distance: 1,
          reason: 'direct-dependent',
        },
      ],
      totalDependents: 1,
      barrelsReached: ['src/index.ts'],
      derivedFromGit: true,
      projectPath: '/repo',
      options: {},
    }).join('\n');
    expect(output).toContain('Changed set derived from `git diff HEAD`');
    expect(output).toContain('Affected test files (1)');
    expect(output).toContain('Traversal reached the public-API barrel');

    expect(JSON.parse(renderNoDerivedChanges({ json: true })[0]!)).toMatchObject({
      changedFiles: [],
      affectedTests: [],
    });
  });
});

describe('affected feature CLI', () => {
  it('reports an uninitialized project without calling process.exit or opening the graph', async () => {
    const { deps, errors, calls } = makeAffectedCommandDeps({ initialized: false });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand(['src/a.ts'], {}, deps);
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Cartograph not initialized in /repo']);
    expect(calls).not.toContain('open:/repo');
  });

  it('handles an explicit empty stdin file list without calling process.exit or opening the graph', async () => {
    const { deps, infos, calls } = makeAffectedCommandDeps({ stdinText: '' });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand([], { stdin: true }, deps);
    });

    expect(exitCode ?? 0).toBe(0);
    expect(infos).toEqual(['No files provided. Use file arguments or --stdin.']);
    expect(calls).not.toContain('open:/repo');
  });

  it('handles unavailable git-derived changes without calling process.exit or opening the graph', async () => {
    const { deps, infos, calls } = makeAffectedCommandDeps({ gitChangedFiles: null });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand([], {}, deps);
    });

    expect(exitCode ?? 0).toBe(0);
    expect(infos).toEqual([
      'No files provided and could not derive from git (git unavailable or no HEAD ref).',
      'Use file arguments or --stdin.',
    ]);
    expect(calls).not.toContain('open:/repo');
  });

  it('handles no git-derived changes without calling process.exit or opening the graph', async () => {
    const { deps, lines, calls } = makeAffectedCommandDeps({ gitChangedFiles: [] });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand([], { json: true }, deps);
    });

    expect(exitCode ?? 0).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ changedFiles: [], affectedTests: [] });
    expect(calls).not.toContain('open:/repo');
  });

  it('reports non-indexed explicit inputs without calling process.exit and closes the graph', async () => {
    const { deps, errors, calls } = makeAffectedCommandDeps({
      indexedPaths: new Set<string>(),
      affectedTests: new Set<string>(),
    });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand(['missing.ts'], {}, deps);
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['None of the 1 input file match indexed paths: missing.ts']);
    expect(calls).toEqual(['open:/repo', 'close']);
  });

  it('reports analysis failures without calling process.exit', async () => {
    const { deps, errors, calls } = makeAffectedCommandDeps({ openError: new Error('open exploded') });

    const exitCode = await withProcessExitGuard(async () => {
      await handleAffectedCommand(['src/a.ts'], {}, deps);
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Affected analysis failed: open exploded']);
    expect(calls).toEqual(['open:/repo']);
  });
});

interface MakeAffectedCommandDepsOptions {
  initialized?: boolean;
  stdinText?: string;
  gitChangedFiles?: string[] | null;
  indexedPaths?: Set<string>;
  affectedTests?: Set<string>;
  openError?: Error;
}

function makeUnusedProgram(): AffectedCommandDeps['program'] {
  let command: AffectedCommandDeps['program'];
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

function makeAffectedCommandDeps(options: MakeAffectedCommandDepsOptions = {}): {
  deps: AffectedCommandDeps;
  errors: string[];
  infos: string[];
  lines: string[];
  calls: string[];
} {
  const errors: string[] = [];
  const infos: string[] = [];
  const lines: string[] = [];
  const calls: string[] = [];
  const indexedPaths = options.indexedPaths ?? new Set(['src/a.ts', '__tests__/a.test.ts']);
  const affectedTests = options.affectedTests ?? new Set(['__tests__/a.test.ts']);
  const candidates = [...affectedTests].map((testPath) => ({
    path: testPath,
    tier: 'direct' as const,
    distance: 1,
    reason: 'direct-dependent' as const,
  }));
  const fakeGraph = {
    queries: {},
    internals: { graphManager: {} },
    close: () => calls.push('close'),
  };

  return {
    errors,
    infos,
    lines,
    calls,
    deps: {
      program: makeUnusedProgram(),
      error: (message) => errors.push(message),
      info: (message) => infos.push(message),
      resolveProjectPath: () => '/repo',
      loadCartograph: async () => ({
        default: {
          open: async (projectPath) => {
            calls.push(`open:${projectPath}`);
            if (options.openError) throw options.openError;
            return fakeGraph;
          },
        },
      }),
      isInitialized: () => options.initialized ?? true,
      buildIndexedPathSets: () => ({
        allIndexedPaths: indexedPaths,
        isTestByIndex: new Set(['__tests__/a.test.ts']),
        filesWithTestCases: new Set(['__tests__/a.test.ts']),
      }),
      findAffectedTests: () => ({
        affectedTests,
        candidates,
        totalDependents: affectedTests.size,
        barrelsReached: [],
      }),
      loadGitUtils: async () => ({
        listChangedFilesSince: () => (options.gitChangedFiles === undefined ? ['src/a.ts'] : options.gitChangedFiles),
      }),
      readStdin: () => options.stdinText ?? '',
      packageDeps: {
        detectPackageManager: () => 'npm',
        readPackageScripts: () => ({}),
        packageScriptCommand: (_manager, script, args) =>
          args && args.length > 0 ? `npm run ${script} -- ${args.join(' ')}` : `npm run ${script}`,
      },
      writeLine: (message = '') => lines.push(message),
    },
  };
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<string | number | undefined> {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const originalExit = process.exit;
  process.exit = (code?: string | number | null | undefined): never => {
    throw new Error(`process.exit(${String(code)})`);
  };
  try {
    await run();
    return process.exitCode;
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode ?? 0;
  }
}
