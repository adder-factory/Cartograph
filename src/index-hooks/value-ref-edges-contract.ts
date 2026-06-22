import { z } from 'zod';
import { formatZodIssues } from '../errors.js';

const valueRefEdgeRecordSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    kind: z.literal('references'),
  })
  .strict();

export type ValueRefEdgeRecord = z.infer<typeof valueRefEdgeRecordSchema>;

const valueRefWorkerFileRecordSchema = z
  .object({
    path: z.string().min(1),
    language: z.string().min(1),
  })
  .strict();

const valueRefWorkerInitSchema = z
  .object({
    dbPath: z.string().min(1),
    projectRoot: z.string().min(1),
    fileRecords: z.array(valueRefWorkerFileRecordSchema),
  })
  .strict();

export type ValueRefWorkerInit = z.infer<typeof valueRefWorkerInitSchema>;

const valueRefWorkerReplySchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      edges: z.array(valueRefEdgeRecordSchema),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);

export type ValueRefWorkerReply = z.infer<typeof valueRefWorkerReplySchema>;

export function parseValueRefWorkerInit(raw: unknown): ValueRefWorkerInit {
  const parsed = valueRefWorkerInitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid value-ref worker init: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseValueRefWorkerReply(raw: unknown): ValueRefWorkerReply {
  const parsed = valueRefWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid value-ref worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
