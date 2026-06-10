/**
 * Cross-dialect schema parity gate.
 *
 * `schema.sql` (SQLite) and `schema-postgres.sql` are hand-maintained in
 * parallel, and the fresh-bootstrap integrity check (`verifySchemaIntegrity`)
 * runs ONLY on the sqlite dialect (it queries `sqlite_master`). Postgres
 * is fresh-init-only, so `schema-postgres.sql` must mirror `schema.sql`
 * plus the net effect of every migration BY HAND — a migration author
 * who updates one file but forgets the other ships a Postgres backend
 * missing a table, which only surfaces as a read-time error in production.
 *
 * This test pins that the two files declare the SAME set of tables and
 * views, modulo a documented list of genuinely dialect-specific objects
 * (SQLite FTS5 / R-tree virtual tables; SQLite compatibility views that
 * the Postgres query translator rewrites away). A new table that lands
 * in only one file fails here, at test time, naming the offender.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** SQLite-only objects with no Postgres counterpart (different engine). */
const SQLITE_ONLY_TABLES = new Set([
  // FTS5 virtual tables — Postgres uses tsvector/GIN instead.
  'nodes_fts',
  'docstring_fts',
  'summary_fts',
  'test_names_fts',
  'nested_function_names_fts',
  // R-tree spatial index — SQLite-specific module.
  'nodes_rtree',
]);
/** SQLite compatibility views the Postgres query layer rewrites away
 *  (e.g. `symbol_summaries` → `summary_refs` in postgres-worker). */
const SQLITE_ONLY_VIEWS = new Set(['symbol_embeddings', 'symbol_summaries']);

interface SchemaObjects {
  tables: Set<string>;
  views: Set<string>;
}

function parseSchemaObjects(file: string): SchemaObjects {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', file), 'utf-8');
  const tables = new Set<string>();
  const views = new Set<string>();
  const re = /CREATE\s+(VIRTUAL\s+TABLE|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?!\d)\w+)/gi;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const kind = m[1]!.toUpperCase();
    const name = m[2]!;
    if (kind === 'VIEW') views.add(name);
    else tables.add(name);
  }
  return { tables, views };
}

describe('schema.sql ↔ schema-postgres.sql parity', () => {
  const sqlite = parseSchemaObjects('schema.sql');
  const postgres = parseSchemaObjects('schema-postgres.sql');

  it('every Postgres table exists in the SQLite schema', () => {
    expect([...postgres.tables].filter((t) => !sqlite.tables.has(t))).toEqual([]);
  });

  it('every SQLite table exists in the Postgres schema (except SQLite-only engines)', () => {
    const missing = [...sqlite.tables].filter((t) => !postgres.tables.has(t) && !SQLITE_ONLY_TABLES.has(t));
    expect(missing).toEqual([]);
  });

  it('every SQLite view exists in the Postgres schema (except documented compat views)', () => {
    const missing = [...sqlite.views].filter((v) => !postgres.views.has(v) && !SQLITE_ONLY_VIEWS.has(v));
    expect(missing).toEqual([]);
  });

  it('the SQLite-only exception list is not stale (every entry still exists in schema.sql)', () => {
    for (const name of SQLITE_ONLY_TABLES) expect(sqlite.tables.has(name)).toBe(true);
    for (const name of SQLITE_ONLY_VIEWS) expect(sqlite.views.has(name)).toBe(true);
  });
});
