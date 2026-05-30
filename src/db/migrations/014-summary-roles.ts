import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add role + role_model columns on symbol_summaries for LLM role classification',
  up: (db) => {
    // Post-migration-049 (Design C) symbol_summaries is a VIEW;
    // ALTER TABLE and CREATE INDEX both error against a view. Skip
    // when the entity is already the post-049 view — migration 040
    // already moved roles to nodes, so this migration is a no-op
    // in the forward-replay scenario.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_summaries'").get() as
      | { type: string }
      | undefined;
    if (existing && existing.type === 'view') return;
    const cols = db.prepare(`PRAGMA table_info(symbol_summaries);`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'role')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN role TEXT;`);
    }
    if (!cols.some((c) => c.name === 'role_model')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN role_model TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_role ON symbol_summaries(role);`);
  },
};
