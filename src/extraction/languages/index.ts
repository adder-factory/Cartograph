/**
 * Per-language barrel.
 *
 * Adding a new language is a single-file addition: drop a
 * `<name>.ts` next to this barrel exporting an `<NAME>_DEF:
 * LanguageDef`, then add one import + one array entry to
 * `./registry.ts`. Nothing in this file needs to change for new
 * languages.
 *
 * `EXTRACTORS` is preserved as a backward-compat export but is now
 * derived from the registry. Direct readers of `EXTRACTORS` get the
 * same shape they always did; the canonical source is each
 * language def's `grammar.extractor` field.
 */

import type { Language } from '../../types.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import { getLanguageDefs } from './registry.js';

export * from './registry.js';

/**
 * Backward-compat: `Language → LanguageExtractor` map. Built lazily
 * on first read (the registry transitively imports modules that
 * import this barrel, so building eagerly would TDZ).
 */
let _extractorsCache: Partial<Record<Language, LanguageExtractor>> | null = null;
function buildExtractors(): Partial<Record<Language, LanguageExtractor>> {
  if (_extractorsCache) return _extractorsCache;
  const out: Partial<Record<Language, LanguageExtractor>> = {};
  for (const def of getLanguageDefs()) {
    if (def.grammar) {
      out[def.name as Language] = def.grammar.extractor;
    }
  }
  _extractorsCache = out;
  return out;
}

/**
 * Lazy Proxy keeps the existing `EXTRACTORS[lang]` access pattern
 * working without forcing the registry to evaluate at module load
 * (which would deadlock on the cyclic import chain through
 * tree-sitter.ts).
 */
export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = new Proxy(
  {} as Partial<Record<Language, LanguageExtractor>>,
  {
    get(_t, key: string) {
      return buildExtractors()[key as Language];
    },
    has(_t, key: string) {
      return key in buildExtractors();
    },
    ownKeys() {
      return Object.keys(buildExtractors());
    },
    getOwnPropertyDescriptor(_t, key: string) {
      const m = buildExtractors();
      if ((key as Language) in m) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: m[key as Language],
        };
      }
      return undefined;
    },
  },
);
