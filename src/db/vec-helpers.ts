/**
 * sqlite-vec helpers — bootstrap, write-mirror, KNN query.
 *
 * The bun:sqlite backend optionally loads the sqlite-vec extension at
 * connection time (see `tryLoadVecExtension` in `sqlite-adapter.ts`).
 * When loaded, similarity search uses an
 * indexed `vec0` virtual table; when not loaded, the existing
 * in-memory `EmbeddingCache` brute-force scan in `src/llm/embeddings.ts`
 * remains the fallback. Every public function here is a no-op when
 * `vecLoaded` is false — callers don't branch on it.
 *
 * Design choices:
 *   - One vec0 table per embedding-DIMENSION (`vec_symbol_embeddings_<dim>`).
 *     vec0 fixes its dim at table creation, but most projects use one
 *     model at a time so usually one table exists. New dim = new table.
 *   - vec0 rowid mirrors `symbol_embeddings.rowid` so JOINs are cheap.
 *   - `distance_metric=cosine` so MATCH results sort directly by
 *     cosine distance; we convert distance -> similarity score in
 *     the query layer (`similarity = 1 - distance` for L2-normalised
 *     vectors, which all our embeddings are).
 *   - All operations idempotent: bootstrap re-runs are no-ops,
 *     mirror-writes use INSERT OR REPLACE.
 */

import { z } from 'zod';
import type { SqliteDatabase } from './sqlite-adapter.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { getOrBuildCachedQuery } from './dynamic-query-cache.js';

/** Float32 = 4 bytes per element, used to derive embedding dim from BLOB length. */
const FLOAT32_BYTES = 4;
/** sqlite-vec stores vectors in fixed 1024-row chunks. */
const VEC_CHUNK_CAPACITY = 1024;

// ─── Typed-query infrastructure ───────────────────────────────────────────
//
// Every prepared statement in this file targets a dim-keyed dynamic table
// name (`vec_symbol_embeddings_<dim>` / `vec_chunk_embeddings_<dim>`).
// Pattern D: a per-(db, name) cache of typed queries — one factory
// closure per logical query, materialised lazily per table name and
// reused thereafter. The static sqlite_master listing query is Pattern A.

const DimLenRowSchema = z.object({ len: z.number() });
const SqliteMasterNameRowSchema = z.object({ name: z.string() });
const VecHitRowSchema = z.object({ node_id: z.string(), distance: z.number() });
const NoParams = z.object({});

const listVecTablesQuery = defineQuery({
  sql:
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
    "AND (name LIKE 'vec_symbol_embeddings_%' OR name LIKE 'vec_chunk_embeddings_%')",
  params: NoParams,
  row: SqliteMasterNameRowSchema,
});

const listVecTablesByDbCache = new WeakMap<SqliteDatabase, ReturnType<typeof listVecTablesQuery>>();
function getListVecTablesQuery(db: SqliteDatabase): ReturnType<typeof listVecTablesQuery> {
  let q = listVecTablesByDbCache.get(db);
  if (!q) {
    q = listVecTablesQuery(db);
    listVecTablesByDbCache.set(db, q);
  }
  return q;
}

type DiscoverDimsTable = 'embedding_store' | 'symbol_chunk_embeddings';

/**
 * Factory: distinct embedding dims (derived from BLOB length) in
 * a given source table. The table name is interpolated into the SQL
 * at factory time, so each (db, table-name) pair gets its own
 * prepared statement. The `table` parameter is type-narrowed to the
 * closed `DiscoverDimsTable` union so the interpolation is
 * machine-checked at the boundary — not a stringly-typed promise.
 */
function discoverDimsQueryFor(table: DiscoverDimsTable) {
  return defineQuery({
    sql: `SELECT DISTINCT LENGTH(embedding) AS len FROM ${table}`,
    params: NoParams,
    row: DimLenRowSchema,
  });
}

const discoverDimsByDbAndTable = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<Record<string, never>, z.infer<typeof DimLenRowSchema>>>
>();
function getDiscoverDimsQuery(
  db: SqliteDatabase,
  table: DiscoverDimsTable,
): TypedQuery<Record<string, never>, z.infer<typeof DimLenRowSchema>> {
  return getOrBuildCachedQuery({ cache: discoverDimsByDbAndTable, db, name: table, build: discoverDimsQueryFor });
}

