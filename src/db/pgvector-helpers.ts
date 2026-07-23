/**
 * PostgreSQL pgvector helpers — optional native vector mirror.
 *
 * PostgreSQL still stores canonical embeddings in `embedding_store`
 * and `symbol_chunk_embeddings` as BYTEA so the storage contract is
 * portable and existing HNSW/in-memory fallbacks keep working. When
 * the `vector` extension is available, this module mirrors those rows
 * into per-dimension pgvector tables and serves indexed KNN queries
 * from them.
 */

import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { DatabaseConfig } from './database-config.js';
import type { SqliteDatabase } from './sqlite-adapter.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { getOrBuildCachedQuery } from './dynamic-query-cache.js';

const FLOAT32_BYTES = 4;
const MAX_VECTOR_DIM = 8192;

const NoParams = z.object({});
const OkRowSchema = z.object({ ok: z.number() });
const DimLenRowSchema = z.object({ len: z.number() });
const NameRowSchema = z.object({ name: z.string() });
const StoreBackfillRowSchema = z.object({
  r: z.union([z.number(), z.bigint()]),
  body_hash: z.string(),
  model: z.string(),
  grain: z.string(),
  embedding: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]),
});
const ChunkBackfillRowSchema = z.object({
  r: z.union([z.number(), z.bigint()]),
  node_id: z.string(),
  embedding_model: z.string(),
  embedding: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]),
});
const PgvectorHitRowSchema = z.object({ node_id: z.string(), distance: z.number() });

const pgvectorAvailableQuery = defineQuery({
  sql: "SELECT CASE WHEN to_regtype('public.vector') IS NULL THEN 0 ELSE 1 END AS ok",
  params: NoParams,
  row: OkRowSchema,
});

// `to_regclass` returns the relation's regclass (cast to its qualified name
// here) or NULL — crucially, NULL rather than an error for a missing table,
// unlike `name::regclass`. Used to skip a KNN against a mirror table that the
// lazy `ensurePgvectorMirrorTable` path hasn't created yet, so Postgres never
// logs a `relation does not exist` ERROR for a search-before-write.
const pgvectorTableExistsQuery = defineQuery({
  sql: 'SELECT to_regclass(@name)::text AS oid',
  params: z.object({ name: z.string() }),
  row: z.object({ oid: z.string().nullable() }),
});

const storeDimsQuery = defineQuery({
  sql: 'SELECT DISTINCT LENGTH(embedding) AS len FROM embedding_store',
  params: NoParams,
  row: DimLenRowSchema,
});

const chunkDimsQuery = defineQuery({
  sql: 'SELECT DISTINCT LENGTH(embedding) AS len FROM symbol_chunk_embeddings',
  params: NoParams,
  row: DimLenRowSchema,
});

const pgvectorTableNamesQuery = defineQuery({
  sql: `SELECT table_name AS name
          FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_type = 'BASE TABLE'
           AND (
                table_name LIKE 'pgvector_symbol_embeddings_%'
             OR table_name LIKE 'pgvector_chunk_embeddings_%'
           )`,
  params: NoParams,
  row: NameRowSchema,
});

const PgvectorStoreParams = z.object({
  rowid: z.union([z.number(), z.bigint()]),
  bodyHash: z.string(),
  model: z.string(),
  grain: z.string(),
  embedding: z.string(),
});
const PgvectorChunkParams = z.object({
  rowid: z.union([z.number(), z.bigint()]),
  nodeId: z.string(),
  model: z.string(),
  embedding: z.string(),
});
const BackfillLenParams = z.object({ byteLen: z.number() });
const KnnParams = z.object({
  embedding: z.string(),
  model: z.string(),
  fetch: z.number(),
});

interface BackfillSqlArgs {
  selectList: string;
  sourceTable: string;
  sourceAlias: string;
  mirrorRowColumn: 'store_rowid' | 'chunk_rowid';
}

const STORE_BACKFILL_SQL_ARGS: BackfillSqlArgs = {
  selectList: 'es.rowid AS r, es.body_hash, es.model, es.grain, es.embedding',
  sourceTable: 'embedding_store',
  sourceAlias: 'es',
  mirrorRowColumn: 'store_rowid',
};

const CHUNK_BACKFILL_SQL_ARGS: BackfillSqlArgs = {
  selectList: 'sce.rowid AS r, sce.node_id, sce.embedding_model, sce.embedding',
  sourceTable: 'symbol_chunk_embeddings',
  sourceAlias: 'sce',
  mirrorRowColumn: 'chunk_rowid',
};

