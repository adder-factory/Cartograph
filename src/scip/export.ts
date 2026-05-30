/**
 * SCIP export — cartograph knowledge graph → a `index.scip` protobuf.
 *
 * Maps cartograph's `nodes` / `edges` / `files` onto SCIP's
 * `Document` / `SymbolInformation` / `Occurrence` model so the index
 * can be consumed by Sourcegraph and other SCIP-aware tooling. This is
 * a deliberately LOSSY subset export: cartograph's distinctive data
 * (biomarkers, summaries, roles, churn, centrality) has no SCIP home,
 * so it is dropped — what crosses over is structure (definitions,
 * references, the type/call graph).
 *
 * {@link exportScipIndex} is pure (graph arrays in, bytes out) so it is
 * trivially testable; {@link writeScipExport} is the thin DB-and-disk
 * wrapper the CLI and MCP surfaces call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeKind, EdgeKind } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getAllNodes } from '../db/queries.js';
import {
  buildSymbolString,
  escapeDescriptorName,
  DescriptorSuffix,
  type Descriptor,
  type ScipPackage,
} from './scip-symbol.js';
import {
  encodeScipIndex,
  ScipSymbolKind,
  SYMBOL_ROLE_DEFINITION,
  type ScipIndex,
  type ScipDocument,
  type ScipRelationship,
} from './scip-encode.js';

// ── input model (structural subsets of Node / Edge / FileRecord) ──

/** The node fields the exporter reads — `Node` is assignable to this. */
export interface ScipNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string | undefined;
}

/** The edge fields the exporter reads — `Edge` is assignable to this. */
export interface ScipEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number | null | undefined;
  column?: number | null | undefined;
}

/** The file fields the exporter reads — `FileRecord` is assignable. */
export interface ScipFile {
  path: string;
  language: string;
}

/** Everything {@link exportScipIndex} needs — graph + project identity. */
export interface ScipExportInput {
  nodes: readonly ScipNode[];
  edges: readonly ScipEdge[];
  files: readonly ScipFile[];
  /** SCIP package name — the indexed project. */
  projectName: string;
  /** SCIP package version — kept stable so symbols match across exports. */
  projectVersion: string;
  /** Version of cartograph itself, recorded in `ToolInfo`. */
  toolVersion: string;
  /** `file://`-prefixed absolute path to the project root. */
  projectRootUri: string;
  /**
   * Resolve a project-relative path to its source lines, used to pin
   * definition occurrences onto the name token rather than the start
   * of the whole declaration. Returns `null` for unreadable files —
   * the exporter then falls back to the node's recorded start column.
   */
  readFileLines?: ((relPath: string) => string[] | null) | undefined;
}

/** Counts describing what an export produced. */
interface ScipExportStats {
  documents: number;
  symbols: number;
  occurrences: number;
  /** Symbols whose natural name collided and got a disambiguator. */
  disambiguated: number;
  bytes: number;
}

/** The {@link exportScipIndex} return shape. */
export interface ScipExportResult {
  index: ScipIndex;
  bytes: Uint8Array;
  stats: ScipExportStats;
}

// ── mapping tables ────────────────────────────────────────────────

/** SCIP symbol scheme + package manager for cartograph-minted symbols. */
const SCIP_SCHEME = 'cartograph';
const SCIP_MANAGER = 'cartograph';

/**
 * Node kinds that get no SCIP symbol: `import` / `export` are synthetic
 * (one per binding, no stable identity), `parameter` is intra-function
 * noise SCIP models with document-local symbols. Edges touching these
 * are dropped from the occurrence stream.
 */
const EXCLUDED_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['import', 'export', 'parameter']);

/** Edge kinds that become reference `Occurrence`s at the edge's site. */
const REFERENCE_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'calls',
  'references',
  'instantiates',
  'extends',
  'implements',
  'overrides',
  'type_of',
  'returns',
  'field_access',
  'decorates',
]);

/** Edge kinds that become `SymbolInformation.relationships` entries. */
const RELATIONSHIP_EDGE_KINDS: Partial<Record<EdgeKind, Omit<ScipRelationship, 'symbol'>>> = {
  extends: { isImplementation: true },
  implements: { isImplementation: true },
  overrides: { isImplementation: true, isReference: true },
};

/**
 * Lookup table: cartograph `NodeKind` → SCIP `SymbolInformation.Kind`.
 * Unmapped kinds resolve to `0` (UnspecifiedKind) via the accessor.
 */
