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
 *   - honours `compilerOptions.baseUrl` and `compilerOptions.paths`
 *   - follows `extends` chains for shared alias config
 *   - supports `*` wildcard (the only TS-supported wildcard)
 *   - does NOT read Vite/webpack/Rollup configs (separate follow-up)
 *
 * The file is parsed as JSON-with-comments-tolerant — tsconfigs in the
 * wild routinely contain `//` and `/* *\/` comments and trailing
 * commas, which JSON.parse rejects. We strip those before parsing.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { logDebug } from '../errors.js';

const MAX_EXTENDS_DEPTH = 8;

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
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

interface ResolvedTsconfigAliases {
  usedFile: string;
  chain: string[];
  baseUrl: string;
  paths?: Record<string, unknown>;
}

interface TsconfigResolveContext {
  projectRoot: string;
  seen: Set<string>;
  depth: number;
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

  if (!found.paths || typeof found.paths !== 'object') {
    // baseUrl alone isn't an "alias" per se; with no paths we'd just
    // be redirecting the whole tree. Skip — the existing resolver
    // already handles relative imports.
    return null;
  }

  const patterns = buildAliasPatterns(found.paths);
  if (patterns.length === 0) return null;

  // Specificity sort: longer prefix first; literal patterns before
  // wildcard patterns of the same prefix length. TypeScript itself
  // uses a similar "most specific match wins" rule.
  patterns.sort(compareAliasSpecificity);

  logDebug('path-aliases loaded', {
    file: found.usedFile,
    chain: found.chain,
    baseUrl: found.baseUrl,
    patternCount: patterns.length,
  });

  return { baseUrl: found.baseUrl, patterns };
}

/**
 * Semantic fingerprint for the alias inputs the resolver actually uses.
 *
 * Mirrors {@link loadProjectAliases}: first parsed `tsconfig.json`, then
 * `jsconfig.json`; only `compilerOptions.baseUrl` and `paths` matter. This
 * deliberately ignores JSONC comments, whitespace, unrelated compiler options,
 * and raw object insertion order so harmless config formatting does not queue a
 * project-wide JS/TS re-extract.
 */
export function projectAliasConfigFingerprint(projectRoot: string): string {
  const found = findFirstTsconfigLike(projectRoot);
  if (!found) return 'alias:none';
  const paths = found.paths && typeof found.paths === 'object' ? normalizePathsForFingerprint(found.paths) : null;
  if (!paths || Object.keys(paths).length === 0) return 'alias:none';
  return JSON.stringify({
    baseUrl: normalizeBaseUrlForFingerprint(projectRoot, found.baseUrl),
    paths,
  });
}

/** Probe `tsconfig.json` then `jsconfig.json` and return the first that parses. */
function findFirstTsconfigLike(projectRoot: string): ResolvedTsconfigAliases | null {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    const resolved = resolveTsconfigAliases(p, { projectRoot, seen: new Set(), depth: 0 });
    if (resolved) return { ...resolved, usedFile: name };
  }
  return null;
}

function resolveTsconfigAliases(
  filePath: string,
  ctx: TsconfigResolveContext,
): Omit<ResolvedTsconfigAliases, 'usedFile'> | null {
  const normalizedPath = path.resolve(filePath);
  if (ctx.seen.has(normalizedPath) || ctx.depth > MAX_EXTENDS_DEPTH) return null;

  const raw = readTsconfigLike(normalizedPath);
  if (!raw) return null;

  const nextCtx: TsconfigResolveContext = {
    projectRoot: ctx.projectRoot,
    seen: new Set(ctx.seen).add(normalizedPath),
    depth: ctx.depth + 1,
  };

  const inherited = resolveExtendedAliases(raw.extends, normalizedPath, nextCtx);
  const configDir = path.dirname(normalizedPath);
  const co = raw.compilerOptions ?? {};
  const inheritedBaseUrl = inherited?.baseUrl ?? configDir;
  const baseUrl = typeof co.baseUrl === 'string' ? path.resolve(configDir, co.baseUrl) : inheritedBaseUrl;
  const paths = co.paths && typeof co.paths === 'object' ? co.paths : inherited?.paths;

  const resolved: Omit<ResolvedTsconfigAliases, 'usedFile'> = {
    chain: [...(inherited?.chain ?? []), normalizeConfigPath(ctx.projectRoot, normalizedPath)],
    baseUrl,
  };
  if (paths !== undefined) resolved.paths = paths;
  return resolved;
}

function resolveExtendedAliases(
  extendsValue: string | undefined,
  filePath: string,
  ctx: TsconfigResolveContext,
): Omit<ResolvedTsconfigAliases, 'usedFile'> | null {
  if (!extendsValue || typeof extendsValue !== 'string') return null;
  const extendedPath = resolveExtendsPath(extendsValue, path.dirname(filePath));
  if (!extendedPath) return null;
  return resolveTsconfigAliases(extendedPath, ctx);
}

function resolveExtendsPath(extendsValue: string, fromDir: string): string | null {
  const raw = extendsValue.trim();
  if (!raw) return null;
  if (raw.startsWith('.') || path.isAbsolute(raw)) return resolveTsconfigCandidate(path.resolve(fromDir, raw));

  const requireFromConfig = createRequire(path.join(fromDir, 'tsconfig.json'));
  for (const specifier of [raw, `${raw}/tsconfig.json`]) {
    try {
      return requireFromConfig.resolve(specifier);
    } catch {
      // Try the next package-style shape.
    }
  }
  return null;
}

function resolveTsconfigCandidate(candidate: string): string | null {
  for (const filePath of [candidate, `${candidate}.json`, path.join(candidate, 'tsconfig.json')]) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function normalizeConfigPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath).replaceAll('\\', '/');
  return relative === '' ? path.basename(filePath) : relative;
}

function normalizePathsForFingerprint(paths: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(paths).sort((a, b) => a.localeCompare(b))) {
    const targets = paths[key];
    if (!Array.isArray(targets)) continue;
    const filtered = targets
      .filter((target): target is string => typeof target === 'string')
      .map(normalizeAliasTargetForFingerprint);
    if (filtered.length > 0) out[key] = filtered;
  }
  return out;
}

function normalizeBaseUrlForFingerprint(projectRoot: string, baseUrl: string): string {
  const relative = path.relative(projectRoot, baseUrl).replaceAll('\\', '/');
  return relative === '' ? '.' : relative;
}

function normalizeAliasTargetForFingerprint(target: string): string {
  return path.posix.normalize(target.replaceAll('\\', '/'));
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
    return expandAliasPattern({ pat, captured, aliases, projectRoot });
  }
  return [];
}

function captureAliasWildcard(importPath: string, pat: AliasPattern): string | null {
  if (!importPath.startsWith(pat.prefix)) return null;
  if (pat.suffix && !importPath.endsWith(pat.suffix)) return null;
  if (pat.hasWildcard) return importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
  return importPath === pat.prefix ? '' : null;
}

function expandAliasPattern(args: {
  pat: AliasPattern;
  captured: string;
  aliases: AliasMap;
  projectRoot: string;
}): string[] {
  const { pat, captured, aliases, projectRoot } = args;
  const out: string[] = [];
  for (const target of pat.replacements) {
    const filled = pat.hasWildcard ? target.replace('*', captured) : target;
    const relative = path.relative(projectRoot, path.resolve(aliases.baseUrl, filled));
    if (relative.startsWith('..')) continue;
    out.push(relative.replaceAll('\\', '/'));
  }
  return out;
}
