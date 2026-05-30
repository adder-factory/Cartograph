/**
 * Tests for the claude-bridge chat backend.
 *
 * Strategy: instead of mocking `child_process.spawn`, we drop a small
 * Node script that mimics `claude -p --model X --output-format json`
 * — reads stdin, optionally prints stderr, exits with the controlled
 * code, prints a JSON wrapper to stdout. Tests then point
 * `claudeBin` at that script. End-to-end coverage of spawn + stdin
 * piping + stdout parsing without touching the real `claude` binary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeBridgeChatBackend, findOnPath } from '../src/llm/claude-bridge.js';
import { LlmEndpointError } from '../src/llm/client.js';

let tmpDir: string;
let fakeBinPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-claude-bridge-'));
  // The fake CLI: reads stdin, writes a JSON object with a `result`
  // string echoing back the model arg. CLI flags handled: `--model`,
  // `-p`, `--output-format`. Any "FAIL" prefix in stdin makes it
  // exit non-zero so we can assert error paths.
  fakeBinPath = path.join(tmpDir, 'claude-fake.js');
  fs.writeFileSync(
    fakeBinPath,
    `#!/usr/bin/env node
const data = [];
process.stdin.on('data', (c) => data.push(c));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(data).toString('utf-8');
  const argv = process.argv.slice(2);
  const modelIdx = argv.indexOf('--model');
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : 'unknown';
  const fmtIdx = argv.indexOf('--output-format');
  const fmt = fmtIdx >= 0 ? argv[fmtIdx + 1] : 'text';

  if (stdin.startsWith('FAIL')) {
    process.stderr.write('simulated failure\\n');
    process.exit(2);
  }
  if (stdin.startsWith('SLOW')) {
    // Sleep longer than the test timeout — exercises the timer path.
    setTimeout(() => process.exit(0), 30_000);
    return;
  }

  if (fmt === 'json') {
    const payload = {
      result: 'echo: ' + stdin.slice(0, 80) + ' [model=' + model + ']',
      usage: { input_tokens: stdin.length, output_tokens: 12 },
    };
    process.stdout.write(JSON.stringify(payload));
  } else {
    process.stdout.write(stdin);
  }
});
`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBridge(opts: { model?: string; askModel?: string; timeoutMs?: number } = {}) {
  return new ClaudeBridgeChatBackend({
    provider: 'claude-bridge',
    model: opts.model ?? 'claude-haiku-4-5',
    askModel: opts.askModel,
    claudeBin: `node ${fakeBinPath}` as never, // see note: spawn-with-args trick below
    timeoutMs: opts.timeoutMs,
  });
}

describe('ClaudeBridgeChatBackend', () => {
  // The implementation uses `spawn(bin, args)` — `bin` must be a path,
  // not a shell phrase. So we invoke the fake script directly by
  // setting it executable and pointing claudeBin at it.
  it('chat() returns text from --output-format json', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    const res = await backend.chat([{ role: 'user', content: 'hello world' }], {}, false);
    expect(res.text).toContain('hello world');
    expect(res.text).toContain('claude-haiku-4-5');
    expect(res.promptTokens).toBeGreaterThan(0);
    expect(res.completionTokens).toBe(12);
  });

  it('useAskModel=true routes to askModel', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      askModel: 'claude-sonnet-4-6',
      claudeBin: fakeBinPath,
    });
    const res = await backend.chat([{ role: 'user', content: 'pick me' }], {}, true);
    expect(res.text).toContain('claude-sonnet-4-6');
  });

  it('falls back to model when askModel is unset', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    const res = await backend.chat([{ role: 'user', content: 'nope' }], {}, true);
    expect(res.text).toContain('claude-haiku-4-5');
  });

  it('serialises multi-turn messages into a single prompt', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    const res = await backend.chat(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'q1' },
      ],
      {},
      false,
    );
    // The fake echoes the first 80 chars of the joined prompt.
    expect(res.text).toMatch(/be brief/);
    expect(res.text).toMatch(/q1/);
  });

  it('non-zero exit produces an LlmEndpointError with stderr', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    await expect(backend.chat([{ role: 'user', content: 'FAIL please' }], {}, false)).rejects.toThrow(LlmEndpointError);
  });

  it('isReachable() resolves true when binary exists', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    expect(await backend.isReachable()).toBe(true);
  });

  it('isReachable() resolves false when explicit claudeBin does not exist', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: '/nonexistent/path/to/claude-binary-12345',
    });
    expect(await backend.isReachable()).toBe(false);
    // chat() also fails (spawn error or our pre-check).
    await expect(backend.chat([{ role: 'user', content: 'x' }], {}, false)).rejects.toThrow();
  });

  it('isReachable() resolves false when explicit claudeBin is not executable', async () => {
    const notExec = path.join(tmpDir, 'not-executable.txt');
    fs.writeFileSync(notExec, 'just a text file', { mode: 0o644 });
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: notExec,
    });
    // On POSIX systems, X_OK should fail here. On Windows the access
    // check effectively reduces to existence, so we only enforce this
    // assertion off Windows.
    if (process.platform !== 'win32') {
      expect(await backend.isReachable()).toBe(false);
    }
  });

  it('timeout kills the subprocess and rejects', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
      timeoutMs: 200,
    });
    await expect(backend.chat([{ role: 'user', content: 'SLOW please' }], {}, false)).rejects.toThrow(/timed out/);
  });

  it('abort signal kills the subprocess immediately (cancel within ~1s)', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
      // Use the SLOW prompt — fake CLI sleeps 30 s. Without
      // signal-honoring this would block until the test timeout.
      timeoutMs: 60_000,
    });
    const ac = new AbortController();
    const t0 = Date.now();
    const promise = backend.chat([{ role: 'user', content: 'SLOW please' }], { signal: ac.signal }, false);
    // Fire abort 100 ms in.
    setTimeout(() => ac.abort(), 100);
    await expect(promise).rejects.toThrow(/aborted by caller/);
    const elapsed = Date.now() - t0;
    // SIGTERM grace is 2 s, but the fake script doesn't trap it so it
    // dies on the first signal — should be well under 2.5 s.
    expect(elapsed).toBeLessThan(2_500);
  });

  it('signal already aborted before chat() rejects without spawning', async () => {
    const backend = new ClaudeBridgeChatBackend({
      provider: 'claude-bridge',
      model: 'claude-haiku-4-5',
      claudeBin: fakeBinPath,
    });
    const ac = new AbortController();
    ac.abort();
    await expect(backend.chat([{ role: 'user', content: 'hello' }], { signal: ac.signal }, false)).rejects.toThrow(
      /aborted before spawn/,
    );
  });
});

describe('findOnPath', () => {
  it('finds an existing binary like `node`', async () => {
    const found = await findOnPath('node');
    expect(found).not.toBeNull();
    expect(typeof found).toBe('string');
  });

  it('returns null for a binary that does not exist', async () => {
    const found = await findOnPath('definitely-not-a-real-binary-xyzzyx');
    expect(found).toBeNull();
  });
});
