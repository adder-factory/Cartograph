/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

import type { Node, Edge, Context, Subgraph, EdgeKind } from '../types.js';
import { type QueryBuilder, getNodesByKind } from '../db/queries.js';
import { getOutgoingEdges, getIncomingEdges } from '../db/queries-edges.js';
import { getAllFiles, getAllFilePaths } from '../db/queries-files.js';
import { GraphTraverser } from './traversal.js';
import { globToSafeRegex } from '../utils.js';
import * as path from 'node:path';

/**
 * Extensions an extension-less relative import spec may resolve to on
 * disk. Mirrors the canonical set in `import-classifier.ts`, plus the
 * NodeNext `.js → .ts` rewrite handled by {@link resolveRelativeSpec}.
 */
const IMPORT_RESOLVE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
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
 * Resolve a relative import specifier to a project-relative file path,
 * matched against the known indexed file set.
 *
 * `imports` edges point at per-file *import nodes* whose `name` holds the
 * verbatim specifier (e.g. `./summarizer.js`, `../types.js`); they never
 * point at the imported file's own node. To recover the real file
 * dependency we resolve the specifier against the importer's directory
 * and probe the indexed path set — extension-less specs are tried with
 * each known extension, and the NodeNext `import './foo.js'` →
 * `foo.ts`-on-disk rewrite is honoured. Returns `null` for bare
 * (non-relative) specs and for relatives that don't match an indexed
 * file (out-of-repo or an `index.<ext>` directory import we don't
 * expand here — directory imports are a rare minority and folding them
 * in would need a second probe pass).
 */
