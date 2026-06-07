import type { QueryBuilder } from '../db/queries.js';
import type * as graph from '../graph/index.js';

/**
 * Immutable dependencies shared by context-building helper modules.
 * Keep request options out of this contract so each phase declares its
 * own per-call inputs explicitly.
 */
export interface ContextBuilderState {
  queries: QueryBuilder;
  traverser: graph.GraphTraverser;
}
