import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findNearestCartographRoot } from '../directory.js';
import { MCPServer } from './index.js';
import { SocketTransport } from './transport.js';
import type { McpServerProfile } from './profiles.js';
import { CARTOGRAPH_PACKAGE_VERSION } from './version.js';
import {
  type DaemonLockInfo,
  decodeLockInfo,
  encodeLockInfo,
  getDaemonPidPath,
  getDaemonSocketPath,
} from './daemon-paths.js';

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_CONNECT_POLL_MS = 100;
const HELLO_TIMEOUT_MS = 2_000;
const MAX_HELLO_BYTES = 4096;

export interface SharedMcpDaemonOptions {
  projectPath?: string | undefined;
  profile?: McpServerProfile | undefined;
  disableWriteTools?: boolean | undefined;
  disabledTools?: ReadonlySet<string> | undefined;
  allowStaleDefault?: boolean | undefined;
  lowTokensDefault?: boolean | undefined;
  disableStartupSync?: boolean | undefined;
}

interface DaemonHello {
  cartograph: string;
  pid: number;
  socketPath: string;
  protocol: 1;
}

export async function runSharedMcpDaemonProcess(options: SharedMcpDaemonOptions): Promise<void> {
  const projectRoot = resolveDaemonProjectRoot(options.projectPath);
  fs.mkdirSync(path.dirname(getDaemonPidPath(projectRoot)), { recursive: true });

  const lock = tryAcquireDaemonLock(projectRoot);
  if (!lock.acquired) {
    process.stderr.write(`[Cartograph daemon] Existing daemon is active at ${lock.info.socketPath}; exiting child.\n`);
    process.exit(0);
  }

  const socketPath = lock.info.socketPath;
  const mcp = new MCPServer({ ...options, projectPath: projectRoot });
  let server: net.Server | null = null;
  let clients = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  const cleanup = (): void => {
    try {
      if (process.platform !== 'win32') fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    try {
      const current = readLockInfo(projectRoot);
      if (current?.pid === process.pid) fs.unlinkSync(getDaemonPidPath(projectRoot));
    } catch {
      /* already gone */
    }
  };

  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    process.stderr.write(`[Cartograph daemon] Shutting down (${reason}; clients=${clients}).\n`);
    server?.close();
    mcp.stop(false);
    cleanup();
    process.exit(0);
  };

  const armIdleTimer = (): void => {
    if (idleTimer || stopping) return;
    const timeoutMs = resolveIdleTimeoutMs();
    if (timeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients === 0) stop('idle timeout');
      else armIdleTimer();
    }, timeoutMs);
    idleTimer.unref?.();
  };

  const disarmIdleTimer = (): void => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* stale socket absent */
    }
  }

  server = net.createServer((socket) => {
    const hello: DaemonHello = {
      cartograph: CARTOGRAPH_PACKAGE_VERSION,
      pid: process.pid,
      socketPath,
      protocol: 1,
    };
    socket.write(`${JSON.stringify(hello)}\n`);

    let transport: SocketTransport;
    const onClose = (): void => {
      clients = Math.max(0, clients - 1);
      mcp.detachTransport(transport);
      if (clients === 0) armIdleTimer();
    };
    transport = new SocketTransport(socket, onClose);
    clients++;
    disarmIdleTimer();
    mcp.attachTransport(transport);
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, () => {
      server!.off('error', reject);
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          /* best effort */
        }
      }
      resolve();
    });
  });

  process.stderr.write(`[Cartograph daemon] Listening on ${socketPath} (pid ${process.pid}).\n`);
  void mcp.tryInitializeDefault(projectRoot);
  armIdleTimer();
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

export async function runSharedMcpDaemonProxy(options: SharedMcpDaemonOptions): Promise<'proxied' | 'fallback'> {
  const projectRoot = resolveDaemonProjectRoot(options.projectPath);
  const socket = await ensureDaemonSocket(projectRoot, options);
  if (!socket) return 'fallback';
  process.stderr.write(`[Cartograph MCP] Attached to shared daemon for ${projectRoot}.\n`);
  await pipeStdioToSocket(socket);
  process.exit(0);
}

function resolveDaemonProjectRoot(projectPath: string | undefined): string {
  const start = path.resolve(projectPath ?? process.cwd());
  return findNearestCartographRoot(start) ?? start;
}

async function ensureDaemonSocket(
  projectRoot: string,
  options: SharedMcpDaemonOptions,
): Promise<net.Socket | null> {
  const existing = await connectExistingDaemon(projectRoot);
  if (existing) return existing;

  spawnDaemonChild(projectRoot, options);
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const socket = await connectExistingDaemon(projectRoot);
    if (socket) return socket;
    await sleep(DAEMON_CONNECT_POLL_MS);
  }
  process.stderr.write('[Cartograph MCP] Shared daemon did not become ready; falling back to direct stdio mode.\n');
  return null;
}

