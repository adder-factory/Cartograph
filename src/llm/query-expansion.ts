/**
 * Query expansion via local LLM.
 *
 * When a semantic search returns low-confidence results (top-1 cosine
 * below threshold), {@link expandQuery} asks the configured chat model
 * for a handful of paraphrases of the original query. The caller
 * embeds each paraphrase, runs them through {@link llmSemanticTopK},
 * and max-pools the candidate scores across the original + expansions.
 *
 * Cache: in-memory `Map` keyed by `sha256(n + ':' + text)`. Volatile
 * (one process lifetime) — by design: paraphrases are cheap once
 * cached but live LLMs evolve, so binding them to disk would freeze
 * stale rewrites in. Bounded LRU-ish via {@link CACHE_CAPACITY} so a
 * long-lived MCP server can't OOM on unique queries.
 *
 * Anti-goals:
 *   - Do NOT bypass `signal.aborted` — the caller's cancellation must
 *     terminate the LLM call.
 *   - Do NOT throw on LLM unreachability — return empty so callers
 *     fall back to the unexpanded query path.
 */

import { createHash } from 'node:crypto';

import type { LlmClient } from './client.js';
import { logDebug } from '../errors.js';

/** Soft cap on the in-memory paraphrase cache. Maps preserve insertion
 *  order so eviction is "oldest first" — good enough for query-shape
 *  workloads where rewrites cluster on a small set of recent queries. */
const CACHE_CAPACITY = 256;
/** Default paraphrase count when callers don't override `n`. */
const DEFAULT_PARAPHRASE_COUNT = 3;
/** Chat-call temperature for paraphrase generation — moderate diversity. */
const PARAPHRASE_TEMPERATURE = 0.7;
/** Max tokens per paraphrase batch. Three paraphrases at ~50 tokens each
 *  comfortably fits under 200; larger budgets just waste latency. */
const PARAPHRASE_MAX_TOKENS = 200;
/** Drop paraphrases whose length exceeds this — almost certainly the
 *  model dumped a paragraph instead of a one-liner. */
const PARAPHRASE_MAX_LINE_CHARS = 500;

const cache = new Map<string, string[]>();

export interface ExpandQueryArgs {
  llmClient: LlmClient;
  text: string;
  /** Active chat-model identifier — folded into the cache key so a
   *  config swap doesn't replay stale paraphrases. */
  model: string;
  /** How many paraphrases to request. Default 3. */
  n?: number;
  signal?: AbortSignal;
  /** Route through localLlm when configured (saves ask/summarize quota). */
  useLocalChat?: boolean;
}

/**
 * Ask the chat model for `n` paraphrases of `text`. Returns an empty
 * array on LLM error / abort / unreachable backend so callers can
 * proceed without paying a query-path stall.
 *
 * Caching: the returned array is memoised under
 * `sha256(model + ':' + n + ':' + text)`; subsequent calls with the
 * same text + n + model are zero-cost. The model is part of the key
 * so a config swap never replays the prior model's paraphrases.
 */
export async function expandQuery(args: ExpandQueryArgs): Promise<string[]> {
  const { llmClient, text, model, n = DEFAULT_PARAPHRASE_COUNT, signal, useLocalChat = true } = args;
  if (n < 1 || text.trim().length === 0) return [];

  const key = createHash('sha256').update(`${model}:${n}:${text}`).digest('hex');
  const cached = cache.get(key);
  if (cached) {
    // Bump the entry to "most recent" so LRU eviction works.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  // Reachability check is gated to cache-miss only — a hot cache
  // serves zero round-trips, even on a torn-down chat backend.
  try {
    if (!(await llmClient.isReachable())) return [];
  } catch {
    return [];
  }

  const messages = [
    {
      role: 'system' as const,
      content:
        'You rewrite code-search queries. For the given query, output exactly the requested number of alternative phrasings, each on its own line. No numbering, no commentary, no quotation marks — just the rephrased queries themselves.',
    },
    {
      role: 'user' as const,
      content: `Rewrite the following code-search query into ${n} alternative phrasings, one per line:\n\n${text}`,
    },
  ];

  let result: Awaited<ReturnType<typeof llmClient.chat>>;
  try {
    result = await llmClient.chat(messages, {
      temperature: PARAPHRASE_TEMPERATURE,
      maxTokens: PARAPHRASE_MAX_TOKENS,
      ...(signal ? { signal } : {}),
      useLocalChat,
    });
  } catch (err) {
    logDebug('expandQuery: LLM call failed; returning no paraphrases', {
      error: String(err),
    });
    return [];
  }

  const lines = result.text
    .split('\n')
    .map((l) => l.replace(/^[\d.\-)*\s]+/, '').trim())
    .filter((l) => l.length > 0 && l.length < PARAPHRASE_MAX_LINE_CHARS && l !== text)
    .slice(0, n);

  if (cache.size >= CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, lines);
  logDebug('expandQuery: produced paraphrases', { n: lines.length, of: n });
  return lines;
}

/**
 * Clear the in-process paraphrase cache. Used by tests and by config-
 * change handlers (model swap → prior paraphrases may diverge).
 */
export function clearExpansionCache(): void {
  cache.clear();
}

/** Visible to tests for exact-size assertions. */
export function _expansionCacheSize(): number {
  return cache.size;
}
