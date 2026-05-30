/**
 * Default knobs for `buildSimilarToEdges`.
 *
 * Kept in this dependency-free module — separate from `similar-edges.ts`
 * — so the CLI and the `cartograph_admin` MCP tool can reference the
 * defaults at command-definition time (option defaults, help text)
 * without eagerly loading the HNSW-heavy `similar-edges` module that
 * both surfaces otherwise lazy-import only when the action actually runs.
 */

/** Default number of nearest neighbors to find per node. */
export const DEFAULT_SIMILAR_K = 5;

/**
 * Default minimum cosine similarity required to create a `similar_to`
 * edge. Nodes whose similarity falls below this are skipped.
 */
export const DEFAULT_SIMILAR_MIN_SCORE = 0.6;
