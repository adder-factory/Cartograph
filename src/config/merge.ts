import type { CartographConfig } from '../types.js';
import { compact } from '../utils.js';

/**
 * Merge configuration with defaults.
 *
 * Special case for `include`: the language registry can grow (new
 * extensions added to existing language defs, e.g. `.mts`/`.cts`
 * joining the TypeScript def). When a persisted config materialized
 * its `include` list at init time, replacing it on every load means
 * the project would silently miss the new extension forever. So `include`
 * is UNIONED with the registry-derived defaults: every user-listed
 * glob is preserved in its original order, then any registry glob the
 * user doesn't already have is appended. This is the "auto-pickup" of
 * new language extensions on next load (G14, 2026-05-21).
 *
 * Trade-off accepted: if a user deliberately removed the Python glob
 * from their include to exclude Python files, the next load re-adds
 * it. That is counted as a misuse of `include` — the supported
 * pattern for excluding a language is the `exclude` array.
 */
export function mergeConfig(defaults: CartographConfig, overrides: Partial<CartographConfig>): CartographConfig {
  // Spread `defaults` then `compact(overrides)`:
  //   - undefined-valued overrides (common when callers forward an
  //     unset CLI flag) don't clobber a populated default
  //   - any new field added to `CartographConfig` flows through
  //     automatically — no per-field listing to keep in sync
  // The previous form listed all fields manually; adding a new
  // field meant remembering to update this function or the
  // override would silently no-op.
  const cleanOverrides = compact(overrides);
  // Merge onto a null-prototype object directly (cheaper than mutating the
  // prototype of an existing literal) so a polluted Object.prototype can't
  // shadow a missing field.
  const merged: CartographConfig = Object.assign(Object.create(null), defaults, cleanOverrides);
  // Defense-in-depth against prototype pollution: a config loaded from
  // disk is `JSON.parse`d untrusted input, so an own `__proto__`/
  // `constructor`/`prototype` data key could ride in through the merge.
  // Drop any such key explicitly (none are valid CartographConfig fields);
  // the strip makes the intent self-evident rather than relying on the
  // null prototype alone.
  const mergedRecord = merged as unknown as Record<string, unknown>;
  for (const unsafeKey of ['__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(mergedRecord, unsafeKey)) delete mergedRecord[unsafeKey];
  }
  const persisted = cleanOverrides.include;
  if (Array.isArray(persisted)) {
    const seen = new Set(persisted);
    const extras = defaults.include.filter((g) => !seen.has(g));
    merged.include = extras.length > 0 ? [...persisted, ...extras] : persisted;
  }
  return merged;
}
