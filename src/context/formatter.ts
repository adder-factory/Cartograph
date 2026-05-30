/**
 * Context Formatter
 *
 * Formats TaskContext as markdown or JSON for consumption by Claude.
 */

import type { Node, Edge, TaskContext } from '../types.js';

/**
 * Format entry points section of markdown output.
 */
function formatEntryPointsSection(nodes: Node[]): string[] {
  if (nodes.length === 0) return [];
  const lines: string[] = ['### Entry Points\n'];
  for (const node of nodes) {
    const location = node.startLine ? `:${node.startLine}` : '';
    lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}`);
    if (node.signature) {
      lines.push(`  \`${node.signature}\``);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Format related symbols section of markdown output.
 */
function formatRelatedSymbolsSection(otherSymbols: Node[]): string[] {
  if (otherSymbols.length === 0) return [];
  const lines: string[] = ['### Related Symbols\n'];
  const byFile = new Map<string, Node[]>();
  for (const node of otherSymbols) {
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }
  for (const [file, nodes] of byFile) {
    const nodeList = nodes.map((n) => `${n.name}:${n.startLine}`).join(', ');
    lines.push(`- ${file}: ${nodeList}`);
  }
  lines.push('');
  return lines;
}

/**
 * Format code blocks section of markdown output.
 */
function formatCodeBlocksSection(codeBlocks: TaskContext['codeBlocks']): string[] {
  if (codeBlocks.length === 0) return [];
  const lines: string[] = ['### Code\n'];
  for (const block of codeBlocks) {
    const nodeName = block.node?.name ?? 'Unknown';
    lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
    lines.push('```' + block.language);
    lines.push(block.content);
    lines.push('```\n');
  }
  return lines;
}

/**
 * Format context as markdown
 *
 * Creates a compact markdown document optimized for Claude with minimal context usage:
 * - Brief summary
 * - Entry points with locations
 * - Code blocks only for key symbols
 */
export function formatContextAsMarkdown(context: TaskContext): string {
  const lines: string[] = [];

  // Header with query
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  // Entry points - compact format
  lines.push(...formatEntryPointsSection(context.entryPoints));

  // Related symbols - compact list (skip verbose structure tree)
  const otherSymbols = Array.from(context.subgraph.nodes.values())
    .filter((n) => !context.entryPoints.some((e) => e.id === n.id))
    .slice(0, 10); // Limit to 10 related symbols
  lines.push(...formatRelatedSymbolsSection(otherSymbols));

  // Code blocks - only for key entry points
  lines.push(...formatCodeBlocksSection(context.codeBlocks));

  return lines.join('\n');
}

/**
 * Format context as JSON
 *
 * Returns a structured JSON representation suitable for programmatic use.
 */
export function formatContextAsJson(context: TaskContext): string {
  // Convert Map to array for JSON serialization
  const serializable = {
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.map(serializeNode),
    nodes: Array.from(context.subgraph.nodes.values()).map(serializeNode),
    edges: context.subgraph.edges.map(serializeEdge),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: block.content,
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    relatedFiles: context.relatedFiles,
    stats: context.stats,
  };

  return JSON.stringify(serializable, null, 2);
}

/**
 * Serialize a node for JSON output
 */
function serializeNode(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
  };
}

/**
 * Serialize an edge for JSON output
 */
function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
  };
}
