import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');
const SPAWNED_INDEX_TEST_TIMEOUT_MS = 15_000;

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

function runCliIn(cwd: string, args: string[], stdin?: string): { out: string; code: number } {
  try {
    const out = execFileSync('bun', [cliEntry, ...args], {
      cwd,
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

  it('admin index rejects invalid --max-file-size before opening a project', () => {
    const { out, code } = runCli(['admin', 'index', '/tmp/cartograph-not-initialized', '--max-file-size', 'abc']);

    expect(code).not.toBe(0);
    expect(out).toContain('--max-file-size must be between 1 byte and 10mb');
    expect(out).toContain('got "abc"');
  });

  it('admin index rejects oversized --max-file-size before opening a project', () => {
    const { out, code } = runCli(['admin', 'index', '/tmp/cartograph-not-initialized', '--max-file-size', '11mb']);

    expect(code).not.toBe(0);
    expect(out).toContain('--max-file-size must be between 1 byte and 10mb');
    expect(out).toContain('got "11mb"');
  });

  it('ask rejects blank questions before opening a project or contacting an LLM', () => {
    const { out, code } = runCli(['ask', '   ', '/tmp/cartograph-not-initialized']);

    expect(code).not.toBe(0);
    expect(out).toContain('ask: the question must not be empty');
  });

  it(
    'affected --stdin --quiet accepts stdin and emits JSON for indexed paths',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-affected-'));
      try {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'config.ts'), 'export const value = 1;\n');
        const init = runCli(['admin', 'init', dir]);
        expect(init.code).toBe(0);
        const index = runCli(['admin', 'index', '--quiet', dir]);
        expect(index.code).toBe(0);

        const { out, code } = runCliIn(dir, ['affected', '--stdin', '--quiet', '--json'], 'src/config.ts\n');
        expect(code).toBe(0);
        const parsed = JSON.parse(out) as { changedFiles: string[]; affectedTests: string[]; derivedFromGit: boolean };
        expect(parsed.changedFiles).toEqual(['src/config.ts']);
        expect(Array.isArray(parsed.affectedTests)).toBe(true);
        expect(parsed.derivedFromGit).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWNED_INDEX_TEST_TIMEOUT_MS,
  );

  it('admin exposes noninteractive LLM setup parity commands', () => {
    const { out, code } = runCli(['admin', 'llm-plan']);
    expect(code).toBe(0);
    expect(out).toContain('Recommended preset:');

    const help = runCli(['admin', '--help']);
    expect(help.out).toContain('llm-apply');
    expect(help.out).toContain('llm-tune');
    expect(help.out).toContain('doctor');
  });

  it('admin embed rejects non-numeric --concurrency before starting work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-concurrency-'));
    try {
      runCli(['admin', 'init', dir]);
      const { out, code } = runCli(['admin', 'embed', '--concurrency', 'abc', dir]);
      expect(code).not.toBe(0);
      expect(out).toContain('--concurrency must be a positive integer');
      expect(out).not.toContain('Embedding indexed symbols');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup --no-models performs real admin init and creates config + db', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-setup-'));
    try {
      const { out, code } = runCli(['setup', '--no-models', dir]);
      expect(code).toBe(0);
      expect(out).toContain('running doctor verification');
      expect(fs.existsSync(path.join(dir, '.cartograph', 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.cartograph', 'cartograph.db'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('doctor rejects invalid runtime LLM provider values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-doctor-invalid-'));
    try {
      fs.mkdirSync(path.join(dir, '.cartograph'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.cartograph', 'config.json'),
        JSON.stringify({ llm: { embeddingLlm: { provider: 'bogus', model: 'x', endpoint: 'http://localhost:8080' } } }),
      );
      const { out, code } = runCli(['doctor', dir]);
      expect(code).not.toBe(0);
      expect(out).toContain('failed runtime validation');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints installable shell completion scripts', () => {
    const bash = runCli(['completions', 'bash']);
    expect(bash.code).toBe(0);
    expect(bash.out).toContain('complete -o default -F _cartograph_completion cartograph');
    expect(bash.out).toContain('cartograph __complete');

    const zsh = runCli(['completion', 'zsh']);
    expect(zsh.code).toBe(0);
    expect(zsh.out).toContain('#compdef cartograph');
    expect(zsh.out).toContain('cartograph __complete');

    const fish = runCli(['completions', 'fish']);
    expect(fish.code).toBe(0);
    expect(fish.out).toContain('complete -c cartograph');
    expect(fish.out).toContain('cartograph __complete');

    const powershell = runCli(['completions', 'powershell']);
    expect(powershell.code).toBe(0);
    expect(powershell.out).toContain('Register-ArgumentCompleter -Native -CommandName cartograph');
    expect(powershell.out).toContain('cartograph __complete');
  });

  it('rejects unsupported completion shells cleanly', () => {
    const { out, code } = runCli(['completions', 'nushell']);
    expect(code).not.toBe(0);
    expect(out).toContain('Unsupported completion shell "nushell"');
    expect(out).toContain('bash, zsh, fish, powershell');
  });

  it('offers command and option candidates through the hidden completion helper', () => {
    const topLevel = runCli(['__complete', 'sta']);
    expect(topLevel.code).toBe(0);
    expect(topLevel.out.split('\n')).toContain('status');

    const admin = runCli(['__complete', 'admin', 'sy']);
    expect(admin.code).toBe(0);
    expect(admin.out.split('\n')).toContain('sync');

    const statusOption = runCli(['__complete', 'status', '--j']);
    expect(statusOption.code).toBe(0);
    expect(statusOption.out.split('\n')).toContain('--json');
  });

  it(
    'suppresses EPIPE noise when output is piped to head',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-epipe-'));
      try {
        fs.mkdirSync(path.join(dir, 'src'));
        for (let i = 0; i < 30; i++)
          fs.writeFileSync(path.join(dir, 'src', `file-${i}.ts`), `export const v${i} = ${i};\n`);
        const init = runCli(['admin', 'init', dir]);
        expect(init.code).toBe(0);
        const index = runCli(['admin', 'index', '--quiet', dir]);
        expect(index.code).toBe(0);

        const out = execFileSync(
          'bash',
          ['-lc', `set -o pipefail; bun ${cliEntry} files --format flat --project-path ${dir} 2>&1 | head -n 5`],
          {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        expect(out).toContain('Files');
        expect(out).not.toContain('EPIPE');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWNED_INDEX_TEST_TIMEOUT_MS,
  );
});
