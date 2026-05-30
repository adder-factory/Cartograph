/**
 * Schema-drift guard — P2 of the structural campaign.
 *
 * THE BUG CLASS. Cartograph keeps two hand-maintained encodings of
 * the database schema:
 *
 *   - `src/db/schema.sql`           — applied verbatim by
 *     `DatabaseConnection.initialize` on a FRESH database.
 *   - `src/db/migrations/NNN-*.ts`  — replayed by `runMigrations`
 *     to UPGRADE an existing database.
 *
 * A new table (or column / index / trigger / view) has to be added
 * to BOTH or the two silently drift: a fresh install gets one shape,
 * an upgraded install gets another. This already caused a real
 * incident — migration 054's strictify swallow dropped five tables
 * and `schema.sql` was the only thing that still declared them
 * (see `057-repair-strictify-drops.ts`).
 *
 * THIS TEST makes that drift a hard failure. It builds the schema
 * BOTH ways and asserts they are structurally identical:
 *
 *   Path A — replay the full migration chain (001 → latest) into an
 *            empty database. `001-initial-schema.ts` is the recovered
 *            v1 base; with it the chain is a complete, executable
 *            description of the schema.
 *   Path B — a fresh `DatabaseConnection.initialize` (the
 *            `schema.sql` path).
 *
 * The four checks below assert the two paths agree on: (1) a clean
 * replay even runs, (2) the table + view set, (3) every column's
 * name / type / nullability / default / PK membership, and (4)
 * every foreign key. Add a table to a migration but forget
 * `schema.sql` (or vice versa) and this test goes red.
 *
 * Historical bugs closed in earlier sessions:
 *
 * (1) Migration 054 dependent-object crash. The strictify rebuild
 *     used to drop a base table mid-loop without first dropping the
 *     views/triggers that referenced it; SQLite's whole-schema
 *     revalidation then aborted on the next sibling rebuild with
 *     `error in view <X>: no such table: main.<Y>`. Real production
 *     upgrades from <49 dodged it (no views yet) and from-empty
 *     replays were silently swallowed by the per-iteration catch
 *     (since fixed in the same migration). 054 now captures all
 *     views + non-virtual-shadow triggers up front, drops them
 *     before the rebuild loop, and restores them afterwards.
 *
 * (2) `nodes.role` CHECK drift. Migration 040 added the column via
 *     bare `ALTER TABLE ADD COLUMN`; 054's regex-based CHECK fixup
 *     required a leading-line `role TEXT,` shape that ALTER TABLE's
 *     inline append never produces, so the CHECK never landed on
 *     upgraded DBs. Migration 067 rebuilds `nodes` to attach the
 *     CHECK on those installs; the new "no invalid role" assertion
 *     below pins the fix.
 *
 * (3) Rename regexes in migrations 054 / 055 / 056 / 062 anchored
 *     `\b` after the quoted-name alternative, where it can never
 *     match (`"` is a non-word char). On the quoted-name shape
 *     SQLite leaves once 054's strictify rename has run, those
 *     rebuilds silently no-opped — file_path FKs never reached the
 *     *_refs tables / role_assignments. Fixed by moving the anchor
 *     inside the unquoted branch (matching 064's corrected form).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import { ALL_MIGRATIONS } from '../src/db/migrations/index.js';
import { DatabaseConnection } from '../src/db/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-schema-drift-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** One row of `sqlite_master`, restricted to user objects. */
interface SchemaObject {
  type: string;
  name: string;
  sql: string | null;
}

/**
 * Read every user-defined schema object (no `sqlite_%` internals,
 * no `vec_*` runtime-extension tables).
 */