const SCIP_KIND_BY_NODE_KIND: Partial<Record<NodeKind, number>> = {
  file: ScipSymbolKind.File,
  module: ScipSymbolKind.Module,
  namespace: ScipSymbolKind.Namespace,
  class: ScipSymbolKind.Class,
  component: ScipSymbolKind.Class,
  struct: ScipSymbolKind.Struct,
  table: ScipSymbolKind.Struct,
  interface: ScipSymbolKind.Interface,
  trait: ScipSymbolKind.Trait,
  protocol: ScipSymbolKind.Protocol,
  enum: ScipSymbolKind.Enum,
  enum_member: ScipSymbolKind.EnumMember,
  type_alias: ScipSymbolKind.TypeAlias,
  function: ScipSymbolKind.Function,
  method: ScipSymbolKind.Method,
  route: ScipSymbolKind.Method,
  property: ScipSymbolKind.Property,
  field: ScipSymbolKind.Field,
  variable: ScipSymbolKind.Variable,
  constant: ScipSymbolKind.Constant,
  resource: ScipSymbolKind.Object,
};

/** cartograph `NodeKind` → SCIP `SymbolInformation.Kind` (0 = UnspecifiedKind). */
function nodeKindToScipKind(kind: NodeKind): number {
  return SCIP_KIND_BY_NODE_KIND[kind] ?? 0;
}

/**
 * Lookup table: cartograph `NodeKind` → the SCIP descriptor suffix for its leaf.
 * Unmapped kinds fall back to `DescriptorSuffix.Term` via the accessor.
 */
const DESCRIPTOR_SUFFIX_BY_NODE_KIND: Partial<Record<NodeKind, DescriptorSuffix>> = {
  file: DescriptorSuffix.Namespace,
  module: DescriptorSuffix.Namespace,
  namespace: DescriptorSuffix.Namespace,
  class: DescriptorSuffix.Type,
  struct: DescriptorSuffix.Type,
  interface: DescriptorSuffix.Type,
  trait: DescriptorSuffix.Type,
  protocol: DescriptorSuffix.Type,
  enum: DescriptorSuffix.Type,
  type_alias: DescriptorSuffix.Type,
  component: DescriptorSuffix.Type,
  table: DescriptorSuffix.Type,
  resource: DescriptorSuffix.Type,
  function: DescriptorSuffix.Method,
  method: DescriptorSuffix.Method,
  route: DescriptorSuffix.Method,
};

/** cartograph `NodeKind` → the SCIP descriptor suffix for its leaf. */
function nodeKindToSuffix(kind: NodeKind): DescriptorSuffix {
  return DESCRIPTOR_SUFFIX_BY_NODE_KIND[kind] ?? DescriptorSuffix.Term;
}

// ── symbol construction ───────────────────────────────────────────

/**
 * Build the *natural* SCIP symbol string for a node — a file-path
 * Namespace descriptor followed by the `::`-split qualified name, the
 * leaf carrying the kind-appropriate suffix. Collisions (cartograph's
 * UID is unique but the qualified name need not be) are resolved by
 * the caller.
 */
function buildNaturalSymbol(pkg: ScipPackage, n: ScipNode): string {
  const descriptors: Descriptor[] = [{ name: n.filePath, suffix: DescriptorSuffix.Namespace }];
  if (n.kind !== 'file') {
    let qn = n.qualifiedName;
    const filePrefix = `${n.filePath}::`;
    if (qn.startsWith(filePrefix)) qn = qn.slice(filePrefix.length);
    const parts = qn.split('::').filter((p) => p.length > 0);
    if (parts.length === 0) parts.push(n.name);
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      descriptors.push({
        name: part,
        suffix: isLeaf ? nodeKindToSuffix(n.kind) : DescriptorSuffix.Type,
      });
    });
  }
  return buildSymbolString(SCIP_SCHEME, pkg, descriptors);
}

/**
 * Assign a globally-unique SCIP symbol to every non-excluded node.
 * When several nodes share a natural symbol they are ordered
 * deterministically (start line, then UID) and all but the first get a
 * trailing `<n>:` Meta descriptor — keeping symbols stable for a given
 * graph snapshot regardless of row order.
 */
