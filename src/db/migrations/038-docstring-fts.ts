import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add docstring_fts FTS5 virtual table over nodes.docstring for mode=intent search',
  up: (db) => {
    const hasNodes =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes'`).get() as { c: number })
        .c > 0;
    if (!hasNodes) return;
    const hasDocstringCol =
      (db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('nodes') WHERE name='docstring'`).get() as { c: number })
        .c > 0;
    if (!hasDocstringCol) return;

    db.exec(`
      DROP TRIGGER IF EXISTS docstring_fts_ai;
      DROP TRIGGER IF EXISTS docstring_fts_ad;
      DROP TRIGGER IF EXISTS docstring_fts_au;
      DROP TABLE IF EXISTS docstring_fts;
    `);

    db.exec(`
      CREATE VIRTUAL TABLE docstring_fts USING fts5(
        docstring,
        content='nodes',
        content_rowid='ROWID',
        tokenize='porter unicode61'
      );
    `);

    db.exec(`
      INSERT INTO docstring_fts(rowid, docstring)
        SELECT ROWID, docstring FROM nodes
         WHERE docstring IS NOT NULL AND docstring != '';
    `);

    db.exec(`
      CREATE TRIGGER docstring_fts_ai AFTER INSERT ON nodes
        WHEN NEW.docstring IS NOT NULL AND NEW.docstring != ''
      BEGIN
        INSERT INTO docstring_fts(rowid, docstring) VALUES (NEW.ROWID, NEW.docstring);
      END;

      CREATE TRIGGER docstring_fts_ad AFTER DELETE ON nodes
        WHEN OLD.docstring IS NOT NULL AND OLD.docstring != ''
      BEGIN
        INSERT INTO docstring_fts(docstring_fts, rowid, docstring) VALUES ('delete', OLD.ROWID, OLD.docstring);
      END;

      CREATE TRIGGER docstring_fts_au AFTER UPDATE OF docstring ON nodes BEGIN
        INSERT INTO docstring_fts(docstring_fts, rowid, docstring)
          SELECT 'delete', OLD.ROWID, OLD.docstring
           WHERE OLD.docstring IS NOT NULL AND OLD.docstring != '';
        INSERT INTO docstring_fts(rowid, docstring)
          SELECT NEW.ROWID, NEW.docstring
           WHERE NEW.docstring IS NOT NULL AND NEW.docstring != '';
      END;
    `);
  },
};
