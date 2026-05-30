/**
 * Shared parser for the JSON-encoded `Node.decorator_args` column (B9).
 *
 * Both the `nestjs-routes` and `spring-value-binding` hooks read decorator
 * args off the graph in the same defensive way; this is the single home
 * for that parse so the two can't drift (was a `duplicate_code` finding).
 */
import type { DecoratorArgsEntry } from '../types.js';

/** Parse the optional `namedArgs` map off a raw entry — populated for
 *  multi-language named args (PHP-8 attribute, Java `element_value_pair`,
 *  Kotlin named `value_argument`). String→string pairs only (boolean
 *  values are persisted as the text `'true'`/`'false'`); returns undefined
 *  for an absent, non-object, array, or all-non-string-valued field (so
 *  positional-only entries stay `namedArgs`-free). */
function parseNamedArgs(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const named: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') named[k] = v;
  }
  return Object.keys(named).length > 0 ? named : undefined;
}

/** Parse the JSON-encoded `Node.decorator_args` column. Returns [] for
 *  NULL / invalid JSON / non-array shapes / entries missing required
 *  fields — defensive against partially-corrupt rows. */
export function parseDecoratorArgsJson(raw: string | null): DecoratorArgsEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DecoratorArgsEntry[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.name === 'string' &&
        Array.isArray(entry.argStrings) &&
        Array.isArray(entry.argIdents)
      ) {
        const parsedEntry: DecoratorArgsEntry = {
          name: entry.name,
          argStrings: entry.argStrings.filter((s: unknown): s is string => typeof s === 'string'),
          argIdents: entry.argIdents.filter((s: unknown): s is string => typeof s === 'string'),
        };
        // Named args (PHP-8 attribute / Java element_value_pair / Kotlin value_argument).
        const named = parseNamedArgs(entry.namedArgs);
        if (named) parsedEntry.namedArgs = named;
        out.push(parsedEntry);
      }
    }
    return out;
  } catch {
    return [];
  }
}