function assignSymbols(
  realNodes: readonly ScipNode[],
  pkg: ScipPackage,
): { symbolByNodeId: Map<string, string>; disambiguated: number } {
  const groups = new Map<string, ScipNode[]>();
  for (const n of realNodes) {
    const natural = buildNaturalSymbol(pkg, n);
    const group = groups.get(natural);
    if (group) group.push(n);
    else groups.set(natural, [n]);
  }
  const symbolByNodeId = new Map<string, string>();
  let disambiguated = 0;
  for (const [natural, group] of groups) {
    if (group.length === 1) {
      symbolByNodeId.set(group[0]!.id, natural);
      continue;
    }
    const ordered = [...group].sort((a, b) => a.startLine - b.startLine || (a.id < b.id ? -1 : 1));
    ordered.forEach((n, i) => {
      if (i === 0) {
        symbolByNodeId.set(n.id, natural);
      } else {
        // Append a Meta descriptor (`<i>:`). A digit run is a SCIP
        // simple identifier, so no escaping is needed.
        symbolByNodeId.set(n.id, `${natural}${escapeDescriptorName(String(i))}:`);
        disambiguated++;
      }
    });
  }
  return { symbolByNodeId, disambiguated };
}

// ── range helpers ─────────────────────────────────────────────────

/**
 * The definition occurrence range — `[line, startChar, endChar]`,
 * 0-based. Cartograph records the start of the whole declaration; this
 * scans the start line for the name token so go-to-definition lands on
 * the identifier. Falls back to the recorded column when the source is
 * unavailable or the name isn't found.
 */
function definitionRange(n: ScipNode, lines: string[] | null): number[] {
  const line0 = Math.max(0, n.startLine - 1);
  let startCol = Math.max(0, n.startColumn);
  if (lines && line0 < lines.length && n.name) {
    const text = lines[line0]!;
    let idx = text.indexOf(n.name, startCol);
    if (idx < 0) idx = text.indexOf(n.name);
    if (idx >= 0) startCol = idx;
  }
  const nameLen = n.name.length > 0 ? n.name.length : 1;
  return [line0, startCol, startCol + nameLen];
}

/** The full declaration span — `[startLine, startChar, endLine, endChar]`. */
function enclosingRange(n: ScipNode): number[] {
  return [
    Math.max(0, n.startLine - 1),
    Math.max(0, n.startColumn),
    Math.max(0, n.endLine - 1),
    Math.max(0, n.endColumn),
  ];
}

// ── core export — phase helpers ───────────────────────────────────

/** Phase 1: index all nodes by id and filter out excluded kinds. */
function buildNodeIndex(
  nodes: readonly ScipNode[],
  pkg: ScipPackage,
): {
  nodeById: Map<string, ScipNode>;
  realNodes: readonly ScipNode[];
  symbolByNodeId: Map<string, string>;
  disambiguated: number;
} {
  const nodeById = new Map<string, ScipNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  const realNodes = nodes.filter((n) => !EXCLUDED_KINDS.has(n.kind));
  const { symbolByNodeId, disambiguated } = assignSymbols(realNodes, pkg);
  return { nodeById, realNodes, symbolByNodeId, disambiguated };
}

/**
 * Phase 2: derive per-node enclosing symbols and relationship lists from
 * `contains` / relationship edges.
 */
function buildEdgeMaps(
  edges: readonly ScipEdge[],
  symbolByNodeId: Map<string, string>,
): {
  enclosingByNodeId: Map<string, string>;
  relationshipsByNodeId: Map<string, ScipRelationship[]>;
} {
  const enclosingByNodeId = new Map<string, string>();
  const relationshipsByNodeId = new Map<string, ScipRelationship[]>();
  for (const e of edges) {
    if (e.kind === 'contains') {
      const childSym = symbolByNodeId.get(e.target);
      const parentSym = symbolByNodeId.get(e.source);
      if (childSym && parentSym) enclosingByNodeId.set(e.target, parentSym);
      continue;
    }
    const relMeta = RELATIONSHIP_EDGE_KINDS[e.kind];
    if (relMeta) {
      const srcSym = symbolByNodeId.get(e.source);
      const tgtSym = symbolByNodeId.get(e.target);
      if (srcSym && tgtSym) {
        const rel: ScipRelationship = { symbol: tgtSym, ...relMeta };
        const list = relationshipsByNodeId.get(e.source);
        if (list) list.push(rel);
        else relationshipsByNodeId.set(e.source, [rel]);
      }
    }
  }
  return { enclosingByNodeId, relationshipsByNodeId };
}

/**
 * Phase 3: seed one `ScipDocument` per file so the language field is
 * accurate; stray node paths not in the files table are lazily created
 * by the returned `docFor` accessor.
 */
