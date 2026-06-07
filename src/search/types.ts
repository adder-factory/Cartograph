import type { Language, Node, NodeKind } from '../types.js';

/**
 * Options for searching the graph.
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** Inline `path:` file path substrings to include after the retrieval cascade. */
  pathFilters?: string[];

  /** Top-level pathFilter prefixes to include after the retrieval cascade. */
  pathPrefixes?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;

  /**
   * Cap the number of results from any single file before returning.
   * Default 3. Set to 0 to disable diversification.
   */
  perFileCap?: number;
}

/**
 * A search result with relevance scoring.
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}
