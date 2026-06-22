import { z } from 'zod';
import { VALID_LANGUAGES } from '../config/languages.js';
import { formatZodIssues } from '../errors.js';
import { extractionResultSchema } from './types.js';

const languageSchema = z.enum(VALID_LANGUAGES);

const profileEntrySchema = z.strictObject({
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});

const parseWorkerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('load-grammars'),
    languages: z.array(languageSchema),
  }),
  z.strictObject({
    type: z.literal('parse'),
    id: z.number().int().nonnegative(),
    filePath: z.string().min(1),
    content: z.string(),
  }),
  z.strictObject({
    type: z.literal('shutdown'),
  }),
]);

export type ParseWorkerCommand = z.infer<typeof parseWorkerCommandSchema>;

const parseWorkerReplySchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('grammars-loaded'),
  }),
  z.strictObject({
    type: z.literal('grammars-load-failed'),
    error: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('parse-result'),
    id: z.number().int().nonnegative(),
    result: extractionResultSchema,
    profileDelta: z.array(profileEntrySchema).optional(),
  }),
  z.strictObject({
    type: z.literal('shutdown-ack'),
  }),
]);

export type ParseWorkerReply = z.infer<typeof parseWorkerReplySchema>;

export function parseParseWorkerCommand(raw: unknown): ParseWorkerCommand {
  const parsed = parseWorkerCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid parse worker command: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseParseWorkerReply(raw: unknown): ParseWorkerReply {
  const parsed = parseWorkerReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid parse worker reply: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseWorkerRawType(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  return typeof type === 'string' ? type : null;
}

export function parseWorkerRawId(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
