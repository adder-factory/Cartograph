import { describe, expect, it } from 'vitest';
import { resolveDiffOption } from '../src/features/at-range/cli.js';
import { buildAtRangeMcpArgs, parseRangeSpecs } from '../src/features/at-range/runtime.js';

describe('at-range feature runtime', () => {
  it('builds positional, ranges, and diff payloads', () => {
    expect(
      buildAtRangeMcpArgs({
        file: 'src/a.ts',
        startLine: '1',
        endLine: '3',
        options: { limit: '4', compact: true, lowTokens: true, fields: 'name,path' },
      }),
    ).toEqual({
      ok: true,
      args: {
        file: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        limit: 4,
        compact: true,
        lowTokens: true,
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

    expect(
      buildAtRangeMcpArgs({
        file: undefined,
        startLine: undefined,
        endLine: undefined,
        options: { diff: 'inline' },
        diffText: '@@ -1 +1 @@\n-old\n+new',
      }),
    ).toEqual({ ok: true, args: { limit: 20, diff: '@@ -1 +1 @@\n-old\n+new' } });
  });

  it('returns validation failures as values', () => {
    expect(parseRangeSpecs('bad')).toEqual({
      ok: false,
      error: "Invalid --ranges spec 'bad' — expected 'file:startLine-endLine'.",
    });
    expect(parseRangeSpecs('src/a.ts:1e2-3')).toEqual({
      ok: false,
      error: "Invalid --ranges spec 'src/a.ts:1e2-3' — expected 'file:startLine-endLine'.",
    });
    expect(
      buildAtRangeMcpArgs({
        file: 'src/a.ts',
        startLine: '1',
        endLine: '2',
        options: { limit: '2x' },
      }),
    ).toEqual({ ok: false, error: 'Invalid value for --limit: "2x" is not an integer' });
    expect(
      buildAtRangeMcpArgs({
        file: 'src/a.ts',
        startLine: '1e2',
        endLine: '2',
        options: {},
      }),
    ).toEqual({ ok: false, error: 'startLine and endLine must be numbers.' });
    expect(
      buildAtRangeMcpArgs({
        file: 'src/a.ts',
        startLine: '1',
        endLine: '2',
        options: { diff: 'x' },
      }),
    ).toEqual({ ok: false, error: '--diff is mutually exclusive with positional file/startLine/endLine.' });
    expect(
      buildAtRangeMcpArgs({
        file: undefined,
        startLine: undefined,
        endLine: undefined,
        options: {},
      }),
    ).toEqual({
      ok: false,
      error: 'Pass <file> <startLine> <endLine> positionally OR use --diff <pathOrText|-> OR --ranges <list>.',
    });
  });

  it('resolves stdin, inline, file, and fallback diff inputs', async () => {
    const warnings: string[] = [];
    await expect(
      resolveDiffOption('-', { warn: (message) => warnings.push(message), readStdin: async () => 'stdin' }),
    ).resolves.toBe('stdin');
    await expect(resolveDiffOption('@@ -1 +1 @@', { warn: (message) => warnings.push(message) })).resolves.toBe(
      '@@ -1 +1 @@',
    );
    await expect(
      resolveDiffOption('change.diff', {
        warn: (message) => warnings.push(message),
        fileExists: async () => true,
        readFile: async () => 'file diff',
      }),
    ).resolves.toBe('file diff');
    await expect(
      resolveDiffOption('missing.diff', {
        warn: (message) => warnings.push(message),
        fileExists: async () => false,
      }),
    ).resolves.toBe('missing.diff');
    expect(warnings.at(-1)).toContain('missing.diff');
  });
});
