/**
 * Symbol Summarizer
 *
 * Generates one-line LLM descriptions of source-code symbols that lack
 * meaningful docstrings. Cached per symbol with a content_hash so the
 * summary stays in sync with the body — change the body, the next pass
 * regenerates only that symbol.
 *
 * Designed to run as a background job after `indexAll` / `sync` so the
 * CLI returns immediately. The user can query cartograph while summaries
 * arrive incrementally.
 *
 * Optionally batches multiple cache-MISS symbols into a single chat
 * call (off by default; the caller passes `summaryBatchSize` based on
 * the chat provider — claude-bridge subprocess and remote-API providers
 * benefit from batching, single-stream local servers don't). Cache
 * hits are NEVER batched: they short-circuit to a per-symbol path
 * that does no LLM work.
 *
 * Pure data layer + driver — the LLM HTTP work lives in `LlmClient`.
 */

import * as fs from 'node:fs';
import { z } from 'zod';
import type { Node } from '../types.js';
import { symbolBodyHash, sliceSymbolBody } from '../extraction/symbol-body-hash.js';
import type { QueryBuilder } from '../db/queries.js';
import {
  getSummarizableNodes,
  getSymbolSummary,
  getSummaryByContentHash,
  upsertSymbolSummary,
} from '../db/queries-summaries.js';
import {
  getPriorityNodeIds,
  clearPriorityQueueForNode,
  recordPriorityQueueFailure,
} from '../db/queries-summary-priority.js';
import { type LlmClient, LlmEndpointError, BATCH_PARSE_FAILURE_LOG_CHARS } from './client.js';
import { extractJsonArrayFromText } from './json-utils.js';
import { logDebug, logWarn } from '../errors.js';
import { validatePathWithinRootReal, stripReasoningTokens, compact } from '../utils.js';

/** Symbol kinds worth summarising. Skip parameters/imports/literals. */
export const SUMMARIZABLE_KINDS: ReadonlySet<string> = new Set([
  'class',
  'function',
  'method',
  'interface',
  'struct',
  'trait',
  'protocol',
  'enum',
  'type_alias',
  'component',
  'route',
]);

/** Min body lines to bother summarising. Bodies smaller than this
 *  rarely have non-trivial behaviour beyond what the name + signature
 *  already convey (getters, single-stmt forwarders, type-only
 *  shapes), so we skip them rather than burn a chat call on each.
 *  Bumped from 3 to 4 to filter typical setters and 1-statement
 *  forwarders too. Tradeoff: searches that hit such a symbol have
 *  no semantic context, only the structural one.
 *
 *  Exported so the structural-summariser sibling can use this value
 *  as the upper bound for "short enough to derive structurally" — no
 *  literal-mirroring drift between the two passes. */
export const MIN_BODY_LINES = 4;

/** Per-kind override for {@link MIN_BODY_LINES}. Routes are typically
 *  short (registration plus delegation), but they're high-signal for
 *  intent search ("the endpoint that creates a user") so we let them
 *  through at a floor of 1 line instead of the default. The
 *  structural-summariser pass also synthesises route summaries when
 *  bodies are too thin for the LLM to add anything; this floor catches
 *  genuinely meaty handlers.
 *
 *  Exported so agent-bridge / structural-summariser stay in lock-step
 *  with the LLM pass — drifted thresholds across siblings caused
 *  candidate-set mismatches before. */
export const MIN_BODY_LINES_BY_KIND: ReadonlyMap<string, number> = new Map([['route', 1]]);

/** Default docstring-char threshold below which a node is considered
 *  not-yet-documented and therefore eligible for summarising. Exported
 *  so agent-bridge keeps parity with the local pass. */
export const DEFAULT_DOC_CHAR_THRESHOLD = 20;

/** Truncate symbol bodies to this many chars to control prompt size. */
// MAX_BODY_CHARS + body truncation moved to ../extraction/symbol-body-hash.ts
// so the extractor's createNode (body_hash) and the summarizer
// (content_hash) share the exact same slice. See sliceSymbolBody.

/** Concurrent summarisation requests in flight. Higher concurrency
 * hides per-call latency for cloud backends (Anthropic HTTPS, claude-bridge
 * subprocess). openai-compat backends process requests one at a time per HTTP connection — surplus slots
 * queue harmlessly. */
const DEFAULT_CONCURRENCY = 8;

/** Lever C — default cap on how many summaries one eager pass generates.
 *  The pass walks candidates by importance (priority-queue items first,
 *  then PageRank centrality DESC) and stops after this many cache-MISS
 *  generations; the lower-importance tail is left for the demand-driven
 *  `summary_priority_queue` to drain when intent-search references it.
 *  Cache-hits and explicitly-queued priority items do NOT count toward
 *  the cap. ~600 covers the high-value core of a typical mid-size repo
 *  (~2-3k summarizable symbols) at roughly 1/4 the wall time of a full
 *  pass.
 *
 *  Override via `config.llm.summarizeEagerLimit` or per-call
 *  (`eagerLimit`). Resolution ({@link SummarizerRun}):
 *    - `undefined` → this default (600)
 *    - `0`         → AD-HOC ONLY — zero eager generations; every
 *                    non-priority symbol defers to the priority queue
 *    - `N > 0`     → cap at N
 *    - negative / non-finite → uncapped (full pass; `admin summarize
 *                    --all` passes `Infinity`). */
const DEFAULT_EAGER_SUMMARY_LIMIT = 600;

