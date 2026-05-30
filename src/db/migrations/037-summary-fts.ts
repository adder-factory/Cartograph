import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add summary_fts FTS5 virtual table over symbol_summaries for mode=intent search',
  up: (db) => {
    const hasSummaries =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='symbol_summaries'`).get() as {
          c: number;
        }
      ).c > 0;
    if (!hasSummaries) return;

    db.exec(`
      DROP TRIGGER IF EXISTS summary_fts_ai;
      DROP TRIGGER IF EXISTS summary_fts_ad;
      DROP TRIGGER IF EXISTS summary_fts_au;
      DROP TABLE IF EXISTS summary_fts;
    `);

    db.exec(`
      CREATE VIRTUAL TABLE summary_fts USING fts5(
        summary,
        content='symbol_summaries',
        content_rowid='ROWID',
        tokenize='porter unicode61'
      );
    `);

    db.exec(`INSERT INTO summary_fts(rowid, summary) SELECT ROWID, summary FROM symbol_summaries;`);

    db.exec(`
      CREATE TRIGGER summary_fts_ai AFTER INSERT ON symbol_summaries BEGIN
        INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
      END;

      CREATE TRIGGER summary_fts_ad AFTER DELETE ON symbol_summaries BEGIN
        INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES ('delete', OLD.ROWID, OLD.summary);
      END;

      CREATE TRIGGER summary_fts_au AFTER UPDATE ON symbol_summaries BEGIN
        INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES ('delete', OLD.ROWID, OLD.summary);
        INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
      END;
    `);
  },
};
