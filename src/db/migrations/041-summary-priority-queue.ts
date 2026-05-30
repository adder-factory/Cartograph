import type { MigrationModule } from './types.js';

/**
 * Demand-driven summary priority queueing. When intent-search misses a
 * query, the agent's last-resort signal is captured: enqueue the matching
 * unsummarised symbols for next-pass priority summarization.
 *
 * The queue is pull-based: the summariser consults it and front-loads those
 * nodes. Cascade-deleted with the parent node, so dead entries self-clean
 * on resync.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add summary_priority_queue table with enqueued_at index',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_priority_queue (
          node_id TEXT PRIMARY KEY,
          enqueued_at INTEGER NOT NULL,
          requested_count INTEGER NOT NULL DEFAULT 1,
          last_query TEXT,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_summary_priority_enqueued
          ON summary_priority_queue(enqueued_at DESC)
    `);
  },
};