/** Max chars in the produced summary. Anything longer gets truncated. */
const MAX_SUMMARY_CHARS = 200;

/** Matches useless stub summaries emitted by LLMs when context is too thin
 *  (forward declarations, .h files). e.g. "Abstract function: ggml_foo" or
 *  "Abstract class: Bar" — no real content, pollutes the FTS5 intent corpus. */
const STUB_SUMMARY_PATTERN =
  /^\s*abstract\s+(function|method|class|struct|interface|trait|enum|type|module)\s*:\s*(?!\d)\w+\s*\.?\s*$/i;

/** Default batch size — 1 (no batching). Caller picks 3 for
 *  claude-bridge / anthropic-api where per-call overhead amortises
 *  across batched outputs. Bench (`/tmp/cg-summary-batch-bench.py`)
 *  showed batch=3 preserves quality on Haiku/Qwen3-Coder; batch=5
 *  starts losing specifics; batch=10 is noticeably degraded. */
const DEFAULT_SUMMARY_BATCH_SIZE = 1;

/**
 * Floor on `maxTokens` for the batched summarisation call. Covers a
 * single-item batch plus the JSON wrapper overhead.
 */
const BATCH_SUMMARIZE_MIN_MAX_TOKENS = 160;

/**
 * Token allowance per batched item. Multiplied by batch size to set
 * the chat call's `maxTokens` budget so the model has room for every
 * one-line entry plus JSON envelope.
 */
const BATCH_SUMMARIZE_TOKENS_PER_ENTRY = 120;

interface SummarizerOptions {
  /** Skip symbols whose existing docstring already exceeds this length. */
  existingDocstringCharThreshold?: number;
  /** Concurrency. Default 2. */
  concurrency?: number;
  /** Cache-misses per LLM call. Default 1 (no batching). Set to 3 for
   *  providers with per-call overhead (claude-bridge subprocess,
   *  anthropic-api network roundtrip); leave at 1 for openai-compat where
   *  batching gives zero speedup but still costs quality. Cache hits
   *  are not batched regardless. */
  summaryBatchSize?: number;
  /** Optional progress callback. */
  onProgress?: (done: number, total: number) => void;
  /** AbortSignal — used to cancel in-flight summarisation when the
   * project is closed or a new sync starts. */
  signal?: AbortSignal;
  /** Lever C — cap on cache-MISS generations for this pass. Once this
   *  many summaries have been generated, the importance-ordered tail is
   *  left for the demand-driven priority queue. `undefined` →
   *  {@link DEFAULT_EAGER_SUMMARY_LIMIT}; `<= 0` or `Infinity` →
   *  uncapped (full pass). Priority-queue items and cache-hits never
   *  count toward the cap. */
  eagerLimit?: number;
}

interface SummarizerResult {
  /** Symbols evaluated as candidates. */
  candidates: number;
  /** Summaries generated this run (cache-misses + body changes). */
  generated: number;
  /** Summaries skipped because the cached one is still valid. */
  cacheHits: number;
  /** Failures (timeout, network, server error). */
  errors: number;
  /** Lever C — candidates left un-summarised because the eager-limit
   *  was reached. They drain on demand via the priority queue. 0 when
   *  the pass ran uncapped or finished within budget. */
  deferred: number;
  /** Total wall time in ms. */
  durationMs: number;
}

/**
 * Constant system prompt for single-symbol summarisation. Holds every
 * instruction that does NOT vary per symbol, so the openai-compat backend can
 * reuse its KV-cache prefix across the thousands of summary calls in a
 * pass (lever A): an identical system message means identical prefix
 * tokens, and `LlamaContextSequence` then re-evaluates only the
 * per-symbol user turn instead of re-prefilling the whole preamble.
 *
 * Covers both framings the old per-kind `promptFramingFor` split —
 * verb-first for callables, shape-first for declarations — as two
 * bullet rules; the model picks the matching one from the `kind` named
 * in the user message. Kept short: long multi-sentence framings used to
 * truncate small models mid-line (2026-05-11 Granite-1b eval). The
 * curated stack is Qwen-3B now, but the brevity still helps.
 */
const SUMMARY_SYSTEM_PROMPT = [
  'You are a senior code reviewer documenting an unfamiliar codebase.',
  '',
  `Summarise the code symbol the user gives you in ONE LINE (max ${MAX_SUMMARY_CHARS} characters):`,
  '- function / method / route / component: state what it DOES, starting with a present-tense verb.',
  '- class / interface / type alias / struct / enum / other declaration: state what it REPRESENTS — its shape, role, or contents.',
  '',
  'Never start the line with "This", "The", "Initiates", the symbol\'s kind name, or an -ing word.',
  'Output the summary line only — no markdown, no quotes, no preamble.',
].join('\n');

/**
 * Per-symbol user message — the variable half of the summary prompt.
 * Just the kind tag plus the body; every constant instruction lives in
 * {@link SUMMARY_SYSTEM_PROMPT}. Keeping this minimal maximises the
 * shared KV-cache prefix the openai-compat backend reuses across calls.
 *
 * Used when batchSize=1 and as the per-item fallback when a batched
 * call's JSON parse fails.
 */
export function buildSummaryUserPrompt(sym: Node, body: string): string {
  return [`Summarise this ${sym.kind}:`, '```', body, '```'].join('\n');
}

