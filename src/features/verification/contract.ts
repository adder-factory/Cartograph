import { z } from 'zod';
import { AffectedTestCandidateSchema } from '../affected/contract.js';

export const VerificationCommandKindSchema = z.enum(['targeted-tests', 'full-suite', 'project-gate']);

export const VerificationCommandSchema = z.object({
  kind: VerificationCommandKindSchema,
  command: z.string().min(1),
  reason: z.string().min(1),
});

export const VerificationStructuralSummarySchema = z.object({
  ref: z.string().min(1),
  filesScanned: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  symbolsAdded: z.number().int().nonnegative(),
  symbolsRemoved: z.number().int().nonnegative(),
  symbolsModified: z.number().int().nonnegative(),
  findingsIntroduced: z.number().int().nonnegative(),
  findingsCleared: z.number().int().nonnegative(),
  findingDiagnostics: z.array(z.string().min(1)),
});

const VerificationPlanBaseSchema = z.object({
  changedFiles: z.array(z.string().min(1)),
  indexedChangedFiles: z.array(z.string().min(1)),
  unindexedChangedFiles: z.array(z.string().min(1)),
  testCandidates: z.array(AffectedTestCandidateSchema),
  barrelsReached: z.array(z.string().min(1)),
  commands: z.array(VerificationCommandSchema),
  commandsExecuted: z.literal(false),
  warnings: z.array(z.string().min(1)),
});

export const VerificationPlanSchema = z.discriminatedUnion('status', [
  VerificationPlanBaseSchema.extend({
    status: z.literal('clean'),
    structural: VerificationStructuralSummarySchema,
  }),
  VerificationPlanBaseSchema.extend({
    status: z.literal('ready'),
    structural: VerificationStructuralSummarySchema,
  }),
  VerificationPlanBaseSchema.extend({
    status: z.literal('blocked'),
    structural: z.null(),
    errors: z.array(z.string().min(1)).min(1),
  }),
]);

export type VerificationCommandKind = z.infer<typeof VerificationCommandKindSchema>;
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type VerificationStructuralSummary = z.infer<typeof VerificationStructuralSummarySchema>;
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;
