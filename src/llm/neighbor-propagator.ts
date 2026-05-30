/**
 * Embedding-neighbor summary propagation.
 *
 * After the embed phase finishes (before LLM summaries), every node has a
 * vector. For nodes that are unsummarised, we can borrow a summary from their
 * nearest embedding neighbor — IF the cosine similarity is high enough that
 * the neighbor's semantic intent really transfers. This is essentially free
 * coverage: embeddings already exist; one HNSW KNN per unsummarised node
 * (falling back to vec0 / in-memory cosine when hnswlib-node is unavailable)
 * copies a high-confidence summary onto the new node_id with `model='neighbor:v1'`.
 *
 * Drift risk is mitigated by a strict cosine threshold (≥0.85 default) and
 * same-kind requirement.
 */

import type { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import { getSymbolSummary, upsertSymbolSummary } from '../db/queries-summaries.js';
import { getEmbeddingForNode, getAllEmbeddings } from '../db/queries-embeddings.js';
import { findSimilarViaVec } from '../db/vec-helpers.js';
import type { QueryBuilder } from '../db/queries.js';
import { contentHashFor } from './summarizer.js';
import { validatePathWithinRootReal } from '../utils.js';
import type { Node } from '../types.js';
import { HnswIndex, type HnswEmbeddingRow } from '../embeddings/hnsw-index.js';

export interface NeighborPropagatorOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Min cosine similarity to accept the neighbor's summary. Default 0.85. */
  minCosine?: number;
  /** Restrict neighbors to the same node kind. Default true. */
  sameKindOnly?: boolean;
}

export interface NeighborPropagatorResult {
  /** Unsummarised nodes considered. */
  candidates: number;
  /** Summaries copied from a neighbor. */
  propagated: number;
  /**
   * Number of neighbor evaluations where the neighbor had a summary but
   * its cosine fell below `minCosine`. Counted per-neighbor (not per-candidate),
   * so a candidate with two below-threshold neighbors contributes 2.
   */
  belowThreshold: number;
  /** Had no embedding or no candidate neighbor. */
  noNeighbor: number;
  /** Total wall time in ms. */
  durationMs: number;
}

/**
 * Candidate node awaiting propagation. Carries everything needed to
 * compute a body-true content_hash via {@link contentHashFor}: file
 * path + line range for the body read, plus the standard `Node`
 * fields the LLM-pass summariser uses for its own hash.
 */
interface Candidate {
  node: Node;
}

/** Raw DB row shape returned by the candidate query. */
type CandidateRow = {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  signature: string | null;
  docstring: string | null;
  updated_at: number;
};

/**
 * Run the SQL query that finds nodes with an embedding but no summary.
 * Eagerly loads file_path / start_line / end_line / signature so the body
 * read + hash computation later is one disk hit per file and zero extra SQL.
 */
function queryCandidateRows(qb: QueryBuilder, embeddingModel: string): CandidateRow[] {
  return qb.db
    .prepare(
      `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.signature, n.docstring, n.updated_at
         FROM nodes n
         JOIN symbol_embeddings e ON e.node_id = n.id
         LEFT JOIN symbol_summaries s ON s.node_id = n.id
        WHERE e.embedding_model = ?
          AND s.node_id IS NULL`,
    )
    .all(embeddingModel) as CandidateRow[];
}

/**
 * Map a raw DB row to a `Node`. Builds piecewise so optional fields are
 * OMITTED (not set to undefined) when the DB row has NULL. tsgo's strict
 * exactOptionalPropertyTypes draws a hard line between `docstring?: string`
 * and `docstring: string | undefined`.
 */
function rowToNode(r: CandidateRow): Node {
  const node: Node = {
    id: r.id,
    kind: r.kind as Node['kind'],
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    language: r.language as Node['language'],
    startLine: r.start_line,
    endLine: r.end_line,
    startColumn: r.start_column,
    endColumn: r.end_column,
    updatedAt: r.updated_at,
  };
  if (r.signature != null) node.signature = r.signature;
  if (r.docstring != null) node.docstring = r.docstring;
  return node;
}

/**
 * Fetch every node that has an embedding but NO summary row. Eagerly
 * loads file_path / start_line / end_line / signature so the body read
 * + hash computation later is one disk hit per file (with per-file
 * caching) and zero extra SQL.
 */
