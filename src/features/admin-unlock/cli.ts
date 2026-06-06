import * as path from 'node:path';
import { errMsg } from '../../errors.js';
import { removeLockFileIfPresent } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface AdminUnlockCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  getCartographDir: (projectPath: string) => string;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
  removeLockFileIfPresent?: (lockPath: string) => boolean;
}

export function registerAdminUnlockCommand(deps: AdminUnlockCommandDeps): void {
  const { adminCmd, error, getCartographDir, info, isInitialized, resolveProjectPath, success } = deps;
  adminCmd
    .command('unlock [path]')
    .description(
      "Remove a stale lock file that is blocking indexing (mirrors cartograph_admin MCP tool with action='unlock')",
    )
    .action(async (pathArg: string | undefined) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          return;
        }

        const lockPath = path.join(getCartographDir(projectPath), 'cartograph.lock');

        if (!(deps.removeLockFileIfPresent ?? removeLockFileIfPresent)(lockPath)) {
          info('No lock file found — nothing to do');
          return;
        }

        success('Removed lock file. You can now run indexing again.');
      } catch (err) {
        error(`Failed to remove lock: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}