/**
 * Batched summarisation prompt. Same single-line/action-verb constraint
 * as the single prompt, repeated per item, plus a JSON-array output
 * format the parser can extract. Numbered (zero-indexed) so
 * `parseBatchSummaries` can align outputs to inputs even if the model
 * shuffles or drops entries.
 */
function buildBatchPrompt(items: Array<{ sym: Node; body: string }>): string {
  const blocks = items.map((it, i) => {
    return [`### ${i}. ${it.sym.name} (${it.sym.kind})`, '```', it.body, '```'].join('\n');
  });
  return [
    'You are a senior code reviewer documenting an unfamiliar codebase.',
    '',
    `Write a SINGLE LINE summary (max ${MAX_SUMMARY_CHARS} chars) for EACH symbol below.`,
    'For function/method/route/component: start with a present-tense verb (Returns, Computes, Sends, …).',
    'For class/interface/type_alias/struct/enum: start with "Represents", "Models", "Defines", "Holds", or the noun.',
    'Never start with "Initiates", "The X", "This X", "Interface", "Class", or a gerund.',
    'No markdown, no quotes.',
    '',
    'Reply with a JSON array — one object per symbol, IN THE SAME ORDER:',
    '[{"i":0,"summary":"..."},{"i":1,"summary":"..."},...]',
    'No prose outside the array. No markdown fences.',
    '',
    'Symbols (zero-indexed):',
    ...blocks,
  ].join('\n');
}

/** Zod v4 schema for ONE batched-summary entry. Applied per-entry in
 *  {@link parseBatchSummaries}: a row with an unparseable `i`
 *  (`z.coerce` honours a string index; `.int()` rejects fractionals)
 *  or a non-string `summary` fails `safeParse` and is skipped — same
 *  drop semantics as the prior hand-rolled guards. Text cleaning and
 *  the ≥80% coverage gate stay in the caller, so no transform here. */
const SummaryEntrySchema = z.object({
  i: z.coerce.number().int(),
  summary: z.string(),
});

/** Parse a batched response into a position→summary map. Returns null
 *  on irrecoverable parse failure (caller falls back to per-item). */
export function parseBatchSummaries(text: string, expectedSize: number): Map<number, string> | null {
  const parsed = extractJsonArrayFromText(text);
  if (!parsed) return null;
  const out = new Map<number, string>();
  for (const entry of parsed) {
    const row = SummaryEntrySchema.safeParse(entry);
    if (!row.success) continue;
    const { i: idx, summary } = row.data;
    if (idx < 0 || idx >= expectedSize) continue;
    const cleaned = stripPreamble(stripReasoningTokens(summary).trim().split('\n')[0]?.trim() ?? '');
    if (cleaned.length === 0) continue;
    out.set(idx, cleaned);
  }
  // Require ≥80% coverage — if the model dropped most entries, the
  // caller should fall back to per-item rather than synthesise empties.
  if (out.size < Math.max(1, Math.floor(expectedSize * 0.8))) return null;
  return out;
}

/** Stable content hash so we know when to regenerate. Delegates to the
 *  shared {@link symbolBodyHash} util so the extractor's `createNode`
 *  (writing `nodes.body_hash`) and the summarizer (writing
 *  `symbol_summaries.content_hash`) use the SAME function — the
 *  `getStaleArtifactsCount` join in `queries-metadata.ts` depends on
 *  byte-identical hashes from both sides. */
export function contentHashFor(sym: Node, body: string): string {
  return symbolBodyHash(sym.signature, body);
}

function truncateSummary(s: string): string {
  return s.length > MAX_SUMMARY_CHARS ? s.slice(0, MAX_SUMMARY_CHARS - 1) + '…' : s;
}

/** Recognised preamble patterns. Granite-1b leans hard on "Initiates a X"
 *  and "Summary: …" echoes; Qwen variants leak "This function …";
 *  several models open with the kind word ("Interface defines …",
 *  "Class caches …") as if narrating a textbook. Strip them all to a
 *  bare action-verb opener.
 *
 *  Order matters: longer / more-specific patterns first so we don't
 *  half-strip ("Summary: This function" → strip "Summary:" only would
 *  leave the inner preamble). */
const PREAMBLE_PATTERNS: RegExp[] = [
  // "Summary: " echo of the prompt label (1b prompt-leak).
  /^\s*Summary:\s+/i,
  // "This (function|method|class|interface|module|component|code|snippet) "
  /^\s*This\s+(?:function|method|class|interface|module|component|code|snippet)\s+/i,
  // "The (function|method|class|interface|module|component|code|snippet) "
  /^\s*The\s+(?:function|method|class|interface|module|component|code|snippet)\s+/i,
  // Bare kind word as opener: "Interface X defines …" / "Class caches …" /
  // "Function returns …". Trailing space required so we don't eat
  // legitimate sentence-initial "Class" inside the body.
  /^\s*(?:Interface|Class|Function|Method|Module|Component)\s+/,
  // "Initiates a/an X constructor with …" — granite-1b's favourite
  // constructor cliché. Strip the wrapper, keep what was actually
  // initialised. Captures the verb so we can re-emit with a sane
  // imperative: "Constructs ParseError with …".
  /^\s*Initiates\s+an?\s+(\S+?)\s+constructor\s+(?:with|using|that|for)\s+/i,
  // "Initiates a/an …" — strip JUST the verb-plus-article so the
  // noun phrase that follows becomes the new opener:
  //   "Initiates a Response with optional fields" → "Response with …"
  // (We deliberately don't consume the noun — the older regex did,
  // dropping the actual subject of the sentence.)
  /^\s*Initiates\s+an?\s+/i,
  // (Note: no general gerund-opener strip — destructive across the verb
  // set: "Scanning source code …" → "Source code …" drops the verb
  // entirely. The prompt forbids gerunds and Granite-1b complies on
  // ~95% of rows; the rare leak is preferable to broken transforms.)
  // Sentence-continuation openers — Granite-1b treats the framing
  // instruction as the sentence stem and continues from it:
  //   prompt: "state what this function does"
  //   output: "That handles HTTP requests …"
  // Strip the "That " and recapitalise — leaves a valid imperative
  // sentence ("Handles HTTP requests …").
  /^\s*That\s+/,
  // "To <verb> …" infinitive opener — similar continuation tic.
  // Stripping "To " converts to imperative ("Process candidate batches").
  /^\s*To\s+(?=[a-z])/,
];

