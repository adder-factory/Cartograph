import { z } from 'zod';
import { formatZodIssues } from '../errors.js';

const sharedArrayBufferSchema = z.instanceof(SharedArrayBuffer);
const arrayBufferSchema = z.instanceof(ArrayBuffer);

const betweennessWorkerInitSchema = z.strictObject({
  N: z.number().int().nonnegative(),
  outOffsetsBuf: sharedArrayBufferSchema,
  outFlatBuf: sharedArrayBufferSchema,
  sourceIndices: z.array(z.number().int().nonnegative()),
});

export type BetweennessWorkerInit = z.infer<typeof betweennessWorkerInitSchema>;

const betweennessWorkerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    cbBuf: arrayBufferSchema,
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);

export type BetweennessWorkerReply = z.infer<typeof betweennessWorkerReplySchema>;

export function parseBetweennessWorkerInit(raw: unknown): BetweennessWorkerInit {
  const parsed = betweennessWorkerInitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid betweenness worker init: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseBetweennessWorkerReply(raw: unknown): BetweennessWorkerReply {
  const parsed = betweennessWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid betweenness worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
