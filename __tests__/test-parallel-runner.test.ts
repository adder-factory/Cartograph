import { execFileSync } from 'node:child_process';
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
});
