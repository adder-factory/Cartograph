/**
 * Project-level import-path alias loading.
 *
 * Reads `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json`
 * at the project root and converts the patterns into a form the
 * import-resolver can consult.
 *
 * This is the single biggest blocker to accurate resolution on modern
 * JS/TS codebases: aliases like `@/components/Foo` (Next, Nuxt, Nest,
 * Vite scaffolds) point into a `paths` map the resolver previously
 * ignored — every import through an alias was treated as unresolvable
 * unless it happened to match the small hard-coded fallback list.
 *
 * Scope deliberately small for v1:
 *   - reads tsconfig.json, then jsconfig.json
 *   - honours top-level `compilerOptions.baseUrl` and `compilerOptions.paths`
 *   - supports `*` wildcard (the only TS-supported wildcard)
 *   - does NOT follow `extends` chains yet (most projects don't need it)
 *   - does NOT read Vite/webpack/Rollup configs (separate follow-up)
 *
 * The file is parsed as JSON-with-comments-tolerant — tsconfigs in the
 * wild routinely contain `//` and `/* *\/` comments and trailing
 * commas, which JSON.parse rejects. We strip those before parsing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logDebug } from '../errors.js';

/** A single alias pattern from `compilerOptions.paths`. */
interface AliasPattern {
  /** The literal prefix before `*` (or the whole pattern if no `*`). */
  prefix: string;
  /** The literal suffix after `*` (almost always empty). */
  suffix: string;
  /** Whether the pattern contains a `*` wildcard. */
  hasWildcard: boolean;
  /**
   * Replacement templates. When `hasWildcard` is true, `*` in the
   * replacement is filled with the captured wildcard portion of the
   * import path. Stored relative to {@link AliasMap.baseUrl}.
   * tsconfig allows multiple targets per alias (priority order).
   */
  replacements: string[];
}

export interface AliasMap {
  /** Absolute path. The directory `compilerOptions.paths` is rooted at. */
  baseUrl: string;
  /**
   * Patterns ordered by specificity: longer prefix first, then literal-
   * before-wildcard, so the resolver tries the most-specific match.
   */
  patterns: AliasPattern[];
}

/**
 * Skip a single-line comment starting at position i.
 * Returns the position after the newline or end of string.
 */
function skipSingleLineComment(src: string, i: number): number {
  while (i < src.length && src[i] !== '\n') i++;
  return i;
}

/**
 * Skip a block comment starting at position i.
 * Returns the position after the block comment or end of string.
 * @internal
 */
function skipBlockComment(src: string, i: number): number {
  i += 2; // Skip past the opening
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
  return i + 2; // Skip past the closing
}

/**
 * Strip JSONC comments + trailing commas so a tsconfig with the usual
 * VS Code-style annotations parses cleanly. Walks the source as a
 * tiny state machine that tracks string context — the previous
 * regex-only version corrupted any URL inside a string value
 * (`"baseUrl": "https://cdn.example.com"` had everything after `//`
 * truncated).
 */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < src.length) {
    const ch = src[i]!;

    if (inString) {
      const next = consumeJsonStringChar(src, i, out);
      out = next.out;
      inString = next.inString;
      i = next.nextIndex;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && src[i + 1] === '/') {
      i = skipSingleLineComment(src, i);
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      i = skipBlockComment(src, i);
      continue;
    }

    out += ch;
    i++;
  }

  // Trailing commas before } or ] — outside strings, so safe to
  // run on the comment-stripped output.
  return out.replaceAll(/,(\s*[}\]])/g, '$1');
}

function consumeJsonStringChar(
  src: string,
  i: number,
  out: string,
): { out: string; inString: boolean; nextIndex: number } {
  const ch = src[i]!;
  let nextOut = out + ch;
  if (ch === '\\' && i + 1 < src.length) {
    nextOut += src[i + 1]!;
    return { out: nextOut, inString: true, nextIndex: i + 2 };
  }
  return { out: nextOut, inString: ch !== '"', nextIndex: i + 1 };
}