function backfillSqlFor(name: string, args: BackfillSqlArgs): string {
  const selectList = args.selectList;
  const sourceTable = args.sourceTable;
  const sourceAlias = args.sourceAlias;
  const mirrorRowColumn = args.mirrorRowColumn;
  return `SELECT ${selectList}
            FROM ${sourceTable} ${sourceAlias}
            LEFT JOIN ${name} p ON p.${mirrorRowColumn} = ${sourceAlias}.rowid
           WHERE LENGTH(${sourceAlias}.embedding) = @byteLen
             AND p.${mirrorRowColumn} IS NULL`;
}

function defineBackfillQuery<RSchema extends z.ZodType>(sql: string, row: RSchema) {
  return defineQuery({ sql, params: BackfillLenParams, row, options: { validateRows: 'first' } });
}

function storeBackfillQueryFor(name: string) {
  return defineBackfillQuery(backfillSqlFor(name, STORE_BACKFILL_SQL_ARGS), StoreBackfillRowSchema);
}

function chunkBackfillQueryFor(name: string) {
  return defineBackfillQuery(backfillSqlFor(name, CHUNK_BACKFILL_SQL_ARGS), ChunkBackfillRowSchema);
}

function upsertStorePgvectorQueryFor(name: string) {
  return defineQuery({
    sql: `INSERT INTO ${name} (store_rowid, body_hash, model, grain, embedding)
          VALUES (@rowid, @bodyHash, @model, @grain, @embedding::public.vector)
          ON CONFLICT(store_rowid) DO UPDATE SET
            body_hash = excluded.body_hash,
            model = excluded.model,
            grain = excluded.grain,
            embedding = excluded.embedding`,
    params: PgvectorStoreParams,
    row: z.never(),
  });
}

function upsertChunkPgvectorQueryFor(name: string) {
  return defineQuery({
    sql: `INSERT INTO ${name} (chunk_rowid, node_id, embedding_model, embedding)
          VALUES (@rowid, @nodeId, @model, @embedding::public.vector)
          ON CONFLICT(chunk_rowid) DO UPDATE SET
            node_id = excluded.node_id,
            embedding_model = excluded.embedding_model,
            embedding = excluded.embedding`,
    params: PgvectorChunkParams,
    row: z.never(),
  });
}

function findSimilarStoreAllQueryFor(name: string) {
  return defineQuery({
    sql: `SELECT r.node_id AS node_id, p.embedding <=> @embedding::public.vector AS distance
            FROM ${name} p
            JOIN embedding_refs r
              ON r.body_hash = p.body_hash
             AND r.model = p.model
             AND r.grain = p.grain
           WHERE p.model = @model
           ORDER BY p.embedding <=> @embedding::public.vector
           LIMIT @fetch`,
    params: KnnParams,
    row: PgvectorHitRowSchema,
  });
}

function findSimilarStoreSymbolQueryFor(name: string) {
  return defineQuery({
    sql: `SELECT r.node_id AS node_id, p.embedding <=> @embedding::public.vector AS distance
            FROM ${name} p
            JOIN embedding_refs r
              ON r.body_hash = p.body_hash
             AND r.model = p.model
             AND r.grain = p.grain
           WHERE p.model = @model
             AND p.grain = 'symbol'
           ORDER BY p.embedding <=> @embedding::public.vector
           LIMIT @fetch`,
    params: KnnParams,
    row: PgvectorHitRowSchema,
  });
}

function findSimilarChunkQueryFor(name: string) {
  return defineQuery({
    sql: `SELECT node_id, embedding <=> @embedding::public.vector AS distance
            FROM ${name}
           WHERE embedding_model = @model
           ORDER BY embedding <=> @embedding::public.vector
           LIMIT @fetch`,
    params: KnnParams,
    row: PgvectorHitRowSchema,
  });
}

const pgvectorAvailableByDb = new WeakMap<SqliteDatabase, boolean>();
const ensuredStoreTablesByDb = new WeakMap<SqliteDatabase, Set<number>>();
const ensuredChunkTablesByDb = new WeakMap<SqliteDatabase, Set<number>>();
// Per-(db, table-name) existence cache for the KNN guard. A successful CREATE in
// `ensurePgvectorMirrorTable` records `true`; a negative `to_regclass` result is
// cached so repeated searches before the table exists never re-probe.
const pgvectorTableExistsByDb = new WeakMap<SqliteDatabase, Map<string, boolean>>();
type PgvectorMirrorTableKind = 'store' | 'chunk';

const storeBackfillByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof BackfillLenParams>, z.infer<typeof StoreBackfillRowSchema>>>
>();
const chunkBackfillByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof BackfillLenParams>, z.infer<typeof ChunkBackfillRowSchema>>>
>();
const upsertStoreByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof PgvectorStoreParams>, never>>
>();
const upsertChunkByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof PgvectorChunkParams>, never>>
>();
const knnStoreAllByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof KnnParams>, z.infer<typeof PgvectorHitRowSchema>>>
>();
const knnStoreSymbolByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof KnnParams>, z.infer<typeof PgvectorHitRowSchema>>>
>();
const knnChunkByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof KnnParams>, z.infer<typeof PgvectorHitRowSchema>>>
>();

function getStoreBackfillQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: storeBackfillByDbAndName, db, name, build: storeBackfillQueryFor });
}

function getChunkBackfillQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: chunkBackfillByDbAndName, db, name, build: chunkBackfillQueryFor });
}

function getUpsertStorePgvectorQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: upsertStoreByDbAndName, db, name, build: upsertStorePgvectorQueryFor });
}

function getUpsertChunkPgvectorQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: upsertChunkByDbAndName, db, name, build: upsertChunkPgvectorQueryFor });
}

function getKnnStoreAllQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: knnStoreAllByDbAndName, db, name, build: findSimilarStoreAllQueryFor });
}

function getKnnStoreSymbolQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: knnStoreSymbolByDbAndName, db, name, build: findSimilarStoreSymbolQueryFor });
}

function getKnnChunkQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: knnChunkByDbAndName, db, name, build: findSimilarChunkQueryFor });
}

export function pgvectorStoreTableNameForDim(dim: number): string {
  return `pgvector_symbol_embeddings_${dim}`;
}

export function pgvectorChunkTableNameForDim(dim: number): string {
  return `pgvector_chunk_embeddings_${dim}`;
}

function isValidDim(dim: number): boolean {
  return Number.isInteger(dim) && dim > 0 && dim <= MAX_VECTOR_DIM;
}

function vectorLiteralFromBytes(embedding: Buffer | Uint8Array): string | null {
  if (embedding.byteLength % FLOAT32_BYTES !== 0) return null;
  const bytes = Buffer.isBuffer(embedding)
    ? embedding
    : Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const values: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += FLOAT32_BYTES) {
    const value = bytes.readFloatLE(offset);
    if (!Number.isFinite(value)) return null;
    values.push(formatVectorNumber(value));
  }
  return `[${values.join(',')}]`;
}

function vectorLiteralFromFloat32Array(vector: Float32Array): string | null {
  const values: string[] = [];
  for (const value of vector) {
    if (!Number.isFinite(value)) return null;
    values.push(formatVectorNumber(value));
  }
  return `[${values.join(',')}]`;
}

function formatVectorNumber(value: number): string {
  if (Object.is(value, -0)) return '0';
  return Number(value.toPrecision(8)).toString();
}

function discoverDims(query: ReturnType<typeof storeDimsQuery>): number[] {
  try {
    return query
      .all({})
      .map((row) => Math.floor(row.len / FLOAT32_BYTES))
      .filter(isValidDim);
  } catch {
    return [];
  }
}

export function isPgvectorAvailable(db: SqliteDatabase): boolean {
  if (db.dialect !== 'postgres') return false;
  const cached = pgvectorAvailableByDb.get(db);
  if (cached !== undefined) return cached;
  try {
    const ok = pgvectorAvailableQuery(db).get({})?.ok === 1;
    pgvectorAvailableByDb.set(db, ok);
    return ok;
  } catch {
    pgvectorAvailableByDb.set(db, false);
    return false;
  }
}

function pgvectorTableExistsCache(db: SqliteDatabase): Map<string, boolean> {
  let cache = pgvectorTableExistsByDb.get(db);
  if (!cache) {
    cache = new Map();
    pgvectorTableExistsByDb.set(db, cache);
  }
  return cache;
}

/**
 * Whether `name` resolves to an existing relation on this connection. Caches
 * per (db, name): the KNN search consults this before querying a mirror table,
 * so a search issued before the lazily-created table exists is skipped rather
 * than throwing `relation does not exist` (which Postgres logs server-side even
 * though the caller catches it — pure noise in CI container logs). The cache is
 * primed to `true` by `ensurePgvectorMirrorTable` on a successful CREATE.
 */
