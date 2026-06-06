import * as fs from 'node:fs';

export interface LockFileDeps {
  existsSync: (filePath: string) => boolean;
  unlinkSync: (filePath: string) => void;
}

export function removeLockFileIfPresent(
  lockPath: string,
  deps: LockFileDeps = { existsSync: fs.existsSync, unlinkSync: fs.unlinkSync },
): boolean {
  if (!deps.existsSync(lockPath)) return false;
  deps.unlinkSync(lockPath);
  return true;
}
