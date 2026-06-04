/**
 * Per-symbol embedding queries (`symbol_embeddings` table + the
 * sqlite-vec mirror).
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain embedding helpers as direct members. The functions
 * read / write the `symbol_embeddings` table and mirror writes into
 * the dim-matching vec0 virtual table via the `@internal`-tagged
 * `db` and `vecLoaded` fields on the parent `QueryBuilder`.
 */

import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { mirrorEmbeddingToVec } from './vec-helpers.js';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

const NoParams = z.object({});

// Embeddings travel as Float32 bytes — accept either backing buffer
// shape SQLite is willing to bind (Buffer or Uint8Array).
const EmbeddingBinding = z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]);

// SQLite's better-sqlite3 / node:sqlite both return BLOB columns as
// `Uint8Array` (Buffer in better-sqlite3 is also a Uint8Array subclass,
// but plain Uint8Array fails an `instanceof Buffer` check on
// node:sqlite). Accept either at the row boundary.
const BlobBinding = z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)]);

const NodeIdEmbeddingRowSchema = z.object({
  node_id: z.string(),
  embedding: BlobBinding,
});

const EmbeddingRowSchema = z.object({ embedding: BlobBinding });

const CountRowSchema = z.object({ c: z.number() });

const OkRowSchema = z.object({ ok: z.number() });

const EmbeddingsSignatureRowSchema = z.object({
  c: z.number(),
  max_generated_at: z.number(),
  max_last_ref_at: z.number(),
  byte_sum: z.number(),
  min_node_id: z.string(),
  max_node_id: z.string(),
  min_source_hash: z.string(),
  max_source_hash: z.string(),
  min_summary_hash: z.string(),
  max_summary_hash: z.string(),
  min_embedding_hex: z.string(),
  max_embedding_hex: z.string(),
});

const EmbeddableNodeRowSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  signature: z.string().nullable(),
  docstring: z.string().nullable(),
  summary: z.string().nullable(),
  summary_hash: z.string().nullable(),
});

const BodyHashRowSchema = z.object({ h: z.string().nullable() });

const RowidRowSchema = z.object({ r: z.union([z.number(), z.bigint()]) });

// ─── Typed query definitions ──────────────────────────────────────────────

const getAllEmbeddingsQuery = defineQuery({
  sql: `SELECT node_id, embedding FROM symbol_embeddings
       WHERE embedding_model = @embeddingModel AND grain = 'symbol'`,
  params: z.object({ embeddingModel: z.string() }),
  row: NodeIdEmbeddingRowSchema,
});

const getEmbeddingForNodeQuery = defineQuery({
  sql: `SELECT embedding FROM symbol_embeddings
        WHERE node_id = @nodeId AND embedding_model = @embeddingModel LIMIT 1`,
  params: z.object({ nodeId: z.string(), embeddingModel: z.string() }),
  row: EmbeddingRowSchema,
});

const getEmbeddingsCountQuery = defineQuery({
  sql: `SELECT COUNT(*) AS c FROM symbol_embeddings
        WHERE embedding_model = @embeddingModel AND grain = 'symbol'`,
  params: z.object({ embeddingModel: z.string() }),
  row: CountRowSchema,
});

const getEmbeddingsSignatureQuery = defineQuery({
  sql: `SELECT
          COUNT(*) AS c,
          COALESCE(MAX(s.generated_at), 0) AS max_generated_at,
          COALESCE(MAX(s.last_ref_at), 0) AS max_last_ref_at,
          COALESCE(SUM(LENGTH(s.embedding)), 0) AS byte_sum,
          COALESCE(MIN(r.node_id), '') AS min_node_id,
          COALESCE(MAX(r.node_id), '') AS max_node_id,
          COALESCE(MIN(r.body_hash), '') AS min_source_hash,
          COALESCE(MAX(r.body_hash), '') AS max_source_hash,
          COALESCE(MIN(r.summary_hash_at_embed), '') AS min_summary_hash,
          COALESCE(MAX(r.summary_hash_at_embed), '') AS max_summary_hash,
          COALESCE(HEX(MIN(s.embedding)), '') AS min_embedding_hex,
          COALESCE(HEX(MAX(s.embedding)), '') AS max_embedding_hex
        FROM embedding_refs r
        JOIN embedding_store s
          ON s.body_hash = r.body_hash
         AND s.model = r.model
         AND s.grain = r.grain
       WHERE r.model = @embeddingModel AND r.grain = 'symbol'`,
  params: z.object({ embeddingModel: z.string() }),
  row: EmbeddingsSignatureRowSchema,
});