/**
 * Strip a leading preamble pattern and re-capitalise the next word so
 * the summary still reads as a single-line action statement. Walks
 * patterns in order; first match wins. No-op when input already
 * complies.
 *
 * Patterns target observed small-model tics (granite-1b, qwen2.5-coder,
 * gemma): preamble like "This function …", "Initiates a X …", echoed
 * prompt labels ("Summary: …"), and gerund openers ("Scanning … input
 * stream"). Body of the summary is preserved verbatim apart from
 * leading-character recapitalisation.
 *
 * Exported for unit testing.
 */
export function stripPreamble(s: string): string {
  for (const re of PREAMBLE_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    // The "Initiates a/an X constructor (with|using|that|for) " pattern
    // captures the constructor's owner so we can rebuild "Constructs X
    // (with|using|that|for) …" — preserves the semantic content the
    // model produced instead of dropping the whole stem.
    if (m[1] && /constructor/i.test(m[0])) {
      const conn = (/(with|using|that|for)\s+$/i.exec(m[0]) ?? [undefined, ''])[1];
      const rest = s.slice(m[0].length);
      return `Constructs ${m[1]} ${conn} ${rest}`.replaceAll(/\s+/g, ' ').trim();
    }
    const rest = s.slice(m[0].length);
    if (!rest) return s;
    return rest[0]!.toUpperCase() + rest.slice(1);
  }
  return s;
}

/** Cap on how many priority-queue entries to honour per pass. Prevents
 *  a runaway queue (or an attacker writing many distinct miss queries)
 *  from monopolising the entire pass — the remainder of the candidate
 *  list still processes in the default updated_at-DESC order. */
const PRIORITY_QUEUE_PULL_LIMIT = 200;

/**
 * Order summarizable candidates for the eager pass and return the
 * priority-id set alongside.
 *
 * Two buckets, front to back:
 *  1. **Priority-queue items** — populated by `_search-intent.ts` when
 *     intent-search returns 0 hits and exact-name matches the query
 *     terms against unsummarised nodes. Front-loaded in queue order so
 *     the next pass summarises exactly what the agent asked about.
 *     Bounded by {@link PRIORITY_QUEUE_PULL_LIMIT}.
 *  2. **Everything else** — by PageRank centrality DESC (null centrality
 *     sorts last). This is what makes the eager-limit (lever C) cut the
 *     LEAST important symbols: the high-centrality core summarises now,
 *     the long tail drains on demand. JS sort is stable, so centrality
 *     ties keep the `getSummarizableNodes` order (updated_at DESC) —
 *     freshly-changed symbols still win their tie band.
 *
 * The returned `prioritySet` lets the run exempt explicitly-requested
 * items from the eager-limit (they were demand-driven; honour them
 * regardless of budget).
 */
function orderCandidatesByImportance(
  qb: QueryBuilder,
  candidates: Node[],
): { ordered: Node[]; prioritySet: Set<string> } {
  const priorityIds = getPriorityNodeIds(qb, PRIORITY_QUEUE_PULL_LIMIT);
  const prioritySet = new Set(priorityIds);
  if (candidates.length === 0) return { ordered: candidates, prioritySet };
  const front: Node[] = [];
  const rest: Node[] = [];
  for (const c of candidates) {
    if (prioritySet.has(c.id)) front.push(c);
    else rest.push(c);
  }
  // FRONT: items the agent asked about most recently come first.
  const idToPos = new Map(priorityIds.map((id, i) => [id, i]));
  front.sort((a, b) => (idToPos.get(a.id) ?? 0) - (idToPos.get(b.id) ?? 0));
  // REST: highest centrality first; null centrality (uncomputed) last.
  rest.sort((a, b) => (b.centrality ?? -1) - (a.centrality ?? -1));
  return { ordered: [...front, ...rest], prioritySet };
}

/**
 * Reorder candidates so call-graph-adjacent symbols are batched in the
 * same LLM round-trip. Quality lift at the same token cost: the model
 * disambiguates `formatDate` / `formatTime` / `formatDuration` better
 * when they're sent together than when batched with three random
 * unrelated symbols.
 *
 * Algorithm: union-find over `calls` edges where BOTH endpoints are in
 * the candidate set. Cluster id = the smallest original position in
 * the cluster (so the most-recent member of each cluster pulls the
 * whole cluster forward, preserving the freshness ordering of the
 * input). Stable sort by (cluster_id, original_position).
 *
 * Cost: one SQL query for the bidirectional edge slice (~O(C+E) where
 * C is the candidate count and E is the matching edge count) plus an
 * O(C·α(C)) union-find pass. For ≤3,000 candidates this is sub-50ms.
 *
 * No-op when batchSize=1: clustering only matters across batched items.
 */
