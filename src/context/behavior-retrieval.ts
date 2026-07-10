import { logDebug } from '../errors.js';
import type { SearchResult } from '../search/types.js';

/** Minimal search surface needed to prepare behavior-question context. */
export interface BehaviorSearchService {
  searchHybrid(query: string, options: { limit: number }): Promise<SearchResult[]>;
}

export interface BehaviorRetrievalOptions {
  extraCandidates: SearchResult[];
  behaviorBias: boolean;
  searchLimit?: number;
}

/**
 * Phrasings that ask for gating logic, decisions, or control flow rather
 * than only the shape of a type.
 */
const BEHAVIOR_QUESTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bhow\s+does?\b/i,
  /\bhow\s+do\b/i,
  /\bwhen\s+does?\b/i,
  /\bwhen\s+is\b/i,
  /\bwhy\s+does?\b/i,
  /\bwhat\s+triggers?\b/i,
  /\bwhat\s+causes?\b/i,
  /\bdecides?\s+(?:when|whether|if|how)\b/i,
  /\b(?:trigger|triggers|triggered|triggering)\b/i,
  /\bhappens?\s+(?:when|after|before|on)\b/i,
  /\bgated\s+by\b/i,
  /\bcontrol\s+flow\b/i,
  /\b(?:dispatch|dispatches|dispatched)\b/i,
];

/**
 * Behavior questions need a wider entry-point window than shape lookups.
 * Eight is enough for behavioral hubs to clear common shape-symbol matches
 * while keeping traversal breadth available inside the response node budget.
 */
export const BEHAVIOR_QUESTION_SEARCH_LIMIT = 8;

export function looksLikeBehaviorQuestion(task: string): boolean {
  return BEHAVIOR_QUESTION_PATTERNS.some((pattern) => pattern.test(task));
}

/**
 * Prepare the behavior-aware candidate channel shared by the MCP tool and
 * retrieval evaluations. Hybrid search is best-effort: an unavailable
 * embedding backend must degrade to the lexical baseline.
 */
export async function prepareBehaviorRetrieval(
  search: BehaviorSearchService,
  task: string,
  maxNodes: number,
): Promise<BehaviorRetrievalOptions> {
  if (!looksLikeBehaviorQuestion(task)) {
    return { extraCandidates: [], behaviorBias: false };
  }

  let extraCandidates: SearchResult[] = [];
  try {
    extraCandidates = await search.searchHybrid(task, { limit: maxNodes * 2 });
  } catch (error) {
    logDebug('behavior context: hybrid candidate fetch failed', { error: String(error) });
  }

  return {
    extraCandidates,
    behaviorBias: true,
    searchLimit: Math.min(BEHAVIOR_QUESTION_SEARCH_LIMIT, maxNodes),
  };
}
