import { z } from 'zod';

export const CodingTaskKindSchema = z.enum(['locate', 'explain', 'debug', 'feature', 'refactor', 'review', 'test']);

export const ContextRouteBucketSchema = z.enum(['edit-site', 'supporting', 'test', 'configuration']);

export const ContextRouteConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const ContextRouteAnchorsSchema = z.object({
  identifiers: z.array(z.string().min(1)),
  paths: z.array(z.string().min(1)),
});

export const ContextRouteCandidateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().nonnegative(),
  bucket: ContextRouteBucketSchema,
  confidence: ContextRouteConfidenceSchema,
  evidence: z.array(z.string().min(1)).min(1),
});

const ContextRouteBaseSchema = z.object({
  taskKind: CodingTaskKindSchema,
  clauses: z.array(z.string().min(1)).min(1),
  anchors: ContextRouteAnchorsSchema,
  candidates: z.array(ContextRouteCandidateSchema),
});

export const ContextRouteSchema = z.discriminatedUnion('status', [
  ContextRouteBaseSchema.extend({
    status: z.literal('ready'),
  }),
  ContextRouteBaseSchema.extend({
    status: z.literal('abstained'),
    reason: z.string().min(1),
  }),
]);

export type ContextRoute = z.infer<typeof ContextRouteSchema>;
