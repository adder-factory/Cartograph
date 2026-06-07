import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCartographDir } from '../directory.js';

const POSIX_SOCKET_PATH_LIMIT = 100;

export interface DaemonLockInfo {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
}

export function getDaemonPidPath(projectRoot: string): string {
  return path.join(getCartographDir(projectRoot), 'daemon.pid');
}

export function getDaemonSocketPath(projectRoot: string): string {
  const hash = projectHash(projectRoot);
  if (process.platform === 'win32') return String.raw`\\.\pipe\cartograph-${hash}`;

  const inProject = path.join(getCartographDir(projectRoot), 'daemon.sock');
  if (inProject.length <= POSIX_SOCKET_PATH_LIMIT) return inProject;
  return path.join(os.tmpdir(), `cartograph-${hash}.sock`);
}

export function encodeLockInfo(info: DaemonLockInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`;
}

export function decodeLockInfo(raw: string): DaemonLockInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<DaemonLockInfo> | number;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
      return { pid: parsed, version: 'unknown', socketPath: '', startedAt: 0 };
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.pid === 'number' &&
      typeof parsed.version === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as DaemonLockInfo;
    }
  } catch {
    const pid = Number(trimmed);
    if (Number.isFinite(pid) && pid > 0) return { pid, version: 'unknown', socketPath: '', startedAt: 0 };
  }
  return null;
}

function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}
