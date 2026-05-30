/**
 * Unknown-argument warnings for tool calls.
 *
 * Zod (`safeParse`) silently STRIPS keys a tool's schema doesn't
 * declare — so an agent that passes a near-miss arg name (`path` when
 * the schema declares `pathFilter`) gets no signal that its argument
 * was ignored. This module is the missing nudge: a non-fatal scan that
 * runs alongside `safeParse` at the dispatch boundary and reports each
 * unknown non-underscore key, suggesting the declared name it most
 * plausibly meant.
 *
 * Keys starting with `_` (`_trace_id`, `__progress_token`, `_meta`)
 * are legit MCP metadata and are accepted silently with no warning.
 *
 * This was extracted from the retired `_schema-validate.ts` (the
 * bespoke pre-Zod JSON-Schema validator) — once every tool became
 * Zod-backed (structural campaign P4), the unknown-arg warning was the
 * only part of that validator still doing live work.
 */

import type { ToolDefinition } from '../tool-types.js';
import { editDistance } from '../../text-distance.js';

/**
 * Scan a tool call's `args` against its declared `inputSchema` and
 * return one non-fatal warning per unknown (non-underscore-prefixed,
 * non-`undefined`) key. An empty array means every arg is declared.
 *
 * Type / range / enum validation is NOT done here — that is Zod's job
 * (`safeParse`). This is purely the "you passed an arg that isn't in
 * the schema" nudge Zod's silent key-stripping would otherwise hide.
 */
export function collectUnknownArgWarnings(
  args: Record<string, unknown>,
  inputSchema: ToolDefinition['inputSchema'],
): string[] {
  const properties = inputSchema.properties ?? {};
  const declaredKeys = Object.keys(properties);
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    // Declared key — Zod validates it. Underscore-prefixed key — legit
    // MCP metadata. `undefined` value — equivalent to "not provided".
    if (name in properties) continue;
    if (name.startsWith('_') || value === undefined) continue;
    warnings.push(buildUnknownArgWarning(name, declaredKeys));
  }
  return warnings;
}

/** Build a warning message for an unknown (non-underscore) argument key. */
function buildUnknownArgWarning(key: string, declaredKeys: string[]): string {
  const keyLower = key.toLowerCase();
  const suggestions = declaredKeys
    .filter((dk) => {
      const dkLower = dk.toLowerCase();
      // Substring-inclusion checks over-match on very short keys (e.g. `a`,
      // `id` matches almost every multi-char declared key). Only apply them
      // when the unknown key is at least 3 chars; Levenshtein <= 2 remains
      // unconditional since edit-distance is meaningful for short strings.
      const substrMatch = keyLower.length >= 3 && (keyLower.includes(dkLower) || dkLower.includes(keyLower));
      return substrMatch || editDistance(keyLower, dkLower) <= 2;
    })
    .slice(0, 3);

  const base = `Unknown argument \`${key}\` was ignored (not in this tool's schema).`;
  if (suggestions.length === 0) return base;
  const quoted = suggestions.map((s) => `\`${s}\``);
  let hint: string;
  if (quoted.length === 1) hint = `Did you mean ${quoted[0]}?`;
  else if (quoted.length === 2) hint = `Did you mean ${quoted[0]} or ${quoted[1]}?`;
  else hint = `Did you mean ${quoted[0]}, ${quoted[1]}, or ${quoted[2]}?`;
  return `${base} ${hint}`;
}
