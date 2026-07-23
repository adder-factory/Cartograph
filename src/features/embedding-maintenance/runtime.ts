import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { SqliteDatabase } from '../../db/sqlite-adapter.js';
import { defineQuery } from '../../db/typed-query.js';
import { reconcilePgvectorStoreTables } from '../../db/pgvector-helpers.js';
import { reconcileVecSymbolTables } from '../../db/vec-helpers.js';
import {
  EmbeddingAuditReportSchema,
  EmbeddingCleanupResultSchema,
  type EmbeddingArtifact,
  type EmbeddingArtifactRemoval,
  type EmbeddingAuditReport,
  type EmbeddingCleanupResult,
  type EmbeddingStorageBucket,
} from './contract.js';

const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;
const MAX_VECTOR_DIM = 8192;

const NoParams = z.object({});
const BucketRowSchema = z.object({
  model: z.string(),
  grain: z.string(),
  embedding_bytes: z.number(),
  store_rows: z.number(),
  referenced_rows: z.number(),
  orphan_rows: z.number(),
  node_refs: z.number(),
  storage_bytes: z.number(),
});
const TableNameRowSchema = z.object({ name: z.string() });
const HnswMetaRowSchema = z.object({
  dim: z.number(),
  row_count: z.number(),
  file_path: z.string(),
});
const DeletedEmbeddingRowSchema = z.object({ embedding_bytes: z.number() });
const DeletedRefRowSchema = z.object({ node_id: z.string() });
const CleanupCandidateRowSchema = z.object({
  embedding_bytes: z.number(),
  candidate_rows: z.number(),
  storage_bytes: z.number(),
});
const SupersededRefRowSchema = z.object({
  embedding_bytes: z.number(),
  ref_count: z.number(),
});
const CountRowSchema = z.object({ c: z.number() });
const ActiveModelParams = z.object({ activeModel: z.string().min(1) });
const DimensionParams = z.object({ dimension: z.number().int().positive() });

const embeddingBucketsQuery = defineQuery({
  sql: `WITH ref_counts AS (
          SELECT body_hash, model, grain, COUNT(*) AS ref_count
            FROM embedding_refs
           GROUP BY body_hash, model, grain
        )
        SELECT s.model AS model,
               s.grain AS grain,
               LENGTH(s.embedding) AS embedding_bytes,
               COUNT(*) AS store_rows,
               SUM(CASE WHEN COALESCE(r.ref_count, 0) > 0 THEN 1 ELSE 0 END) AS referenced_rows,
               SUM(CASE WHEN COALESCE(r.ref_count, 0) = 0 THEN 1 ELSE 0 END) AS orphan_rows,
               COALESCE(SUM(r.ref_count), 0) AS node_refs,
               COALESCE(SUM(LENGTH(s.embedding)), 0) AS storage_bytes
          FROM embedding_store s
          LEFT JOIN ref_counts r
            ON r.body_hash = s.body_hash
           AND r.model = s.model
           AND r.grain = s.grain
         GROUP BY s.model, s.grain, LENGTH(s.embedding)
         ORDER BY s.model, s.grain, LENGTH(s.embedding)`,
  params: NoParams,
  row: BucketRowSchema,
});

// PostgreSQL exposes a compatibility sqlite_master view in schema-postgres.sql,
// so this one bounded metadata query works for both adapters.
const embeddingArtifactTablesQuery = defineQuery({
  sql: `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND (
                name LIKE 'vec_symbol_embeddings_%'
             OR name LIKE 'pgvector_symbol_embeddings_%'
           )
         ORDER BY name`,
  params: NoParams,
  row: TableNameRowSchema,
});

const hnswMetaQuery = defineQuery({
  sql: 'SELECT dim, row_count, file_path FROM hnsw_meta ORDER BY dim',
  params: NoParams,
  row: HnswMetaRowSchema,
});

