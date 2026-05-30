import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Track call-site multiplicity on unresolved refs (siteCount + extraLines)',
  up: (db) => {
    // Some test fixtures build a partial DB by hand at an earlier
    // schema version and replay forward; they may not have the
    // unresolved_refs table at all (it gets created lazily from
    // schema.sql on real bootstraps). Guard so the migration is a
    // no-op for those paths instead of failing the whole upgrade.
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='unresolved_refs'").get();
    if (!tableExists) return;

    // Idempotent ADD COLUMN: other tests bootstrap a fresh DB (which
    // already has these columns from schema.sql) and then replay
    // migrations from v3, so a second ALTER would fail with
    // "duplicate column name".
    const cols = db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('site_count')) {
      db.exec('ALTER TABLE unresolved_refs ADD COLUMN site_count INTEGER NOT NULL DEFAULT 1');
    }
    if (!have.has('extra_lines')) {
      db.exec('ALTER TABLE unresolved_refs ADD COLUMN extra_lines TEXT');
    }
  },
};
