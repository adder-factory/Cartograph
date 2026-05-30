import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add centrality on nodes; per-file churn metrics on files',
  up: (db) => {
    // ALTER TABLE ADD COLUMN is not idempotent on SQLite — guard with
    // PRAGMA table_info so re-running after a partial DDL failure (or
    // landing alongside another migration that touches the same files
    // columns) does not throw "duplicate column name".
    const tableExists = (name: string): boolean =>
      (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { c: number })
        .c > 0;

    if (tableExists('nodes')) {
      const nodeCols = db.prepare(`PRAGMA table_info(nodes);`).all() as Array<{ name: string }>;
      if (!nodeCols.some((c) => c.name === 'centrality')) {
        db.exec(`ALTER TABLE nodes ADD COLUMN centrality REAL DEFAULT NULL;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_centrality ON nodes(centrality DESC);`);
    }

    if (tableExists('files')) {
      const fileCols = db.prepare(`PRAGMA table_info(files);`).all() as Array<{ name: string }>;
      if (!fileCols.some((c) => c.name === 'commit_count')) {
        db.exec(`ALTER TABLE files ADD COLUMN commit_count INTEGER NOT NULL DEFAULT 0;`);
      }
      if (!fileCols.some((c) => c.name === 'loc')) {
        db.exec(`ALTER TABLE files ADD COLUMN loc INTEGER NOT NULL DEFAULT 0;`);
      }
      if (!fileCols.some((c) => c.name === 'first_seen_ts')) {
        db.exec(`ALTER TABLE files ADD COLUMN first_seen_ts INTEGER DEFAULT NULL;`);
      }
      if (!fileCols.some((c) => c.name === 'last_touched_ts')) {
        db.exec(`ALTER TABLE files ADD COLUMN last_touched_ts INTEGER DEFAULT NULL;`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_files_commit_count ON files(commit_count DESC);
        CREATE INDEX IF NOT EXISTS idx_files_last_touched ON files(last_touched_ts DESC);
      `);
    }
  },
};
