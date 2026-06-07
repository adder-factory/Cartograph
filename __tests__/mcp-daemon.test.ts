import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';

const repoRoot = path.join(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');
const DAEMON_TEST_TIMEOUT_MS = 25_000;

describe('shared MCP daemon', () => {
  it(
    'proxies initialize and tools/list through one shared daemon',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-daemon-'));
      let child: ChildProcessWithoutNullStreams | null = null;
      try {
        const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
        cg.close();

        const exchange = startDaemonProxy(dir);
        child = exchange.child;
        await exchange.attached;

        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              clientInfo: { name: 'daemon-test', version: '0' },
              capabilities: {},
              rootUri: `file://${dir}`,
            },
          })}\n`,
        );
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);

        await waitUntil(() => exchange.responses.has(1) && exchange.responses.has(2), {
          child,
          stdout: () => exchange.stdout,
          stderr: () => exchange.stderr,
          timeoutMs: 10_000,
        });

        const initialize = exchange.responses.get(1) as { result?: { serverInfo?: { name?: string } } };
        expect(initialize.result?.serverInfo?.name).toBe('cartograph');

        const toolsList = exchange.responses.get(2) as { result?: { tools?: Array<{ name: string }> } };
        const toolNames = toolsList.result?.tools?.map((tool) => tool.name) ?? [];
        expect(toolNames).toContain('cartograph_status');
        expect(toolNames).toContain('cartograph_find');

        child.stdin.end();
        await waitForExit(child, 5_000);
        child = null;
      } finally {
        if (child && child.exitCode === null) child.kill('SIGTERM');
        cleanupDaemon(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    'serves multiple simultaneous proxy clients from the same daemon',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-daemon-multi-'));
      const exchanges: Array<ReturnType<typeof startDaemonProxy>> = [];
      try {
        const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
        cg.close();

        for (let i = 0; i < 3; i++) exchanges.push(startDaemonProxy(dir));
        await Promise.all(exchanges.map((exchange) => exchange.attached));

        const daemonPid = readDaemonPid(dir);
        expect(daemonPid).toBeGreaterThan(0);

        for (let i = 0; i < exchanges.length; i++) {
          sendInitializeAndList({
            exchange: exchanges[i]!,
            dir,
            clientName: `daemon-client-${i}`,
            idOffset: i * 10,
          });
        }

        await Promise.all(
          exchanges.map((exchange, i) =>
            waitUntil(() => exchange.responses.has(i * 10 + 1) && exchange.responses.has(i * 10 + 2), {
              child: exchange.child,
              stdout: () => exchange.stdout,
              stderr: () => exchange.stderr,
              timeoutMs: 10_000,
            }),
          ),
        );

        expect(readDaemonPid(dir)).toBe(daemonPid);

        for (let i = 0; i < exchanges.length; i++) {
          const exchange = exchanges[i]!;
          const initialize = exchange.responses.get(i * 10 + 1) as { result?: { serverInfo?: { name?: string } } };
          expect(initialize.result?.serverInfo?.name).toBe('cartograph');

          const toolsList = exchange.responses.get(i * 10 + 2) as { result?: { tools?: Array<{ name: string }> } };
          const toolNames = toolsList.result?.tools?.map((tool) => tool.name) ?? [];
          expect(toolNames).toContain('cartograph_status');
          expect(toolNames).toContain('cartograph_find');
        }

        await Promise.all(
          exchanges.map(async (exchange) => {
            exchange.child.stdin.end();
            await waitForExit(exchange.child, 5_000);
          }),
        );
        exchanges.length = 0;
      } finally {
        for (const exchange of exchanges) {
          if (exchange.child.exitCode === null) exchange.child.kill('SIGTERM');
        }
        cleanupDaemon(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    'does not print daemon attach noise unless explicitly requested',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-daemon-quiet-'));
      let child: ChildProcessWithoutNullStreams | null = null;
      try {
        const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
        cg.close();

        const exchange = startDaemonProxy(dir, { logAttach: false, resolveOnStdout: true });
        child = exchange.child;
        sendInitializeAndList({ exchange, dir, clientName: 'quiet-daemon-client', idOffset: 100 });

        await waitUntil(() => exchange.responses.has(101) && exchange.responses.has(102), {
          child,
          stdout: () => exchange.stdout,
          stderr: () => exchange.stderr,
          timeoutMs: 10_000,
        });

        expect(exchange.stderr).not.toContain('Attached to shared daemon');
        child.stdin.end();
        await waitForExit(child, 5_000);
        child = null;
      } finally {
        if (child && child.exitCode === null) child.kill('SIGTERM');
        cleanupDaemon(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );
});

interface InitializeClientArgs {
  exchange: ReturnType<typeof startDaemonProxy>;
  dir: string;
  clientName: string;
  idOffset: number;
}

function sendInitializeAndList(args: InitializeClientArgs): void {
  const { exchange, dir, clientName, idOffset } = args;
  exchange.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: idOffset + 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: clientName, version: '0' },
        capabilities: {},
        rootUri: `file://${dir}`,
      },
    })}\n`,
  );
  exchange.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  exchange.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: idOffset + 2, method: 'tools/list', params: {} })}\n`,
  );
}

