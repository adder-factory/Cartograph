import type { MigrationModule } from './types.js';
import { buildNameSubwords } from '../../utils.js';

export const MIGRATION: MigrationModule = {
  description: 'Add name_subwords + Porter stemmer to FTS so natural-language and partial-identifier queries work',
  up: (db) => {
    // Synthetic test DBs may not have the nodes table — skip cleanly.
    const hasNodes =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes'`).get() as { c: number })
        .c > 0;
    if (!hasNodes) return;

    // 1. Add the synthetic subwords column to nodes — idempotent so a
    //    re-run after a partial DDL failure (SQLite auto-commits DDL,
    //    so only some of these statements may have landed) doesn't fail
    //    with "duplicate column name".
    const cols = db.prepare(`PRAGMA table_info(nodes);`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'name_subwords')) {
      db.exec(`ALTER TABLE nodes ADD COLUMN name_subwords TEXT;`);
    }

    // 2. Drop the existing FTS table + triggers. We can't ALTER the
    //    FTS5 tokenizer in place; recreating is the supported path.
    db.exec(`
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
      DROP TABLE IF EXISTS nodes_fts;
    `);

    // 3. Recreate the FTS table — but DO NOT recreate the triggers yet.
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id, name, qualified_name, docstring, signature, name_subwords,
        content='nodes',
        content_rowid='rowid',
        tokenize="porter unicode61"
      );
    `);

    // 4. Backfill name_subwords.
    const rows = db.prepare('SELECT id, name FROM nodes').all() as Array<{ id: string; name: string }>;
    const update = db.prepare('UPDATE nodes SET name_subwords = ? WHERE id = ?');
    for (const row of rows) {
      update.run(buildNameSubwords(row.name), row.id);
    }

    // 5. Rebuild the FTS index from the content table.
    db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');`);

    // 6. Re-attach the triggers — fire on subsequent application writes.
    db.exec(`
      CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
        VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
      END;

      CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
        VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
      END;

      CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
        VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
        INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
        VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
      END;
    `);
  },
};
