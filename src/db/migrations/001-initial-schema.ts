import type { MigrationModule } from './types.js';

/**
 * Migration 001 — the v1 base schema.
 *
 * **Why this exists.** Fresh databases initialise from
 * `src/db/schema.sql` (one `db.exec`), while existing databases
 * upgrade by replaying `migrations/NNN-*.ts`. Before this file the
 * migration chain started at 002, which `ALTER`s `unresolved_refs`
 * and `edges` — tables only `schema.sql` ever created. The chain was
 * therefore a *delta on top of an unwritten v1 base*: it could not
 * be replayed from an empty database, and nothing could cross-check
 * `schema.sql` against the migrations. That gap let a new table be
 * added to one source and silently forgotten in the other (the
 * migration-054 incident lost 5 tables this way).
 *
 * This migration is a verbatim transcription of the **original
 * v1 `schema.sql`** as it stood at the `Init` commit. With it in
 * place the migration chain (001 → latest) is a *complete,
 * executable* description of the schema, so a test can replay it
 * into an empty database and assert byte-equality with a fresh
 * `schema.sql` init — drift between the two sources becomes a hard
 * test failure instead of a runtime "no such table".
 *
 * **Production impact: none.** `DatabaseConnection.initialize`
 * still loads `schema.sql` directly and stamps the DB at
 * `CURRENT_SCHEMA_VERSION`, so 001 never runs on a fresh install.
 * Every pre-existing database is already at version ≥ 2, and
 * `runMigrations` only applies migrations with `version >
 * fromVersion`, so 001 never replays on an upgrade either. This
 * file executes in exactly one place: the schema-equivalence test
 * (`__tests__/schema-drift.test.ts`), which builds a DB from an
 * empty file. Treat it as frozen history — never edit it to track
 * later schema changes; later changes belong in new migrations
 * (which the equivalence test then validates against `schema.sql`).
 */
export const MIGRATION: MigrationModule = {
  description: 'Initial schema',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL,
          description TEXT
      );

      CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          language TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          start_column INTEGER NOT NULL,
          end_column INTEGER NOT NULL,
          docstring TEXT,
          signature TEXT,
          visibility TEXT,
          is_exported INTEGER DEFAULT 0,
          is_async INTEGER DEFAULT 0,
          is_static INTEGER DEFAULT 0,
          is_abstract INTEGER DEFAULT 0,
          decorators TEXT, -- JSON array
          type_parameters TEXT, -- JSON array
          updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          kind TEXT NOT NULL,
          metadata TEXT, -- JSON object
          line INTEGER,
          col INTEGER,
          FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          language TEXT NOT NULL,
          size INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL,
          node_count INTEGER DEFAULT 0,
          errors TEXT -- JSON array
      );

      CREATE TABLE IF NOT EXISTS unresolved_refs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_node_id TEXT NOT NULL,
          reference_name TEXT NOT NULL,
          reference_kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          col INTEGER NOT NULL,
          candidates TEXT, -- JSON array
          FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
      CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
          id,
          name,
          qualified_name,
          docstring,
          content='nodes',
          content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring)
          VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring);
          INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring)
          VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring);
      END;

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
      CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

      CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
      CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);

      CREATE TABLE IF NOT EXISTS vectors (
          node_id TEXT PRIMARY KEY,
          embedding BLOB NOT NULL, -- Float32 array stored as blob
          model TEXT NOT NULL, -- Model used to generate embedding
          created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model);
    `);
  },
};
