/**
 * Migration 071 — `idx_nodes_name_nocase` COLLATE NOCASE index.
 *
 * F#76 (2026-05-28). Verifies that:
 *
 *   1. Fresh DBs and migrated DBs both end up with the index in place.
 *   2. SQLite's planner actually USES the index for the
 *      `WHERE name = ? COLLATE NOCASE` shape — pinning the SCAN→SEARCH
 *      transition that justified the migration. A future change that
 *      drops the index OR adds a redundant collation-confounding column
 *      that defeats the planner would surface here, not as a silent
 *      perf regression in production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-071-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Migration 071 — nodes(name COLLATE NOCASE) index', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('creates idx_nodes_name_nocase on a fresh DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const db = conn.getDb();
      const idxList = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'")
        .all() as Array<{ name: string }>;
      expect(idxList.map((r) => r.name)).toContain('idx_nodes_name_nocase');

      // Confirm the index is COLLATE NOCASE-flavoured by reading the
      // CREATE INDEX DDL back from sqlite_master.
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_nodes_name_nocase'")
        .get() as { sql: string };
      expect(ddl.sql).toMatch(/COLLATE NOCASE/i);
    } finally {
      conn.close();
    }
  });

  it('the planner uses the index for `WHERE name = ? COLLATE NOCASE`', () => {
    // Pins the perf invariant: F#76's whole point was that the
    // supplement-candidates queries flip from SCAN nodes to SEARCH.
    // Without this assertion a future "drop the index, we don\'t need
    // it" PR would only show up as a silent slow query in production.
    const conn = DatabaseConnection.initialize(path.join(dir, 'plan.db'));
    try {
      const db = conn.getDb();
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name = ? COLLATE NOCASE')
        .all('foo') as Array<{ detail: string }>;
      const planText = plan.map((r) => r.detail).join(' | ');
      expect(planText).toMatch(/SEARCH\s+nodes\s+USING\s+(?:COVERING\s+)?INDEX\s+idx_nodes_name_nocase/);
      expect(planText).not.toMatch(/^SCAN nodes$/);
    } finally {
      conn.close();
    }
  });
});
