import { z } from 'zod';
import { ContextRouteSchema, ContextRouteCandidateSchema } from '../context-route/contract.js';
import { WorkingTreeOverlayReportSchema } from '../working-tree-overlay/contract.js';

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

export const TaskHandoffPacketSchema = z.object({
  version: z.literal(1),
  status: z.enum(['ready', 'needs-narrowing']),
  task: z.string().min(1),
  route: ContextRouteSchema,
  editSites: z.array(ContextRouteCandidateSchema),
  contextFiles: z.array(z.string().min(1)),
  indexFreshness: TaskHandoffIndexFreshnessSchema,
  workingTree: WorkingTreeOverlayReportSchema,
  nextActions: z.array(TaskHandoffActionSchema),
  resumeGuidance: z.array(z.string().min(1)).min(1),
});

export type TaskHandoffAction = z.infer<typeof TaskHandoffActionSchema>;
export type TaskHandoffIndexFreshness = z.infer<typeof TaskHandoffIndexFreshnessSchema>;
export type TaskHandoffPacket = z.infer<typeof TaskHandoffPacketSchema>;
