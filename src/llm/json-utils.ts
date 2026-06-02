/**
 * Shared JSON-extraction helpers for LLM batch responses. Models
 * sometimes wrap the JSON array in prose, code fences, or trailing
 * tokens, so we scan for a bracket-balanced array rather than calling
 * `JSON.parse` directly.
 */

/**
 * Find the bracket-balanced array starting at `start` in `text`.
 * String-aware so escaped quotes and brackets inside string values
 * don't fool the depth tracker. Returns the closing-bracket index,
 * or -1 when the scan runs past EOF without balancing (caller treats
 * as parse failure).
 */
function findBalancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const state = advanceStringScanState(text[i], inString, escapeNext);
    inString = state.inString;
    escapeNext = state.escapeNext;
    if (state.consumed) continue;
    if (inString) continue;
    if (text[i] === '[') {
      depth++;
      continue;
    }
    if (text[i] !== ']') continue;
    if (--depth === 0) return i;
  }
  return -1;
}

function advanceStringScanState(
  ch: string | undefined,
  inString: boolean,
  escapeNext: boolean,
): { inString: boolean; escapeNext: boolean; consumed: boolean } {
  if (escapeNext) return { inString, escapeNext: false, consumed: true };
  if (ch === '\\' && inString) return { inString, escapeNext: true, consumed: true };
  if (ch === '"') return { inString: !inString, escapeNext: false, consumed: true };
  return { inString, escapeNext: false, consumed: false };
}

/**
 * Extract the first bracket-balanced JSON array from `text` and
 * `JSON.parse` it. Returns `null` on no array found, malformed JSON,
 * or a top-level value that isn't an array. Used by the three batch-
 * response parsers (summarizer / classifier / dead-code).
 */
export function extractJsonArrayFromText(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  const end = findBalancedArrayEnd(text, start);
  if (end === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}
