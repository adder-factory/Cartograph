/**
 * File-grain (multi-grain Stage 2) embedding aggregator.
 *
 * For each indexed file, builds a single embedding from a header and
 * the file's top-K symbol summaries, ordered by centrality. Stored on
 * `symbol_embeddings` with `grain='file'` and `node_id` reusing the
 * file's `nodes(id)`. File nodes never have `grain='symbol'` rows
 * (`getEmbeddableNodes` excludes `kind='file'`), so the PK doesn't
 * collide.
 *
 * Search-side fallback chain in `llmSemanticTopK` queries the symbol
 * grain first; when results are sparse or low-confidence it merges
 * file-grain hits to recover topic-level matches that no single
 * symbol carries.
 *
 * Staleness — a file-grain row is stale (needs re-embed) when:
 *   1. The file's `content_hash` drifted since last embed, or
 *   2. Any of the included symbol summaries changed (caught via the
 *      `combinedHash` baked into `summary_hash_at_embed`), or
 *   3. The embedding model changed.
 */

import type { Buffer } from 'buffer';
import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from '../llm/embedding-client.js';
import { vectorToBytes } from '../llm/embeddings.js';
import type { QueryBuilder } from '../db/queries.js';
import { mirrorEmbeddingToVec } from '../db/vec-helpers.js';
import { logDebug, logWarn } from '../errors.js';

/** How many top-centrality symbols per file to fold into the embed
 *  text. K=20 stays well under typical embed-server max-token limits
 *  while covering the most-called surface of every realistic file. */
export const FILE_GRAIN_TOP_K = 20;

/** Bytes per Float32. */
const FLOAT32_BYTES = 4;

/** Per-symbol payload included in a file-grain embed. */
export interface FileGrainSymbol {
  name: string;
  signature: string | null;
  summary: string | null;
  /** `symbol_summaries.content_hash` for this symbol — `''` when no
   *  summary row exists. Folded into the file's `combinedHash`. */
  summaryHash: string;
}

/** A file ready to be (re-)embedded at the file grain. */
export interface FileGrainCandidate {
  fileNodeId: string;
  filePath: string;
  fileContentHash: string;
  symbols: FileGrainSymbol[];
  /** sha256(fileContentHash + sorted included summary hashes). Stored
   *  in `summary_hash_at_embed` to drive staleness detection. */
  combinedHash: string;
}

/**
 * Compute the per-file `combinedHash` from the file's content_hash
 * and the sorted set of included symbol summary hashes. Sorting makes
 * the hash insensitive to the order centrality returns symbols in
 * the rare cases of ties.
 */
