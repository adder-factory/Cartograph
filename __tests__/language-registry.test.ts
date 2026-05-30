/**
 * Language registry: structural invariants.
 *
 * These tests guard against the "parallel list" failure mode that
 * the registry refactor exists to prevent. If a future PR adds a
 * grammar-backed language but forgets to wire it through one of
 * the derived consumers, one of these tests should catch it.
 */
import { describe, it, expect } from 'vitest';
import {
  getLanguageDefs,
  getLanguageDefByExtension,
  getLanguageDefByName,
} from '../src/extraction/languages/registry.js';
import { EXTRACTORS } from '../src/extraction/languages/index.js';
import {
  detectLanguage,
  isLanguageSupported,
  getSupportedLanguages,
  getLanguageDisplayName,
  EXTENSION_MAP,
} from '../src/extraction/grammars.js';

describe('language registry — single source of truth', () => {
  it('has at least the original 19 languages', () => {
    const defs = getLanguageDefs();
    expect(defs.length).toBeGreaterThanOrEqual(19);
  });

  it('every def includeGlob covers every declared extension (FRICTION-10 drift guard)', () => {
    // EXTENSION_MAP is built from `extensions`; the file-walk include
    // set is built from `includeGlobs`. If the two drift, files of the
    // missing extension get a language but are never walked — exactly
    // the bug that hid every `.mjs` file from the index.
    for (const def of getLanguageDefs()) {
      for (const ext of def.extensions) {
        const covered = def.includeGlobs.some((g) => g.endsWith(ext));
        expect(covered, `${def.name}: includeGlobs missing a glob for "${ext}"`).toBe(true);
      }
    }
  });

  it('every def has unique non-empty name', () => {
    const names = new Set<string>();
    for (const def of getLanguageDefs()) {
      expect(def.name).toBeTruthy();
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
    }
  });

  it('extensions are unique across registry (one ext maps to one language)', () => {
    const seen = new Map<string, string>();
    for (const def of getLanguageDefs()) {
      for (const ext of def.extensions) {
        const lower = ext.toLowerCase();
        if (seen.has(lower)) {
          // The .h ambiguity (C vs C++) is intentionally pinned to C
          // by the registry; tree-sitter.ts has a content-sniff
          // override. Anything else duplicating extensions is a bug.
          throw new Error(`Extension ${lower} mapped twice: ${seen.get(lower)} and ${def.name}`);
        }
        seen.set(lower, def.name);
      }
    }
  });

  it('grammar-backed defs have wasmFile + extractor', () => {
    // cartograph parses with web-tree-sitter (WASM). Each grammar-backed
    // def names a `.wasm` file resolved against `src/extraction/wasm/`.
    // (The 2026-05-11 native swap briefly replaced this with an
    // `npmPackage` string + optional `.node` vendoring; reverted
    // 2026-05-17 to drop the native-binary distribution.)
    for (const def of getLanguageDefs()) {
      if (!def.grammar) continue;
      expect(def.grammar.wasmFile).toMatch(/^[a-z_]+\.wasm$/);
      expect(def.grammar.extractor).toBeDefined();
    }
  });

  it('custom-extractor defs have a customExtractor function', () => {
    for (const def of getLanguageDefs()) {
      if (def.grammar) continue; // grammar-backed
      expect(def.customExtractor).toBeInstanceOf(Function);
    }
  });
});

describe('derived consumers stay in sync with the registry', () => {
  // Catch the "parallel list drift" bug that motivated this refactor.
  // If a new language gets added to registry but a derived consumer
  // still hard-codes the old set, one of these will fail.

  it('EXTRACTORS contains exactly the grammar-backed languages', () => {
    const grammarBacked = getLanguageDefs()
      .filter((d) => d.grammar)
      .map((d) => d.name)
      .sort();
    const extractorKeys = Object.keys(EXTRACTORS).sort();
    expect(extractorKeys).toEqual(grammarBacked);
  });

  it('every grammar-backed extractor matches def.grammar.extractor exactly', () => {
    for (const def of getLanguageDefs()) {
      if (!def.grammar) continue;
      expect(EXTRACTORS[def.name as keyof typeof EXTRACTORS]).toBe(def.grammar.extractor);
    }
  });

  it('EXTENSION_MAP entries exactly mirror registry extensions', () => {
    const expected = new Map<string, string>();
    for (const def of getLanguageDefs()) {
      for (const ext of def.extensions) {
        expected.set(ext.toLowerCase(), def.name);
      }
    }
    for (const [ext, lang] of expected) {
      expect(EXTENSION_MAP[ext]).toBe(lang);
    }
    // Reverse: no extra keys in EXTENSION_MAP.
    expect(Object.keys(EXTENSION_MAP).sort()).toEqual([...expected.keys()].sort());
  });

  it('detectLanguage returns the expected name for every registered extension', () => {
    for (const def of getLanguageDefs()) {
      for (const ext of def.extensions) {
        // .h is pinned to C by the registry; the C++ heuristic only
        // applies when source is provided AND looks like C++.
        expect(detectLanguage(`x${ext}`)).toBe(def.name);
      }
    }
  });

  it('isLanguageSupported returns true for every registered language and false for unknown', () => {
    for (const def of getLanguageDefs()) {
      expect(isLanguageSupported(def.name as never)).toBe(true);
    }
    expect(isLanguageSupported('unknown' as never)).toBe(false);
  });

  it('getSupportedLanguages returns exactly the registry names', () => {
    const fromRegistry = getLanguageDefs()
      .map((d) => d.name)
      .sort();
    const supported = (getSupportedLanguages() as string[]).sort();
    expect(supported).toEqual(fromRegistry);
  });

  it('getLanguageDisplayName uses each defs displayName', () => {
    for (const def of getLanguageDefs()) {
      expect(getLanguageDisplayName(def.name as never)).toBe(def.displayName);
    }
  });
});

describe('lookup helpers', () => {
  it('getLanguageDefByName returns the def for a registered name', () => {
    expect(getLanguageDefByName('typescript')?.displayName).toBe('TypeScript');
  });

  it('getLanguageDefByName returns undefined for unknown names', () => {
    expect(getLanguageDefByName('nonexistent-language-name')).toBeUndefined();
  });

  it('getLanguageDefByExtension is case-insensitive', () => {
    expect(getLanguageDefByExtension('.TS')?.name).toBe('typescript');
    expect(getLanguageDefByExtension('.ts')?.name).toBe('typescript');
  });

  it('Pascal extensionOverrides routes .dfm and .fmx to a customExtractor', () => {
    const def = getLanguageDefByName('pascal');
    expect(def?.extensionOverrides?.['.dfm']?.customExtractor).toBeInstanceOf(Function);
    expect(def?.extensionOverrides?.['.fmx']?.customExtractor).toBeInstanceOf(Function);
  });

  it('TypeScript registers .ts, .mts, and .cts (parity with JS .js/.mjs/.cjs)', () => {
    // Caught 2026-05-21 when bench/*.mts files were silently dropped
    // from extraction. The TS extractor handles all three identically;
    // dropping any extension here means files-on-disk vanish from the
    // index. JavaScript carries the matching .js/.mjs/.cjs triplet.
    const def = getLanguageDefByName('typescript');
    expect(def?.extensions).toEqual(expect.arrayContaining(['.ts', '.mts', '.cts']));
    expect(getLanguageDefByExtension('.mts')?.name).toBe('typescript');
    expect(getLanguageDefByExtension('.cts')?.name).toBe('typescript');
  });
});
