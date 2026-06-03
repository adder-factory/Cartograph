#!/usr/bin/env node
/**
 * Order-dependence canary for Bun's shared module cache.
 *
 * A top-level `vi.mock()` that replaces a shared internal module with a
 * partial export object can poison later test files when Bun runs them in
 * one process. This script runs every remaining top-level-mock test before
 * the MCP canaries that previously caught the leaks.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CANARIES = ['__tests__/tool-surface-smoke.test.ts', '__tests__/mcp-node-multi.test.ts'];
const MAX_CAPTURE_BYTES = 30 * 1024 * 1024;
const FAILURE_SUMMARY_LINES = 30;
const FAILURE_TAIL_LINES = 40;
const canaries = (process.env['TEST_LEAK_CANARIES'] ?? DEFAULT_CANARIES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
    ...options,
  });
}

const rg = run('rg', ['-l', '^vi\\.mock\\(', '__tests__', '-g', '*.ts']);
if (rg.status !== 0 && rg.status !== 1) {
  process.stderr.write(rg.stderr || rg.stdout);
  process.exit(rg.status ?? 1);
}

const files = rg.stdout
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((file) => !canaries.includes(file));

if (files.length === 0) {
  console.log('No top-level vi.mock() test files found.');
  process.exit(0);
}

const failures = [];
const env = {
  ...process.env,
  CARTOGRAPH_HOOKS_IN_PROCESS: '1',
  CARTOGRAPH_TRACK_CONSUMED_ARGS: '1',
};

function summarizeFailure(output) {
  const lines = output
    .split('\n')
    .filter((line) => /# Unhandled error|error: |SyntaxError|TypeError|\(fail\)/.test(line));
  if (lines.length > 0) return lines.slice(0, FAILURE_SUMMARY_LINES).join('\n');
  return output.split('\n').slice(-FAILURE_TAIL_LINES).join('\n');
}

for (const file of files) {
  for (const canary of canaries) {
    const label = `${file} -> ${canary}`;
    process.stdout.write(`### checking ${label}\n`);
    const result = run('bun', ['test', '--timeout', '60000', file, canary], { env });
    if (result.status === 0) {
      process.stdout.write(`ok ${label}\n`);
      continue;
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    failures.push(label);
    process.stdout.write(`FAILED ${label}\n${summarizeFailure(output)}\n`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nModule-leak canary failures:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

console.log('Module-leak canaries passed.');
