import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isBunStandalonePath } from '../bun-standalone.js';
import { findNearestCartographRoot } from '../directory.js';
import { MCPServer } from './index.js';
import { SocketTransport } from './transport.js';
import type { McpServerProfile } from './profiles.js';
import { CARTOGRAPH_PACKAGE_VERSION } from './version.js';
import { isAcceptableDaemonHello, isDaemonConnectFailure, isDaemonLockPastStartupGrace } from './daemon-logic.js';
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
const DAEMON_LOCK_STARTUP_GRACE_MS = DAEMON_START_TIMEOUT_MS;
const WINDOWS_PIPE_PREFLIGHT_TIMEOUT_MS = 250;

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

interface DaemonRuntime {
  projectRoot: string;
  socketPath: string;
  mcp: MCPServer;
  server: net.Server | null;
  clients: number;
  idleTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

interface DaemonSocketTarget {
  socketPath: string;
  lock: DaemonLockInfo | null;
}

export function runSharedMcpDaemonProcess(options: SharedMcpDaemonOptions): Promise<void> {
  const projectRoot = resolveDaemonProjectRoot(options.projectPath);
  const lock = prepareDaemonLock(projectRoot);
  if (!lock.acquired) {
    process.stderr.write(`[Cartograph daemon] Existing daemon is active at ${lock.info.socketPath}; exiting child.\n`);
    process.exit(0);
  }

  const runtime = createDaemonRuntime(projectRoot, lock.info.socketPath, options);
  return preflightDaemonSocketForListen(runtime.socketPath).then((state) => {
    if (state === 'active') {
      process.stderr.write(
        `[Cartograph daemon] Existing daemon named pipe is active at ${runtime.socketPath}; exiting child.\n`,
      );
      cleanupDaemonRuntime(runtime);
      process.exit(0);
      return;
    }

    runtime.server = createDaemonServer(runtime);
    return listenDaemonServer(runtime.server, runtime.socketPath).then(() => {
      if (!chmodDaemonSocket(runtime.socketPath)) {
        process.stderr.write(
          `[Cartograph daemon] Warning: could not restrict daemon socket permissions for ${runtime.socketPath}.\n`,
        );
      }
      process.stderr.write(`[Cartograph daemon] Listening on ${runtime.socketPath} (pid ${process.pid}).\n`);
      void runtime.mcp.tryInitializeDefault(projectRoot);
      armDaemonIdleTimer(runtime);
      process.on('SIGINT', () => stopDaemon(runtime, 'SIGINT'));
      process.on('SIGTERM', () => stopDaemon(runtime, 'SIGTERM'));
    });
  });
}

function createDaemonRuntime(projectRoot: string, socketPath: string, options: SharedMcpDaemonOptions): DaemonRuntime {
  return {
    projectRoot,
    socketPath,
    mcp: new MCPServer({ ...options, projectPath: projectRoot }),
    server: null,
    clients: 0,
    idleTimer: null,
    stopping: false,
  };
}

function createDaemonServer(runtime: DaemonRuntime): net.Server {
  return net.createServer((socket) => attachDaemonClient(runtime, socket));
}

function attachDaemonClient(runtime: DaemonRuntime, socket: net.Socket): void {
  writeDaemonHello(socket, runtime.socketPath);
  let transport: SocketTransport;
  const onClose = (): void => {
    runtime.clients = Math.max(0, runtime.clients - 1);
    runtime.mcp.detachTransport(transport);
    if (runtime.clients === 0) armDaemonIdleTimer(runtime);
  };
  transport = new SocketTransport(socket, onClose);
  runtime.clients++;
  disarmDaemonIdleTimer(runtime);
  runtime.mcp.attachTransport(transport);
}

function writeDaemonHello(socket: net.Socket, socketPath: string): void {
  const hello: DaemonHello = {
    cartograph: CARTOGRAPH_PACKAGE_VERSION,
    pid: process.pid,
    socketPath,
    protocol: 1,
  };
  socket.write(`${JSON.stringify(hello)}\n`);
}

function listenDaemonServer(server: net.Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function armDaemonIdleTimer(runtime: DaemonRuntime): void {
  if (runtime.idleTimer || runtime.stopping) return;
  const timeoutMs = resolveIdleTimeoutMs();
  if (timeoutMs <= 0) return;
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null;
    if (runtime.clients === 0) stopDaemon(runtime, 'idle timeout');
    else armDaemonIdleTimer(runtime);
  }, timeoutMs);
  runtime.idleTimer.unref?.();
}

function disarmDaemonIdleTimer(runtime: DaemonRuntime): void {
  if (!runtime.idleTimer) return;
  clearTimeout(runtime.idleTimer);
  runtime.idleTimer = null;
}

function stopDaemon(runtime: DaemonRuntime, reason: string): void {
  if (runtime.stopping) return;
  runtime.stopping = true;
  disarmDaemonIdleTimer(runtime);
  process.stderr.write(`[Cartograph daemon] Shutting down (${reason}; clients=${runtime.clients}).\n`);
  runtime.server?.close();
  runtime.mcp.stop(false);
  cleanupDaemonRuntime(runtime);
  process.exit(0);
}

