#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const testDir = path.join(root, '__tests__');
const coverageDir = path.join(root, 'coverage');
const tmpRoot = path.join(coverageDir, '.tmp-coverage');
const timeoutMs = process.env.COVERAGE_TIMEOUT ?? '30000';
const jobs = Math.max(1, Number.parseInt(process.env.COVERAGE_JOBS ?? process.env.N ?? '4', 10) || 4);

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

function parseLcov(text, records) {
  for (const chunk of text.split('end_of_record')) {
    const sf = chunk.match(/^SF:(.*)$/m)?.[1];
    if (!sf) continue;
    let file = records.get(sf);
    if (!file) {
      file = new Map();
      records.set(sf, file);
    }
    for (const m of chunk.matchAll(/^DA:(\d+),(\d+)/gm)) {
      const line = Number(m[1]);
      const hits = Number(m[2]);
      file.set(line, (file.get(line) ?? 0) + hits);
    }
  }
}

const relevantLineCache = new Map();
const sourceLineLimitCache = new Map();

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

function lineCoverageSource(sf) {
  const sourcePath = sourcePathForCoverageFile(sf);
  if (!existsSync(sourcePath)) return null;
  if (!/\.[cm]?tsx?$/.test(sourcePath)) return null;
  return { sourcePath, text: readFileSync(sourcePath, 'utf8') };
}

function sourceLineLimit(sf) {
  if (sourceLineLimitCache.has(sf)) return sourceLineLimitCache.get(sf);
  const sourcePath = sourcePathForCoverageFile(sf);
  if (!existsSync(sourcePath)) {
    sourceLineLimitCache.set(sf, null);
    return null;
  }
  const lineLimit = readFileSync(sourcePath, 'utf8').split(/\r\n|\r|\n/).length;
  sourceLineLimitCache.set(sf, lineLimit);
  return lineLimit;
}

function scannerContext(text) {
  const lines = text.split(/\r?\n/);
  return {
    code: Array.from({ length: lines.length }, () => ''),
    escaped: false,
    line: 0,
    state: 'code',
  };
}

function pushCode(ctx, ch) {
  ctx.code[ctx.line] += ch;
}

function scannerNewline(ctx) {
  ctx.line++;
  ctx.escaped = false;
  if (ctx.state === 'line-comment') ctx.state = 'code';
}

function handleCodeChar(ctx, ch, next) {
  if (ch === '/' && next === '/') {
    ctx.state = 'line-comment';
    return 1;
  }
  if (ch === '/' && next === '*') {
    ctx.state = 'block-comment';
    return 1;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    pushCode(ctx, ch);
    ctx.state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
    ctx.escaped = false;
    return 0;
  }
  pushCode(ctx, ch);
  return 0;
}

function handleQuotedChar(ctx, ch, quote) {
  if (ctx.escaped) {
    ctx.escaped = false;
    return;
  }
  if (ch === '\\') {
    ctx.escaped = true;
    return;
  }
  if (ch === quote) {
    pushCode(ctx, ch);
    ctx.state = 'code';
  }
}

function handleBlockCommentChar(ctx, ch, next) {
  if (ch !== '*' || next !== '/') return 0;
  ctx.state = 'code';
  return 1;
}

function scanCoverageChar(ctx, ch, next) {
  if (ctx.state === 'code') return handleCodeChar(ctx, ch, next);
  if (ctx.state === 'single') {
    handleQuotedChar(ctx, ch, "'");
    return 0;
  }
  if (ctx.state === 'double') {
    handleQuotedChar(ctx, ch, '"');
    return 0;
  }
  if (ctx.state === 'template') {
    handleQuotedChar(ctx, ch, '`');
    return 0;
  }
  if (ctx.state === 'block-comment') return handleBlockCommentChar(ctx, ch, next);
  return 0;
}

function codeByLine(text) {
  const ctx = scannerContext(text);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '\n') {
      scannerNewline(ctx);
      continue;
    }

    i += scanCoverageChar(ctx, ch, next);
  }
  return ctx.code;
}

function bracketDelta(text) {
  let delta = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '(' || ch === '[') delta++;
    if (ch === '}' || ch === ')' || ch === ']') delta--;
  }
  return delta;
}