/**
 * Factories for vec0 mirror writes — `DELETE FROM ${name} WHERE rowid = @rowid` /
 * `INSERT INTO ${name}(rowid, embedding) VALUES (@rowid, @embedding)`. One
 * prepared statement per vec0 table name. The name is whitelisted by
 * the caller (regex `^vec_(symbol|chunk)_embeddings_\d+$` enforced
 * via {@link vecTableNameForDim} / {@link vecChunkTableNameForDim}).
 */
const VecDeleteParams = z.object({ rowid: z.bigint() });
const VecInsertParams = z.object({
  rowid: z.bigint(),
  embedding: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]),
});

function vecDeleteByRowidQueryFor(name: string) {
  return defineQuery({
    sql: `DELETE FROM ${name} WHERE rowid = @rowid`,
    params: VecDeleteParams,
    row: z.never(),
  });
}

function vecInsertRowidEmbeddingQueryFor(name: string) {
  return defineQuery({
    sql: `INSERT INTO ${name}(rowid, embedding) VALUES (@rowid, @embedding)`,
    params: VecInsertParams,
    row: z.never(),
  });
}

const vecDeleteByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof VecDeleteParams>, never>>
>();
const vecInsertByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof VecInsertParams>, never>>
>();

function getVecDeleteQuery(db: SqliteDatabase, name: string): TypedQuery<z.infer<typeof VecDeleteParams>, never> {
  return getOrBuildCachedQuery({ cache: vecDeleteByDbAndName, db, name, build: vecDeleteByRowidQueryFor });
}

function getVecInsertQuery(db: SqliteDatabase, name: string): TypedQuery<z.infer<typeof VecInsertParams>, never> {
  return getOrBuildCachedQuery({ cache: vecInsertByDbAndName, db, name, build: vecInsertRowidEmbeddingQueryFor });
}

/**
 * Factories for the KNN search queries. Two shapes — the
 * symbol-grain join through `embedding_store` / `embedding_refs`, and
 * the chunk-grain join through `symbol_chunk_embeddings`. Each cached
 * per (db, table-name).
 */
const KnnParams = z.object({
  embedding: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  k: z.number(),
  model: z.string(),
  fetch: z.number(),
});

function findSimilarSymbolGrainQueryFor(name: string) {
  return defineQuery({
    sql: `SELECT r.node_id AS node_id, v.distance AS distance
         FROM ${name} v
         JOIN embedding_store s ON s.rowid = v.rowid
         JOIN embedding_refs r
           ON r.body_hash = s.body_hash
          AND r.model = s.model
          AND r.grain = s.grain
        WHERE v.embedding MATCH @embedding
          AND v.k = @k
          AND s.model = @model
          AND s.grain = 'symbol'
        ORDER BY v.distance
        LIMIT @fetch`,
    params: KnnParams,
    row: VecHitRowSchema,
  });
}

function findSimilarChunkGrainQueryFor(name: string) {
  return defineQuery({
    sql: `SELECT s.node_id AS node_id, v.distance AS distance
         FROM ${name} v
         JOIN symbol_chunk_embeddings s ON s.rowid = v.rowid
        WHERE v.embedding MATCH @embedding
          AND v.k = @k
          AND s.embedding_model = @model
        ORDER BY v.distance
        LIMIT @fetch`,
    params: KnnParams,
    row: VecHitRowSchema,
  });
}

const knnSymbolByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof KnnParams>, z.infer<typeof VecHitRowSchema>>>
>();
const knnChunkByDbAndName = new WeakMap<
  SqliteDatabase,
  Map<string, TypedQuery<z.infer<typeof KnnParams>, z.infer<typeof VecHitRowSchema>>>
>();

function getKnnSymbolQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: knnSymbolByDbAndName, db, name, build: findSimilarSymbolGrainQueryFor });
}

function getKnnChunkQuery(db: SqliteDatabase, name: string) {
  return getOrBuildCachedQuery({ cache: knnChunkByDbAndName, db, name, build: findSimilarChunkGrainQueryFor });
}

/**
 * Build the vec0 table name for a given embedding dimension. Stable
 * across runs so re-bootstrap finds the same table.
 */
export function vecTableNameForDim(dim: number): string {
  return `vec_symbol_embeddings_${dim}`;
}

