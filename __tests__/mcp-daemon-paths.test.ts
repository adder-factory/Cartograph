import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chmodDaemonSocket, preflightDaemonSocketForListen } from '../src/mcp/daemon.js';
import {
  decodeLockInfo,
  encodeLockInfo,
  getDaemonPidPath,
  getDaemonSocketPath,
  type DaemonLockInfo,
} from '../src/mcp/daemon-paths.js';

function withObjectPrototypeProperty<T>(key: string, value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous);
    else Reflect.deleteProperty(Object.prototype, key);
  }
}

describe('MCP daemon path helpers', () => {
  it('builds pid and socket paths from the project metadata directory', () => {
    const projectRoot = path.join(os.tmpdir(), 'cg-daemon-short-root');

    expect(getDaemonPidPath(projectRoot)).toBe(path.join(projectRoot, '.cartograph', 'daemon.pid'));
    if (process.platform !== 'win32') {
      expect(getDaemonSocketPath(projectRoot)).toBe(path.join(projectRoot, '.cartograph', 'daemon.sock'));
    }
  });

  it('falls back to the temp dir when a POSIX socket path would be too long', () => {
    if (process.platform === 'win32') return;
    const projectRoot = path.join(os.tmpdir(), 'cartograph-' + 'nested-'.repeat(20));

    const socketPath = getDaemonSocketPath(projectRoot);
    expect(socketPath.startsWith(os.tmpdir())).toBe(true);
    expect(socketPath.endsWith('.sock')).toBe(true);
  });

  it('round-trips structured lock info and accepts legacy pid-only locks', () => {
    const info: DaemonLockInfo = {
      pid: 123,
      version: '0.0.0-test',
      socketPath: '/tmp/cartograph-test.sock',
      startedAt: 456,
    };

    expect(decodeLockInfo(encodeLockInfo(info))).toEqual(info);
    expect(decodeLockInfo('789')).toEqual({ pid: 789, version: 'unknown', socketPath: '', startedAt: 0 });
    expect(decodeLockInfo('')).toBeNull();
    expect(decodeLockInfo('{ nope')).toBeNull();
  });

  it('rejects malformed daemon lock values instead of trusting the JSON shape', () => {
    const validBase: DaemonLockInfo = {
      pid: 123,
      version: '0.0.0-test',
      socketPath: '/tmp/cartograph-test.sock',
      startedAt: 456,
    };

    expect(decodeLockInfo(JSON.stringify({ ...validBase, pid: 12.5 }))).toBeNull();
    expect(decodeLockInfo(JSON.stringify({ ...validBase, startedAt: -1 }))).toBeNull();
    expect(decodeLockInfo('12.5')).toBeNull();
  });

  it('ignores inherited daemon lock fields while decoding structured locks', () => {
    withObjectPrototypeProperty('pid', 123, () => {
      withObjectPrototypeProperty('version', '0.0.0-polluted', () => {
        withObjectPrototypeProperty('socketPath', '/tmp/polluted.sock', () => {
          withObjectPrototypeProperty('startedAt', 456, () => {
            expect(decodeLockInfo('{}')).toBeNull();
          });
        });
      });
    });
  });

  it('chmod helper reports whether POSIX socket permissions were restricted', () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-chmod-'));
    try {
      const socketPath = path.join(dir, 'daemon.sock');
      fs.writeFileSync(socketPath, '');
      expect(chmodDaemonSocket(socketPath)).toBe(true);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(chmodDaemonSocket(path.join(dir, 'missing.sock'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflight removes stale POSIX socket files before listen', async () => {
    const removed: string[] = [];

    await expect(
      preflightDaemonSocketForListen('/tmp/cartograph-stale.sock', {
        platform: 'linux',
        unlink: (socketPath) => removed.push(socketPath),
      }),
    ).resolves.toBe('ready');

    expect(removed).toEqual(['/tmp/cartograph-stale.sock']);
  });

  it('preflight treats an active Windows named pipe as an existing daemon', async () => {
    await expect(
      preflightDaemonSocketForListen(String.raw`\\.\pipe\cartograph-test`, {
        platform: 'win32',
        probeWindowsNamedPipe: async () => true,
      }),
    ).resolves.toBe('active');
  });

  it('preflight allows Windows listen when the named pipe is not active', async () => {
    await expect(
      preflightDaemonSocketForListen(String.raw`\\.\pipe\cartograph-test`, {
        platform: 'win32',
        probeWindowsNamedPipe: async () => false,
      }),
    ).resolves.toBe('ready');
  });
});