const cleanupCandidateBucketsQuery = defineQuery({
  sql: `SELECT LENGTH(s.embedding) AS embedding_bytes,
               COUNT(*) AS candidate_rows,
               COALESCE(SUM(LENGTH(s.embedding)), 0) AS storage_bytes
          FROM embedding_store s
         WHERE s.model <> @activeModel
           AND NOT EXISTS (
             SELECT 1
               FROM embedding_refs legacy
              WHERE legacy.body_hash = s.body_hash
                AND legacy.model = s.model
                AND legacy.grain = s.grain
                AND NOT EXISTS (
                  SELECT 1
                    FROM embedding_refs current_ref
                    JOIN embedding_store current_store
                      ON current_store.body_hash = current_ref.body_hash
                     AND current_store.model = current_ref.model
                     AND current_store.grain = current_ref.grain
                   WHERE current_ref.node_id = legacy.node_id
                     AND current_ref.grain = legacy.grain
                     AND current_ref.model = @activeModel
                )
           )
         GROUP BY LENGTH(s.embedding)
         ORDER BY LENGTH(s.embedding)`,
  params: ActiveModelParams,
  row: CleanupCandidateRowSchema,
});

const supersededRefBucketsQuery = defineQuery({
  sql: `SELECT LENGTH(s.embedding) AS embedding_bytes,
               COUNT(*) AS ref_count
          FROM embedding_refs legacy
          JOIN embedding_store s
            ON s.body_hash = legacy.body_hash
           AND s.model = legacy.model
           AND s.grain = legacy.grain
         WHERE legacy.model <> @activeModel
           AND EXISTS (
             SELECT 1
               FROM embedding_refs current_ref
               JOIN embedding_store current_store
                 ON current_store.body_hash = current_ref.body_hash
                AND current_store.model = current_ref.model
                AND current_store.grain = current_ref.grain
              WHERE current_ref.node_id = legacy.node_id
                AND current_ref.grain = legacy.grain
                AND current_ref.model = @activeModel
           )
         GROUP BY LENGTH(s.embedding)
         ORDER BY LENGTH(s.embedding)`,
  params: ActiveModelParams,
  row: SupersededRefRowSchema,
});

const protectedLegacyStoreRowsQuery = defineQuery({
  sql: `SELECT COUNT(*) AS c
          FROM embedding_store s
         WHERE s.model <> @activeModel
           AND EXISTS (
             SELECT 1
               FROM embedding_refs legacy
              WHERE legacy.body_hash = s.body_hash
                AND legacy.model = s.model
                AND legacy.grain = s.grain
                AND NOT EXISTS (
                  SELECT 1
                    FROM embedding_refs current_ref
                    JOIN embedding_store current_store
                      ON current_store.body_hash = current_ref.body_hash
                     AND current_store.model = current_ref.model
                     AND current_store.grain = current_ref.grain
                   WHERE current_ref.node_id = legacy.node_id
                     AND current_ref.grain = legacy.grain
                     AND current_ref.model = @activeModel
                )
           )`,
  params: ActiveModelParams,
  row: CountRowSchema,
});

const deleteSupersededRefsQuery = defineQuery({
  sql: `DELETE FROM embedding_refs
         WHERE model <> @activeModel
           AND EXISTS (
             SELECT 1
               FROM embedding_refs current_ref
               JOIN embedding_store current_store
                 ON current_store.body_hash = current_ref.body_hash
                AND current_store.model = current_ref.model
                AND current_store.grain = current_ref.grain
              WHERE current_ref.node_id = embedding_refs.node_id
                AND current_ref.grain = embedding_refs.grain
                AND current_ref.model = @activeModel
           )
       RETURNING node_id`,
  params: ActiveModelParams,
  row: DeletedRefRowSchema,
});

const deleteSafeObsoleteRowsQuery = defineQuery({
  sql: `DELETE FROM embedding_store
         WHERE model <> @activeModel
           AND NOT EXISTS (
             SELECT 1 FROM embedding_refs r
              WHERE r.body_hash = embedding_store.body_hash
                AND r.model = embedding_store.model
                AND r.grain = embedding_store.grain
           )
       RETURNING LENGTH(embedding) AS embedding_bytes`,
  params: ActiveModelParams,
  row: DeletedEmbeddingRowSchema,
});