/**
 * Multi-vector retrieval (Stage 5 #C): vec0 mirror table for
 * `symbol_chunk_embeddings`. One per dim, parallel to the main
 * `vec_symbol_embeddings_<dim>` table. Rowids are
 * `symbol_chunk_embeddings.rowid` (NOT compatible with the main vec
 * table's rowids — different SQLite tables, different rowid spaces).
 */
export function vecChunkTableNameForDim(dim: number): string {
  return `vec_chunk_embeddings_${dim}`;
}

/**
 * Sanity-check that a value looks like a positive embedding dimension.
 * Defends against accidental `NaN` / negative dim hitting SQL DDL where
 * it would either fail noisily or (worse) succeed with a 0-dim table.
 */
function isValidDim(dim: number): boolean {
  return Number.isInteger(dim) && dim > 0 && dim <= 8192;
}

/**
 * Scan a single-column `LENGTH(embedding)` distinct over `table` and
 * return the valid embedding dimensions found (BLOB byte-length /
 * FLOAT32_BYTES, filtered by `isValidDim`). Returns `[]` on any SQL
 * error (e.g. table absent on a pre-migration DB).
 */
function discoverDimsInTable(db: SqliteDatabase, table: DiscoverDimsTable): number[] {
  try {
    const rows = getDiscoverDimsQuery(db, table).all({});
    return rows.map((r) => Math.floor(r.len / FLOAT32_BYTES)).filter(isValidDim);
  } catch {
    return [];
  }
}

/**
 * Inspect existing `embedding_store` rows and return the distinct
 * embedding dimensions present (derived from BLOB length). Empty
 * array when the table is empty.
 *
 * Design C: embedding_store is the canonical content-addressed
 * storage. The legacy `symbol_embeddings` VIEW joins through refs;
 * scanning the store directly is faster (one column scan).
 *
 * For native typical workloads this is a fast scan-and-distinct on a
 * small column; SQLite caches the page so repeated calls are
 * sub-millisecond.
 */
function discoverEmbeddingDims(db: SqliteDatabase): number[] {
  // On error (pre-migration-050 state, table missing) → nothing to bootstrap.
  return discoverDimsInTable(db, 'embedding_store');
}

/** Same scan, against the multi-vec sibling table. Empty when no
 *  chunks have been embedded yet. */
function discoverChunkEmbeddingDims(db: SqliteDatabase): number[] {
  return discoverDimsInTable(db, 'symbol_chunk_embeddings');
}

/**
 * Create vec0 virtual tables for every embedding dim found in
 * `symbol_embeddings`, then backfill any rows that aren't yet
 * mirrored. Idempotent — safe to run on every DatabaseConnection
 * open. No-op when `vecLoaded` is false.
 *
 * The backfill uses INSERT OR IGNORE so re-runs don't duplicate.
 */
export function bootstrapVecTables(db: SqliteDatabase, vecLoaded: boolean): void {
  if (!vecLoaded) return;
  const dims = discoverEmbeddingDims(db);
  for (const dim of dims) {
    const table = { name: vecTableNameForDim(dim), sourceTable: 'embedding_store' as const, dim };
    ensureVecTable(db, dim);
    if (vecTableNeedsRebuild(db, table)) {
      rebuildVecTable(db, table);
    } else {
      backfillVecTable(db, dim);
    }
  }
  // Stage 5 #C — also bootstrap the multi-vec chunk tables. Idempotent
  // and cheap when symbol_chunk_embeddings has no rows yet.
  const chunkDims = discoverChunkEmbeddingDims(db);
  for (const dim of chunkDims) {
    const table = { name: vecChunkTableNameForDim(dim), sourceTable: 'symbol_chunk_embeddings' as const, dim };
    ensureChunkVecTable(db, dim);
    if (vecTableNeedsRebuild(db, table)) {
      rebuildVecTable(db, table);
    } else {
      backfillChunkVecTable(db, dim);
    }
  }
}

/** Create the multi-vec table for `dim` if it doesn't exist. Mirrors
 *  ensureVecTable's shape exactly — same vec0 cosine config. */