function clusterCandidatesByCalls(qb: QueryBuilder, candidates: Node[]): Node[] {
  if (candidates.length < 2) return candidates;
  const idToPos = new Map<string, number>();
  candidates.forEach((c, i) => {
    idToPos.set(c.id, i);
  });
  const placeholders = candidates.map(() => '?').join(',');
  const edges = qb.db
    .prepare(
      `SELECT source, target FROM edges
        WHERE kind = 'calls'
          AND source IN (${placeholders})
          AND target IN (${placeholders})`,
    )
    .all(...candidates.map((c) => c.id), ...candidates.map((c) => c.id)) as Array<{
    source: string;
    target: string;
  }>;

  const parent = candidates.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Lower position wins so cluster id == smallest member position.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (const e of edges) {
    const a = idToPos.get(e.source);
    const b = idToPos.get(e.target);
    if (a === undefined || b === undefined) continue;
    union(a, b);
  }

  return candidates
    .map((c, i) => ({ c, i, cluster: find(i) }))
    .sort((x, y) => x.cluster - y.cluster || x.i - y.i)
    .map((x) => x.c);
}

/**
 * Read a file's lines safely — validate the path stays inside
 * `projectRoot` (symlink-resistant) and swallow read errors as
 * `null`. Pulled out so {@link SummarizerRun.readBodyLines} doesn't
 * nest a try/catch inside an else inside the cache-miss if (which
 * was the nested_complexity=4 source).
 */
function loadProjectFileLinesSafely(projectRoot: string, filePath: string): string[] | null {
  const safePath = validatePathWithinRootReal(projectRoot, filePath);
  if (!safePath) return null;
  try {
    return fs.readFileSync(safePath, 'utf-8').split('\n');
  } catch {
    return null;
  }
}

/**
 * Run a full summarisation pass over every summarisable symbol that
 * doesn't yet have a fresh cached summary. Safe to call repeatedly:
 * cache hits are O(1) per symbol and require no LLM call.
 */
/** Inputs bundle threaded through both {@link summarizeAll} and the
 *  {@link SummarizerRun} constructor — same shape, different shape of
 *  caller (free function vs class). */
interface SummarizerInputs {
  projectRoot: string;
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  options?: SummarizerOptions;
}

export async function summarizeAll(inputs: SummarizerInputs): Promise<SummarizerResult> {
  return new SummarizerRun(inputs).run();
}

type PendingItem = { sym: Node; body: string; hash: string };

// ---------------------------------------------------------------------------
// Module-scope helpers for SummarizerRun
// ---------------------------------------------------------------------------

/** Mutable progress counters shared by all workers in one run. */
interface SummarizerCounters {
  done: number;
  generated: number;
  cacheHits: number;
  errors: number;
  next: number;
  /** Lever C — non-priority cache-MISS items claimed for generation.
   *  Checked-and-incremented synchronously (no `await` between), so
   *  workers never overshoot the eager-limit. */
  missesClaimed: number;
}

/** Shared context for summarization helper functions. */
interface SummarizerCallContext {
  counters: SummarizerCounters;
  queries: QueryBuilder;
  client: LlmClient;
  /** Chat model id — stamped on all produced rows. */
  modelLabel: string;
  total: number;
  options: SummarizerOptions;
}

/**
 * All mutable and immutable state a worker / batch-flush pass needs.
 * Extracted from `SummarizerRun` so that `summaryRunWorker` and
 * `summaryFlushBatch` can be free functions rather than private methods,
 * keeping the class below the god_class threshold.
 */
interface SummarizerWorkerState {
  counters: SummarizerCounters;
  candidates: Node[];
  options: SummarizerOptions;
  fileContentCache: Map<string, string[] | null>;
  batchSize: number;
  total: number;
  budget: number;
  prioritySet: Set<string>;
  inputs: SummarizerInputs;
}

/**
 * Two-tier cache lookup: by node_id (common — stable symbols) then
 * by content_hash (handles rename/move where node_id changed but
 * the body is identical, copying the cached summary onto the new
 * node_id). Returns true on hit so the caller skips the LLM batch.
 */
function summaryTryServeFromCache(ctx: SummarizerCallContext, sym: Node, hash: string): boolean {
  const { counters, queries, modelLabel, total, options } = ctx;
  const existing = getSymbolSummary(queries, sym.id);
  if (existing?.contentHash === hash && existing?.model === modelLabel) {
    counters.cacheHits++;
    counters.done++;
    options.onProgress?.(counters.done, total);
    return true;
  }
  const byHash = getSummaryByContentHash(queries, hash, modelLabel);
  if (byHash) {
    const wrote = upsertSymbolSummary({
      qb: queries,
      nodeId: sym.id,
      contentHash: hash,
      summary: byHash.summary,
      model: modelLabel,
    });
    if (wrote) {
      counters.cacheHits++;
    } else {
      // Node was deleted between candidate enumeration and write —
      // a stale-handle race. Don't bill the LLM path for it; the
      // result's `skipped` metric (candidates - generated - errors
      // - cacheHits) absorbs the no-op naturally without polluting
      // the `errors` bucket reserved for real LLM/network failures.
      logDebug('Summarizer: cache write skipped (stale node id)', { node: sym.id });
    }
    counters.done++;
    options.onProgress?.(counters.done, total);
    return true;
  }
  return false;
}

