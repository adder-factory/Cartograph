import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  attachUnknownActionHandler,
  assignFloatArg,
  assignIntArg,
  createVerboseProgress,
  error,
  formatDuration,
  formatNumber,
  info,
  installFamilyActionAlias,
  printIndexResult,
  resolveProjectPath,
  runViaMCPCapture,
  success,
  warn,
  writeErrorLog,
  type IndexResult,
} from '../src/bin/_cli-core.js';

function captureStdout(fn: () => void): string {
  let out = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

function captureConsoleError(fn: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

function captureConsoleLog(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function fakeClack() {
  const calls: Array<[string, string, string?]> = [];
  return {
    calls,
    log: {
      success: (message: string) => calls.push(['success', message]),
      info: (message: string) => calls.push(['info', message]),
      warn: (message: string) => calls.push(['warn', message]),
      error: (message: string) => calls.push(['error', message]),
    },
    note: (message: string, title?: string) => calls.push(['note', message, title]),
  };
}

function indexResult(overrides: Partial<IndexResult>): IndexResult {
  return {
    success: true,
    filesIndexed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    errors: [],
    durationMs: 0,
    ...overrides,
  };
}

describe('CLI core contracts', () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('formats numbers and durations for user-facing progress output', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });

  it('prints styled success, info, and warning messages', () => {
    const out = captureConsoleLog(() => {
      success('indexed');
      info('ready');
      warn('stale');
    });
    expect(out).toContain('indexed');
    expect(out).toContain('ready');
    expect(out).toContain('stale');
    expect(out).toContain('✓');
    expect(out).toContain('ℹ');
    expect(out).toContain('⚠');
  });

  it('resolves nested paths to the nearest initialized Cartograph project', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-resolve-'));
    const child = path.join(projectRoot, 'src', 'feature');
    fs.mkdirSync(path.join(projectRoot, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.cartograph', 'cartograph.db'), '');
    fs.mkdirSync(child, { recursive: true });
    try {
      expect(resolveProjectPath(child)).toBe(projectRoot);
      expect(resolveProjectPath(projectRoot)).toBe(projectRoot);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns the absolute input path when no initialized project exists above it', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-unresolved-'));
    const child = path.join(projectRoot, 'src', 'feature');
    fs.mkdirSync(child, { recursive: true });
    try {
      expect(resolveProjectPath(child)).toBe(path.resolve(child));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a styled uninitialized result without opening Cartograph for MCP capture', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-uninit-'));
    try {
      const result = await runViaMCPCapture('cartograph_node', { symbol: 'Missing' }, projectRoot);
      expect(result.exitCode).toBe(1);
      expect(result.text).toContain('Cartograph not initialized');
      expect(result.contentDriftedFiles).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates integer CLI options before assigning MCP args', () => {
    const args: Record<string, unknown> = {};
    expect(assignIntArg({ args, key: 'limit', raw: undefined, optionName: '--limit' })).toBe(true);
    expect(args).toEqual({});
    expect(assignIntArg({ args, key: 'limit', raw: '12', optionName: '--limit', opts: { min: 1, max: 20 } })).toBe(
      true,
    );
    expect(args['limit']).toBe(12);

    const stderr = captureConsoleError(() => {
      expect(assignIntArg({ args, key: 'limit', raw: '12abc', optionName: '--limit' })).toBe(false);
    });
    expect(stderr).toContain('Invalid value for --limit');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects integer CLI options that are empty no-ops, fractional, too small, or too large', () => {
    const args: Record<string, unknown> = {};
    expect(assignIntArg({ args, key: 'limit', raw: '', optionName: '--limit' })).toBe(true);
    expect(args).toEqual({});

    const fractional = captureConsoleError(() => {
      expect(assignIntArg({ args, key: 'limit', raw: '1.5', optionName: '--limit' })).toBe(false);
    });
    expect(fractional).toContain('is not an integer');
    process.exitCode = 0;

    const tooSmall = captureConsoleError(() => {
      expect(assignIntArg({ args, key: 'limit', raw: '0', optionName: '--limit', opts: { min: 1 } })).toBe(false);
    });
    expect(tooSmall).toContain('must be >= 1');
    process.exitCode = 0;

    const tooLarge = captureConsoleError(() => {
      expect(assignIntArg({ args, key: 'limit', raw: '11', optionName: '--limit', opts: { max: 10 } })).toBe(false);
    });
    expect(tooLarge).toContain('must be <= 10');
  });

  it('validates float CLI options and rejects out-of-range values', () => {
    const args: Record<string, unknown> = {};
    expect(
      assignFloatArg({ args, key: 'minScore', raw: '0.75', optionName: '--min-score', opts: { min: 0, max: 1 } }),
    ).toBe(true);
    expect(args['minScore']).toBe(0.75);

    const stderr = captureConsoleError(() => {
      expect(assignFloatArg({ args, key: 'minScore', raw: '1.5', optionName: '--min-score', opts: { max: 1 } })).toBe(
        false,
      );
    });
    expect(stderr).toContain('must be <= 1');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects invalid and too-small float CLI options', () => {
    const args: Record<string, unknown> = {};
    const invalid = captureConsoleError(() => {
      expect(assignFloatArg({ args, key: 'score', raw: '0.5x', optionName: '--score' })).toBe(false);
    });
    expect(invalid).toContain('is not a number');
    process.exitCode = 0;

    const tooSmall = captureConsoleError(() => {
      expect(assignFloatArg({ args, key: 'score', raw: '-0.1', optionName: '--score', opts: { min: 0 } })).toBe(
        false,
      );
    });
    expect(tooSmall).toContain('must be >= 0');
  });

  it('prints styled error messages to stderr', () => {
    const stderr = captureConsoleError(() => error('failed'));
    expect(stderr).toContain('✗');
    expect(stderr).toContain('failed');
  });

  it('prints verbose progress only on phase changes, useful percentage steps, and scan cadence', () => {
    const progress = createVerboseProgress();
    const out = captureStdout(() => {
      progress({ phase: 'scan', current: 1, total: 0 });
      progress({ phase: 'scan', current: 999, total: 0 });
      progress({ phase: 'scan', current: 1000, total: 0 });
      progress({ phase: 'parse', current: 5, total: 100, currentFile: 'src/a.ts' });
      progress({ phase: 'parse', current: 6, total: 100, currentFile: 'src/b.ts' });
      progress({ phase: 'parse', current: 10, total: 100, currentFile: 'src/c.ts' });
      progress({ phase: 'parse', current: 100, total: 100 });
    });

    expect(out).toContain('Phase: scan');
    expect(out).toContain('1 files found');
    expect(out).toContain('1,000 files found');
    expect(out).toContain('Phase: parse');
    expect(out).toContain('5/100 (5%)');
    expect(out).not.toContain('6/100 (6%)');
    expect(out).toContain('10/100 (10%)');
    expect(out).toContain('100/100 (100%)');
  });

  it('writes error logs with file buckets, no-file entries, and warning counts', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-core-'));
    fs.mkdirSync(path.join(projectRoot, '.cartograph'), { recursive: true });
    try {
      writeErrorLog(projectRoot, [
        { severity: 'error', filePath: 'src/a.ts', message: 'parse failed', code: 'parse_error' },
        { severity: 'warning', filePath: 'src/b.ts', message: 'too large', code: 'size_exceeded' },
        { severity: 'error', message: 'lock failed', code: 'store_error' },
      ]);
      const log = fs.readFileSync(path.join(projectRoot, '.cartograph', 'errors.log'), 'utf-8');
      expect(log).toContain('2 files with issues (2 errors, 1 warning)');
      expect(log).toContain('src/a.ts: parse failed');
      expect(log).toContain('src/b.ts: too large');
      expect(log).toContain('lock failed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('skips writing error logs when the project metadata directory is absent', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-no-log-'));
    try {
      writeErrorLog(projectRoot, [{ severity: 'info', message: 'ignored' }]);
      expect(fs.existsSync(path.join(projectRoot, '.cartograph', 'errors.log'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('prints index result breakdowns and clears stale logs on clean runs', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-index-'));
    fs.mkdirSync(path.join(projectRoot, '.cartograph'), { recursive: true });
    const logPath = path.join(projectRoot, '.cartograph', 'errors.log');
    try {
      const clack = fakeClack();
      printIndexResult(
        clack as unknown as typeof import('@clack/prompts'),
        indexResult({
          success: true,
          filesIndexed: 2,
          filesErrored: 1,
          nodesCreated: 10,
          edgesCreated: 4,
          durationMs: 1250,
          errors: [{ severity: 'error', filePath: 'src/a.ts', message: 'parse failed', code: 'parse_error' }],
        }),
        projectRoot,
      );
      expect(clack.calls).toContainEqual(['success', 'Indexed 2 files (1 could not be parsed)']);
      expect(
        clack.calls.some(([kind, message]) => kind === 'note' && message.includes('1 files failed to parse')),
      ).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);

      printIndexResult(
        fakeClack() as unknown as typeof import('@clack/prompts'),
        indexResult({ success: true, filesIndexed: 1, nodesCreated: 1, edgesCreated: 0, durationMs: 5 }),
        projectRoot,
      );
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('prints lock failures, empty indexes, all-error indexes, and size-skip logs', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-index-branches-'));
    fs.mkdirSync(path.join(projectRoot, '.cartograph'), { recursive: true });
    try {
      const lock = fakeClack();
      printIndexResult(
        lock as unknown as typeof import('@clack/prompts'),
        indexResult({
          success: false,
          errors: [{ severity: 'error', message: 'database is locked', code: 'store_error' }],
        }),
        projectRoot,
      );
      expect(lock.calls).toContainEqual(['error', 'database is locked']);

      const empty = fakeClack();
      printIndexResult(empty as unknown as typeof import('@clack/prompts'), indexResult({ success: true }), projectRoot);
      expect(empty.calls).toContainEqual(['warn', 'No files found to index']);

      const allErrored = fakeClack();
      printIndexResult(
        allErrored as unknown as typeof import('@clack/prompts'),
        indexResult({
          success: false,
          filesErrored: 2,
          errors: [
            { severity: 'error', filePath: 'src/a.ts', message: 'parse', code: 'parse_error' },
            { severity: 'error', filePath: 'src/b.ts', message: 'store', code: 'store_error' },
          ],
        }),
        projectRoot,
      );
      expect(allErrored.calls).toContainEqual(['error', 'Indexing failed — all 2 files had errors']);
      expect(allErrored.calls.some(([kind, message]) => kind === 'note' && message.includes('DB contention'))).toBe(
        true,
      );

      const sizeSkipped = fakeClack();
      printIndexResult(
        sizeSkipped as unknown as typeof import('@clack/prompts'),
        indexResult({
          success: true,
          filesSkipped: 1,
          errors: [{ severity: 'warning', filePath: 'large.js', message: 'too large', code: 'size_exceeded' }],
        }),
        projectRoot,
      );
      expect(sizeSkipped.calls.some(([kind, message]) => kind === 'warn' && message.includes('maxFileSize'))).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(projectRoot, '.cartograph', 'errors.log'), 'utf-8')).toContain(
        'large.js: too large',
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rewrites family --action aliases into canonical subcommand argv shape', () => {
    const originalArgv = process.argv;
    try {
      process.argv = ['bun', 'cartograph', 'summaries', '--action', 'pending', '--json'];
      installFamilyActionAlias(new Command('summaries'), 'summaries', 'action');
      expect(process.argv).toEqual(['bun', 'cartograph', 'summaries', 'pending', '--json']);

      process.argv = ['bun', 'cartograph', 'review', '--mode=risk', '--json'];
      installFamilyActionAlias(new Command('review'), 'review', 'mode');
      expect(process.argv).toEqual(['bun', 'cartograph', 'review', 'risk', '--json']);

      process.argv = ['bun', 'cartograph', 'review', 'context', '--json'];
      installFamilyActionAlias(new Command('review'), 'review', 'mode');
      expect(process.argv).toEqual(['bun', 'cartograph', 'review', 'context', '--json']);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('prints a styled unknown family action and exits with code 1', () => {
    const group = new Command('session');
    group.command('list');
    group.command('delete');
    attachUnknownActionHandler(group, 'session');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    const stderr = captureConsoleError(() => {
      expect(() => group.emit('command:*', ['bogus'])).toThrow('exit:1');
    });
    expect(stderr).toContain("Unknown session action 'bogus'");
    expect(stderr).toContain('list, delete');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
