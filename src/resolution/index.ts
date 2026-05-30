/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Node, UnresolvedReference, Edge, EdgeKind } from '../types.js';
import { type QueryBuilder, getNodesByKind } from '../db/queries.js';
import { getNodesByName, getNodesByQualifiedNameExact, getNodesByLowerName } from '../db/queries-search.js';
import { insertEdges } from '../db/queries-edges.js';
import {
  deleteSpecificResolvedReferences,
  getUnresolvedReferencesBatch,
  getUnresolvedReferencesCount,
} from '../db/queries-unresolved-refs.js';
import { getAllFilePaths } from '../db/queries-files.js';
import {
  type UnresolvedRef,
  type ResolvedRef,
  type ResolutionResult,
  type ResolutionContext,
  type FrameworkResolver,
  type ImportMapping,
  classifyConfidence,
} from './types.js';
import { matchReference } from './name-matcher.js';
import { isJsFamily } from '../utils.js';
import { resolveViaImport, extractImportMappings, extractReExports } from './import-resolver.js';
import { detectFrameworks } from './frameworks/index.js';
import { loadProjectAliases, type AliasMap } from './path-aliases.js';
import { logDebug } from '../errors.js';
import type { ReExport } from './types.js';
import { compact } from '../utils.js';

// Re-export types
export * from './types.js';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const JS_BUILT_INS = new Set([
  'console',
  'window',
  'document',
  'global',
  'process',
  'Promise',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Date',
  'Math',
  'JSON',
  'RegExp',
  'Error',
  'Map',
  'Set',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'fetch',
  'require',
  'module',
  'exports',
  'import.meta.dirname',
  '__filename',
]);