export function ensureChunkVecTable(db: SqliteDatabase, dim: number): void {
  if (!isValidDim(dim)) return;
  const name = vecChunkTableNameForDim(dim);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}] distance_metric=cosine)`);
}

/** Backfill the multi-vec mirror from `symbol_chunk_embeddings` —
 *  same NOT-IN pattern as the main table since vec0 rejects
 *  INSERT OR IGNORE. */
function backfillChunkVecTable(db: SqliteDatabase, dim: number): void {
  const name = vecChunkTableNameForDim(dim);
  const byteLen = dim * FLOAT32_BYTES;
  db.exec(
    `INSERT INTO ${name}(rowid, embedding)
       SELECT s.rowid, s.embedding FROM symbol_chunk_embeddings s
        WHERE LENGTH(s.embedding) = ${byteLen}
          AND s.rowid NOT IN (SELECT rowid FROM ${name})`,
  );
}

/**
 * Create the vec0 table for `dim` if it doesn't exist. Cheap when it
 * already exists (CREATE VIRTUAL TABLE IF NOT EXISTS is a metadata
 * lookup).
 */
export function ensureVecTable(db: SqliteDatabase, dim: number): void {
  if (!isValidDim(dim)) return;
  const name = vecTableNameForDim(dim);
  // distance_metric=cosine: MATCH results sort by cosine distance
  // directly. With L2-normalised vectors (which all cartograph
  // embeddings are), cosine distance = 1 - dot product.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}] distance_metric=cosine)`);
}

/**
 * Copy any `embedding_store.rowid` not yet present in the dim-matching
 * vec0 table. Design C (migration 050): vec0 mirrors embedding_store
 * (content-addressed) instead of the legacy node-id-keyed
 * symbol_embeddings table — one vec0 row per unique (body_hash, model,
 * grain), shared across all nodes referencing it via embedding_refs.
 *
 * Filters via NOT IN — vec0 virtual tables do NOT honour `INSERT OR
 * IGNORE` / `INSERT OR REPLACE`, so we filter by rowid before inserting.
 */
function backfillVecTable(db: SqliteDatabase, dim: number): void {
  const name = vecTableNameForDim(dim);
  const byteLen = dim * FLOAT32_BYTES;
  db.exec(
    `INSERT INTO ${name}(rowid, embedding)
       SELECT s.rowid, s.embedding FROM embedding_store s
        WHERE LENGTH(s.embedding) = ${byteLen}
          AND s.rowid NOT IN (SELECT rowid FROM ${name})`,
  );
}

type VecSourceTable = 'embedding_store' | 'symbol_chunk_embeddings';

interface VecMirrorTable {
  readonly name: string;
  readonly sourceTable: VecSourceTable;
  readonly dim: number;
}

