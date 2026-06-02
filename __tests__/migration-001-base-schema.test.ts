import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { MIGRATION as MIG_001 } from '../src/db/migrations/001-initial-schema.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDb(): SqliteDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mig-001-'));
  dirs.push(dir);
  return createDatabase(path.join(dir, 'test.db')).db;
}

function names(db: SqliteDatabase, type: string): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

describe('migration 001 base schema', () => {
  it('creates the original v1 tables, indexes, FTS triggers, and vector table contract', () => {
    const db = tempDb();
    try {
      MIG_001.up(db);
      MIG_001.up(db);

      expect(names(db, 'table')).toEqual(
        expect.arrayContaining(['schema_versions', 'nodes', 'edges', 'files', 'unresolved_refs', 'nodes_fts', 'vectors']),
      );
      expect(names(db, 'index')).toEqual(
        expect.arrayContaining([
          'idx_nodes_kind',
          'idx_nodes_name',
          'idx_nodes_qualified_name',
          'idx_nodes_file_path',
          'idx_nodes_language',
          'idx_nodes_file_line',
          'idx_edges_source',
          'idx_edges_target',
          'idx_edges_kind',
          'idx_edges_source_kind',
          'idx_edges_target_kind',
          'idx_files_language',
          'idx_files_modified_at',
          'idx_unresolved_from_node',
          'idx_unresolved_name',
          'idx_vectors_model',
        ]),
      );
      expect(names(db, 'trigger')).toEqual(expect.arrayContaining(['nodes_ai', 'nodes_ad', 'nodes_au']));

      db.prepare(
        `INSERT INTO nodes
          (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, docstring, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('n1', 'function', 'searchThing', 'pkg.searchThing', 'src/app.ts', 'typescript', 1, 4, 1, 1, 'Finds a thing', 1);

      expect(
        db.prepare(`SELECT id, name FROM nodes_fts WHERE nodes_fts MATCH 'searchThing'`).get(),
      ).toEqual({ id: 'n1', name: 'searchThing' });

      db.prepare(`UPDATE nodes SET name = ?, qualified_name = ? WHERE id = ?`).run('lookupThing', 'pkg.lookupThing', 'n1');
      expect(db.prepare(`SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'searchThing'`).get()).toBeNull();
      expect(db.prepare(`SELECT id, name FROM nodes_fts WHERE nodes_fts MATCH 'lookupThing'`).get()).toEqual({
        id: 'n1',
        name: 'lookupThing',
      });

      db.prepare(
        `INSERT INTO nodes
          (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('n2', 'function', 'targetThing', 'pkg.targetThing', 'src/lib.ts', 'typescript', 10, 12, 1, 1, 1);
      db.prepare(`INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)`).run(
        'n1',
        'n2',
        'calls',
        2,
        4,
      );
      expect(db.prepare(`SELECT source, target, kind FROM edges WHERE source = ?`).get('n1')).toEqual({
        source: 'n1',
        target: 'n2',
        kind: 'calls',
      });

      db.prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('src/app.ts', 'hash', 'typescript', 100, 1, 2, 1);
      expect(db.prepare(`SELECT path FROM files WHERE language = ?`).get('typescript')).toEqual({ path: 'src/app.ts' });

      db.prepare(
        `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('n1', 'targetThing', 'calls', 2, 4, '[]');
      expect(db.prepare(`SELECT reference_name FROM unresolved_refs WHERE from_node_id = ?`).get('n1')).toEqual({
        reference_name: 'targetThing',
      });

      db.prepare(`INSERT INTO vectors (node_id, embedding, model, created_at) VALUES (?, ?, ?, ?)`).run(
        'n1',
        Buffer.from([1, 2, 3, 4]),
        'model-a',
        3,
      );
      expect(db.prepare(`SELECT node_id FROM vectors WHERE model = ?`).get('model-a')).toEqual({ node_id: 'n1' });
    } finally {
      db.close();
    }
  });
});