const REACT_HOOKS = new Set([
  'useState',
  'useEffect',
  'useContext',
  'useReducer',
  'useCallback',
  'useMemo',
  'useRef',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'list',
  'dict',
  'set',
  'tuple',
  'open',
  'input',
  'type',
  'isinstance',
  'hasattr',
  'getattr',
  'setattr',
  'super',
  'self',
  'cls',
  'None',
  'True',
  'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list',
  'dict',
  'set',
  'tuple',
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'bytearray',
  'frozenset',
  'object',
  'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append',
  'extend',
  'insert',
  'remove',
  'pop',
  'clear',
  'sort',
  'reverse',
  'copy',
  'update',
  'keys',
  'values',
  'items',
  'get',
  'add',
  'discard',
  'union',
  'intersection',
  'difference',
  'split',
  'join',
  'strip',
  'lstrip',
  'rstrip',
  'replace',
  'lower',
  'upper',
  'startswith',
  'endswith',
  'find',
  'index',
  'count',
  'encode',
  'decode',
  'format',
  'isdigit',
  'isalpha',
  'isalnum',
  'read',
  'write',
  'readline',
  'readlines',
  'close',
  'flush',
  'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt',
  'os',
  'io',
  'net',
  'http',
  'log',
  'math',
  'sort',
  'sync',
  'time',
  'path',
  'bytes',
  'strings',
  'strconv',
  'errors',
  'context',
  'json',
  'xml',
  'csv',
  'html',
  'template',
  'regexp',
  'reflect',
  'runtime',
  'testing',
  'flag',
  'bufio',
  'crypto',
  'encoding',
  'filepath',
  'hash',
  'mime',
  'rand',
  'signal',
  'sql',
  'syscall',
  'unicode',
  'unsafe',
  'atomic',
  'binary',
  'debug',
  'exec',
  'heap',
  'ring',
  'scanner',
  'tar',
  'zip',
  'gzip',
  'zlib',
  'tls',
  'url',
  'user',
  'pprof',
  'trace',
  'ast',
  'build',
  'parser',
  'printer',
  'token',
  'types',
  'cgo',
  'plugin',
  'race',
  'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime',
  'utilwait',
  'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make',
  'new',
  'len',
  'cap',
  'append',
  'copy',
  'delete',
  'close',
  'panic',
  'recover',
  'print',
  'println',
  'complex',
  'real',
  'imag',
  'error',
  'nil',
  'true',
  'false',
  'iota',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'string',
  'bool',
  'byte',
  'rune',
  'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.',
  'Winapi.',
  'Vcl.',
  'Fmx.',
  'Data.',
  'Datasnap.',
  'Soap.',
  'Xml.',
  'Web.',
  'REST.',
  'FireDAC.',
  'IBX.',
  'IdHTTP',
  'IdTCP',
  'IdSSL',
];

const PASCAL_BUILT_INS = new Set([
  'System',
  'SysUtils',
  'Classes',
  'Types',
  'Variants',
  'StrUtils',
  'Math',
  'DateUtils',
  'IOUtils',
  'Generics.Collections',
  'Generics.Defaults',
  'Rtti',
  'TypInfo',
  'SyncObjs',
  'RegularExpressions',
  'SysInit',
  'Windows',
  'Messages',
  'Graphics',
  'Controls',
  'Forms',
  'Dialogs',
  'StdCtrls',
  'ExtCtrls',
  'ComCtrls',
  'Menus',
  'ActnList',
  'WriteLn',
  'Write',
  'ReadLn',
  'Read',
  'Inc',
  'Dec',
  'Ord',
  'Chr',
  'Length',
  'SetLength',
  'High',
  'Low',
  'Assigned',
  'FreeAndNil',
  'Format',
  'IntToStr',
  'StrToInt',
  'FloatToStr',
  'StrToFloat',
  'Trim',
  'UpperCase',
  'LowerCase',
  'Pos',
  'Copy',
  'Delete',
  'Insert',
  'Now',
  'Date',
  'Time',
  'DateToStr',
  'StrToDate',
  'Raise',
  'Exit',
  'Break',
  'Continue',
  'Abort',
  'True',
  'False',
  'nil',
  'Self',
  'Result',
  'Create',
  'Destroy',
  'Free',
  'TObject',
  'TComponent',
  'TPersistent',
  'TInterfacedObject',
  'TList',
  'TStringList',
  'TStrings',
  'TStream',
  'TMemoryStream',
  'TFileStream',
  'Exception',
  'EAbort',
  'EConvertError',
  'EAccessViolation',
  'IInterface',
  'IUnknown',
]);

// `isJsFamily` from utils.ts is the canonical JS-family predicate;
// re-aliased here for the existing call sites in this file.
const isJsTsLanguage = (lang: string): boolean => isJsFamily(lang);

/**
 * Per-language built-in/external check for JS/TS — covers the
 * built-in identifier set, the common-library dotted prefixes
 * (`console.*`, `Math.*`, `JSON.*`), and the React hook list.
 */
function isJsTsBuiltInRef(name: string): boolean {
  if (JS_BUILT_INS.has(name)) return true;
  if (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.')) return true;
  if (REACT_HOOKS.has(name)) return true;
  return false;
}

/**
 * Per-language built-in/external check for Python — covers bare
 * built-ins, dotted built-in-type calls (list.append, dict.update),
 * and built-in method names on non-class receivers. The capitalised-
 * receiver guard lets `MyClass.pop` survive when `MyClass` is a known
 * codebase class even though `pop` is also a built-in method.
 */
function isPythonBuiltInRef(name: string, knownNames: Set<string> | null | undefined): boolean {
  if (PYTHON_BUILT_INS.has(name)) return true;
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const receiver = name.substring(0, dotIdx);
    const method = name.substring(dotIdx + 1);
    if (PYTHON_BUILT_IN_TYPES.has(receiver)) return true;
    if (PYTHON_BUILT_IN_METHODS.has(method)) {
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (!knownNames?.has(capitalized)) return true;
    }
  }
  return PYTHON_BUILT_IN_METHODS.has(name);
}

/** Per-language check for Go: stdlib package prefixes + bare built-ins. */
function isGoBuiltInRef(name: string): boolean {
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0 && GO_STDLIB_PACKAGES.has(name.substring(0, dotIdx))) return true;
  return GO_BUILT_INS.has(name);
}

/** Per-language check for Pascal/Delphi: stdlib unit prefixes + bare built-ins. */
function isPascalBuiltInRef(name: string): boolean {
  if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) return true;
  return PASCAL_BUILT_INS.has(name);
}

/**
 * Stable identity key matching the `edges` unique index
 * `(source, target, kind, COALESCE(line, -1), COALESCE(col, -1))`.
 * Used to correlate `insertEdges`'s survivor list back to the
 * `ResolvedRef[]` that generated it — see {@link persistResolvedBatch}
 * for the load-bearing rationale.
 */
function edgeIdentityKey(e: {
  source: string;
  target: string;
  kind: string;
  line?: number | null;
  column?: number | null;
}): string {
  return `${e.source}\0${e.target}\0${e.kind}\0${e.line ?? -1}\0${e.column ?? -1}`;
}

