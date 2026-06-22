/**
 * Import Resolver
 *
 * Resolves import paths to actual files and symbols.
 */

import * as path from 'node:path';
import { z } from 'zod';
import type { Language, Node } from '../types.js';
import type { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping, ReExport } from './types.js';
import { applyAliases } from './path-aliases.js';
import { isJsFamily } from '../utils.js';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.d.ts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.xsjs',
    '.xsjslib',
    '/index.ts',
    '/index.tsx',
    '/index.mts',
    '/index.cts',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
    '/index.xsjs',
    '/index.xsjslib',
  ],
  javascript: [
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.xsjs',
    '.xsjslib',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
    '/index.xsjs',
    '/index.xsjslib',
  ],
  tsx: [
    '.tsx',
    '.ts',
    '.mts',
    '.cts',
    '.d.ts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.xsjs',
    '.xsjslib',
    '/index.tsx',
    '/index.ts',
    '/index.mts',
    '/index.cts',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
    '/index.xsjs',
    '/index.xsjslib',
  ],
  jsx: [
    '.jsx',
    '.js',
    '.mjs',
    '.cjs',
    '.xsjs',
    '.xsjslib',
    '/index.jsx',
    '/index.js',
    '/index.mjs',
    '/index.cjs',
    '/index.xsjs',
    '/index.xsjslib',
  ],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
  // F#65 — ObjC `#import` resolves to `.h` headers (declaration) or
  // `.m` / `.mm` implementations; the same name often appears in
  // both, with the `.h` being the canonical export.
  objc: ['.h', '.m', '.mm'],
};

/** Argument bundle for {@link resolveImportPath}. */
interface ResolveImportArgs {
  importPath: string;
  fromFile: string;
  language: Language;
  context: ResolutionContext;
}

type WorkspacePackageExport = {
  readonly packageDir: string;
  readonly exports: unknown;
};

const workspacePackageJsonSchema = z.looseObject({
  name: z.string().min(1),
  exports: z.unknown().optional(),
});

type WorkspacePackageJson = z.infer<typeof workspacePackageJsonSchema>;

const workspacePackageCache = new WeakMap<ResolutionContext, Map<string, WorkspacePackageExport>>();

/**
 * Resolve an import path to an actual file
 */
export function resolveImportPath(args: ResolveImportArgs): string | null {
  const { importPath, fromFile, language, context } = args;
  const workspacePackagePath = resolveWorkspacePackageImport({ importPath, language, context });
  if (workspacePackagePath !== null) return workspacePackagePath;
  // Skip external/npm packages — but pass the context so the
  // bare-specifier heuristic can consult the project's tsconfig
  // alias map first (custom prefixes like `@components/*` would
  // otherwise be misclassified as npm).
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return resolveRelativeImport({ importPath, language, context, fromDir });
  }

  // Handle absolute/aliased imports (like @/ or src/)
  return resolveAliasedImport({ importPath, language, context, projectRoot });
}

function resolveWorkspacePackageImport(args: {
  importPath: string;
  language: Language;
  context: ResolutionContext;
}): string | null {
  const { importPath, language, context } = args;
  if (!isJsFamily(language)) return null;
  const packageName = packageNameFromSpecifier(importPath);
  if (packageName === null) return null;
  const packages = getWorkspacePackages(context);
  const workspacePackage = packages.get(packageName);
  if (workspacePackage === undefined) return null;

  const subpath = importPath === packageName ? '.' : `.${importPath.slice(packageName.length)}`;
  const exportedTarget = resolvePackageExportTarget(workspacePackage.exports, subpath);
  const candidate = exportedTarget ?? (subpath === '.' ? './index' : subpath);
  const packageRelative = stripLeadingDotSlash(path.posix.join(workspacePackage.packageDir, candidate));
  return resolveProjectRelativeCandidate({ candidate: packageRelative, language, context });
}

function getWorkspacePackages(context: ResolutionContext): Map<string, WorkspacePackageExport> {
  const cached = workspacePackageCache.get(context);
  if (cached !== undefined) return cached;
  const packages = new Map<string, WorkspacePackageExport>();
  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('package.json') || filePath.includes('node_modules/')) continue;
    const pkg = parseWorkspacePackageJson(context.readFile(filePath));
    if (pkg === null) continue;
    packages.set(pkg.name, {
      packageDir: path.posix.dirname(filePath),
      exports: pkg.exports,
    });
  }
  workspacePackageCache.set(context, packages);
  return packages;
}

function parseWorkspacePackageJson(content: string | null): { name: string; exports: unknown } | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const result = workspacePackageJsonSchema.safeParse(parsed);
    if (!result.success) return null;
    return workspacePackageJsonFromSchema(result.data);
  } catch {
    return null;
  }
}

function workspacePackageJsonFromSchema(pkg: WorkspacePackageJson): { name: string; exports: unknown } {
  return { name: pkg.name, exports: pkg.exports ?? null };
}