function startDaemonProxy(
  projectRoot: string,
  options: { logAttach?: boolean; resolveOnStdout?: boolean } = {},
): {
  child: ChildProcessWithoutNullStreams;
  attached: Promise<void>;
  responses: Map<number, unknown>;
  stdout: string;
  stderr: string;
} {
  const child = spawn(
    'bun',
    [cliEntry, 'serve', '--mcp', '--daemon', '--project-path', projectRoot, '--no-startup-sync'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CARTOGRAPH_DAEMON_IDLE_TIMEOUT_MS: '500',
        ...(options.logAttach === false
          ? { CARTOGRAPH_MCP_LOG_ATTACH: undefined }
          : { CARTOGRAPH_MCP_LOG_ATTACH: '1' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const state = {
    child,
    attached: Promise.resolve(),
    responses: new Map<number, unknown>(),
    stdout: '',
    stderr: '',
  };

  let stdoutBuffer = '';
  let resolveAttachedFromOutput: (() => void) | undefined;
  child.stdout.on('data', (chunk) => {
    state.stdout += String(chunk);
    stdoutBuffer += String(chunk);
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        const parsed = parseJsonRpcLine(line);
        if (typeof parsed.id === 'number') state.responses.set(parsed.id, parsed);
        if (options.resolveOnStdout && state.responses.size > 0) resolveAttachedFromOutput?.();
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });

  state.attached = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`daemon proxy did not attach\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`));
    }, 10_000);
    resolveAttachedFromOutput = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.stderr.on('data', (chunk) => {
      state.stderr += String(chunk);
      if (state.stderr.includes('Attached to shared daemon')) {
        resolveAttachedFromOutput?.();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`daemon proxy exited before attach with ${code}\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`),
      );
    });
  });

  return state;
}

function parseJsonRpcLine(line: string): { id?: number } {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as { id?: number }) : {};
  } catch {
    return {};
  }
}

async function waitUntil(
  predicate: () => boolean,
  opts: {
    child: ChildProcessWithoutNullStreams;
    stdout: () => string;
    stderr: () => string;
    timeoutMs: number;
  },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (opts.child.exitCode !== null) {
      throw new Error(`daemon proxy exited early\nstdout:\n${opts.stdout()}\nstderr:\n${opts.stderr()}`);
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for daemon responses\nstdout:\n${opts.stdout()}\nstderr:\n${opts.stderr()}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('daemon proxy did not exit after stdin close'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`daemon proxy exited with ${code}`));
    });
  });
}

function cleanupDaemon(projectRoot: string): void {
  const pid = readDaemonPid(projectRoot);
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
}

function readDaemonPid(projectRoot: string): number {
  const pidPath = path.join(projectRoot, '.cartograph', 'daemon.pid');
  try {
    const parsed = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
    return typeof parsed.pid === 'number' && parsed.pid > 0 ? parsed.pid : 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