function buildDocumentMap(files: readonly ScipFile[]): {
  documents: Map<string, ScipDocument>;
  docFor: (relPath: string, language: string) => ScipDocument;
} {
  const documents = new Map<string, ScipDocument>();
  for (const f of files) {
    documents.set(f.path, {
      relativePath: f.path,
      language: f.language,
      occurrences: [],
      symbols: [],
    });
  }
  const docFor = (relPath: string, language: string): ScipDocument => {
    let doc = documents.get(relPath);
    if (!doc) {
      doc = { relativePath: relPath, language, occurrences: [], symbols: [] };
      documents.set(relPath, doc);
    }
    return doc;
  };
  return { documents, docFor };
}

/** Arguments for {@link emitDefinitions}. */
interface EmitDefinitionsArgs {
  realNodes: readonly ScipNode[];
  symbolByNodeId: Map<string, string>;
  enclosingByNodeId: Map<string, string>;
  relationshipsByNodeId: Map<string, ScipRelationship[]>;
  docFor: (relPath: string, language: string) => ScipDocument;
  readFileLines: ScipExportInput['readFileLines'];
}

/** Phase 4: emit a `SymbolInformation` and a `Definition` occurrence for every real node. */
function emitDefinitions({
  realNodes,
  symbolByNodeId,
  enclosingByNodeId,
  relationshipsByNodeId,
  docFor,
  readFileLines,
}: EmitDefinitionsArgs): void {
  const linesCache = new Map<string, string[] | null>();
  const linesFor = (relPath: string): string[] | null => {
    if (linesCache.has(relPath)) return linesCache.get(relPath)!;
    const lines = readFileLines ? readFileLines(relPath) : null;
    linesCache.set(relPath, lines);
    return lines;
  };
  for (const n of realNodes) {
    const symbol = symbolByNodeId.get(n.id)!;
    const doc = docFor(n.filePath, n.language);
    doc.symbols.push({
      symbol,
      displayName: n.name,
      kind: nodeKindToScipKind(n.kind),
      documentation: n.docstring ? [n.docstring] : [],
      relationships: relationshipsByNodeId.get(n.id) ?? [],
      enclosingSymbol: enclosingByNodeId.get(n.id) ?? '',
    });
    if (n.kind !== 'file') {
      doc.occurrences.push({
        range: definitionRange(n, linesFor(n.filePath)),
        symbol,
        symbolRoles: SYMBOL_ROLE_DEFINITION,
        enclosingRange: enclosingRange(n),
      });
    }
  }
}

/** Phase 5: emit a reference `Occurrence` (role 0) for every call/use-site edge. */
/** Arguments for {@link emitReferences}. */
interface EmitReferencesArgs {
  edges: readonly ScipEdge[];
  nodeById: Map<string, ScipNode>;
  symbolByNodeId: Map<string, string>;
  docFor: (relPath: string, language: string) => ScipDocument;
}

function emitReferences({ edges, nodeById, symbolByNodeId, docFor }: EmitReferencesArgs): void {
  for (const e of edges) {
    if (!REFERENCE_EDGE_KINDS.has(e.kind)) continue;
    if (e.line == null || e.line < 1) continue;
    const src = nodeById.get(e.source);
    const targetSymbol = symbolByNodeId.get(e.target);
    if (!src || !targetSymbol) continue;
    if (EXCLUDED_KINDS.has(src.kind)) continue;
    const target = nodeById.get(e.target);
    const nameLen = target && target.name.length > 0 ? target.name.length : 1;
    const col = Math.max(0, e.column ?? 0);
    docFor(src.filePath, src.language).occurrences.push({
      range: [e.line - 1, col, col + nameLen],
      symbol: targetSymbol,
      symbolRoles: 0,
    });
  }
}

/**
 * Phase 6: drop empty documents, sort documents by path, and sort
 * occurrences + symbols within each document for deterministic output.
 */
function sortAndFilterDocuments(documents: Map<string, ScipDocument>): ScipDocument[] {
  const orderedDocs = [...documents.values()]
    .filter((d) => d.symbols.length > 0 || d.occurrences.length > 0)
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const doc of orderedDocs) {
    doc.occurrences.sort(
      (a, b) =>
        a.range[0]! - b.range[0]! ||
        a.range[1]! - b.range[1]! ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
    doc.symbols.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }
  return orderedDocs;
}

