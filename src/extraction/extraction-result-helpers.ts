import type { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types.js';

/**
 * Shared accumulator fields that every self-contained extractor (GraphQL,
 * HCL, SQL, …) keeps as private class members. `buildExtractionResult` reads
 * them plus the epoch captured at the start of `extract()` and returns the
 * assembled {@link ExtractionResult}.
 *
 * Keep this interface in sync with the field layout that each extractor
 * declares — they are identical by convention, not inheritance.
 */
export interface ExtractionAccumulators {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

/**
 * Assemble an {@link ExtractionResult} from the accumulated state and the
 * epoch captured at the start of `extract()`.  Used by every standalone
 * extractor that keeps its own `nodes / edges / unresolvedReferences / errors`
 * accumulators (GraphQL, HCL, SQL).
 */
export function buildExtractionResult(acc: ExtractionAccumulators, startTime: number): ExtractionResult {
  return {
    nodes: acc.nodes,
    edges: acc.edges,
    unresolvedReferences: acc.unresolvedReferences,
    errors: acc.errors,
    durationMs: Date.now() - startTime,
  };
}
