import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dir, '..');

function extractFailedFiles(log: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-test-parallel-runner-'));
  const logPath = path.join(dir, 'shard.log');
  try {
    fs.writeFileSync(logPath, log);
    const output = execFileSync('bash', ['scripts/test-parallel.sh', logPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TEST_PARALLEL_EXTRACT_FAILED_FILES: '1' },
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type NativeCrashMode = 'transient-shard-crash' | 'repeated-shard-crash' | 'file-fail-then-pass' | 'repeated-file-crash';

interface NativeCrashRun {
  readonly invocations: string;
  readonly status: number | null;
  readonly stdout: string;
}

function runNativeCrashRecovery(mode: NativeCrashMode, retry: number): NativeCrashRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-test-parallel-native-crash-'));
  const binDir = path.join(dir, 'bin');
  const fixtureDir = path.join(dir, 'fixtures');
  const stateDir = path.join(dir, 'state');
  const invocationLog = path.join(dir, 'invocations.log');
  fs.mkdirSync(binDir);
  fs.mkdirSync(fixtureDir);
  fs.mkdirSync(stateDir);
  for (const name of ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']) {
    fs.writeFileSync(path.join(fixtureDir, name), '// fake test file\n');
  }
  const fakeBun = path.join(binDir, 'bun');
  fs.writeFileSync(
    fakeBun,
    [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> '${invocationLog}'`,
      'case " $* " in',
      '  *" --shard=1/2 "*)',
      '    state="$FAKE_BUN_STATE/shard-1-attempted"',
      '    if [[ "$FAKE_BUN_MODE" = "transient-shard-crash" && ! -f "$state" ]]; then',
      '      : > "$state"',
      '      exit 133',
      '    fi',
      '    if [[ "$FAKE_BUN_MODE" != "transient-shard-crash" ]]; then exit 133; fi',
      "    printf ' 2 pass\\n 0 fail\\nRan 2 tests across 2 files. [1ms]\\n'",
      '    exit 0',
      '    ;;',
      '  *" --shard=2/2 "*)',
      "    printf ' 2 pass\\n 0 fail\\nRan 2 tests across 2 files. [1ms]\\n'",
      '    exit 0',
      '    ;;',
      'esac',
      'file="${@: -1}"',
      'if [[ "$FAKE_BUN_MODE" = "file-fail-then-pass" && "$file" = */a.test.ts ]]; then',
      '  state="$FAKE_BUN_STATE/a-attempted"',
      '  if [ ! -f "$state" ]; then',
      '    : > "$state"',
      '    printf \'%s:\\n(fail) fixture > first attempt fails\\n\\n 0 pass\\n 1 fail\\nRan 1 test across 1 file. [1ms]\\n\' "$file"',
      '    exit 1',
      '  fi',
      'fi',
      'if [[ "$FAKE_BUN_MODE" = "repeated-file-crash" && "$file" = */a.test.ts ]]; then',
      '  exit 139',
      'fi',
      'printf "%s:\\n(pass) fixture > passes\\n\\n 1 pass\\n 0 fail\\nRan 1 test across 1 file. [1ms]\\n" "$file"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeBun, 0o755);

  try {
    const run = spawnSync('bash', ['scripts/test-parallel.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_BUN_MODE: mode,
        FAKE_BUN_STATE: stateDir,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        N: '2',
        RETRY: String(retry),
        SHARD_PATTERN: `${fixtureDir}/*.test.ts`,
        FLAKE_LOG: path.join(dir, 'flake.log'),
        TMPDIR: path.join(dir, 'tmp'),
      },
    });
    return {
      invocations: fs.readFileSync(invocationLog, 'utf8'),
      status: run.status,
      stdout: run.stdout,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('test-parallel failed-file extraction', () => {
  it('selects only files with bun fail records, not every noisy file header', () => {
    const failed = extractFailedFiles(`
__tests__/biomarker-worker-parity.test.ts:
(pass) biomarker worker parity > stays aligned [1.00ms]

__tests__/file-grain.test.ts:
[postHook] group A indexAll: starting (4 hooks)
(pass) file grain > indexes files [2.00ms]

__tests__/readme-drift.test.ts:
error: package.json files is missing README-displayed image docs/assets/viewer-system.png
Expected: true
Received: false
(fail) README drift guard > ships README-linked docs and assets in the package allowlist [0.29ms]

 849 pass
 1 fail
Ran 850 tests across 65 files. [74.89s]
`);

    expect(failed).toEqual(['__tests__/readme-drift.test.ts']);
  });

  it('returns no files for process-level logs without bun fail records', () => {
    const failed = extractFailedFiles(`
__tests__/some-noisy-file.test.ts:
(pass) noisy file > still passed [1.00ms]
`);

    expect(failed).toEqual([]);
  });

  it('ignores bun final failure-summary records after the last file header', () => {
    const failed = extractFailedFiles(`
__tests__/review-neighbors.test.ts:
Expected substring or pattern: /alpha/i
Received: "Found 1 changed symbol(s) with embeddings, but no semantic neighbors above threshold."
(fail) cartograph_review_neighbors > resolves a symbol name [90.93ms]

__tests__/sqlite-vec.test.ts:
RangeError: Cannot use a closed database
(fail) vec-helpers > bootstrapVecTables creates a vec0 table [9.97ms]

__tests__/viewer.test.ts:
(pass) viewer HTTP server > streams an in-process re-index as Server-Sent Events [374.96ms]

14 tests failed:
(fail) cartograph_review_neighbors > resolves a symbol name [90.93ms]
(fail) vec-helpers > bootstrapVecTables creates a vec0 table [9.97ms]

 1080 pass
 14 fail
Ran 1094 tests across 66 files. [43.68s]
`);

    expect(failed).toEqual(['__tests__/review-neighbors.test.ts', '__tests__/sqlite-vec.test.ts']);
  });

  it('recovers a transient process crash only after the same shard passes', () => {
    const run = runNativeCrashRecovery('transient-shard-crash', 1);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('retrying the same shard');
    expect(run.stdout).toContain('shard 1 passed as a whole on attempt 1');
    expect(run.stdout).toContain('pass: 4   fail: 0');
    expect(run.invocations.match(/--shard=1\/2/g)).toHaveLength(2);
    expect(
      run.invocations.split('\n').filter((invocation) => invocation.length > 0 && !invocation.includes('--shard=')),
    ).toEqual([]);
  });

  it('keeps a repeatable shard crash red even when every file passes alone', () => {
    const run = runNativeCrashRecovery('repeated-shard-crash', 1);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('shard 1 still crashed after 1 same-shard retry');
    expect(run.stdout).toContain('file-grain diagnosis: all 2 files passed alone');
    expect(run.stdout).toContain('pass: 4   fail: 1');
    expect(run.invocations.match(/--shard=1\/2/g)).toHaveLength(2);
    expect(run.invocations).toContain('/a.test.ts');
    expect(run.invocations).toContain('/c.test.ts');
  });

  it('counts only the final diagnostic attempt when a file fails once and then passes', () => {
    const run = runNativeCrashRecovery('file-fail-then-pass', 2);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('pass: 4   fail: 1');
    expect(run.stdout).not.toContain('pass: 5');
  });

  it('counts a repeatedly crashing file as failed even when Bun prints no summary', () => {
    const run = runNativeCrashRecovery('repeated-file-crash', 2);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('pass: 3   fail: 1');
    expect(run.stdout).not.toContain('fail: 0');
  });
});
