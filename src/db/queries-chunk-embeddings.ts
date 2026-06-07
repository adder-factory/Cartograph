/**
 * Persistence helpers for the `symbol_chunk_embeddings` table (migration 046,
 * Stage 5 C.2). Stores one row per body chunk of long symbols (>= 500 LOC).
 *
 * Canonical per-symbol embeddings (chunk_idx=0) remain in `symbol_embeddings`.
 * This table holds chunk_idx >= 1 rows produced by `chunkSymbol` in
 * `src/embeddings/multi-vec.ts`.
 *
 * All writes are upsert-on-conflict so re-running the embed phase on the same
 * symbol is idempotent.
 */

import { z } from 'zod';
import { Buffer } from 'node:buffer';
import type { QueryBuilder } from './queries.js';
import { mirrorChunkEmbeddingToVec } from './vec-helpers.js';
import { mirrorChunkEmbeddingToPgvector } from './pgvector-helpers.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

const FLOAT32_BYTES = 4;

// ─── Zod schemas ──────────────────────────────────────────────────────────

const NoParams = z.object({});

// Embeddings travel as Float32 bytes — accept either backing buffer
// shape SQLite is willing to bind (Buffer or Uint8Array).
const EmbeddingBinding = z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]);

const RowidRowSchema = z.object({ r: z.union([z.number(), z.bigint()]) });
// SQLite's better-sqlite3 / node:sqlite both return BLOB columns as
// `Uint8Array` (Buffer in better-sqlite3 is also a Uint8Array subclass,
// but plain Uint8Array fails an `instanceof Buffer` check on
// node:sqlite). Accept either at the row boundary.
const BlobBinding = z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]);

const ChunkRowSchema = z.object({
  chunk_idx: z.number(),
  embedding: BlobBinding,
  start_line: z.number(),
  end_line: z.number(),
});
const ChunkCountRowSchema = z.object({ c: z.number() });

// ─── Typed query definitions ──────────────────────────────────────────────

const UpsertChunkEmbeddingParamsSchema = z.object({
  nodeId: z.string(),
  chunkIdx: z.number(),
  embedding: EmbeddingBinding,
  embeddingModel: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  summaryHashAtEmbed: z.string(),
});
type UpsertChunkEmbeddingQueryParams = z.infer<typeof UpsertChunkEmbeddingParamsSchema>;

const upsertChunkEmbeddingQuery = defineQuery({
  sql: `INSERT INTO symbol_chunk_embeddings
           (node_id, chunk_idx, embedding, embedding_model, start_line, end_line, summary_hash_at_embed)
         VALUES (@nodeId, @chunkIdx, @embedding, @embeddingModel, @startLine, @endLine, @summaryHashAtEmbed)
         ON CONFLICT(node_id, chunk_idx) DO UPDATE SET
           embedding             = excluded.embedding,
           embedding_model       = excluded.embedding_model,
           start_line            = excluded.start_line,
           end_line              = excluded.end_line,
           summary_hash_at_embed = excluded.summary_hash_at_embed`,
  params: UpsertChunkEmbeddingParamsSchema,
  row: z.never(),
});

const chunkEmbeddingRowidQuery = defineQuery({
  sql: 'SELECT rowid AS r FROM symbol_chunk_embeddings WHERE node_id = @nodeId AND chunk_idx = @chunkIdx',
  params: z.object({ nodeId: z.string(), chunkIdx: z.number() }),
  row: RowidRowSchema,
});

const getChunkEmbeddingsByNodeQuery = defineQuery({
  sql: `SELECT chunk_idx, embedding, start_line, end_line
         FROM symbol_chunk_embeddings
        WHERE node_id = @nodeId
        ORDER BY chunk_idx ASC`,
  params: z.object({ nodeId: z.string() }),
  row: ChunkRowSchema,
});

const clearChunkEmbeddingsQuery = defineQuery({
  sql: 'DELETE FROM symbol_chunk_embeddings WHERE node_id = @nodeId',
  params: z.object({ nodeId: z.string() }),
  row: z.never(),
});

const countChunkEmbeddingsQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS c FROM symbol_chunk_embeddings',
  params: NoParams,
  row: ChunkCountRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    upsertChunkEmbedding?: TypedQuery<UpsertChunkEmbeddingQueryParams, never>;
    chunkEmbeddingRowid?: TypedQuery<{ nodeId: string; chunkIdx: number }, { r: number | bigint }>;
    getChunkEmbeddingsByNode?: TypedQuery<
      { nodeId: string },
      { chunk_idx: number; embedding: Buffer | Uint8Array; start_line: number; end_line: number }
    >;
    clearChunkEmbeddings?: TypedQuery<{ nodeId: string }, never>;
    countChunkEmbeddings?: TypedQuery<Record<string, never>, { c: number }>;
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/** Arguments for a single chunk upsert. */
export interface UpsertChunkEmbeddingArgs {
  nodeId: string;
  chunkIdx: number;
  embedding: Buffer;
  embeddingModel: string;
  startLine: number;
  endLine: number;
  summaryHashAtEmbed?: string;
}