export async function runSharedMcpDaemonProxy(options: SharedMcpDaemonOptions): Promise<'proxied' | 'fallback'> {
  const projectRoot = resolveDaemonProjectRoot(options.projectPath);
  const socket = await ensureDaemonSocket(projectRoot, options);
  if (!socket) return 'fallback';
  if (process.env['CARTOGRAPH_MCP_LOG_ATTACH'] === '1') {
    process.stderr.write(`[Cartograph MCP] Attached to shared daemon for ${projectRoot}.\n`);
  }
  await pipeStdioToSocket(socket);
  process.exit(0);
}

function resolveDaemonProjectRoot(projectPath: string | undefined): string {
  const start = path.resolve(projectPath ?? process.cwd());
  return findNearestCartographRoot(start) ?? start;
}

async function ensureDaemonSocket(projectRoot: string, options: SharedMcpDaemonOptions): Promise<net.Socket | null> {
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

function connectExistingDaemon(projectRoot: string): Promise<net.Socket | null> {
  const target = resolveDaemonSocketTarget(projectRoot);
  if (!target) return Promise.resolve(null);
  const socket = net.createConnection(target.socketPath);
  return readHelloLine(socket)
    .then((hello) => acceptDaemonSocket(socket, hello))
    .catch((err) => {
      socket.destroy();
      retireUnreachableDaemonLock(projectRoot, target.lock, err);
      return null;
    });
}

function acceptDaemonSocket(socket: net.Socket, hello: DaemonHello): net.Socket | null {
  if (isAcceptableDaemonHello(hello.cartograph, hello.protocol, CARTOGRAPH_PACKAGE_VERSION)) return socket;
  process.stderr.write(
    `[Cartograph MCP] Shared daemon version/protocol mismatch ` +
      `(daemon ${hello.cartograph}, local ${CARTOGRAPH_PACKAGE_VERSION}); using direct mode.\n`,
  );
  socket.destroy();
  return null;
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
  return isBunStandalonePath(fileURLToPath(import.meta.url));
}

function tryAcquireDaemonLock(
  projectRoot: string,
): { acquired: true; info: DaemonLockInfo } | { acquired: false; info: DaemonLockInfo } {
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

function prepareDaemonLock(
  projectRoot: string,
): { acquired: true; info: DaemonLockInfo } | { acquired: false; info: DaemonLockInfo } {
  fs.mkdirSync(path.dirname(getDaemonPidPath(projectRoot)), { recursive: true });
  return tryAcquireDaemonLock(projectRoot);
}

function resolveDaemonSocketTarget(projectRoot: string): DaemonSocketTarget | null {
  const lock = readLockInfo(projectRoot);
  if (lock && !isProcessAlive(lock.pid)) {
    removeStaleLock(projectRoot, lock);
    return null;
  }
  const socketPath = lock?.socketPath || getDaemonSocketPath(projectRoot);
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
    retireUnreachableDaemonLock(projectRoot, lock, new Error(`daemon socket is missing at ${socketPath}`));
    return null;
  }
  return { socketPath, lock };
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

function retireUnreachableDaemonLock(projectRoot: string, info: DaemonLockInfo | null, err: unknown): void {
  if (!info || !isDaemonConnectFailure(err) || !isDaemonLockPastStartupGraceInfo(info)) return;
  process.stderr.write(
    `[Cartograph MCP] Removing stale daemon lock for pid ${info.pid}; ` +
      `socket is unreachable after startup grace. Retrying daemon start.\n`,
  );
  removeStaleLock(projectRoot, info);
}

function isDaemonLockPastStartupGraceInfo(info: DaemonLockInfo): boolean {
  return isDaemonLockPastStartupGrace(info.startedAt, DAEMON_LOCK_STARTUP_GRACE_MS, Date.now());
}

type DaemonSocketPreflightState = 'ready' | 'active';

interface DaemonSocketPreflightDeps {
  platform?: NodeJS.Platform;
  unlink?: (socketPath: string) => void;
  probeWindowsNamedPipe?: (socketPath: string) => Promise<boolean>;
}

export async function preflightDaemonSocketForListen(
  socketPath: string,
  deps: DaemonSocketPreflightDeps = {},
): Promise<DaemonSocketPreflightState> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const active = await (deps.probeWindowsNamedPipe ?? isWindowsNamedPipeActive)(socketPath);
    return active ? 'active' : 'ready';
  }
  try {
    (deps.unlink ?? fs.unlinkSync)(socketPath);
  } catch {
    /* stale socket absent */
  }
  return 'ready';
}

function isWindowsNamedPipeActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(false), WINDOWS_PIPE_PREFLIGHT_TIMEOUT_MS);
    timer.unref?.();

    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(isBusyWindowsNamedPipeError(err)));
  });
}

function isBusyWindowsNamedPipeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM';
}

export function chmodDaemonSocket(socketPath: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    fs.chmodSync(socketPath, 0o600);
    return true;
  } catch {
    return false;
  }
}

function cleanupDaemonRuntime(runtime: DaemonRuntime): void {
  try {
    if (process.platform !== 'win32') fs.unlinkSync(runtime.socketPath);
  } catch {
    /* already gone */
  }
  try {
    const current = readLockInfo(runtime.projectRoot);
    if (current?.pid === process.pid) fs.unlinkSync(getDaemonPidPath(runtime.projectRoot));
  } catch {
    /* already gone */
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
      const line = buf.subarray(0, newline).toString('utf-8').trim();
      const tail = buf.subarray(newline + 1);
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