function sourceRowsForDim(db: SqliteDatabase, sourceTable: VecSourceTable, dim: number): number | null {
  const byteLen = dim * FLOAT32_BYTES;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${sourceTable} WHERE LENGTH(embedding) = ?`).get(byteLen) as {
      c: number;
    };
    return row.c;
  } catch {
    return null;
  }
}

function countRows(db: SqliteDatabase, tableName: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
    return row.c;
  } catch {
    return null;
  }
}

function vecShadowChunkRows(db: SqliteDatabase, vecTableName: string): number | null {
  return countRows(db, `${vecTableName}_vector_chunks00`);
}

/**
 * Detect a vec0 mirror that needs drop+rebuild during bootstrap.
 *
 * A plain backfill is insufficient when vec0 has ghost rows or a stale
 * chunk allocation: `NOT IN (SELECT rowid FROM vec)` can consider a
 * source row present even though the row's shadow-table chunk pointer
 * sits in old, bloated storage. Rebuild when the live row count differs
 * from the source, or when chunk storage is far larger than a packed
 * rebuild would need.
 */
function vecTableNeedsRebuild(db: SqliteDatabase, table: VecMirrorTable): boolean {
  const sourceRows = sourceRowsForDim(db, table.sourceTable, table.dim);
  const vecRows = countRows(db, table.name);
  if (sourceRows === null || vecRows === null) return false;
  if (sourceRows !== vecRows) return true;

  const chunkRows = vecShadowChunkRows(db, table.name);
  if (chunkRows === null) return false;
  const packedChunks = Math.max(1, Math.ceil(Math.max(sourceRows, 1) / VEC_CHUNK_CAPACITY));
  const toleratedChunks = Math.max(packedChunks * 4, packedChunks + 2);
  return chunkRows > toleratedChunks;
}

function rebuildVecTable(db: SqliteDatabase, table: VecMirrorTable): void {
  const name = table.name;
  db.exec(`DROP TABLE IF EXISTS ${name}`);
  if (table.sourceTable === 'embedding_store') {
    ensureVecTable(db, table.dim);
    backfillVecTable(db, table.dim);
  } else {
    ensureChunkVecTable(db, table.dim);
    backfillChunkVecTable(db, table.dim);
  }
}

/**
 * Mirror a single embedding write into the dim-matching vec0 table.
 * Called by `QueryBuilder.upsertSymbolEmbedding` after the main
 * write. Lazily creates the vec0 table when a new dim shows up
 * (e.g. user changes embedding model).
 *
 * vec0 doesn't accept `INSERT OR REPLACE`, so we DELETE-then-INSERT.
 * The torn-write window (delete succeeds, insert fails) is small;
 * the next write would recreate the row anyway.
 *
 * vec0 binds rowids as BigInt — passing a JS Number triggers the
 * "Only integers are allowed for primary key values" error from the
 * extension. We coerce upward to BigInt for both the DELETE and
 * INSERT bindings.
 */
interface MirrorEmbeddingOpts {
  db: SqliteDatabase;
  /** Skip silently when false — caller doesn't have to gate the call. */
  vecLoaded: boolean;
  rowid: number | bigint;
  embedding: Buffer | Uint8Array;
  dim: number;
}

export function mirrorEmbeddingToVec(opts: MirrorEmbeddingOpts): void {
  const { db, vecLoaded, rowid, embedding, dim } = opts;
  if (!vecLoaded) return;
  if (!isValidDim(dim)) return;
  ensureVecTable(db, dim);
  const name = vecTableNameForDim(dim);
  const bigRowid = typeof rowid === 'bigint' ? rowid : BigInt(rowid);
  getVecDeleteQuery(db, name).run({ rowid: bigRowid });
  getVecInsertQuery(db, name).run({
    rowid: bigRowid,
    embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
  });
}

/** Multi-vec mirror — same shape as mirrorEmbeddingToVec but writes
 *  to the chunk vec0 table. Called from `upsertChunkEmbedding`. */
export function mirrorChunkEmbeddingToVec(opts: MirrorEmbeddingOpts): void {
  const { db, vecLoaded, rowid, embedding, dim } = opts;
  if (!vecLoaded) return;
  if (!isValidDim(dim)) return;
  ensureChunkVecTable(db, dim);
  const name = vecChunkTableNameForDim(dim);
  const bigRowid = typeof rowid === 'bigint' ? rowid : BigInt(rowid);
  getVecDeleteQuery(db, name).run({ rowid: bigRowid });
  // Buffer-coerce so the bind type stays a concrete `Buffer<ArrayBuffer>`
  // regardless of whether the caller handed us a `Uint8Array<ArrayBufferLike>`.
  const embBuf = Buffer.isBuffer(embedding)
    ? embedding
    : Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  getVecInsertQuery(db, name).run({ rowid: bigRowid, embedding: embBuf });
}

/**
 * Drop every row from every `vec_symbol_embeddings_*` table the
 * connection has. Mirrors `DELETE FROM symbol_embeddings` and
 * structural-clear paths so vec0 doesn't accumulate ghost rowids
 * pointing at gone source rows. Without this, `findSimilarViaVec`'s
 * over-fetch budget gets eaten by ghosts and the post-JOIN model
 * filter can under-return below `k`.
 *
 * Discovers the live vec0 tables via `sqlite_master` (we don't track
 * which dims have ever had a vec0 table created).
 */
export function clearVecTables(db: SqliteDatabase, vecLoaded: boolean): void {
  if (!vecLoaded) return;
  let names: Array<{ name: string }>;
  try {
    // Stage 5 #C — also clear the chunk vec0 tables. Without this,
    // a `clearAll` (full reset) leaves ghost rowids in the chunk
    // mirror that survive the source-table delete.
    names = getListVecTablesQuery(db).all({});
  } catch {
    return;
  }
  for (const { name } of names) {
    // Whitelist by exact prefix + numeric suffix so a poisoned
    // sqlite_master row can't sneak in as table-name interpolation.
    if (!/^vec_symbol_embeddings_\d+$/.test(name) && !/^vec_chunk_embeddings_\d+$/.test(name)) continue;
    try {
      db.exec(`DELETE FROM ${name}`);
    } catch {
      // best-effort
    }
  }
}

/**
 * Compact every live vec0 table by dropping and rebuilding it from the
 * canonical source table (`embedding_store` for the symbol mirror,
 * `symbol_chunk_embeddings` for the chunk mirror).
 *
 * Why a rebuild and not just `DELETE`: vec0 stores vectors in
 * fixed-size chunk blocks (`<name>_vector_chunks00` shadow table).
 * `DELETE FROM <vec0 table>` marks a slot free but NEVER releases the
 * chunk block back to the SQLite freelist — so after a bulk eviction
 * (e.g. `prune-store` reaping tens of thousands of orphan embeddings)
 * the vec0 shadow tables keep their full pre-prune on-disk footprint.
 * Even a full `VACUUM` can't reclaim it because the pages are still
 * "live" as far as SQLite is concerned. Dropping the virtual table
 * frees every shadow-table page; rebuilding it from the (already
 * pruned) source produces a vec0 table sized to the live row set.
 *
 * Rowid fidelity: the rebuild's `INSERT ... SELECT s.rowid, s.embedding`
 * carries the source rowid verbatim, so the
 * `embedding_refs → embedding_store.rowid → vec0.rowid` join chain
 * (and HNSW's rowid→meta map) survives the rebuild unchanged.
 *
 * Best-effort and idempotent: a no-op when `vecLoaded` is false, when
 * no vec0 tables exist, or when the source table is already in sync.
 * Caller should wrap in its own transaction if atomicity vs concurrent
 * readers matters.
 */
export function compactVecTables(db: SqliteDatabase, vecLoaded: boolean): void {
  if (!vecLoaded) return;
  let names: Array<{ name: string }>;
  try {
    names = getListVecTablesQuery(db).all({});
  } catch {
    return;
  }
  for (const { name } of names) {
    const symbolMatch = /^vec_symbol_embeddings_(\d+)$/.exec(name);
    const chunkMatch = /^vec_chunk_embeddings_(\d+)$/.exec(name);
    if (!symbolMatch && !chunkMatch) continue;
    const dim = Number((symbolMatch ?? chunkMatch)![1]);
    if (!isValidDim(dim)) continue;
    try {
      // DROP frees every shadow-table page; the matching ensure+backfill
      // pair recreates a compact table from the live source rows.
      rebuildVecTable(db, {
        name,
        sourceTable: symbolMatch ? 'embedding_store' : 'symbol_chunk_embeddings',
        dim,
      });
    } catch {
      // best-effort — a failed rebuild leaves the table dropped, which
      // bootstrapVecTables recreates on the next connection open.
    }
  }
}

/**
 * Reconcile only the content-addressed symbol vec0 mirrors after a
 * canonical embedding-store cleanup.
 *
 * Tables whose dimension still exists are rebuilt so deleted store rowids
 * cannot survive as vec0 ghost rows. Tables whose dimension has no canonical
 * rows are dropped outright instead of being recreated empty. Chunk mirrors
 * are intentionally untouched: their canonical table and lifecycle are
 * independent from `embedding_store`.
 */
export function reconcileVecSymbolTables(
  db: SqliteDatabase,
  vecLoaded: boolean,
): { rebuiltDimensions: number[]; droppedDimensions: number[] } {
  const result = { rebuiltDimensions: [] as number[], droppedDimensions: [] as number[] };
  if (!vecLoaded || db.dialect !== 'sqlite') return result;
  const liveDimensions = new Set(discoverEmbeddingDims(db));
  let names: Array<{ name: string }>;
  try {
    names = getListVecTablesQuery(db).all({});
  } catch {
    return result;
  }
  for (const { name } of names) {
    const match = /^vec_symbol_embeddings_(\d+)$/.exec(name);
    if (!match) continue;
    const dim = Number(match[1]);
    if (!isValidDim(dim)) continue;
    try {
      if (!liveDimensions.has(dim)) {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
        result.droppedDimensions.push(dim);
        continue;
      }
      rebuildVecTable(db, { name, sourceTable: 'embedding_store', dim });
      result.rebuiltDimensions.push(dim);
    } catch {
      // Best-effort mirror repair. Canonical storage remains authoritative,
      // and connection bootstrap retries any missing/stale mirror later.
    }
  }
  result.rebuiltDimensions.sort((a, b) => a - b);
  result.droppedDimensions.sort((a, b) => a - b);
  return result;
}

/**
 * Result row from the indexed KNN query. `distance` is cosine
 * distance ([0, 2] for general vectors; ~[0, 1] for our normalised
 * positive-correlated embeddings). Convert to similarity score with
 * `similarity = 1 - distance`.
 */
interface VecHit {
  nodeId: string;
  distance: number;
}

/**
 * Indexed top-K cosine search. Filters by `model` so multiple models
 * can coexist in `symbol_embeddings` without polluting results; the
 * KNN happens against ALL rows at this dim, then post-filters by
 * model. We over-fetch (`fetch = max(k * 4, k + 5)`) so the model
 * filter doesn't drop us below `k` in mixed-model setups — chosen
 * to tolerate up to 75% wrong-model rows (a project that ran two
 * embedding models sequentially at the same dim).
 *
 * Returns an empty array when:
 *   - vec extension isn't loaded
 *   - the dim's vec0 table doesn't exist (no embeddings at this dim)
 *   - no neighbours found
 *
 * Caller should fall back to the in-memory `EmbeddingCache` path on
 * empty (it'll handle the no-data and no-extension cases the same
 * way).
 */
interface FindSimilarOpts {
  db: SqliteDatabase;
  /** Returns [] silently when false — caller doesn't gate the call. */
  vecLoaded: boolean;
  queryVec: Float32Array;
  model: string;
  k: number;
}

export function findSimilarViaVec(opts: FindSimilarOpts): VecHit[] {
  const { db, vecLoaded, queryVec, model, k } = opts;
  if (!vecLoaded) return [];
  const dim = queryVec.length;
  if (!isValidDim(dim)) return [];
  const name = vecTableNameForDim(dim);
  const fetch = Math.max(k * 4, k + 5);
  const queryBuf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  // Cosine MATCH on the vec0 table. Design C (migration 050): vec0
  // mirrors embedding_store; the JOIN goes vec0.rowid ->
  // embedding_store.ROWID, then embedding_refs maps back to node_id.
  // A single store row may have many refs (rename / move / duplicate)
  // — emit one hit per (store row, node) pair; downstream merge dedups
  // by node_id.
  //
  // Grain filter — vec0 is the symbol-only fallback path. File-grain
  // rows (migration 043) coexist in the store; filter via embedding_refs.grain.
  let rows: Array<{ node_id: string; distance: number }>;
  try {
    rows = getKnnSymbolQuery(db, name).all({
      embedding: queryBuf,
      k,
      model,
      fetch,
    });
  } catch {
    // Table doesn't exist yet (no embeddings at this dim) or vec0
    // returned an unexpected error — let the caller fall back.
    return [];
  }

  // Stage 5 #C — multi-vec retrieval merge. Query the chunk vec0
  // table for the same dim/model and fold its results in by
  // node_id + max-similarity. Long symbols may have multiple chunks;
  // the smallest distance wins (== highest cosine similarity).
  let chunkRows: Array<{ node_id: string; distance: number }> = [];
  const chunkName = vecChunkTableNameForDim(dim);
  try {
    chunkRows = getKnnChunkQuery(db, chunkName).all({
      embedding: queryBuf,
      k,
      model,
      fetch,
    });
  } catch {
    // Chunk table absent (no long symbols indexed yet OR pre-046
    // schema). Silent fall-through to symbol-only results.
  }

  if (chunkRows.length === 0) {
    return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }));
  }

  // Merge: per node_id keep the smallest distance. Tie-break on
  // first-seen. The main vec0 table is iterated first so its rows
  // win on ties, preserving back-compat ordering.
  const minDistByNode = new Map<string, number>();
  for (const r of rows) {
    const cur = minDistByNode.get(r.node_id);
    if (cur === undefined || r.distance < cur) minDistByNode.set(r.node_id, r.distance);
  }
  for (const r of chunkRows) {
    const cur = minDistByNode.get(r.node_id);
    if (cur === undefined || r.distance < cur) minDistByNode.set(r.node_id, r.distance);
  }
  return [...minDistByNode.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([nodeId, distance]) => ({ nodeId, distance }));
}
