/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * Grammars are loaded lazily — only languages actually present in the
 * project are compiled, keeping V8 WASM memory pressure low on large
 * codebases.
 *
 * Re-adopted web-tree-sitter on 2026-05-17, reverting the 2026-05-11
 * native-bindings swap. The native runtime was faster per parse but
 * dragged in a whole distribution class of pain: per-platform `.node`
 * binaries, the `vendor/tree-sitter-natives/` tree, npm ERESOLVE peer
 * conflicts, and the `.npmrc` + `npm-shrinkwrap.json` band-aids. WASM
 * parse is ~1.9× slower per core, but cartograph's parse-worker pool
 * (auto-sized `cpus-1`) erases that in wall-clock.
 *
 * All per-language metadata (the `.wasm` filename, file extensions,
 * display names) lives in `./languages/<name>.ts` and is auto-collected
 * by `./languages/registry.ts`. The constants exported here
 * (`EXTENSION_MAP`, `getSupportedLanguages`, `getLanguageDisplayName`)
 * remain for backward compat but are derived from the registry.
 *
 * Grammar `.wasm` files live in `src/extraction/wasm/` and are copied
 * to `dist/extraction/wasm/` by `scripts/copy-assets.mjs` at build time.
 */

import { readFile } from 'node:fs/promises';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import type { Language } from '../types.js';
import { getLanguageDefs, getLanguageDefByExtension, getLanguageDefByName } from './languages/registry.js';
import { errMsg, logWarn } from '../errors.js';
import { resolveAssetPath } from '../assets.js';

/**
 * File extension → Language mapping, computed lazily on first read.
 *
 * Cannot be a top-level IIFE: the registry transitively pulls in
 * `tree-sitter.ts` (via custom-extractor language defs), which
 * imports this file — building the map at module load would TDZ
 * against `ALL_DEFS` in the registry. Use the `getExtensionMap()`
 * function for an explicit lazy entry point, or read
 * `EXTENSION_MAP` (a Proxy that materialises on first property
 * access).
 */
let _extensionMapCache: Record<string, Language> | null = null;
function getExtensionMap(): Record<string, Language> {
  if (_extensionMapCache) return _extensionMapCache;
  const out: Record<string, Language> = {};
  for (const def of getLanguageDefs()) {
    for (const ext of def.extensions) {
      out[ext.toLowerCase()] = def.name as Language;
    }
  }
  _extensionMapCache = out;
  return out;
}

/**
 * Backward-compat: a Proxy that lazy-builds the extension map on
 * first property access. Existing callers can keep doing
 * `EXTENSION_MAP['.ts']` without changes.
 */
export const EXTENSION_MAP: Record<string, Language> = new Proxy({} as Record<string, Language>, {
  get(_t, key: string) {
    return getExtensionMap()[key];
  },
  has(_t, key: string) {
    return key in getExtensionMap();
  },
  ownKeys() {
    return Object.keys(getExtensionMap());
  },
  getOwnPropertyDescriptor(_t, key: string) {
    const map = getExtensionMap();
    if (key in map) {
      return { configurable: true, enumerable: true, writable: false, value: map[key] };
    }
    return undefined;
  },
});

