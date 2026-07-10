import type { NodeKind } from '../../src/types.js';

export type SemanticSkipReason = 'no-embeddings' | 'no-source-embedding' | 'endpoint-unavailable';

export interface EvalTestCase {
  id: string;
  /**
   * Free-text query for `searchNodes` / `findRelevantContext` /
   * `searchSemantic` (concept mode). For `searchSemantic` peer mode,
   * leave `query` empty and pass `symbolName` instead.
   */
  query: string;
  api: 'searchNodes' | 'findRelevantContext' | 'searchSemantic';
  expectedSymbols: string[];
  kinds?: NodeKind[];
  options?: Record<string, unknown>;
  /**
   * (api='searchSemantic' peer mode) Source symbol name to find peers
   * of, mutually exclusive with `query`. The runner resolves the name
   * to a node id before calling `cg.llm.findSimilar`.
   */
  symbolName?: string;
}

export interface EvalResult {
  caseId: string;
  pass: boolean;
  recall: number;
  mrr: number;
  foundSymbols: string[];
  missedSymbols: string[];
  nodeCount?: number;
  edgeCount?: number;
  edgeDensity?: number;
  latencyMs: number;
  /**
   * Size of the raw response payload in bytes (B5). Computed by
   * `JSON.stringify`-ing the API result before scoring. Catches
   * regressions where an extractor / formatter bloats per-row output
   * by ~30%+ — the kind of change that erodes the agent's context
   * budget without touching recall or MRR. Optional so old reports
   * still load.
   */
  payloadBytes?: number;
  /**
   * Optional skip status (B9). Semantic cases set this to 'no-
   * embeddings' when the project lacks an embedding model or has no
   * embedding rows on the source symbol — the case can't run usefully
   * but shouldn't fail (`pass=true`) since the gap is environmental,
   * not a regression. Activates automatically when embeddings are
   * loaded.
   */
  skipped?: SemanticSkipReason;
  /** Exact endpoint error retained when a semantic case cannot run. */
  skipDetail?: string;
}

export interface EvalReport {
  timestamp: string;
  codebasePath: string;
  cartographSha: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    meanRecall: number;
    meanMRR: number;
  };
  results: EvalResult[];
}
