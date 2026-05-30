import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add test_names table + test_names_fts FTS5 over test descriptions for mode=intent search',
  up: (db) => {
    const hasFiles =
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='files'`).get() as { c: number })
        .c > 0;
    if (!hasFiles) return;

    db.exec(`
      DROP TRIGGER IF EXISTS test_names_fts_ai;
      DROP TRIGGER IF EXISTS test_names_fts_ad;
      DROP TRIGGER IF EXISTS test_names_fts_au;
      DROP TABLE IF EXISTS test_names_fts;
      DROP TABLE IF EXISTS test_names;
    `);

    db.exec(`
      CREATE TABLE test_names (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        description TEXT NOT NULL,
        FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX idx_test_names_file ON test_names(file_path);
    `);

    db.exec(`
      CREATE VIRTUAL TABLE test_names_fts USING fts5(
        description,
        content='test_names',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    db.exec(`
      CREATE TRIGGER test_names_fts_ai AFTER INSERT ON test_names BEGIN
        INSERT INTO test_names_fts(rowid, description) VALUES (NEW.id, NEW.description);
      END;

      CREATE TRIGGER test_names_fts_ad AFTER DELETE ON test_names BEGIN
        INSERT INTO test_names_fts(test_names_fts, rowid, description)
          VALUES ('delete', OLD.id, OLD.description);
      END;

      CREATE TRIGGER test_names_fts_au AFTER UPDATE ON test_names BEGIN
        INSERT INTO test_names_fts(test_names_fts, rowid, description)
          VALUES ('delete', OLD.id, OLD.description);
        INSERT INTO test_names_fts(rowid, description) VALUES (NEW.id, NEW.description);
      END;
    `);
  },
};
