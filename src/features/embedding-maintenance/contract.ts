import { z } from 'zod';

export const EmbeddingArtifactKindSchema = z.enum(['sqlite-vec', 'pgvector', 'hnsw']);
export const EmbeddingArtifactStateSchema = z.enum(['live', 'obsolete']);

export const EmbeddingStorageBucketSchema = z.object({
  model: z.string().min(1),
  grain: z.string().min(1),
  dimension: z.number().int().positive().nullable(),
  embeddingBytes: z.number().int().nonnegative(),
  storeRows: z.number().int().nonnegative(),
  referencedRows: z.number().int().nonnegative(),
  orphanRows: z.number().int().nonnegative(),
  nodeRefs: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  activeModel: z.boolean(),
});

export const EmbeddingMixedDimensionsSchema = z.object({
  model: z.string().min(1),
  grain: z.string().min(1),
  dimensions: z.array(z.number().int().positive()).min(2),
});

export const EmbeddingArtifactSchema = z.object({
  kind: EmbeddingArtifactKindSchema,
  grain: z.enum(['symbol', 'chunk']),
  dimension: z.number().int().positive(),
  state: EmbeddingArtifactStateSchema,
  detail: z.string().min(1),
});

const EmbeddingAuditTotalsSchema = z.object({
  storeRows: z.number().int().nonnegative(),
  referencedRows: z.number().int().nonnegative(),
  orphanRows: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  staleModelRows: z.number().int().nonnegative(),
  safeCleanupRows: z.number().int().nonnegative(),
  supersededRefs: z.number().int().nonnegative(),
  protectedReferencedRows: z.number().int().nonnegative(),
  protectedActiveRows: z.number().int().nonnegative(),
});

export const EmbeddingAuditReportSchema = z.object({
  activeModel: z.string().min(1).optional(),
  buckets: z.array(EmbeddingStorageBucketSchema),
  activeDimensions: z.array(z.number().int().positive()),
  canonicalDimensions: z.array(z.number().int().positive()),
  mixedDimensions: z.array(EmbeddingMixedDimensionsSchema),
  artifacts: z.array(EmbeddingArtifactSchema),
  totals: EmbeddingAuditTotalsSchema,
  warnings: z.array(z.string().min(1)),
});

export const EmbeddingArtifactRemovalSchema = z.object({
  kind: EmbeddingArtifactKindSchema,
  dimension: z.number().int().positive(),
  detail: z.string().min(1),
});

export const EmbeddingCleanupResultSchema = z.object({
  activeModel: z.string().min(1),
  dryRun: z.boolean(),
  candidateRows: z.number().int().nonnegative(),
  candidateRefs: z.number().int().nonnegative(),
  candidateStorageBytes: z.number().int().nonnegative(),
  deletedRows: z.number().int().nonnegative(),
  deletedRefs: z.number().int().nonnegative(),
  protectedReferencedRows: z.number().int().nonnegative(),
  protectedActiveRows: z.number().int().nonnegative(),
  affectedDimensions: z.array(z.number().int().positive()),
  obsoleteDimensionsAfterCleanup: z.array(z.number().int().positive()),
  removedArtifacts: z.array(EmbeddingArtifactRemovalSchema),
});

export type EmbeddingStorageBucket = z.infer<typeof EmbeddingStorageBucketSchema>;
export type EmbeddingArtifact = z.infer<typeof EmbeddingArtifactSchema>;
export type EmbeddingAuditReport = z.infer<typeof EmbeddingAuditReportSchema>;
export type EmbeddingCleanupResult = z.infer<typeof EmbeddingCleanupResultSchema>;
export type EmbeddingArtifactRemoval = z.infer<typeof EmbeddingArtifactRemovalSchema>;