/**
 * Build the edge-identity key for what a `ResolvedRef` WOULD produce
 * via `createEdges` — mirrors the source/target/kind/line/column
 * fields {@link Resolver.createEdges} emits. The kind goes through
 * `resolverPromoteExtendsToImplements` so the key matches the exact
 * kind that `insertEdges` saw.
 */
function resolvedRefEdgeKey(queries: QueryBuilder, r: ResolvedRef): string {
  return edgeIdentityKey({
    source: r.original.fromNodeId,
    target: r.targetNodeId,
    kind: resolverPromoteExtendsToImplements(queries, r),
    line: r.original.line,
    column: r.original.column,
  });
}

/**
 * Persist one batch's resolved edges and delete its handled rows
 * (both resolved and unresolved) from `unresolved_refs` so the next
 * read of offset 0 returns fresh work.
 *
 * Handoff #10 (root cause): a resolved ref whose corresponding edge
 * gets silently dropped by `insertEdges`'s endpoint check (source or
 * target node no longer exists in `nodes`) used to STILL have its
 * `unresolved_refs` row deleted — silent edge loss. Now we correlate
 * the survivor set returned by {@link insertEdges} against
 * `result.resolved` and only delete the refs whose edges actually
 * made it through. Refs whose edges were dropped due to a dead
 * endpoint stay in `unresolved_refs` — they're either dead permanently
 * (FK CASCADE will eventually purge them when their source node is
 * deleted) or will resolve on a future sync when the source-file
 * re-extracts and writes fresh refs.
 */
/**
 * Returned `deletedCount` is a LOWER-BOUND on the actual rows
 * removed from `unresolved_refs`: `deleteSpecificResolvedReferences`
 * deletes by `(from_node_id, reference_name, reference_kind)` —
 * duplicate tuples at different `(line, col)` (same call site
 * coalesced into multiple rows by an unusual sync sequence) all
 * disappear in one DELETE but count as one toward the returned
 * total. Safe for the only consumer (the `resolveAndPersistBatched`
 * loop's `deletedCount === 0` exit guard): an under-count can only
 * make the loop exit SOONER, never spin longer.
 */
function persistResolvedBatch(queries: QueryBuilder, edges: Edge[], result: ResolutionResult): number {
  const survivorKeys = new Set<string>();
  if (edges.length > 0) {
    const survivors = insertEdges(queries, edges);
    for (const e of survivors) survivorKeys.add(edgeIdentityKey(e));
  }
  let deletedCount = 0;
  if (result.resolved.length > 0) {
    const trulyResolved = result.resolved.filter((r) => survivorKeys.has(resolvedRefEdgeKey(queries, r)));
    if (trulyResolved.length > 0) {
      deleteSpecificResolvedReferences(
        queries,
        trulyResolved.map((r) => ({
          fromNodeId: r.original.fromNodeId,
          referenceName: r.original.referenceName,
          referenceKind: r.original.referenceKind,
        })),
      );
      deletedCount += trulyResolved.length;
    }
  }
  if (result.unresolved.length > 0) {
    deleteSpecificResolvedReferences(
      queries,
      result.unresolved.map((r) => ({
        fromNodeId: r.fromNodeId,
        referenceName: r.referenceName,
        referenceKind: r.referenceKind,
      })),
    );
    deletedCount += result.unresolved.length;
  }
  return deletedCount;
}

/**
 * Build the metadata blob for a resolved-ref edge: confidence/method
 * are always set; tieMargin and siteCount/extraLines flow through
 * only when the resolver actually saw them.
 */
function buildResolvedEdgeMetadata(ref: ResolvedRef): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    confidence: ref.confidence,
    resolvedBy: ref.resolvedBy,
  };
  // Forward the tie-margin signal so consumers that unpack the
  // metadata JSON can see the underlying number that drove the
  // AMBIGUOUS classification on the categorical column.
  if (typeof ref.tieMargin === 'number') {
    metadata['tieMargin'] = ref.tieMargin;
  }
  // Forward call-site multiplicity from the extractor's dedup.
  // siteCount > 1 means the same (caller, callee, kind) edge stood
  // in for N call sites; consumers (cartograph_callers, etc.) can
  // surface that to avoid understating real usage.
  if (ref.original.siteCount && ref.original.siteCount > 1) {
    metadata['siteCount'] = ref.original.siteCount;
    if (ref.original.extraLines && ref.original.extraLines.length > 0) {
      metadata['extraLines'] = ref.original.extraLines;
    }
  }
  return metadata;
}

