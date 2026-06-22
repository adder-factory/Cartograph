import { z } from 'zod';
import { parseZodBoundary } from '../errors.js';

const shimmerWorkerDataSchema = z.strictObject({
  startTime: z.number(),
});

const shimmerWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('update'),
    phase: z.string(),
    phaseName: z.string(),
    percent: z.number().int(),
    count: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('finish-phase') }),
  z.strictObject({ type: z.literal('stop') }),
]);

const shimmerWorkerReplySchema = z.strictObject({
  type: z.literal('stopped'),
});

export type ShimmerWorkerData = z.infer<typeof shimmerWorkerDataSchema>;
export type ShimmerWorkerMessage = z.infer<typeof shimmerWorkerMessageSchema>;
export type ShimmerWorkerReply = z.infer<typeof shimmerWorkerReplySchema>;

export function parseShimmerWorkerData(value: unknown): ShimmerWorkerData {
  return parseZodBoundary(shimmerWorkerDataSchema, value, 'Invalid shimmer worker data');
}

export function parseShimmerWorkerMessage(value: unknown): ShimmerWorkerMessage {
  return parseZodBoundary(shimmerWorkerMessageSchema, value, 'Invalid shimmer worker message');
}

export function parseShimmerWorkerReply(value: unknown): ShimmerWorkerReply {
  return parseZodBoundary(shimmerWorkerReplySchema, value, 'Invalid shimmer worker reply');
}