/**
 * Caches for loaded grammars and parsers.
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * Initialize the tree-sitter WASM runtime. Must be called before
 * loading grammars. Does NOT load any grammar WASM files — use
 * loadGrammarsForLanguages() for that. Idempotent.
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;
  await Parser.init({
    locateFile(scriptName: string, scriptDirectory: string) {
      if (scriptName === 'web-tree-sitter.wasm') return resolveAssetPath('web-tree-sitter.wasm');
      return `${scriptDirectory}${scriptName}`;
    },
  });
  parserInitialized = true;
}

/**
 * Load grammar WASM files for specific languages only. Skips languages
 * that are already loaded or have no WASM grammar. Runs initGrammars()
 * first if the runtime isn't up yet.
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  // Deduplicate; filter to languages that have a tree-sitter grammar
  // (registry's `def.grammar` field) and aren't already loaded.
  const seen = new Set<Language>();
  const toLoad: Array<{ lang: Language; wasmFile: string }> = [];
  for (const lang of languages) {
    if (seen.has(lang)) continue;
    seen.add(lang);
    if (languageCache.has(lang) || unavailableGrammarErrors.has(lang)) continue;
    const def = getLanguageDefByName(lang);
    if (!def?.grammar) continue;
    toLoad.push({ lang, wasmFile: def.grammar.wasmFile });
  }

  // Load grammars sequentially to avoid a web-tree-sitter WASM race
  // condition on Node 20+. See:
  // https://github.com/tree-sitter/tree-sitter/issues/2338
  for (const { lang, wasmFile } of toLoad) {
    try {
      const wasmPath = resolveAssetPath('extraction', 'wasm', wasmFile);
      const language = await WasmLanguage.load(await readFile(wasmPath));
      languageCache.set(lang, language);
    } catch (error) {
      const message = errMsg(error);
      logWarn(`Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * Load ALL grammar WASM files. Convenience function for tests and
 * backward compatibility. Prefer loadGrammarsForLanguages() in production.
 */
export async function loadAllGrammars(): Promise<void> {
  const allLanguages = getLanguageDefs()
    .filter((d) => d.grammar)
    .map((d) => d.name as Language);
  await loadGrammarsForLanguages(allLanguages);
}

/**
 * Get a parser for the specified language. Returns synchronously from
 * the pre-loaded cache. Caller must have called loadGrammarsForLanguages()
 * for the language first.
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }
  const lang = languageCache.get(language);
  if (!lang) {
    return null;
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

/**
 * Get the loaded web-tree-sitter `Language` (grammar) object for a
 * language, or null when its grammar hasn't been loaded. Needed by
 * query-driven extractors (`TagsQueryExtractor`) which construct a
 * `Query` — that requires the `Language` object directly, not the
 * `Parser`. `getParser` is the right call for plain parsing.
 */
export function getLanguageGrammar(language: Language): WasmLanguage | null {
  return languageCache.get(language) ?? null;
}

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string, source?: string): Language {
  if (isPlayRoutesFile(filePath)) return 'yaml';

  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const def = getLanguageDefByExtension(ext);
  const lang = (def?.name as Language) ?? 'unknown';

  // .h files could be C, C++, or Objective-C (F#65). Check source
  // content. ObjC wins when the file has `@interface` / `@implementation`
  // / `@protocol` / `@synthesize` declarations — those are unambiguous
  // ObjC syntax that's a hard parse error in both C and C++.
  // C++ check stays after the ObjC check for legacy reasons (existing
  // `.h` files that look like C++ but were extracted as C++ pre-F#65
  // shouldn't get reclassified just because they import an ObjC header).
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeObjc(source)) return 'objc';
    if (looksLikeCpp(source)) return 'cpp';
  }

  // .html (and .md) files that begin with a YAML front-matter block (`---\n…\n---`)
  // are Jekyll/Liquid templates. Detect by content so plain HTML files (no front
  // matter) continue to map to HTML and are not run through the Liquid
  // extractor. `.md` files that are already matched by a markdown-language def
  // are not reclassified; only `.html` (plus unmatched `.md`) files with front
  // matter are candidates.
  if (source && (lang === 'unknown' || lang === 'html' || lang === 'liquid') && hasYamlFrontMatter(source)) {
    if (ext === '.html' || ext === '.md') return 'liquid';
  }

  return lang;
}

/** Play Framework route declarations live in extensionless `conf/routes`
 *  files (and included `conf/*.routes` files). Treat only those well-known
 *  paths as indexable YAML so the Play framework resolver can extract the
 *  actual route nodes. */
export function isPlayRoutesFile(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  return /(^|\/)conf\/routes$/.test(normalized) || /(^|\/)conf\/[^/]+\.routes$/.test(normalized);
}

