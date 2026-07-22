/**
 * Backend-native lexical queries for intent search.
 *
 * SQLite uses its three FTS5 corpora. PostgreSQL uses equivalent
 * `tsvector` expressions and `websearch_to_tsquery`, returning the same
 * lower-is-better negative rank contract consumed by the MCP feature.
 */

import { z } from 'zod';
import { prefixLikePattern } from './sql-like.js';
import type { SqliteDatabase } from './sqlite-adapter.js';

const RawIntentSymbolHitRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  start_line: z.number().nullable(),
  rank: z.number(),
  text: z.string().nullable(),
  source: z.enum(['summary', 'docstring']),
});

const IntentSymbolHitRowSchema = RawIntentSymbolHitRowSchema.extend({
  text: z.string().min(1),
});

export type IntentSymbolHitRow = z.infer<typeof IntentSymbolHitRowSchema>;

export const IntentTestNameHitRowSchema = z.object({
  file_path: z.string(),
  line: z.number(),
  description: z.string(),
  rank: z.number(),
});

export type IntentTestNameHitRow = z.infer<typeof IntentTestNameHitRowSchema>;

export interface IntentSearchFilters {
  kind?: string;
  language?: string;
  pathPrefix?: string;
}

interface IntentSymbolSearchArgs {
  db: SqliteDatabase;
  corpus: 'summary' | 'docstring';
  expression: string;
  filters: IntentSearchFilters;
  limit: number;
  rowCount: number;
}

interface IntentTestNameSearchArgs {
  db: SqliteDatabase;
  expression: string;
  pathPrefix?: string;
  limit: number;
  rowCount: number;
}

interface SqlWithParams {
  sql: string;
  params: unknown[];
}

const POSTGRES_SUMMARY_VECTOR = `to_tsvector('simple', COALESCE(ss.summary, ''))`;
const POSTGRES_DOCSTRING_VECTOR = `to_tsvector('simple', COALESCE(n.docstring, ''))`;
const POSTGRES_TEST_NAME_VECTOR = `to_tsvector('simple', COALESCE(tn.description, ''))`;

/**
 * Additive PostgreSQL accelerators. These deliberately live outside the
 * SQLite migration version chain: PostgreSQL is fresh-schema-only, while
 * `CREATE INDEX IF NOT EXISTS` safely upgrades existing current-version
 * schemas without forcing a destructive reinitialization. Call this only
 * from explicit write/admin lifecycle paths because PostgreSQL index DDL can
 * take locks on large existing tables.
 */
export function bootstrapPostgresIntentSearch(db: SqliteDatabase): void {
  if (db.dialect !== 'postgres') return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summary_store_intent_fts
      ON summary_store USING GIN (to_tsvector('simple', COALESCE(summary, '')));
    CREATE INDEX IF NOT EXISTS idx_nodes_docstring_intent_fts
      ON nodes USING GIN (to_tsvector('simple', COALESCE(docstring, '')));
    CREATE INDEX IF NOT EXISTS idx_test_names_intent_fts
      ON test_names USING GIN (to_tsvector('simple', COALESCE(description, '')));
  `);
}

export function searchIntentSymbolRows(args: IntentSymbolSearchArgs): IntentSymbolHitRow[] {
  if (args.rowCount <= 0) return [];
  const query = buildIntentSymbolQuery(args.db.dialect, args.corpus, args.filters);
  const rows = args.db.prepare(query.sql).all(args.expression, ...query.params, args.limit);
  return z
    .array(RawIntentSymbolHitRowSchema)
    .parse(rows)
    .filter((row): row is IntentSymbolHitRow => typeof row.text === 'string' && row.text.length > 0);
}

export function searchIntentTestNameRows(args: IntentTestNameSearchArgs): IntentTestNameHitRow[] {
  if (args.rowCount <= 0) return [];
  const query = buildIntentTestNameQuery(args.db.dialect, args.pathPrefix);
  const rows = args.db.prepare(query.sql).all(args.expression, ...query.params, args.limit);
  return z.array(IntentTestNameHitRowSchema).parse(rows);
}

function buildIntentSymbolQuery(
  dialect: SqliteDatabase['dialect'],
  corpus: IntentSymbolSearchArgs['corpus'],
  filters: IntentSearchFilters,
): SqlWithParams {
  const filter = buildSymbolFilterClause(filters);
  if (dialect === 'postgres') {
    return {
      sql: corpus === 'summary' ? postgresSummarySql(filter.sql) : postgresDocstringSql(filter.sql),
      params: filter.params,
    };
  }
  return {
    sql: corpus === 'summary' ? sqliteSummarySql(filter.sql) : sqliteDocstringSql(filter.sql),
    params: filter.params,
  };
}

function buildIntentTestNameQuery(dialect: SqliteDatabase['dialect'], pathPrefix: string | undefined): SqlWithParams {
  const filter = buildPathFilterClause('tn.file_path', pathPrefix);
  return {
    sql: dialect === 'postgres' ? postgresTestNameSql(filter.sql) : sqliteTestNameSql(filter.sql),
    params: filter.params,
  };
}

function buildSymbolFilterClause(filters: IntentSearchFilters): SqlWithParams {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.kind) {
    conditions.push('n.kind = ?');
    params.push(filters.kind);
  }
  if (filters.language) {
    conditions.push('n.language = ?');
    params.push(filters.language);
  }
  const path = buildPathFilterClause('n.file_path', filters.pathPrefix);
  if (path.sql) conditions.push(path.sql);
  params.push(...path.params);
  return { sql: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '', params };
}

function buildPathFilterClause(column: string, pathPrefix: string | undefined): SqlWithParams {
  if (!pathPrefix) return { sql: '', params: [] };
  return {
    sql: String.raw`${column} LIKE ? ESCAPE '\'`,
    params: [prefixLikePattern(pathPrefix)],
  };
}

