import { describe, expect, it } from 'vitest';
import { migrationSuccessMessage, registerAdminMigrateCommand } from '../src/features/admin-migrate/index.js';

describe('admin migrate feature runtime', () => {
  it('renders current and migrated outcomes', () => {
    expect(migrationSuccessMessage({ migratedThisRun: false, version: 99 })).toBe(
      'Schema already current (v99). Nothing to migrate.',
    );
    expect(migrationSuccessMessage({ migratedThisRun: true, version: 99 })).toBe('Schema migrated to v99.');
    expect(migrationSuccessMessage({ migratedThisRun: true })).toBe('Schema migrated to v?.');
  });
});

describe('admin migrate feature CLI', () => {
  it('reports already-current schema when the first open succeeds', async () => {
    const { action, calls } = registerTestCommand(false);

    await action('/repo');

    expect(calls).toEqual(['open:/repo:{}', 'success:Schema already current (v99). Nothing to migrate.', 'close']);
  });

  it('reopens with autoMigrate when the first open fails', async () => {
    const { action, calls } = registerTestCommand(true);

    await action('/repo');

    expect(calls).toEqual([
      'open:/repo:{}',
      'open:/repo:{"autoMigrate":true}',
      'success:Schema migrated to v99.',
      'info:Restart any MCP server still bound to the old schema (its tools will return "stale code, restart" until you do).',
      'close',
    ]);
  });
});

function registerTestCommand(firstOpenFails: boolean) {
  let action: ((pathArg: string | undefined) => Promise<void>) | undefined;
  const calls: string[] = [];
  let opened = false;

  registerAdminMigrateCommand({
    adminCmd: fakeCommand((fn) => {
      action = fn;
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    isInitialized: () => true,
    loadCartograph: async () => ({
      default: {
        open: async (projectPath, opts = {}) => {
          calls.push(`open:${projectPath}:${JSON.stringify(opts)}`);
          if (firstOpenFails && !opened) {
            opened = true;
            throw new Error('behind');
          }
          opened = true;
          return {
            db: { getSchemaVersion: () => ({ version: 99 }) },
            close: () => calls.push('close'),
          };
        },
      },
    }),
    success: (message) => calls.push(`success:${message}`),
    info: (message) => calls.push(`info:${message}`),
    error: (message) => calls.push(`error:${message}`),
  });

  if (!action) throw new Error('migrate action was not registered');
  return { action, calls };
}

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
