import { z } from 'zod';

export const TrustCheckStateSchema = z.enum(['ok', 'warn', 'blocked']);

export const TrustCheckSchema = z.object({
  state: TrustCheckStateSchema,
  label: z.string().min(1),
  detail: z.string().min(1),
  action: z.string().min(1),
});

export const TrustReportSchema = z.object({
  deep: z.boolean(),
  overall: TrustCheckStateSchema,
  checks: z.array(TrustCheckSchema),
});

export const SemanticGoldenProbeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    sourceNodeId: z.string().min(1),
    sourceName: z.string().min(1),
    sourcePath: z.string().min(1),
    rank: z.number().int().positive(),
    candidatesReturned: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('fail'),
    sourceNodeId: z.string().min(1).optional(),
    sourceName: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    candidatesReturned: z.number().int().nonnegative().optional(),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal('skip'),
    reason: z.string().min(1),
  }),
]);

export type TrustCheckState = z.infer<typeof TrustCheckStateSchema>;
export type TrustCheck = z.infer<typeof TrustCheckSchema>;
export type TrustReport = z.infer<typeof TrustReportSchema>;
export type SemanticGoldenProbe = z.infer<typeof SemanticGoldenProbeSchema>;
