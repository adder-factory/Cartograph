import { z } from 'zod';
import { ContextRouteConfidenceSchema } from '../context-route/contract.js';

export const WorkingTreeOverlayModeSchema = z.enum(['auto', 'live', 'off']);
export const WorkingTreeOverlayStatusSchema = z.enum(['off', 'clean', 'ready', 'partial']);
export const WorkingTreeOverlayFacetSchema = z.enum(['gitDiff', 'contentDrift']);

export const WorkingTreeOverlayCandidateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().nonnegative(),
  confidence: ContextRouteConfidenceSchema,
  facets: z.array(WorkingTreeOverlayFacetSchema).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  provenance: z.literal('working-tree'),
});

export const WorkingTreeOverlaySkipSchema = z.object({
  filePath: z.string().min(1),
  reason: z.string().min(1),
});

export const WorkingTreeOverlayReportSchema = z.object({
  mode: WorkingTreeOverlayModeSchema,
  status: WorkingTreeOverlayStatusSchema,
  changedFiles: z.array(z.string().min(1)),
  extractedFiles: z.array(z.string().min(1)),
  candidates: z.array(WorkingTreeOverlayCandidateSchema),
  skipped: z.array(WorkingTreeOverlaySkipSchema),
});

export type WorkingTreeOverlayMode = z.infer<typeof WorkingTreeOverlayModeSchema>;
export type WorkingTreeOverlayStatus = z.infer<typeof WorkingTreeOverlayStatusSchema>;
export type WorkingTreeOverlayFacet = z.infer<typeof WorkingTreeOverlayFacetSchema>;
export type WorkingTreeOverlayCandidate = z.infer<typeof WorkingTreeOverlayCandidateSchema>;
export type WorkingTreeOverlayReport = z.infer<typeof WorkingTreeOverlayReportSchema>;