const getEmbeddingsTotalQuery = defineQuery({
  sql: 'SELECT COUNT(*) AS c FROM symbol_embeddings',
  params: NoParams,
  row: CountRowSchema,
});

const hasSymbolEmbeddingWithModelQuery = defineQuery({
  sql: 'SELECT 1 AS ok FROM symbol_embeddings WHERE node_id = @nodeId AND embedding_model = @embeddingModel LIMIT 1',
  params: z.object({ nodeId: z.string(), embeddingModel: z.string() }),
  row: OkRowSchema,
});

const hasSymbolEmbeddingAnyQuery = defineQuery({
  sql: 'SELECT 1 AS ok FROM symbol_embeddings WHERE node_id = @nodeId LIMIT 1',
  params: z.object({ nodeId: z.string() }),
  row: OkRowSchema,
});

const getEmbeddableNodesQuery = defineQuery({
  sql: `SELECT
         n.id              AS node_id,
         n.name            AS name,
         n.signature       AS signature,
         n.docstring       AS docstring,
         ss.summary        AS summary,
         ss.content_hash   AS summary_hash
       FROM nodes n
       LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
       LEFT JOIN embedding_refs er
              ON er.node_id = n.id AND er.grain = 'symbol'
       WHERE n.kind NOT IN ('file', 'import', 'export')
         AND (
               er.model IS NULL
            OR er.model != @embeddingModel
            OR er.body_hash != n.body_hash
            OR COALESCE(ss.content_hash, '') != er.summary_hash_at_embed
         )`,
  params: z.object({ embeddingModel: z.string() }),
  row: EmbeddableNodeRowSchema,
});

const resolveNodeBodyHashQuery = defineQuery({
  sql: 'SELECT body_hash AS h FROM nodes WHERE id = @nodeId',
  params: z.object({ nodeId: z.string() }),
  row: BodyHashRowSchema,
});

const embeddingStoreRowidQuery = defineQuery({
  sql: `SELECT rowid AS r FROM embedding_store
         WHERE body_hash = @bodyHash AND model = @model AND grain = @grain`,
  params: z.object({ bodyHash: z.string(), model: z.string(), grain: z.string() }),
  row: RowidRowSchema,
});

export const nodeExistsQuery = defineQuery({
  sql: 'SELECT 1 AS ok FROM nodes WHERE id = @nodeId LIMIT 1',
  params: z.object({ nodeId: z.string() }),
  row: OkRowSchema,
});

const upsertEmbeddingStoreQuery = defineQuery({
  sql: `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
         VALUES (@bodyHash, @model, @grain, @embedding, @generatedAt)
         ON CONFLICT(body_hash, model, grain) DO UPDATE SET
           embedding = excluded.embedding,
           generated_at = excluded.generated_at`,
  params: z.object({
    bodyHash: z.string(),
    model: z.string(),
    grain: z.string(),
    embedding: EmbeddingBinding,
    generatedAt: z.number(),
  }),
  row: z.never(),
});

