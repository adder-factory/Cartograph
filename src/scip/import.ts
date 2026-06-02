/**
 * SCIP import — a `.scip` protobuf index → cartograph's knowledge graph.
 *
 * Phase 2 of SCIP interop. Lets cartograph consume a precise index from
 * a mature language indexer (scip-typescript / rust-analyzer / …) — its
 * cross-file resolution beats cartograph's best-effort name match.
 *
 * Semantics: **per-file replace.** Every file a `.scip` `Document`
 * covers has its cartograph nodes+edges atomically evicted and rebuilt
 * from the SCIP data (the same evict+insert the native extractor uses
 * per file); files the `.scip` does not cover keep native extraction.
 *
 * Lossy by nature: SCIP `Occurrence`s carry no edge-kind distinction
 * (a call and a type reference are both just occurrences), so every
 * reference occurrence imports as a generic `references` edge.
 * `SymbolInformation.relationships` recover `extends` / `type_of`.
 *
 * {@link buildGraphFromScip} is pure (a `ScipIndex` → graph arrays) so
 * it is testable without a database; {@link writeScipImport} is the
 * decode + DB-transaction wrapper the CLI / MCP surfaces call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Node, Edge, FileRecord, NodeKind, EdgeKind, Language } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { qbTransaction } from '../db/queries.js';
import { insertEdges } from '../db/queries-edges.js';
import { removeFileFromIndexInTx, upsertFile } from '../db/queries-files.js';
import { isTestPath } from '../path-class.js';
import { decodeScipIndex } from './scip-decode.js';
import { parseScipSymbol, descriptorsToQualifiedName, DescriptorSuffix, type ParsedSymbol } from './scip-symbol.js';
import { SYMBOL_ROLE_DEFINITION, type ScipIndex, type ScipOccurrence, type ScipRelationship } from './scip-encode.js';

// ── kind mapping (SCIP → cartograph) ───────────────────────────────

/**
 * SCIP `SymbolInformation.Kind` → cartograph `NodeKind`. Covers the
 * kinds mature indexers emit; an unmapped or unspecified kind falls
 * back to {@link suffixToNodeKind} on the symbol's leaf descriptor.
 */
const SCIP_KIND_TO_NODE_KIND: Readonly<Record<number, NodeKind>> = {
  7: 'class',
  8: 'constant',
  9: 'method', // Constructor
  11: 'enum',
  12: 'enum_member',
  15: 'field',
  16: 'file',
  17: 'function',
  18: 'method', // Getter
  21: 'interface',
  25: 'function', // Macro
  26: 'method',
  29: 'module',
  30: 'namespace',
  33: 'class', // Object
  35: 'module', // Package
  37: 'parameter',
  41: 'property',
  42: 'protocol',
  44: 'parameter', // SelfParameter
  45: 'method', // Setter
  49: 'struct',
  53: 'trait',
  54: 'type_alias', // Type
  55: 'type_alias',
  58: 'type_alias', // TypeParameter (cartograph has no dedicated kind)
  61: 'variable',
  66: 'method', // AbstractMethod
  72: 'method', // Accessor
  76: 'method', // SingletonMethod
  77: 'field', // StaticDataMember
  79: 'field', // StaticField
  80: 'method', // StaticMethod
  81: 'property', // StaticProperty
  82: 'variable', // StaticVariable
};

/** Leaf descriptor suffix → cartograph `NodeKind`, the last-resort guess. */
function suffixToNodeKind(suffix: DescriptorSuffix): NodeKind {
  switch (suffix) {
    case DescriptorSuffix.Namespace:
      return 'namespace';
    case DescriptorSuffix.Type:
      return 'class';
    case DescriptorSuffix.Method:
      return 'function';
    case DescriptorSuffix.Macro:
      return 'function';
    case DescriptorSuffix.Parameter:
    case DescriptorSuffix.TypeParameter:
      return 'parameter';
    default:
      return 'variable';
  }
}

