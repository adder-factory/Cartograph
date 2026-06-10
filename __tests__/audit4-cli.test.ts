/**
 * Audit-4 CLI-layer regression tests.
 *
 * Pins the fixes from the audit-4 friction sweep for the CLI argument
 * layer in `src/bin/cartograph.ts` — bounds validation, CLI/MCP option
 * parity, styled unknown-subcommand errors, and the model-path leak.
 *
 * The CLI is spawned via `bun` so each run is a fresh process that
 * reflects the latest source — mirroring the `cli-mcp-alignment.test.ts`
 * "CLI behaviour parity (spawned)" block.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('audit-4 CLI argument-layer fixes', () => {
  const repoRoot = path.join(__dirname, '..');
  const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');
  const indexed = fs.existsSync(path.join(repoRoot, '.cartograph'));

  /** Run the CLI, returning stdout+stderr and the exit code. */
  function runCli(cliArgs: string[]): { out: string; code: number } {
    try {
      const out = execFileSync('bun', [cliEntry, ...cliArgs], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
    }
  }

  // ── help-text only (no index needed) ───────────────────────────

  it('graph --help exposes --compact / --fields / --since (MCP parity)', () => {
    const { out, code } = runCli(['graph', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--compact');
    expect(out).toContain('--fields');
    expect(out).toContain('--since');
  }, 60_000);

  it('graph --help exposes the -d similar tunables', () => {
    const { out, code } = runCli(['graph', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--top-k');
    expect(out).toContain('--min-score');
    expect(out).toContain('--same-language');
  }, 60_000);

  it('ask --help documents the [path] arg, the char cap, and the retrieve-k range', () => {
    const { out, code } = runCli(['ask', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--project-path');
    expect(out).toContain('--mode');
    expect(out).toContain('--prompt');
    expect(out).toContain('--system');
    expect(out).toContain('--max-tokens');
    expect(out).toMatch(/4096/);
    expect(out).toMatch(/range 4-30/);
  }, 60_000);

  it('files --help shows folded module and one-file flags', () => {
    const { out, code } = runCli(['files', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('[path]');
    expect(out).toContain('--format');
    expect(out).toContain('--dir-path');
    expect(out).toContain('--file');
    expect(out).toContain('--limit');
  }, 60_000);

  // ── bounds validation (no index needed — rejected at parse) ────

  it('summaries pending --limit 999 is rejected (max 40)', () => {
    const { out, code } = runCli(['summaries', 'pending', '--limit', '999']);
    expect(code).not.toBe(0);
    expect(out).toContain('must be <= 40');
  }, 60_000);

  it('summaries pending --limit -5 is rejected (min 1)', () => {
    const { out, code } = runCli(['summaries', 'pending', '--limit', '-5']);
    expect(code).not.toBe(0);
    expect(out).toContain('must be >= 1');
  }, 60_000);

  // ── styled unknown-subcommand errors ───────────────────────────

  it("session <bad-action> prints a styled '✗ Unknown session action' error", () => {
    const { out, code } = runCli(['session', 'bogusaction']);
    expect(code).not.toBe(0);
    expect(out).toContain("Unknown session action 'bogusaction'");
    expect(out).toContain('valid:');
  }, 60_000);

  it("admin <bad-action> prints a styled '✗ Unknown admin action' error", () => {
    const { out, code } = runCli(['admin', 'frobnicate']);
    expect(code).not.toBe(0);
    expect(out).toContain("Unknown admin action 'frobnicate'");
    expect(out).toContain('valid:');
  }, 60_000);

  // ── needs an indexed repo ──────────────────────────────────────

  it.skipIf(!indexed)(
    'blame --per-commit-peers 0 is accepted (0 disables the trail)',
    () => {
      const { code } = runCli(['blame', 'indexAll', '--per-commit-peers', '0']);
      expect(code).toBe(0);
    },
    90_000,
  );

  it.skipIf(!indexed)(
    'blame --per-commit-peers -1 is rejected (min 0)',
    () => {
      const { out, code } = runCli(['blame', 'indexAll', '--per-commit-peers', '-1']);
      expect(code).not.toBe(0);
      expect(out).toContain('must be >= 0');
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'hotspots --min-commits -5 is rejected (min 0)',
    () => {
      const { out, code } = runCli(['hotspots', '--min-commits', '-5']);
      expect(code).not.toBe(0);
      expect(out).toContain('must be >= 0');
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'files --format module with no dirPath reaches the list-all summaries path',
    () => {
      const { out, code } = runCli(['files', '--format', 'module']);
      expect(code).toBe(0);
      expect(out).toMatch(/Module summaries|No module summaries cached yet/);
    },
    90_000,
  );

  it.skipIf(!indexed)(
    'review context rejects an explicitly-passed empty diff file',
    () => {
      const tmp = path.join(os.tmpdir(), `audit4-empty-${Date.now()}.diff`);
      fs.writeFileSync(tmp, '   \n  \n');
      try {
        const { out, code } = runCli(['review', 'context', tmp]);
        expect(code).not.toBe(0);
        expect(out).toContain('diff file is empty');
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
    60_000,
  );

  // Regression: the `ask` command must reach its action body without a
  // TypeError. A duplicate `[path]` registration (command-string +
  // `.argument()`) once displaced the options object, crashing every
  // invocation with "Cannot read properties of undefined". Probing an
  // uninitialised path exercises the action callback (which reads
  // `options.projectPath`) without needing an LLM.
  it('ask reaches its action callback without crashing (no displaced opts)', () => {
    const bogus = path.join(os.tmpdir(), `audit4-noinit-${Date.now()}`);
    const { out, code } = runCli(['ask', 'hello', bogus]);
    expect(code).not.toBe(0);
    expect(out).toContain('Cartograph not initialized');
    expect(out).not.toContain('Cannot read properties of undefined');
  }, 60_000);

  it('ask accepts the project path via the -p alias', () => {
    const bogus = path.join(os.tmpdir(), `audit4-noinit-p-${Date.now()}`);
    const { out, code } = runCli(['ask', 'hello', '-p', bogus]);
    expect(code).not.toBe(0);
    expect(out).toContain('Cartograph not initialized');
    expect(out).not.toContain('Cannot read properties of undefined');
  }, 60_000);
});