/** Fold one batch's stats into the running aggregate counters. */
function foldBatchStats(
  aggregate: { total: number; resolved: number; unresolved: number; byMethod: Record<string, number> },
  batch: { total: number; resolved: number; unresolved: number; byMethod: Record<string, number> },
): void {
  aggregate.total += batch.total;
  aggregate.resolved += batch.resolved;
  aggregate.unresolved += batch.unresolved;
  for (const [method, count] of Object.entries(batch.byMethod)) {
    aggregate.byMethod[method] = (aggregate.byMethod[method] || 0) + count;
  }
}

/**
 * Mutable cache fields for ReferenceResolver — grouped into a single
 * object so the class field count stays low while the caches remain
 * fully mutable through the resolver's lifetime.
 */
interface ResolverCaches {
  nodeCache: Map<string, Node[]>;
  fileCache: Map<string, string | null>;
  importMappingCache: Map<string, ImportMapping[]>;
  reExportCache: Map<string, ReExport[]>;
  nameCache: Map<string, Node[]>;
  lowerNameCache: Map<string, Node[]>;
  qualifiedNameCache: Map<string, Node[]>;
  knownNames: Set<string> | null;
  knownFiles: Set<string> | null;
  cachesWarmed: boolean;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Immutable once set.
  projectAliases: AliasMap | null | undefined;
}

/** Factory — returns a freshly-zeroed cache bundle. */
function resolverMakeCaches(): ResolverCaches {
  return {
    nodeCache: new Map(),
    fileCache: new Map(),
    importMappingCache: new Map(),
    reExportCache: new Map(),
    nameCache: new Map(),
    lowerNameCache: new Map(),
    qualifiedNameCache: new Map(),
    knownNames: null,
    knownFiles: null,
    cachesWarmed: false,
    projectAliases: undefined,
  };
}

/**
 * Cached file read — falls back to disk on miss, persists `null`
 * on read failure so the cost is paid at most once per file.
 */
function resolverReadFileCached(caches: ResolverCaches, projectRoot: string, filePath: string): string | null {
  if (caches.fileCache.has(filePath)) return caches.fileCache.get(filePath)!;
  const fullPath = path.join(projectRoot, filePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    caches.fileCache.set(filePath, content);
    return content;
  } catch (error) {
    logDebug('Failed to read file for resolution', { filePath, error: String(error) });
    caches.fileCache.set(filePath, null);
    return null;
  }
}

/** Existence check — checks the pre-built `knownFiles` set first, falls back to fs.existsSync. */
function resolverFileExistsCached(caches: ResolverCaches, projectRoot: string, filePath: string): boolean {
  if (caches.knownFiles) {
    const normalized = filePath.replaceAll('\\', '/');
    if (caches.knownFiles.has(filePath) || caches.knownFiles.has(normalized)) return true;
  }
  const fullPath = path.join(projectRoot, filePath);
  try {
    return fs.existsSync(fullPath);
  } catch (error) {
    logDebug('Error checking file existence', { filePath, error: String(error) });
    return false;
  }
}

/**
 * The cached symbol-lookup wrappers (by file / by name / by qualified
 * name / by lower-cased name). Returned as a partial context that
 * `resolverCreateContext` spreads into the final object.
 */
function resolverBuildSymbolLookups(
  caches: ResolverCaches,
  queries: QueryBuilder,
): Pick<
  ResolutionContext,
  'getNodesInFile' | 'getNodesByName' | 'getNodesByQualifiedName' | 'getNodesByLowerName' | 'getNodesByKind'
> {
  return {
    getNodesInFile: (filePath) => {
      if (!caches.nodeCache.has(filePath)) {
        caches.nodeCache.set(filePath, queries.getNodesByFile(filePath));
      }
      return caches.nodeCache.get(filePath)!;
    },
    getNodesByName: (name) => {
      const cached = caches.nameCache.get(name);
      if (cached !== undefined) return cached;
      const result = getNodesByName(queries, name);
      caches.nameCache.set(name, result);
      return result;
    },
    getNodesByQualifiedName: (qualifiedName) => {
      const cached = caches.qualifiedNameCache.get(qualifiedName);
      if (cached !== undefined) return cached;
      const result = getNodesByQualifiedNameExact(queries, qualifiedName);
      caches.qualifiedNameCache.set(qualifiedName, result);
      return result;
    },
    getNodesByLowerName: (lowerName) => {
      const cached = caches.lowerNameCache.get(lowerName);
      if (cached !== undefined) return cached;
      const result = getNodesByLowerName(queries, lowerName);
      caches.lowerNameCache.set(lowerName, result);
      return result;
    },
    getNodesByKind: (kind: Node['kind']) => getNodesByKind(queries, kind),
  };
}