/**
 * Upsert a single chunk embedding row.
 *
 * Returns `true` when any row was written (INSERT or UPDATE — the
 * `ON CONFLICT DO UPDATE` clause produces `changes=1` on both paths;
 * the vec0 mirror fires correctly on either). Returns `false` only
 * when the upsert was a no-op (e.g. SQLite detected the row was
 * identical to the existing one).
 *
 * The FK constraint (node_id → nodes.id) will throw when the referenced
 * node does not exist — callers must ensure the node is indexed before
 * calling this function.
 */
export function upsertChunkEmbedding(qb: QueryBuilder, args: UpsertChunkEmbeddingArgs): boolean {
  const { nodeId, chunkIdx, embedding, embeddingModel, startLine, endLine } = args;
  const summaryHashAtEmbed = args.summaryHashAtEmbed ?? '';

  let wrote = false;
  qb.db.transaction(() => {
    qb.queries.upsertChunkEmbedding ??= upsertChunkEmbeddingQuery(qb.db);
    const result = qb.queries.upsertChunkEmbedding.run({
      nodeId,
      chunkIdx,
      embedding,
      embeddingModel,
      startLine,
      endLine,
      summaryHashAtEmbed,
    });
    wrote = result.changes > 0;
    if (!wrote && qb.db.dialect === 'postgres') {
      qb.queries.chunkEmbeddingRowid ??= chunkEmbeddingRowidQuery(qb.db);
      wrote = qb.queries.chunkEmbeddingRowid.get({ nodeId, chunkIdx }) !== undefined;
    }
    if (!wrote) return;
    // Stage 5 #C — mirror into the multi-vec table when sqlite-vec
    // is loaded. No-op on WASM / extension-missing builds.
    if (qb.vecLoaded) {
      qb.queries.chunkEmbeddingRowid ??= chunkEmbeddingRowidQuery(qb.db);
      const rowidRow = qb.queries.chunkEmbeddingRowid.get({ nodeId, chunkIdx });
      if (rowidRow) {
        const dim = Math.floor(embedding.byteLength / FLOAT32_BYTES);
        mirrorChunkEmbeddingToVec({
          db: qb.db,
          vecLoaded: qb.vecLoaded,
          rowid: rowidRow.r,
          embedding,
          dim,
        });
      }
    }
  })();
  if (wrote) {
    qb.queries.chunkEmbeddingRowid ??= chunkEmbeddingRowidQuery(qb.db);
    const rowidRow = qb.queries.chunkEmbeddingRowid.get({ nodeId, chunkIdx });
    if (rowidRow) {
      mirrorChunkEmbeddingToPgvector({
        db: qb.db,
        rowid: rowidRow.r,
        nodeId,
        model: embeddingModel,
        embedding,
      });
    }
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** A single chunk row returned by {@link getChunkEmbeddingsByNode}. */
export interface ChunkEmbeddingRow {
  chunkIdx: number;
  embedding: Buffer;
  startLine: number;
  endLine: number;
}

/**
 * Fetch all chunk embeddings for a given node, ordered by chunk_idx ascending.
 * Returns an empty array when no chunks exist for the node.
 */
export function getChunkEmbeddingsByNode(qb: QueryBuilder, nodeId: string): ChunkEmbeddingRow[] {
  qb.queries.getChunkEmbeddingsByNode ??= getChunkEmbeddingsByNodeQuery(qb.db);
  const rows = qb.queries.getChunkEmbeddingsByNode.all({ nodeId });

  return rows.map((r) => ({
    chunkIdx: r.chunk_idx,
    // Row schema admits Buffer | Uint8Array (better-sqlite3 returns
    // Buffer, node:sqlite returns Uint8Array). Public surface keeps
    // the historical Buffer typing; `Buffer.from(view)` is a cheap
    // zero-copy upgrade when the value is already a Uint8Array.
    embedding: Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding),
    startLine: r.start_line,
    endLine: r.end_line,
  }));
}

// ---------------------------------------------------------------------------
// Maintenance helpers
// ---------------------------------------------------------------------------

/**
 * Delete all chunk rows for a given node. Called when a symbol is
 * re-extracted and its body chunks need to be rebuilt from scratch.
 */
export function clearChunkEmbeddings(qb: QueryBuilder, nodeId: string): void {
  qb.queries.clearChunkEmbeddings ??= clearChunkEmbeddingsQuery(qb.db);
  qb.queries.clearChunkEmbeddings.run({ nodeId });
}

/**
 * Total number of chunk rows in the table — used by `cartograph_admin status`
 * and progress logging in the embed phase.
 */
export function countChunkEmbeddings(qb: QueryBuilder): number {
  qb.queries.countChunkEmbeddings ??= countChunkEmbeddingsQuery(qb.db);
  const row = qb.queries.countChunkEmbeddings.get({});
  return row?.c ?? 0;
}
