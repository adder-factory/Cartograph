import type { GraphExportEdge, GraphExportFormat, GraphExportNode, GraphExportSnapshot } from './contract.js';

export function formatGraphExportSnapshot(snapshot: GraphExportSnapshot, format: GraphExportFormat): string {
  if (format === 'json') return `${JSON.stringify(snapshot, null, 2)}\n`;
  if (format === 'dot') return formatDot(snapshot);
  if (format === 'mermaid') return formatMermaid(snapshot);
  return `${JSON.stringify(formatCytoscape(snapshot), null, 2)}\n`;
}

function formatDot(snapshot: GraphExportSnapshot): string {
  const lines = [
    'digraph cartograph {',
    '  graph [rankdir=LR];',
    '  node [shape=box, style="rounded"];',
    '  edge [fontsize=10];',
  ];
  for (const node of snapshot.nodes) {
    lines.push(`  ${dotQuote(node.id)} [label=${dotQuote(nodeLabel(node))}];`);
  }
  for (const edge of snapshot.edges) {
    lines.push(`  ${dotQuote(edge.source)} -> ${dotQuote(edge.target)} [label=${dotQuote(edge.kind)}];`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function formatMermaid(snapshot: GraphExportSnapshot): string {
  const ids = new Map<string, string>();
  const lines = ['flowchart LR'];
  snapshot.nodes.forEach((node, index) => {
    const id = `n${index}`;
    ids.set(node.id, id);
    lines.push(`  ${id}["${escapeMermaidLabel(nodeLabel(node))}"]`);
  });
  for (const edge of snapshot.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) continue;
    lines.push(`  ${source} -->|${escapeMermaidLabel(edge.kind)}| ${target}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatCytoscape(snapshot: GraphExportSnapshot): {
  formatVersion: 1;
  metadata: Pick<GraphExportSnapshot, 'filters' | 'stats'>;
  elements: {
    nodes: Array<{ data: Record<string, string | number> }>;
    edges: Array<{ data: Record<string, string | number> }>;
  };
} {
  return {
    formatVersion: 1,
    metadata: {
      filters: snapshot.filters,
      stats: snapshot.stats,
    },
    elements: {
      nodes: snapshot.nodes.map((node) => ({
        data: {
          id: node.id,
          label: nodeLabel(node),
          kind: node.kind,
          name: node.name,
          qualifiedName: node.qualifiedName,
          filePath: node.filePath,
          language: node.language,
          startLine: node.startLine,
        },
      })),
      edges: snapshot.edges.map((edge, index) => ({ data: cytoscapeEdgeData(edge, index) })),
    },
  };
}

function cytoscapeEdgeData(edge: GraphExportEdge, index: number): Record<string, string | number> {
  const data: Record<string, string | number> = {
    id: `e${index}`,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    label: edge.kind,
  };
  if (typeof edge.line === 'number') data['line'] = edge.line;
  if (typeof edge.column === 'number') data['column'] = edge.column;
  return data;
}

function nodeLabel(node: GraphExportNode): string {
  const fileLine = node.startLine > 0 ? `${node.filePath}:${node.startLine}` : node.filePath;
  return `${node.qualifiedName || node.name}\n${node.kind}\n${fileLine}`;
}

function dotQuote(value: string): string {
  return JSON.stringify(value);
}

function escapeMermaidLabel(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('|', '&#124;')
    .replaceAll('\n', '<br/>');
}
