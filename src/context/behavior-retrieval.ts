import { logDebug } from '../errors.js';
import type { SearchResult } from '../search/types.js';
import { z } from 'zod';

export const ContextRetrievalModeSchema = z.enum(['auto', 'deterministic', 'hybrid']);
type ContextRetrievalMode = z.infer<typeof ContextRetrievalModeSchema>;

const BehaviorRetrievalTraceSchema = z.object({
  requested: ContextRetrievalModeSchema,
  strategy: z.enum(['lexical-graph', 'hybrid']),
  hybridAttempted: z.boolean(),
  hybridCandidateCount: z.number().int().nonnegative(),
  reason: z.enum([
    'explicit-deterministic',
    'explicit-hybrid',
    'non-behavior-query',
    'behavior-query',
    'hybrid-failed',
  ]),
});
export type BehaviorRetrievalTrace = z.infer<typeof BehaviorRetrievalTraceSchema>;

/** Minimal search surface needed to prepare behavior-question context. */
interface BehaviorSearchService {
  searchHybrid(query: string, options: { limit: number }): Promise<SearchResult[]>;
}

export interface BehaviorRetrievalOptions {
  extraCandidates: SearchResult[];
  behaviorBias: boolean;
  searchLimit?: number;
  trace: BehaviorRetrievalTrace;
}

interface PrepareBehaviorRetrievalArgs {
  search: BehaviorSearchService;
  task: string;
  maxNodes: number;
  retrievalMode?: ContextRetrievalMode;
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
export async function prepareBehaviorRetrieval(args: PrepareBehaviorRetrievalArgs): Promise<BehaviorRetrievalOptions> {
  const { search, task, maxNodes, retrievalMode = 'auto' } = args;
  const behaviorQuestion = looksLikeBehaviorQuestion(task);
  if (retrievalMode === 'deterministic') {
    const searchLimit = behaviorQuestion ? Math.min(BEHAVIOR_QUESTION_SEARCH_LIMIT, maxNodes) : undefined;
    return {
      extraCandidates: [],
      behaviorBias: behaviorQuestion,
      ...(searchLimit === undefined ? {} : { searchLimit }),
      trace: makeRetrievalTrace({
        requested: retrievalMode,
        strategy: 'lexical-graph',
        hybridAttempted: false,
        hybridCandidateCount: 0,
        reason: 'explicit-deterministic',
      }),
    };
  }

  if (!behaviorQuestion && retrievalMode === 'auto') {
    return {
      extraCandidates: [],
      behaviorBias: false,
      trace: makeRetrievalTrace({
        requested: retrievalMode,
        strategy: 'lexical-graph',
        hybridAttempted: false,
        hybridCandidateCount: 0,
        reason: 'non-behavior-query',
      }),
    };
  }

  const searchLimit = behaviorQuestion ? Math.min(BEHAVIOR_QUESTION_SEARCH_LIMIT, maxNodes) : undefined;
  try {
    const extraCandidates = await search.searchHybrid(task, { limit: maxNodes * 2 });
    return {
      extraCandidates,
      behaviorBias: behaviorQuestion,
      ...(searchLimit === undefined ? {} : { searchLimit }),
      trace: makeRetrievalTrace({
        requested: retrievalMode,
        strategy: 'hybrid',
        hybridAttempted: true,
        hybridCandidateCount: extraCandidates.length,
        reason: retrievalMode === 'hybrid' ? 'explicit-hybrid' : 'behavior-query',
      }),
    };
  } catch (error) {
    logDebug('behavior context: hybrid candidate fetch failed', { error: String(error) });
    return {
      extraCandidates: [],
      behaviorBias: behaviorQuestion,
      ...(searchLimit === undefined ? {} : { searchLimit }),
      trace: makeRetrievalTrace({
        requested: retrievalMode,
        strategy: 'lexical-graph',
        hybridAttempted: true,
        hybridCandidateCount: 0,
        reason: 'hybrid-failed',
      }),
    };
  }
}

function makeRetrievalTrace(value: BehaviorRetrievalTrace): BehaviorRetrievalTrace {
  return BehaviorRetrievalTraceSchema.parse(value);
}
