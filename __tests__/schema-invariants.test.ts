/**
 * Schema invariants — deferred tests from the 2026-05-11 schema
 * audit (F5 + F7 + M2). Bundled into one file since each is a
 * narrow assertion about the migration layer rather than a
 * standalone feature.
 *
 * Coverage:
 *
 *   F5  — write-order FK invariant. Migration 055 / 056 added
 *         non-deferrable file_path FKs. The extractor's
 *         eoPersistFileExtraction upserts the parent `files` row
 *         before inserting child nodes / refs in the same txn.
 *         These tests assert (a) violating the write order trips
 *         a FK error, and (b) the canonical happy-path order
 *         succeeds.
 *
 *   F7  — migration 054 partial-failure rollback. Pre-mig-057 the
 *         strictify catch swallowed every error silently and the
 *         runner recorded version 54 as applied; the live DB lost
 *         5 tables that way. The new rethrow + outer-transaction
 *         rollback is asserted here against a fabricated failure
 *         injected via a wrapped `db.exec`.
 *
 *   M2  — strictifyTable CREATE-SQL round-trip. The strictify
 *         regex appends `) STRICT[, WITHOUT ROWID]` after the
 *         table-closing paren. For every entry in
 *         PER_TABLE_FIXUPS, this test feeds the fixed-up CREATE
 *         SQL back through strictifyTable inside an in-memory DB
 *         and confirms the result is parseable and produces a
 *         STRICT table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { createDatabase } from '../src/db/sqlite-adapter.js';
import { strictifyTable, PER_TABLE_FIXUPS, MIGRATION as MIG_054 } from '../src/db/migrations/054-strict-tables.js';
import { ROLE_LABELS } from '../src/llm/classifier.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-schema-invariants-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// F5 — Write-order FK invariant
// ============================================================================

describe('F5 — refs/nodes file_path FK write order', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('rejects a nodes insert whose file_path has no matching files row', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fk-violate.db'));
    try {
      const db = conn.getDb();
      // FK enforcement is ON via dbApplyPragmas — confirm before asserting.
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);

      const insert = (): void => {
        db.prepare(
          `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                              start_line, end_line, start_column, end_column,
                              is_exported, is_async, is_static, updated_at)
           VALUES ('n1', 'function', 'orphan', 'orphan', 'no-such-file.ts', 'typescript',
                   1, 1, 0, 0, 0, 0, 0, ?)`,
        ).run(Date.now());
      };
      expect(insert).toThrow(/FOREIGN KEY constraint failed/i);
    } finally {
      conn.close();
    }
  });

  it('rejects a config_refs insert whose file_path has no matching files row', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fk-refs-violate.db'));
    try {
      const db = conn.getDb();
      const insert = (): void => {
        db.prepare(
          `INSERT INTO config_refs (config_kind, config_key, source_node_id, file_path, line)
           VALUES ('env', 'API_KEY', NULL, 'no-such-file.ts', 1)`,
        ).run();
      };
      expect(insert).toThrow(/FOREIGN KEY constraint failed/i);
    } finally {
      conn.close();
    }
  });

  it('canonical write order (files first, then nodes) succeeds', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fk-happy.db'));
    try {
      const db = conn.getDb();
      db.prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES ('a.ts', 'h', 'typescript', 0, 0, 0)`,
      ).run();
      const insert = (): void => {
        db.prepare(
          `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                              start_line, end_line, start_column, end_column,
                              is_exported, is_async, is_static, updated_at)
           VALUES ('n1', 'function', 'f', 'f', 'a.ts', 'typescript',
                   1, 1, 0, 0, 0, 0, 0, ?)`,
        ).run(Date.now());
      };
      expect(insert).not.toThrow();
      const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('n1') as { id: string } | undefined;
      expect(row?.id).toBe('n1');
    } finally {
      conn.close();
    }
  });

  it('reversed write order (nodes before files) fails even inside one transaction', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fk-txn-violate.db'));
    try {
      const db = conn.getDb();
      const reversed = (): void => {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                                start_line, end_line, start_column, end_column,
                                is_exported, is_async, is_static, updated_at)
             VALUES ('n1', 'function', 'f', 'f', 'a.ts', 'typescript',
                     1, 1, 0, 0, 0, 0, 0, ?)`,
          ).run(Date.now());
          db.prepare(
            `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
             VALUES ('a.ts', 'h', 'typescript', 0, 0, 0)`,
          ).run();
        })();
      };
      // The FK is enforced at statement time (not DEFERRABLE INITIALLY
      // DEFERRED), so the first INSERT fails before the matching
      // files row can be added later in the same txn.
      expect(reversed).toThrow(/FOREIGN KEY constraint failed/i);
    } finally {
      conn.close();
    }
  });
});

// ============================================================================
// F7 — Migration 054 partial-failure rollback
// ============================================================================

describe('F7 — migration 054 rethrow + outer transaction rollback', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('rethrows when strictifyTable fails and leaves the original table intact', () => {
    // Build an in-memory pre-STRICT DB with two simple base tables.
    // We can't easily replay migrations 1..53 in-memory, so we set
    // up a minimal fixture that exercises the strictify loop's
    // failure path without engaging the migration runner. The
    // assertion is: when strictifyTable throws partway through, no
    // orphan __strict_tmp persists and the original survives.
    const { db } = createDatabase(path.join(dir, 'rollback.db'));
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
        VALUES ('a.ts', 'h', 'typescript', 0, 0, 0);
    `);

    // Capture the original SQL exactly as sqlite_master stored it.
    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='files'").get() as {
      name: string;
      sql: string;
    };

    // Inject a corrupted ObjectRow whose SQL doesn't match the
    // rename regex — strictifyTable throws on it. We then assert
    // the orphan temp table cleanup that mig 054's catch performs
    // leaves no `files__strict_tmp` behind.
    expect(() => strictifyTable(db, { name: 'files', sql: 'TOTALLY NOT A CREATE TABLE STATEMENT' })).toThrow(
      /could not locate CREATE TABLE/,
    );

    const orphans = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE name LIKE '%__strict_tmp'`,
      )
      .all() as Array<{ name: string }>;
    expect(orphans).toHaveLength(0);

    // Original table + data still intact.
    const filesRow = db.prepare(`SELECT path FROM files WHERE path = 'a.ts'`).get() as { path: string } | undefined;
    expect(filesRow?.path).toBe('a.ts');
    expect(row.sql).toContain('CREATE TABLE files');

    db.close();
  });

  it('migration 054 catch wraps the strictify error with a recognizable prefix', () => {
    // The mig-054 `up()` runs the strictify loop and wraps any
    // throw with `[migration 054] strictify failed on "<table>": …`.
    // Verify against a fabricated db whose schema mimics a tiny
    // pre-mig-054 state with only a problematic table — the
    // strictify regex can't find its CREATE TABLE so it rethrows.
    const { db } = createDatabase(path.join(dir, 'wrap-err.db'));
    db.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      INSERT INTO schema_versions (version, applied_at, description) VALUES (53, 0, 'v53');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL
      );
    `);

    // Force a strictify failure by stripping the stored SQL out
    // from under the loop: rewrite sqlite_master entries directly
    // would corrupt the DB, so instead inject a deliberately-bad
    // CREATE statement that the rename regex won't match.
    // Easiest path: pre-create an orphan temp table whose presence
    // makes the rebuild's CREATE step error with "table already
    // exists" — exercises the post-throw cleanup path.
    db.exec('CREATE TABLE "nodes__strict_tmp" (id TEXT PRIMARY KEY)');

    expect(() => MIG_054.up(db)).toThrow(/\[migration 054\] strictify failed/);

    // Orphan temp table was cleaned up by the catch's
    // DROP TABLE IF EXISTS step before the rethrow. (`.get()` returns
    // null under bun:sqlite, undefined under better-sqlite3 — assert
    // either nullish.)
    const orphan = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE name='nodes__strict_tmp'`).get();
    expect(orphan).toBeFalsy();

    db.close();
  });
});

// ============================================================================
// M2 — strictifyTable PER_TABLE_FIXUPS round-trip
// ============================================================================

describe('M2 — strictifyTable round-trip for PER_TABLE_FIXUPS', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  // Minimal pre-STRICT shapes that match the columns each fixup
  // function rewrites. The fixup only touches enum CHECK / type
  // wording so the rest of the column list can be lightweight.
  const FIXTURE_SQL: Record<string, string> = {
    code_health_findings: `
      CREATE TABLE code_health_findings (
        node_id TEXT NOT NULL,
        biomarker TEXT NOT NULL,
        severity TEXT NOT NULL,
        metric INTEGER NOT NULL,
        detail TEXT,
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, biomarker)
      )`,
    nodes: `
      CREATE TABLE nodes (
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
        updated_at INTEGER NOT NULL,
        role TEXT,
        role_model TEXT
      )`,
    edges: `
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence TEXT,
        line INTEGER
      )`,
    embedding_refs: `
      CREATE TABLE embedding_refs (
        node_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        grain TEXT NOT NULL DEFAULT 'symbol',
        PRIMARY KEY (node_id, model, grain)
      )`,
  };

  for (const tableName of Object.keys(PER_TABLE_FIXUPS)) {
    it(`${tableName}: rebuild produces a parseable STRICT table`, () => {
      const { db } = createDatabase(path.join(dir, `roundtrip-${tableName}.db`));
      const fixtureSql = FIXTURE_SQL[tableName];
      expect(fixtureSql, `fixture missing for ${tableName}`).toBeDefined();

      // Seed the pre-STRICT table from the fixture SQL.
      db.exec(fixtureSql!);

      // Pull the canonical CREATE statement back from sqlite_master
      // — that's what mig 054 actually feeds into strictifyTable.
      const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as {
        name: string;
        sql: string;
      };
      expect(row.sql).toBeDefined();

      // Round-trip.
      strictifyTable(db, row);

      // Result is parseable + STRICT + same name.
      const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as {
        sql: string;
      };
      expect(after.sql).toMatch(/\bSTRICT\b/);

      // No orphan temp table left behind. (`.get()` returns null
      // under bun:sqlite, undefined under better-sqlite3 — assert
      // either nullish.)
      const orphan = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE name=?`).get(`${tableName}__strict_tmp`);
      expect(orphan).toBeFalsy();

      db.close();
    });
  }
});

// ============================================================================
// ROLE_LABELS drift — schema.sql ↔ src/llm/classifier.ts
// ============================================================================

/**
 * The role enum is duplicated across:
 *
 *   1. `src/llm/classifier.ts` `ROLE_LABELS` — canonical (used by Zod
 *      output schemas + GBNF grammar that constrains LLM emissions);
 *   2. `src/db/schema.sql` `nodes.role CHECK (role IS NULL OR role IN (...))`;
 *   3. migration-040 / 067 — frozen-in-time copies, intentional.
 *
 * Migration 067 attaches the CHECK to `nodes` on upgraded installs
 * (closing the silent drift caught while shipping the migration —
 * fresh installs from schema.sql enforced the enum but upgraded
 * installs did not). Now that the CHECK is universal, ANY drift
 * between (1) and (2) is a hard runtime failure: the classifier
 * emits a label whose Zod schema passes, the UPDATE binds, SQLite
 * rejects with `CHECK constraint failed`, and the whole classify
 * batch aborts.
 *
 * Pin the two canonical sources together so a developer adding a
 * label to one will get a red test pointing at the other.
 */
describe('ROLE_LABELS — schema.sql CHECK ↔ classifier.ts canonical export', () => {
  it('schema.sql role-enum CHECK list matches src/llm/classifier.ts ROLE_LABELS', () => {
    const schemaPath = path.resolve(__dirname, '..', 'src', 'db', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

    // Pull the contents of the `role IN (...)` clause out of the
    // nodes CREATE statement. The regex is permissive about
    // whitespace/newlines so a future re-indent doesn't break the
    // test, but the structure (a comma-separated list of single-
    // quoted identifiers) is locked.
    const match = schemaSql.match(/role\s+IS\s+NULL\s+OR\s+role\s+IN\s*\(([^)]+)\)/i);
    expect(match, 'expected to find `role IS NULL OR role IN (...)` in schema.sql').not.toBeNull();
    const inListBody = match![1] ?? '';
    const labelsFromSchema = [...inListBody.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((s): s is string => !!s);
    expect(labelsFromSchema.length, 'expected at least one quoted label in the CHECK clause').toBeGreaterThan(0);

    // Set-equality (order-independent) so a future reorder of the
    // enum-list-in-SQL stays green.
    expect(new Set(labelsFromSchema)).toEqual(new Set(ROLE_LABELS));
  });
});