/** Resolve a node kind from the SCIP kind, falling back to the symbol. */
function resolveNodeKind(scipKind: number, parsed: ParsedSymbol | null): NodeKind {
  const mapped = SCIP_KIND_TO_NODE_KIND[scipKind];
  if (mapped) return mapped;
  const leaf = parsed && parsed.descriptors.length > 0 ? parsed.descriptors.at(-1) : undefined;
  return leaf ? suffixToNodeKind(leaf.suffix) : 'variable';
}

// ── model ─────────────────────────────────────────────────────────

/** Counts describing what an import produced. */
export interface ScipImportStats {
  documents: number;
  files: number;
  nodes: number;
  edges: number;
  /** Documents skipped — absolute path or `..` traversal in the path. */
  skippedDocuments: number;
  /** Occurrences / relationships whose target symbol had no definition. */
  unresolvedEdges: number;
}

/** Per-file payload produced by {@link buildGraphFromScip}. */
export interface ScipImportFile {
  fileRecord: FileRecord;
  nodes: Node[];
}

/** The full graph {@link buildGraphFromScip} derives from a `.scip`. */
export interface ScipImportGraph {
  filesByPath: Map<string, ScipImportFile>;
  edges: Edge[];
  allNodeIds: Set<string>;
  stats: ScipImportStats;
}

/** Disk metadata for an imported file — `null` when not on disk. */
export interface ScipFileMeta {
  contentHash: string;
  size: number;
  modifiedAt: number;
}

