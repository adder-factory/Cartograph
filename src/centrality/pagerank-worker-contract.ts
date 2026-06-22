import { z } from 'zod';
import { formatZodIssues } from '../errors.js';

const int32ArraySchema = z.instanceof(Int32Array);
const sharedArrayBufferSchema = z.instanceof(SharedArrayBuffer);

const pageRankWorkerInitSchema = z.strictObject({
  targets: int32ArraySchema,
  N: z.number().int().positive(),
  damping: z.number().min(0).max(1),
  prBuf: sharedArrayBufferSchema,
  nextBuf: sharedArrayBufferSchema,
  outDegBuf: sharedArrayBufferSchema,
  inEdgesFlatBuf: sharedArrayBufferSchema,
  inEdgesOffsetsBuf: sharedArrayBufferSchema,
});

export type PageRankWorkerInit = z.infer<typeof pageRankWorkerInitSchema>;

const pageRankStepMessageSchema = z.strictObject({
  type: z.literal('step'),
  basePlusDangling: z.number().nonnegative(),
});

export type PageRankStepMessage = z.infer<typeof pageRankStepMessageSchema>;

const pageRankWorkerReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('done') }),
  z.strictObject({ type: z.literal('error'), error: z.string().min(1) }),
]);

export type PageRankWorkerReply = z.infer<typeof pageRankWorkerReplySchema>;

export function parsePageRankWorkerInit(raw: unknown): PageRankWorkerInit {
  const parsed = pageRankWorkerInitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid pagerank worker init: ${formatZodIssues(parsed.error)}`);
  }
  validatePageRankWorkerInit(parsed.data);
  return parsed.data;
}

export function parsePageRankStepMessage(raw: unknown): PageRankStepMessage {
  const parsed = pageRankStepMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid pagerank step message: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parsePageRankWorkerReply(raw: unknown): PageRankWorkerReply {
  const parsed = pageRankWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid pagerank worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function validatePageRankWorkerInit(init: PageRankWorkerInit): void {
  assertByteLength('prBuf', init.prBuf, init.N * Float64Array.BYTES_PER_ELEMENT);
  assertByteLength('nextBuf', init.nextBuf, init.N * Float64Array.BYTES_PER_ELEMENT);
  assertByteLength('outDegBuf', init.outDegBuf, init.N * Int32Array.BYTES_PER_ELEMENT);
  assertByteLength('inEdgesOffsetsBuf', init.inEdgesOffsetsBuf, (init.N + 1) * Int32Array.BYTES_PER_ELEMENT);

  for (let i = 0; i < init.targets.length; i++) {
    const target = init.targets[i]!;
    if (target < 0 || target >= init.N) {
      throw new Error(`invalid pagerank worker init: targets.${i}: target index ${target} is outside [0, ${init.N})`);
    }
  }
}

function assertByteLength(field: string, buffer: SharedArrayBuffer, expected: number): void {
  if (buffer.byteLength !== expected) {
    throw new Error(`invalid pagerank worker init: ${field}: expected ${expected} bytes, got ${buffer.byteLength}`);
  }
}
