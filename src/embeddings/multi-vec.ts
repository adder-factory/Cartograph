/**
 * Multi-vector chunking helper — Stage 5 C.2.
 *
 * Splits long symbol bodies into overlapping line windows for
 * higher-fidelity embedding retrieval. Chunk embeddings live in
 * `symbol_chunk_embeddings` (migration 046); the canonical per-symbol
 * embedding stays in `symbol_embeddings` at chunk_idx=0.
 *
 * Design constraints (v1):
 *  - Pure function: no I/O, no DB, no embedding calls — only text splitting.
 *  - Line-window split only (no tree-sitter boundary detection for v1).
 *  - Only fires on symbols whose body spans >= LARGE_SYMBOL_LOC_THRESHOLD lines.
 *  - chunk_idx starts at 1 (0 is reserved for the canonical row).
 *  - Chunks overlap by CHUNK_OVERLAP lines on each boundary for recall continuity.
 */

/** Minimum symbol body size (LOC) before chunking kicks in. Symbols
 *  with fewer than 500 lines are embedded whole; at or above 500 lines
 *  the body is split into overlapping {@link CHUNK_LOC}-line windows. */
export const LARGE_SYMBOL_LOC_THRESHOLD = 500;

/** Target lines of code per chunk. */
export const CHUNK_LOC = 200;

/** Overlap in lines between consecutive chunks (boundary recall). */
export const CHUNK_OVERLAP = 50;

/** A single chunk produced by {@link chunkSymbol}. */
export interface SymbolChunk {
  /** 1-based chunk index. Index 0 is reserved for the canonical embedding. */
  idx: number;
  /** Inclusive start line of this chunk (matching the `nodes` table convention). */
  startLine: number;
  /** Inclusive end line of this chunk. */
  endLine: number;
  /** The slice of `body` text that falls within [startLine, endLine]. */
  text: string;
}

/** Input shape for {@link chunkSymbol}. */
export interface ChunkSymbolInput {
  /** Inclusive start line of the symbol in the source file. */
  startLine: number;
  /** Inclusive end line of the symbol in the source file. */
  endLine: number;
  /** Full body text of the symbol (may be empty for declaration-only symbols). */
  body: string;
}

/**
 * Split a symbol's body into overlapping line-window chunks.
 *
 * Returns an empty array when the symbol body is shorter than
 * {@link LARGE_SYMBOL_LOC_THRESHOLD} lines — callers should rely solely
 * on the canonical single-vector embedding in those cases.
 *
 * The split is performed on line boundaries only (no tree-sitter AST
 * awareness in v1). Each chunk targets {@link CHUNK_LOC} lines and
 * overlaps the previous chunk by {@link CHUNK_OVERLAP} lines.
 *
 * Example for a 800-line symbol (startLine=1, endLine=800):
 *   Chunk 1: lines   1–200
 *   Chunk 2: lines 151–350   (200 - 50 = 150 step)
 *   Chunk 3: lines 301–500
 *   Chunk 4: lines 451–650
 *   Chunk 5: lines 601–800
 */