function packageNameFromSpecifier(importPath: string): string | null {
  if (importPath.startsWith('.') || importPath.length === 0) return null;
  const parts = importPath.split('/');
  if (importPath.startsWith('@')) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

function resolvePackageExportTarget(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
  if (exportsField === null || typeof exportsField !== 'object') return null;
  if (subpath === '.') {
    const rootTarget = packageExportEntryToString(exportsField);
    if (rootTarget !== null) return rootTarget;
  }
  if (Array.isArray(exportsField)) return null;
  const entry = objectProperty(exportsField, subpath);
  const exactTarget = packageExportEntryToString(entry);
  return exactTarget ?? resolvePackageExportPatternTarget(exportsField, subpath);
}

function packageExportEntryToString(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const hit = packageExportEntryToString(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (entry === null || typeof entry !== 'object') return null;
  for (const key of ['types', 'import', 'default']) {
    const hit = packageExportEntryToString(objectProperty(entry, key));
    if (hit !== null) return hit;
  }
  return null;
}

function objectProperty(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function resolvePackageExportPatternTarget(exportsField: object, subpath: string): string | null {
  for (const key of Object.keys(exportsField)) {
    const wildcard = packageExportPatternWildcard(key, subpath);
    if (wildcard === null) continue;
    const target = packageExportEntryToString(objectProperty(exportsField, key));
    if (target !== null) return target.replaceAll('*', wildcard);
  }
  return null;
}

function packageExportPatternWildcard(pattern: string, subpath: string): string | null {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex < 0) return null;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return null;
  const wildcardEnd = subpath.length - suffix.length;
  if (wildcardEnd < prefix.length) return null;
  return subpath.slice(prefix.length, wildcardEnd);
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function resolveProjectRelativeCandidate(args: {
  candidate: string;
  language: Language;
  context: ResolutionContext;
}): string | null {
  const { candidate, language, context } = args;
  if (context.fileExists(candidate)) return candidate;
  const extensions = EXTENSION_RESOLUTION[language] || [''];
  for (const ext of extensions) {
    const candidateWithExt = `${candidate}${ext}`;
    if (context.fileExists(candidateWithExt)) return candidateWithExt;
  }
  return null;
}

/**
 * Check if an import is external (npm package, etc.)
 *
 * `context` is consulted for project-defined path aliases
 * (tsconfig/jsconfig `paths`). Without that check, custom prefixes
 * like `@components/*` would fail the bare-specifier heuristic and
 * be classified as external before alias resolution can run.
 */
function isExternalImport(importPath: string, language: Language, context?: ResolutionContext): boolean {
  // Relative imports are not external
  if (importPath.startsWith('.')) return false;

  if (isJsFamily(language)) return isJsExternal(importPath, context);
  if (language === 'python') return isPythonStdlib(importPath);
  if (language === 'go') return isGoExternal(importPath);
  return false;
}

const JS_NODE_BUILTINS: ReadonlySet<string> = new Set([
  'fs',
  'path',
  'os',
  'crypto',
  'http',
  'https',
  'url',
  'util',
  'events',
  'stream',
  'child_process',
  'buffer',
]);

/** JS/TS external test: Node builtin OR npm bare specifier (with project-alias escape hatch). */
function isJsExternal(importPath: string, context?: ResolutionContext): boolean {
  if (JS_NODE_BUILTINS.has(importPath)) return true;
  // Project-defined alias prefix? Treat as local.
  const aliases = context?.getProjectAliases?.();
  if (aliases && importMatchesProjectAlias(importPath, aliases)) return false;
  // Scoped packages or bare specifiers that don't start with conventional aliases
  return !importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/');
}

const PYTHON_STDLIBS: ReadonlySet<string> = new Set([
  'os',
  'sys',
  'json',
  're',
  'math',
  'datetime',
  'collections',
  'typing',
  'pathlib',
  'logging',
]);

/** Python stdlib test on the leading dotted segment. */
function isPythonStdlib(importPath: string): boolean {
  return PYTHON_STDLIBS.has(importPath.split('.')[0]!);
}

/** Go external test: non-relative path that isn't an `/internal/` package. */
function isGoExternal(importPath: string): boolean {
  return !importPath.startsWith('.') && !importPath.includes('/internal/');
}

/**
 * Module specifier extensions that NodeNext-style code writes in
 * import paths even though the SOURCE file is `.ts` / `.tsx`. When
 * `import './foo.js'` doesn't resolve directly, retry with `.ts` /
 * `.tsx` etc. on the stripped base — this is the same shim
 * TypeScript itself applies for `moduleResolution: NodeNext`.
 *
 * Without this, every relative `.js`-suffixed import in a NodeNext
 * project fails the path-based resolver and falls through to
 * name-only matching, which produces AMBIGUOUS edges whenever ≥2
 * files export the same symbol name (root cause of the migrations
 * `unused_export` cluster — 31 files all exporting `MIGRATION`).
 */
const NODENEXT_JS_EXT_RE = /\.(jsx?|mjs|cjs)$/;

/** Does any project-alias pattern's prefix start `importPath`? Pulled
 *  out of {@link isExternalImport} so the alias scan doesn't sit
 *  3-deep inside the language dispatch + null-check chain. */
function importMatchesProjectAlias(
  importPath: string,
  aliases: NonNullable<ReturnType<NonNullable<ResolutionContext['getProjectAliases']>>>,
): boolean {
  for (const pat of aliases.patterns) {
    if (importPath.startsWith(pat.prefix)) return true;
  }
  return false;
}

/** Internal context bundle for `resolveRelativeImport`. */
interface RelativeImportCtx {
  importPath: string;
  language: Language;
  context: ResolutionContext;
  fromDir: string;
}

/** Internal context bundle for `resolveAliasedImport` and `tryProjectAliasResolution`. */
interface AliasedImportCtx {
  importPath: string;
  language: Language;
  context: ResolutionContext;
  projectRoot: string;
}

/**
 * Resolve a relative import
 */
function resolveRelativeImport(ctx: RelativeImportCtx): string | null {
  const { importPath, language, context, fromDir } = ctx;
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const normalizedImportPath = normalizeRelativeImportPath(importPath, language);

  // Try the path as-is first
  const basePath = path.resolve(fromDir, normalizedImportPath);
  const relativePath = path.relative(projectRoot, basePath).replaceAll('\\', '/');

  // Try each extension
  for (const ext of extensions) {
    const candidatePath = relativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Try without extension (might already have one)
  if (context.fileExists(relativePath)) {
    return relativePath;
  }

  // NodeNext shim: import paths use `.js` but source files are `.ts`.
  // Strip the JS-family extension and re-try with the language's
  // canonical extension list on the bare base.
  if (NODENEXT_JS_EXT_RE.test(relativePath)) {
    const stripped = relativePath.replace(NODENEXT_JS_EXT_RE, '');
    for (const ext of extensions) {
      const candidatePath = stripped + ext;
      if (context.fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

/**
 * Resolve an aliased/absolute import.
 *
 * Tries, in order:
 *   1. Project-defined `compilerOptions.paths` (tsconfig/jsconfig).
 *      Each pattern can have multiple replacements; tried in tsconfig
 *      priority order with extension permutations.
 *   2. The legacy hard-coded fallback list (`@/`, `~/`, `src/`, ...)
 *      for projects that have aliases but no tsconfig paths block.
 *   3. Direct path lookup (with extensions).
 */
function resolveAliasedImport(ctx: AliasedImportCtx): string | null {
  const { importPath, language, context } = ctx;
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const tryWithExt = (basePath: string): string | null => {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    if (context.fileExists(basePath)) return basePath;
    return null;
  };

  // 1. Project tsconfig/jsconfig paths.
  const fromTsconfig = tryProjectAliasResolution(ctx, tryWithExt);
  if (fromTsconfig) return fromTsconfig;

  // 2. Hard-coded fallback list (conventional aliases without tsconfig).
  const fromFallback = tryFallbackAliasResolution(importPath, tryWithExt);
  if (fromFallback) return fromFallback;

  // 3. Direct path.
  return tryWithExt(normalizeAliasedImportPath(importPath, language));
}

/**
 * Python dotted module paths are import syntax, not filesystem syntax:
 * `from .models import User` should probe `./models.py`, not `.models.py`.
 * Non-Python languages keep their existing path semantics.
 */
function normalizeRelativeImportPath(importPath: string, language: Language): string {
  if (language !== 'python') return importPath;
  const dotCount = leadingDotCount(importPath);
  if (dotCount === 0) return importPath;
  const rest = importPath.slice(dotCount);
  const upward = dotCount === 1 ? './' : '../'.repeat(dotCount - 1);
  if (!rest) return upward.slice(0, -1) || '.';
  return upward + rest.replaceAll('.', '/');
}

function leadingDotCount(value: string): number {
  let count = 0;
  while (value[count] === '.') count++;
  return count;
}

/** Python absolute imports use dotted package names (`pkg.mod`), while
 * indexed project paths use directory separators (`pkg/mod.py`). */
function normalizeAliasedImportPath(importPath: string, language: Language): string {
  return language === 'python' ? importPath.replaceAll('.', '/') : importPath;
}

/** Try every alias candidate from the project's tsconfig/jsconfig, in priority order. */
function tryProjectAliasResolution(
  ctx: AliasedImportCtx,
  tryWithExt: (basePath: string) => string | null,
): string | null {
  const { importPath, projectRoot, context } = ctx;
  const aliasMap = context.getProjectAliases?.();
  if (!aliasMap) return null;
  const candidates = applyAliases(importPath, aliasMap, projectRoot);
  for (const c of candidates) {
    const hit = tryWithExt(c);
    if (hit) return hit;
  }
  return null;
}

/** Hard-coded fallback aliases for projects that don't declare them in tsconfig. */
const FALLBACK_ALIASES: Record<string, string> = {
  '@/': 'src/',
  '~/': 'src/',
  '@src/': 'src/',
  'src/': 'src/',
  '@app/': 'app/',
  'app/': 'app/',
};

/** Substitute the first matching fallback alias prefix and probe with extensions. */
function tryFallbackAliasResolution(
  importPath: string,
  tryWithExt: (basePath: string) => string | null,
): string | null {
  for (const [alias, replacement] of Object.entries(FALLBACK_ALIASES)) {
    if (!importPath.startsWith(alias)) continue;
    const hit = tryWithExt(importPath.replace(alias, replacement));
    if (hit) return hit;
  }
  return null;
}

/**
 * Extract import mappings from a file
 */
export function extractImportMappings(_filePath: string, content: string, language: Language): ImportMapping[] {
  // Sequential early returns instead of an if/else-if cascade — keeps
  // the nested_complexity metric flat (else-if parses as nested
  // if_statement; four else-ifs reach depth 4).
  if (isJsFamily(language)) return extractJSImports(content);
  if (language === 'python') return extractPythonImports(content);
  if (language === 'go') return extractGoImports(content);
  if (language === 'php') return extractPHPImports(content);
  return [];
}

/** CJS `const x = require('src')` regex. */
const CJS_DEFAULT_REQUIRE_RE = /(?:const|let|var)\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/g;
/** CJS `const {a, b: c} = require('src')` regex. */
const CJS_DESTRUCTURED_REQUIRE_RE = /(?:const|let|var)\s+{([^}]+)}\s*=\s*require\(['"]([^'"]+)['"]\)/g;
/** Named-import alias: `a as b` (ES6) or `a: b` (CJS destructured). */
const NAMED_ALIAS_RE = /(\w+)\s+as\s+(\w+)/;
const CJS_ALIAS_RE = /(\w+)\s*:\s*(\w+)/;

/**
 * Push one mapping per name in a comma-separated import list.
 * `aliasRegex` differs between ES6 (`as`) and CJS (`:`); the rest of
 * the shape is identical.
 */
/** Count newlines in `content` up to (exclusive) code-unit offset `idx`,
 *  returning the 1-indexed line number that contains `idx`.
 *  Iterates Unicode code points while tracking code-unit position. */
function lineOfOffset(content: string, idx: number): number {
  let line = 1;
  let codeUnitPos = 0;
  for (const char of content) {
    if (codeUnitPos >= idx) break;
    if (char === '\n') line++;
    codeUnitPos += char.length;
  }
  return line;
}

interface PushNamedImportsArgs {
  out: ImportMapping[];
  source: string;
  namesList: string;
  aliasRegex: RegExp;
  line: number;
}

function pushNamedImports(args: PushNamedImportsArgs): void {
  const { out, source, namesList, aliasRegex, line } = args;
  for (const raw of namesList.split(',')) {
    const name = normalizeTypeOnlyImportSpecifier(raw.trim());
    if (!name) continue;
    const alias = aliasRegex.exec(name);
    if (alias) {
      out.push({
        localName: alias[2]!,
        exportedName: alias[1]!,
        source,
        isDefault: false,
        isNamespace: false,
        line,
      });
    } else {
      out.push({
        localName: name,
        exportedName: name,
        source,
        isDefault: false,
        isNamespace: false,
        line,
      });
    }
  }
}

function normalizeTypeOnlyImportSpecifier(name: string): string {
  return name.replace(/^type\s+/, '');
}

interface Es6ImportClause {
  defaultImport: string | null;
  namedImports: string | null;
  namespaceAlias: string | null;
}

function parseEs6ImportClause(clause: string): Es6ImportClause {
  const named = extractBracedImportList(clause);
  const namespaceAlias = extractNamespaceAlias(clause);
  const defaultImport = extractDefaultImportName(clause);
  return { defaultImport, namedImports: named, namespaceAlias };
}

function extractBracedImportList(clause: string): string | null {
  const open = clause.indexOf('{');
  if (open < 0) return null;
  const close = clause.indexOf('}', open + 1);
  if (close < 0) return null;
  return clause.slice(open + 1, close);
}

function extractNamespaceAlias(clause: string): string | null {
  const star = clause.indexOf('*');
  if (star < 0) return null;
  const afterStar = clause.slice(star + 1).trimStart();
  if (!afterStar.startsWith('as ')) return null;
  const alias = afterStar.slice(3).trim().split(/\s+/)[0];
  return alias || null;
}

function extractDefaultImportName(clause: string): string | null {
  const beforeSpecialImport = clause.split(/[,{*]/, 1)[0]?.trim();
  if (!beforeSpecialImport) return null;
  const normalized = normalizeTypeOnlyDefaultImport(beforeSpecialImport);
  if (normalized === null) return null;
  return /^\w+$/.test(normalized) ? normalized : null;
}

function normalizeTypeOnlyDefaultImport(name: string): string | null {
  if (name === 'type') return null;
  return name.replace(/^type\s+/, '');
}

interface Es6ImportMatch {
  clause: string;
  source: string;
  index: number;
  end: number;
}

function findNextEs6Import(content: string, startAt: number): Es6ImportMatch | null {
  let searchAt = startAt;
  while (searchAt < content.length) {
    const importIndex = content.indexOf('import', searchAt);
    if (importIndex < 0) return null;
    const clauseStart = skipWhitespace(content, importIndex + 'import'.length);
    if (clauseStart === importIndex + 'import'.length) {
      searchAt = importIndex + 'import'.length;
      continue;
    }
    const found = readEs6ImportFrom(content, importIndex, clauseStart);
    if (found) return found;
    searchAt = importIndex + 'import'.length;
  }
  return null;
}

function readEs6ImportFrom(content: string, importIndex: number, clauseStart: number): Es6ImportMatch | null {
  let braceDepth = 0;
  for (let i = clauseStart; i < content.length; i++) {
    const char = content[i]!;
    if (char === ';' && braceDepth === 0) return null;
    if (char === '{') braceDepth++;
    if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (braceDepth === 0 && isFromKeywordAt(content, i)) {
      const source = readImportSource(content, i + 'from'.length);
      if (!source) return null;
      return {
        clause: content.slice(clauseStart, i).trimEnd(),
        source: source.value,
        index: importIndex,
        end: source.end,
      };
    }
  }
  return null;
}

function isFromKeywordAt(content: string, index: number): boolean {
  if (!content.startsWith('from', index)) return false;
  return isWhitespace(content[index - 1]) && isWhitespace(content[index + 'from'.length]);
}

function readImportSource(content: string, startAt: number): { value: string; end: number } | null {
  const quoteIndex = skipWhitespace(content, startAt);
  const quote = content[quoteIndex];
  if (quote !== "'" && quote !== '"') return null;
  const endQuote = content.indexOf(quote, quoteIndex + 1);
  if (endQuote < 0) return null;
  return { value: content.slice(quoteIndex + 1, endQuote), end: endQuote + 1 };
}

function skipWhitespace(content: string, startAt: number): number {
  let i = startAt;
  while (i < content.length && isWhitespace(content[i])) i++;
  return i;
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** Walk every ES6 `import ... from` match and push the resulting mappings. */
function pushES6Imports(content: string, out: ImportMapping[]): void {
  let offset = 0;
  let match: Es6ImportMatch | null;
  while ((match = findNextEs6Import(content, offset)) !== null) {
    offset = match.end;
    const { defaultImport, namedImports, namespaceAlias } = parseEs6ImportClause(match.clause);
    const line = lineOfOffset(content, match.index);
    if (defaultImport) {
      out.push({
        localName: defaultImport,
        exportedName: 'default',
        source: match.source,
        isDefault: true,
        isNamespace: false,
        line,
      });
    }
    if (namedImports) {
      pushNamedImports({ out, source: match.source, namesList: namedImports, aliasRegex: NAMED_ALIAS_RE, line });
    }
    if (namespaceAlias) {
      out.push({
        localName: namespaceAlias,
        exportedName: '*',
        source: match.source,
        isDefault: false,
        isNamespace: true,
        line,
      });
    }
  }
}

/** Walk every CJS `const ... = require(...)` match and push the resulting mappings. */
function pushRequireImports(content: string, out: ImportMapping[]): void {
  const matches: Array<{ index: number; push: () => void }> = [];
  let match: RegExpExecArray | null;
  while ((match = CJS_DEFAULT_REQUIRE_RE.exec(content)) !== null) {
    const [, defaultName, source] = match;
    const line = lineOfOffset(content, match.index);
    matches.push({
      index: match.index,
      push: () =>
        out.push({
          localName: defaultName!,
          exportedName: 'default',
          source: source!,
          isDefault: true,
          isNamespace: false,
          line,
        }),
    });
  }
  while ((match = CJS_DESTRUCTURED_REQUIRE_RE.exec(content)) !== null) {
    const [, destructured, source] = match;
    const line = lineOfOffset(content, match.index);
    matches.push({
      index: match.index,
      push: () => pushNamedImports({ out, source: source!, namesList: destructured!, aliasRegex: CJS_ALIAS_RE, line }),
    });
  }
  matches.sort((a, b) => a.index - b.index);
  for (const matchInfo of matches) {
    matchInfo.push();
  }
}

/**
 * Extract JS/TS import mappings — both ES6 `import` declarations and
 * CJS `require()` calls. Both are regex-based today; AST extraction
 * would be more accurate but pulls a heavier dependency for the
 * dependency-graph use case (where false positives just become a
 * slightly-fuzzier resolution candidate set, not a wrong answer).
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];
  pushES6Imports(content, mappings);
  pushRequireImports(content, mappings);
  return mappings;
}

/**
 * Extract Python import mappings.
 *
 * Two from-import shapes are recognised in one regex pass:
 *   - parenthesised, possibly multi-line (PEP-8 / Black style):
 *       `from abc import (\n    ABC,\n    abstractmethod,\n)`
 *   - single-line non-parenthesised:
 *       `from abc import ABC, abstractmethod`
 *
 * F#36 (2026-05-26): the pre-fix regex `[^#\n]+` was newline-anchored,
 * so multi-line parenthesised imports captured only the literal `(`
 * and produced no useful name mapping. Downstream, `resolveViaImport`
 * couldn't match bare-identifier references like
 * `class Foo(ABC):` against an import for `ABC`, so the F#33
 * external-import fallback never fired and the inheritance ref stayed
 * unresolved (live count: 14 such refs on /tmp/pandas).
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import (...) — multi-line parenthesised — OR — from X import name1, name2  (single line)
  const fromImportRegex = /from\s+([\w.]+)\s+import\s+(?:\(([^)]+)\)|([^#\n]+))/g;
  let match: RegExpExecArray | null;

  while ((match = fromImportRegex.exec(content)) !== null) {
    const [, source, parenList, lineList] = match;
    const imports = parenList ?? lineList ?? '';
    pushPythonFromImportNames(mappings, source!, imports);
  }

  // import X
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const [, source, alias] = match;
    const localName = alias || source!.split('.').pop()!;
    mappings.push({
      localName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

/**
 * Push one mapping per name in a Python `from MODULE import a, b as c`
 * comma-separated list. Wildcard re-exports (`from x import *`) are
 * skipped — they can't be tracked symbol-by-symbol from the import
 * statement alone.
 *
 * Inline `#` comments are stripped FIRST so a multi-line paren block
 * like `from typing import (\n    Optional,  # legacy\n    List,\n)`
 * doesn't fold the `# legacy\n    List` text into one corrupted token
 * — without this, `List` is silently dropped because the comma-split
 * gives `["Optional", "# legacy\n    List", "Dict"]` and the middle
 * element fails the `\w+` alias / bare-name match. Comments are not
 * valid inside `from … import` content otherwise; `#` can never appear
 * in a Python identifier so the strip is unambiguous. The legacy
 * single-line path's `[^#\n]+` regex stopped at `#` anyway; this just
 * adds parity for the paren-list branch's `[^)]+` (which intentionally
 * crosses newlines and therefore can't stop at `#` at match time).
 */
function pushPythonFromImportNames(mappings: ImportMapping[], source: string, importsList: string): void {
  const cleaned = importsList.replaceAll(/#[^\n]*/g, '');
  const names = cleaned.split(',').map((s) => s.trim());
  for (const name of names) {
    const aliasMatch = /(\w+)\s+as\s+(\w+)/.exec(name);
    if (aliasMatch) {
      mappings.push({
        localName: aliasMatch[2]!,
        exportedName: aliasMatch[1]!,
        source,
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }
    if (name && name !== '*') {
      mappings.push({
        localName: name,
        exportedName: name,
        source,
        isDefault: false,
        isNamespace: false,
      });
    }
  }
}

/**
 * Extract Go import mappings
 */
function extractGoImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import "path" or import alias "path"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = singleImportRegex.exec(content)) !== null) {
    const [, alias, source] = match;
    const packageName = source!.split('/').pop()!;
    mappings.push({
      localName: alias || packageName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  // import ( ... ) block
  const blockImportRegex = /import\s*\(\s*([^)]+)\s*\)/gs;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1]!;
    const lineRegex = /(?:(\w+)\s+)?["']([^"']+)["']/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const [, alias, source] = lineMatch;
      const packageName = source!.split('/').pop()!;
      mappings.push({
        localName: alias || packageName,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  return mappings;
}

/**
 * Extract PHP import mappings (use statements)
 */
function extractPHPImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use Namespace\Class; or use Namespace\Class as Alias;
  const useRegex = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/g;
  let match: RegExpExecArray | null;

  while ((match = useRegex.exec(content)) !== null) {
    const [, fullPath, alias] = match;
    const className = fullPath!.split('\\').pop()!;
    mappings.push({
      localName: alias || className,
      exportedName: className,
      source: fullPath!,
      isDefault: false,
      isNamespace: false,
    });
  }

  return mappings;
}

/**
 * Process character inside a JS string (quote-aware).
 * Returns [nextIndex, stringState, output].
 */
type JsStringQuote = '"' | "'" | '`';

function processJsStringChar(
  content: string,
  i: number,
  str: JsStringQuote | null,
): [number, JsStringQuote | null, string] {
  const ch = content[i]!;
  let out = ch;
  if (ch === '\\' && i + 1 < content.length) {
    out += content[i + 1]!;
    return [i + 2, str, out];
  }
  if (ch === str) {
    return [i + 1, null, out];
  }
  return [i + 1, str, out];
}

/**
 * Single-character tokens that syntactically precede an expression,
 * meaning a following `/` is a regex literal, not a division operator.
 * Mirrors `EXPRESSION_PRECEDERS` in `src/string-imports/index.ts` — keep
 * the two in sync if either is updated.
 */
const STRIP_EXPRESSION_PRECEDERS = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '?',
  '=',
  '+',
  '-',
  '*',
  '%',
  '&',
  '|',
  '^',
  '~',
  '!',
  '<',
  '>',
]);

/**
 * Consume a `[...]` char-class body starting at `i` (which points at the
 * first character INSIDE the class — the `[` is already appended to
 * `chunk` by the caller).  Returns `{ chunk, nextI }` with `chunk`
 * extended through the closing `]`.
 */
function consumeRegexCharClass(content: string, i: number, chunk: string): { chunk: string; nextI: number } {
  while (i < content.length && content[i] !== ']') {
    if (content[i] === '\\') {
      chunk += content[i]! + (content[i + 1] ?? '');
      i += 2;
    } else {
      chunk += content[i]!;
      i++;
    }
  }
  if (i < content.length) {
    chunk += content[i]!;
    i++;
  } // closing `]`
  return { chunk, nextI: i };
}

/**
 * Consume a regex literal starting at `i` (which points at the opening `/`).
 * Returns `{ chunk, nextI }` where `chunk` is the verbatim text to append
 * (including opening `/`, body, closing `/`, and any flags) and `nextI` is the
 * updated cursor position.  Called only when the caller has already decided
 * the `/` is a regex — not a division operator.
 */
function consumeRegexLiteral(content: string, i: number): { chunk: string; nextI: number } {
  let chunk = content[i]!; // opening `/`
  i++;
  // Consume body: handle escape sequences and `[...]` char classes.
  // Use early-continue guards so each case is a flat if, not a nested else-if chain.
  while (i < content.length) {
    const rc = content[i]!;
    if (rc === '\\') {
      chunk += rc + (content[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (rc === '[') {
      // Inside a char class, `/` does not close the regex — delegate.
      chunk += rc;
      i++;
      ({ chunk, nextI: i } = consumeRegexCharClass(content, i, chunk));
      continue;
    }
    if (rc === '/') {
      chunk += rc;
      i++;
      break;
    } // closing `/`
    if (rc === '\n') {
      break;
    } // unterminated — bail
    chunk += rc;
    i++;
  }
  // Consume trailing flags (e.g. `g`, `i`, `m`, `s`, `u`, `v`) — JS regex
  // flags are lowercase-only, matching the StringImportScanner reference.
  while (i < content.length && /[a-z]/.test(content[i]!)) {
    chunk += content[i]!;
    i++;
  }
  return { chunk, nextI: i };
}

/**
 * Strip JS line + block comments from `content` while preserving
 * string literals (so `"//"` inside a string stays intact) and regex
 * literals (so quote characters inside `/[^'"]/` don't mislead the
 * string-state tracker). Used by {@link extractReExports},
 * {@link buildDynamicImportEdges}, and `collectImportsFromSourceScan`
 * (src/deps/unused.ts) so commented-out import/export statements don't
 * generate phantom edges or phantom package usages.
 *
 * Regex disambiguation uses the standard `prevSig` (last significant
 * non-whitespace char) heuristic: a `/` that follows an expression-
 * preceder or appears at start-of-input is a regex literal; otherwise
 * it is a division operator. Regex contents are emitted verbatim —
 * they are NOT scanned for quote or comment delimiters.
 */
export function stripJsComments(content: string): string {
  let out = '';
  let i = 0;
  let str: '"' | "'" | '`' | null = null;
  /** Last significant (non-whitespace) char emitted; drives regex-vs-division disambiguation. */
  let prevSig = '';
  while (i < content.length) {
    const ch = content[i]!;
    if (str !== null) {
      const [nextI, nextStr, charOut] = processJsStringChar(content, i, str);
      out += charOut;
      if (!nextStr) prevSig = str; // closing quote is the last significant char
      str = nextStr;
      i = nextI;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/') {
      const next = consumeJsSlash(content, i, prevSig);
      out += next.out;
      i = next.nextI;
      prevSig = next.prevSig;
      continue;
    }
    // Track prevSig for non-whitespace chars.
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prevSig = ch;
    }
    out += ch;
    i++;
  }
  return out;
}

function consumeJsSlash(content: string, i: number, prevSig: string): { out: string; nextI: number; prevSig: string } {
  const commentEnd = skipJsComment(content, i);
  if (commentEnd !== null) return { out: '', nextI: commentEnd, prevSig: '' };
  if (prevSig === '' || STRIP_EXPRESSION_PRECEDERS.has(prevSig)) {
    // Regex literal — emit verbatim so quote chars inside don't confuse the string tracker.
    const { chunk, nextI } = consumeRegexLiteral(content, i);
    return { out: chunk, nextI, prevSig: '/' };
  }
  // Division operator — emit as normal char.
  return { out: '/', nextI: i + 1, prevSig: '/' };
}

function skipJsComment(content: string, i: number): number | null {
  const next = content[i + 1];
  if (next === '/') return skipJsLineComment(content, i);
  if (next === '*') return skipJsBlockComment(content, i);
  return null;
}

function skipJsLineComment(content: string, i: number): number {
  while (i < content.length && content[i] !== '\n') i++;
  return i;
}

function skipJsBlockComment(content: string, i: number): number {
  i += 2;
  while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
  return i + 2;
}

/**
 * Extract JS/TS re-export declarations from `content`.
 *
 * Recognised forms:
 *   export { foo } from './a.js';
 *   export { foo as bar } from './a.js';
 *   export * from './a.js';
 *   export * as ns from './a.js';   (treated as wildcard for chasing)
 *   export { default as Foo } from './a.js';
 *
 * The walker intentionally stays regex-based — the import-resolver
 * elsewhere in this file already chooses regex over a fresh
 * tree-sitter pass, and this function shares that trade-off. Errors
 * fall through silently; resolution simply skips the broken file.
 */
export function extractReExports(content: string, language: Language): ReExport[] {
  if (language !== 'typescript' && language !== 'javascript' && language !== 'tsx' && language !== 'jsx') {
    return [];
  }
  const out: ReExport[] = [];

  // Pre-strip block comments + line comments so a commented-out
  // `// export { x } from '...'` doesn't produce a phantom edge.
  // (Template literals are still a possible source of false positives;
  // a project that builds export statements as runtime strings is
  // out of scope.)
  const cleaned = stripJsComments(content);

  // Wildcard: `export * from '...'` / `export type * from '...'` /
  //           `export * as ns from '...'`
  const wildcardRe = /export\s+(?:type\s+)?\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! });
  }

  // Named: `export { a, b as c } from '...'` — also matches the
  // type-only form `export type { a } from '...'`. The leading `type`
  // marker (and per-specifier `type Foo` markers inside the brace)
  // are stripped further down by the brace parser.
  const namedRe = /export\s+(?:type\s+)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(cleaned)) !== null) {
    pushNamedReExportsFromBrace(out, m[2]!, m[1]!);
  }

  return out;
}

/**
 * Parse a single `{ a, b as c, ... }` named-re-export brace and push
 * one ReExport per name into `out`. Aliases (`a as b`) become
 * `originalName=a, exportedName=b`; bare identifiers become
 * `originalName=exportedName=name`. Anything that doesn't match a
 * bare identifier is skipped silently — the regex source is broad
 * enough that the inner items may contain whitespace, type-only
 * markers, or comments we'd rather drop than misclassify.
 */
function pushNamedReExportsFromBrace(out: ReExport[], source: string, inner: string): void {
  for (const raw of inner.split(',')) {
    // Strip per-specifier `type` marker (`type Foo` or `type Foo as Bar`)
    // so the alias / bare-identifier patterns below match either form.
    const item = raw.trim().replace(/^type\s+/, '');
    if (!item) continue;
    const aliasMatch = /^(\w+)\s+as\s+(\w+)$/.exec(item);
    if (aliasMatch) {
      out.push({ kind: 'named', exportedName: aliasMatch[2]!, originalName: aliasMatch[1]!, source });
      continue;
    }
    if (/^\w+$/.test(item)) {
      out.push({ kind: 'named', exportedName: item, originalName: item, source });
    }
  }
}

/**
 * Pick the import mapping that produced `ref`. Two passes, ordered:
 *   1. Local-name / namespace match — `import { X }` then `X()`,
 *      `import { X as Alias }` then `Alias()`, or `import * as ns`
 *      then `ns.foo`. The ref's `referenceName` is the file-local
 *      binding (alias when aliased). This is the typical path:
 *      `emitNamedImportRefsFromFile` and TS/JS call-site extractors both
 *      emit the local name.
 *   2. Aliased same-line fallback — defensive coverage for refs that
 *      carry the EXPORTED name as `referenceName` (refs from other
 *      extractors, framework matchers, or future shapes). When N
 *      imports share that exported name (the migrations registry is
 *      the canonical case — 31 files all `export const MIGRATION`),
 *      the matching import is the one whose statement spans the
 *      ref's line. Skipped when `imp.localName === imp.exportedName`
 *      (not aliased — pass 1 already handles it).
 *
 * Returns the import that should drive resolution, or null.
 */
function pickMatchingImport(ref: UnresolvedRef, imports: ImportMapping[]): ImportMapping | null {
  return pickLocalImport(ref, imports) ?? pickAliasedSameLineImport(ref, imports);
}

function pickLocalImport(ref: UnresolvedRef, imports: ImportMapping[]): ImportMapping | null {
  for (const imp of imports) {
    if (imp.localName === ref.referenceName) return imp;
    if (imp.isNamespace && ref.referenceName.startsWith(imp.localName + '.')) return imp;
    if (getPythonImportedModuleAttribute(ref, imp)) return imp;
  }
  return null;
}

function pickAliasedSameLineImport(ref: UnresolvedRef, imports: ImportMapping[]): ImportMapping | null {
  for (const imp of imports) {
    if (imp.exportedName !== ref.referenceName) continue;
    if (imp.localName === imp.exportedName) continue; // not aliased; covered by pass 1
    if (imp.line !== undefined && imp.line === ref.line) return imp;
  }
  return null;
}

/**
 * Python's `from pkg import helpers; helpers.run()` and
 * `import pkg.helpers as h; h.run()` both import a module as a local
 * binding. Resolve the module path plus member name when the reference
 * is attribute-qualified.
 */
function getPythonImportedModuleAttribute(
  ref: UnresolvedRef,
  imp: ImportMapping,
): { modulePath: string; memberName: string } | null {
  if (ref.language !== 'python') return null;
  if (!ref.referenceName.startsWith(`${imp.localName}.`)) return null;
  const memberName = ref.referenceName.slice(imp.localName.length + 1);
  if (!memberName || memberName.includes('.')) return null;

  if (imp.isNamespace) return { modulePath: imp.source, memberName };
  const modulePath = isOnlyDots(imp.source) ? `${imp.source}${imp.exportedName}` : `${imp.source}.${imp.exportedName}`;
  return { modulePath, memberName };
}

/**
 * F#33 (2026-05-26) — find the local `import` node for a given source
 * module in a file. Returns null when the file has no matching import
 * node. Used by {@link resolveViaImport} as the fallback target when
 * the import's path can't be resolved (stdlib / external dependency
 * like `typing` / `java.util` / `std::collections`) — instead of
 * dropping the ref, we resolve it to the local import node so the
 * edge survives.
 */
function findLocalImportNode(context: ResolutionContext, filePath: string, source: string) {
  // `n.name` on an `import` node is the UNRESOLVED specifier string —
  // exactly what `imp.source` carries (e.g. `'typing'` / `'./utils'` /
  // `'java.util'`), not the resolved file path. Match by specifier so
  // a stdlib import (no resolved path) and a relative import (resolved
  // path differs from specifier) both hit cleanly.
  const nodes = context.getNodesInFile(filePath);
  for (const n of nodes) {
    if (n.kind === 'import' && n.name === source) return n;
  }
  return null;
}

/**
 * Resolve a reference using import mappings.
 *
 * Two-tier resolution:
 *
 * 1. **Direct symbol resolution** (confidence 0.9): the import's source
 *    path resolves to a file in the project AND that file exports the
 *    referenced symbol. Returns a ref to the exported symbol's node.
 *
 * 2. **External-import fallback** (confidence 0.4, F#33): the import
 *    matches by name, but EITHER the path doesn't resolve (stdlib /
 *    external dep — `typing`, `java.util`, `std::collections`) OR
 *    the resolved file has no matching export. In both cases the
 *    LOCAL import node IS in the graph; we resolve to it instead of
 *    dropping the ref. Without this fallback, `class Foo(Protocol)`
 *    in Python (and structurally similar shapes in Rust / Java) would
 *    silently lose its `implements` edge because `Protocol` lives
 *    outside the indexed graph.
 *
 * Confidence values are chosen so that direct-resolution always beats
 * external-import in `pickWinnerWithTieMargin` — the fallback only
 * fires when nothing better was found.
 */
export function resolveViaImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // Use cached import mappings (avoids re-reading and re-parsing per ref)
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  const imp = pickMatchingImport(ref, imports);
  if (!imp) return null;

  const pythonModuleAttribute = resolvePythonImportedModuleAttribute(ref, imp, context);
  if (pythonModuleAttribute) return pythonModuleAttribute;

  const resolvedPath = resolveImportPath({
    importPath: imp.source,
    fromFile: ref.filePath,
    language: ref.language,
    context,
  });

  if (resolvedPath) {
    const exportedName = imp.isDefault ? 'default' : imp.exportedName;
    const memberName = imp.isNamespace ? ref.referenceName.replace(imp.localName + '.', '') : null;

    const targetNode = findExportedSymbol({
      filePath: resolvedPath,
      want: { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName },
      language: ref.language,
      context,
      visited: new Set(),
    });
    if (targetNode) {
      return {
        original: ref,
        targetNodeId: targetNode.id,
        confidence: 0.9,
        resolvedBy: 'import',
      };
    }
  }

  // F#33 fallback: import-path didn't resolve (stdlib/external) OR the
  // target file had no matching export. Either way the local import
  // node represents a real graph relationship ("this file imports the
  // module that contains the referenced symbol") — keep the edge
  // instead of dropping silently.
  //
  // BUT: when the import is a RELATIVE intra-project reference (`./foo`,
  // `../bar`, Python `.foo`) AND the resolution failed because the
  // target file isn't on disk yet, the ref should STAY unresolved so
  // pass-B re-resolution sweeps it once the file lands. Without this
  // exception, the placeholder external-import edge survives forever
  // and the cross-file caller never binds to the real definition.
  // Stdlib / node-modules / unscoped-package imports (`react`,
  // `typing`, `java.util`) still get the fallback — those by
  // definition aren't going to materialise inside the project.
  const isUnresolvedRelativeImport = resolvedPath === null && isRelativeImportSource(imp.source);
  if (isUnresolvedRelativeImport) return null;
  const importNode = findLocalImportNode(context, ref.filePath, imp.source);
  if (importNode) {
    return {
      original: ref,
      targetNodeId: importNode.id,
      confidence: 0.4,
      resolvedBy: 'external-import',
    };
  }

  return null;
}

function resolvePythonImportedModuleAttribute(
  ref: UnresolvedRef,
  imp: ImportMapping,
  context: ResolutionContext,
): ResolvedRef | null {
  const moduleAttribute = getPythonImportedModuleAttribute(ref, imp);
  if (!moduleAttribute) return null;

  const resolvedPath = resolveImportPath({
    importPath: moduleAttribute.modulePath,
    fromFile: ref.filePath,
    language: ref.language,
    context,
  });
  if (!resolvedPath) return null;

  const targetNode =
    findPythonModuleMember(context, resolvedPath, moduleAttribute.memberName) ??
    findExportedSymbol({
      filePath: resolvedPath,
      want: {
        isDefault: false,
        isNamespace: true,
        exportedName: imp.exportedName,
        memberName: moduleAttribute.memberName,
      },
      language: ref.language,
      context,
      visited: new Set(),
    });
  if (!targetNode) return null;

  return {
    original: ref,
    targetNodeId: targetNode.id,
    confidence: 0.9,
    resolvedBy: 'import',
  };
}

function isOnlyDots(value: string): boolean {
  if (!value) return false;
  for (const ch of value) {
    if (ch !== '.') return false;
  }
  return true;
}

function findPythonModuleMember(context: ResolutionContext, filePath: string, memberName: string): Node | undefined {
  return context
    .getNodesInFile(filePath)
    .find((n) => n.name === memberName && n.kind !== 'import' && n.kind !== 'file');
}

/** True when an import source is a relative intra-project reference
 *  (TS/JS `./foo` or `../bar`, Python `.foo` / `..foo`, Python bare
 *  `.` / `..` from `from . import x` / `from .. import x`). These
 *  name files inside the project; an unresolved relative import means
 *  the file isn't on disk yet, not that the dep is external. */
function isRelativeImportSource(source: string): boolean {
  if (source.startsWith('./') || source.startsWith('../')) return true;
  // Python bare-package-relative (`from . import x` → `imp.source = '.'`,
  // `from .. import x` → `'..'`). Reviewer-caught 2026-05-27 — the
  // original regex required a letter after the dots so the bare form
  // slipped through and re-triggered the F#33 fallback.
  if (/^\.+$/.test(source)) return true;
  // Python dotted-package (`from .foo import x` → `imp.source = '.foo'`,
  // `from ..foo import x` → `'..foo'`).
  return /^\.+[A-Za-z_]/.test(source);
}

/** Recursive depth cap for re-export chain following. Real codebases
 *  rarely chain barrels more than 2–3 deep; 8 is a generous safety
 *  net that still bounds worst-case work. */
const REEXPORT_MAX_DEPTH = 8;

/**
 * Find an exported symbol in `filePath`, following `export { x } from
 * './other'` and `export * from './other'` chains until the original
 * declaration is reached. Cycle-safe via the `visited` set.
 *
 * Without this, every barrel-style import (`import { Foo } from
 * './index'` where `index.ts` only re-exports) used to resolve to
 * nothing — the existing code only looked for declarations IN the
 * resolved file, not declarations the file forwarded.
 */
type ExportWant = {
  isDefault: boolean;
  isNamespace: boolean;
  exportedName: string;
  memberName: string | null;
};

/**
 * Phase 1 of `findExportedSymbol`: direct hit. The symbol is declared
 * AND exported in the current file. Three lookup shapes:
 *  - default: any exported function/class (default-export sugar
 *    doesn't always carry the name on the declaration node);
 *  - namespace member: `import * as ns from './x'; ns.foo` — match
 *    `foo` inside the resolved file;
 *  - named: match `exportedName` directly.
 */
function findDirectExportInFile(nodesInFile: ReadonlyArray<Node>, want: ExportWant): Node | undefined {
  if (want.isDefault) {
    return nodesInFile.find((n) => n.isExported && (n.kind === 'function' || n.kind === 'class'));
  }
  if (want.isNamespace && want.memberName) {
    return nodesInFile.find((n) => n.name === want.memberName && n.isExported);
  }
  return nodesInFile.find((n) => n.name === want.exportedName && n.isExported);
}

/** Single-arg bundle for the recursive {@link findExportedSymbol} —
 *  every recursive call rebuilds this with a new `filePath` (and
 *  sometimes new `want` / `depth`); the rest carries through. */
interface FindExportedSymbolArgs {
  filePath: string;
  want: ExportWant;
  language: Language;
  context: ResolutionContext;
  visited: Set<string>;
  depth?: number;
}

function findExportedSymbol(args: FindExportedSymbolArgs): Node | undefined {
  const { filePath, want, language, context, visited } = args;
  const depth = args.depth ?? 0;
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const direct = findDirectExportInFile(context.getNodesInFile(filePath), want);
  if (direct) return direct;

  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  return chaseNamedReExport(args, reExports, depth) ?? chaseWildcardReExport(args, reExports, depth);
}

/** Phase 2: chase explicit `export { want } from './other'` (with optional rename). */
function chaseNamedReExport(
  args: FindExportedSymbolArgs,
  reExports: readonly ReExport[],
  depth: number,
): Node | undefined {
  const { filePath, want, language, context, visited } = args;
  const targetName = want.isDefault ? 'default' : want.exportedName;
  for (const rex of reExports) {
    if (rex.kind !== 'named' || rex.exportedName !== targetName) continue;
    const next = resolveImportPath({ importPath: rex.source, fromFile: filePath, language, context });
    if (!next) continue;
    const chained = findExportedSymbol({
      filePath: next,
      want: {
        isDefault: rex.originalName === 'default',
        isNamespace: false,
        exportedName: rex.originalName,
        memberName: null,
      },
      language,
      context,
      visited,
      depth: depth + 1,
    });
    if (chained) return chained;
  }
  return undefined;
}

/** Phase 3: chase wildcard `export * from './other'` — barrel-of-barrels. */
function chaseWildcardReExport(
  args: FindExportedSymbolArgs,
  reExports: readonly ReExport[],
  depth: number,
): Node | undefined {
  const { filePath, want, language, context, visited } = args;
  for (const rex of reExports) {
    if (rex.kind !== 'wildcard') continue;
    const next = resolveImportPath({ importPath: rex.source, fromFile: filePath, language, context });
    if (!next) continue;
    const chained = findExportedSymbol({ filePath: next, want, language, context, visited, depth: depth + 1 });
    if (chained) return chained;
  }
  return undefined;
}