/** File-IO context methods + project-aliases lookup. */
function resolverBuildFileLookups(
  caches: ResolverCaches,
  projectRoot: string,
  queries: QueryBuilder,
): Pick<ResolutionContext, 'fileExists' | 'readFile' | 'getProjectRoot' | 'getAllFiles' | 'getProjectAliases'> {
  return {
    fileExists: (filePath) => resolverFileExistsCached(caches, projectRoot, filePath),
    readFile: (filePath) => resolverReadFileCached(caches, projectRoot, filePath),
    getProjectRoot: () => projectRoot,
    getAllFiles: () => getAllFilePaths(queries),
    getProjectAliases: () => {
      if (caches.projectAliases === undefined) {
        caches.projectAliases = loadProjectAliases(projectRoot);
      }
      return caches.projectAliases;
    },
  };
}

/**
 * Import / re-export extractors — both share the "read file then
 * cache the extracted result" pattern.
 */
function resolverBuildImportLookups(
  caches: ResolverCaches,
  projectRoot: string,
): Pick<ResolutionContext, 'getImportMappings' | 'getReExports'> {
  return {
    getImportMappings: (filePath, language) => {
      const cached = caches.importMappingCache.get(filePath);
      if (cached) return cached;
      const content = resolverReadFileCached(caches, projectRoot, filePath);
      if (!content) {
        caches.importMappingCache.set(filePath, []);
        return [];
      }
      const mappings = extractImportMappings(filePath, content, language);
      caches.importMappingCache.set(filePath, mappings);
      return mappings;
    },
    getReExports: (filePath, language) => {
      const cached = caches.reExportCache.get(filePath);
      if (cached) return cached;
      const content = resolverReadFileCached(caches, projectRoot, filePath);
      if (!content) {
        caches.reExportCache.set(filePath, []);
        return [];
      }
      const reExports = extractReExports(content, language);
      caches.reExportCache.set(filePath, reExports);
      return reExports;
    },
  };
}

/** Compose the full resolution context from all lookup groups. */
function resolverCreateContext(caches: ResolverCaches, projectRoot: string, queries: QueryBuilder): ResolutionContext {
  return {
    ...resolverBuildSymbolLookups(caches, queries),
    ...resolverBuildFileLookups(caches, projectRoot, queries),
    ...resolverBuildImportLookups(caches, projectRoot),
  };
}

/** Convert wire-format refs to internal `UnresolvedRef` shape. */
function resolverPrepareUnresolvedRefs(queries: QueryBuilder, unresolvedRefs: UnresolvedReference[]): UnresolvedRef[] {
  return unresolvedRefs.map((ref) =>
    compact({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || resolverGetFilePathFromNodeId(queries, ref.fromNodeId),
      language: ref.language || resolverGetLanguageFromNodeId(queries, ref.fromNodeId),
      siteCount: ref.siteCount,
      extraLines: ref.extraLines,
    }),
  );
}

/** Check if a dot-separated qualified name has any known part. */
function resolverCheckDotQualifiedParts(name: string, names: Set<string>): boolean {
  const dotIdx = name.indexOf('.');
  if (dotIdx <= 0) return false;
  const receiver = name.substring(0, dotIdx);
  const member = name.substring(dotIdx + 1);
  if (names.has(receiver) || names.has(member)) return true;
  const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
  return names.has(capitalized);
}

/** Check if a double-colon-separated qualified name has any known part. */
function resolverCheckColonQualifiedParts(name: string, names: Set<string>): boolean {
  const colonIdx = name.indexOf('::');
  if (colonIdx <= 0) return false;
  const receiver = name.substring(0, colonIdx);
  const member = name.substring(colonIdx + 2);
  return names.has(receiver) || names.has(member);
}

/** Check if a path-like reference has a known filename. */
function resolverCheckPathLikeFilename(name: string, names: Set<string>): boolean {
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx <= 0) return false;
  const fileName = name.substring(slashIdx + 1);
  return names.has(fileName);
}

