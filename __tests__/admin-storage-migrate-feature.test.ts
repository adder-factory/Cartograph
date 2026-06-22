import { describe, expect, it, vi } from 'vitest';
import {
  registerAdminStorageMigrateCommand,
  storageMigrationSuccessMessage,
  type AdminStorageMigrateCommandDeps,
} from '../src/features/admin-storage-migrate/index.js';

interface StorageMigrateActionOptions {
  databaseProvider?: string;
  databaseUrl?: string;
  databaseSchema?: string;
  databasePgvector?: string;
  databaseMaxConnections?: string;
  databaseQueryTimeoutMs?: string;
  databaseConnectionTimeoutSeconds?: string;
  databaseSsl?: boolean;
  force?: boolean;
}

type StorageMigrateAction = (pathArg: string | undefined, options: StorageMigrateActionOptions) => Promise<void>;

describe('admin storage-migrate feature runtime', () => {
  it('renders a concise migration summary', () => {
    expect(
      storageMigrationSuccessMessage({
        tablesCopied: 3,
        rowsCopied: 42,
        sourceProvider: 'sqlite',
        targetProvider: 'postgres',
        sqliteBackupPath: '/repo/.cartograph/cartograph.db.sqlite-backup.2026',
        configPath: '/repo/.cartograph/config.json',
        postgresSchema: 'cartograph',
      }),
    ).toBe(
      'Migrated 42 rows across 3 tables to PostgreSQL schema "cartograph". SQLite backup: /repo/.cartograph/cartograph.db.sqlite-backup.2026',
    );
  });

  it('renders a concise reverse migration summary', () => {
    expect(
      storageMigrationSuccessMessage({
        tablesCopied: 3,
        rowsCopied: 42,
        sourceProvider: 'postgres',
        targetProvider: 'sqlite',
        sqlitePath: '/repo/.cartograph/cartograph.db',
        configPath: '/repo/.cartograph/config.json',
        postgresSchema: 'cartograph',
        postgresSentinelBackupPath: '/repo/.cartograph/cartograph.db.postgres-sentinel-backup.2026',
        configBackupPath: '/repo/.cartograph/config.json.pre-sqlite-2026.bak',
      }),
    ).toBe(
      'Migrated 42 rows across 3 tables from PostgreSQL schema "cartograph" to SQLite database /repo/.cartograph/cartograph.db. PostgreSQL sentinel backup: /repo/.cartograph/cartograph.db.postgres-sentinel-backup.2026',
    );
  });
});

describe('admin storage-migrate feature CLI', () => {
  it('reports invalid database options without running a migration or hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const calls: string[] = [];
      const action = registerAction({
        migrateSqliteProjectToPostgres: async () => {
          calls.push('sqlite-to-postgres');
          throw new Error('migration should not run');
        },
        migratePostgresProjectToSqlite: async () => {
          calls.push('postgres-to-sqlite');
          throw new Error('migration should not run');
        },
        error: (message) => calls.push(`error:${message}`),
      });

      await action('/repo', {});

      expect(calls).toEqual([
        'error:PostgreSQL database provider requires `database.url` in .cartograph/config.json, CARTOGRAPH_DATABASE_URL, or DATABASE_URL.',
      ]);
      expect(process.exitCode).toBe(1);
    });
  });

  it('renders migration failures without hard-exiting', async () => {
    await withProcessExitGuard(async () => {
      const calls: string[] = [];
      const action = registerAction({
        migrateSqliteProjectToPostgres: async ({ projectPath, database, force }) => {
          calls.push(`sqlite-to-postgres:${projectPath}:${database.provider}:${database.schema}:${String(force)}`);
          return {
            ok: false,
            exitCode: 1,
            error: {
              code: 'target-not-empty',
              message: 'Target schema is not empty.',
              remediation: 'Use --force to recreate it.',
            },
          };
        },
        migratePostgresProjectToSqlite: async () => {
          calls.push('postgres-to-sqlite');
          throw new Error('reverse migration should not run');
        },
        error: (message) => calls.push(`error:${message}`),
      });

      await action('/repo', {
        databaseUrl: 'postgres://cartograph:cartograph@localhost:5432/cartograph',
        databaseSchema: 'cartograph',
        force: true,
      });

      expect(calls).toEqual([
        'sqlite-to-postgres:/repo:postgres:cartograph:true',
        'error:Target schema is not empty. Use --force to recreate it.',
      ]);
      expect(process.exitCode).toBe(1);
    });
  });

  it('runs the SQLite target branch and reports success', async () => {
    const calls: string[] = [];
    const action = registerAction({
      migratePostgresProjectToSqlite: async ({ projectPath }) => {
        calls.push(`postgres-to-sqlite:${projectPath}`);
        return {
          ok: true,
          summary: {
            tablesCopied: 1,
            rowsCopied: 1,
            sourceProvider: 'postgres',
            targetProvider: 'sqlite',
            sqlitePath: '/repo/.cartograph/cartograph.db',
            configPath: '/repo/.cartograph/config.json',
            postgresSchema: 'cartograph',
            postgresSentinelBackupPath: '/repo/.cartograph/cartograph.db.postgres-sentinel-backup.2026',
            configBackupPath: '/repo/.cartograph/config.json.pre-sqlite-2026.bak',
          },
        };
      },
      migrateSqliteProjectToPostgres: async () => {
        calls.push('sqlite-to-postgres');
        throw new Error('forward migration should not run');
      },
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
    });

    await action('/repo', { databaseProvider: 'sqlite' });

    expect(calls).toEqual([
      'postgres-to-sqlite:/repo',
      'success:Migrated 1 row across 1 table from PostgreSQL schema "cartograph" to SQLite database /repo/.cartograph/cartograph.db. PostgreSQL sentinel backup: /repo/.cartograph/cartograph.db.postgres-sentinel-backup.2026',
      'info:Updated config: /repo/.cartograph/config.json',
      'info:Restart any MCP server still attached to the old postgres database.',
    ]);
  });
});

function registerAction(overrides: Partial<AdminStorageMigrateCommandDeps>): StorageMigrateAction {
  let action: StorageMigrateAction | undefined;
  registerAdminStorageMigrateCommand({
    adminCmd: fakeCommand((fn) => {
      action = fn;
    }),
    resolveProjectPath: (pathArg) => pathArg ?? '/repo',
    success: () => {},
    info: () => {},
    error: () => {},
    migratePostgresProjectToSqlite: async () => {
      throw new Error('postgres-to-sqlite migration should be explicitly provided by the test');
    },
    migrateSqliteProjectToPostgres: async () => {
      throw new Error('sqlite-to-postgres migration should be explicitly provided by the test');
    },
    ...overrides,
  });
  if (!action) throw new Error('storage-migrate action was not registered');
  return action;
}

function fakeCommand(setAction: (fn: StorageMigrateAction) => void) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(fn: StorageMigrateAction) {
      setAction(fn);
      return this;
    },
  };
}

async function withProcessExitGuard(run: () => Promise<void>): Promise<void> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await run();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    process.exitCode = 0;
  }
}
