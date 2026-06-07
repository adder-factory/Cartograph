/**
 * Cross-file biomarker rule: `illegal_import`.
 *
 * Evaluates user-defined architectural layering constraints (from
 * `CartographConfig.layers`) against the `imports` edges already in
 * the knowledge graph. Returns findings — DB write and diagnostic-
 * path filtering are handled by the caller via `runCrossFileRule`.
 */

import * as path from 'node:path';
import { compileGlob } from '../glob.js';
import type { QueryBuilder } from '../db/queries.js';
import { getAllFilePaths } from '../db/queries-files.js';
import { logWarn } from '../errors.js';
import type { LayerConfig, LayerException } from './layering-types.js';
import type { Finding } from './types.js';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const IMPORT_EDGES_SQL = `
  SELECT s.id   AS importer_id,
         s.file_path AS importer_file,
         t.id   AS import_node_id,
         t.name AS spec
  FROM edges e
  JOIN nodes s ON e.source = s.id
  JOIN nodes t ON e.target = t.id
  WHERE e.kind = 'imports' AND t.kind = 'import'
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.py', '.go', '.rs', '.java'];

interface ResolveSpecToIndexedArgs {
  importerAbs: string;
  spec: string;
  projectRootAbs: string;
  indexedRelSet: ReadonlySet<string>;
}

/** True when `spec` is a relative path (`./`, `../`, `.`, `..`). */
function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

/**
 * Resolve the absolute filesystem path for a relative-or-absolute spec,
 * then convert to a project-root-relative POSIX path.
 */
function specToResolvedRel(importerAbs: string, spec: string, projectRootAbs: string): string {
  const isAbsolute = spec.startsWith('/');
  const fromDir = path.dirname(importerAbs);
  const resolvedAbs = isAbsolute ? path.resolve(projectRootAbs, spec.replace(/^\/+/, '')) : path.resolve(fromDir, spec);
  return toRelPosix(resolvedAbs, projectRootAbs);
}

/**
 * NodeNext / ESM rewrite probe: spec ends in `.js`/`.mjs`/`.cjs`/`.jsx`
 * but the indexed source is `.ts`/`.tsx`/`.d.ts`. Returns the indexed
 * path on a match, or `null`.
 */
function resolveJsToTs(resolvedRel: string, indexedRelSet: ReadonlySet<string>): string | null {
  const jsExtMatch = /\.(js|jsx|mjs|cjs)$/.exec(resolvedRel);
  if (!jsExtMatch) return null;
  const stemRel = resolvedRel.slice(0, -jsExtMatch[0].length);
  for (const tsExt of ['.ts', '.tsx', '.d.ts']) {
    const candidate = stemRel + tsExt;
    if (indexedRelSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Extension-less and directory-index probes. Tries `<resolvedRel><ext>`
 * for every known extension, then `<resolvedRel>/index<ext>`. Returns
 * the first indexed hit, or `null`.
 */
function resolveByExtPermutations(resolvedRel: string, indexedRelSet: ReadonlySet<string>): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = resolvedRel + ext;
    if (indexedRelSet.has(candidate)) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = resolvedRel === '' ? `index${ext}` : `${resolvedRel}/index${ext}`;
    if (indexedRelSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a relative/absolute import specifier to a project-root-relative
 * POSIX path that exists in the index. Looks up against `indexedRelSet`
 * — no filesystem I/O. Handles the NodeNext convention where source
 * imports end in `.js` but the file on disk is `.ts`/`.tsx`/`.d.ts`.
 */
function resolveSpecToIndexed({
  importerAbs,
  spec,
  projectRootAbs,
  indexedRelSet,
}: ResolveSpecToIndexedArgs): string | null {
  const specIsRelative = isRelativeSpec(spec);
  const specIsAbsolute = spec.startsWith('/');
  const isBarePackage = !specIsRelative && !specIsAbsolute;

  if (isBarePackage) {
    // bare package import — not subject to in-repo layering
    return null;
  }

  const resolvedRel = specToResolvedRel(importerAbs, spec, projectRootAbs);

  // Direct hit — spec carries the real extension and the file is indexed.
  if (indexedRelSet.has(resolvedRel)) return resolvedRel;

  return resolveJsToTs(resolvedRel, indexedRelSet) ?? resolveByExtPermutations(resolvedRel, indexedRelSet);
}

/** Map an absolute file path to a project-root-relative POSIX path. */
function toRelPosix(absFile: string, projectRootAbs: string): string {
  return path.relative(projectRootAbs, absFile).split(path.sep).join('/');
}

type Matcher = (p: string) => boolean;

interface CompiledLayer {
  name: string;
  config: LayerConfig;
  pathMatchers: Matcher[];
}

interface LayerMatch {
  name: string;
  config: LayerConfig;
}

/**
 * Pre-compile glob matchers for every layer's `paths` globs ONCE,
 * so the per-row hot loop doesn't re-compile.
 */
function compileLayers(layers: LayerConfig[]): CompiledLayer[] {
  return layers.map((layer) => ({
    name: layer.name,
    config: layer,
    pathMatchers: layer.paths.map((g) => compileGlob(g)),
  }));
}

/** First-match-wins layer lookup by project-root-relative POSIX path. */
function matchLayer(relPosix: string, compiled: CompiledLayer[]): LayerMatch | null {
  for (const layer of compiled) {
    for (const m of layer.pathMatchers) {
      if (m(relPosix)) return { name: layer.name, config: layer.config };
    }
  }
  return null;
}

/**
 * Expand a canImport / cannotImport entry into a list of compiled
 * matchers. If the entry matches a layer name, return that layer's
 * pre-compiled `pathMatchers`. Otherwise compile the entry as a raw
 * glob (cached per-call by the caller via `matcherCacheFor`).
 */
function entryMatchers(entry: string, compiled: CompiledLayer[], rawCache: Map<string, Matcher>): Matcher[] {
  const byName = compiled.find((l) => l.name === entry);
  if (byName) return byName.pathMatchers;
  let m = rawCache.get(entry);
  if (!m) {
    m = compileGlob(entry);
    rawCache.set(entry, m);
  }
  return [m];
}

/** True when `relPosix` matches at least one of `matchers`. */
function matchesAny(relPosix: string, matchers: Matcher[]): boolean {
  return matchers.some((m) => m(relPosix));
}

// ---------------------------------------------------------------------------
// Row shape returned by IMPORT_EDGES_SQL
// ---------------------------------------------------------------------------

interface ImportRow {
  importer_id: string;
  importer_file: string;
  import_node_id: string;
  spec: string;
}

// ---------------------------------------------------------------------------
// Internal helpers — violation / exception logic
// ---------------------------------------------------------------------------

interface CheckViolationArgs {
  toLayer: string;
  targetRel: string;
  canImport: string[] | undefined;
  cannotImport: string[] | undefined;
  compiled: CompiledLayer[];
  rawMatcherCache: Map<string, Matcher>;
}

/**
 * Determine whether a cross-layer import violates the source layer's policy.
 *
 * Deny-list (`cannotImport`) wins over allow-list when both are present —
 * that conflict is warned about upstream in `validateLayerConflicts`.
 * Returns `true` when the import is a policy violation.
 */
function isImportViolated({
  toLayer,
  targetRel,
  canImport,
  cannotImport,
  compiled,
  rawMatcherCache,
}: CheckViolationArgs): boolean {
  if (cannotImport && cannotImport.length > 0) {
    // Deny-list: fire when target layer name OR target file matches any entry.
    for (const entry of cannotImport) {
      const matchers = entryMatchers(entry, compiled, rawMatcherCache);
      if (toLayer === entry || matchesAny(targetRel, matchers)) return true;
    }
    return false;
  }

  if (canImport && canImport.length > 0) {
    // Allow-list: fire when target is NOT covered by any allow entry.
    for (const entry of canImport) {
      const matchers = entryMatchers(entry, compiled, rawMatcherCache);
      if (toLayer === entry || matchesAny(targetRel, matchers)) return false;
    }
    return true;
  }

  // No policy declared for this layer — nothing to enforce.
  return false;
}

interface CheckExceptionArgs {
  importerAbs: string;
  toLayer: string;
  targetRel: string;
  exceptions: LayerException[];
  projectRootAbs: string;
  compiled: CompiledLayer[];
  rawMatcherCache: Map<string, Matcher>;
}

/**
 * Returns `true` when a per-file exception explicitly allows the import,
 * meaning the finding should be suppressed.
 */
function isExceptionAllowed({
  importerAbs,
  toLayer,
  targetRel,
  exceptions,
  projectRootAbs,
  compiled,
  rawMatcherCache,
}: CheckExceptionArgs): boolean {
  const exc = exceptions.find((e) => {
    const excFileAbs = path.resolve(projectRootAbs, e.file);
    return excFileAbs === importerAbs;
  });
  if (!exc) return false;

  for (const entry of exc.canImport) {
    const matchers = entryMatchers(entry, compiled, rawMatcherCache);
    if (toLayer === entry || matchesAny(targetRel, matchers)) return true;
  }
  return false;
}

interface BuildFindingArgs {
  importNodeId: string;
  fromLayer: string;
  toLayer: string;
  spec: string;
  importerRel: string;
  targetRel: string;
}

/** Construct an `illegal_import` Finding from the resolved import context. */
function buildIllegalImportFinding({
  importNodeId,
  fromLayer,
  toLayer,
  spec,
  importerRel,
  targetRel,
}: BuildFindingArgs): Finding {
  return {
    nodeId: importNodeId,
    biomarker: 'illegal_import',
    severity: 'warning',
    metric: 0,
    detail: {
      fromLayer,
      toLayer,
      importedSpec: spec,
      fromFile: importerRel,
      toFile: targetRel,
    },
  };
}

/**
 * Warn when a layer has both `canImport` and `cannotImport` set — only
 * `cannotImport` (deny-list) takes effect; `canImport` is silently ignored.
 */
function validateLayerConflicts(layers: LayerConfig[]): void {
  for (const layer of layers) {
    if (layer.canImport && layer.canImport.length > 0 && layer.cannotImport && layer.cannotImport.length > 0) {
      logWarn(
        `Layer "${layer.name}" has both canImport and cannotImport set; ` +
          `cannotImport (deny-list) wins, canImport is ignored. Set one, not both.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Shared context threaded through the per-row evaluation loop. */
