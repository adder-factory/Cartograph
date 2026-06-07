import { describe, expect, it } from 'vitest';
import { storageMigrationSuccessMessage } from '../src/features/admin-storage-migrate/index.js';

describe('admin storage-migrate feature runtime', () => {
  it('renders a concise migration summary', () => {
    expect(
      storageMigrationSuccessMessage({
        tablesCopied: 3,
        rowsCopied: 42,
        sqliteBackupPath: '/repo/.cartograph/cartograph.db.sqlite-backup.2026',
        configPath: '/repo/.cartograph/config.json',
        postgresSchema: 'cartograph',
      }),
    ).toBe(
      'Migrated 42 rows across 3 tables to PostgreSQL schema "cartograph". SQLite backup: /repo/.cartograph/cartograph.db.sqlite-backup.2026',
    );
  });
});
