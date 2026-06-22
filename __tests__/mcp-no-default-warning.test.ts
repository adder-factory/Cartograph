/**
 * Tests for the "wrong directory" warning emitted when the MCP
 * server boots without a default project. The warning shape varies
 * based on what's in the launch directory:
 *  - 0 child candidates: "no projects found, run init first"
 *  - 1 child candidate: "did you mean X? restart with --project-path"
 *  - N candidates: list them all
 *
 * Without this warning, an operator who launches Claude Code from a
 * parent dir gets silent stale-index pain. With it, the misconfig
 * is visible on the first server-stderr line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function setupChildProject(parent: string, name: string): Promise<void> {
  const sub = path.join(parent, name);
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'src', 'a.ts'), `export function ${name}() { return 1; }\n`);
  fs.writeFileSync(path.join(sub, '.gitignore'), '.cartograph/\n');
  git(sub, 'init', '-q');
  git(sub, 'config', 'user.email', 't@t');
  git(sub, 'config', 'user.name', 't');
  git(sub, 'config', 'commit.gpgsign', 'false');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'init');
  const cg = await Cartograph.init(sub, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  cg.close();
}

/** Capture stderr writes during a fn call, restore on exit. */
async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stderr.write;
  let buf = '';
  const captureWrite: typeof process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (typeof encodingOrCallback === 'function') encodingOrCallback();
    if (callback) callback();
    return true;
  };
  process.stderr.write = captureWrite;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

describe('MCPServer wrong-directory warning', () => {
  let parent: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-no-default-'));
  });

  afterEach(() => {
    if (fs.existsSync(parent)) fs.rmSync(parent, { recursive: true, force: true });
  });

  it('one child candidate → "did you mean X?" suggestion', async () => {
    await setupChildProject(parent, 'my-project');
    const { MCPServer } = await import('../src/mcp/index.js');
    // Invoke tryInitializeDefault directly because spinning up the full
    // stdio transport is heavy.
    const server = new MCPServer();
    const stderr = await captureStderr(async () => {
      await server.tryInitializeDefault(parent);
    });
    expect(stderr).toContain('No `.cartograph/` at or above');
    expect(stderr).toContain('Did you mean');
    expect(stderr).toContain('my-project');
    expect(stderr).toContain('--project-path');
  });

  it('multiple child candidates → list them all', async () => {
    await setupChildProject(parent, 'alpha');
    await setupChildProject(parent, 'beta');
    await setupChildProject(parent, 'gamma');
    const { MCPServer } = await import('../src/mcp/index.js');
    const server = new MCPServer();
    const stderr = await captureStderr(async () => {
      await server.tryInitializeDefault(parent);
    });
    expect(stderr).toContain('Found 3 candidate cartograph projects');
    expect(stderr).toContain('alpha');
    expect(stderr).toContain('beta');
    expect(stderr).toContain('gamma');
  });

  it('zero candidates → "no projects found, run quickstart first" hint', async () => {
    // Empty parent dir — no children at all.
    const { MCPServer } = await import('../src/mcp/index.js');
    const server = new MCPServer();
    const stderr = await captureStderr(async () => {
      await server.tryInitializeDefault(parent);
    });
    expect(stderr).toContain('No cartograph projects found');
    expect(stderr).toContain('cartograph index');
  });

  it('default project found → no warning emitted', async () => {
    await setupChildProject(parent, 'real');
    const child = path.join(parent, 'real');
    const { MCPServer } = await import('../src/mcp/index.js');
    const server = new MCPServer();
    try {
      const stderr = await captureStderr(async () => {
        await server.tryInitializeDefault(child);
      });
      expect(stderr).not.toContain('No `.cartograph/` at or above');
      expect(stderr).not.toContain('Did you mean');
    } finally {
      server.stop(false);
    }
  });
});