const deleteHnswMetaQuery = defineQuery({
  sql: 'DELETE FROM hnsw_meta WHERE dim = @dimension',
  params: DimensionParams,
  row: z.never(),
});

interface AuditEmbeddingStorageOptions {
  db: SqliteDatabase;
  projectRoot: string;
  activeModel: string | undefined;
}

interface CleanupObsoleteEmbeddingsOptions extends AuditEmbeddingStorageOptions {
  vecLoaded: boolean;
  confirm: boolean;
}

export function auditEmbeddingStorage(options: AuditEmbeddingStorageOptions): EmbeddingAuditReport {
  return buildEmbeddingAudit(options, collectCleanupProjection(options.db, options.activeModel));
}

function buildEmbeddingAudit(
  options: AuditEmbeddingStorageOptions,
  cleanupProjection: CleanupProjection,
): EmbeddingAuditReport {
  const rows = embeddingBucketsQuery(options.db).all({});
  const buckets = rows.map((row) => bucketFromRow(row, options.activeModel));
  const canonicalDimensions = dimensionsFor(buckets);
  const symbolDimensions = dimensionsFor(buckets.filter((bucket) => bucket.grain === 'symbol'));
  const activeDimensions = dimensionsFor(buckets.filter((bucket) => bucket.activeModel));
  const mixedDimensions = collectMixedDimensions(buckets);
  const artifacts = collectArtifacts(options, canonicalDimensions, symbolDimensions);
  const totals = collectTotals(buckets, options.activeModel, cleanupProjection);
  const warnings = collectWarnings({ activeModel: options.activeModel, buckets, mixedDimensions, totals });
  return EmbeddingAuditReportSchema.parse({
    ...(options.activeModel ? { activeModel: options.activeModel } : {}),
    buckets,
    activeDimensions,
    canonicalDimensions,
    mixedDimensions,
    artifacts,
    totals,
    warnings,
  });
}

function bucketFromRow(row: z.infer<typeof BucketRowSchema>, activeModel: string | undefined): EmbeddingStorageBucket {
  return {
    model: row.model,
    grain: row.grain,
    dimension: dimensionFromByteLength(row.embedding_bytes),
    embeddingBytes: row.embedding_bytes,
    storeRows: row.store_rows,
    referencedRows: row.referenced_rows,
    orphanRows: row.orphan_rows,
    nodeRefs: row.node_refs,
    storageBytes: row.storage_bytes,
    activeModel: activeModel !== undefined && row.model === activeModel,
  };
}

function dimensionFromByteLength(bytes: number): number | null {
  const dimension = bytes / FLOAT32_BYTES;
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > MAX_VECTOR_DIM) return null;
  return dimension;
}

function dimensionsFor(buckets: readonly EmbeddingStorageBucket[]): number[] {
  return [...new Set(buckets.flatMap((bucket) => (bucket.dimension === null ? [] : [bucket.dimension])))].sort(
    (a, b) => a - b,
  );
}