export function computeCombinedHash(fileContentHash: string, summaryHashes: string[]): string {
  const h = createHash('sha256');
  h.update(fileContentHash);
  h.update('\n');
  for (const sh of [...summaryHashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(sh);
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * The text fed to the embedder for one file. Format:
 *
 *   # <file path>
 *
 *   - <symbol name>: <summary | signature | name-only>
 *   - <symbol name>: ...
 *
 * Deterministic: same set of symbols + summaries always produces the
 * same string, so the `combinedHash`-keyed cache is well-defined.
 */
export function buildFileEmbedText(c: FileGrainCandidate): string {
  const lines: string[] = [`# ${c.filePath}`, ''];
  for (const sym of c.symbols) {
    if (sym.summary && sym.summary.trim().length > 0) {
      lines.push(`- ${sym.name}: ${sym.summary.trim()}`);
    } else if (sym.signature && sym.signature.trim().length > 0) {
      lines.push(`- ${sym.name}: ${sym.signature.trim()}`);
    } else {
      lines.push(`- ${sym.name}`);
    }
  }
  return lines.join('\n');
}

/** Raw row shape returned by the candidate query. */
type CandidateFileRow = {
  file_node_id: string;
  file_path: string;
  file_content_hash: string;
};

type SymbolRow = {
  name: string;
  signature: string | null;
  summary: string | null;
  summary_hash: string | null;
};

/**
 * Discover files eligible for file-grain embedding and assemble a
 * {@link FileGrainCandidate} per file. Returns ALL indexed files —
 * the caller filters to "needs re-embed" via {@link isFileGrainStale}
 * just before calling the embed client.
 *
 * Files with zero ranked symbols are skipped (their embedding would
 * carry only the path header — too noisy to be useful for retrieval).
 */
export function getFileGrainCandidates(qb: QueryBuilder, topK: number = FILE_GRAIN_TOP_K): FileGrainCandidate[] {
  const fileRows = qb.db
    .prepare(
      `SELECT n.id           AS file_node_id,
              n.file_path    AS file_path,
              f.content_hash AS file_content_hash
         FROM nodes n
         JOIN files f ON f.path = n.file_path
        WHERE n.kind = 'file'`,
    )
    .all() as CandidateFileRow[];

  if (fileRows.length === 0) return [];

  // Order by centrality (PageRank) so we surface the file's most-
  // referenced symbols first. start_line is the deterministic
  // tiebreaker; nodes without centrality (NULL) sort last via COALESCE.
  const symbolStmt = qb.db.prepare(
    `SELECT n.name           AS name,
            n.signature      AS signature,
            ss.summary       AS summary,
            ss.content_hash  AS summary_hash
       FROM nodes n
       LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
      WHERE n.file_path = ?
        AND n.kind NOT IN ('file', 'import', 'export')
      ORDER BY COALESCE(n.centrality, 0) DESC,
               n.start_line ASC
      LIMIT ?`,
  );

  const out: FileGrainCandidate[] = [];
  for (const fr of fileRows) {
    const symbols = symbolStmt.all(fr.file_path, topK) as SymbolRow[];
    if (symbols.length === 0) continue;

    const summaryHashes = symbols.map((s) => s.summary_hash ?? '');
    const combinedHash = computeCombinedHash(fr.file_content_hash, summaryHashes);

    out.push({
      fileNodeId: fr.file_node_id,
      filePath: fr.file_path,
      fileContentHash: fr.file_content_hash,
      symbols: symbols.map((s) => ({
        name: s.name,
        signature: s.signature,
        summary: s.summary,
        summaryHash: s.summary_hash ?? '',
      })),
      combinedHash,
    });
  }
  return out;
}

/** Existing file-grain row shape used by {@link isFileGrainStale}. */
type ExistingFileGrainRow = {
  embedding_model: string;
  source_content_hash: string;
  summary_hash_at_embed: string;
};

/**
 * Returns true when the file-grain row for `fileNodeId` is missing,
 * targets a different model, or carries a stale `combinedHash`.
 */
export function isFileGrainStale(qb: QueryBuilder, c: FileGrainCandidate, embeddingModel: string): boolean {
  const existing = qb.db
    .prepare(
      `SELECT embedding_model, source_content_hash, summary_hash_at_embed
         FROM symbol_embeddings
        WHERE node_id = ? AND grain = 'file'`,
    )
    .get(c.fileNodeId) as ExistingFileGrainRow | undefined;
  if (!existing) return true;
  if (existing.embedding_model !== embeddingModel) return true;
  if (existing.source_content_hash !== c.fileContentHash) return true;
  if (existing.summary_hash_at_embed !== c.combinedHash) return true;
  return false;
}

interface UpsertFileEmbeddingArgs {
  qb: QueryBuilder;
  fileNodeId: string;
  embedding: Buffer;
  model: string;
  fileContentHash: string;
  combinedHash: string;
}

/**
 * Persist one file-grain embedding. Atomic against concurrent file-node
 * deletion (no-ops via the `WHERE EXISTS` gate). Mirrors the new row
 * into the dim-matching vec0 shadow table when sqlite-vec is loaded.
 *
 * Hard-codes `grain='file'` in the INSERT and the ON-CONFLICT branch.
 * Pre-condition: callers MUST only pass `fileNodeId`s of `kind='file'`
 * nodes — file kinds never carry a grain='symbol' row, so the
 * (node_id) PK won't collide. A future module-grain expansion that
 * targets non-file nodes (e.g. a class with both symbol-grain and
 * module-grain rows) requires a compound `(node_id, grain)` primary
 * key migration as a hard prerequisite.
 */
export function upsertFileEmbedding(args: UpsertFileEmbeddingArgs): boolean {
  const { qb, fileNodeId, embedding, model, fileContentHash, combinedHash } = args;
  // Design C (migration 050): file-grain rows live in embedding_store
  // keyed by (body_hash=fileContentHash, model, grain='file') with a
  // per-node pointer in embedding_refs. Writing directly to the two
  // underlying tables avoids the view's UPSERT limitation
  // (INSTEAD OF triggers don't fire on `INSERT ... ON CONFLICT`).
  let wrote = false;
  qb.db.transaction(() => {
    qb.db
      .prepare(
        `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
         VALUES (?, ?, 'file', ?, ?)
         ON CONFLICT(body_hash, model, grain) DO UPDATE SET
           embedding = excluded.embedding,
           generated_at = excluded.generated_at`,
      )
      .run(fileContentHash, model, embedding, Date.now());

    const info = qb.db
      .prepare(
        `INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
         SELECT ?, ?, ?, 'file', ?
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
         ON CONFLICT(node_id, model, grain) DO UPDATE SET
           body_hash = excluded.body_hash,
           summary_hash_at_embed = excluded.summary_hash_at_embed`,
      )
      .run(fileNodeId, fileContentHash, model, combinedHash, fileNodeId);
    wrote = info.changes > 0;
    if (!wrote) return;
    if (qb.vecLoaded) {
      // vec0 mirrors embedding_store.ROWID — look it up by the
      // (body_hash, model, grain) key we just wrote.
      const rowidRow = qb.db
        .prepare(
          `SELECT rowid AS r FROM embedding_store
             WHERE body_hash = ? AND model = ? AND grain = 'file'`,
        )
        .get(fileContentHash, model) as { r: number | bigint } | undefined;
      if (rowidRow) {
        const dim = Math.floor(embedding.byteLength / FLOAT32_BYTES);
        mirrorEmbeddingToVec({
          db: qb.db,
          vecLoaded: qb.vecLoaded,
          rowid: rowidRow.r,
          embedding,
          dim,
        });
      }
    }
  })();
  return wrote;
}

interface EmbedFilesArgs {
  qb: QueryBuilder;
  client: EmbeddingProvider;
  embeddingModel: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  topK?: number;
}

export interface EmbedFilesResult {
  /** Files considered for re-embed. */
  candidates: number;
  /** Files actually re-embedded this run. */
  generated: number;
  /** Files skipped because the cached file-grain row was still fresh. */
  cacheHits: number;
  /** Files where the embed call failed. */
  errors: number;
  durationMs: number;
}

/**
 * Aggregate file-grain embedder. Walks every indexed file, builds the
 * per-file embed text from its top-K symbol summaries, batches calls
 * to the embed client, and upserts results with `grain='file'`.
 *
 * Idempotent: skips files whose `combinedHash` already matches the
 * stored row. Aborts cleanly on `signal.aborted`.
 */
export async function embedFilesAggregated(args: EmbedFilesArgs): Promise<EmbedFilesResult> {
  const { qb, client, embeddingModel, signal, onProgress, topK = FILE_GRAIN_TOP_K } = args;
  const t0 = Date.now();

  const allCandidates = getFileGrainCandidates(qb, topK);
  const stale = allCandidates.filter((c) => isFileGrainStale(qb, c, embeddingModel));

  let generated = 0;
  let errors = 0;
  let done = 0;
  const total = stale.length;

  // Batch the embed calls so we amortise HTTP/IPC round-trips over
  // multiple files; stays well below the embed servers' typical
  // batch ceilings even for 768-dim outputs and ~2k-char inputs.
  const FILE_GRAIN_BATCH = 16;
  for (let i = 0; i < stale.length; i += FILE_GRAIN_BATCH) {
    if (signal?.aborted) break;
    const batch = stale.slice(i, i + FILE_GRAIN_BATCH);
    const texts = batch.map(buildFileEmbedText);
    let vectors: Float32Array[] | null = null;
    try {
      const opts = signal ? { signal } : {};
      vectors = await client.embed(texts, opts);
    } catch (err) {
      errors += batch.length;
      logWarn(`file-grain embed batch failed: ${(err as Error).message}`);
      done += batch.length;
      onProgress?.(done, total);
      continue;
    }
    if (vectors.length !== batch.length) {
      errors += batch.length;
      logWarn(`file-grain embed returned ${vectors.length} vectors for ${batch.length} inputs — skipping batch`);
      done += batch.length;
      onProgress?.(done, total);
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j]!;
      const vec = vectors[j]!;
      const ok = upsertFileEmbedding({
        qb,
        fileNodeId: c.fileNodeId,
        embedding: vectorToBytes(vec),
        model: embeddingModel,
        fileContentHash: c.fileContentHash,
        combinedHash: c.combinedHash,
      });
      if (ok) generated++;
    }
    done += batch.length;
    onProgress?.(done, total);
  }

  logDebug(`file-grain embed: ${generated}/${allCandidates.length} files (${errors} errors)`);

  return {
    candidates: allCandidates.length,
    generated,
    cacheHits: allCandidates.length - stale.length,
    errors,
    durationMs: Date.now() - t0,
  };
}
