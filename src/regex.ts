/**
 * Safe regex construction, backed by RE2 (via `re2-wasm`).
 *
 * Why RE2: JS's `RegExp` uses a backtracking engine that's vulnerable
 * to catastrophic backtracking on adversarial patterns (`(a+)+` etc.).
 * `cartograph_find by:'content'` accepts user-supplied regex; a hostile
 * pattern against a large file can spin the agent's CPU for hours.
 * RE2 runs in linear time by construction — no backtracking, no ReDoS.
 *
 * Trade-off vs. `RegExp`: RE2 doesn't support the features that
 * require backtracking — lookahead (`(?=...)`), lookbehind (`(?<=...)`),
 * and backreferences (`\1`). Construction throws on those with a clear
 * error message, so callers fall back gracefully rather than running
 * silently degraded.
 *
 * The Unicode flag is required by `re2-wasm` (it normalises pattern +
 * input to UTF-16 internally). This helper always appends `'u'` to the
 * caller's flag string; passing it explicitly is harmless.
 */

import { RE2 } from 're2-wasm';

/**
 * Construct a safe (linear-time) regex from a user-supplied pattern.
 *
 * @param pattern - Regex source; may not use lookahead/lookbehind/backrefs.
 * @param flags - Standard RegExp flags string (`g`, `i`, etc.); `'u'`
 *   is added automatically if not present.
 * @returns A RegExp-shape object: `source`, `flags`, `lastIndex`,
 *   `test()`, `exec()` all behave like `RegExp`. Use `exec` loops over
 *   `matchAll` — RE2 doesn't implement the `Symbol.matchAll` protocol.
 * @throws Error with a `re2-wasm` diagnostic message when the pattern
 *   is invalid or uses an unsupported feature.
 */
export function compileSafeRegex(pattern: string, flags = ''): RE2 {
  const withUnicode = flags.includes('u') ? flags : `${flags}u`;
  return new RE2(pattern, withUnicode);
}

/**
 * Validate that `pattern` is a syntactically-correct, RE2-compatible
 * regex. Use in Zod `.refine(...)` contexts at config boundaries.
 * Returns true on success, false on either an invalid pattern or one
 * that uses unsupported features (lookahead, lookbehind, backrefs).
 */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 500) return false;
  try {
    new RE2(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}