function getCandidates(qb: QueryBuilder, embeddingModel: string): Candidate[] {
  return queryCandidateRows(qb, embeddingModel).map((r) => ({ node: rowToNode(r) }));
}

/** Per-file LRU cache for body reads: many candidates often share a
 *  file, and we don't want to re-open the file once per candidate. */
type FileLineCache = Map<string, string[] | null>;

/** Read the candidate's source body lines from disk, returning the
 *  joined slice for content-hash computation. Symlink-resistant via
 *  `validatePathWithinRootReal`. Caches per file_path so multiple
 *  candidates in the same file share one read. */
function readBodyLines(cache: FileLineCache, projectRoot: string, sym: Node): string {
  let lines = cache.get(sym.filePath);
  if (lines === undefined) {
    const safe = validatePathWithinRootReal(projectRoot, sym.filePath);
    if (!safe) {
      cache.set(sym.filePath, null);
      return '';
    }
    try {
      lines = fs.readFileSync(safe, 'utf-8').split('\n');
    } catch {
      lines = null;
    }
    cache.set(sym.filePath, lines);
  }
  if (!lines) return '';
  return lines.slice(Math.max(0, sym.startLine - 1), sym.endLine).join('\n');
}

/**
 * Fetch a neighbor's summary row, or null if none exists.
 * Returns both the summary text and the source node ID for diagnostics.
 */
function getNeighborSummary(qb: QueryBuilder, neighborId: string): { summary: string; model: string } | null {
  const row = getSymbolSummary(qb, neighborId);
  if (!row) return null;
  return { summary: row.summary, model: row.model };
}

/**
 * Compute cosine similarity from two Float32Array vectors.
 * Both vectors are expected to be L2-normalised (which all cartograph
 * embeddings are), so similarity = 1 - distance.
 *
 * Falls back to manual dot-product + norm computation if vec0 isn't available.
 */
function cosineSimilarity(v1: Float32Array, v2: Float32Array): number {
  if (v1.length !== v2.length || v1.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < v1.length; i++) {
    const a = v1[i];
    const b = v2[i];
    if (a !== undefined && b !== undefined) {
      dot += a * b;
    }
  }
  // For L2-normalised vectors, dot product directly equals cosine similarity.
  return Math.max(0, Math.min(1, dot));
}

/**
 * Decode a Float32Array from a Buffer of little-endian bytes.
 * Used to parse embedding BLOBs from the database.
 */
function decodeFloat32Array(buffer: Buffer | null): Float32Array | null {
  if (!buffer) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/** Arguments for {@link findNearestNeighbors}. */
interface FindNearestNeighborsArgs {
  qb: QueryBuilder;
  queryVec: Float32Array;
  embeddingModel: string;
  /** Number of neighbors to find. Default 2. */
  k?: number;
  /**
   * Pre-built HNSW index for this propagation pass — built once in
   * {@link runNeighborPropagator} and reused per-row. When present,
   * skips the per-row vec0 scan; when null/undefined, falls back to
   * vec0 then in-memory cosine.
   */
  hnsw?: HnswIndex | null;
}

/**
 * Find the top-K nearest neighbors of a query vector. Routing order:
 *   1. Pre-built HNSW (when provided by the caller — built once per
 *      runNeighborPropagator invocation).
 *   2. vec0 brute force (when sqlite-vec is loaded).
 *   3. In-memory cosine over every embedding.
 *
 * Returns an array of {nodeId, distance} tuples sorted by increasing distance
 * (i.e., decreasing cosine similarity). Distance is computed as (1 - cosine)
 * for consistency with vec0.
 */
function findNearestNeighbors(args: FindNearestNeighborsArgs): Array<{ nodeId: string; distance: number }> {
  const { qb, queryVec, embeddingModel, k = 2, hnsw } = args;
  // Try HNSW path first (cheap query against the prebuilt index).
  // Don't pass embeddingModel — the index is built per-model in
  // buildHnswForPropagator, so the post-filter would reject nothing
  // and the 4× over-fetch heuristic inside hnsw.query would only
  // burn cycles. (Distinct from similar-edges 8.4, where a single
  // per-dim index can carry multiple models.)
  if (hnsw) {
    const hits = hnsw.query(queryVec, k);
    if (hits.length > 0) {
      return hits;
    }
  }
  // Try vec0 path next.
  if (qb.vecLoaded) {
    try {
      const vecHits = findSimilarViaVec({
        db: qb.db,
        vecLoaded: qb.vecLoaded,
        queryVec,
        model: embeddingModel,
        k,
      });
      if (vecHits.length > 0) {
        return vecHits;
      }
    } catch {
      // Fall through to in-memory path.
    }
  }

  // Fallback: in-memory cosine over all embeddings.
  const allEmbeddings = getAllEmbeddings(qb, embeddingModel);
  const results: Array<{ nodeId: string; distance: number }> = [];

  for (const { nodeId, embedding } of allEmbeddings) {
    const neighborVecOrNull = decodeFloat32Array(embedding);
    if (!neighborVecOrNull) continue;
    const similarity = cosineSimilarity(queryVec, neighborVecOrNull);
    const distance = 1 - similarity;
    results.push({ nodeId, distance });
  }

  // Sort by distance (ascending = increasing similarity) and take top k.
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, k);
}

