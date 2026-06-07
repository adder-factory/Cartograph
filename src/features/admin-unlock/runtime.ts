import * as fs from 'node:fs';

export interface LockFileDeps {
  existsSync: (filePath: string) => boolean;
  unlinkSync: (filePath: string) => void;
}

const DEFAULT_LOCK_FILE_DEPS: LockFileDeps = {
  existsSync: fs.existsSync,
  unlinkSync: fs.unlinkSync,
};

export function removeLockFileIfPresent(lockPath: string, deps: LockFileDeps = DEFAULT_LOCK_FILE_DEPS): boolean {
  if (!deps.existsSync(lockPath)) return false;
  deps.unlinkSync(lockPath);
  return true;
}
