/**
 * Classify an import-statement's resolution kind for `cartograph_imports`.
 *
 * "Resolution kind" is one of:
 *   - 'file'         — relative spec resolves to a real file on disk
 *                      (with any of the language's extensions, or none).
 *   - 'directory'    — relative spec resolves to a directory containing
 *                      an index.{ts,tsx,js,jsx,mjs,cjs} entry, OR is a
 *                      directory itself (older bundler convention). Also
 *                      a Go intra-module spec that re-anchors to a local
 *                      directory when `opts.goModuleAlias` is provided.
 *   - 'bare'         — non-relative specifier (`fs`, `react`, `@scope/x`).
 *                      When `opts.goModuleAlias` is set, Go specs that
 *                      match the alias get re-anchored to the project
 *                      root instead and report 'directory' / 'unresolvable'.
 *   - 'unresolvable' — relative spec (or a Go intra-module spec when an
 *                      alias is set) that doesn't resolve to a file or
 *                      directory under the project root.
 *
 * Cheap and self-contained: uses `fs.existsSync` + `fs.statSync` rather
 * than the full ReferenceResolver. Suitable for a per-call query
 * surface; for ~1000 import nodes it runs in well under a second.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { asJsonObject, type JsonObject } from './json-object.js';
import { fileExists } from './utils.js';

type ResolutionKind = 'file' | 'directory' | 'bare' | 'unresolvable';

interface ImportClassification {
  kind: ResolutionKind;
  /** True when relative AND the specifier has no file extension. */
  extMissing: boolean;
  /**
   * Absolute path of the resolved target. Set when `kind` is 'file' or
   * 'directory' (and a directory has an `index.<ext>` entry); absent
   * for 'bare' / 'unresolvable'. Lets callers skip re-doing the
   * resolution work the classifier already did.
   */
  resolvedFile?: string;
}

const EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.php',
  '.rb',
  '.dart',
  '.swift',
];

/**
 * NodeNext / ESM convention: `import x from './foo.js'` where the
 * source on disk is `foo.ts` (or `.tsx` / `.d.ts`). Try the TS sibling
 * before falling through to extension permutations.
 */
const JS_TO_TS_REWRITES: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/\.js$/, ['.ts', '.tsx', '.d.ts']],
  [/\.jsx$/, ['.tsx']],
  [/\.mjs$/, ['.mts']],
  [/\.cjs$/, ['.cts']],
];

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Has a file extension on the LAST path segment? Excludes ambiguous
 * cases like `./my.config` (looks like an extension but might be a
 * basename-only file). Conservative: only flags the canonical
 * extensions in EXTENSIONS as "has extension."
 */