/** Resolved configuration used throughout the propagation run. */
interface PropagatorConfig {
  signal: AbortSignal | undefined;
  onProgress: ((done: number, total: number) => void) | undefined;
  minCosine: number;
  sameKindOnly: boolean;
  fileLineCache: FileLineCache;
  projectRoot: string | undefined;
  embeddingModel: string;
  /** Built once per run by {@link buildHnswForPropagator}; null when
   *  hnswlib-node is missing or when this dim has no rows yet. */
  hnsw: HnswIndex | null;
}

/** Mutable per-run counters threaded through the processing loop. */
interface PropagatorCounters {
  propagated: number;
  /** Per-neighbor count (not per-candidate): matches `NeighborPropagatorResult.belowThreshold`. */
  belowThreshold: number;
  noNeighbor: number;
}

/**
 * Detect the active embedding model from the database.
 * Returns undefined when no embeddings exist yet.
 */
function detectEmbeddingModel(qb: QueryBuilder): string | undefined {
  const row = qb.db.prepare('SELECT DISTINCT embedding_model FROM symbol_embeddings LIMIT 1').get() as
    | { embedding_model: string }
    | undefined;
  return row?.embedding_model;
}

/**
 * Build a single in-memory HNSW index over every embedding for
 * `embeddingModel` so the per-row neighbor lookup runs in O(log N)
 * instead of O(N). Returns null when hnswlib-node is missing OR no
 * rows exist; both signals trigger the vec0 / in-memory fallback in
 * {@link findNearestNeighbors}. The empty-rows branch is unreachable
 * via {@link runNeighborPropagator} since `detectEmbeddingModel`
 * already short-circuits on the no-embeddings case; left in for
 * direct callers / tests.
 *
 * Assumes all rows for one `embedding_model` share one embedding
 * dim (HnswIndex.build's internal filter discards any mismatch but
 * we shouldn't rely on that — model:dim is a 1:1 invariant across
 * the codebase).
 *
 * The index is short-lived (one propagation pass) and not persisted
 * — the postHook owns the disk-backed copy. Building per-pass is
 * cheap relative to the total propagation work it accelerates.
 */
async function buildHnswForPropagator(qb: QueryBuilder, embeddingModel: string): Promise<HnswIndex | null> {
  // Design C (migration 050): vec0/HNSW key off embedding_store.rowid.
  // Use the store's rowid + an arbitrary ref per row (rename/copy share
  // a store row — any node attribution is valid).
  const rows = qb.db
    .prepare(
      `SELECT s.rowid AS rowid,
              (SELECT r.node_id FROM embedding_refs r
                WHERE r.body_hash = s.body_hash
                  AND r.model = s.model
                  AND r.grain = s.grain
                LIMIT 1) AS node_id,
              s.embedding AS embedding,
              s.model AS embedding_model
         FROM embedding_store s
        WHERE s.embedding IS NOT NULL
          AND s.model = ?
          AND s.grain = 'symbol'`,
    )
    .all(embeddingModel)
    .filter((r): r is HnswEmbeddingRow => (r as { node_id: string | null }).node_id !== null) as HnswEmbeddingRow[];
  if (rows.length === 0) return null;
  const dim = rows[0]!.embedding.length / 4;
  const idx = await HnswIndex.create(dim);
  if (!idx) return null;
  const built = await idx.build(rows);
  if (!built.built) return null;
  return idx;
}

/** Arguments for {@link neighborKindMatches}. */
interface NeighborKindMatchesArgs {
  qb: QueryBuilder;
  neighborId: string;
  candidateKind: string;
  sameKindOnly: boolean;
}