interface RawTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readTsconfigLike(filePath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logDebug('path-aliases: failed to parse', { filePath, err: String(err) });
    return null;
  }
}

function splitWildcard(pattern: string): {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
} {
  const star = pattern.indexOf('*');
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false };
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    hasWildcard: true,
  };
}

/**
 * Load aliases for `projectRoot`. Returns `null` when no tsconfig /
 * jsconfig is present or when the file has no usable `paths`.
 *
 * Cheap to call repeatedly — caching is the caller's job (the
 * resolver does it via {@link aliasCache}).
 */
export function loadProjectAliases(projectRoot: string): AliasMap | null {
  const found = findFirstTsconfigLike(projectRoot);
  if (!found) return null;
  const { raw, usedFile } = found;

  const co = raw.compilerOptions ?? {};
  const baseUrl = path.resolve(projectRoot, co.baseUrl ?? '.');

  const paths = co.paths;
  if (!paths || typeof paths !== 'object') {
    // baseUrl alone isn't an "alias" per se; with no paths we'd just
    // be redirecting the whole tree. Skip — the existing resolver
    // already handles relative imports.
    return null;
  }

  const patterns = buildAliasPatterns(paths);
  if (patterns.length === 0) return null;

  // Specificity sort: longer prefix first; literal patterns before
  // wildcard patterns of the same prefix length. TypeScript itself
  // uses a similar "most specific match wins" rule.
  patterns.sort(compareAliasSpecificity);

  logDebug('path-aliases loaded', {
    file: usedFile,
    baseUrl,
    patternCount: patterns.length,
  });

  return { baseUrl, patterns };
}

/** Probe `tsconfig.json` then `jsconfig.json` and return the first that parses. */
function findFirstTsconfigLike(projectRoot: string): { raw: RawTsconfig; usedFile: string } | null {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    const raw = readTsconfigLike(p);
    if (raw) return { raw, usedFile: name };
  }
  return null;
}

/** Convert the `compilerOptions.paths` map into a list of {@link AliasPattern}. */
function buildAliasPatterns(paths: Record<string, unknown>): AliasPattern[] {
  const patterns: AliasPattern[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const filtered = targets.filter((t): t is string => typeof t === 'string');
    if (filtered.length === 0) continue;
    const { prefix, suffix, hasWildcard } = splitWildcard(pattern);
    patterns.push({ prefix, suffix, hasWildcard, replacements: filtered });
  }
  return patterns;
}

/** Comparator: longer prefix first; literal patterns before wildcards of equal length. */
function compareAliasSpecificity(a: AliasPattern, b: AliasPattern): number {
  if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
  if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
  return 0;
}

/**
 * Resolve an import path through an {@link AliasMap}. Returns the list
 * of candidate filesystem paths (relative to `projectRoot`), in the
 * priority order defined by tsconfig (multiple replacements per alias
 * are tried in order). Returns `[]` when no alias matches.
 *
 * Callers still need to try each candidate with the language's
 * extension list — this function only does the alias rewrite.
 */
export function applyAliases(importPath: string, aliases: AliasMap, projectRoot: string): string[] {
  for (const pat of aliases.patterns) {
    const captured = captureAliasWildcard(importPath, pat);
    if (captured === null) continue;
    return expandAliasPattern(pat, captured, aliases, projectRoot);
  }
  return [];
}

function captureAliasWildcard(importPath: string, pat: AliasPattern): string | null {
  if (!importPath.startsWith(pat.prefix)) return null;
  if (pat.suffix && !importPath.endsWith(pat.suffix)) return null;
  if (pat.hasWildcard) return importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
  return importPath === pat.prefix ? '' : null;
}

function expandAliasPattern(pat: AliasPattern, captured: string, aliases: AliasMap, projectRoot: string): string[] {
  const out: string[] = [];
  for (const target of pat.replacements) {
    const filled = pat.hasWildcard ? target.replace('*', captured) : target;
    const relative = path.relative(projectRoot, path.resolve(aliases.baseUrl, filled));
    if (relative.startsWith('..')) continue;
    out.push(relative.replaceAll('\\', '/'));
  }
  return out;
}