function collectMixedDimensions(buckets: readonly EmbeddingStorageBucket[]): EmbeddingAuditReport['mixedDimensions'] {
  const byModelGrain = new Map<string, { model: string; grain: string; dimensions: Set<number> }>();
  for (const bucket of buckets) {
    if (bucket.dimension === null) continue;
    const key = `${bucket.model}\u0000${bucket.grain}`;
    const group = byModelGrain.get(key) ?? {
      model: bucket.model,
      grain: bucket.grain,
      dimensions: new Set<number>(),
    };
    group.dimensions.add(bucket.dimension);
    byModelGrain.set(key, group);
  }
  return [...byModelGrain.values()]
    .filter((group) => group.dimensions.size > 1)
    .map((group) => ({
      model: group.model,
      grain: group.grain,
      dimensions: [...group.dimensions].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.grain.localeCompare(b.grain));
}

function collectArtifacts(
  options: AuditEmbeddingStorageOptions,
  canonicalDimensions: readonly number[],
  symbolDimensions: readonly number[],
): EmbeddingArtifact[] {
  const canonical = new Set(canonicalDimensions);
  const symbols = new Set(symbolDimensions);
  const artifacts: EmbeddingArtifact[] = [];
  try {
    const tableRows = embeddingArtifactTablesQuery(options.db).all({});
    for (const row of tableRows) {
      const vec = /^vec_symbol_embeddings_(\d+)$/.exec(row.name);
      const pgvector = /^pgvector_symbol_embeddings_(\d+)$/.exec(row.name);
      const match = vec ?? pgvector;
      if (!match) continue;
      const dimension = Number(match[1]);
      if (!validDimension(dimension)) continue;
      const state = canonical.has(dimension) ? 'live' : 'obsolete';
      artifacts.push({
        kind: vec ? 'sqlite-vec' : 'pgvector',
        grain: 'symbol',
        dimension,
        state,
        detail: `${row.name} ${state === 'live' ? 'mirrors canonical rows' : 'has no canonical rows'}.`,
      });
    }
  } catch {
    // Pre-migration databases can lack the compatibility metadata view.
  }
  try {
    for (const row of hnswMetaQuery(options.db).all({})) {
      if (!validDimension(row.dim)) continue;
      const state = symbols.has(row.dim) ? 'live' : 'obsolete';
      const expectedPath = hnswPath(options.projectRoot, row.dim);
      const fileState = fs.existsSync(expectedPath) ? 'file present' : 'file missing';
      artifacts.push({
        kind: 'hnsw',
        grain: 'symbol',
        dimension: row.dim,
        state,
        detail: `${row.row_count} indexed row(s); ${fileState}; metadata path ${row.file_path}.`,
      });
    }
  } catch {
    // Pre-HNSW schemas simply have no artifacts to report.
  }
  return artifacts.sort(
    (a, b) => a.dimension - b.dimension || a.kind.localeCompare(b.kind) || a.grain.localeCompare(b.grain),
  );
}

function validDimension(dimension: number): boolean {
  return Number.isInteger(dimension) && dimension > 0 && dimension <= MAX_VECTOR_DIM;
}

function collectTotals(
  buckets: readonly EmbeddingStorageBucket[],
  activeModel: string | undefined,
  cleanupProjection: CleanupProjection,
): EmbeddingAuditReport['totals'] {
  const sum = (selector: (bucket: EmbeddingStorageBucket) => number): number =>
    buckets.reduce((total, bucket) => total + selector(bucket), 0);
  return {
    storeRows: sum((bucket) => bucket.storeRows),
    referencedRows: sum((bucket) => bucket.referencedRows),
    orphanRows: sum((bucket) => bucket.orphanRows),
    storageBytes: sum((bucket) => bucket.storageBytes),
    staleModelRows: sum((bucket) => (bucket.model === activeModel ? 0 : bucket.storeRows)),
    safeCleanupRows: cleanupProjection.candidateRows,
    supersededRefs: cleanupProjection.supersededRefs,
    protectedReferencedRows: activeModel
      ? cleanupProjection.protectedReferencedRows
      : sum((bucket) => bucket.referencedRows),
    protectedActiveRows: activeModel ? sum((bucket) => (bucket.model === activeModel ? bucket.storeRows : 0)) : 0,
  };
}

interface CleanupProjectionBucket {
  dimension: number | null;
  rows: number;
  storageBytes: number;
}

interface CleanupProjection {
  candidateRows: number;
  candidateStorageBytes: number;
  candidateBuckets: CleanupProjectionBucket[];
  supersededRefs: number;
  supersededRefDimensions: number[];
  protectedReferencedRows: number;
}

function collectCleanupProjection(db: SqliteDatabase, activeModel: string | undefined): CleanupProjection {
  if (!activeModel) {
    return {
      candidateRows: 0,
      candidateStorageBytes: 0,
      candidateBuckets: [],
      supersededRefs: 0,
      supersededRefDimensions: [],
      protectedReferencedRows: 0,
    };
  }
  const params = { activeModel };
  const candidateBuckets = cleanupCandidateBucketsQuery(db)
    .all(params)
    .map((row) => ({
      dimension: dimensionFromByteLength(row.embedding_bytes),
      rows: row.candidate_rows,
      storageBytes: row.storage_bytes,
    }));
  const supersededBuckets = supersededRefBucketsQuery(db).all(params);
  return {
    candidateRows: candidateBuckets.reduce((total, bucket) => total + bucket.rows, 0),
    candidateStorageBytes: candidateBuckets.reduce((total, bucket) => total + bucket.storageBytes, 0),
    candidateBuckets,
    supersededRefs: supersededBuckets.reduce((total, bucket) => total + bucket.ref_count, 0),
    supersededRefDimensions: [
      ...new Set(
        supersededBuckets.flatMap((bucket) => {
          const dimension = dimensionFromByteLength(bucket.embedding_bytes);
          return dimension === null ? [] : [dimension];
        }),
      ),
    ].sort((a, b) => a - b),
    protectedReferencedRows: protectedLegacyStoreRowsQuery(db).get(params)?.c ?? 0,
  };
}

function collectWarnings(args: {
  activeModel: string | undefined;
  buckets: readonly EmbeddingStorageBucket[];
  mixedDimensions: EmbeddingAuditReport['mixedDimensions'];
  totals: EmbeddingAuditReport['totals'];
}): string[] {
  const warnings: string[] = [];
  if (!args.activeModel) warnings.push('No active embedding model is configured; cleanup is blocked.');
  const invalidRows = args.buckets.reduce(
    (total, bucket) => total + (bucket.dimension === null ? bucket.storeRows : 0),
    0,
  );
  if (invalidRows > 0) warnings.push(`${invalidRows} row(s) have an invalid Float32 embedding byte length.`);
  for (const mixed of args.mixedDimensions) {
    warnings.push(`${mixed.model}/${mixed.grain} contains mixed dimensions: ${mixed.dimensions.join(', ')}.`);
  }
  if (args.totals.protectedReferencedRows > 0) {
    warnings.push(
      `${args.totals.protectedReferencedRows} non-active row(s) remain referenced and will not be removed automatically.`,
    );
  }
  if (args.totals.supersededRefs > 0) {
    warnings.push(
      `${args.totals.supersededRefs} non-active ref(s) have an active-model replacement and are safe to detach.`,
    );
  }
  return warnings;
}

export function cleanupObsoleteEmbeddings(options: CleanupObsoleteEmbeddingsOptions): EmbeddingCleanupResult {
  if (!options.activeModel) {
    throw new Error('Cleanup requires an active embedding model as its safety anchor.');
  }
  const projection = collectCleanupProjection(options.db, options.activeModel);
  const before = buildEmbeddingAudit(options, projection);
  const plan = cleanupPlan(before, projection);
  if (!options.confirm) {
    return EmbeddingCleanupResultSchema.parse({
      activeModel: options.activeModel,
      dryRun: true,
      ...plan,
      deletedRows: 0,
      deletedRefs: 0,
      removedArtifacts: [],
    });
  }

  const deleted = options.db.transaction(() => {
    const params = { activeModel: options.activeModel! };
    const refs = deleteSupersededRefsQuery(options.db).all(params);
    const rows = deleteSafeObsoleteRowsQuery(options.db).all(params);
    return { refs, rows };
  })();
  const removedArtifacts: EmbeddingArtifactRemoval[] = [];
  if (deleted.rows.length > 0) {
    const vec = reconcileVecSymbolTables(options.db, options.vecLoaded);
    removedArtifacts.push(
      ...vec.droppedDimensions.map((dimension) => ({
        kind: 'sqlite-vec' as const,
        dimension,
        detail: 'Dropped mirror table because no canonical rows remain at this dimension.',
      })),
    );
    const pgvector = reconcilePgvectorStoreTables(options.db);
    removedArtifacts.push(
      ...pgvector.droppedDimensions.map((dimension) => ({
        kind: 'pgvector' as const,
        dimension,
        detail: 'Dropped mirror table because no canonical rows remain at this dimension.',
      })),
    );
  }
  if (deleted.rows.length > 0 || deleted.refs.length > 0) {
    removedArtifacts.push(...removeStaleHnswArtifacts(options, plan.affectedDimensions));
  }
  return EmbeddingCleanupResultSchema.parse({
    activeModel: options.activeModel,
    dryRun: false,
    ...plan,
    deletedRows: deleted.rows.length,
    deletedRefs: deleted.refs.length,
    removedArtifacts,
  });
}

function cleanupPlan(
  report: EmbeddingAuditReport,
  projection: CleanupProjection,
): Omit<EmbeddingCleanupResult, 'activeModel' | 'dryRun' | 'deletedRows' | 'deletedRefs' | 'removedArtifacts'> {
  const candidateDimensions = projection.candidateBuckets.flatMap((bucket) =>
    bucket.dimension === null ? [] : [bucket.dimension],
  );
  const affectedDimensions = [...new Set([...candidateDimensions, ...projection.supersededRefDimensions])].sort(
    (a, b) => a - b,
  );
  const remainingByDimension = new Map<number, number>();
  for (const bucket of report.buckets) {
    if (bucket.dimension === null) continue;
    remainingByDimension.set(bucket.dimension, (remainingByDimension.get(bucket.dimension) ?? 0) + bucket.storeRows);
  }
  for (const bucket of projection.candidateBuckets) {
    if (bucket.dimension === null) continue;
    remainingByDimension.set(bucket.dimension, (remainingByDimension.get(bucket.dimension) ?? 0) - bucket.rows);
  }
  const obsoleteDimensionsAfterCleanup = candidateDimensions.filter(
    (dimension) => (remainingByDimension.get(dimension) ?? 0) === 0,
  );
  return {
    candidateRows: projection.candidateRows,
    candidateRefs: projection.supersededRefs,
    candidateStorageBytes: projection.candidateStorageBytes,
    protectedReferencedRows: projection.protectedReferencedRows,
    protectedActiveRows: report.totals.protectedActiveRows,
    affectedDimensions,
    obsoleteDimensionsAfterCleanup,
  };
}

function removeStaleHnswArtifacts(
  options: CleanupObsoleteEmbeddingsOptions,
  affectedDimensions: readonly number[],
): EmbeddingArtifactRemoval[] {
  const affected = new Set(affectedDimensions);
  const liveSymbolDimensions = new Set(
    embeddingBucketsQuery(options.db)
      .all({})
      .filter((row) => row.grain === 'symbol')
      .flatMap((row) => {
        const dimension = dimensionFromByteLength(row.embedding_bytes);
        return dimension === null ? [] : [dimension];
      }),
  );
  const metaDimensions = (() => {
    try {
      return hnswMetaQuery(options.db)
        .all({})
        .map((row) => row.dim);
    } catch {
      return [];
    }
  })();
  const metaSet = new Set(metaDimensions);
  const dimensions = [...new Set([...metaDimensions, ...affectedDimensions])]
    .filter((dimension) => affected.has(dimension) || !liveSymbolDimensions.has(dimension))
    .filter(validDimension)
    .sort((a, b) => a - b);
  const removed: EmbeddingArtifactRemoval[] = [];
  for (const dimension of dimensions) {
    const expectedPath = hnswPath(options.projectRoot, dimension);
    const hadMetadata = metaSet.has(dimension);
    const hadFile = fs.existsSync(expectedPath);
    if (!hadMetadata && !hadFile) continue;
    let fileRemoved = false;
    try {
      if (hadFile) {
        fs.unlinkSync(expectedPath);
        fileRemoved = true;
      }
    } catch {
      // Metadata is still cleared so query-time loading cannot trust a stale index.
    }
    try {
      deleteHnswMetaQuery(options.db).run({ dimension });
    } catch {
      // A pre-HNSW schema has nothing to invalidate.
    }
    removed.push({
      kind: 'hnsw',
      dimension,
      detail: liveSymbolDimensions.has(dimension)
        ? `Invalidated stale HNSW metadata${fileRemoved ? ' and file' : ''}; canonical rows at this dimension remain.`
        : `Removed obsolete HNSW metadata${fileRemoved ? ' and file' : ''}; no canonical symbol rows remain.`,
    });
  }
  return removed;
}

function hnswPath(projectRoot: string, dimension: number): string {
  return path.resolve(projectRoot, '.cartograph', `hnsw_${dimension}.bin`);
}

export function formatEmbeddingAudit(report: EmbeddingAuditReport): string {
  const lines = [
    '## Embedding storage audit',
    '',
    `- Active model: ${report.activeModel ?? '(not configured)'}`,
    `- Canonical rows: ${report.totals.storeRows} (${formatBytes(report.totals.storageBytes)})`,
    `- Referenced / orphan: ${report.totals.referencedRows} / ${report.totals.orphanRows}`,
    `- Safe cleanup candidates: ${report.totals.safeCleanupRows}`,
    `- Superseded non-active refs: ${report.totals.supersededRefs}`,
    `- Protected: ${report.totals.protectedActiveRows} active-model row(s), ${report.totals.protectedReferencedRows} referenced non-active row(s)`,
    '',
    '| Model | Grain | Dim | Rows | Referenced | Orphan | Node refs | Storage |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const bucket of report.buckets) {
    const model = bucket.activeModel ? `${bucket.model} (active)` : bucket.model;
    lines.push(
      `| ${model} | ${bucket.grain} | ${bucket.dimension ?? 'invalid'} | ${bucket.storeRows} | ${bucket.referencedRows} | ${bucket.orphanRows} | ${bucket.nodeRefs} | ${formatBytes(bucket.storageBytes)} |`,
    );
  }
  if (report.buckets.length === 0) lines.push('| (empty) | - | - | 0 | 0 | 0 | 0 | 0 B |');
  if (report.artifacts.length > 0) {
    lines.push('', '### Dimension artifacts');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind} ${artifact.grain}/${artifact.dimension}: ${artifact.state} — ${artifact.detail}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', '### Warnings', ...report.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n');
}

export function formatEmbeddingCleanup(result: EmbeddingCleanupResult): string {
  const lines = [
    result.dryRun ? '## Embedding cleanup dry run' : '## Embedding cleanup applied',
    '',
    `- Active model safety anchor: ${result.activeModel}`,
    `- Candidate rows: ${result.candidateRows} (${formatBytes(result.candidateStorageBytes)})`,
    `- Superseded refs: ${result.candidateRefs}`,
    `- Deleted rows: ${result.deletedRows}`,
    `- Deleted refs: ${result.deletedRefs}`,
    `- Protected: ${result.protectedActiveRows} active-model row(s), ${result.protectedReferencedRows} referenced non-active row(s)`,
    `- Affected dimensions: ${result.affectedDimensions.join(', ') || '(none)'}`,
    `- Dimensions unused after cleanup: ${result.obsoleteDimensionsAfterCleanup.join(', ') || '(none)'}`,
  ];
  if (result.dryRun) {
    lines.push(
      '',
      'No data was changed. Re-run with `confirm: true` (MCP) or `--confirm` (CLI) to apply this exact safety policy.',
    );
  }
  if (result.removedArtifacts.length > 0) {
    lines.push('', '### Reconciled artifacts');
    for (const artifact of result.removedArtifacts) {
      lines.push(`- ${artifact.kind}/${artifact.dimension}: ${artifact.detail}`);
    }
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