interface IllegalImportContext {
  projectRootAbs: string;
  compiled: CompiledLayer[];
  indexedRelSet: ReadonlySet<string>;
  rawMatcherCache: Map<string, Matcher>;
  exceptions: LayerException[] | undefined;
}

/**
 * Evaluate one import row: resolve the spec, check layer membership,
 * check policy, suppress exceptions. Returns a Finding when the import
 * is a policy violation, or `null` when it should be skipped.
 *
 * @internal
 */
function evaluateImportRow(row: ImportRow, ctx: IllegalImportContext): Finding | null {
  const importerAbs = path.resolve(ctx.projectRootAbs, row.importer_file);
  const targetRel = resolveSpecToIndexed({
    importerAbs,
    spec: row.spec,
    projectRootAbs: ctx.projectRootAbs,
    indexedRelSet: ctx.indexedRelSet,
  });

  // Bare package or unresolvable — skip.
  if (targetRel === null) return null;

  const importerRel = toRelPosix(importerAbs, ctx.projectRootAbs);
  const fromMatch = matchLayer(importerRel, ctx.compiled);
  const toMatch = matchLayer(targetRel, ctx.compiled);

  // Importer not in any layer → not under layering rules.
  if (!fromMatch) return null;
  // Target not in any layer → out of scope, never flag.
  if (!toMatch) return null;
  // Same layer → always allowed.
  if (fromMatch.name === toMatch.name) return null;

  const fromLayer = fromMatch.name;
  const toLayer = toMatch.name;
  const { canImport, cannotImport } = fromMatch.config;

  const violated = isImportViolated({
    toLayer,
    targetRel,
    canImport,
    cannotImport,
    compiled: ctx.compiled,
    rawMatcherCache: ctx.rawMatcherCache,
  });
  if (!violated) return null;

  // Suppress if a per-file exception explicitly allows this import.
  if (
    ctx.exceptions &&
    ctx.exceptions.length > 0 &&
    isExceptionAllowed({
      importerAbs,
      toLayer,
      targetRel,
      exceptions: ctx.exceptions,
      projectRootAbs: ctx.projectRootAbs,
      compiled: ctx.compiled,
      rawMatcherCache: ctx.rawMatcherCache,
    })
  ) {
    return null;
  }

  return buildIllegalImportFinding({
    importNodeId: row.import_node_id,
    fromLayer,
    toLayer,
    spec: row.spec,
    importerRel,
    targetRel,
  });
}

/**
 * Compute all `illegal_import` findings for the current index state.
 *
 * Designed to be passed as the `produce` callback to `runCrossFileRule`
 * in `src/biomarkers/index.ts`. Does not write to the DB itself.
 */
export function computeIllegalImports(args: {
  queries: QueryBuilder;
  projectRoot: string;
  layers: LayerConfig[] | undefined;
  exceptions: LayerException[] | undefined;
}): Finding[] {
  const { queries, projectRoot, layers, exceptions } = args;
  if (!layers || layers.length === 0) return [];

  validateLayerConflicts(layers);

  const ctx: IllegalImportContext = {
    projectRootAbs: path.resolve(projectRoot),
    compiled: compileLayers(layers),
    indexedRelSet: new Set(getAllFilePaths(queries)),
    rawMatcherCache: new Map(),
    exceptions,
  };
  const rows = queries.db.prepare(IMPORT_EDGES_SQL).all() as ImportRow[];
  const findings: Finding[] = [];

  for (const row of rows) {
    const finding = evaluateImportRow(row, ctx);
    if (finding) findings.push(finding);
  }

  return findings;
}