export function chunkSymbol(input: ChunkSymbolInput): SymbolChunk[] {
  const { startLine, endLine, body } = input;
  const totalLoc = endLine - startLine + 1;

  // Only chunk long symbols.
  if (totalLoc < LARGE_SYMBOL_LOC_THRESHOLD) {
    return [];
  }

  // Split body into lines preserving empty lines (don't strip trailing \n so
  // round-tripping body.split('\n').join('\n') is lossless).
  const bodyLines = body.split('\n');

  const step = CHUNK_LOC - CHUNK_OVERLAP;
  const chunks: SymbolChunk[] = [];
  let chunkIdx = 1;

  // Walk from startLine in steps of `step`, each chunk spanning CHUNK_LOC lines.
  for (let lineStart = startLine; lineStart <= endLine; lineStart += step) {
    const lineEnd = Math.min(lineStart + CHUNK_LOC - 1, endLine);

    // Convert absolute file line numbers to 0-based indexes into bodyLines.
    const bodyStartIdx = lineStart - startLine;
    const bodyEndIdx = lineEnd - startLine;

    // Slice only lines that exist in bodyLines (guard against body shorter
    // than the node's declared range, which can happen with synthetic nodes).
    const sliceStart = Math.min(bodyStartIdx, bodyLines.length);
    const sliceEnd = Math.min(bodyEndIdx + 1, bodyLines.length);
    const text = bodyLines.slice(sliceStart, sliceEnd).join('\n');

    chunks.push({
      idx: chunkIdx,
      startLine: lineStart,
      endLine: lineEnd,
      text,
    });

    chunkIdx++;

    // If this chunk already reaches the end, we're done.
    if (lineEnd >= endLine) {
      break;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Stage 5 #C runtime — embed pass for long symbols
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import { vectorToBytes } from '../llm/embeddings.js';
import type { EmbeddingProvider } from '../llm/embedding-client.js';
import type { QueryBuilder } from '../db/queries.js';
import { upsertChunkEmbedding } from '../db/queries-chunk-embeddings.js';
import { validatePathWithinRootReal } from '../utils.js';
import { logDebug, logWarn } from '../errors.js';

interface LongSymbolRow {
  nodeId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fileContentHash: string;
}

/**
 * Discover symbols that need (re-)chunking. Filters:
 *   - Body LOC >= LARGE_SYMBOL_LOC_THRESHOLD
 *   - Canonical (chunk_idx=0) embedding exists for the active model
 *     (chunks enrich; they don't replace the primary signal)
 *   - Either no chunks exist yet OR the file's content_hash drifted
 *     since the last chunk pass — staleness gating prevents
 *     re-embedding unchanged long symbols on every sync.
 *
 * Staleness signal: chunk rows store `summary_hash_at_embed` (named
 * for legacy compat with the parent table). For multi-vec we
 * repurpose this column to hold the file content_hash at chunk time.
 * Rows whose stored hash matches the current files.content_hash are
 * up-to-date and skipped.
 */
function discoverLongSymbols(qb: QueryBuilder, embeddingModel: string): LongSymbolRow[] {
  return qb.db
    .prepare(
      `SELECT n.id AS nodeId, n.file_path AS filePath,
              n.start_line AS startLine, n.end_line AS endLine,
              COALESCE(f.content_hash, '') AS fileContentHash
         FROM nodes n
         JOIN symbol_embeddings e ON e.node_id = n.id
         LEFT JOIN files f ON f.path = n.file_path
        WHERE e.embedding_model = ?
          AND e.grain = 'symbol'
          AND (n.end_line - n.start_line + 1) >= ?
          AND NOT EXISTS (
            SELECT 1 FROM symbol_chunk_embeddings c
             WHERE c.node_id = n.id
               AND c.embedding_model = ?
               AND c.summary_hash_at_embed = COALESCE(f.content_hash, '')
            LIMIT 1
          )`,
    )
    .all(embeddingModel, LARGE_SYMBOL_LOC_THRESHOLD, embeddingModel) as LongSymbolRow[];
}

/** Read source file body and slice to the symbol's line range.
 *  Returns null when the file is missing / outside the project root. */
function loadSymbolBody(projectRoot: string, sym: LongSymbolRow): string | null {
  const safePath = validatePathWithinRootReal(projectRoot, sym.filePath);
  if (!safePath) return null;
  let lines: string[];
  try {
    lines = fs.readFileSync(safePath, 'utf-8').split('\n');
  } catch {
    return null;
  }
  const start = Math.max(0, sym.startLine - 1);
  const end = Math.min(lines.length, sym.endLine);
  if (start >= end) return null;
  return lines.slice(start, end).join('\n');
}

export interface EmbedLongSymbolsArgs {
  qb: QueryBuilder;
  client: EmbeddingProvider;
  embeddingModel: string;
  projectRoot: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface EmbedLongSymbolsResult {
  /** Long symbols seen this pass. */
  candidates: number;
  /** Symbols whose chunks were (re-)embedded. */
  chunked: number;
  /** Total chunk rows written. */
  chunksWritten: number;
  /** Symbols whose body couldn't be read. */
  bodyMisses: number;
  /** Embed-call failures. */
  errors: number;
  durationMs: number;
}

/** Batched chunk-embed. ~16 chunks per call mirrors the file-grain
 *  pipeline; HF in-process clients amortise IPC well at this size. */
const CHUNK_EMBED_BATCH = 16;

/**
 * Persist one (chunk, vector) pair via upsertChunkEmbedding. Returns
 * true on success. Extracted from {@link embedLongSymbols} so the
 * outer function's nesting stays shallow (was the nested_complexity
 * source on the prior layout).
 */
interface PersistChunkArgs {
  qb: QueryBuilder;
  sym: LongSymbolRow;
  chunk: SymbolChunk;
  vec: Float32Array;
  embeddingModel: string;
}

function persistChunkEmbedding(args: PersistChunkArgs): boolean {
  const { qb, sym, chunk, vec, embeddingModel } = args;
  try {
    return upsertChunkEmbedding(qb, {
      nodeId: sym.nodeId,
      chunkIdx: chunk.idx,
      embedding: vectorToBytes(vec),
      embeddingModel,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      // Stage 5 #C staleness gate: stamp the file's content_hash
      // so the next pass's discoverLongSymbols can skip this
      // symbol when nothing changed.
      summaryHashAtEmbed: sym.fileContentHash,
    });
  } catch (err) {
    logDebug('multi-vec: chunk persist failed', {
      node: sym.nodeId,
      chunkIdx: chunk.idx,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Embed one batch of chunks for `sym` and persist the results. Returns
 * `{written, errors}` counts the caller accumulates. Splitting this
 * out collapsed the nested_complexity warning.
 */
interface EmbedChunkBatchArgs {
  qb: QueryBuilder;
  client: EmbedLongSymbolsArgs['client'];
  sym: LongSymbolRow;
  batch: SymbolChunk[];
  embeddingModel: string;
  signal?: AbortSignal | undefined;
}

async function embedAndPersistChunkBatch(args: EmbedChunkBatchArgs): Promise<{ written: number; errors: number }> {
  const { qb, client, sym, batch, embeddingModel, signal } = args;
  let vecs: Float32Array[];
  try {
    const opts = signal ? { signal } : {};
    vecs = await client.embed(
      batch.map((c) => c.text),
      opts,
    );
  } catch (err) {
    logWarn('multi-vec: chunk embed failed', { node: sym.nodeId, error: String(err) });
    return { written: 0, errors: batch.length };
  }
  if (vecs.length !== batch.length) {
    return { written: 0, errors: batch.length };
  }
  let written = 0;
  let errors = 0;
  for (let j = 0; j < batch.length; j++) {
    const c = batch[j]!;
    const v = vecs[j]!;
    try {
      if (persistChunkEmbedding({ qb, sym, chunk: c, vec: v, embeddingModel })) {
        written++;
      }
    } catch {
      errors++;
    }
  }
  return { written, errors };
}

/**
 * Stage 5 #C runtime — embed every long symbol's body chunks.
 *
 * Pipeline:
 *   1. SELECT long symbols (body LOC >= LARGE_SYMBOL_LOC_THRESHOLD)
 *      that already have a canonical embedding.
 *   2. Per symbol: read body from disk → chunkSymbol → batch-embed
 *      via the configured EmbeddingProvider.
 *   3. Persist via upsertChunkEmbedding (which mirrors into
 *      vec_chunk_embeddings_<dim> when sqlite-vec is loaded).
 *
 * Idempotent: each call overwrites existing chunk rows for the
 * symbols it processes. A future PR can add staleness gating
 * keyed on file content_hash to skip unchanged symbols.
 */
export async function embedLongSymbols(args: EmbedLongSymbolsArgs): Promise<EmbedLongSymbolsResult> {
  const { qb, client, embeddingModel, projectRoot, signal, onProgress } = args;
  const t0 = Date.now();
  const longSyms = discoverLongSymbols(qb, embeddingModel);
  const total = longSyms.length;

  let chunked = 0;
  let chunksWritten = 0;
  let bodyMisses = 0;
  let errors = 0;

  for (let i = 0; i < longSyms.length; i++) {
    if (signal?.aborted) break;
    const sym = longSyms[i]!;
    onProgress?.(i, total);

    const body = loadSymbolBody(projectRoot, sym);
    if (!body) {
      bodyMisses++;
      continue;
    }

    const chunks = chunkSymbol({ startLine: sym.startLine, endLine: sym.endLine, body });
    if (chunks.length === 0) continue;

    for (let off = 0; off < chunks.length; off += CHUNK_EMBED_BATCH) {
      if (signal?.aborted) break;
      const batch = chunks.slice(off, off + CHUNK_EMBED_BATCH);
      const { written, errors: batchErrors } = await embedAndPersistChunkBatch({
        qb,
        client,
        sym,
        batch,
        embeddingModel,
        signal,
      });
      chunksWritten += written;
      errors += batchErrors;
    }
    chunked++;
  }
  onProgress?.(total, total);

  return {
    candidates: total,
    chunked,
    chunksWritten,
    bodyMisses,
    errors,
    durationMs: Date.now() - t0,
  };
}
