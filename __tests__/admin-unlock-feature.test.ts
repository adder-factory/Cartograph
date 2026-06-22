import { describe, expect, it } from 'vitest';
import { registerAdminUnlockCommand, removeLockFileIfPresent } from '../src/features/admin-unlock/index.js';

describe('admin unlock feature runtime', () => {
  it('removes a lock file only when present', () => {
    const calls: string[] = [];
    expect(
      removeLockFileIfPresent('/repo/.cartograph/cartograph.lock', {
        existsSync: () => false,
        unlinkSync: (filePath) => calls.push(`unlink:${filePath}`),
      }),
    ).toBe(false);
    expect(calls).toEqual([]);

    expect(
      removeLockFileIfPresent('/repo/.cartograph/cartograph.lock', {
        existsSync: () => true,
        unlinkSync: (filePath) => calls.push(`unlink:${filePath}`),
      }),
    ).toBe(true);
    expect(calls).toEqual(['unlink:/repo/.cartograph/cartograph.lock']);
  });
});

describe('admin unlock feature CLI', () => {
  it('reports no-op and removed-lock outcomes', async () => {
    let action: ((pathArg: string | undefined) => Promise<void>) | undefined;
    const calls: string[] = [];
    let hasLock = false;

    registerAdminUnlockCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      getCartographDir: (projectPath) => `${projectPath}/.cartograph`,
      removeLockFileIfPresent: (lockPath) => {
        calls.push(`remove:${lockPath}`);
        return hasLock;
      },
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });

    expect(action).toBeDefined();
    await action!('/repo');
    hasLock = true;
    await action!('/repo');

    expect(calls).toEqual([
      'remove:/repo/.cartograph/cartograph.lock',
      'info:No lock file found — nothing to do',
      'remove:/repo/.cartograph/cartograph.lock',
      'success:Removed lock file. You can now run indexing again.',
    ]);
  });

  it('sets exitCode instead of hard-exiting when lock removal throws', async () => {
    let action: ((pathArg: string | undefined) => Promise<void>) | undefined;
    const calls: string[] = [];
    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    let exitCalled = false;
    let observedExitCode: string | number | undefined;

    registerAdminUnlockCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      getCartographDir: (projectPath) => `${projectPath}/.cartograph`,
      removeLockFileIfPresent: () => {
        throw new Error('permission denied');
      },
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });

    expect(action).toBeDefined();
    process.exitCode = 0;
    process.exit = (code?: string | number | null | undefined): never => {
      exitCalled = true;
      throw new Error(`process.exit(${String(code)})`);
    };

    try {
      await action!('/repo');
      observedExitCode = process.exitCode;
    } finally {
      process.exit = originalExit;
      // `?? 0`: under Bun, `process.exitCode = undefined` does NOT clear a
      // previously-set code, so restoring the (undefined) original would leak
      // the SUT's exitCode=1 to the test process — passing tests, exit 1.
      process.exitCode = originalExitCode ?? 0;
    }

    expect(exitCalled).toBe(false);
    expect(observedExitCode).toBe(1);
    expect(calls).toEqual(['error:Failed to remove lock: permission denied']);
  });
});

function fakeCommand(setAction: (fn: (pathArg: string | undefined) => Promise<void>) => void) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    action(fn: (pathArg: string | undefined) => Promise<void>) {
      setAction(fn);
      return this;
    },
  };
}
