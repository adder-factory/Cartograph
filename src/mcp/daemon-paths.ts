import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { getCartographDir } from '../directory.js';
import { asJsonObject } from '../json-object.js';

const POSIX_SOCKET_PATH_LIMIT = 100;

const daemonLockInfoSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string().min(1),
  socketPath: z.string(),
  startedAt: z.number().nonnegative(),
});

const legacyDaemonPidSchema = z.number().int().positive();

export type DaemonLockInfo = z.infer<typeof daemonLockInfoSchema>;

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
    const parsed: unknown = JSON.parse(trimmed);
    const legacy = legacyDaemonPidSchema.safeParse(parsed);
    if (legacy.success) return { pid: legacy.data, version: 'unknown', socketPath: '', startedAt: 0 };
    const lockInput = asJsonObject(parsed);
    if (!lockInput) return null;
    const lock = daemonLockInfoSchema.safeParse(lockInput);
    if (lock.success) return lock.data;
  } catch {
    const pid = Number(trimmed);
    const legacy = legacyDaemonPidSchema.safeParse(pid);
    if (legacy.success) return { pid: legacy.data, version: 'unknown', socketPath: '', startedAt: 0 };
  }
  return null;
}

function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}