/**
 * Check whether the neighbor's node kind matches the candidate's kind.
 * Returns true when the kind matches (or when sameKindOnly is false).
 */
function neighborKindMatches(args: NeighborKindMatchesArgs): boolean {
  const { qb, neighborId, candidateKind, sameKindOnly } = args;
  if (!sameKindOnly) return true;
  const row = qb.db.prepare('SELECT kind FROM nodes WHERE id = ?').get(neighborId) as { kind: string } | undefined;
  return row?.kind === candidateKind;
}

/**
 * Fetch and decode the embedding vector for a candidate node.
 * Returns null when no embedding is stored or the buffer cannot be decoded.
 */
function getCandidateVector(qb: QueryBuilder, candidateId: string, embeddingModel: string): Float32Array | null {
  const embedding = getEmbeddingForNode(qb, candidateId, embeddingModel);
  if (!embedding) return null;
  return decodeFloat32Array(embedding);
}

/** Result of evaluating a single neighbor against the propagation criteria. */
type NeighborEvalResult =
  | { outcome: 'skip' }
  | { outcome: 'belowThreshold' }
  | { outcome: 'eligible'; summary: string };

/**
 * Evaluate one neighbor against the propagation criteria.
 * - 'skip'           — self-match, kind mismatch, or no summary row.
 * - 'belowThreshold' — summary exists but cosine < `minCosine`.
 * - 'eligible'       — passes all checks; returns the summary text.
 */
function evaluateNeighborSummary(args: {
  qb: QueryBuilder;
  neighborId: string;
  neighborDistance: number;
  candidateId: string;
  candidateKind: string;
  sameKindOnly: boolean;
  minCosine: number;
}): NeighborEvalResult {
  const { qb, neighborId, neighborDistance, candidateId, candidateKind, sameKindOnly, minCosine } = args;
  if (neighborId === candidateId) return { outcome: 'skip' };
  if (!neighborKindMatches({ qb, neighborId, candidateKind, sameKindOnly })) return { outcome: 'skip' };
  const neighborSummary = getNeighborSummary(qb, neighborId);
  if (!neighborSummary) return { outcome: 'skip' };
  if (1 - neighborDistance < minCosine) return { outcome: 'belowThreshold' };
  return { outcome: 'eligible', summary: neighborSummary.summary };
}

/**
 * Build the content hash for a candidate's body and upsert the propagated
 * summary row. Returns true when the upsert succeeds.
 *
 * Compute the content_hash from the candidate's actual source body (matching
 * the LLM-pass `contentHashFor` format) so on body change the propagated row
 * is invalidated and the next pass reconsiders it. When `projectRoot` isn't
 * passed (legacy callers), fall back to a signature-only hash; the
 * model='neighbor:v1' label already prevents LLM-cache collisions, so the
 * legacy path is safe but not body-drift-aware.
 */
function buildAndUpsertSummary(args: {
  qb: QueryBuilder;
  candidate: Node;
  summary: string;
  fileLineCache: FileLineCache;
  projectRoot: string | undefined;
}): boolean {
  const { qb, candidate, summary, fileLineCache, projectRoot } = args;
  const body = projectRoot ? readBodyLines(fileLineCache, projectRoot, candidate) : '';
  const contentHash = contentHashFor(candidate, body);
  return upsertSymbolSummary({ qb, nodeId: candidate.id, contentHash, summary, model: 'neighbor:v1' });
}

/** Arguments for {@link tryPropagateSummary}. */
interface TryPropagateSummaryArgs {
  qb: QueryBuilder;
  candidate: Node;
  config: PropagatorConfig;
  counters: PropagatorCounters;
}

interface PropagateFromNeighborsArgs {
  qb: QueryBuilder;
  candidate: Node;
  neighbors: ReturnType<typeof findNearestNeighbors>;
  config: PropagatorConfig;
  counters: PropagatorCounters;
}

/**
 * Walk `neighbors` to find the first eligible summary to propagate onto `candidate`.
 * Updates `counters.belowThreshold` in-place for each below-threshold neighbor.
 * Returns true when a summary was propagated successfully.
 */