function resolveRelativeSpec(importerFile: string, spec: string, indexedFiles: ReadonlySet<string>): string | null {
  const isRelative = spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
  if (!isRelative) return null;
  // POSIX join — indexed paths are always stored project-relative with
  // forward slashes regardless of host OS.
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerFile), spec));
  if (indexedFiles.has(base)) return base;
  // NodeNext: `./foo.js` may map to `foo.ts` / `.tsx` / `.d.ts` on disk.
  const jsRewrite = base
    .replace(/\.js$/, '')
    .replace(/\.jsx$/, '')
    .replace(/\.mjs$/, '')
    .replace(/\.cjs$/, '');
  // Extension-less (or JS-extension) probe: strip a known extension if
  // present, then try every candidate extension.
  let stem = base;
  for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
    if (stem.endsWith(ext)) {
      stem = stem.slice(0, -ext.length);
      break;
    }
  }
  for (const stemCandidate of stem === jsRewrite ? [stem] : [stem, jsRewrite]) {
    for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
      const candidate = stemCandidate + ext;
      if (indexedFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Collect non-containment edges in one direction, returning each paired with
 * the resolved neighbor node.
 *
 * `direction: 'incoming'` — things that reference `nodeId` (edge.source).
 * `direction: 'outgoing'` — things `nodeId` references (edge.target).
 * Containment edges are always excluded from both views.
 */
function gqmCollectRefs(
  queries: QueryBuilder,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
): Array<{ node: Node; edge: Edge }> {
  const refs: Array<{ node: Node; edge: Edge }> = [];
  const edges = direction === 'incoming' ? getIncomingEdges(queries, nodeId) : getOutgoingEdges(queries, nodeId);
  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    const neighbor = direction === 'incoming' ? edge.source : edge.target;
    const node = queries.getNodeById(neighbor);
    if (node) refs.push({ node, edge });
  }
  return refs;
}

/** Incoming refs: things that reference `nodeId`, minus containment. */
function gqmCollectIncomingRefs(queries: QueryBuilder, nodeId: string): Array<{ node: Node; edge: Edge }> {
  return gqmCollectRefs(queries, nodeId, 'incoming');
}

/** Outgoing refs: things `nodeId` references, minus containment. */
function gqmCollectOutgoingRefs(queries: QueryBuilder, nodeId: string): Array<{ node: Node; edge: Edge }> {
  return gqmCollectRefs(queries, nodeId, 'outgoing');
}

/** Type nodes reachable via `type_of` / `returns` edges, deduped by id. */
function gqmCollectTypeNodes(queries: QueryBuilder, nodeId: string): Node[] {
  const types: Node[] = [];
  const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
  for (const kind of typeEdgeKinds) {
    for (const edge of getOutgoingEdges(queries, nodeId, [kind])) {
      const typeNode = queries.getNodeById(edge.target);
      if (typeNode && !types.some((t) => t.id === typeNode.id)) {
        types.push(typeNode);
      }
    }
  }
  return types;
}

/** Imports declared on the focal node's enclosing file (if any). */
function gqmCollectImportNodes(queries: QueryBuilder, ancestors: Node[]): Node[] {
  const imports: Node[] = [];
  const fileNode = ancestors.find((a) => a.kind === 'file');
  if (!fileNode) return imports;
  for (const edge of getOutgoingEdges(queries, fileNode.id, ['imports'])) {
    const importNode = queries.getNodeById(edge.target);
    if (importNode) imports.push(importNode);
  }
  return imports;
}

/** Walk incoming `imports` edges on `targetId` and add each source's
 *  filePath into `dependents`, skipping self-references. */
interface GqmAddImportSourceFilesIntoArgs {
  queries: QueryBuilder;
  targetId: string;
  selfFilePath: string;
  dependents: Set<string>;
}

function gqmAddImportSourceFilesInto(args: GqmAddImportSourceFilesIntoArgs): void {
  const { queries, targetId, selfFilePath, dependents } = args;
  // Cross-file dependency materialises as several edge kinds in
  // practice — the resolver doesn't always produce a clean
  // file→file `imports` edge. A test importing a source symbol
  // typically produces a `references` (file→symbol), a `calls`
  // (function→function), a `type_of` (consumer-side type
  // annotation), and/or a `tests` (file→file) edge. Following only
  // `imports` returned empty on real codebases. The five-kind list
  // covers the dependency surface emitted by the TS/JS extractor;
  // type_of in particular catches "test that uses a source type as
  // a parameter annotation" cases that would otherwise be invisible.
  for (const edge of getIncomingEdges(queries, targetId, ['imports', 'references', 'calls', 'type_of', 'tests'])) {
    const sourceNode = queries.getNodeById(edge.source);
    if (!sourceNode) continue;
    if (sourceNode.filePath === selfFilePath) continue;
    dependents.add(sourceNode.filePath);
  }
}

export interface ResolvedFileImportDependent {
  /** Importing file path. */
  filePath: string;
  /** Import-statement line in the importing file, when available. */
  line?: number;
}

interface ResolvedImportRow {
  importerFilePath: string;
  spec: string;
  line: number | null;
}

/**
 * Resolve every file→import-node edge in reverse and return files whose
 * import specifier resolves to `targetFilePath`.
 *
 * The persisted graph stores side-effect imports (`import './setup.js'`) as
 * file→import-node edges; there is no incoming edge on the imported file's
 * file node. Forward file-dependency queries already resolve the import-node
 * specifier. This helper performs the same resolution in reverse so file-node
 * callers and affected-test BFS can see those dependents too.
 */
function gqmCollectResolvedFileImportDependents(args: {
  queries: QueryBuilder;
  targetFilePath: string;
  indexedFiles: ReadonlySet<string>;
}): ResolvedFileImportDependent[] {
  const { queries, targetFilePath, indexedFiles } = args;
  const rows = queries.db
    .prepare(
      `
      SELECT src.file_path AS importerFilePath, imp.name AS spec, imp.start_line AS line
      FROM edges e
      JOIN nodes src ON src.id = e.source AND src.kind = 'file'
      JOIN nodes imp ON imp.id = e.target AND imp.kind = 'import'
      WHERE e.kind = 'imports'
    `,
    )
    .all() as ResolvedImportRow[];

  const out = new Map<string, ResolvedFileImportDependent>();
  for (const row of rows) {
    if (row.importerFilePath === targetFilePath) continue;
    const resolved = resolveRelativeSpec(row.importerFilePath, row.spec, indexedFiles);
    if (resolved !== targetFilePath) continue;
    const existing = out.get(row.importerFilePath);
    const line = typeof row.line === 'number' && row.line > 0 ? row.line : undefined;
    if (!existing || (line !== undefined && (existing.line === undefined || line < existing.line))) {
      const dependent: ResolvedFileImportDependent = { filePath: row.importerFilePath };
      if (line !== undefined) dependent.line = line;
      out.set(row.importerFilePath, dependent);
    }
  }
  return Array.from(out.values());
}

interface GqmAppendInternalOutgoingEdgesIntoArgs {
  queries: QueryBuilder;
  nodeId: string;
  nodes: ReadonlyMap<string, Node>;
  edges: Edge[];
}

/** Append every outgoing edge from `nodeId` whose `target` is also
 *  present in `nodes` into `edges`. */
function gqmAppendInternalOutgoingEdgesInto(args: GqmAppendInternalOutgoingEdgesIntoArgs): void {
  const { queries, nodeId, nodes, edges } = args;
  for (const edge of getOutgoingEdges(queries, nodeId)) {
    if (nodes.has(edge.target)) edges.push(edge);
  }
}

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private readonly queries: QueryBuilder;
  private readonly traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  getContext(nodeId: string): Context {
    const focal = this.queries.getNodeById(nodeId);
    if (!focal) throw new Error(`Node not found: ${nodeId}`);

    const ancestors = this.traverser.getAncestors(nodeId);
    const children = this.traverser.getChildren(nodeId);

    return {
      focal,
      ancestors,
      children,
      incomingRefs: gqmCollectIncomingRefs(this.queries, nodeId),
      outgoingRefs: gqmCollectOutgoingRefs(this.queries, nodeId),
      types: gqmCollectTypeNodes(this.queries, nodeId),
      imports: gqmCollectImportNodes(this.queries, ancestors),
    };
  }

  /**
   * Resolve the project-relative files `filePath` imports.
   *
   * `indexedFiles` is the known indexed-path set. It is optional for
   * one-off callers (built on demand), but a caller invoking this in a
   * loop — `findCircularDependencies`, `module`'s per-directory edge
   * accounting — MUST hoist the set and pass it, or every iteration
   * pays a full `getAllFilePaths` query.
   */
  getFileDependencies(filePath: string, indexedFiles?: ReadonlySet<string>): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const fileNode = nodes.find((n) => n.kind === 'file');
    if (!fileNode) return [];

    const fileSet = indexedFiles ?? new Set(getAllFilePaths(this.queries));
    const dependencies = new Set<string>();
    // `imports` edges target this file's own per-file *import nodes*,
    // whose `name` is the verbatim specifier — NOT the imported file's
    // node. (A `targetNode.filePath !== filePath` filter therefore drops
    // everything, since every import node lives in `filePath` itself.)
    // Resolve each specifier back to the project-relative file it imports.
    for (const edge of getOutgoingEdges(this.queries, fileNode.id, ['imports'])) {
      const importNode = this.queries.getNodeById(edge.target);
      if (!importNode || importNode?.kind !== 'import') continue;
      const resolved = resolveRelativeSpec(filePath, importNode.name, fileSet);
      if (resolved && resolved !== filePath) dependencies.add(resolved);
    }
    return Array.from(dependencies);
  }

  getFileDependents(filePath: string): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const dependents = new Set<string>();
    const indexedFiles = new Set(getAllFilePaths(this.queries));

    for (const dep of this.getResolvedFileImportDependents(filePath, indexedFiles)) {
      dependents.add(dep.filePath);
    }

    const fileNode = nodes.find((n) => n.kind === 'file');
    if (fileNode) {
      gqmAddImportSourceFilesInto({ queries: this.queries, targetId: fileNode.id, selfFilePath: filePath, dependents });
    }

    for (const node of nodes) {
      if (!node.isExported) continue;
      gqmAddImportSourceFilesInto({ queries: this.queries, targetId: node.id, selfFilePath: filePath, dependents });
    }

    return Array.from(dependents);
  }

  getResolvedFileImportDependents(filePath: string, indexedFiles?: ReadonlySet<string>): ResolvedFileImportDependent[] {
    return gqmCollectResolvedFileImportDependents({
      queries: this.queries,
      targetFilePath: filePath,
      indexedFiles: indexedFiles ?? new Set(getAllFilePaths(this.queries)),
    });
  }

  getExportedSymbols(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath).filter((n) => n.isExported);
  }

  findByQualifiedName(pattern: string): Node[] {
    // Convert glob pattern to regex (ReDoS-safe).
    const regexBody = globToSafeRegex(pattern);
    if (regexBody === null) return [];
    const regex = new RegExp(`^${regexBody}$`);

    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = ['class', 'function', 'method', 'interface', 'type_alias', 'variable', 'constant'];
    for (const kind of kinds) {
      for (const node of getNodesByKind(this.queries, kind)) {
        if (regex.test(node.qualifiedName)) allNodes.push(node);
      }
    }
    return allNodes;
  }

  getModuleStructure(): Map<string, string[]> {
    const files = getAllFiles(this.queries);
    const structure = new Map<string, string[]>();
    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';
      if (!structure.has(dir)) structure.set(dir, []);
      structure.get(dir)!.push(file.path);
    }
    return structure;
  }

  findCircularDependencies(): string[][] {
    const files = getAllFiles(this.queries);
    // Hoist the indexed-path set once — getFileDependencies is called
    // per file in the DFS below, and would otherwise re-query it N times.
    const indexedFiles = new Set(getAllFilePaths(this.queries));
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (filePath: string, path: string[]): void => {
      if (recursionStack.has(filePath)) {
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(filePath)) return;
      visited.add(filePath);
      recursionStack.add(filePath);
      for (const dep of this.getFileDependencies(filePath, indexedFiles)) {
        dfs(dep, [...path, filePath]);
      }
      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) dfs(file.path, []);
    }
    return cycles;
  }

  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    const incomingEdges = getIncomingEdges(this.queries, nodeId);
    const outgoingEdges = getOutgoingEdges(this.queries, nodeId);
    const ancestors = this.traverser.getAncestors(nodeId);
    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: outgoingEdges.filter((e) => e.kind === 'calls').length,
      callerCount: incomingEdges.filter((e) => e.kind === 'calls').length,
      childCount: outgoingEdges.filter((e) => e.kind === 'contains').length,
      depth: ancestors.length,
    };
  }

  findDeadCode(kinds?: Node['kind'][]): Node[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];
    for (const kind of targetKinds) {
      for (const node of getNodesByKind(this.queries, kind)) {
        if (node.isExported) continue;
        const references = getIncomingEdges(this.queries, node.id).filter((e) => e.kind !== 'contains');
        if (references.length === 0) deadCode.push(node);
      }
    }
    return deadCode;
  }

  getFilteredSubgraph(filter: (node: Node) => boolean, includeEdges: boolean = true): Subgraph {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];
    for (const kind of kinds) {
      for (const node of getNodesByKind(this.queries, kind)) {
        if (filter(node)) nodes.set(node.id, node);
      }
    }
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        gqmAppendInternalOutgoingEdgesInto({ queries: this.queries, nodeId, nodes, edges });
      }
    }
    return { nodes, edges, roots: [] };
  }

  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
