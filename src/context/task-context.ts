import type { CodeBlock, Node, Subgraph, TaskContext } from '../types.js';
import { runSequential } from '../utils/async-iteration.js';

/** Code-block extraction budget for `extractCodeBlocks`. */
export interface CodeBlockBudget {
  maxBlocks: number;
  maxBlockSize: number;
}

export type NodeCodeLoader = (node: Node) => Promise<string | null>;

export interface BuildTaskContextArgs {
  query: string;
  subgraph: Subgraph;
  codeBlocks: CodeBlock[];
}

const ENTRY_POINTS_INLINE_CAP = 3;

export function buildTaskContext(args: BuildTaskContextArgs): TaskContext {
  const { query, subgraph, codeBlocks } = args;
  const entryPoints = getEntryPoints(subgraph);
  const relatedFiles = getRelatedFiles(subgraph);
  const summary = generateSummary(subgraph, entryPoints, relatedFiles);
  return {
    query,
    subgraph,
    entryPoints,
    codeBlocks,
    relatedFiles,
    summary,
    stats: {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    },
  };
}

/** Extract code blocks for key nodes in the subgraph. */
export async function extractCodeBlocks(
  subgraph: Subgraph,
  budget: CodeBlockBudget,
  loadNodeCode: NodeCodeLoader,
): Promise<CodeBlock[]> {
  const priorityNodes = collectPriorityCodeBlockNodes(subgraph);
  const blocks: CodeBlock[] = [];
  await runSequential(priorityNodes, async (node) => {
    if (blocks.length >= budget.maxBlocks) return false;
    const block = await tryBuildCodeBlock(node, budget.maxBlockSize, loadNodeCode);
    if (block) blocks.push(block);
    return true;
  });
  return blocks;
}

/** Get entry points from a subgraph: the root nodes. */
export function getEntryPoints(subgraph: Subgraph): Node[] {
  return subgraph.roots.map((id) => subgraph.nodes.get(id)).filter((n): n is Node => n !== undefined);
}

/** Get unique sorted file paths from a subgraph. */
export function getRelatedFiles(subgraph: Subgraph): string[] {
  const files = new Set<string>();
  for (const node of subgraph.nodes.values()) files.add(node.filePath);
  return Array.from(files).sort((a, b) => Number(a > b) - Number(a < b));
}

function generateSummary(subgraph: Subgraph, entryPoints: Node[], relatedFiles: string[]): string {
  const entryPointNames = entryPoints
    .slice(0, ENTRY_POINTS_INLINE_CAP)
    .map((n) => n.name)
    .join(', ');
  const overflow = entryPoints.length - ENTRY_POINTS_INLINE_CAP;
  const remaining = overflow > 0 ? ` and ${overflow} more` : '';
  return (
    `Found ${subgraph.nodes.size} relevant code symbols across ${relatedFiles.length} files. ` +
    `Key entry points: ${entryPointNames}${remaining}. ` +
    `${subgraph.edges.length} relationships identified.`
  );
}

/** Read a node's source and wrap it in a CodeBlock, or undefined if extraction fails. */
async function tryBuildCodeBlock(
  node: Node,
  maxBlockSize: number,
  loadNodeCode: NodeCodeLoader,
): Promise<CodeBlock | undefined> {
  const code = await loadNodeCode(node);
  if (!code) return undefined;
  return {
    content: truncateCodeBlock(code, maxBlockSize),
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    language: node.language,
    node,
  };
}

/**
 * Build the priority list for `extractCodeBlocks`: roots first, then non-root
 * functions/methods, then non-root classes.
 */
function collectPriorityCodeBlockNodes(subgraph: Subgraph): Node[] {
  const out: Node[] = [];
  for (const id of subgraph.roots) {
    const node = subgraph.nodes.get(id);
    if (node) out.push(node);
  }
  appendNonRootByKind(subgraph, out, (kind) => kind === 'function' || kind === 'method');
  appendNonRootByKind(subgraph, out, (kind) => kind === 'class');
  return out;
}

/** Append nodes to `out` whose kind matches `pred` and which are not roots. */
function appendNonRootByKind(subgraph: Subgraph, out: Node[], pred: (kind: string) => boolean): void {
  for (const node of subgraph.nodes.values()) {
    if (subgraph.roots.includes(node.id)) continue;
    if (pred(node.kind)) out.push(node);
  }
}

function truncateCodeBlock(code: string, maxBytes: number): string {
  if (code.length <= maxBytes) return code;
  return code.slice(0, maxBytes) + '\n// ... truncated ...';
}