function propagateFromNeighbors(args: PropagateFromNeighborsArgs): boolean {
  const { qb, candidate, neighbors, config, counters } = args;
  for (const neighbor of neighbors) {
    const result = evaluateNeighborSummary({
      qb,
      neighborId: neighbor.nodeId,
      neighborDistance: neighbor.distance,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
      sameKindOnly: config.sameKindOnly,
      minCosine: config.minCosine,
    });
    if (result.outcome === 'skip') continue;
    if (result.outcome === 'belowThreshold') {
      counters.belowThreshold++;
      continue;
    }
    // outcome === 'eligible'
    const ok = buildAndUpsertSummary({
      qb,
      candidate,
      summary: result.summary,
      fileLineCache: config.fileLineCache,
      projectRoot: config.projectRoot,
    });
    if (ok) {
      counters.propagated++;
      return true;
    }
  }
  return false;
}

/**
 * Attempt to propagate a summary from the best qualifying neighbor onto
 * `candidate`. Updates `counters` in-place:
 * - `propagated` incremented on a successful upsert.
 * - `belowThreshold` incremented once per neighbor whose cosine falls short
 *   (preserving per-neighbor counting to match `NeighborPropagatorResult`).
 * - `noNeighbor` incremented when no eligible neighbor exists at all.
 */
function tryPropagateSummary(args: TryPropagateSummaryArgs): void {
  const { qb, candidate, config, counters } = args;

  const candidateVec = getCandidateVector(qb, candidate.id, config.embeddingModel);
  if (!candidateVec) {
    counters.noNeighbor++;
    return;
  }

  // Find top-2 neighbors (we'll skip the self-match if it appears).
  const neighbors = findNearestNeighbors({
    qb,
    queryVec: candidateVec,
    embeddingModel: config.embeddingModel,
    k: 2,
    hnsw: config.hnsw,
  });
  const found = propagateFromNeighbors({ qb, candidate, neighbors, config, counters });
  if (!found) {
    counters.noNeighbor++;
  }
}

/** Arguments for {@link processCandidates}. */
interface ProcessCandidatesArgs {
  qb: QueryBuilder;
  candidateList: Candidate[];
  config: PropagatorConfig;
  counters: PropagatorCounters;
}

/**
 * Process all candidates in sequence, updating counters in-place.
 * Aborts early via `config.signal` and calls `config.onProgress` each
 * iteration.
 */
function processCandidates(args: ProcessCandidatesArgs): void {
  const { qb, candidateList, config, counters } = args;
  const total = candidateList.length;
  let processedCount = 0;
  for (const { node: candidate } of candidateList) {
    config.signal?.throwIfAborted();
    config.onProgress?.(processedCount, total);
    processedCount++;
    tryPropagateSummary({ qb, candidate, config, counters });
  }
  config.onProgress?.(total, total);
}

/**
 * Main entry point: scan unsummarised nodes with embeddings and propagate
 * high-confidence summaries from embedding neighbors.
 */
export async function runNeighborPropagator(args: {
  queries: QueryBuilder;
  /** Project root for symlink-resistant body reads. Optional only for
   *  legacy callers that pre-date the body-true content_hash change;
   *  when omitted the propagator falls back to the stable signature-
   *  based hash and the propagated row's hash is functionally inert
   *  (model='neighbor:v1' already prevents LLM cache collisions). */
  projectRoot?: string;
  options?: NeighborPropagatorOptions;
}): Promise<NeighborPropagatorResult> {
  const { queries: qb, projectRoot, options = {} } = args;
  const { signal, onProgress, minCosine = 0.85, sameKindOnly = true } = options;

  const startMs = Date.now();

  const embeddingModel = detectEmbeddingModel(qb);
  if (!embeddingModel) {
    // No embeddings yet — nothing to propagate from.
    return {
      candidates: 0,
      propagated: 0,
      belowThreshold: 0,
      noNeighbor: 0,
      durationMs: Date.now() - startMs,
    };
  }

  const hnsw = await buildHnswForPropagator(qb, embeddingModel);

  const config: PropagatorConfig = {
    signal,
    onProgress,
    minCosine,
    sameKindOnly,
    fileLineCache: new Map(),
    projectRoot,
    embeddingModel,
    hnsw,
  };

  const candidateList = getCandidates(qb, embeddingModel);
  const counters: PropagatorCounters = { propagated: 0, belowThreshold: 0, noNeighbor: 0 };
  processCandidates({ qb, candidateList, config, counters });

  return {
    candidates: candidateList.length,
    ...counters,
    durationMs: Date.now() - startMs,
  };
}