function pgvectorTableExists(db: SqliteDatabase, name: string): boolean {
  const cache = pgvectorTableExistsCache(db);
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  try {
    const exists = pgvectorTableExistsQuery(db).get({ name })?.oid != null;
    cache.set(name, exists); // cache only a definitive probe result
    return exists;
  } catch {
    // A transient probe failure (e.g. a connection blip) must NOT poison the
    // cache — leave the entry absent so the next call re-probes, rather than
    // permanently suppressing KNN for this db instance.
    return false;
  }
}

export function bootstrapPgvector(db: SqliteDatabase, database: DatabaseConfig): boolean {
  if (db.dialect !== 'postgres') return false;
  const mode = database.pgvector ?? 'auto';
  if (mode === 'off') {
    pgvectorAvailableByDb.set(db, false);
    return false;
  }

  try {
    db.exec('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    if (!isPgvectorAvailable(db)) {
      pgvectorAvailableByDb.delete(db);
      db.exec('ALTER EXTENSION vector SET SCHEMA public');
      pgvectorAvailableByDb.delete(db);
    }
  } catch (err) {
    pgvectorAvailableByDb.set(db, false);
    if (mode === 'require') {
      throw new Error(`database.pgvector=require but PostgreSQL could not enable pgvector: ${(err as Error).message}`);
    }
    return false;
  }

  const available = isPgvectorAvailable(db);
  if (!available && mode === 'require') {
    throw new Error('database.pgvector=require but PostgreSQL extension `vector` is not available.');
  }
  return available;
}

export function bootstrapPgvectorTables(db: SqliteDatabase, pgvectorAvailable: boolean): void {
  if (!pgvectorAvailable || db.dialect !== 'postgres') return;
  const storeDims = discoverDims(storeDimsQuery(db));
  for (const dim of storeDims) {
    backfillPgvectorStoreTable(db, dim);
  }
  const chunkDims = discoverDims(chunkDimsQuery(db));
  for (const dim of chunkDims) {
    backfillPgvectorChunkTable(db, dim);
  }
}

function backfillPgvectorStoreTable(db: SqliteDatabase, dim: number): void {
  if (!ensurePgvectorMirrorTable(db, dim, 'store')) return;
  const tableName = pgvectorStoreTableNameForDim(dim);
  const rows = getStoreBackfillQuery(db, tableName).all({ byteLen: dim * FLOAT32_BYTES });
  for (const row of rows) {
    mirrorEmbeddingToPgvector({
      db,
      rowid: row.r,
      bodyHash: row.body_hash,
      model: row.model,
      grain: row.grain,
      embedding: row.embedding,
    });
  }
}

function backfillPgvectorChunkTable(db: SqliteDatabase, dim: number): void {
  if (!ensurePgvectorMirrorTable(db, dim, 'chunk')) return;
  const tableName = pgvectorChunkTableNameForDim(dim);
  const rows = getChunkBackfillQuery(db, tableName).all({ byteLen: dim * FLOAT32_BYTES });
  for (const row of rows) {
    mirrorChunkEmbeddingToPgvector({
      db,
      rowid: row.r,
      nodeId: row.node_id,
      model: row.embedding_model,
      embedding: row.embedding,
    });
  }
}

function ensurePgvectorMirrorTable(db: SqliteDatabase, dim: number, kind: PgvectorMirrorTableKind): boolean {
  if (!isValidDim(dim) || !isPgvectorAvailable(db)) return false;
  const ensuredByDb = kind === 'store' ? ensuredStoreTablesByDb : ensuredChunkTablesByDb;
  const ensured = ensuredByDb.get(db) ?? new Set<number>();
  if (ensured.has(dim)) return true;
  ensuredByDb.set(db, ensured);
  const name = kind === 'store' ? pgvectorStoreTableNameForDim(dim) : pgvectorChunkTableNameForDim(dim);
  const indexPrefix = kind === 'store' ? `pgv_se_${dim}` : `pgv_ce_${dim}`;
  try {
    db.exec(pgvectorCreateTableSql(kind, name, dim));
    db.exec(pgvectorLookupIndexSql(kind, name, dim));
    ensurePgvectorKnnIndex(db, name, indexPrefix);
    ensured.add(dim);
    pgvectorTableExistsCache(db).set(name, true); // primed so the KNN guard doesn't re-probe
    return true;
  } catch {
    return false;
  }
}