function hasKnownExtension(spec: string): boolean {
  const last = spec.split('/').pop() ?? spec;
  for (const ext of EXTENSIONS) {
    if (last.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Direct file hit: spec already has an extension matching a file on disk.
 * Returns the classification when resolved, undefined when not matched.
 */
function resolveDirectFileHit(resolvedBase: string, extMissing: boolean): ImportClassification | undefined {
  if (fileExists(resolvedBase)) {
    return { kind: 'file', extMissing, resolvedFile: resolvedBase };
  }
  return undefined;
}

/**
 * ESM rewrite: spec carries a JS-family extension but the source is TS.
 * NodeNext / ESM convention: `import x from './foo.js'` where the source on
 * disk is `foo.ts` (or `.tsx` / `.d.ts`). Tries each rewrite before falling
 * through.
 * Returns the classification when resolved, undefined when not matched.
 */
function resolveEsmRewrite(resolvedBase: string, extMissing: boolean): ImportClassification | undefined {
  for (const [pattern, exts] of JS_TO_TS_REWRITES) {
    const m = pattern.exec(resolvedBase);
    if (!m) continue;
    const stem = resolvedBase.slice(0, -m[0].length);
    for (const ext of exts) {
      const candidate = stem + ext;
      if (fileExists(candidate)) {
        return { kind: 'file', extMissing, resolvedFile: candidate };
      }
    }
  }
  return undefined;
}

/**
 * Extension permutation: try appending each known extension to the base path.
 * Handles extension-less specs such as `./foo` where the disk file is
 * `foo.ts`.
 * Returns the classification when resolved, undefined when not matched.
 */
function resolveExtensionPermutation(resolvedBase: string, extMissing: boolean): ImportClassification | undefined {
  for (const ext of EXTENSIONS) {
    const candidate = resolvedBase + ext;
    if (fileExists(candidate)) {
      return { kind: 'file', extMissing, resolvedFile: candidate };
    }
  }
  return undefined;
}

/**
 * Directory target: probe `<dir>/index.<ext>` so `resolvedFile` is the
 * actual entry, not the dir. Both "has index file" and "bare directory"
 * (older bundler convention) report `kind='directory'`; `resolvedFile` is
 * set only when an index file is found.
 * Returns the classification when the base path is a directory, undefined
 * when it isn't a directory at all.
 */
function resolveDirectoryTarget(resolvedBase: string, extMissing: boolean): ImportClassification | undefined {
  if (!dirExists(resolvedBase)) return undefined;
  for (const ext of EXTENSIONS) {
    const idx = path.join(resolvedBase, `index${ext}`);
    if (fileExists(idx)) {
      return { kind: 'directory', extMissing, resolvedFile: idx };
    }
  }
  return { kind: 'directory', extMissing };
}

interface ClassifyImportOpts {
  /**
   * Go module alias declared in the project's `go.mod` (e.g.
   * `github.com/ollama/ollama`). When set, non-relative specs that
   * start with this alias get re-anchored against `projectRootAbs`
   * — `github.com/ollama/ollama/api` resolves to `<root>/api/`
   * rather than falling through to `bare`. Without this, every
   * intra-module Go import looks like an external dependency.
   */
  goModuleAlias?: string;
  /**
   * C/C++ include style for this spec. The preprocessor distinguishes
   * `#include "header.h"` (quoted: nearest-directory first, then
   * include path) from `#include <system.h>` (angled: include path
   * only). Set `'quoted'` to enable a sibling-directory file probe
   * for the spec; `'angled'` (or unset) preserves the current bare
   * behavior. Caller derives the style from the import node's signature.
   */
  cIncludeStyle?: 'quoted' | 'angled';
  /**
   * TypeScript path-alias map derived from the nearest tsconfig.json
   * (`compilerOptions.paths` + `baseUrl`). When set, non-relative
   * specs that match an alias get re-anchored against the resolved
   * substitution path — `@/contexts/Foo` with `paths: {"@/*": ["src/*"]}`
   * and baseUrl=`<projectRoot>` resolves to `<projectRoot>/src/contexts/Foo`.
   * Without this, every aliased import looks like an external dep.
   * Caller is responsible for resolving the nearest tsconfig per file
   * (with caching); the classifier is pure.
   */
  tsPathAliases?: TsPathAliases;
}

/**
 * Resolved TypeScript path-alias map. `baseUrl` is absolute; each
 * `paths` value is an array of substitution patterns (also relative
 * to baseUrl per tsconfig spec).
 */
export interface TsPathAliases {
  baseUrl: string;
  paths: Record<string, string[]>;
}

const tsPathSubstitutionsSchema = z.array(z.string());
const tsPathMapSchema = z.unknown().transform(normalizeTsPathMap);

const tsconfigBaseUrlSchema = z.string().optional();
const tsconfigPathsFieldSchema = tsPathMapSchema.optional();
const tsconfigCompilerOptionsSchema = z.looseObject({
  baseUrl: tsconfigBaseUrlSchema,
  paths: tsconfigPathsFieldSchema,
});
const tsconfigAliasesSchema = z.looseObject({
  compilerOptions: tsconfigCompilerOptionsSchema.optional(),
});

type TsconfigAliasesConfig = z.infer<typeof tsconfigAliasesSchema>;

function normalizeTsPathMap(value: unknown): Record<string, string[]> {
  const map = asJsonObject(value);
  const out: Record<string, string[]> = {};
  Object.setPrototypeOf(out, null);
  if (!map) return out;

  for (const [pattern, substitutions] of Object.entries(map)) {
    const parsed = tsPathSubstitutionsSchema.safeParse(substitutions);
    if (parsed.success && parsed.data.length > 0) out[pattern] = parsed.data;
  }
  return out;
}

/**
 * Try to resolve a non-relative spec against a tsconfig paths map.
 * Returns null when no alias matches; otherwise returns the resolved
 * classification (file / directory / unresolvable).
 *
 * Alias matching follows the tsconfig spec:
 *   - exact alias key without `*` matches the spec exactly.
 *   - alias key with one `*` matches a spec whose prefix matches up
 *     to the `*`; the captured tail substitutes into each value's `*`.
 *
 * Each value in the alias array is tried in order; the first existing
 * file or directory wins.
 */
function resolveTsPathAlias(spec: string, aliases: TsPathAliases): ImportClassification | null {
  for (const [pattern, substitutions] of Object.entries(aliases.paths)) {
    const tail = matchTsPathAliasTail(spec, pattern);
    if (tail === null) continue;
    for (const sub of substitutions) {
      const resolvedBase = path.resolve(aliases.baseUrl, substituteTsPathAlias(sub, tail));
      // TS aliases typically point at file-like targets; try the same
      // resolution cascade as relative specs (direct hit → JS↔TS rewrite
      // → extension permutation → directory with index).
      const hit =
        resolveDirectFileHit(resolvedBase, false) ??
        resolveEsmRewrite(resolvedBase, false) ??
        resolveExtensionPermutation(resolvedBase, false) ??
        resolveDirectoryTarget(resolvedBase, false);
      if (hit) return hit;
    }
  }
  return null;
}

function matchTsPathAliasTail(spec: string, pattern: string): string | null {
  const wildcardIdx = pattern.indexOf('*');
  if (wildcardIdx === -1) return spec === pattern ? '' : null;
  const prefix = pattern.slice(0, wildcardIdx);
  const suffix = pattern.slice(wildcardIdx + 1);
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

function substituteTsPathAlias(substitution: string, tail: string): string {
  const subWildcardIdx = substitution.indexOf('*');
  if (subWildcardIdx === -1) return substitution;
  return substitution.slice(0, subWildcardIdx) + tail + substitution.slice(subWildcardIdx + 1);
}

/**
 * Classify an import specifier from a given source file.
 *
 *   importingFileAbs: absolute path of the file containing the import.
 *   spec: the verbatim moduleName from the import statement.
 *   projectRootAbs: absolute project root (for sanity bounds).
 *   opts: optional per-language helpers (see {@link ClassifyImportOpts}).
 */
export interface ClassifyImportArgs {
  importingFileAbs: string;
  spec: string;
  projectRootAbs: string;
  opts?: ClassifyImportOpts;
}

export function classifyImport(args: ClassifyImportArgs): ImportClassification {
  const { importingFileAbs, spec, projectRootAbs } = args;
  const opts = args.opts ?? {};
  const isRelative = spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
  const isAbsolute = spec.startsWith('/');
  if (!isRelative && !isAbsolute) {
    // Go intra-module path: strip the module-alias prefix and re-anchor.
    // Go package specs never have file extensions (they name packages,
    // not files), so extMissing is always false for the Go branch.
    const goAliasHit = resolveGoModuleAlias(spec, projectRootAbs, opts.goModuleAlias);
    if (goAliasHit) return goAliasHit;
    // TS path-alias re-anchor (e.g. `@/contexts/Foo` → `<root>/src/contexts/Foo`).
    // Caller-supplied alias map keeps the classifier pure; null on no
    // alias match falls through to bare.
    if (opts.tsPathAliases) {
      const aliasHit = resolveTsPathAlias(spec, opts.tsPathAliases);
      if (aliasHit) return aliasHit;
    }
    // C/C++ quoted include: probe relative-to-importing-file first
    // (path.resolve follows `..` segments so `#include "../other/h.h"`
    // works too), then fall back to projectRootAbs. Matches the C
    // preprocessor's documented quoted-include search order (compiler-
    // specific paths beyond the source tree are out of scope — they'd
    // require knowing the build's `-I` flags, which cartograph doesn't
    // have).
    const quotedIncludeHit = resolveQuotedInclude({
      spec,
      importingFileAbs,
      projectRootAbs,
      cIncludeStyle: opts.cIncludeStyle,
    });
    if (quotedIncludeHit) return quotedIncludeHit;
    return { kind: 'bare', extMissing: false };
  }

  const fromDir = path.dirname(importingFileAbs);
  const resolvedBase = isAbsolute
    ? path.resolve(projectRootAbs, spec.replace(/^\/+/, ''))
    : path.resolve(fromDir, spec);
  const extMissing = isRelative && !hasKnownExtension(spec);

  return (
    resolveDirectFileHit(resolvedBase, extMissing) ??
    resolveEsmRewrite(resolvedBase, extMissing) ??
    resolveExtensionPermutation(resolvedBase, extMissing) ??
    resolveDirectoryTarget(resolvedBase, extMissing) ?? { kind: 'unresolvable', extMissing }
  );
}

function resolveQuotedInclude(args: {
  spec: string;
  importingFileAbs: string;
  projectRootAbs: string;
  cIncludeStyle: ClassifyImportOpts['cIncludeStyle'];
}): ImportClassification | null {
  const { spec, importingFileAbs, projectRootAbs, cIncludeStyle } = args;
  if (cIncludeStyle !== 'quoted') return null;
  const sameDir = path.resolve(path.dirname(importingFileAbs), spec);
  const sameDirHit = resolveDirectFileHit(sameDir, false);
  if (sameDirHit) return sameDirHit;
  const rootHit = resolveDirectFileHit(path.resolve(projectRootAbs, spec), false);
  return rootHit ?? { kind: 'unresolvable', extMissing: false };
}

function resolveGoModuleAlias(
  spec: string,
  projectRootAbs: string,
  goAlias: string | undefined,
): ImportClassification | null {
  if (!goAlias) return null;
  let stripped: string | null = null;
  if (spec === goAlias) stripped = '';
  else if (spec.startsWith(`${goAlias}/`)) stripped = spec.slice(goAlias.length + 1);
  if (stripped === null) return null;
  const resolvedBase = path.resolve(projectRootAbs, stripped);
  return resolveDirectoryTarget(resolvedBase, false) ?? { kind: 'unresolvable', extMissing: false };
}

/**
 * Strip JSONC comments (line `//` + block `/* … *\/`) from a tsconfig
 * source so the standard `JSON.parse` accepts it. Conservative — does
 * NOT respect strings (a `//` inside a string literal would be
 * stripped); tsconfig values are paths and identifiers in practice so
 * this is safe for the documented surface.
 */
function stripJsonComments(src: string): string {
  return src.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Read the nearest tsconfig.json from a file's directory upward, return
 * its `compilerOptions.paths` + resolved `baseUrl`. Returns null when:
 *   - no tsconfig.json is found up to projectRootAbs
 *   - tsconfig has no `paths` (the alias feature is opt-in)
 *   - any read / parse error
 *
 * Known limitation: `extends` chains are NOT followed — a tsconfig that
 * inherits `paths` from a base file (e.g. `extends: "./tsconfig.base.json"`
 * with the paths only on the base) will silently fall through to `null`.
 * Most projects with `paths` define them on the leaf tsconfig directly;
 * extending-only-for-paths is uncommon enough to defer.
 *
 * Callers should cache by directory — this walks the FS every call.
 * The companion {@link buildTsPathAliasResolver} helper bundles that
 * caching so collectStaticImports / similar callers do one lookup per
 * unique directory.
 */
export function readTsPathAliases(fromDirAbs: string, projectRootAbs: string): TsPathAliases | null {
  let dir = fromDirAbs;
  while (true) {
    const aliases = readTsPathAliasesInDir(dir);
    if (aliases) return aliases;
    // Stop at the project root or filesystem root (path.dirname returns
    // the same dir for `/` on POSIX or `C:\` on Windows). One guard
    // covers both — no need for a second `parent === dir` check.
    if (dir === projectRootAbs || dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

function readTsPathAliasesInDir(dir: string): TsPathAliases | null {
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    return aliasesFromTsconfig(stripJsonComments(raw), dir);
  } catch {
    // Unreadable / malformed tsconfig: skip and keep walking up.
    return null;
  }
}

function aliasesFromTsconfig(json: string, dir: string): TsPathAliases | null {
  const parsed = parseTsconfigAliases(json);
  if (!parsed) return null;
  const compilerOptions = ownCompilerOptions(parsed);
  const paths = compilerOptions ? ownPaths(compilerOptions) : undefined;
  if (!compilerOptions || !paths || Object.keys(paths).length === 0) return null;
  return {
    baseUrl: path.resolve(dir, ownBaseUrl(compilerOptions) ?? '.'),
    paths,
  };
}

/**
 * Build a memoised per-directory tsconfig.paths resolver. Callers pass
 * `importingFileAbs`; the resolver returns the nearest aliases (or
 * null) with at most one FS walk per directory across the whole run.
 */
export function buildTsPathAliasResolver(projectRootAbs: string): (importingFileAbs: string) => TsPathAliases | null {
  const cache = new Map<string, TsPathAliases | null>();
  return (importingFileAbs: string) => {
    const dir = path.dirname(importingFileAbs);
    const cached = cache.get(dir);
    if (cached !== undefined) return cached;
    const aliases = readTsPathAliases(dir, projectRootAbs);
    cache.set(dir, aliases);
    return aliases;
  };
}

function parseTsconfigAliases(json: string): TsconfigAliasesConfig | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const root = asJsonObject(parsed);
    if (!root) return null;
    const compilerOptionsInput = asJsonObject(root['compilerOptions']);
    if (!compilerOptionsInput) {
      return Object.hasOwn(root, 'compilerOptions') ? null : createTsconfigAliasesConfig();
    }
    const compilerOptions = parseTsconfigCompilerOptions(compilerOptionsInput);
    if (!compilerOptions) return null;
    const config = createTsconfigAliasesConfig();
    config.compilerOptions = compilerOptions;
    return config;
  } catch {
    return null;
  }
}

function createTsconfigAliasesConfig(): TsconfigAliasesConfig {
  const config: TsconfigAliasesConfig = {};
  Object.setPrototypeOf(config, null);
  return config;
}

function parseTsconfigCompilerOptions(input: JsonObject): NonNullable<TsconfigAliasesConfig['compilerOptions']> | null {
  const compilerOptions: NonNullable<TsconfigAliasesConfig['compilerOptions']> = {};
  Object.setPrototypeOf(compilerOptions, null);
  if (Object.hasOwn(input, 'baseUrl')) {
    const baseUrl = tsconfigBaseUrlSchema.safeParse(input['baseUrl']);
    if (!baseUrl.success) return null;
    if (baseUrl.data !== undefined) compilerOptions.baseUrl = baseUrl.data;
  }
  const paths = tsconfigPathsFieldSchema.safeParse(Object.hasOwn(input, 'paths') ? input['paths'] : undefined);
  if (!paths.success) return null;
  if (paths.data !== undefined) compilerOptions.paths = paths.data;
  return compilerOptions;
}

function ownCompilerOptions(
  config: TsconfigAliasesConfig,
): NonNullable<TsconfigAliasesConfig['compilerOptions']> | undefined {
  return Object.hasOwn(config, 'compilerOptions') ? config.compilerOptions : undefined;
}

function ownBaseUrl(compilerOptions: NonNullable<TsconfigAliasesConfig['compilerOptions']>): string | undefined {
  return Object.hasOwn(compilerOptions, 'baseUrl') ? compilerOptions.baseUrl : undefined;
}

function ownPaths(
  compilerOptions: NonNullable<TsconfigAliasesConfig['compilerOptions']>,
): Record<string, string[]> | undefined {
  return Object.hasOwn(compilerOptions, 'paths') ? compilerOptions.paths : undefined;
}

/**
 * Parse the `module github.com/foo/bar` declaration from a project's
 * go.mod file. Returns the module path or null if no go.mod, no
 * module line, or any read error. Used by callers to thread the
 * Go-module alias into {@link classifyImport}.
 */
export function readGoModuleAlias(projectRootAbs: string): string | null {
  try {
    const goModPath = path.join(projectRootAbs, 'go.mod');
    if (!fs.existsSync(goModPath)) return null;
    const content = fs.readFileSync(goModPath, 'utf8');
    // First non-comment `module <path>` line.
    const match = /^\s*module\s+(\S+)/m.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
