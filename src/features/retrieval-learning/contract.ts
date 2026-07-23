import { z } from 'zod';

export const ProjectLearningModeSchema = z.enum(['auto', 'off']);
export const ProjectLearningStatusSchema = z.enum(['off', 'empty', 'ready']);

export const ProjectLearningCandidateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().nonnegative(),
  score: z.number().finite().nonnegative(),
  matchedContexts: z.number().int().positive(),
  tools: z.array(z.string().min(1)).min(1),
  provenance: z.literal('project-session-outcome'),
});

export const ProjectLearningReportSchema = z.object({
  mode: ProjectLearningModeSchema,
  status: ProjectLearningStatusSchema,
  sessionsScanned: z.number().int().nonnegative(),
  contextMatches: z.number().int().nonnegative(),
  outcomeSignals: z.number().int().nonnegative(),
  candidates: z.array(ProjectLearningCandidateSchema),
});

export type ProjectLearningMode = z.infer<typeof ProjectLearningModeSchema>;
export type ProjectLearningCandidate = z.infer<typeof ProjectLearningCandidateSchema>;
export type ProjectLearningReport = z.infer<typeof ProjectLearningReportSchema>;