/**
 * Read the symbol's body lines from its file (with per-file LRU
 * caching shared across all symbols in the same file). Validates
 * the path symlink-resistant — a between-write-and-read symlink
 * swap could otherwise steer the read off-tree.
 */
function summaryReadBodyLines(fileContentCache: Map<string, string[] | null>, projectRoot: string, sym: Node): string {
  let lines = fileContentCache.get(sym.filePath);
  if (lines === undefined) {
    lines = loadProjectFileLinesSafely(projectRoot, sym.filePath);
    fileContentCache.set(sym.filePath, lines);
  }
  // Shared slice with the extractor's createNode — see
  // src/extraction/symbol-body-hash.ts. Both sides must produce the
  // SAME string for getStaleArtifactsCount's body_hash <> content_hash
  // join to work.
  return sliceSymbolBody(lines, sym.startLine, sym.endLine);
}

/**
 * One LLM call for the whole batch. Returns true when handled (all
 * items processed, counters updated, caller skips the per-item
 * fallback). Returns false on parse failure or LLM error so the
 * caller falls back. "Item passed batch's 80% coverage gate but its
 * own entry was missing/empty" is counted as an error rather than
 * synthesised — the next sync retries.
 */
/**
 * Apply the successfully parsed batch summaries to the DB,
 * updating counters and emitting progress for each item.
 */
function summaryApplyBatchResults(ctx: SummarizerCallContext, batch: PendingItem[], parsed: Map<number, string>): void {
  const { counters, queries, modelLabel, total, options } = ctx;
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]!;
    const summary = parsed.get(i);
    if (summary && summary.length > 0) {
      // Stub-pattern filter: LLMs lacking enough context (forward declarations,
      // .h files) produce "Abstract function: foo" / "Abstract class: Bar"
      // with no real content. Skip the upsert — absorbed by the skipped
      // derivation, same as the stale-handle no-op below.
      if (STUB_SUMMARY_PATTERN.test(summary)) {
        logWarn('Summarizer: stub summary rejected', { node: item.sym.id, kind: 'stub-rejected' });
      } else if (
        // Stale-handle race: the upsert no-ops if the node was deleted
        // mid-flight; don't increment generated OR errors — the
        // skipped derivation in the caller absorbs it.
        upsertSymbolSummary({
          qb: queries,
          nodeId: item.sym.id,
          contentHash: item.hash,
          summary: truncateSummary(summary),
          model: modelLabel,
        })
      ) {
        counters.generated++;
        // Demand-driven priority queue: this node was either explicitly
        // requested by an intent-search miss or just happened to be next
        // anyway. Either way, the "needs summarising" signal is now
        // satisfied — drop the queue entry. No-op when the node wasn't
        // queued.
        clearPriorityQueueForNode(queries, item.sym.id);
      }
    } else {
      // Empty / whitespace-only response from the LLM for this batch
      // entry. Log it so the operator has a per-node breadcrumb when
      // the run-end "Errors: N" counter is non-zero.
      logWarn('Summarizer: empty batch entry', { node: item.sym.id });
      counters.errors++;
      // Track failure for poison-row eviction.
      if (recordPriorityQueueFailure(queries, item.sym.id).evicted) {
        logDebug('Summarizer: priority queue poison-evicted', { node: item.sym.id });
      }
    }
    counters.done++;
    options.onProgress?.(counters.done, total);
  }
}

async function summaryTryBatchSummarize(ctx: SummarizerCallContext, batch: PendingItem[]): Promise<boolean> {
  const { client, options } = ctx;
  const batchMaxTokens = Math.max(BATCH_SUMMARIZE_MIN_MAX_TOKENS, batch.length * BATCH_SUMMARIZE_TOKENS_PER_ENTRY);
  let result: Awaited<ReturnType<typeof client.chat>> | undefined;
  try {
    result = await client.chat(
      [{ role: 'user', content: buildBatchPrompt(batch) }],
      compact({ temperature: 0, maxTokens: batchMaxTokens, signal: options.signal }),
    );
  } catch (err) {
    if (options.signal?.aborted) return false;
    if (err instanceof LlmEndpointError) {
      logDebug('Summarizer: batch endpoint error, falling back', { error: err.message });
    } else {
      logWarn('Summarizer: batch unexpected error, falling back', { error: String(err) });
    }
    return false;
  }
  if (options.signal?.aborted) return true;

  const parsed = parseBatchSummaries(result.text, batch.length);
  if (!parsed) {
    logDebug('Summarizer: batch parse failed, falling back to per-item', {
      batchSize: batch.length,
      sample: result.text.slice(0, BATCH_PARSE_FAILURE_LOG_CHARS),
    });
    return false;
  }

  summaryApplyBatchResults(ctx, batch, parsed);
  return true;
}

/**
 * Per-item summary generation via the chat backend.
 */
