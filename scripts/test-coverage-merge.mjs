#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const testDir = path.join(root, '__tests__');
const coverageDir = path.join(root, 'coverage');
const tmpRoot = path.join(coverageDir, '.tmp-coverage');
const timeoutMs = process.env.COVERAGE_TIMEOUT ?? '30000';
const jobs = Math.max(1, Number.parseInt(process.env.COVERAGE_JOBS ?? process.env.N ?? '4', 10) || 4);
const retries = Math.max(0, Number.parseInt(process.env.COVERAGE_RETRY ?? '2', 10) || 0);

function safeName(file, index) {
  return `${String(index).padStart(4, '0')}-${path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

async function listTests(dir = testDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => path.relative(root, path.join(dir, entry.name)));
  const nested = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => listTests(path.join(dir, entry.name))),
  );
  return [...files, ...nested.flat()].sort();
}

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function childEnv() {
  return {
    ...process.env,
    CARTOGRAPH_HOOKS_IN_PROCESS: envValue('CARTOGRAPH_HOOKS_IN_PROCESS', '1'),
    CARTOGRAPH_TRACK_CONSUMED_ARGS: envValue('CARTOGRAPH_TRACK_CONSUMED_ARGS', '1'),
    COVERAGE: envValue('COVERAGE', '1'),
  };
}

function runOne(file, index) {
  const outDir = path.join(tmpRoot, safeName(file, index));
  const args = [
    'test',
    '--coverage',
    '--coverage-reporter=lcov',
    `--coverage-dir=${outDir}`,
    '--reporter=dots',
    '--timeout',
    timeoutMs,
    file,
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bun', args, {
      cwd: root,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      resolve({
        file,
        outDir,
        code,
        signal,
        index,
        ms: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function runPool(files) {
  const failures = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      const result = await runOne(file, index);
      done++;
      if (result.code === 0) {
        process.stdout.write('.');
      } else {
        process.stdout.write('F');
        failures.push(result);
      }
      if (done % 50 === 0 || done === files.length) {
        process.stdout.write(` ${done}/${files.length}${os.EOL}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker()));
  process.stdout.write(os.EOL);
  return failures;
}

async function retryFailures(failures) {
  if (retries <= 0 || failures.length === 0) return failures;
  const stillFailing = [];
  process.stderr.write(
    `=== retrying ${failures.length} failed coverage file(s), up to ${retries} attempt(s) each ===\n`,
  );

  for (let index = 0; index < failures.length; index++) {
    const failure = failures[index];
    let last = failure;
    let passed = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await rm(failure.outDir, { recursive: true, force: true });
      const result = await runOne(failure.file, failure.index);
      last = result;
      if (result.code === 0) {
        process.stderr.write(`  -> ${failure.file} passed on attempt ${attempt}\n`);
        passed = true;
        break;
      }
    }
    if (!passed) stillFailing.push(last);
  }

  return stillFailing;
}

/** Parse ONE shard's lcov into a per-file `Map<line, hits>` map. Kept
 *  per-shard (not accumulated across shards) because we merge by picking the
 *  best shard per file, not by summing line hits — see {@link mergeLcov}. */
function parseShardLcov(text) {
  const perFile = new Map();
  for (const chunk of text.split('end_of_record')) {
    const sf = chunk.match(/^SF:(.*)$/m)?.[1];
    if (!sf) continue;
    let da = perFile.get(sf);
    if (!da) {
      da = new Map();
      perFile.set(sf, da);
    }
    for (const m of chunk.matchAll(/^DA:(\d+),(\d+)/gm)) {
      const line = Number(m[1]);
      da.set(line, (da.get(line) ?? 0) + Number(m[2]));
    }
  }
  return perFile;
}

function sourcePathForCoverageFile(sf) {
  if (path.isAbsolute(sf)) return sf;
  return path.join(root, sf);
}

function projectRelativePath(sf) {
  return path.relative(root, sourcePathForCoverageFile(sf)).split(path.sep).join('/');
}

function isProjectSourceRecord(sf) {
  return projectRelativePath(sf).startsWith('src/');
}

/** Hit-line count for a file's `Map<line, hits>` — how many distinct lines
 *  were executed at least once. Used to pick a file's best-covering shard. */
function hitLineCount(da) {
  let lh = 0;
  for (const hits of da.values()) if (hits > 0) lh++;
  return lh;
}

