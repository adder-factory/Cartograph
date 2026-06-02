/**
 * Migration 022 — add (content_hash, model) index on symbol_summaries.
 *
 * The behavioural intent (LLM caches surviving --force re-index) is
 * achieved at the runtime level by `clearStructural()` toggling FKs
 * OFF around its deletes. The migration itself just adds the index
 * the new content-hash fallback in summarizer.ts uses.
 *
 * Verifies:
 *  - On a fresh DB, the index is present.
 *  - On an upgrade from a pre-022 DB, the index is added without
 *    touching summary rows.
 *  - clearStructural preserves summary rows even though the FK is
 *    still defined as ON DELETE CASCADE — proves the runtime FK
 *    toggle works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabase } from '../src/db/sqlite-adapter.js';
import { runMigrations, getCurrentVersion } from '../src/db/migrations.js';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder, clearAll, clearStructural } from '../src/db/queries.js';
import { getSummaryByContentHash, pruneOrphanSummaries } from '../src/db/queries-summaries.js';
import { pruneOrphanDirectorySummaries } from '../src/db/queries-directory-summaries.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-022-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function seedFile(raw: { prepare: (sql: string) => { run: (...p: unknown[]) => unknown } }, fpath: string): void {
  raw
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

describe('Migration 022 — content_hash index + structural-clear preservation', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('fresh DB has idx_summary_refs_body_hash on (body_hash, model)', () => {
    const db = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      // Migration 049 replaced symbol_summaries with summary_store +
      // summary_refs. The content-hash lookup index moved with it.
      const idxList = db
        .getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='summary_refs'")
        .all() as Array<{ name: string }>;
      const names = idxList.map((r) => r.name);
      expect(names).toContain('idx_summary_refs_body_hash');

      const cols = db.getDb().prepare('PRAGMA index_info(idx_summary_refs_body_hash)').all() as Array<{
        name: string;
        seqno: number;
      }>;
      const orderedCols = [...cols];
      orderedCols.sort((a, b) => a.seqno - b.seqno);
      const ordered = orderedCols.map((c) => c.name);
      expect(ordered).toEqual(['body_hash', 'model']);
    } finally {
      db.close();
    }
  });

  it('upgrades a pre-022 DB by adding the index without touching rows', () => {
    const dbPath = path.join(dir, 'upgrade.db');
    const { db: adapter } = createDatabase(dbPath);

    adapter.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      INSERT INTO nodes (id) VALUES ('n1');
      CREATE TABLE symbol_summaries (
        node_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        model TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        role TEXT,
        role_model TEXT,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      INSERT INTO schema_versions (version, applied_at, description) VALUES (21, 0, 'v21');
      INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n1', 'hash-a', 'sum A', 'chat-m', 100);
    `);

    // Partial-schema test fixture: bootstraps a minimal nodes shape
    // for migration-022 isolation, so the post-migration integrity
    // check (which compares against schema.sql) would fail expectedly.
    process.env['CARTOGRAPH_SKIP_SCHEMA_INTEGRITY_CHECK'] = '1';
    try {
      runMigrations(adapter, getCurrentVersion(adapter));
    } finally {
      delete process.env['CARTOGRAPH_SKIP_SCHEMA_INTEGRITY_CHECK'];
    }

    expect(getCurrentVersion(adapter)).toBeGreaterThanOrEqual(22);

    // Migration 049 (Design C) replaces symbol_summaries with
    // summary_store + summary_refs, moving the content-hash lookup
    // index to summary_refs. Forward-migration through to current
    // schema must produce the renamed index.
    const idx = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='summary_refs'")
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_summary_refs_body_hash');

    // Existing rows survive the data-migration into summary_store +
    // summary_refs and are readable through the backward-compat view.
    const rows = adapter.prepare('SELECT node_id, content_hash, summary FROM symbol_summaries').all();
    expect(rows).toEqual([{ node_id: 'n1', content_hash: 'hash-a', summary: 'sum A' }]);

    adapter.close();
  });

  it('clearStructural preserves summary rows even with CASCADE FK', () => {
    const dbPath = path.join(dir, 'preserve.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);

      // Seed parent files row for nodes.file_path FK (migration 056).
      seedFile(raw, 'a.ts');
      // Plant a node + a summary row that the FK CASCADE would drop
      // on a naive DELETE FROM nodes.
      raw
        .prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                           start_line, end_line, start_column, end_column, updated_at)
        VALUES (?, 'function', 'foo', 'foo', 'a.ts', 'typescript', 1, 5, 0, 0, 0)
      `)
        .run('n1');
      raw
        .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n1', 'hash-a', 'cached summary', 'chat-m', 100)
      `)
        .run();

      expect(raw.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get()).toEqual({ c: 1 });

      // The path under test: structural clear with FK suppression.
      clearStructural(queries);

      // Node is gone, but summary row survived — proving the FK
      // toggle did its job.
      expect(raw.prepare('SELECT COUNT(*) AS c FROM nodes').get()).toEqual({ c: 0 });
      expect(raw.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get()).toEqual({ c: 1 });

      // Content-hash fallback finds the surviving row.
      const hit = getSummaryByContentHash(queries, 'hash-a', 'chat-m');
      expect(hit?.summary).toBe('cached summary');

      // FKs are restored after clearStructural — so an explicit
      // single-symbol delete still cascades correctly (sync path).
      // clearStructural also wiped `files`, so re-seed the parent row
      // for the n2 nodes.file_path FK (migration 056).
      seedFile(raw, 'a.ts');
      raw
        .prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                           start_line, end_line, start_column, end_column, updated_at)
        VALUES (?, 'function', 'foo', 'foo', 'a.ts', 'typescript', 1, 5, 0, 0, 0)
      `)
        .run('n2');
      raw
        .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n2', 'hash-b', 'second summary', 'chat-m', 100)
      `)
        .run();
      raw.prepare("DELETE FROM nodes WHERE id = 'n2'").run();
      // n2 summary should have cascade-deleted (sync semantics intact).
      expect(raw.prepare("SELECT COUNT(*) AS c FROM symbol_summaries WHERE node_id='n2'").get()).toEqual({ c: 0 });
    } finally {
      conn.close();
    }
  });

  it('pruneOrphanSummaries deletes only summaries whose node_id is gone', () => {
    const dbPath = path.join(dir, 'prune.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);

      // Seed parent files row for nodes.file_path FK (migration 056).
      seedFile(raw, 'a.ts');
      // All three nodes exist initially (so FK on summaries is happy).
      const insertNode = raw.prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                           start_line, end_line, start_column, end_column, updated_at)
        VALUES (?, 'function', 'foo', 'foo', 'a.ts', 'typescript', 1, 5, 0, 0, 0)
      `);
      insertNode.run('n1');
      insertNode.run('n2');
      insertNode.run('n3');

      raw
        .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n1', 'h1', 'live summary', 'm', 100),
               ('n2', 'h2', 'orphan A', 'm', 100),
               ('n3', 'h3', 'orphan B', 'm', 100)
      `)
        .run();

      const liveVec = Buffer.from(new Float32Array([1, 0, 0]).buffer);
      const orphanVec = Buffer.from(new Float32Array([0, 1, 0]).buffer);
      raw
        .prepare(`
        INSERT INTO symbol_embeddings (node_id, embedding, embedding_model, source_content_hash)
        VALUES ('n1', ?, 'em', 'src-1'),
               ('n2', ?, 'em', 'src-2')
      `)
        .run(liveVec, orphanVec);

      // Simulate clearStructural's effect: delete n2/n3 from `nodes`
      // with FKs OFF, leaving the summary + embedding rows orphaned.
      // This is the exact post-clearStructural-then-reindex state where
      // pruneOrphanSummaries is meant to clean up.
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.prepare("DELETE FROM nodes WHERE id IN ('n2', 'n3')").run();
      raw.exec('PRAGMA foreign_keys = ON');

      const result = pruneOrphanSummaries(queries);

      // Two summaries removed (n2, n3) — n1 stayed.
      expect(result.summariesDeleted).toBe(2);
      // One embedding removed via FK cascade (n2 had an embedding).
      expect(result.embeddingsDeleted).toBe(1);

      // Verify final state: only the live row remains.
      expect((raw.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number }).c).toBe(1);
      expect((raw.prepare('SELECT COUNT(*) AS c FROM symbol_embeddings').get() as { c: number }).c).toBe(1);
      const survivor = raw.prepare("SELECT summary FROM symbol_summaries WHERE node_id = 'n1'").get() as {
        summary: string;
      };
      expect(survivor.summary).toBe('live summary');
    } finally {
      conn.close();
    }
  });

  it('pruneOrphanDirectorySummaries deletes only dirs with no indexed files', () => {
    const dbPath = path.join(dir, 'prune-dirs.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);

      // Indexed files: 2 in src/a, 1 in src/b, 1 directly in src/.
      // Live = exactly the immediate parents the dir-summarizer would
      // have written for: src/a, src/b, and src (only because main.ts
      // lives directly in src/). NOT all ancestors — see the comment
      // in pruneOrphanDirectorySummaries explaining why we don't walk
      // the chain (would let stale ancestor-only summaries survive).
      const insFile = raw.prepare(`
        INSERT INTO files (path, language, content_hash, modified_at, size, indexed_at)
        VALUES (?, 'typescript', 'h', 0, 100, 0)
      `);
      insFile.run('src/a/foo.ts');
      insFile.run('src/a/bar.ts');
      insFile.run('src/b/baz.ts');
      insFile.run('src/main.ts');

      // Plant 5 dir summaries: 3 live, 2 orphan.
      const insDir = raw.prepare(`
        INSERT INTO directory_summaries (dir_path, summary, content_hash, model, generated_at)
        VALUES (?, ?, 'h', 'm', 100)
      `);
      insDir.run('src/a', 'live a');
      insDir.run('src/b', 'live b');
      insDir.run('src', 'live root (has main.ts directly)');
      insDir.run('src/c', 'orphan deleted dir');
      insDir.run('vendor/lib', 'orphan outside tree');

      const result = pruneOrphanDirectorySummaries(queries);

      expect(result.directorySummariesDeleted).toBe(2);

      const remaining = (
        raw.prepare('SELECT dir_path FROM directory_summaries ORDER BY dir_path').all() as Array<{ dir_path: string }>
      ).map((r) => r.dir_path);
      expect(remaining).toEqual(['src', 'src/a', 'src/b']);
    } finally {
      conn.close();
    }
  });

  it('pruneOrphanDirectorySummaries: stale ancestor-only dir IS pruned', () => {
    // Regression for an under-pruning bug: if files used to live
    // directly in `src/` (so the dir-summarizer wrote a `src` summary)
    // but have all moved into subdirs like `src/core/`, the stale
    // `src` summary must be pruned. The earlier draft walked the
    // ancestor chain and would have kept it.
    const dbPath = path.join(dir, 'prune-dirs-ancestor.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);

      raw
        .prepare(`
        INSERT INTO files (path, language, content_hash, modified_at, size, indexed_at)
        VALUES ('src/core/foo.ts', 'typescript', 'h', 0, 100, 0)
      `)
        .run();

      raw
        .prepare(`
        INSERT INTO directory_summaries (dir_path, summary, content_hash, model, generated_at)
        VALUES ('src/core', 'live', 'h', 'm', 100),
               ('src',      'stale ancestor — no file lives directly here', 'h', 'm', 100)
      `)
        .run();

      const result = pruneOrphanDirectorySummaries(queries);
      expect(result.directorySummariesDeleted).toBe(1);
      const remaining = (
        raw.prepare('SELECT dir_path FROM directory_summaries').all() as Array<{ dir_path: string }>
      ).map((r) => r.dir_path);
      expect(remaining).toEqual(['src/core']);
    } finally {
      conn.close();
    }
  });

  it('pruneOrphanDirectorySummaries: empty files table prunes everything', () => {
    const dbPath = path.join(dir, 'prune-dirs-empty.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);
      raw
        .prepare(`
        INSERT INTO directory_summaries (dir_path, summary, content_hash, model, generated_at)
        VALUES ('src/a', 's', 'h', 'm', 100), ('src/b', 's', 'h', 'm', 100)
      `)
        .run();

      const result = pruneOrphanDirectorySummaries(queries);
      expect(result.directorySummariesDeleted).toBe(2);
      expect((raw.prepare('SELECT COUNT(*) AS c FROM directory_summaries').get() as { c: number }).c).toBe(0);
    } finally {
      conn.close();
    }
  });

  it('pruneOrphanSummaries is a no-op when nothing is orphaned', () => {
    const dbPath = path.join(dir, 'noop.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);
      // Seed parent files row for nodes.file_path FK (migration 056).
      seedFile(raw, 'a.ts');
      raw
        .prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                           start_line, end_line, start_column, end_column, updated_at)
        VALUES ('n1', 'function', 'foo', 'foo', 'a.ts', 'typescript', 1, 5, 0, 0, 0)
      `)
        .run();
      raw
        .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n1', 'h', 's', 'm', 100)
      `)
        .run();

      const result = pruneOrphanSummaries(queries);
      expect(result.summariesDeleted).toBe(0);
      expect(result.embeddingsDeleted).toBe(0);
      expect((raw.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number }).c).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('clear (full reset) wipes summaries too', () => {
    const dbPath = path.join(dir, 'wipe.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const raw = conn.getDb();
      const queries = new QueryBuilder(raw);
      // Seed parent files row for nodes.file_path FK (migration 056).
      seedFile(raw, 'a.ts');
      raw
        .prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                           start_line, end_line, start_column, end_column, updated_at)
        VALUES (?, 'function', 'foo', 'foo', 'a.ts', 'typescript', 1, 5, 0, 0, 0)
      `)
        .run('n1');
      raw
        .prepare(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('n1', 'h', 's', 'chat-m', 100)
      `)
        .run();

      clearAll(queries);

      expect(raw.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get()).toEqual({ c: 0 });
    } finally {
      conn.close();
    }
  });
});
