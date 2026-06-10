/**
 * Loaded-grammar / parser cache — the registry-free leaf of the grammar
 * subsystem.
 *
 * Extracted from `grammars.ts` to break a runtime import cycle: standalone
 * extractors need `getParser` / `getLanguageGrammar`, but importing those
 * from `grammars.ts` pulled in `grammars.ts → languages/registry.ts →
 * (language defs) → extractor classes → grammars.ts`. This module imports
 * only web-tree-sitter + the `Language` type, so `extractor → grammar-cache`
 * is a clean DAG edge. `grammars.ts` owns the WASM LOADING (it needs the
 * registry) and writes into this cache via the setters below; it re-exports
 * the readers for back-compat.
 */

import { Parser, type Language as WasmLanguage } from 'web-tree-sitter';
import type { Language } from '../types.js';

const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

/** Record a successfully-loaded WASM grammar. Called by grammars.ts. */
export function setLoadedGrammar(language: Language, grammar: WasmLanguage): void {
  languageCache.set(language, grammar);
}

/** Record that a grammar failed to load (so we don't retry it). */
export function markGrammarUnavailable(language: Language, message: string): void {
  unavailableGrammarErrors.set(language, message);
}

/** True when the grammar is loaded OR already known-unavailable (skip it). */
export function isGrammarKnown(language: Language): boolean {
  return languageCache.has(language) || unavailableGrammarErrors.has(language);
}

/** True when the grammar's WASM `Language` is loaded. */
export function hasLoadedGrammar(language: Language): boolean {
  return languageCache.has(language);
}

/** Snapshot of recorded grammar-load errors keyed by language. */
export function getUnavailableGrammarErrors(): Record<string, string> {
  return Object.fromEntries(unavailableGrammarErrors);
}

/**
 * Get a parser for the specified language. Returns synchronously from the
 * pre-loaded cache. Caller must have loaded the grammar first.
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
 * Get the loaded web-tree-sitter `Language` (grammar) object, or null when
 * its grammar hasn't been loaded. Needed by query-driven extractors
 * (`TagsQueryExtractor`) which construct a `Query` from the `Language`.
 */
export function getLanguageGrammar(language: Language): WasmLanguage | null {
  return languageCache.get(language) ?? null;
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory. The
 * tree-sitter WASM runtime fragments over thousands of parses; deleting and
 * recreating the Parser forces the heap to reset, preventing "memory access
 * out of bounds" crashes. `languageCache` is intentionally kept — the next
 * getParser() rebuilds a fresh Parser from it without re-reading the .wasm.
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * Clear the per-language Parser cache (useful for testing). `languageCache`
 * and the `Parser.init()` runtime are intentionally NOT cleared — the WASM
 * `Language` modules are expensive to load and stay cached so a subsequent
 * `getParser` can rebuild a fresh `Parser` without re-reading the .wasm.
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