/** Options for {@link buildGraphFromScip}. */
export interface BuildGraphOptions {
  /**
   * Resolve a project-relative path to its on-disk metadata. Lets the
   * imported `files` row carry a real content hash, so a later `sync`
   * only re-extracts the file if it genuinely changed. Returns `null`
   * for files not on disk (the row then gets a placeholder hash).
   */
  fileMeta?: ((relPath: string) => ScipFileMeta | null) | undefined;
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Normalise a SCIP document path to cartograph's forward-slash relative
 * form — collapses `.` / `..` segments and `\` separators, so an
 * imported `files.path` matches what native extraction would store
 * (an un-normalised path would round-trip into a duplicate row).
 */
function normalizeScipPath(p: string): string {
  return path.posix.normalize(p.replaceAll('\\', '/'));
}

/** A path is safe to import if it is relative and has no `.`/`..`/empty
 *  segment (run on the already-normalised path). */
function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== '');
}

const sha256Hex = (data: crypto.BinaryLike): string => crypto.createHash('sha256').update(data).digest('hex');

/** Mint a cartograph node id — `<kind>:<32 hex>`, matching the native
 *  `generateNodeId` shape. Keyed on the globally-unique SCIP symbol
 *  string, so ids never collide. */
function mintNodeId(kind: NodeKind, key: string): string {
  return `${kind}:${sha256Hex(key).slice(0, 32)}`;
}

/** A definition occurrence's span as 1-based-line / 0-based-column. */
interface Span {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** SCIP `Range` tuple shapes: a four-element `[startLine, startChar,
 *  endLine, endChar]` span, or the compact three-element single-line
 *  `[line, startChar, endChar]` form. */
const FULL_RANGE_LEN = 4;
const SINGLE_LINE_RANGE_LEN = 3;
/** SCIP lines are 0-based; cartograph lines are 1-based. */
const SCIP_TO_CARTOGRAPH_LINE_OFFSET = 1;
/** Fallback span for a missing/empty occurrence (line 1, column 0). */
const FALLBACK_SPAN: Span = { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 };

/**
 * The declaration span of a definition occurrence — `enclosing_range`
 * (the full body) when present, else the name-token `range`. SCIP
 * lines are 0-based; cartograph lines are 1-based.
 */
function definitionSpan(occ: ScipOccurrence | undefined): Span {
  if (!occ) return { ...FALLBACK_SPAN };
  const r = occ.enclosingRange && occ.enclosingRange.length >= FULL_RANGE_LEN ? occ.enclosingRange : occ.range;
  if (r.length >= FULL_RANGE_LEN) {
    return {
      startLine: r[0]! + SCIP_TO_CARTOGRAPH_LINE_OFFSET,
      startColumn: r[1]!,
      endLine: r[2]! + SCIP_TO_CARTOGRAPH_LINE_OFFSET,
      endColumn: r[3]!,
    };
  }
  if (r.length === SINGLE_LINE_RANGE_LEN) {
    return {
      startLine: r[0]! + SCIP_TO_CARTOGRAPH_LINE_OFFSET,
      startColumn: r[1]!,
      endLine: r[0]! + SCIP_TO_CARTOGRAPH_LINE_OFFSET,
      endColumn: r[2]!,
    };
  }
  return { ...FALLBACK_SPAN };
}

/** A definition's 0-based enclosing line span, for reference attribution. */
function enclosingLineSpan(occ: ScipOccurrence): [number, number] {
  const r = occ.enclosingRange && occ.enclosingRange.length >= FULL_RANGE_LEN ? occ.enclosingRange : occ.range;
  if (r.length >= FULL_RANGE_LEN) return [r[0]!, r[2]!];
  if (r.length >= 1) return [r[0]!, r[0]!];
  return [0, 0];
}

// ── core build ────────────────────────────────────────────────────

/** Intermediate per-document build state produced by {@link buildDocNodes}. */
interface DocBuild {
  relativePath: string;
  language: Language;
  nodes: Node[];
  occurrences: ScipOccurrence[];
  symbols: ScipIndex['documents'][number]['symbols'];
  /** SCIP symbols of kind `file` — remapped to the synthesised file node. */
  fileSymbols: string[];
}

/** Args shared by the per-document and per-edge phase helpers. */
interface BuildPhaseArgs {
  now: number;
  symbolToNodeId: Map<string, string>;
}

/**
 * Pass 1a — process one SCIP document into a {@link DocBuild}: resolve
 * definition-occurrence positions, mint a node per SymbolInformation
 * (recording file-kind symbols separately for later folding), and
 * populate `symbolToNodeId`.  Returns `null` when the path is unsafe.
 */
function buildDocNodes(doc: ScipIndex['documents'][number], { now, symbolToNodeId }: BuildPhaseArgs): DocBuild | null {
  const relPath = normalizeScipPath(doc.relativePath);
  if (!isSafeRelPath(relPath)) return null;

  const language = (doc.language || 'unknown').toLowerCase() as Language;

  // First definition occurrence per symbol — the node's position.
  const defOccBySymbol = new Map<string, ScipOccurrence>();
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) !== 0 && !defOccBySymbol.has(occ.symbol)) {
      defOccBySymbol.set(occ.symbol, occ);
    }
  }

  const nodes: Node[] = [];
  const fileSymbols: string[] = [];
  for (const si of doc.symbols) {
    const node = buildNodeForSymbol(si, { relPath, language, now, defOccBySymbol, symbolToNodeId, fileSymbols });
    if (!node) continue;
    nodes.push(node);
  }

  return {
    relativePath: relPath,
    language,
    nodes,
    occurrences: doc.occurrences,
    symbols: doc.symbols,
    fileSymbols,
  };
}

function buildNodeForSymbol(
  si: ScipIndex['documents'][number]['symbols'][number],
  args: {
    relPath: string;
    language: Language;
    now: number;
    defOccBySymbol: Map<string, ScipOccurrence>;
    symbolToNodeId: Map<string, string>;
    fileSymbols: string[];
  },
): Node | null {
  if (!si.symbol || args.symbolToNodeId.has(si.symbol)) return null;
  const parsed = parseScipSymbol(si.symbol);
  const kind = resolveNodeKind(si.kind, parsed);
  // A `file`-kind symbol is folded into the synthesised file node below.
  if (kind === 'file') {
    args.fileSymbols.push(si.symbol);
    return null;
  }
  const leafName = parsed && parsed.descriptors.length > 0 ? parsed.descriptors.at(-1)!.name : '';
  const name = si.displayName || leafName || '(anonymous)';
  const span = definitionSpan(args.defOccBySymbol.get(si.symbol));
  const id = mintNodeId(kind, si.symbol);
  args.symbolToNodeId.set(si.symbol, id);
  return {
    id,
    kind,
    name,
    qualifiedName: parsed ? descriptorsToQualifiedName(parsed.descriptors) || name : name,
    filePath: args.relPath,
    language: args.language,
    startLine: span.startLine,
    endLine: span.endLine,
    startColumn: span.startColumn,
    endColumn: span.endColumn,
    updatedAt: args.now,
    ...(si.documentation.length > 0 ? { docstring: si.documentation.join('\n\n') } : {}),
  };
}

/**
 * Pass 1b — synthesise one `file` node per {@link DocBuild} (cartograph
 * hangs `contains` edges off it; foreign indexers rarely emit a File
 * symbol).  Mutates `db.nodes`, `fileNodeIdByPath`, and
 * `symbolToNodeId` to register file-symbol aliases.
 */
function synthesiseFileNode(
  db: DocBuild,
  fileNodeIdByPath: Map<string, string>,
  { now, symbolToNodeId }: BuildPhaseArgs,
): void {
  const maxLine = db.nodes.reduce((m, n) => Math.max(m, n.endLine), 1);
  const base = path.basename(db.relativePath);
  const fileNodeId = mintNodeId('file', `\0file\0${db.relativePath}`);
  db.nodes.push({
    id: fileNodeId,
    kind: 'file',
    name: base,
    qualifiedName: db.relativePath,
    filePath: db.relativePath,
    language: db.language,
    startLine: 1,
    endLine: maxLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  });
  fileNodeIdByPath.set(db.relativePath, fileNodeId);
  // A `file`-kind SCIP symbol resolves to this synthesised node, so
  // `enclosing_symbol` / `contains` edges that point at the file land.
  for (const sym of db.fileSymbols) symbolToNodeId.set(sym, fileNodeId);
}

/** A def-occurrence entry used during reference attribution. */
interface DefEntry {
  nodeId: string;
  startLine: number;
  endLine: number;
  span: number;
}

/**
 * Pass 2a — collect definition spans for one document; used by
 * {@link buildReferenceEdges} to attribute each reference occurrence to
 * the smallest enclosing definition.
 */
function collectDefEntries(db: DocBuild, symbolToNodeId: Map<string, string>): DefEntry[] {
  const defs: DefEntry[] = [];
  for (const occ of db.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) === 0) continue;
    const nodeId = symbolToNodeId.get(occ.symbol);
    if (!nodeId) continue;
    const [sl, el] = enclosingLineSpan(occ);
    defs.push({ nodeId, startLine: sl, endLine: el, span: el - sl });
  }
  return defs;
}

/** Callback used to push a deduplicated edge. */
type PushEdge = (e: Edge) => void;

/** Args shared by the Pass-2 edge-building helpers. */
interface EdgePhaseArgs {
  db: DocBuild;
  fileNodeId: string;
  symbolToNodeId: Map<string, string>;
  pushEdge: PushEdge;
}

/**
 * Pass 2b — emit `contains` edges (from `enclosing_symbol` or the file
 * node) and relationship edges (`extends` / `type_of` / `references`)
 * from `SymbolInformation.relationships`.  Returns the count of
 * unresolved relationship targets.
 */
function buildContainsAndRelEdges({ db, fileNodeId, symbolToNodeId, pushEdge }: EdgePhaseArgs): number {
  let unresolvedEdges = 0;
  for (const si of db.symbols) {
    const childId = symbolToNodeId.get(si.symbol);
    if (!childId) continue;
    const parentId = si.enclosingSymbol ? symbolToNodeId.get(si.enclosingSymbol) : undefined;
    // A file-kind symbol resolves to its own file node — skip the
    // `contains` self-loop that would otherwise produce (file → file).
    const containsSource = parentId ?? fileNodeId;
    if (containsSource !== childId) {
      pushEdge({ source: containsSource, target: childId, kind: 'contains', confidence: 'EXTRACTED' });
    }
    for (const rel of si.relationships) {
      if (!pushRelationshipEdge(rel, childId, symbolToNodeId, pushEdge)) {
        unresolvedEdges++;
      }
    }
  }
  return unresolvedEdges;
}

function pushRelationshipEdge(
  rel: ScipRelationship,
  childId: string,
  symbolToNodeId: Map<string, string>,
  pushEdge: (edge: Edge) => void,
): boolean {
  const targetId = symbolToNodeId.get(rel.symbol);
  if (!targetId) return false;
  const kind = edgeKindForScipRelationship(rel);
  if (kind) pushEdge({ source: childId, target: targetId, kind, confidence: 'EXTRACTED' });
  return true;
}

function edgeKindForScipRelationship(rel: ScipRelationship): EdgeKind | null {
  if (rel.isImplementation) return 'extends';
  if (rel.isTypeDefinition) return 'type_of';
  if (rel.isReference) return 'references';
  return null;
}

/** Args for {@link buildReferenceEdges} — extends the shared edge args with definition spans. */
interface RefEdgeArgs extends EdgePhaseArgs {
  defs: DefEntry[];
}

/**
 * Pass 2c — emit `references` edges for non-definition occurrences,
 * attributed to the smallest enclosing definition (or the file node).
 * Returns the count of occurrences whose target symbol was unresolved.
 */
function buildReferenceEdges({ db, fileNodeId, defs, symbolToNodeId, pushEdge }: RefEdgeArgs): number {
  let unresolvedEdges = 0;
  for (const occ of db.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) !== 0) continue;
    const targetId = symbolToNodeId.get(occ.symbol);
    if (!targetId) {
      unresolvedEdges++;
      continue;
    }
    const refLine = occ.range[0] ?? 0;
    let source = fileNodeId;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const d of defs) {
      if (d.startLine <= refLine && refLine <= d.endLine && d.span < bestSpan) {
        bestSpan = d.span;
        source = d.nodeId;
      }
    }
    pushEdge({
      source,
      target: targetId,
      kind: 'references',
      line: refLine + 1,
      column: occ.range[1] ?? 0,
      confidence: 'EXTRACTED',
    });
  }
  return unresolvedEdges;
}

/**
 * Pass 3 — build the per-file {@link ScipImportFile} records from the
 * completed {@link DocBuild} list, resolving on-disk metadata via
 * `opts.fileMeta` when available.
 */
function buildFilesByPath(docBuilds: DocBuild[], opts: BuildGraphOptions, now: number): Map<string, ScipImportFile> {
  const filesByPath = new Map<string, ScipImportFile>();
  for (const db of docBuilds) {
    const meta = opts.fileMeta ? opts.fileMeta(db.relativePath) : null;
    const fileRecord: FileRecord = {
      path: db.relativePath,
      contentHash: meta ? meta.contentHash : `scip:${sha256Hex(db.relativePath).slice(0, 24)}`,
      language: db.language,
      size: meta ? meta.size : 0,
      modifiedAt: meta ? meta.modifiedAt : now,
      indexedAt: now,
      nodeCount: db.nodes.length,
      isTest: isTestPath(db.relativePath),
    };
    filesByPath.set(db.relativePath, { fileRecord, nodes: db.nodes });
  }
  return filesByPath;
}

/**
 * Derive a cartograph graph (per-file nodes + cross-file edges) from a
 * decoded SCIP index. Pure — all I/O is the caller's via `fileMeta`.
 */
export function buildGraphFromScip(index: ScipIndex, opts: BuildGraphOptions = {}): ScipImportGraph {
  const now = Date.now();
  let skippedDocuments = 0;
  let unresolvedEdges = 0;

  // Pass 1 — nodes. Every SymbolInformation becomes a node; the
  // symbol→id map must be fully populated before edges can be built.
  const symbolToNodeId = new Map<string, string>();
  const fileNodeIdByPath = new Map<string, string>();
  const phaseArgs: BuildPhaseArgs = { now, symbolToNodeId };

  const docBuilds: DocBuild[] = [];
  for (const doc of index.documents) {
    const db = buildDocNodes(doc, phaseArgs);
    if (!db) {
      skippedDocuments++;
      continue;
    }
    docBuilds.push(db);
  }

  for (const db of docBuilds) {
    synthesiseFileNode(db, fileNodeIdByPath, phaseArgs);
  }

  const allNodeIds = new Set<string>();
  for (const db of docBuilds) for (const n of db.nodes) allNodeIds.add(n.id);

  // Pass 2 — edges. `contains` + relationships + reference occurrences.
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  const pushEdge: PushEdge = (e) => {
    const key = `${e.source}\0${e.target}\0${e.kind}\0${e.line ?? ''}\0${e.column ?? ''}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(e);
  };

  for (const db of docBuilds) {
    const fileNodeId = fileNodeIdByPath.get(db.relativePath)!;
    const defs = collectDefEntries(db, symbolToNodeId);
    unresolvedEdges += buildContainsAndRelEdges({ db, fileNodeId, symbolToNodeId, pushEdge });
    unresolvedEdges += buildReferenceEdges({ db, fileNodeId, defs, symbolToNodeId, pushEdge });
  }

  // Pass 3 — assemble per-file FileRecord metadata.
  const filesByPath = buildFilesByPath(docBuilds, opts, now);

  return {
    filesByPath,
    edges,
    allNodeIds,
    stats: {
      documents: index.documents.length,
      files: filesByPath.size,
      nodes: allNodeIds.size,
      edges: edges.length,
      skippedDocuments,
      unresolvedEdges,
    },
  };
}