async function summaryGenerateSingle(ctx: SummarizerCallContext, item: PendingItem): Promise<void> {
  const { counters, queries, client, modelLabel, total, options } = ctx;
  if (options.signal?.aborted) return;

  let summary: string | null = null;
  try {
    const result = await client.chat(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserPrompt(item.sym, item.body) },
      ],
      compact({ temperature: 0, maxTokens: 80, signal: options.signal }),
    );
    if (options.signal?.aborted) return;
    summary = stripPreamble(stripReasoningTokens(result.text).trim().split('\n')[0]?.trim() ?? '');
  } catch (err) {
    counters.errors++;
    if (err instanceof LlmEndpointError) {
      logDebug('Summarizer: endpoint error', { node: item.sym.id, error: err.message });
    } else {
      logWarn('Summarizer: unexpected error', { node: item.sym.id, error: String(err) });
    }
    // Track failure for poison-row eviction.
    if (recordPriorityQueueFailure(queries, item.sym.id).evicted) {
      logDebug('Summarizer: priority queue poison-evicted', { node: item.sym.id });
    }
    counters.done++;
    options.onProgress?.(counters.done, total);
    return;
  }

  if (!summary || summary.length === 0) {
    // Per-item LLM call returned text that emptied out after stripping
    // <think> tags + preamble. Log so the operator can see which node
    // tripped the empty-response path (vs the catch-block above which
    // already logs endpoint / unexpected errors).
    logWarn('Summarizer: empty single-item response', { node: item.sym.id });
    counters.errors++;
    // Track failure for poison-row eviction.
    if (recordPriorityQueueFailure(queries, item.sym.id).evicted) {
      logDebug('Summarizer: priority queue poison-evicted', { node: item.sym.id });
    }
  } else if (STUB_SUMMARY_PATTERN.test(summary)) {
    // Stub-pattern filter: same skip logic as the batch path.
    logWarn('Summarizer: stub summary rejected', { node: item.sym.id, kind: 'stub-rejected' });
  } else if (
    upsertSymbolSummary({
      qb: queries,
      nodeId: item.sym.id,
      contentHash: item.hash,
      summary: truncateSummary(summary),
      model: modelLabel,
    })
  ) {
    counters.generated++;
    clearPriorityQueueForNode(queries, item.sym.id);
  }
  // else: stale-handle no-op, derived `skipped` accounts for it.

  counters.done++;
  options.onProgress?.(counters.done, total);
}

/**
 * Resolve the eager-generation budget from the caller's `eagerLimit`
 * option:
 *  - `undefined` → {@link DEFAULT_EAGER_SUMMARY_LIMIT}
 *  - `0` → ad-hoc-only mode (budget 0, every non-priority miss defers)
 *  - negative or non-finite → `Infinity` (uncapped full pass)
 *  - positive finite → that exact cap
 *
 * Extracted from `SummarizerRun.constructor` so the constructor's
 * conditional operand count stays below the complex_conditional threshold.
 */
function resolveEagerBudget(rawLimit: number | undefined): number {
  if (rawLimit === undefined) return DEFAULT_EAGER_SUMMARY_LIMIT;
  if (rawLimit < 0 || !Number.isFinite(rawLimit)) return Number.POSITIVE_INFINITY;
  return rawLimit;
}

/**
 * One concurrent worker: dequeue candidates, check the cache, claim a
 * budget slot for cache-misses, accumulate a pending batch, and flush.
 *
 * Extracted from `SummarizerRun` as a free function so the class stays
 * below the god_class threshold while sharing all mutable counters and
 * the file-content cache via the {@link SummarizerWorkerState} bundle.
 */
async function summaryRunWorker(state: SummarizerWorkerState): Promise<void> {
  const { counters, candidates, options, fileContentCache, batchSize, total, budget, prioritySet } = state;
  const { projectRoot, queries, client, modelLabel } = state.inputs;
  const pending: PendingItem[] = [];
  const ctx: SummarizerCallContext = {
    counters,
    queries,
    client,
    modelLabel,
    total,
    options,
  };

  while (counters.next < candidates.length) {
    if (options.signal?.aborted) return;
    const i = counters.next++;
    const sym = candidates[i];
    if (!sym) break;

    const pendingItem = summaryPreparePendingItem(ctx, fileContentCache, projectRoot, sym);
    if (!pendingItem) continue;

    // Lever C — cache MISS: honour the eager-limit. Priority-queue
    // items are demand-driven and exempt; every other miss claims a
    // budget slot. Check-and-increment is synchronous (no `await`
    // between the two statements), so concurrent workers never
    // overshoot — once `budget` slots are claimed the rest of the
    // importance-ordered tail is left for the priority queue.
    //
    // Note: a worker that breaks here has ALREADY done `counters.next++`
    // for `sym`, so up to `concurrency - 1` items past the cutoff are
    // dequeued-and-skipped rather than left un-pulled. They still count
    // as `deferred` (never `done`) and re-appear as candidates on the
    // next pass — but a future "resume exactly where we stopped"
    // feature must account for these skipped-past slots, not assume
    // `counters.next` marks a clean boundary.
    if (!summaryClaimMissBudget(counters, prioritySet, sym.id, budget)) break;

    pending.push(pendingItem);
    if (pending.length >= batchSize) {
      await summaryFlushBatch(state, pending);
      pending.length = 0;
    }
  }

  if (pending.length > 0 && !options.signal?.aborted) {
    await summaryFlushBatch(state, pending);
  }
}

function summaryClaimMissBudget(
  counters: SummarizerCounters,
  prioritySet: Set<string>,
  symbolId: string,
  budget: number,
): boolean {
  if (prioritySet.has(symbolId)) return true;
  if (counters.missesClaimed >= budget) return false;
  counters.missesClaimed++;
  return true;
}

