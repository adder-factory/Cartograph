import type { Edge, EdgeKind, Node, NodeKind } from '../types.js';

/**
 * A subgraph containing a subset of the knowledge graph.
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /**
   * Per-candidate score breakdown across the retrieval scoring
   * pipeline. Populated only when `findRelevantContext` /
   * `buildContext` is called with `explain: true`.
   */
  scoreTrace?: ScoreExplanation;
}

/** One candidate's score after a single named scoring pass. */
export interface ScorePassEntry {
  /** Pass name, e.g. `lexical-merge`, `centrality`, `behavior-bias`. */
  pass: string;
  /** The candidate's score immediately after that pass ran. */
  score: number;
}

/** The full scoring history of one retrieval candidate. */
export interface CandidateScoreTrace {
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  /** Score after the last pass the candidate was present for. */
  finalScore: number;
  /** Whether the candidate made it into the final entry-point set. */
  survived: boolean;
  /** Score after each pass, in pipeline order. */
  passes: ScorePassEntry[];
}

/**
 * `explain: true` output for `cartograph_context`.
 */
export interface ScoreExplanation {
  /** The query the scorer ran for. */
  query: string;
  /** Ordered names of every scoring pass that ran. */
  passNames: string[];
  /** Survivors first, then the top near-misses. */
  candidates: CandidateScoreTrace[];
}

/**
 * Options for graph traversal.
 */
export interface TraversalOptions {
  /**
   * Maximum depth to traverse (default: 10).
   * Pass `Infinity` to traverse the full reachable subgraph.
   */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}
