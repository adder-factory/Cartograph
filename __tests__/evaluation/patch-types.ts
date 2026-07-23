import { z } from 'zod';

export const PatchRetrievalModeSchema = z.enum(['deterministic', 'auto', 'hybrid']);
export const PatchEvalSkipReasonSchema = z.enum(['no-embeddings', 'endpoint-unavailable']);

export const PatchTaskCaseSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  expectedSymbols: z.array(z.string().min(1)),
  expectedEditFiles: z.array(z.string().min(1)),
  expectedTestFiles: z.array(z.string().min(1)),
  shouldAbstain: z.boolean().optional(),
});

export const PatchTaskObservationSchema = z.object({
  rankedSymbols: z.array(z.object({ name: z.string().min(1), filePath: z.string().min(1) })),
  predictedEditFiles: z.array(z.string().min(1)),
  selectedTestFiles: z.array(z.string().min(1)),
  abstained: z.boolean(),
  latencyMs: z.number().nonnegative(),
  payloadBytes: z.number().int().nonnegative(),
  retrievalStrategy: z.enum(['lexical-graph', 'hybrid']).optional(),
  hybridCandidateCount: z.number().int().nonnegative().optional(),
});

export const PatchTaskEvalResultSchema = z.object({
  caseId: z.string().min(1),
  mode: PatchRetrievalModeSchema,
  pass: z.boolean(),
  hitAtK: z.number().min(0).max(1),
  mrr: z.number().min(0).max(1),
  editSitePrecision: z.number().min(0).max(1),
  editSiteRecall: z.number().min(0).max(1),
  testSelectionRecall: z.number().min(0).max(1).nullable(),
  abstentionCorrect: z.boolean(),
  latencyMs: z.number().nonnegative(),
  payloadBytes: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  foundSymbols: z.array(z.string()),
  missedSymbols: z.array(z.string()),
  rankedSymbols: z.array(z.object({ name: z.string(), filePath: z.string() })),
  predictedEditFiles: z.array(z.string()),
  selectedTestFiles: z.array(z.string()),
  retrievalStrategy: z.enum(['lexical-graph', 'hybrid']).optional(),
  hybridCandidateCount: z.number().int().nonnegative().optional(),
  skipped: PatchEvalSkipReasonSchema.optional(),
  skipDetail: z.string().min(1).optional(),
});

export const PatchModeSummarySchema = z.object({
  mode: PatchRetrievalModeSchema,
  scored: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  meanHitAtK: z.number().min(0).max(1),
  meanMrr: z.number().min(0).max(1),
  meanEditSitePrecision: z.number().min(0).max(1),
  meanEditSiteRecall: z.number().min(0).max(1),
  meanTestSelectionRecall: z.number().min(0).max(1).nullable(),
  abstentionAccuracy: z.number().min(0).max(1),
  medianLatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  meanPayloadBytes: z.number().nonnegative(),
  meanEstimatedTokens: z.number().nonnegative(),
});

export const PatchTaskEvalReportSchema = z
  .object({
    generatedAt: z.string().min(1),
    codebasePath: z.string().min(1),
    topK: z.number().int().positive(),
    caseCount: z.number().int().nonnegative(),
    caseIds: z.array(z.string().min(1)),
    corpusFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    modes: z.array(PatchModeSummarySchema),
    results: z.array(PatchTaskEvalResultSchema),
  })
  .superRefine((report, ctx) => {
    const uniqueCaseIds = new Set(report.caseIds);
    if (uniqueCaseIds.size !== report.caseIds.length) {
      ctx.addIssue({ code: 'custom', path: ['caseIds'], message: 'caseIds must be unique' });
    }
    if (report.caseIds.length !== report.caseCount) {
      ctx.addIssue({ code: 'custom', path: ['caseIds'], message: 'caseIds must match caseCount' });
    }
    for (const [index, summary] of report.modes.entries()) {
      if (summary.scored + summary.skipped !== report.caseCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['modes', index],
          message: 'mode scored + skipped must match caseCount',
        });
      }
    }
  });

export type PatchRetrievalMode = z.infer<typeof PatchRetrievalModeSchema>;
export type PatchEvalSkipReason = z.infer<typeof PatchEvalSkipReasonSchema>;
export type PatchTaskCase = z.infer<typeof PatchTaskCaseSchema>;
export type PatchTaskObservation = z.infer<typeof PatchTaskObservationSchema>;
export type PatchTaskEvalResult = z.infer<typeof PatchTaskEvalResultSchema>;
export type PatchModeSummary = z.infer<typeof PatchModeSummarySchema>;
export type PatchTaskEvalReport = z.infer<typeof PatchTaskEvalReportSchema>;