/** Check if a backslash-qualified reference (a PHP/C# FQCN like
 *  `Drupal\my_module\Cleaner` or `\App\Service\Foo`) has a known last
 *  segment. Without this, FQCN refs that lack a `::method` suffix were
 *  skipped before any framework resolver ran — the colon check only
 *  catches the `Class::member` form. */
function resolverCheckBackslashQualifiedParts(name: string, names: Set<string>): boolean {
  const idx = name.lastIndexOf('\\');
  if (idx < 0) return false;
  const last = name.substring(idx + 1);
  return last.length > 0 && names.has(last);
}

/**
 * Check if a reference name has any possible match in the codebase.
 * Uses the pre-built knownNames set to skip expensive resolution
 * for names that definitely don't exist as symbols.
 */
function resolverHasAnyPossibleMatch(caches: ResolverCaches, name: string): boolean {
  if (!caches.knownNames) return true;
  if (caches.knownNames.has(name)) return true;
  if (resolverCheckDotQualifiedParts(name, caches.knownNames)) return true;
  if (resolverCheckColonQualifiedParts(name, caches.knownNames)) return true;
  if (resolverCheckPathLikeFilename(name, caches.knownNames)) return true;
  if (resolverCheckBackslashQualifiedParts(name, caches.knownNames)) return true;
  return false;
}

/**
 * Third-chance pre-filter: does any DETECTED framework explicitly claim
 * this reference name? A framework's optional `claimsReference` opts a
 * name past the known-node gate so its `resolve()` can see selector-shape
 * refs (e.g. ObjC `fooWithBar:`) that no graph node is named after.
 */
function resolverAnyFrameworkClaims(frameworks: FrameworkResolver[], name: string): boolean {
  return frameworks.some((f) => f.claimsReference?.(name) === true);
}

/**
 * Second-chance pre-filter for refs whose `referenceName` is a
 * file-local alias rather than an exported symbol.
 */
function resolverMatchesLocalImportAlias(context: ResolutionContext, ref: UnresolvedRef): boolean {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0) return false;
  for (const imp of imports) {
    if (imp.localName === ref.referenceName) return true;
    if (imp.isNamespace && ref.referenceName.startsWith(imp.localName + '.')) return true;
  }
  return false;
}

/**
 * Run every framework resolver in turn. Short-circuits and returns when one
 * produces ≥0.9 confidence; otherwise appends every result to `candidates`
 * and returns null (caller continues to strategy 2).
 */
interface ResolverTryFrameworkResolutionArgs {
  frameworks: FrameworkResolver[];
  context: ResolutionContext;
  ref: UnresolvedRef;
  candidates: ResolvedRef[];
}

function resolverTryFrameworkResolution(args: ResolverTryFrameworkResolutionArgs): ResolvedRef | null {
  const { frameworks, context, ref, candidates } = args;
  for (const framework of frameworks) {
    const result = framework.resolve(ref, context);
    if (!result) continue;
    if (result.confidence >= 0.9) return result;
    candidates.push(result);
  }
  return null;
}

/**
 * Promote a kind=extends edge to `implements` when the source is a
 * class/struct and the target is an interface/protocol.
 */
function resolverPromoteExtendsToImplements(queries: QueryBuilder, ref: ResolvedRef): EdgeKind {
  const kind = ref.original.referenceKind;
  if (kind !== 'extends') return kind;
  const targetNode = queries.getNodeById(ref.targetNodeId);
  if (!targetNode || (targetNode.kind !== 'interface' && targetNode.kind !== 'protocol')) return kind;
  const sourceNode = queries.getNodeById(ref.original.fromNodeId);
  if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
    return 'implements';
  }
  return kind;
}

/**
 * Check if reference is to a built-in or external symbol. Per-
 * language predicates live as free functions; this is a thin language-router.
 */
function resolverIsBuiltInOrExternal(caches: ResolverCaches, ref: UnresolvedRef): boolean {
  const name = ref.referenceName;
  const lang = ref.language;
  if (isJsTsLanguage(lang) && isJsTsBuiltInRef(name)) return true;
  if (lang === 'python' && isPythonBuiltInRef(name, caches.knownNames)) return true;
  if (lang === 'go' && isGoBuiltInRef(name)) return true;
  if (lang === 'pascal' && isPascalBuiltInRef(name)) return true;
  return false;
}

