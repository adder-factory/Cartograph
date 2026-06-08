import type { QueryBuilder } from '../../db/queries.js';
import type { Edge, EdgeKind, FileRecord, Node, NodeKind } from '../../types.js';
import { formatGraphExportSnapshot } from './format.js';
import {
  DEFAULT_GRAPH_EXPORT_LIMIT,
  GRAPH_EXPORT_EDGE_KINDS,
  GRAPH_EXPORT_FORMATS,
  GRAPH_EXPORT_NODE_KINDS,
  MAX_GRAPH_EXPORT_LIMIT,
  type GraphExportEdge,
  type GraphExportFile,
  type GraphExportFormat,
  type GraphExportInput,
  type GraphExportNode,
  type GraphExportOptions,
  type GraphExportRawOptions,
  type GraphExportSnapshot,
} from './contract.js';

export interface GraphExportGraph {
  queries: QueryBuilder;
  close: () => void;
}

export interface GraphExportRuntimeDeps {
  isInitialized: (projectPath: string) => boolean;
  openCartograph: (projectPath: string) => Promise<GraphExportGraph>;
  getAllNodes: (queries: QueryBuilder) => Node[];
  getAllEdges: (queries: QueryBuilder) => Edge[];
  getAllFiles: (queries: QueryBuilder) => FileRecord[];
}

export type GraphExportParseResult = { ok: true; options: GraphExportOptions } | { ok: false; error: string };

export type GraphExportRunResult =
  | { ok: true; artifact: string; snapshot: GraphExportSnapshot }
  | { ok: false; error: string };

const FORMAT_SET: ReadonlySet<string> = new Set(GRAPH_EXPORT_FORMATS);
const NODE_KIND_SET: ReadonlySet<string> = new Set(GRAPH_EXPORT_NODE_KINDS);
const EDGE_KIND_SET: ReadonlySet<string> = new Set(GRAPH_EXPORT_EDGE_KINDS);

export function parseGraphExportOptions(raw: GraphExportRawOptions): GraphExportParseResult {
  const formatRaw = raw.format?.trim() || 'json';
  if (!FORMAT_SET.has(formatRaw)) {
    return {
      ok: false,
      error: `--format must be one of: ${GRAPH_EXPORT_FORMATS.join(', ')}; got ${JSON.stringify(formatRaw)}`,
    };
  }

  const limit = parseLimit(raw.limit);
  if (!limit.ok) return limit;

  const kinds = parseCsvEnum<NodeKind>({
    label: '--kind',
    raw: raw.kind,
    allowed: NODE_KIND_SET,
    allowedValues: GRAPH_EXPORT_NODE_KINDS,
  });
  if (!kinds.ok) return kinds;

  const edgeKinds = parseCsvEnum<EdgeKind>({
    label: '--edge-kind',
    raw: raw.edgeKind,
    allowed: EDGE_KIND_SET,
    allowedValues: GRAPH_EXPORT_EDGE_KINDS,
  });
  if (!edgeKinds.ok) return edgeKinds;

  return {
    ok: true,
    options: {
      projectPath: raw.projectPath,
      format: formatRaw as GraphExportFormat,
      limit: limit.value,
      kinds: kinds.values,
      edgeKinds: edgeKinds.values,
      languages: parseCsv(raw.language),
      ...(raw.file?.trim() ? { filePrefix: normalizeFilePrefix(raw.file) } : {}),
    },
  };
}

function parseLimit(raw: string | number | undefined): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, value: DEFAULT_GRAPH_EXPORT_LIMIT };
  const text = String(raw).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    return {
      ok: false,
      error: `--limit must be an integer between 1 and ${MAX_GRAPH_EXPORT_LIMIT} (got ${JSON.stringify(text)})`,
    };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GRAPH_EXPORT_LIMIT) {
    return {
      ok: false,
      error: `--limit must be an integer between 1 and ${MAX_GRAPH_EXPORT_LIMIT} (got ${JSON.stringify(text)})`,
    };
  }
  return { ok: true, value };
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

interface ParseCsvEnumArgs {
  label: string;
  raw: string | undefined;
  allowed: ReadonlySet<string>;
  allowedValues: readonly string[];
}

