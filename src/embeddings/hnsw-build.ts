/**
 * HNSW rebuild — rebuilds per-dim HNSW KNN indexes when the embedding
 * rowset has grown >5% or max rowid has drifted since the last build.
 * Writes hnsw_meta entries so query-time semantic search can validate
 * freshness without rescanning every row.
 *
 * Invoked from the detached background embed phase (`runEmbedPhase` in
 * `cartograph-llm-pass.ts`) once a pass's embedding writes have landed.
 * HNSW only has work to do after embeddings exist, and embeddings are
 * produced by that same detached pass — so the rebuild belongs with
 * it, not in the blocking index postHooks (where it sat until it was
 * moved out). Reads `embedding_store` only; no graph dependency.
 * Silently skips when USearch isn't available.
 */

import path from 'node:path';

import type { SqliteDatabase } from '../db/sqlite-adapter.js';
import { logDebug, logWarn } from '../errors.js';
import { isHnswAvailable, HnswIndex, computeRowsetSignature, discoverEmbeddingDims } from './hnsw-index.js';

/** Float32 = 4 bytes per element. */
const FLOAT32_BYTES = 4;

/** Fraction of growth that triggers a rebuild — 0.05 (i.e. 5%). */
const REBUILD_GROWTH_THRESHOLD = 0.05;

interface HnswMetaRow {
  dim: number;
  row_count: number;
  max_rowid: number;
  built_at: number;
  file_path: string;
}

/**
 * Decide whether the on-disk HNSW for `dim` is stale relative to the
 * current rowset signature. `null` meta means no prior build → rebuild.
 * Otherwise check both row-count drift (>5%) AND maxRowid drift —
 * absolute drift catches pure-deletion churn that doesn't move maxRowid.
 */
interface NeedsRebuildArgs {
  dim: number;
  sig: { rowCount: number; maxRowid: number };
  meta: HnswMetaRow | undefined;
}

function shouldRebuildDim(args: NeedsRebuildArgs): boolean {
  const { dim, sig, meta } = args;
  if (!meta) {
    logDebug(`hnsw-build: dim=${dim} — no existing meta; will build`);
    return true;
  }
  const driftFraction = Math.abs(sig.rowCount - meta.row_count) / Math.max(meta.row_count, 1);
  const drifted = driftFraction > REBUILD_GROWTH_THRESHOLD;
  const maxRowidDrifted = sig.maxRowid !== meta.max_rowid;
  if (drifted || maxRowidDrifted) {
    logDebug(
      `hnsw-build: dim=${dim} stale (rowcount_drifted=${drifted}, rowid_drifted=${maxRowidDrifted}) — rebuilding`,
    );
    return true;
  }
  logDebug(`hnsw-build: dim=${dim} is fresh (rowCount=${sig.rowCount}) — skipping`);
  return false;
}

/**
 * Build the in-memory HNSW for `dim` over the matching `symbol_embeddings`
 * rows. Returns null when the build couldn't proceed (race / dep missing).
 */
