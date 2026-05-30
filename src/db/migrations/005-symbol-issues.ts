import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add symbol_issues table for issue→symbol attribution from git history',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_issues (
        node_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('modified','added','removed')),
        PRIMARY KEY (node_id, issue_number, commit_sha, kind),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_issues_node ON symbol_issues(node_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_issues_issue ON symbol_issues(issue_number);
    `);
  },
};
