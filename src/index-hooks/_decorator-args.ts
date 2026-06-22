/**
 * Shared parser for the JSON-encoded `Node.decorator_args` column (B9).
 *
 * Both the `nestjs-routes` and `spring-value-binding` hooks read decorator
 * args off the graph in the same defensive way; this is the single home
 * for that parse so the two can't drift (was a `duplicate_code` finding).
 */
import { z } from 'zod';
import type { DecoratorArgsEntry } from '../types.js';

const namedArgsSchema = z.record(z.string(), z.string());

const decoratorArgsEntryInputSchema = z.object({
  name: z.string(),
  argStrings: z.array(z.string()),
  argIdents: z.array(z.string()),
  namedArgs: namedArgsSchema.optional(),
});

const decoratorArgsEntrySchema = decoratorArgsEntryInputSchema.transform((entry): DecoratorArgsEntry => {
  const out: DecoratorArgsEntry = {
    name: entry.name,
    argStrings: entry.argStrings,
    argIdents: entry.argIdents,
  };
  if (entry.namedArgs !== undefined) out.namedArgs = entry.namedArgs;
  return out;
});

type ParsedDecoratorArgsEntry = z.infer<typeof decoratorArgsEntrySchema>;

const decoratorArgsJsonSchema = z.array(decoratorArgsEntrySchema);

/** Parse the JSON-encoded `Node.decorator_args` column. Returns [] for
 *  NULL / invalid JSON / non-array shapes / entries with invalid fields
 *  — defensive against partially-corrupt rows. */
export function parseDecoratorArgsJson(raw: string | null): ParsedDecoratorArgsEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = decoratorArgsJsonSchema.safeParse(parsed);
  return result.success ? result.data : [];
}