async function buildHnswForDim(db: SqliteDatabase, dim: number): Promise<{ idx: HnswIndex; rowCount: number } | null> {
  const idx = await HnswIndex.create(dim);
  if (!idx) return null; // dep went missing between availability check and here

  const expectBytes = dim * FLOAT32_BYTES;
  // Design C: embeddings live in embedding_store keyed by (body_hash,
  // model, grain). vec0 mirrors the store's ROWID — HNSW must do the
  // same so query-time vec0 results map cleanly to HNSW results.
  // Build the index using the FIRST node_id that points at each store
  // row (deterministic by rowid). Downstream consumers that need
  // per-node attribution can join through embedding_refs.
  const rows = db
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
          AND LENGTH(s.embedding) = ?
          AND s.grain = 'symbol'`,
    )
    .all(expectBytes) as Array<{
    rowid: number;
    node_id: string | null;
    embedding: Buffer;
    embedding_model: string;
  }>;
  // Drop orphan store rows whose refs all got pruned (race) — HNSW
  // can't carry a null node_id. Should be empty in practice.
  const builtRows = rows.filter(
    (r): r is { rowid: number; node_id: string; embedding: Buffer; embedding_model: string } => r.node_id !== null,
  );

  const built = await idx.build(builtRows);
  if (!built.built) {
    // Could happen if rows became 0 between discoverEmbeddingDims and
    // the per-dim fetch (race during concurrent sync).
    logDebug(`hnsw-build: dim=${dim} build returned built=false (${built.reason ?? 'unknown'}) — skipping`);
    return null;
  }
  return { idx, rowCount: built.rowCount };
}

/**
 * Persist the in-memory index to disk and upsert hnsw_meta with the
 * current signature. Returns true on full success, false when persist
 * fails (caller skips the meta upsert in that case).
 */
interface PersistArgs {
  db: SqliteDatabase;
  projectRoot: string;
  dim: number;
  idx: HnswIndex;
  rowCount: number;
  sig: { rowCount: number; maxRowid: number };
  startMs: number;
}

function persistAndRecordMeta(args: PersistArgs): boolean {
  const { db, projectRoot, dim, idx, rowCount, sig, startMs } = args;
  const filePath = path.join(projectRoot, '.cartograph', `hnsw_${dim}.bin`);
  try {
    idx.persist(filePath);
  } catch (err) {
    logWarn(
      `hnsw-build: dim=${dim} persist failed (${err instanceof Error ? err.message : String(err)}) — meta not updated`,
    );
    return false;
  }
  const durationMs = Date.now() - startMs;
  logDebug(`hnsw-build: dim=${dim} rebuilt ${rowCount} entries in ${durationMs}ms → ${filePath}`);

  db.prepare(
    `INSERT INTO hnsw_meta (dim, row_count, max_rowid, built_at, file_path)
          VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dim) DO UPDATE SET
          row_count  = excluded.row_count,
          max_rowid  = excluded.max_rowid,
          built_at   = excluded.built_at,
          file_path  = excluded.file_path`,
  ).run(dim, sig.rowCount, sig.maxRowid, Date.now(), filePath);
  return true;
}

/**
 * Core rebuild logic. For each embedding dim present in
 * `embedding_store`:
 *   1. Compute the current rowset signature (rowCount, maxRowid).
 *   2. Compare against the stored hnsw_meta row.
 *   3. If absent or stale (>5% growth or maxRowid drift), rebuild and
 *      persist the index, then upsert hnsw_meta.
 *
 * The drift gate (step 2) makes this cheap to call after every embed
 * sub-pass — the second call within one background pass skips unless
 * the summary-refresh embed moved >5% of the rowset.
 *
 * Each step is its own helper so this orchestrator stays small and
 * cyclomatic complexity per function stays comfortably under the
 * biomarker thresholds.
 */
export async function rebuildHnswIfStale(db: SqliteDatabase, projectRoot: string): Promise<void> {
  if (!(await isHnswAvailable())) {
    logDebug('hnsw-build: skipped (USearch unavailable; vec0 fallback active)');
    return;
  }

  const dims = discoverEmbeddingDims(db);
  if (dims.length === 0) {
    logDebug('hnsw-build: no embedding dims found — nothing to build');
    return;
  }

  for (const dim of dims) {
    const sig = computeRowsetSignature(db, dim);
    if (sig.rowCount === 0) {
      logDebug(`hnsw-build: dim=${dim} has 0 rows — skipping`);
      continue;
    }

    const meta = db
      .prepare(
        `SELECT dim, row_count, max_rowid, built_at, file_path
           FROM hnsw_meta
          WHERE dim = ?`,
      )
      .get(dim) as HnswMetaRow | undefined;

    if (!shouldRebuildDim({ dim, sig, meta })) continue;

    const startMs = Date.now();
    const built = await buildHnswForDim(db, dim);
    if (!built) continue;

    persistAndRecordMeta({
      db,
      projectRoot,
      dim,
      idx: built.idx,
      rowCount: built.rowCount,
      sig,
      startMs,
    });
  }
}
