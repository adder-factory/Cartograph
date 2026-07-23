import { z } from 'zod';

export const TaskHandoffActionSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
  priority: z.number().int().nonnegative(),
});

export const TaskHandoffIndexFreshnessSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string().min(1) }),
  z.object({
    available: z.literal(true),
    severity: z.enum(['fresh', 'recent', 'stale', 'very_stale']),
    isStale: z.boolean(),
    filesChanged: z.number().int().nonnegative().nullable(),
    contentDriftedFiles: z.number().int().nonnegative().nullable(),
  }),
]);

export type TaskHandoffIndexFreshness = z.infer<typeof TaskHandoffIndexFreshnessSchema>;
