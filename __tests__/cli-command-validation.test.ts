import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');

function runCli(args: string[], stdin?: string): { out: string; code: number } {
  try {
    const out = execFileSync('bun', [cliEntry, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      input: stdin,
      stdio: stdin === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

describe('CLI command validation contracts', () => {
  it('at-range rejects malformed --ranges before opening a project', () => {
    const { out, code } = runCli(['at-range', '--ranges', 'bad']);

    expect(code).not.toBe(0);
    expect(out).toContain("Invalid --ranges spec 'bad'");
    expect(out).toContain("expected 'file:startLine-endLine'");
  });

  it('admin index rejects non-positive --parse-workers before opening a project', () => {
    const { out, code } = runCli(['admin', 'index', '/tmp/cartograph-not-initialized', '--parse-workers', '0']);

    expect(code).not.toBe(0);
    expect(out).toContain('--parse-workers must be a positive integer');
    expect(out).toContain('got "0"');
  });

  it('ask rejects blank questions before opening a project or contacting an LLM', () => {
    const { out, code } = runCli(['ask', '   ', '/tmp/cartograph-not-initialized']);

    expect(code).not.toBe(0);
    expect(out).toContain('ask: the question must not be empty');
  });

  it('affected --stdin --quiet accepts stdin and emits JSON for indexed paths', () => {
    const { out, code } = runCli(['affected', '--stdin', '--quiet', '--json'], 'src/config.ts\n');

    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { changedFiles: string[]; affectedTests: string[]; derivedFromGit: boolean };
    expect(parsed.changedFiles).toEqual(['src/config.ts']);
    expect(Array.isArray(parsed.affectedTests)).toBe(true);
    expect(parsed.derivedFromGit).toBe(false);
  });
});
