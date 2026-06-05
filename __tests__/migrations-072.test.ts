import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCurrentVersion, runMigrations } from '../src/db/migrations.js';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-072-'));
  dirs.push(dir);
  return path.join(dir, name);
}

function legacyV71Db(): SqliteDatabase {
  const { db } = createDatabase(tempPath('v71.db'));
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT NOT NULL
    );
    INSERT INTO schema_versions(version, applied_at, description)
    VALUES (71, 1, 'legacy v71 fixture');

    CREATE TABLE unresolved_refs (
      id INTEGER PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      reference_name TEXT NOT NULL
    );
  `);
  return db;
}

function unresolvedRefIndexes(db: SqliteDatabase): string[] {
  return (db.prepare('PRAGMA index_list(unresolved_refs)').all() as Array<{ name: string }>).map((row) => row.name);
}

describe('migration 072 unresolved_refs composite index', () => {
  it('migrates a v71 DB to v72 by adding idx_unresolved_from_name', () => {
    const db = legacyV71Db();
    try {
      expect(getCurrentVersion(db)).toBe(71);
      expect(unresolvedRefIndexes(db)).not.toContain('idx_unresolved_from_name');

      runMigrations(db, 71, 72);

      expect(getCurrentVersion(db)).toBe(72);
      expect(unresolvedRefIndexes(db)).toContain('idx_unresolved_from_name');
    } finally {
      db.close();
    }
  });
});
