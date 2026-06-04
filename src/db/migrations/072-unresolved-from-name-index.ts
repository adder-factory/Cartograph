import type { MigrationModule } from './types.js';

/**
 * Close fresh-vs-upgraded schema drift for unresolved_refs.
 *
 * `schema.sql` has carried `idx_unresolved_from_name` on
 * `(from_node_id, reference_name)`, but the migration chain never added
 * it. Fresh installs therefore had the composite lookup index while
 * upgraded installs did not. The historical chain shape test now
 * compares indexes against a fresh DB and catches this drift.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add missing idx_unresolved_from_name composite index to upgraded DBs',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='unresolved_refs'").get();
    if (!tableExists) return;
    const cols = new Set(
      (db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>).map((col) => col.name),
    );
    if (!(cols.has('from_node_id') && cols.has('reference_name'))) return;
    db.exec('CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name)');
  },
};