function parseCsvEnum<T extends string>(
  args: ParseCsvEnumArgs,
): { ok: true; values: T[] } | { ok: false; error: string } {
  const { label, raw, allowed, allowedValues } = args;
  const values = parseCsv(raw);
  const invalid = values.filter((v) => !allowed.has(v));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `${label} must contain only: ${allowedValues.join(', ')}; got ${invalid.map((v) => JSON.stringify(v)).join(', ')}`,
    };
  }
  return { ok: true, values: values as T[] };
}

function normalizeFilePrefix(raw: string): string {
  return raw.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export async function runGraphExport(
  rawOptions: GraphExportRawOptions,
  deps: GraphExportRuntimeDeps,
): Promise<GraphExportRunResult> {
  const parsed = parseGraphExportOptions(rawOptions);
  if (!parsed.ok) return parsed;
  const options = parsed.options;

  if (!deps.isInitialized(options.projectPath)) {
    return { ok: false, error: `Cartograph not initialized in ${options.projectPath}` };
  }

  let graph: GraphExportGraph | null = null;
  try {
    graph = await deps.openCartograph(options.projectPath);
    const snapshot = buildGraphExportSnapshot(
      {
        nodes: deps.getAllNodes(graph.queries),
        edges: deps.getAllEdges(graph.queries),
        files: deps.getAllFiles(graph.queries),
      },
      options,
    );
    return { ok: true, snapshot, artifact: formatGraphExportSnapshot(snapshot, options.format) };
  } finally {
    graph?.close();
  }
}

export function buildGraphExportSnapshot(input: GraphExportInput, options: GraphExportOptions): GraphExportSnapshot {
  const kindFilter = nonEmptySet(options.kinds);
  const edgeKindFilter = nonEmptySet(options.edgeKinds);
  const languageFilter = nonEmptySet(options.languages);
  const filePrefix = options.filePrefix;

  const filteredNodes = sortNodes(
    input.nodes.filter((node) => {
      if (kindFilter && !kindFilter.has(node.kind)) return false;
      if (languageFilter && !languageFilter.has(node.language)) return false;
      if (filePrefix && !node.filePath.startsWith(filePrefix)) return false;
      return true;
    }),
  );
  const exportedNodes = filteredNodes.slice(0, options.limit);
  const exportedNodeIds = new Set(exportedNodes.map((node) => node.id));

  const exportedEdges = sortEdges(
    input.edges.filter((edge) => {
      if (!exportedNodeIds.has(edge.source) || !exportedNodeIds.has(edge.target)) return false;
      if (edgeKindFilter && !edgeKindFilter.has(edge.kind)) return false;
      return true;
    }),
  );

  const filePaths = new Set(exportedNodes.map((node) => node.filePath));
  const exportedFiles = input.files
    .filter((file) => filePaths.has(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(toExportFile);

  return {
    formatVersion: 1,
    filters: {
      kinds: [...options.kinds],
      edgeKinds: [...options.edgeKinds],
      languages: [...options.languages],
      ...(filePrefix ? { filePrefix } : {}),
    },
    stats: {
      totalNodes: input.nodes.length,
      totalEdges: input.edges.length,
      exportedNodes: exportedNodes.length,
      exportedEdges: exportedEdges.length,
      exportedFiles: exportedFiles.length,
      truncatedNodes: Math.max(0, filteredNodes.length - exportedNodes.length),
    },
    nodes: exportedNodes.map(toExportNode),
    edges: exportedEdges.map(toExportEdge),
    files: exportedFiles,
  };
}

function nonEmptySet<T>(values: readonly T[]): ReadonlySet<T> | null {
  return values.length > 0 ? new Set(values) : null;
}

function sortNodes(nodes: readonly Node[]): Node[] {
  return [...nodes].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

function sortEdges(edges: readonly Edge[]): Edge[] {
  return [...edges].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.kind.localeCompare(b.kind) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}

function toExportNode(node: Node): GraphExportNode {
  const out: GraphExportNode = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
  };
  if (node.signature) out.signature = node.signature;
  if (typeof node.isExported === 'boolean') out.isExported = node.isExported;
  return out;
}

function toExportEdge(edge: Edge): GraphExportEdge {
  const out: GraphExportEdge = {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  };
  if (typeof edge.line === 'number') out.line = edge.line;
  if (typeof edge.column === 'number') out.column = edge.column;
  if (edge.confidence) out.confidence = edge.confidence;
  return out;
}

function toExportFile(file: FileRecord): GraphExportFile {
  return {
    path: file.path,
    language: file.language,
    nodeCount: file.nodeCount,
  };
}
