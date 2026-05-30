/**
 * Unit tests for the deferred derived-index helper used by `indexAll`
 * (`src/db/deferred-index.ts`): dropping the nine `nodes` FTS5/R*Tree
 * maintenance triggers for a bulk store, then rebuilding the indexes
 * and recreating the triggers once at the end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import type { SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { deferNodeDerivedIndexes, finalizeDeferredNodeIndexes } from '../src/db/deferred-index.js';

const TRIGGER_NAMES = [
  'nodes_ai',
  'nodes_ad',
  'nodes_au',
  'nodes_rtree_ai',
  'nodes_rtree_ad',
  'nodes_rtree_au',
  'docstring_fts_ai',
  'docstring_fts_ad',
  'docstring_fts_au',
];

function triggerCount(db: SqliteDatabase): number {
  const names = TRIGGER_NAMES.map((n) => `'${n}'`).join(',');
  return (
    db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN (${names})`).get() as {
      n: number;
    }
  ).n;
}

/** Insert one file row + N node rows with the given docstrings. */
function seedNodes(db: SqliteDatabase, docstrings: Array<string | null>): void {
  db.prepare(
    `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES ('f.ts', 'h', 'typescript', 1, 0, 0)`,
  ).run();
  const stmt = db.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column, docstring, updated_at)
     VALUES (?, 'function', ?, ?, 'f.ts', 'typescript', ?, ?, 0, 0, ?, 0)`,
  );
  docstrings.forEach((doc, i) => {
    const name = `symbol_${i}`;
    stmt.run(`n${i}`, name, name, (i + 1) * 10, (i + 1) * 10 + 5, doc);
  });
}

describe('deferred-index', () => {
  let tempDir: string;
  let conn: DatabaseConnection;
  let db: SqliteDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-defidx-'));
    conn = DatabaseConnection.initialize(path.join(tempDir, 'test.db'));
    db = conn.getDb();
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('drops all nine maintenance triggers, then restores them on finalize', () => {
    expect(triggerCount(db)).toBe(9);

    const handle = deferNodeDerivedIndexes(db);
    expect(triggerCount(db)).toBe(0);
    expect(handle.capturedTriggerSql).toHaveLength(9);

    finalizeDeferredNodeIndexes(db, handle);
    expect(triggerCount(db)).toBe(9);
  });

  it('rebuilds nodes_fts / docstring_fts / nodes_rtree from final content', () => {
    const handle = deferNodeDerivedIndexes(db);
    // Nodes inserted with triggers dropped — derived indexes are NOT
    // maintained per-row, so they are empty until finalize rebuilds them.
    seedNodes(db, ['parses the input tree', null, 'computes a checksum']);
    expect(
      (db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH 'symbol_0'").get() as { n: number }).n,
    ).toBe(0);

    finalizeDeferredNodeIndexes(db, handle);

    // nodes_fts: name search resolves
    expect((db.prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'symbol_2'").get() as { id: string }).id).toBe(
      'n2',
    );
    // docstring_fts: docstring word search resolves
    expect(
      (db.prepare("SELECT rowid FROM docstring_fts WHERE docstring_fts MATCH 'checksum'").all() as unknown[]).length,
    ).toBe(1);
    // nodes_rtree: every node row is range-indexed
    expect((db.prepare('SELECT count(*) AS n FROM nodes_rtree').get() as { n: number }).n).toBe(3);
    expect(
      (
        db.prepare('SELECT count(*) AS n FROM nodes_rtree WHERE start_line <= 12 AND end_line >= 12').get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('restores triggers via the schema.sql fallback when the capture is incomplete', () => {
    // Simulate a prior crash: the triggers were already dropped, so
    // deferNodeDerivedIndexes captures fewer than nine.
    for (const name of TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    const handle = deferNodeDerivedIndexes(db);
    expect(handle.capturedTriggerSql).toHaveLength(0);

    // finalize must still end with all nine triggers present.
    finalizeDeferredNodeIndexes(db, handle);
    expect(triggerCount(db)).toBe(9);
  });
});
