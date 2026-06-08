import { describe, expect, it } from 'vitest';
import { storageMigrationSuccessMessage } from '../src/features/admin-storage-migrate/index.js';

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
