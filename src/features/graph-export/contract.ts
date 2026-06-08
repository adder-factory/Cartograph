import type { Edge, EdgeKind, FileRecord, Node, NodeKind } from '../../types.js';

export const GRAPH_EXPORT_FORMATS = ['json', 'dot', 'mermaid', 'cytoscape'] as const;
export type GraphExportFormat = (typeof GRAPH_EXPORT_FORMATS)[number];

export const DEFAULT_GRAPH_EXPORT_LIMIT = 1000;
export const MAX_GRAPH_EXPORT_LIMIT = 50_000;

export const GRAPH_EXPORT_NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'table',
  'resource',
] as const satisfies readonly NodeKind[];

export const GRAPH_EXPORT_EDGE_KINDS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
  'tests',
  'field_access',
  'similar_to',
  'def_use',
] as const satisfies readonly EdgeKind[];

type _NodeKindCoverageOk<Missing = Exclude<NodeKind, (typeof GRAPH_EXPORT_NODE_KINDS)[number]>> = [Missing] extends [
  never,
]
  ? true
  : never;

type _EdgeKindCoverageOk<Missing = Exclude<EdgeKind, (typeof GRAPH_EXPORT_EDGE_KINDS)[number]>> = [Missing] extends [
  never,
]
  ? true
  : never;

function assertGraphKindCoverage(_node: _NodeKindCoverageOk, _edge: _EdgeKindCoverageOk): true {
  return true;
}
assertGraphKindCoverage(true, true);

export interface GraphExportFilters {
  kinds: NodeKind[];
  edgeKinds: EdgeKind[];
  languages: string[];
  filePrefix?: string;
}

export interface GraphExportOptions extends GraphExportFilters {
  projectPath: string;
  format: GraphExportFormat;
  limit: number;
}

export interface GraphExportRawOptions {
  projectPath: string;
  format?: string;
  limit?: string | number;
  kind?: string;
  edgeKind?: string;
  language?: string;
  file?: string;
}

export interface GraphExportNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  signature?: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  isExported?: boolean;
}

export interface GraphExportEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
  column?: number;
  confidence?: Edge['confidence'];
}

export interface GraphExportFile {
  path: string;
  language: string;
  nodeCount: number;
}

interface GraphExportStats {
  totalNodes: number;
  totalEdges: number;
  exportedNodes: number;
  exportedEdges: number;
  exportedFiles: number;
  truncatedNodes: number;
}

export interface GraphExportSnapshot {
  formatVersion: 1;
  filters: GraphExportFilters;
  stats: GraphExportStats;
  nodes: GraphExportNode[];
  edges: GraphExportEdge[];
  files: GraphExportFile[];
}

export interface GraphExportInput {
  nodes: readonly Node[];
  edges: readonly Edge[];
  files: readonly FileRecord[];
}