function sqliteSummarySql(filter: string): string {
  return `
    SELECT n.id, n.name, n.kind, n.file_path, n.start_line,
           bm25(summary_fts) AS rank, ss.summary AS text, 'summary' AS source
      FROM summary_fts
      JOIN summary_store ss ON ss.ROWID = summary_fts.rowid
      JOIN summary_refs sr ON sr.body_hash = ss.body_hash AND sr.model = ss.model
      JOIN nodes n ON n.id = sr.node_id
     WHERE summary_fts MATCH ?${filter}
     ORDER BY rank
     LIMIT ?
  `;
}

function sqliteDocstringSql(filter: string): string {
  return `
    SELECT n.id, n.name, n.kind, n.file_path, n.start_line,
           bm25(docstring_fts) AS rank, n.docstring AS text, 'docstring' AS source
      FROM docstring_fts
      JOIN nodes n ON n.ROWID = docstring_fts.rowid
     WHERE docstring_fts MATCH ?${filter}
     ORDER BY rank
     LIMIT ?
  `;
}

function sqliteTestNameSql(filter: string): string {
  return `
    SELECT tn.file_path, tn.line, tn.description, bm25(test_names_fts) AS rank
      FROM test_names_fts
      JOIN test_names tn ON tn.id = test_names_fts.rowid
     WHERE test_names_fts MATCH ?${filter}
     ORDER BY rank
     LIMIT ?
  `;
}

function postgresSummarySql(filter: string): string {
  return `
    WITH intent_query AS (SELECT websearch_to_tsquery('simple', ?) AS value)
    SELECT n.id, n.name, n.kind, n.file_path, n.start_line,
           -ts_rank_cd(${POSTGRES_SUMMARY_VECTOR}, intent_query.value) AS rank,
           ss.summary AS text, 'summary' AS source
      FROM summary_store ss
      JOIN summary_refs sr ON sr.body_hash = ss.body_hash AND sr.model = ss.model
      JOIN nodes n ON n.id = sr.node_id
      CROSS JOIN intent_query
     WHERE ${POSTGRES_SUMMARY_VECTOR} @@ intent_query.value${filter}
     ORDER BY rank
     LIMIT ?
  `;
}

function postgresDocstringSql(filter: string): string {
  return `
    WITH intent_query AS (SELECT websearch_to_tsquery('simple', ?) AS value)
    SELECT n.id, n.name, n.kind, n.file_path, n.start_line,
           -ts_rank_cd(${POSTGRES_DOCSTRING_VECTOR}, intent_query.value) AS rank,
           n.docstring AS text, 'docstring' AS source
      FROM nodes n
      CROSS JOIN intent_query
     WHERE ${POSTGRES_DOCSTRING_VECTOR} @@ intent_query.value${filter}
     ORDER BY rank
     LIMIT ?
  `;
}

function postgresTestNameSql(filter: string): string {
  return `
    WITH intent_query AS (SELECT websearch_to_tsquery('simple', ?) AS value)
    SELECT tn.file_path, tn.line, tn.description,
           -ts_rank_cd(${POSTGRES_TEST_NAME_VECTOR}, intent_query.value) AS rank
      FROM test_names tn
      CROSS JOIN intent_query
     WHERE ${POSTGRES_TEST_NAME_VECTOR} @@ intent_query.value${filter}
     ORDER BY rank
     LIMIT ?
  `;
}