/** Build the `ScipExportStats` summary from a finalised document list. */
function buildExportStats(orderedDocs: ScipDocument[], disambiguated: number, byteLength: number): ScipExportStats {
  return {
    documents: orderedDocs.length,
    symbols: orderedDocs.reduce((sum, d) => sum + d.symbols.length, 0),
    occurrences: orderedDocs.reduce((sum, d) => sum + d.occurrences.length, 0),
    disambiguated,
    bytes: byteLength,
  };
}

// ── core export ───────────────────────────────────────────────────

/**
 * Build a SCIP index from a cartograph graph snapshot and encode it.
 * Pure — all I/O is the caller's (`readFileLines` and disk writes).
 */
export function exportScipIndex(input: ScipExportInput): ScipExportResult {
  const pkg: ScipPackage = {
    manager: SCIP_MANAGER,
    name: input.projectName,
    version: input.projectVersion,
  };

  const { nodeById, realNodes, symbolByNodeId, disambiguated } = buildNodeIndex(input.nodes, pkg);
  const { enclosingByNodeId, relationshipsByNodeId } = buildEdgeMaps(input.edges, symbolByNodeId);
  const { documents, docFor } = buildDocumentMap(input.files);
  emitDefinitions({
    realNodes,
    symbolByNodeId,
    enclosingByNodeId,
    relationshipsByNodeId,
    docFor,
    readFileLines: input.readFileLines,
  });
  emitReferences({ edges: input.edges, nodeById, symbolByNodeId, docFor });
  const orderedDocs = sortAndFilterDocuments(documents);

  const index: ScipIndex = {
    toolName: 'cartograph',
    toolVersion: input.toolVersion,
    projectRoot: input.projectRootUri,
    documents: orderedDocs,
  };
  const bytes = encodeScipIndex(index);
  return { index, bytes, stats: buildExportStats(orderedDocs, disambiguated, bytes.length) };
}

// ── DB + disk wrapper ─────────────────────────────────────────────

/** Read all nodes / edges / files the exporter needs from the graph DB. */
function readGraph(qb: QueryBuilder): {
  nodes: ScipNode[];
  edges: ScipEdge[];
  files: ScipFile[];
} {
  const nodes = getAllNodes(qb) as ScipNode[];
  const edges = qb.db.prepare('SELECT source, target, kind, line, col AS column FROM edges').all() as ScipEdge[];
  const files = qb.db.prepare('SELECT path, language FROM files').all() as ScipFile[];
  return { nodes, edges, files };
}

/** Project identity for the SCIP package triple + tool info. */
interface ScipMeta {
  projectName: string;
  projectVersion: string;
  toolVersion: string;
}

/**
 * Derive the SCIP package name/version from the indexed project's
 * `package.json` (falling back to the directory name and `0.0.0`), and
 * cartograph's own version from its bundled `package.json`.
 */
export function deriveScipMeta(projectRoot: string): ScipMeta {
  const projectPkg = readPackageJson(path.join(projectRoot, 'package.json'));
  const toolPkg = readPackageJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));
  return {
    projectName:
      (typeof projectPkg.name === 'string' && projectPkg.name) || path.basename(path.resolve(projectRoot)) || 'project',
    projectVersion: (typeof projectPkg.version === 'string' && projectPkg.version) || '0.0.0',
    toolVersion: (typeof toolPkg.version === 'string' && toolPkg.version) || '0.0.0',
  };
}

/** Parse a `package.json`, returning `{}` when absent or malformed. */
function readPackageJson(file: string): { name?: unknown; version?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return {};
  }
}

/** {@link writeScipExport} return shape — the stats plus where it landed. */
export interface WriteScipResult {
  outPath: string;
  stats: ScipExportStats;
}

/**
 * Export the project's cartograph index to a `.scip` file on disk. The
 * thin wrapper the CLI (`cartograph admin scip-export`) and MCP
 * (`cartograph_admin action=scip-export`) surfaces share.
 */
export function writeScipExport(qb: QueryBuilder, projectRoot: string, outPath: string): WriteScipResult {
  const { nodes, edges, files } = readGraph(qb);
  const meta = deriveScipMeta(projectRoot);
  const result = exportScipIndex({
    nodes,
    edges,
    files,
    projectName: meta.projectName,
    projectVersion: meta.projectVersion,
    toolVersion: meta.toolVersion,
    projectRootUri: `file://${path.resolve(projectRoot)}`,
    readFileLines: (relPath) => {
      try {
        return fs.readFileSync(path.join(projectRoot, relPath), 'utf8').split('\n');
      } catch {
        return null;
      }
    },
  });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, result.bytes);
  return { outPath, stats: result.stats };
}
