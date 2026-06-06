import { describe, expect, it } from 'vitest';
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