const upsertEmbeddingRefQuery = defineQuery({
  sql: `INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
         SELECT @nodeId, @bodyHash, @model, @grain, @summaryHashAtEmbed
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @nodeIdExists)
         ON CONFLICT(node_id, model, grain) DO UPDATE SET
           body_hash = excluded.body_hash,
           summary_hash_at_embed = excluded.summary_hash_at_embed`,
  params: z.object({
    nodeId: z.string(),
    bodyHash: z.string(),
    model: z.string(),
    grain: z.string(),
    summaryHashAtEmbed: z.string(),
    nodeIdExists: z.string(),
  }),
  row: z.never(),
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    getAllEmbeddings?: TypedQuery<{ embeddingModel: string }, { node_id: string; embedding: Buffer | Uint8Array }>;
    getEmbeddingForNode?: TypedQuery<{ nodeId: string; embeddingModel: string }, { embedding: Buffer | Uint8Array }>;
    getEmbeddingsCount?: TypedQuery<{ embeddingModel: string }, { c: number }>;
    getEmbeddingsSignature?: TypedQuery<
      { embeddingModel: string },
      {
        c: number;
        max_generated_at: number;
        max_last_ref_at: number;
        byte_sum: number;
        min_node_id: string;
        max_node_id: string;
        min_source_hash: string;
        max_source_hash: string;
        min_summary_hash: string;
        max_summary_hash: string;
        min_embedding_hex: string;
        max_embedding_hex: string;
      }
    >;
    getEmbeddingsTotal?: TypedQuery<Record<string, never>, { c: number }>;
    hasSymbolEmbeddingWithModel?: TypedQuery<{ nodeId: string; embeddingModel: string }, { ok: number }>;
    hasSymbolEmbeddingAny?: TypedQuery<{ nodeId: string }, { ok: number }>;
    getEmbeddableNodes?: TypedQuery<
      { embeddingModel: string },
      {
        node_id: string;
        name: string;
        signature: string | null;
        docstring: string | null;
        summary: string | null;
        summary_hash: string | null;
      }
    >;
    resolveNodeBodyHash?: TypedQuery<{ nodeId: string }, { h: string | null }>;
    embeddingStoreRowid?: TypedQuery<{ bodyHash: string; model: string; grain: string }, { r: number | bigint }>;
    nodeExists?: TypedQuery<{ nodeId: string }, { ok: number }>;
    upsertEmbeddingStore?: TypedQuery<
      {
        bodyHash: string;
        model: string;
        grain: string;
        embedding: Buffer | Uint8Array;
        generatedAt: number;
      },
      never
    >;
    upsertEmbeddingRef?: TypedQuery<
      {
        nodeId: string;
        bodyHash: string;
        model: string;
        grain: string;
        summaryHashAtEmbed: string;
        nodeIdExists: string;
      },
      never
    >;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Bulk fetch every node's embedding for the active model. Used by
 * the in-process semantic search scan. Cheap because BLOBs are
 * already byte-aligned in SQLite.
 *
 * Grain filter — restricted to the per-symbol grain so the in-memory
 * fallback in `llmSemanticTopK` doesn't surface file-grain rows
 * (migration 043+) without the symbol-first merge that the HNSW
 * path applies. Multi-grain retrieval only meaningfully runs through
 * the HNSW path; the brute-force fallback stays symbol-only.
 */
export function getAllEmbeddings(
  qb: QueryBuilder,
  embeddingModel: string,
): Array<{ nodeId: string; embedding: Buffer }> {
  qb.queries.getAllEmbeddings ??= getAllEmbeddingsQuery(qb.db);
  const rows = qb.queries.getAllEmbeddings.all({ embeddingModel });
  // Row admits Buffer | Uint8Array — historical public surface returns
  // Buffer, so coerce when the underlying driver gave us a plain view.
  return rows.map((r) => ({
    nodeId: r.node_id,
    embedding: Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding),
  }));
}

/**
 * Fetch one symbol's embedding row by `node_id` + `model`. Used by
 * the indexed similarity path (`findSimilarViaVec`) which needs the
 * source vector to query against without first warming the
 * in-memory cache.
 */
export function getEmbeddingForNode(qb: QueryBuilder, nodeId: string, embeddingModel: string): Buffer | null {
  qb.queries.getEmbeddingForNode ??= getEmbeddingForNodeQuery(qb.db);
  const row = qb.queries.getEmbeddingForNode.get({ nodeId, embeddingModel });
  if (!row) return null;
  return Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
}

/**
 * Cheap row count for {@link EmbeddingCache} freshness checks.
 * Lets the cache notice rows written by another process (e.g. an
 * out-of-band `embedAllNodes` after `save_summaries`) without
 * relying solely on `indexAll`/`sync` to invalidate.
 *
 * Scoped to grain='symbol' so the cache (which only ever loads
 * symbol-grain rows via `getAllEmbeddings`) doesn't get spurious
 * invalidations when file-grain rows churn in/out.
 */
export function getEmbeddingsCount(qb: QueryBuilder, embeddingModel: string): number {
  qb.queries.getEmbeddingsCount ??= getEmbeddingsCountQuery(qb.db);
  const row = qb.queries.getEmbeddingsCount.get({ embeddingModel });
  return row?.c ?? 0;
}

/**
 * Cheap rowset signature for {@link EmbeddingCache} freshness checks.
 * Stronger than row count alone: same-count rewrites typically change
 * generated_at, ref timestamps, node/source/summary bounds, byte totals,
 * or the min/max embedding blob sentinels.
 */
export function getEmbeddingsSignature(qb: QueryBuilder, embeddingModel: string): string {
  qb.queries.getEmbeddingsSignature ??= getEmbeddingsSignatureQuery(qb.db);
  const row = qb.queries.getEmbeddingsSignature.get({ embeddingModel });
  if (!row) return '0:0:0:0::::::::';
  return [
    row.c,
    row.max_generated_at,
    row.max_last_ref_at,
    row.byte_sum,
    row.min_node_id,
    row.max_node_id,
    row.min_source_hash,
    row.max_source_hash,
    row.min_summary_hash,
    row.max_summary_hash,
    row.min_embedding_hex,
    row.max_embedding_hex,
  ].join(':');
}

/**
 * Total embedding rows across all models. Used by status to decide
 * whether tier-3 similarity tools have any data to work with.
 */
export function getEmbeddingsTotal(qb: QueryBuilder): number {
  qb.queries.getEmbeddingsTotal ??= getEmbeddingsTotalQuery(qb.db);
  const row = qb.queries.getEmbeddingsTotal.get({});
  return row?.c ?? 0;
}

/**
 * Does this specific symbol have an embedding row? Lets the
 * `cartograph_search({mode: 'semantic'})` MCP handler distinguish "source has no
 * embedding yet" from "source has an embedding but no neighbours
 * scored above the threshold" — two failure modes that previously
 * collapsed into one ambiguous empty-state message.
 */
export function hasSymbolEmbedding(qb: QueryBuilder, nodeId: string, embeddingModel?: string): boolean {
  if (embeddingModel) {
    qb.queries.hasSymbolEmbeddingWithModel ??= hasSymbolEmbeddingWithModelQuery(qb.db);
    const row = qb.queries.hasSymbolEmbeddingWithModel.get({ nodeId, embeddingModel });
    return row !== undefined;
  }
  qb.queries.hasSymbolEmbeddingAny ??= hasSymbolEmbeddingAnyQuery(qb.db);
  const row = qb.queries.hasSymbolEmbeddingAny.get({ nodeId });
  return row !== undefined;
}

/**
 * Every node that is a candidate for embedding but does not yet have
 * a fresh embedding for `embeddingModel`. Returns `docstring` (from
 * `nodes`), `summary` and `summaryHash` (from `symbol_summaries`,
 * each may be empty/null) so the caller can pick the richest text
 * available — summary when present, docstring otherwise, falling
 * back to name+signature — AND record which summary version was
 * baked into the embed text.
 *
 * Excludes structural container kinds (`file`, `import`, `export`)
 * that carry no useful semantic content and whose names are just
 * file/path strings.
 *
 * Staleness filter — three independent reasons a node is returned:
 *   1. No embedding for the active model (never embedded, or model swap)
 *   2. File `content_hash` drifted since the embedding was written
 *      (the source code that fed the embed text has changed)
 *   3. Summary `content_hash` drifted since the embedding was
 *      written — covers "summary arrived after initial embed", "summary
 *      regenerated", and "summary deleted but embedding still has it
 *      baked in". `summary_hash_at_embed` is `''` when the embedding
 *      was generated without a summary; `COALESCE(ss.content_hash, '')`
 *      is `''` when no summary currently exists, so the predicate is
 *      `false` (not stale) only when both are absent or both are the
 *      same hash.
 */
export function getEmbeddableNodes(
  qb: QueryBuilder,
  embeddingModel: string,
): Array<{
  nodeId: string;
  name: string;
  signature: string | null;
  docstring: string | null;
  summary: string | null;
  summaryHash: string;
}> {
  // Design C: embeddings live in embedding_refs (per-node pointer)
  // + embedding_store. Staleness condition is now per-symbol:
  //   - no ref at all (never embedded), or
  //   - ref for a different model, or
  //   - ref's body_hash != nodes.body_hash (symbol body drifted), or
  //   - ref's summary_hash_at_embed != current summary content_hash
  //     (summary was added/updated since the embed pass).
  // Identical-body symbols across renames share an embedding_store
  // row — the per-node ref check still surfaces THIS node correctly
  // when only the ref is missing.
  qb.queries.getEmbeddableNodes ??= getEmbeddableNodesQuery(qb.db);
  const rows = qb.queries.getEmbeddableNodes.all({ embeddingModel });
  return rows.map((r) => ({
    nodeId: r.node_id,
    name: r.name,
    signature: r.signature,
    docstring: r.docstring,
    summary: r.summary,
    summaryHash: r.summary_hash ?? '',
  }));
}

/**
 * Persist an embedding for a symbol. The caller passes raw Float32
 * bytes (already L2-normalised).
 *
 * Atomic against concurrent node deletion: the `WHERE EXISTS` on
 * `nodes` gates the row, so an intervening sync that removed the
 * parent produces a no-op rather than an FK constraint error. Returns
 * true when the row was written; false when the node was no longer
 * present (vec0 mirror is also skipped in that case to keep the two
 * tables in sync).
 */
/**
 * Resolve the per-symbol body_hash for `nodeId`. Returns '' when the
 * node was deleted between caller-id capture and the write. Migration 048
 * populates nodes.body_hash via the extractor's createNode using
 * sliceSymbolBody — the same canonical body the summarizer reads.
 */
function resolveNodeBodyHash(qb: QueryBuilder, nodeId: string): string {
  qb.queries.resolveNodeBodyHash ??= resolveNodeBodyHashQuery(qb.db);
  const row = qb.queries.resolveNodeBodyHash.get({ nodeId });
  return row?.h ?? '';
}

interface MirrorVecForBodyHashArgs {
  qb: QueryBuilder;
  bodyHash: string;
  model: string;
  grain: string;
  embedding: Buffer | Uint8Array;
}

/**
 * Mirror the just-upserted embedding into the dim-matching vec0
 * shadow table when the sqlite-vec extension is loaded. No-op on
 * WASM / extension-missing setups. Migration 050 (Design C) keyed
 * vec0 against embedding_store.ROWID — look up by (body_hash, model,
 * grain) since that's the store row's identity.
 */
function mirrorVecForBodyHash(args: MirrorVecForBodyHashArgs): void {
  const { qb, bodyHash, model, grain, embedding } = args;
  if (!qb.vecLoaded) return;
  qb.queries.embeddingStoreRowid ??= embeddingStoreRowidQuery(qb.db);
  const rowidRow = qb.queries.embeddingStoreRowid.get({ bodyHash, model, grain });
  if (!rowidRow) return;
  const dim = Math.floor(embedding.byteLength / 4);
  mirrorEmbeddingToVec({ db: qb.db, vecLoaded: qb.vecLoaded, rowid: rowidRow.r, embedding, dim });
}

interface UpsertSymbolEmbeddingArgs {
  qb: QueryBuilder;
  nodeId: string;
  embedding: Buffer | Uint8Array;
  model: string;
  /**
   * Summary `content_hash` baked into the embed text. Pass `''` when
   * no summary was used. Compared against
   * `symbol_summaries.content_hash` by the staleness check in
   * `getEmbeddableNodes` to drive the second embed pass after
   * summarise.
   */
  summaryHashAtEmbed: string;
}

export function upsertSymbolEmbedding(args: UpsertSymbolEmbeddingArgs): boolean {
  const { qb, nodeId, embedding, model, summaryHashAtEmbed } = args;
  let bodyHash = resolveNodeBodyHash(qb, nodeId);
  // Node missing entirely → can't write (no FK target).
  qb.queries.nodeExists ??= nodeExistsQuery(qb.db);
  const nodeExists = qb.queries.nodeExists.get({ nodeId });
  if (!nodeExists) return false;
  // Synthetic fallback: when body_hash is empty (test fixtures that bypass
  // the extractor, or pre-migration-048 leftovers that haven't re-extracted
  // yet), derive a per-node key so the write still lands. This loses
  // cross-rename dedup for that specific row but preserves correctness
  // until the next re-extraction populates the real body_hash.
  if (bodyHash === '') bodyHash = `node:${nodeId}`;
  const grain = 'symbol';

  // Design C: write to embedding_store (deduped by (body_hash, model,
  // grain)) AND embedding_refs (per-node pointer). The legacy
  // symbol_embeddings VIEW (migration 050) joins these for
  // backward-compat reads. Wrapped in one transaction so a torn
  // write can never leave vec0 missing an embedding the store has.
  let wrote = false;
  qb.db.transaction(() => {
    qb.queries.upsertEmbeddingStore ??= upsertEmbeddingStoreQuery(qb.db);
    qb.queries.upsertEmbeddingStore.run({
      bodyHash,
      model,
      grain,
      embedding,
      generatedAt: Date.now(),
    });

    qb.queries.upsertEmbeddingRef ??= upsertEmbeddingRefQuery(qb.db);
    const info = qb.queries.upsertEmbeddingRef.run({
      nodeId,
      bodyHash,
      model,
      grain,
      summaryHashAtEmbed,
      nodeIdExists: nodeId,
    });
    wrote = info.changes > 0;
    if (!wrote) return;
    mirrorVecForBodyHash({ qb, bodyHash, model, grain, embedding });
  })();
  return wrote;
}
