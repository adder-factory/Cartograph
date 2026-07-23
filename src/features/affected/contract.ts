import { z } from 'zod';

export const AffectedTestTierSchema = z.enum(['direct', 'likely', 'broad']);

export const AffectedTestCandidateSchema = z.object({
  path: z.string().min(1),
  tier: AffectedTestTierSchema,
  distance: z.number().int().nonnegative(),
  reason: z.enum(['changed-test', 'direct-dependent', 'transitive-dependent']),
});

export type AffectedTestTier = z.infer<typeof AffectedTestTierSchema>;
export type AffectedTestCandidate = z.infer<typeof AffectedTestCandidateSchema>;
