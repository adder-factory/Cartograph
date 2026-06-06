import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from '../../embeddings/similarity-defaults.js';

export interface ParsedSimilarityEdgeArgs {
  k?: number;
  minScore?: number;
}

export interface SimilarityEdgeBuildOptions {
  k: number;
  minScore: number;
}

export function resolveSimilarityEdgeBuildOptions(parsed: ParsedSimilarityEdgeArgs): SimilarityEdgeBuildOptions {
  return {
    k: parsed.k ?? DEFAULT_SIMILAR_K,
    minScore: parsed.minScore ?? DEFAULT_SIMILAR_MIN_SCORE,
  };
}