async function connectExistingDaemon(projectRoot: string): Promise<net.Socket | null> {
  const lock = readLockInfo(projectRoot);
  if (lock && !isProcessAlive(lock.pid)) {
    removeStaleLock(projectRoot, lock);
    return null;
  }
  const socketPath = lock?.socketPath || getDaemonSocketPath(projectRoot);
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return null;

  const socket = net.createConnection(socketPath);
  const hello = await readHelloLine(socket).catch(() => null);
  if (!hello) {
    socket.destroy();
    return null;
  }
  if (hello.cartograph !== CARTOGRAPH_PACKAGE_VERSION || hello.protocol !== 1) {
    process.stderr.write(
      `[Cartograph MCP] Shared daemon version/protocol mismatch ` +
        `(daemon ${hello.cartograph}, local ${CARTOGRAPH_PACKAGE_VERSION}); using direct mode.\n`,
    );
    socket.destroy();
    return null;
  }
  return socket;
}

function spawnDaemonChild(projectRoot: string, options: SharedMcpDaemonOptions): void {
  const args = [
    'serve',
    '--mcp',
    '--daemon-child',
    '--project-path',
    projectRoot,
    '--profile',
    options.profile ?? 'core',
  ];
  if (options.disableWriteTools) args.push('--no-write-tools');
  if (options.allowStaleDefault) args.push('--allow-stale-default');
  if (options.lowTokensDefault) args.push('--low-tokens-default');
  if (options.disableStartupSync) args.push('--no-startup-sync');
  for (const tool of options.disabledTools ?? []) args.push('--disable-tool', tool);

  if (!isBunStandaloneModulePath()) {
    const entry = process.argv[1];
    if (!entry) return;
    args.unshift(entry);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CARTOGRAPH_DAEMON_CHILD: '1' },
  });
  child.unref();
}

function isBunStandaloneModulePath(): boolean {
  return fileURLToPath(import.meta.url).startsWith('/$bunfs/');
}

function tryAcquireDaemonLock(projectRoot: string): { acquired: true; info: DaemonLockInfo } | { acquired: false; info: DaemonLockInfo } {
  const pidPath = getDaemonPidPath(projectRoot);
  const info: DaemonLockInfo = {
    pid: process.pid,
    version: CARTOGRAPH_PACKAGE_VERSION,
    socketPath: getDaemonSocketPath(projectRoot),
    startedAt: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(pidPath, 'wx');
      try {
        fs.writeFileSync(fd, encodeLockInfo(info), 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, info };
    } catch {
      const existing = readLockInfo(projectRoot);
      if (existing && isProcessAlive(existing.pid)) return { acquired: false, info: existing };
      removeStaleLock(projectRoot, existing);
    }
  }

  const existing = readLockInfo(projectRoot) ?? info;
  return { acquired: false, info: existing };
}

function readLockInfo(projectRoot: string): DaemonLockInfo | null {
  try {
    return decodeLockInfo(fs.readFileSync(getDaemonPidPath(projectRoot), 'utf-8'));
  } catch {
    return null;
  }
}

function removeStaleLock(projectRoot: string, info: DaemonLockInfo | null): void {
  try {
    fs.unlinkSync(getDaemonPidPath(projectRoot));
  } catch {
    /* absent */
  }
  if (info?.socketPath && process.platform !== 'win32') {
    try {
      fs.unlinkSync(info.socketPath);
    } catch {
      /* absent */
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHelloLine(socket: net.Socket): Promise<DaemonHello> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for daemon hello'));
    }, HELLO_TIMEOUT_MS);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('daemon closed before hello'));
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HELLO_BYTES) {
        cleanup();
        reject(new Error('daemon hello too large'));
        return;
      }
      const newline = buf.indexOf(0x0a);
      if (newline < 0) return;
      const line = buf.slice(0, newline).toString('utf-8').trim();
      const tail = buf.slice(newline + 1);
      if (tail.length > 0) socket.unshift(tail);
      cleanup();
      try {
        const parsed = JSON.parse(line) as DaemonHello;
        if (
          parsed?.protocol !== 1 ||
          typeof parsed.cartograph !== 'string' ||
          typeof parsed.pid !== 'number' ||
          typeof parsed.socketPath !== 'string'
        ) {
          reject(new Error('invalid daemon hello'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function pipeStdioToSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };

    process.stdin.on('data', (chunk) => {
      try {
        socket.write(chunk);
      } catch {
        finish();
      }
    });
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    socket.on('data', (chunk) => {
      try {
        process.stdout.write(chunk);
      } catch {
        finish();
      }
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveIdleTimeoutMs(): number {
  const raw = process.env['CARTOGRAPH_DAEMON_IDLE_TIMEOUT_MS'];
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_TIMEOUT_MS;
}