// ── DB wrapper ────────────────────────────────────────────────────

/** {@link writeScipImport} result. */
export interface WriteScipImportResult {
  stats: ScipImportStats;
}

/** Read on-disk metadata for an imported file (for the `files` row). */
function diskFileMeta(projectRoot: string): (relPath: string) => ScipFileMeta | null {
  const root = path.resolve(projectRoot);
  return (relPath: string) => {
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null; // traversal guard
    try {
      const content = fs.readFileSync(abs);
      const stat = fs.statSync(abs);
      return {
        contentHash: sha256Hex(content),
        size: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
      };
    } catch {
      return null;
    }
  };
}

/**
 * Import a `.scip` protobuf into the cartograph graph DB. For every file
 * the index covers, the prior nodes+edges are atomically evicted and
 * rebuilt from SCIP (per-file replace); uncovered files are untouched.
 * The CLI (`cartograph admin scip-import`) and MCP (`cartograph_admin
 * action=scip-import`) surfaces share this.
 */
export function writeScipImport(qb: QueryBuilder, projectRoot: string, scipBytes: Uint8Array): WriteScipImportResult {
  const index = decodeScipIndex(scipBytes);
  const graph = buildGraphFromScip(index, { fileMeta: diskFileMeta(projectRoot) });

  qbTransaction(qb, () => {
    // Phase 1 — per-file replace: evict the prior extraction, then
    // insert the SCIP nodes. Done for every file before any edge so
    // cross-file edge endpoints all exist by phase 2.
    for (const [filePath, file] of graph.filesByPath) {
      removeFileFromIndexInTx(qb, filePath);
      upsertFile(qb, file.fileRecord);
      qb.insertNodes(file.nodes);
    }
    // Phase 2 — edges. Endpoints are guaranteed present by construction;
    // the filter is a defensive guard against an FK insert failure.
    const validEdges = graph.edges.filter((e) => graph.allNodeIds.has(e.source) && graph.allNodeIds.has(e.target));
    insertEdges(qb, validEdges);
  });

  return { stats: graph.stats };
}