function coverageRelevantLines(sf) {
  if (relevantLineCache.has(sf)) return relevantLineCache.get(sf);

  const source = lineCoverageSource(sf);
  if (!source) {
    relevantLineCache.set(sf, null);
    return null;
  }

  const codeLines = codeByLine(source.text);
  const relevant = new Set();
  let typeDepth = 0;

  for (let index = 0; index < codeLines.length; index++) {
    const lineNo = index + 1;
    const trimmed = codeLines[index].trim();

    if (typeDepth > 0) {
      typeDepth += bracketDelta(trimmed);
      if (typeDepth <= 0 || /[;}]$/.test(trimmed)) typeDepth = 0;
      continue;
    }

    if (!trimmed) continue;
    if (/^[{}()[\],;:.]+$/.test(trimmed)) continue;
    if (
      /^(import\s+type|export\s+type|type\s+\w|interface\s+\w|declare\s+interface\s+\w|export\s+interface\s+\w)\b/.test(
        trimmed,
      )
    ) {
      typeDepth = /[;}]$/.test(trimmed) ? 0 : Math.max(1, bracketDelta(trimmed));
      continue;
    }
    if (/^export\s*{\s*type\b/.test(trimmed)) continue;

    relevant.add(lineNo);
  }

  relevantLineCache.set(sf, relevant);
  return relevant;
}

async function mergeLcov(files) {
  const records = new Map();
  const reads = await Promise.all(
    files.map(async (file) => {
      const lcovPath = path.join(file.outDir, 'lcov.info');
      try {
        return { file, text: await readFile(lcovPath, 'utf8'), skipped: false };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return { file, text: '', skipped: true };
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
    parseLcov(read.text, records);
  }
  const lines = ['TN:'];
  let prunedLines = 0;
  let prunedOutOfRangeLines = 0;
  let sourceFiles = 0;
  for (const [sf, lineHits] of [...records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isProjectSourceRecord(sf)) continue;
    sourceFiles++;
    const relevant = coverageRelevantLines(sf);
    const lineLimit = sourceLineLimit(sf);
    lines.push(`SF:${sf}`);
    let lh = 0;
    const entries = [...lineHits.entries()]
      .filter(([line]) => {
        const inRange = lineLimit == null || line <= lineLimit;
        if (!inRange) {
          prunedOutOfRangeLines++;
          return false;
        }
        const keep = relevant == null || relevant.has(line);
        if (!keep) prunedLines++;
        return keep;
      })
      .sort(([a], [b]) => a - b);
    for (const [line, hits] of entries) {
      if (hits > 0) lh++;
      lines.push(`DA:${line},${hits}`);
    }
    lines.push(`LF:${entries.length}`);
    lines.push(`LH:${lh}`);
    lines.push('end_of_record');
  }
  await mkdir(coverageDir, { recursive: true });
  await writeFile(path.join(coverageDir, 'lcov.info'), `${lines.join(os.EOL)}${os.EOL}`);
  return { files: sourceFiles, skippedNoCoverage, prunedLines, prunedOutOfRangeLines };
}

const tests = await listTests();
if (tests.length === 0) {
  console.error('No __tests__/**/*.test.ts files found.');
  process.exit(1);
}

await rm(tmpRoot, { recursive: true, force: true });
await mkdir(tmpRoot, { recursive: true });
console.log(`=== coverage: ${tests.length} files, ${jobs} workers ===`);
const failures = await runPool(tests);
if (failures.length > 0) {
  console.error(`=== ${failures.length} coverage test file(s) failed ===`);
  for (const failure of failures.slice(0, 20)) {
    console.error(`--- ${failure.file} (${failure.code ?? failure.signal}) ---`);
    const combined = `${failure.stdout}${failure.stderr}`.trim();
    console.error(combined.split('\n').slice(-120).join('\n'));
  }
  process.exit(1);
}

const merged = await mergeLcov(
  tests.map((file, index) => ({ file, outDir: path.join(tmpRoot, safeName(file, index)) })),
);
await rm(tmpRoot, { recursive: true, force: true });
const skipped = merged.skippedNoCoverage > 0 ? ` (${merged.skippedNoCoverage} test files had no LCOV records)` : '';
const prunedParts = [];
if (merged.prunedLines > 0) prunedParts.push(`pruned ${merged.prunedLines} non-executable TS lines`);
if (merged.prunedOutOfRangeLines > 0)
  prunedParts.push(`dropped ${merged.prunedOutOfRangeLines} out-of-range LCOV lines`);
const pruned = prunedParts.length > 0 ? `; ${prunedParts.join('; ')}` : '';
console.log(`=== coverage merged: ${merged.files} source files -> coverage/lcov.info${skipped}${pruned} ===`);
