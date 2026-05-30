import type { MigrationModule } from './types.js';

/**
 * Stage 7 #2 — commit-intent persistence.
 *
 * Stores the classified intent for each commit SHA encountered by
 * the cochange miner. Lookups are by SHA for join-with-co-changes
 * filtering ("show me only refactor co-changes in this file"). A
 * commit lives once in the table; re-classification overwrites.
 *
 * The classifier itself is heuristic-only (`src/llm/commit-intent.ts`),
 * so re-running it is cheap; the persistence layer just memoises so
 * downstream queries don't re-parse the message every read.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add commit_intents table for Stage 7 #2 commit-intent persistence',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS commit_intents (
        sha    TEXT PRIMARY KEY,
        intent TEXT NOT NULL,
        score  REAL NOT NULL,
        seen_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commit_intents_intent ON commit_intents(intent)`);
  },
};
