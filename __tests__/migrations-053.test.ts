/**
 * Migration 053 — last_ref_at columns + prune-store cold-orphan GC.
 *
 * Verifies:
 *   - Migration adds `last_ref_at` to summary_store + embedding_store.
 *   - Refresh triggers bump `last_ref_at` on the parent store row
 *     when a new ref is inserted (revert/rename reuse path).
 *   - `pruneOrphanStoreRows` only deletes rows that are BOTH orphan
 *     AND older than the cutoff. Active refs prevent eviction
 *     regardless of age; recent orphans are preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { pruneOrphanStoreRows, MS_PER_DAY, PRUNE_STORE_DEFAULT_DAYS } from '../src/db/queries-summaries.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

// Test fixtures expressed in days for readability; converted to ms
// at use via the production MS_PER_DAY constant so test ↔ runtime
// stay in lock-step if someone ever changes the unit.
const NINETY_DAYS_MS = 90 * MS_PER_DAY;
const FIVE_DAYS_MS = 5 * MS_PER_DAY;
const PRUNE_THRESHOLD_MS = PRUNE_STORE_DEFAULT_DAYS * MS_PER_DAY;
// Tolerance for "this happened during the test" — wide enough to
// absorb startup + DB I/O slack, narrow enough to catch a stale
// last_ref_at value not being bumped by the trigger.
const RECENT_TOLERANCE_MS = 5_000;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-053-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function seedFile(qb: QueryBuilder, fpath: string): void {
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

function seedNodes(qb: QueryBuilder): void {
  // Seed the parent files row for the nodes.file_path FK (migration 056).
  seedFile(qb, 'src/a.ts');
  qb.db.exec(`
    INSERT INTO nodes (
      id, name, qualified_name, kind, language, file_path,
      start_line, end_line, start_column, end_column, updated_at, body_hash
    )
    VALUES
      ('n_active',      'active_fn', 'active_fn', 'function', 'typescript', 'src/a.ts', 1,  10, 0, 0, 0, 'body_active'),
      ('n_will_orphan', 'orphan_fn', 'orphan_fn', 'function', 'typescript', 'src/a.ts', 11, 20, 0, 0, 0, 'body_will_orphan');
  `);
}

describe('Migration 053 — last_ref_at + prune-store', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('adds last_ref_at columns to both store tables', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'cols.db'));
    try {
      const summaryCols = (
        dbConn.getDb().prepare("PRAGMA table_info('summary_store')").all() as Array<{ name: string }>
      ).map((c) => c.name);
      const embedCols = (
        dbConn.getDb().prepare("PRAGMA table_info('embedding_store')").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(summaryCols).toContain('last_ref_at');
      expect(embedCols).toContain('last_ref_at');
    } finally {
      dbConn.close();
    }
  });

  it('refresh trigger bumps last_ref_at when a new ref points at an existing store row', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'trigger.db'));
    try {
      const qb = new QueryBuilder(dbConn.getDb());
      seedNodes(qb);

      // Seed an old store row (90 days old).
      const oldMs = Date.now() - NINETY_DAYS_MS;
      qb.db
        .prepare(
          `INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('body_active', 'm', 'summary text', oldMs, oldMs);

      // Insert a fresh ref pointing at it (revert/rename reuse path).
      qb.db
        .prepare(`INSERT INTO summary_refs (node_id, body_hash, model) VALUES (?, ?, ?)`)
        .run('n_active', 'body_active', 'm');

      const after = qb.db.prepare(`SELECT last_ref_at FROM summary_store WHERE body_hash = 'body_active'`).get() as {
        last_ref_at: number;
      };
      expect(after.last_ref_at).toBeGreaterThan(Date.now() - RECENT_TOLERANCE_MS);
    } finally {
      dbConn.close();
    }
  });

  it('pruneOrphanStoreRows evicts ONLY cold orphans, preserves active + recent', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'prune.db'));
    try {
      const qb = new QueryBuilder(dbConn.getDb());
      seedNodes(qb);

      const now = Date.now();
      const old = now - NINETY_DAYS_MS;
      const recent = now - FIVE_DAYS_MS;

      // Active row — has a live ref. Must survive even when last_ref_at is old.
      qb.db
        .prepare(
          `INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('body_active', 'm', 's', old, old);
      qb.db
        .prepare(`INSERT INTO summary_refs (node_id, body_hash, model) VALUES (?, ?, ?)`)
        .run('n_active', 'body_active', 'm');
      // The trigger bumped last_ref_at to ~now via the ref insert above.
      // Reset it so this test verifies "active row preserved DESPITE old last_ref_at".
      qb.db.prepare(`UPDATE summary_store SET last_ref_at = ? WHERE body_hash = 'body_active'`).run(old);

      // Cold orphan — no ref, last_ref_at older than 30-day cutoff. Must be evicted.
      qb.db
        .prepare(
          `INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('body_cold_orphan', 'm', 's', old, old);

      // Recent orphan — no ref, last_ref_at within freshness window. Must be kept.
      qb.db
        .prepare(
          `INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('body_recent_orphan', 'm', 's', recent, recent);

      const result = pruneOrphanStoreRows(qb, { maxAgeMs: PRUNE_THRESHOLD_MS });

      expect(result.summariesPruned).toBe(1);
      const rows = qb.db.prepare(`SELECT body_hash FROM summary_store ORDER BY body_hash`).all() as Array<{
        body_hash: string;
      }>;
      expect(rows.map((r) => r.body_hash).sort(byString)).toEqual(['body_active', 'body_recent_orphan']);
    } finally {
      dbConn.close();
    }
  });

  it('maxAgeDays=0 evicts every orphan (no recency window)', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'zero.db'));
    try {
      const qb = new QueryBuilder(dbConn.getDb());
      const now = Date.now();
      qb.db
        .prepare(
          `INSERT INTO summary_store (body_hash, model, summary, generated_at, last_ref_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('body_orphan_now', 'm', 's', now, now);

      const result = pruneOrphanStoreRows(qb, { maxAgeMs: 0 });
      expect(result.summariesPruned).toBe(1);
    } finally {
      dbConn.close();
    }
  });
});