function pgvectorCreateTableSql(kind: PgvectorMirrorTableKind, name: string, dim: number): string {
  if (kind === 'store') {
    return `CREATE TABLE IF NOT EXISTS ${name} (
      store_rowid BIGINT PRIMARY KEY REFERENCES embedding_store(rowid) ON DELETE CASCADE,
      body_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      grain TEXT NOT NULL CHECK (grain IN ('symbol', 'file')),
      embedding public.vector(${dim}) NOT NULL
    )`;
  }
  return `CREATE TABLE IF NOT EXISTS ${name} (
      chunk_rowid BIGINT PRIMARY KEY REFERENCES symbol_chunk_embeddings(rowid) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      embedding_model TEXT NOT NULL,
      embedding public.vector(${dim}) NOT NULL
    )`;
}

function pgvectorLookupIndexSql(kind: PgvectorMirrorTableKind, name: string, dim: number): string {
  if (kind === 'store') return `CREATE INDEX IF NOT EXISTS pgv_se_${dim}_model_grain ON ${name}(model, grain)`;
  return `CREATE INDEX IF NOT EXISTS pgv_ce_${dim}_model ON ${name}(embedding_model)`;
}

function ensurePgvectorKnnIndex(db: SqliteDatabase, tableName: string, indexPrefix: string): void {
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS ${indexPrefix}_hnsw ON ${tableName} USING hnsw (embedding vector_cosine_ops)`);
    return;
  } catch {
    // Older pgvector releases may not support HNSW. Try IVFFlat; if
    // that fails too, ordered scans still work and the caller falls
    // back at the query layer on any hard error.
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${indexPrefix}_ivf ON ${tableName} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
  } catch {
    // Best-effort acceleration only.
  }
}

interface MirrorEmbeddingToPgvectorOpts {
  db: SqliteDatabase;
  rowid: number | bigint;
  bodyHash: string;
  model: string;
  grain: string;
  embedding: Buffer | Uint8Array;
}

export function mirrorEmbeddingToPgvector(opts: MirrorEmbeddingToPgvectorOpts): void {
  const { db, rowid, bodyHash, model, grain, embedding } = opts;
  if (db.dialect !== 'postgres') return;
  const dim = Math.floor(embedding.byteLength / FLOAT32_BYTES);
  if (!ensurePgvectorMirrorTable(db, dim, 'store')) return;
  const literal = vectorLiteralFromBytes(embedding);
  if (!literal) return;
  try {
    getUpsertStorePgvectorQuery(db, pgvectorStoreTableNameForDim(dim)).run({
      rowid,
      bodyHash,
      model,
      grain,
      embedding: literal,
    });
  } catch {
    // The canonical BYTEA write already succeeded; pgvector is an
    // optional mirror and can be repaired by bootstrap/backfill.
  }
}

interface MirrorChunkEmbeddingToPgvectorOpts {
  db: SqliteDatabase;
  rowid: number | bigint;
  nodeId: string;
  model: string;
  embedding: Buffer | Uint8Array;
}

export function mirrorChunkEmbeddingToPgvector(opts: MirrorChunkEmbeddingToPgvectorOpts): void {
  const { db, rowid, nodeId, model, embedding } = opts;
  if (db.dialect !== 'postgres') return;
  const dim = Math.floor(embedding.byteLength / FLOAT32_BYTES);
  if (!ensurePgvectorMirrorTable(db, dim, 'chunk')) return;
  const literal = vectorLiteralFromBytes(embedding);
  if (!literal) return;
  try {
    getUpsertChunkPgvectorQuery(db, pgvectorChunkTableNameForDim(dim)).run({
      rowid,
      nodeId,
      model,
      embedding: literal,
    });
  } catch {
    // Optional mirror; the BYTEA chunk row remains authoritative.
  }
}

export interface PgvectorHit {
  nodeId: string;
  distance: number;
}

export interface FindSimilarViaPgvectorOpts {
  db: SqliteDatabase;
  queryVec: Float32Array;
  model: string;
  k: number;
  grain?: 'all' | 'symbol';
  includeChunks?: boolean;
}

export function findSimilarViaPgvector(opts: FindSimilarViaPgvectorOpts): PgvectorHit[] {
  const { db, queryVec, model, k } = opts;
  if (db.dialect !== 'postgres' || !isPgvectorAvailable(db)) return [];
  const dim = queryVec.length;
  if (!isValidDim(dim)) return [];
  const embedding = vectorLiteralFromFloat32Array(queryVec);
  if (!embedding) return [];
  const fetch = Math.max(k * 4, k + 5);
  const params = { embedding, model, fetch };
  const tableName = pgvectorStoreTableNameForDim(dim);
  let rows: PgvectorHit[] = [];
  // Skip the KNN when the lazily-created mirror table doesn't exist yet (e.g. a
  // search before any embedding of this dim was written), so Postgres doesn't
  // log a `relation does not exist` ERROR. The try/catch stays as a backstop
  // for a table dropped concurrently after the existence check.
  if (pgvectorTableExists(db, tableName)) {
    try {
      const query =
        opts.grain === 'symbol' ? getKnnStoreSymbolQuery(db, tableName) : getKnnStoreAllQuery(db, tableName);
      rows = query.all(params).map((row) => ({ nodeId: row.node_id, distance: row.distance }));
    } catch {
      rows = [];
    }
  }

  const includeChunks = opts.includeChunks ?? true;
  if (!includeChunks) return rows.slice(0, k);

  let chunkRows: PgvectorHit[] = [];
  const chunkTableName = pgvectorChunkTableNameForDim(dim);
  if (pgvectorTableExists(db, chunkTableName)) {
    try {
      chunkRows = getKnnChunkQuery(db, chunkTableName)
        .all(params)
        .map((row) => ({ nodeId: row.node_id, distance: row.distance }));
    } catch {
      chunkRows = [];
    }
  }
  if (chunkRows.length === 0) return rows.slice(0, k);
  return mergeByBestDistance(rows, chunkRows, k);
}

function mergeByBestDistance(primary: PgvectorHit[], secondary: PgvectorHit[], k: number): PgvectorHit[] {
  const minDistByNode = new Map<string, number>();
  for (const hit of primary) {
    const current = minDistByNode.get(hit.nodeId);
    if (current === undefined || hit.distance < current) minDistByNode.set(hit.nodeId, hit.distance);
  }
  for (const hit of secondary) {
    const current = minDistByNode.get(hit.nodeId);
    if (current === undefined || hit.distance < current) minDistByNode.set(hit.nodeId, hit.distance);
  }
  return [...minDistByNode.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([nodeId, distance]) => ({ nodeId, distance }));
}

export function clearPgvectorTables(db: SqliteDatabase): void {
  if (db.dialect !== 'postgres' || !isPgvectorAvailable(db)) return;
  let names: Array<{ name: string }>;
  try {
    names = pgvectorTableNamesQuery(db).all({});
  } catch {
    return;
  }
  for (const { name } of names) {
    if (!/^pgvector_(symbol|chunk)_embeddings_\d+$/.test(name)) continue;
    try {
      db.exec(`DELETE FROM ${name}`);
    } catch {
      // best-effort reset
    }
  }
}

/**
 * Drop PostgreSQL store-mirror tables whose dimension no longer exists in
 * canonical `embedding_store`. Live tables need no rebuild: their
 * `store_rowid` foreign key uses `ON DELETE CASCADE`, so canonical cleanup
 * removes mirror rows atomically. Chunk mirrors are deliberately independent.
 */
export function reconcilePgvectorStoreTables(db: SqliteDatabase): { droppedDimensions: number[] } {
  const result = { droppedDimensions: [] as number[] };
  if (db.dialect !== 'postgres' || !isPgvectorAvailable(db)) return result;
  const liveDimensions = new Set(discoverDims(storeDimsQuery(db)));
  let names: Array<{ name: string }>;
  try {
    names = pgvectorTableNamesQuery(db).all({});
  } catch {
    return result;
  }
  for (const { name } of names) {
    const match = /^pgvector_symbol_embeddings_(\d+)$/.exec(name);
    if (!match) continue;
    const dim = Number(match[1]);
    if (!isValidDim(dim) || liveDimensions.has(dim)) continue;
    try {
      db.exec(`DROP TABLE IF EXISTS ${name} CASCADE`);
      ensuredStoreTablesByDb.get(db)?.delete(dim);
      pgvectorTableExistsCache(db).set(name, false);
      result.droppedDimensions.push(dim);
    } catch {
      // Canonical rows are already safe; a later maintenance run can retry
      // dropping the optional empty acceleration table.
    }
  }
  result.droppedDimensions.sort((a, b) => a - b);
  return result;
}