/**
 * Merge per-shard lcov into a single `coverage/lcov.info`.
 *
 * IMPORTANT — why we pick the best shard per file instead of summing per line:
 * each test file runs in its OWN bun process (the whole suite in one process
 * SIGBUS-crashes on this repo's native deps), and bun's coverage reports a
 * source file's line numbers INCONSISTENTLY across processes. A file's
 * dedicated test shard maps its lines correctly (e.g. name-matcher.ts:233 is
 * real code); a shard that only imports it transitively reports SHIFTED /
 * phantom line numbers (233's hit lands on a blank line). Summing hits per
 * (file, line) across 500+ shards therefore scatters real hits onto wrong /
 * blank lines and collapses coverage (we observed a true 90% read as 25%).
 *
 * So for each source file we keep the single shard with the most executed
 * lines — whose numbering is internally consistent — and emit its raw DA
 * records. This is slightly CONSERVATIVE (it ignores complementary coverage
 * when two tests exercise different halves of one file) but accurate and
 * stable, and Sonar does its own executable-line analysis on top. Paths are
 * normalised to project-relative so abs/relative SF spellings from different
 * shards dedupe to one record.
 */
async function mergeLcov(files) {
  const best = new Map(); // project-relative sf -> { lh, da: Map<line, hits> }
  const reads = await Promise.all(
    files.map(async (file) => {
      const lcovPath = path.join(file.outDir, 'lcov.info');
      try {
        return { text: await readFile(lcovPath, 'utf8'), skipped: false };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return { text: '', skipped: true };
        }
        throw new Error(
          `Failed reading coverage for ${file.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
  let skippedNoCoverage = 0;
  for (const read of reads) {
    if (read.skipped) {
      skippedNoCoverage++;
      continue;
    }
    for (const [rawSf, da] of parseShardLcov(read.text)) {
      if (!isProjectSourceRecord(rawSf)) continue;
      const sf = projectRelativePath(rawSf);
      const lh = hitLineCount(da);
      const current = best.get(sf);
      if (!current || lh > current.lh) best.set(sf, { lh, da });
    }
  }
  const lines = ['TN:'];
  let sourceFiles = 0;
  for (const [sf, { da, lh }] of [...best.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sourceFiles++;
    lines.push(`SF:${sf}`);
    for (const [line, hits] of [...da.entries()].sort(([a], [b]) => a - b)) {
      lines.push(`DA:${line},${hits}`);
    }
    lines.push(`LF:${da.size}`);
    lines.push(`LH:${lh}`);
    lines.push('end_of_record');
  }
  await mkdir(coverageDir, { recursive: true });
  await writeFile(path.join(coverageDir, 'lcov.info'), `${lines.join(os.EOL)}${os.EOL}`);
  return { files: sourceFiles, skippedNoCoverage };
}

const tests = await listTests();
if (tests.length === 0) {
  console.error('No __tests__/**/*.test.ts files found.');
  process.exit(1);
}

await rm(tmpRoot, { recursive: true, force: true });
await mkdir(tmpRoot, { recursive: true });
console.log(`=== coverage: ${tests.length} files, ${jobs} workers ===`);
let failures = await runPool(tests);
failures = await retryFailures(failures);

// Merge whatever coverage we collected FIRST, so a flaky / crashing test can
// never block the report. A failed shard simply contributes no records (its
// file falls back to a passing shard, or reads as uncovered) — it cannot zero
// out `coverage/lcov.info`. Failures are surfaced AFTER the merge, below.
const merged = await mergeLcov(
  tests.map((file, index) => ({ file, outDir: path.join(tmpRoot, safeName(file, index)) })),
);
await rm(tmpRoot, { recursive: true, force: true });
const skipped = merged.skippedNoCoverage > 0 ? ` (${merged.skippedNoCoverage} test files had no LCOV records)` : '';
console.log(`=== coverage merged: ${merged.files} source files -> coverage/lcov.info${skipped} ===`);

if (failures.length > 0) {
  console.error(`=== ${failures.length} coverage test file(s) failed (coverage/lcov.info was still written) ===`);
  for (const failure of failures.slice(0, 20)) {
    console.error(`--- ${failure.file} (${failure.code ?? failure.signal}) ---`);
    const combined = `${failure.stdout}${failure.stderr}`.trim();
    console.error(combined.split('\n').slice(-120).join('\n'));
  }
  // Surface failures with a non-zero exit by default so a real regression is
  // never masked. Set COVERAGE_ALLOW_TEST_FAILURES=1 to still exit 0 once the
  // coverage report is written — for when a known-flaky spawned test must not
  // block a coverage / Sonar run.
  if (process.env.COVERAGE_ALLOW_TEST_FAILURES === '1') {
    console.error('=== COVERAGE_ALLOW_TEST_FAILURES=1 — exiting 0 despite the failure(s) above ===');
  } else {
    process.exit(1);
  }
}
