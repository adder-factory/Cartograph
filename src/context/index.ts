/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import type { Edge, Node } from '../types.js';
import type { Subgraph } from '../graph/types.js';
import type { BuildContextOptions, FindRelevantContextOptions, TaskContext, TaskInput } from './types.js';
import type { QueryBuilder } from '../db/queries.js';
import type { GraphTraverser } from '../graph/index.js';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter.js';
import { ScoreTrace } from './score-trace.js';
import { buildTaskContext, extractCodeBlocks } from './task-context.js';
import type { ContextBuilderState } from './builder-state.js';
import { normalizeBuildOptions, normalizeFindOptions } from './options.js';
import { expandTypeHierarchy, expandViaTraversal, finaliseSubgraph } from './subgraph.js';
import { extractNodeSourceCode } from './source-code.js';
import { collectAndScoreContextCandidates } from './candidate-search.js';

/** Render a `TaskInput` (string or `{title, description?}`) into the
 *  composite query string used by {@link ContextBuilder.buildContext}. */
function stringifyTaskInput(input: TaskInput): string {
  if (typeof input === 'string') return input;
  if (input.description) return `${input.title}: ${input.description}`;
  return input.title;
}

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private readonly projectRoot: string;
  private readonly queries: QueryBuilder;
  private readonly traverser: GraphTraverser;

  constructor(projectRoot: string, queries: QueryBuilder, traverser: GraphTraverser) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  /** Snapshot of the builder's immutable dependencies for module-scope helpers. */
  private state(): ContextBuilderState {
    return { projectRoot: this.projectRoot, queries: this.queries, traverser: this.traverser };
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(input: TaskInput, options: BuildContextOptions = {}): Promise<TaskContext | string> {
    const opts = normalizeBuildOptions(options);
    const query = stringifyTaskInput(input);

    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
      extraCandidates: opts.extraCandidates,
      behaviorBias: opts.behaviorBias,
      explain: opts.explain,
    });

    const codeBlocks = opts.includeCode
      ? await extractCodeBlocks(
          subgraph,
          {
            maxBlocks: opts.maxCodeBlocks,
            maxBlockSize: opts.maxCodeBlockSize,
          },
          (node) => extractNodeSourceCode(this.projectRoot, node),
        )
      : [];
    const context = buildTaskContext({ query, subgraph, codeBlocks });

    if (opts.format === 'markdown') return formatContextAsMarkdown(context);
    if (opts.format === 'json') return formatContextAsJson(context);
    return context;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(query: string, options: FindRelevantContextOptions = {}): Promise<Subgraph> {
    const opts = normalizeFindOptions(options);

    if (!query || query.trim().length === 0) {
      return { nodes: new Map<string, Node>(), edges: [], roots: [] };
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
    const st = this.state();
    const trace = opts.explain ? new ScoreTrace() : undefined;
    const filteredResults = collectAndScoreContextCandidates(st, { query, opts, isTestQuery, trace });

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Type-hierarchy expansion: ensure subclasses and superclasses of
    // class/interface entry points appear in results, bounded by
    // maxNodes/4 to avoid flooding.
    expandTypeHierarchy(st, { filteredResults, nodes, edges, roots, maxNodes: opts.maxNodes });
    expandViaTraversal(st, filteredResults, { nodes, edges, opts });
    const subgraph = finaliseSubgraph(st, { nodes, edges, roots, maxNodes: opts.maxNodes, isTestQuery });
    if (trace) subgraph.scoreTrace = trace.finalize(query, filteredResults);
    return subgraph;
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return extractNodeSourceCode(this.projectRoot, node);
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter.js';
