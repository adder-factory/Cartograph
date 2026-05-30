/**
 * Load-bearing algorithm-source hashing.
 *
 * Every persisted cache in cartograph keyed by a "version" (parse_cache
 * payload version, extraction logic version, biomarker rule version,
 * etc.) used to ship as a hand-maintained integer / string literal that
 * the contributor was expected to bump whenever its underlying logic
 * changed. A drift-detector test yelled when a spec file's content
 * hash diverged from a checked-in manifest, but the actual bump was a
 * manual decision — easy to forget, easy to under-bump (only one
 * constant when two were affected), easy to over-bump (refactor that
 * doesn't change semantics).
 *
 * This module replaces that workflow. Each cache key is now derived
 * at module-load time from a sha256 of the relevant algorithm source
 * files (after comment-strip + whitespace normalisation, so cosmetic
 * edits don't invalidate). When a contributor edits a spec file, the
 * hash changes automatically and the cache invalidates on the next
 * sync — no manifest update, no constant bump, no drift detector.
 *
 * Runtime resolution: the caller passes its own `import.meta.url`;
 * the helper reads sibling files relative to that path. In
 * dev/test (bun:test) the URL points at `src/.../*.ts` and
 * the helper hashes the TypeScript sources. In production (compiled
 * `dist/.../*.js`) the URL points at the built files and the helper
 * hashes those. Both produce stable hashes within a single install;
 * the absolute hash value differs between src and dist, but a single
 * project never straddles the two so the cache invalidates exactly
 * once when a contributor flips between `npm test` (src) and
 * `npx cartograph` (dist) — acceptable for the contribution workflow,
 * invisible for end users.
 *
 * The hash is truncated to 16 hex chars — 64 bits of entropy, plenty
 * to make accidental collision astronomical, short enough to read in
 * a debug log without scrolling.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsForRegex } from './utils.js';

/** Cache so repeated calls with the same (caller, paths) are O(1). */
const HASH_CACHE = new Map<string, string>();

/**
 * Hash the listed sibling source files relative to the caller's
 * `import.meta.url`. The caller passes `import.meta.url` so we can
 * resolve siblings without depending on `__dirname` (ESM has no
 * `__dirname`) and so the helper works identically in src/ (where
 * siblings are `.ts`) and dist/ (where siblings are `.js`).
 *
 * `siblingBasenames` are filename stems WITHOUT extension. The helper
 * derives the extension from the caller's own file (`.ts` in dev,
 * `.js` in prod) and reads the corresponding sibling files. Pass
 * `..`-prefixed names to reach parent directories
 * (e.g. `'../types'` from a `db/` module).
 *
 * Throws on a missing file — silently producing the wrong hash would
 * defeat the point.
 */
export function computeAlgoHash(callerUrl: string, siblingBasenames: readonly string[]): string {
  const cacheKey = `${callerUrl}\0${siblingBasenames.join('\0')}`;
  const cached = HASH_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const callerPath = fileURLToPath(callerUrl);
  const callerDir = path.dirname(callerPath);
  const ext = path.extname(callerPath);

  const hasher = crypto.createHash('sha256');
  for (const stem of siblingBasenames) {
    const abs = path.resolve(callerDir, stem + ext);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      throw new Error(`computeAlgoHash: cannot read ${abs} (caller=${callerPath}): ${String(err)}`);
    }
    const lf = content.replaceAll(/\r\n/g, '\n');
    // Comment stripping is what makes refactor-PRs that only touch
    // block comments (`/* … */`, JSDoc) or comment-anchored lines
    // (lines starting with `//`) NOT invalidate the cache. Trailing
    // inline comments on code lines (`const x = 1; // note`) DO
    // count — `stripInlineComments: false` keeps the legacy
    // leading-only strip, so an inline-tail edit still shifts the
    // hash. Whitespace normalisation handles reformatting.
    const stripped = stripCommentsForRegex(lf, 'typescript', { stripInlineComments: false });
    const normalised = stripped.replaceAll(/\s+/g, ' ').trim();
    hasher.update(stem);
    hasher.update('\0');
    hasher.update(normalised);
    hasher.update('\0');
  }
  const hash = hasher.digest('hex').slice(0, 16);
  HASH_CACHE.set(cacheKey, hash);
  return hash;
}