/**
 * Heuristic: does a file begin with a YAML front-matter block (`---\n…\n---`)?
 * Only inspects the first ~4KB to keep detection cheap. Requires the opening
 * `---` to be at position 0 (no leading whitespace or BOM) so we don't
 * misclassify HTML files that happen to contain `---` separators mid-document.
 */
function hasYamlFrontMatter(source: string): boolean {
  const sample = source.length > 4096 ? source.substring(0, 4096) : source;
  // Must start with `---` on the very first line, then have a closing `---` line.
  if (!sample.startsWith('---')) return false;
  const afterOpen = sample.indexOf('\n');
  if (afterOpen < 0) return false;
  // The rest of the sample must contain a closing `---` line somewhere
  // after the opening delimiter (Jekyll front matter always closes with
  // `---`, never the YAML `...` end-of-document marker).
  return /\n---\s*(\n|$)/.test(sample.substring(afterOpen));
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Checks the first ~8KB for patterns that are unique to C++ and never valid C.
 */
function looksLikeObjc(source: string): boolean {
  // ObjC-specific declarations that never appear in C or C++:
  // `@interface`, `@implementation`, `@protocol`, `@synthesize`.
  // First 8KB cap matches looksLikeCpp's policy — headers are usually
  // small and the @-form declarations always appear at top scope.
  const sample = source.length > 8192 ? source.substring(0, 8192) : source;
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(sample);
}

function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return (
    /\bnamespace\b/.test(sample) ||
    /\bclass\s+\w+\s*[:{]/.test(sample) ||
    /\btemplate\s*</.test(sample) ||
    /\b(?:public|private|protected)\s*:/.test(sample) ||
    /\bvirtual\b/.test(sample) ||
    /\busing\s+namespace\b/.test(sample) ||
    /\busing\s+\w+\s*=/.test(sample)
  );
}

/**
 * Check if a language is supported (has a grammar or custom extractor).
 * Returns true if a registry entry exists, even if its grammar isn't loaded.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'unknown') return false;
  return getLanguageDefByName(language) !== undefined;
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 * Custom-extractor languages (no `grammar` field) are always "ready".
 */
export function isGrammarLoaded(language: Language): boolean {
  const def = getLanguageDefByName(language);
  if (!def) return false;
  if (!def.grammar) return true; // custom extractor — always available
  return languageCache.has(language);
}

/**
 * Get all supported languages from the registry.
 */
export function getSupportedLanguages(): Language[] {
  return getLanguageDefs().map((d) => d.name as Language);
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory.
 * The tree-sitter WASM runtime accumulates fragmented memory over
 * thousands of parses. Deleting and recreating the Parser instance
 * forces the WASM heap to reset, preventing "memory access out of
 * bounds" crashes in large repos. `languageCache` is intentionally
 * kept — the next getParser() rebuilds a fresh Parser from it without
 * re-reading the `.wasm`.
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * Clear the per-language Parser cache (useful for testing).
 *
 * Note: `languageCache` and the `Parser.init()` runtime are
 * intentionally NOT cleared — the WASM `Language` modules are
 * expensive to load and stay cached so a subsequent `getParser` call
 * can rebuild a fresh `Parser` instance without re-reading the .wasm
 * file. There is deliberately no full-reset entry point: nothing in
 * the codebase needs to tear the WASM runtime down, and a test that
 * truly wants a clean slate re-imports the module.
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    try {
      parser.delete();
    } catch {
      /* ignore */
    }
  }
  parserCache.clear();
  unavailableGrammarErrors.clear();
}

/**
 * Snapshot of recorded grammar-load errors keyed by language. Used
 * by status / diagnostic surfaces to explain why a file's language
 * is unsupported at parse time. Empty when every requested grammar
 * loaded cleanly.
 */
export function getUnavailableGrammarErrors(): Record<string, string> {
  return Object.fromEntries(unavailableGrammarErrors);
}

/**
 * Get the display name for a language from the registry.
 */
export function getLanguageDisplayName(language: Language): string {
  const def = getLanguageDefByName(language);
  return def?.displayName ?? language;
}
