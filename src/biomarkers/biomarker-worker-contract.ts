import { z } from 'zod';
import { formatZodIssues } from '../errors.js';
import { crossFileBiomarkerNameSchema, findingSchema } from './types.js';

const biomarkerWorkerInitSchema = z.strictObject({
  dbPath: z.string().min(1),
  projectRoot: z.string().min(1),
  ruleKind: crossFileBiomarkerNameSchema,
});

export type BiomarkerWorkerInit = z.infer<typeof biomarkerWorkerInitSchema>;

const biomarkerWorkerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    ruleKind: crossFileBiomarkerNameSchema,
    findings: z.array(findingSchema),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    ruleKind: crossFileBiomarkerNameSchema,
    error: z.string().min(1),
  }),
]);

export type BiomarkerWorkerReply = z.infer<typeof biomarkerWorkerReplySchema>;

export function parseBiomarkerWorkerInit(raw: unknown): BiomarkerWorkerInit {
  const parsed = biomarkerWorkerInitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid biomarker worker init: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseBiomarkerWorkerReply(raw: unknown): BiomarkerWorkerReply {
  const parsed = biomarkerWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid biomarker worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