function readSchema(db: SqliteDatabase): SchemaObject[] {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
            AND name NOT LIKE 'vec_%'
          ORDER BY type, name`,
    )
    .all() as SchemaObject[];
}

/**
 * Build a database by replaying the entire migration chain into an
 * empty file. Mirrors `runMigrations` — each migration in its own
 * transaction, FK enforcement off for the strict-rebuild migrations.
 *
 * The pre-067 shape of this helper had a chain-replay shim that
 * dropped + restored views/triggers around migration 054; that's
 * now built into 054 itself, so the helper is a straight loop.
 */
function buildViaMigrations(dir: string): SqliteDatabase {
  const { db } = createDatabase(path.join(dir, 'migrated.db'));
  db.exec('PRAGMA foreign_keys = OFF');

  for (const migration of ALL_MIGRATIONS) {
    db.transaction(() => {
      migration.up(db);
    })();
  }
  return db;
}

describe('schema.sql ↔ migration-replay equivalence', () => {
  it('the full migration chain replays cleanly from an empty database', () => {
    const dir = tempDir();
    try {
      const db = buildViaMigrations(dir);
      const objects = readSchema(db);
      // A sanity floor — the chain must produce a non-trivial schema.
      expect(objects.filter((o) => o.type === 'table').length).toBeGreaterThan(20);
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('migration replay and schema.sql produce the same set of tables and views', () => {
    const dir = tempDir();
    try {
      const migratedDb = buildViaMigrations(dir);
      const migratedNames = new Set(
        readSchema(migratedDb)
          .filter((o) => o.type === 'table' || o.type === 'view')
          .map((o) => `${o.type}:${o.name}`),
      );
      migratedDb.close();

      const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
      const freshNames = new Set(
        readSchema(conn.getDb())
          .filter((o) => o.type === 'table' || o.type === 'view')
          .map((o) => `${o.type}:${o.name}`),
      );
      conn.close();

      const onlyInMigrations = [...migratedNames].filter((n) => !freshNames.has(n)).sort();
      const onlyInSchemaSql = [...freshNames].filter((n) => !migratedNames.has(n)).sort();

      // A table/view created by a migration but absent from
      // schema.sql → fresh installs get a "no such table" at runtime.
      expect(
        onlyInMigrations,
        `objects created by a migration but MISSING from src/db/schema.sql — ` +
          `add them to schema.sql:\n  ${onlyInMigrations.join('\n  ')}`,
      ).toEqual([]);

      // A table/view in schema.sql with no migration that creates it
      // → upgraded installs never get it.
      expect(
        onlyInSchemaSql,
        `objects in src/db/schema.sql with no migration that creates them — ` +
          `add a migration:\n  ${onlyInSchemaSql.join('\n  ')}`,
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('every foreign key matches between the two sources', () => {
    const dir = tempDir();
    try {
      const migratedDb = buildViaMigrations(dir);
      const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
      const freshDb = conn.getDb();

      const tableNames = readSchema(freshDb)
        .filter((o) => o.type === 'table')
        .map((o) => o.name)
        .filter((n) => !n.endsWith('_fts') && !n.startsWith('nodes_rtree'));

      // Compares FK SEMANTICS via PRAGMA foreign_key_list, not CREATE
      // text — a column-level `REFERENCES` and a table-level `FOREIGN
      // KEY (...)` clause are the same constraint and must compare
      // equal. A missing FK here is real drift: the FK-injection
      // migrations (055 / 062) once silently no-opped on the
      // quoted-name shape SQLite leaves after the 054 strictify
      // rebuild, so upgraded DBs lost FKs that fresh schema.sql DBs
      // kept.
      const fkSig = (db: SqliteDatabase, table: string): string =>
        (
          db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
            table: string;
            from: string;
            to: string | null;
            on_delete: string;
            on_update: string;
          }>
        )
          .map((f) => `${f.from}->${f.table}.${f.to ?? ''}:${f.on_delete}/${f.on_update}`)
          .sort()
          .join('|');

      const drift: string[] = [];
      for (const table of tableNames) {
        const freshSig = fkSig(freshDb, table);
        const migratedSig = fkSig(migratedDb, table);
        if (freshSig !== migratedSig) {
          drift.push(
            `  ${table}\n    schema.sql : ${freshSig || '(none)'}\n` + `    migrations : ${migratedSig || '(none)'}`,
          );
        }
      }
      migratedDb.close();
      conn.close();

      expect(drift, `foreign-key drift between schema.sql and the migration chain:\n${drift.join('\n')}`).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('every column of every shared table matches between the two sources', () => {
    const dir = tempDir();
    try {
      const migratedDb = buildViaMigrations(dir);
      const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
      const freshDb = conn.getDb();

      const tableNames = readSchema(freshDb)
        .filter((o) => o.type === 'table')
        .map((o) => o.name)
        .filter((n) => !n.endsWith('_fts') && !n.startsWith('nodes_rtree'));

      const columnSig = (db: SqliteDatabase, table: string): string =>
        (
          db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: unknown;
            pk: number;
          }>
        )
          .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? 'NULL'}:${c.pk}`)
          .sort()
          .join('|');

      const drift: string[] = [];
      for (const table of tableNames) {
        const freshSig = columnSig(freshDb, table);
        const migratedSig = columnSig(migratedDb, table);
        if (freshSig !== migratedSig) {
          drift.push(`  ${table}\n    schema.sql : ${freshSig}\n    migrations : ${migratedSig}`);
        }
      }
      migratedDb.close();
      conn.close();

      expect(drift, `column-level drift between schema.sql and the migration chain:\n${drift.join('\n')}`).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  // PRAGMA table_info is CHECK-blind, so column-level drift can't see
  // missing CHECK constraints. We probe them by attempting writes the
  // CHECK should reject. nodes.role drifted for the whole stretch
  // between migration 040 (column added without CHECK) and 067 (rebuild
  // attaches it); this test pins the post-067 state.
  it('nodes.role rejects values outside the documented enum on both build paths', () => {
    const dir = tempDir();
    try {
      const migratedDb = buildViaMigrations(dir);
      const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
      const freshDb = conn.getDb();

      const probe = (db: SqliteDatabase, source: string): void => {
        db.prepare(
          `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(`probe-${source}.ts`, 'h', 'typescript', 0, 0, 0);
        const insertNode = db.prepare(
          `INSERT INTO nodes
             (id, kind, name, qualified_name, file_path, language,
              start_line, end_line, start_column, end_column, updated_at, role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        expect(() =>
          insertNode.run(
            `n-${source}-bad`,
            'function',
            'foo',
            'foo',
            `probe-${source}.ts`,
            'typescript',
            1,
            2,
            0,
            0,
            0,
            'INVALID_ROLE_XXX',
          ),
        ).toThrow(/CHECK constraint failed/);
        // Sanity floor: a documented value still writes.
        insertNode.run(
          `n-${source}-ok`,
          'function',
          'foo',
          'foo',
          `probe-${source}.ts`,
          'typescript',
          1,
          2,
          0,
          0,
          0,
          'business_logic',
        );
      };

      probe(migratedDb, 'migrated');
      probe(freshDb, 'fresh');
      migratedDb.close();
      conn.close();
    } finally {
      cleanup(dir);
    }
  });
});