/** Get file path from node ID. */
function resolverGetFilePathFromNodeId(queries: QueryBuilder, nodeId: string): string {
  const node = queries.getNodeById(nodeId);
  return node?.filePath || '';
}

/** Get language from node ID. */
function resolverGetLanguageFromNodeId(queries: QueryBuilder, nodeId: string): UnresolvedRef['language'] {
  const node = queries.getNodeById(nodeId);
  return node?.language || 'unknown';
}

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  /** All mutable cache state in one bundle (reduces field count). */
  private caches: ResolverCaches;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.queries = queries;
    this.caches = resolverMakeCaches();
    this.context = resolverCreateContext(this.caches, projectRoot, queries);
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.caches.cachesWarmed) return;
    // Re-detect frameworks now that the index is populated. `initialize()`
    // runs at resolver CREATION (`createResolver`), before extraction — so
    // any `getAllFiles()`-based `detect()` (swift-objc / swiftUI / uikit)
    // saw an empty index and matched nothing. Disk-based detects (drupal via
    // composer.json) were unaffected, which masked the bug. warmCaches runs
    // once per resolution pass (post-extraction), so this re-detect is the
    // single place that gives every resolver a populated index to detect on.
    this.frameworks = detectFrameworks(this.context);
    this.caches.knownFiles = new Set(getAllFilePaths(this.queries));
    this.caches.knownNames = new Set(this.queries.getAllNodeNames());
    this.caches.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    // Let framework resolvers drop any per-context memoized state (e.g. the
    // swift-objc reverse-bridge map built from ObjC method nodes) so it can't
    // go stale across a sync that reuses this same long-lived context.
    for (const framework of this.frameworks) framework.clearCache?.(this.context);
    this.caches.nodeCache.clear();
    this.caches.fileCache.clear();
    this.caches.importMappingCache.clear();
    this.caches.reExportCache.clear();
    this.caches.nameCache.clear();
    this.caches.lowerNameCache.clear();
    this.caches.qualifiedNameCache.clear();
    this.caches.knownNames = null;
    this.caches.knownFiles = null;
    this.caches.cachesWarmed = false;
  }

  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void,
  ): ResolutionResult {
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};
    const refs = resolverPrepareUnresolvedRefs(this.queries, unresolvedRefs);
    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    if (onProgress && total > 0) onProgress(total, total);
    return {
      resolved,
      unresolved,
      stats: { total: refs.length, resolved: resolved.length, unresolved: unresolved.length, byMethod },
    };
  }

  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    if (resolverIsBuiltInOrExternal(this.caches, ref)) return null;

    if (
      !resolverHasAnyPossibleMatch(this.caches, ref.referenceName) &&
      !resolverMatchesLocalImportAlias(this.context, ref) &&
      !resolverAnyFrameworkClaims(this.frameworks, ref.referenceName)
    ) {
      return null;
    }

    const candidates: ResolvedRef[] = [];

    const fromFramework = resolverTryFrameworkResolution({
      frameworks: this.frameworks,
      context: this.context,
      ref,
      candidates,
    });
    if (fromFramework) return fromFramework;

    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    const nameResult = matchReference(ref, this.context);
    if (nameResult) candidates.push(nameResult);

    return pickWinnerWithTieMargin(candidates);
  }

  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => ({
      source: ref.original.fromNodeId,
      target: ref.targetNodeId,
      kind: resolverPromoteExtendsToImplements(this.queries, ref),
      line: ref.original.line,
      column: ref.original.column,
      metadata: buildResolvedEdgeMetadata(ref),
      confidence: classifyConfidence(ref.resolvedBy, ref.confidence, ref.tieMargin),
    }));
  }

  /**
   * Resolve and persist scoped to an input ref list (Pass A+B's
   * canonical entry point). Unlike `resolveAndPersistBatched`, leaves
   * UNRESOLVED rows in place so a future sync can retry them — see
   * `reconstructCrossFileRefsToFile` for the lifecycle contract that
   * depends on this.
   *
   * Handoff #10: only refs whose corresponding edge survived
   * `insertEdges`'s endpoint check are deleted from `unresolved_refs`.
   * A ref whose source/target node got cascade-deleted between
   * resolve and insert used to vanish silently along with its edge;
   * now the row survives and gets retried (or eventually cleaned by
   * the FK CASCADE on `from_node_id`).
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void,
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);
    const edges = this.createEdges(result.resolved);
    const survivorKeys = new Set<string>();
    if (edges.length > 0) {
      const survivors = insertEdges(this.queries, edges);
      for (const e of survivors) survivorKeys.add(edgeIdentityKey(e));
    }
    if (result.resolved.length > 0) {
      const trulyResolved = result.resolved.filter((r) => survivorKeys.has(resolvedRefEdgeKey(this.queries, r)));
      if (trulyResolved.length > 0) {
        deleteSpecificResolvedReferences(
          this.queries,
          trulyResolved.map((r) => ({
            fromNodeId: r.original.fromNodeId,
            referenceName: r.original.referenceName,
            referenceKind: r.original.referenceKind,
          })),
        );
      }
    }
    return result;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   *
   * Handoff #10 semantics: refs that name-match in `resolveAll` but
   * whose corresponding edge gets dropped by `insertEdges`'s endpoint
   * check (dead source / target node) are NOT deleted from
   * `unresolved_refs` — they're left for a future sync to retry, or
   * for FK CASCADE on `from_node_id` to eventually reap. The
   * `aggregateStats.resolved` counter still reflects the
   * name-matched count, NOT the count of edges actually written;
   * consumers comparing that to `edges` row growth will see a small
   * delta under the orphan scenario.
   *
   * `onProgress` semantics (B3, 2026-05-23): `current` counts refs
   * REMOVED from the queue, not refs read. When orphan refs survive
   * across iterations (Handoff #10 case) the callback's `current` may
   * stop short of `total` at termination — accurate, since those refs
   * really weren't resolved. Pre-fix the counter used `batch.length`
   * and could overshoot `total` (observed 122% on microsoft/TypeScript).
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000,
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = getUnresolvedReferencesCount(this.queries);
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    while (true) {
      const batch = getUnresolvedReferencesBatch(this.queries, 0, batchSize);
      if (batch.length === 0) break;

      const result = this.resolveAll(batch);
      const deletedCount = persistResolvedBatch(this.queries, this.createEdges(result.resolved), result);
      foldBatchStats(aggregateStats, result.stats);

      // Count REFS REMOVED FROM THE QUEUE, not refs read. `batch` is
      // always read at offset 0, so any handoff #10 orphan refs the
      // prior iteration left behind get re-counted on every subsequent
      // read. Using `batch.length` caused the reported progress to
      // ratchet past 100% on repos with stuck orphan refs (observed
      // 406921/331994 = 122% on microsoft/TypeScript). `deletedCount`
      // is the survivors-only count from `persistResolvedBatch`; orphan
      // refs that pass name-match but fail the endpoint check do NOT
      // bump it, so `processed` may stop short of `total` — that's
      // accurate (the orphans really weren't resolved) instead of
      // overcounting.
      processed += deletedCount;
      onProgress?.(processed, total);

      await new Promise((resolve) => setImmediate(resolve));

      // Termination guards (BOTH required for correctness):
      //   1. No-progress on the resolve/unresolve split: nothing new
      //      resolved AND the whole batch was truly-unresolved (the
      //      pre-#10 contract).
      //   2. No-progress on the DELETE side: handoff #10's fix leaves
      //      orphan refs (name-matched but edge-dropped at the endpoint
      //      check) in `unresolved_refs`. Those refs land in
      //      `result.resolved` (passed name-match) but `deletedCount`
      //      excludes them, so they re-emerge in the next batch's
      //      offset-0 read forever. `deletedCount === 0` is the
      //      load-bearing exit when the only refs left are orphans the
      //      next pass also can't clear.
      if (result.resolved.length === 0 && result.unresolved.length === batch.length) break;
      if (deletedCount === 0) break;
    }

    return { resolved: [], unresolved: [], stats: aggregateStats };
  }

  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }
}

/**
 * Pick the highest-confidence candidate from a multi-strategy resolution
 * pass and stamp it with the gap to the best different-target runner-up so
 * #8's classifier can flag near-ties as AMBIGUOUS. Same-target candidates
 * reinforce (not contest) the winner, so they don't count toward the gap.
 */
function pickWinnerWithTieMargin(candidates: ResolvedRef[]): ResolvedRef | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const winner = sorted[0]!;
  const runnerUp = sorted.slice(1).find((c) => c.targetNodeId !== winner.targetNodeId);
  if (!runnerUp) return winner;
  return { ...winner, tieMargin: winner.confidence - runnerUp.confidence };
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
