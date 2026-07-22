import type { Subgraph } from '../graph/types.js';
import type { SearchResult } from '../search/types.js';
import type { EdgeKind, Language, Node, NodeKind } from '../graph/core-types.js';

/**
 * A block of code with context.
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

/**
 * Input for building task context.
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context.
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown'). */
  format?: 'markdown' | 'json' | 'object';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Seed candidates merged into the lexical pool. */
  extraCandidates?: SearchResult[];

  /** Bias retrieval toward behavior-like symbols. */
  behaviorBias?: boolean;

  /** Collect a per-candidate score breakdown. */
  explain?: boolean;
}

/**
 * Full context for a task, ready for Claude.
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context.
 */
export interface FindRelevantContextOptions {
  /** Number of ranked entry-point candidates (default: 3) */
  searchLimit?: number;

  /** Graph traversal depth (default: 1) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 20) */
  maxNodes?: number;

  /** Minimum candidate score after lexical/structural ranking (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];

  /** Externally-supplied candidate set merged into the lexical pool. */
  extraCandidates?: SearchResult[];

  /** Bias retrieval toward function/method/route kinds. */
  behaviorBias?: boolean;

  /** Record candidate scores after each scoring pass. */
  explain?: boolean;
}
