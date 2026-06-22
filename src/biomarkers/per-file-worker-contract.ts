import { z } from 'zod';
import { formatZodIssues } from '../errors.js';
import { findingSchema } from './types.js';

const perFileOutcomeSchema = z.enum([
  'file-unreadable',
  'no-analysable',
  'unsupported-language',
  'parse-failed',
  'computed',
]);

export type PerFileOutcome = z.infer<typeof perFileOutcomeSchema>;

const perFileMetricsRowSchema = z.strictObject({
  loc: z.number().int().nonnegative(),
  cyclomatic: z.number().int().nonnegative(),
  maxNesting: z.number().int().nonnegative(),
  maxConditionalOperands: z.number().int().nonnegative(),
  paramCount: z.number().int().nonnegative(),
  magicNumberCount: z.number().int().nonnegative(),
  hardcodedUrlCount: z.number().int().nonnegative(),
});

export type PerFileMetricsRow = z.infer<typeof perFileMetricsRowSchema>;

const perFileStatsDeltaSchema = z.strictObject({
  symbolsAnalysed: z.number().int().nonnegative(),
  findingsEmitted: z.number().int().nonnegative(),
  unsupportedLanguages: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  skippedRangeMismatch: z.number().int().nonnegative(),
});

const perFileResultSchema = z.strictObject({
  relPath: z.string().min(1),
  currentHash: z.string().min(1).nullable(),
  outcome: perFileOutcomeSchema,
  metricsByNode: z.map(z.string().min(1), perFileMetricsRowSchema).optional(),
  locByNode: z.map(z.string().min(1), z.number().int().nonnegative()).optional(),
  findingsByNode: z.map(z.string().min(1), z.array(findingSchema)).optional(),
  statsDelta: perFileStatsDeltaSchema,
});

export type PerFileResult = z.infer<typeof perFileResultSchema>;

const perFileWorkerBatchItemSchema = z.strictObject({
  relPath: z.string().min(1),
  currentHash: z.string().min(1).nullable(),
});

const perFileWorkerInitSchema = z.strictObject({
  dbPath: z.string().min(1),
  projectRoot: z.string().min(1),
  batch: z.array(perFileWorkerBatchItemSchema),
  nowMs: z.number().nonnegative(),
});

export type PerFileWorkerInit = z.infer<typeof perFileWorkerInitSchema>;

const perFileWorkerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    results: z.array(perFileResultSchema),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);

export type PerFileWorkerReply = z.infer<typeof perFileWorkerReplySchema>;

export function parsePerFileWorkerInit(raw: unknown): PerFileWorkerInit {
  const parsed = perFileWorkerInitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid biomarker per-file worker init: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parsePerFileWorkerReply(raw: unknown): PerFileWorkerReply {
  const parsed = perFileWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid biomarker per-file worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