function summaryPreparePendingItem(
  ctx: SummarizerCallContext,
  fileContentCache: Map<string, string[] | null>,
  projectRoot: string,
  sym: Node,
): PendingItem | null {
  const body = summaryReadBodyLines(fileContentCache, projectRoot, sym);
  if (!body) {
    ctx.counters.errors++;
    ctx.counters.done++;
    ctx.options.onProgress?.(ctx.counters.done, ctx.total);
    return null;
  }
  const hash = contentHashFor(sym, body);
  if (summaryTryServeFromCache(ctx, sym, hash)) return null;
  return { sym, body, hash };
}

/**
 * Flush a batch of cache-MISS items via one batched LLM call. Falls
 * back to per-item via `summaryGenerateSingle` on parse failure or
 * LlmEndpointError so a bad batch can't lose every item.
 *
 * Single-item batches short-circuit to `summaryGenerateSingle` so we
 * don't pay the batch-prompt overhead for a degenerate case.
 *
 * Extracted from `SummarizerRun` as a free function; shares state via
 * the {@link SummarizerWorkerState} bundle.
 */
async function summaryFlushBatch(state: SummarizerWorkerState, batch: PendingItem[]): Promise<void> {
  const { counters, options, total } = state;
  const { queries, client, modelLabel } = state.inputs;
  const ctx: SummarizerCallContext = {
    counters,
    queries,
    client,
    modelLabel,
    total,
    options,
  };
  if (batch.length === 0) return;
  if (options.signal?.aborted) return;
  if (batch.length === 1) {
    await summaryGenerateSingle(ctx, batch[0]!);
    return;
  }

  if (await summaryTryBatchSummarize(ctx, batch)) return;

  for (const item of batch) {
    if (options.signal?.aborted) return;
    await summaryGenerateSingle(ctx, item);
  }
}

/**
 * Per-call state for {@link summarizeAll}. Builds the candidate list,
 * resolves concurrency / batch / budget settings, then fans out to
 * `summaryRunWorker` coroutines that share mutable counters and the
 * per-file content cache via a {@link SummarizerWorkerState} bundle.
 *
 * Single-shot — `run()` is intended to be called once per instance.
 */
class SummarizerRun {
  private readonly t0 = Date.now();
  private readonly concurrency: number;
  // Read in `run()` via `const { workerState } = this` destructure; biome's
  // noUnusedPrivateClassMembers analysis doesn't follow that pattern, so suppress.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: see comment above
  private readonly workerState!: SummarizerWorkerState;

  constructor(inputs: SummarizerInputs) {
    const options = inputs.options ?? {};
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const batchSize = Math.max(1, options.summaryBatchSize ?? DEFAULT_SUMMARY_BATCH_SIZE);
    // 20 (was 30): a 17-char docstring "Hashes a password" is more
    // useful than a generated single-line summary would be. The 30
    // cutoff was filtering useful short docstrings on this corpus
    // (2026-05-08 coverage audit).
    const docThreshold = options.existingDocstringCharThreshold ?? DEFAULT_DOC_CHAR_THRESHOLD;
    const rawCandidates = getSummarizableNodes(inputs.queries, SUMMARIZABLE_KINDS, {
      minBodyLinesByKind: MIN_BODY_LINES_BY_KIND,
      defaultMinBodyLines: MIN_BODY_LINES,
      docCharThreshold: docThreshold,
    });
    // Lever C — order by importance: demand-driven priority-queue items
    // first (the intent-search zero-hit hook in `_search-intent.ts`
    // writes them; this closes the loop), then PageRank centrality DESC.
    // `worker()` then stops after `budget` cache-MISS generations, so
    // the cut falls on the lowest-centrality tail.
    const { ordered, prioritySet } = orderCandidatesByImportance(inputs.queries, rawCandidates);
    // Cluster only when batching makes the prompt context useful.
    // batchSize=1 sees one symbol per call so neighbour ordering is free
    // of effect — and the openai-compat path (batchSize=1) is exactly where the
    // budget matters, so its importance order is preserved intact.
    // batchSize>1 re-sorts by call-adjacency, but priority items stay at
    // the FRONT regardless: clusterCandidatesByCalls keys each cluster on
    // its smallest member position, and priority items occupy positions
    // 0..N_priority-1, so no non-priority cluster can sort ahead of them.
    const candidates = batchSize > 1 ? clusterCandidatesByCalls(inputs.queries, ordered) : ordered;
    const budget = resolveEagerBudget(options.eagerLimit);
    this.workerState = {
      counters: { done: 0, generated: 0, cacheHits: 0, errors: 0, next: 0, missesClaimed: 0 },
      candidates,
      options,
      fileContentCache: new Map(),
      batchSize,
      total: candidates.length,
      budget,
      prioritySet,
      inputs,
    };
  }

  async run(): Promise<SummarizerResult> {
    const { workerState, concurrency } = this;
    await Promise.all(Array.from({ length: concurrency }, () => summaryRunWorker(workerState)));
    // Anything not `done` (cache-hit / generated / errored) was left
    // un-summarised by the eager-limit — it drains via the priority
    // queue. `max(0, …)` guards the abort path where counters race.
    const { counters, total } = workerState;
    const deferred = Math.max(0, total - counters.done);
    return {
      candidates: total,
      generated: counters.generated,
      cacheHits: counters.cacheHits,
      errors: counters.errors,
      deferred,
      durationMs: Date.now() - this.t0,
    };
  }
}
