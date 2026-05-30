/**
 * Natural-language Q&A over the indexed codebase (RAG).
 *
 * Tier-1 enrichment: hybrid-retrieve top-K relevant symbols, hand
 * the LLM a curated context (summaries + bodies for the most
 * promising ones), let it synthesise an answer that cites symbol
 * names and file paths.
 *
 * The retrieval already weights by lexical AND semantic match (PR
 * #112), so the model doesn't have to do its own retrieval — we just
 * hand it a tight, well-formed prompt.
 */

import type { LlmClient } from './client.js';
import type { Node, SearchResult } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getSymbolDescriptions } from '../db/queries-summaries.js';
import { stripReasoningTokens, compact } from '../utils.js';
import { readBodySafe } from './read-body-safe.js';
import { logDebug } from '../errors.js';

/** Max bodies we include verbatim. Beyond this, we just list names + summaries. */
const MAX_FULL_BODIES = 4;
/** Per-body char cap. Long bodies blow the prompt budget for nothing. */
const MAX_BODY_CHARS = 1800;

/** Multiplicative boost applied to a candidate whose `name` is literally
 *  mentioned in the question. Tuned to 1.5× so a strong semantic hit at
 *  ~0.6 (boosted to 0.9) ties or beats an unrelated verbose-docstring
 *  competitor at ~0.9 — pulls the exact-name match toward retrieval[0]
 *  without overriding ordering among non-matching peers.
 *
 *  See F-K (2026-05-11): asked "what triggers an EXTRACTION_LOGIC_VERSION
 *  bump?" — model answered entirely about PAYLOAD_VERSION because the
 *  more-specific entity was buried at retrieval[6]. Round-2 used a 1.5×
 *  soft boost which didn't always win against a verbose-docstring rival;
 *  round-3 (2026-05-11) switched to hard pinning + a system-prompt anchor
 *  after a smoke test showed granite-1b still drifts under the soft boost.
 *  Kept exported for the back-compat helper {@link applyEntityBoost} that
 *  one test still consumes. */
const ENTITY_MATCH_BOOST = 1.5;

/**
 * System-prompt addendum injected when the question names identifier-
 * shaped entities. Anchors the model on the SPECIFIC symbol the user
 * asked about, so similarly-named constants (e.g. PAYLOAD_VERSION vs
 * EXTRACTION_LOGIC_VERSION) don't get conflated during synthesis.
 * Templated via {@link buildEntityAnchorSystemPrompt}.
 */
const ENTITY_ANCHOR_SYSTEM_PROMPT_TEMPLATE =
  "The user's question names the following symbol(s): {ENTITIES}. " +
  'Anchor your answer on those specific symbols — do not substitute ' +
  'similarly-named but distinct symbols (e.g. PAYLOAD_VERSION vs ' +
  'EXTRACTION_LOGIC_VERSION are different constants with different ' +
  'bump rules). If the retrieved context covers a different symbol, ' +
  'say so explicitly rather than answering about the wrong one.';

/** @internal — exported for tests. */
export function buildEntityAnchorSystemPrompt(entities: readonly string[]): string {
  return ENTITY_ANCHOR_SYSTEM_PROMPT_TEMPLATE.replace('{ENTITIES}', entities.join(', '));
}

/**
 * Pull identifier-shaped tokens out of a natural-language question.
 * Used to boost retrieval candidates whose `name` matches one of these
 * literals (see {@link ENTITY_MATCH_BOOST}).
 *
 * Three identifier shapes:
 *  - SCREAMING_SNAKE_CASE constants (e.g. `EXTRACTION_LOGIC_VERSION`).
 *    Minimum length 4 to avoid English-word collisions like `THE`, `AN`.
 *  - camelCase functions / methods with an interior capital
 *    (e.g. `applyExtractionLogicVersionHeal`). The interior-capital
 *    requirement excludes plain English words.
 *  - PascalCase compound types (e.g. `QueryBuilder`, `ToolModule`).
 *    Requires at least one secondary capital to exclude single-word
 *    PascalCase tokens like `Hello` that are common in prose.
 *
 * De-duplicated; case preserved in output (the boost itself lowercases
 * both sides before comparing).
 */
export function extractQuestionEntities(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns: RegExp[] = [
    // SCREAMING_SNAKE: ALL_CAPS_WITH_UNDERSCORES, at least 4 chars total.
    /\b[A-Z][A-Z0-9_]{3,}\b/g,
    // camelCase: starts lowercase, has at least one interior capital
    // followed by more letters/digits. Excludes plain English words.
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/g,
    // PascalCase compound: starts capital + lowercase, requires another
    // capital later (Q+ueryBuilder, T+oolModule). Excludes single-word
    // PascalCase like `Hello` or `Question`.
    /\b[A-Z][a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(question)) !== null) {
      const tok = m[0];
      if (!seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

/**
 * Re-rank the retrieval pool so candidates whose `name` literally
 * appears in the question hard-pin to the top, preserving their
 * relative order. Non-matching peers keep their existing relative
 * order behind the pinned set.
 *
 * Round-2 used a 1.5× multiplicative boost + global sort. F-K smoke
 * test (2026-05-11) showed that with a verbose-docstring rival at a
 * slightly higher base score, the boosted entity could still lose
 * the tie-break — so the bug recurred. Hard pinning closes the
 * window: if you named EXTRACTION_LOGIC_VERSION in your question
 * and it's in the retrieval pool, it lands at position 0.
 *
 * Only re-orders the existing pool — never promotes a candidate
 * that didn't already pass the retrieval threshold. Returns a NEW
 * array (the round-2 in-place sort variant became too easy to
 * misuse when chained); callers should consume the `reranked`
 * field rather than re-using their original reference.
 *
 * Returns the entities that were extracted so the caller can log
 * them and emit citation-mismatch warnings.
 */
export function rerankByQuestionEntities(
  candidates: SearchResult[],
  question: string,
): { reranked: SearchResult[]; entities: string[] } {
  const entities = extractQuestionEntities(question);
  if (entities.length === 0) return { reranked: candidates, entities };

  const entitySet = new Set(entities.map((e) => e.toLowerCase()));
  const pinned: SearchResult[] = [];
  const rest: SearchResult[] = [];
  for (const row of candidates) {
    if (entitySet.has(row.node.name.toLowerCase())) {
      pinned.push(row);
    } else {
      rest.push(row);
    }
  }
  // No matches → preserve the original order verbatim.
  if (pinned.length === 0) return { reranked: candidates, entities };
  return { reranked: [...pinned, ...rest], entities };
}

/**
 * Back-compat soft-boost helper retained for the one test that
 * asserted the round-2 1.5× multiplicative behaviour. Production
 * callers should use {@link rerankByQuestionEntities} instead —
 * hard pinning has strictly better behaviour on the F-K case and
 * doesn't risk losing tie-breaks against verbose-docstring rivals.
 *
 * @internal
 */
export function applyEntityBoost(candidates: SearchResult[], entities: readonly string[]): void {
  if (entities.length === 0) return;
  const entitySet = new Set(entities.map((e) => e.toLowerCase()));
  for (const row of candidates) {
    if (entitySet.has(row.node.name.toLowerCase())) {
      row.score *= ENTITY_MATCH_BOOST;
    }
  }
  candidates.sort((a, b) => b.score - a.score);
}

/**
 * Build the citation-mismatch warning footer fired by F-K. Returns
 * non-empty string only when entities were extracted from the question
 * AND none of them appear anywhere in the answer text. Substring match
 * is the right granularity here — if the model named the entity once,
 * even outside a backtick, that's enough to claim it anchored on the
 * right symbol.
 *
 * Case-insensitive containment because models sometimes lowercase
 * SCREAMING_SNAKE constants in prose.
 */
export function buildEntityMismatchWarning(entities: string[], answer: string): string {
  if (entities.length === 0) return '';
  const lower = answer.toLowerCase();
  const missed = entities.filter((e) => !lower.includes(e.toLowerCase()));
  if (missed.length === 0) return '';
  // Only warn when EVERY mentioned entity was missed — otherwise the
  // model may still have grounded on a partial set, and a warning is
  // noisier than informative.
  if (missed.length !== entities.length) return '';
  return (
    `\n\n> ⚠ The question mentioned [${missed.join(', ')}], ` +
    `but no answer citation matched that entity. The model may have ` +
    `anchored on a related-but-different symbol.`
  );
}

export interface AskOptions {
  /** Max retrieved candidates to consider (deeper = better recall, slower prompt). */
  retrieveK?: number;
  /** Override the default ask model temperature (default 0.2 — stays grounded). */
  temperature?: number;
  /** Cap on response tokens. */
  maxTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Route to the higher-stakes `askModel` (Sonnet by default for
   *  claude-bridge). Set by `Cartograph.ask()`; callers of
   *  `askWithCandidates` directly typically want this true as well. */
  useAskModel?: boolean;
}

export interface AskResult {
  answer: string;
  /** Symbols the LLM was given as context — useful for citing/UI. */
  citations: Array<{ node: Node; summary?: string }>;
  /** Wall time of the chat call only. */
  chatMs: number;
  /** Wall time of retrieval only. */
  retrieveMs: number;
  /**
   * Cross-encoder reranker outcome for the retrieval pass. Set by
   * {@link CartographLlmService.ask} after calling
   * `searchHybridWithOutcome`; absent when `askWithCandidates` is
   * called directly without a reranker-aware search path.
   */
  rerankOutcome?: import('../cartograph-llm-service.js').RerankOutcome;
}

/**
 * Enrich retrieved candidates with descriptions (cascade: summary >
 * docstring), strip reasoning tokens, and compact the result.
 */
function enrichCandidates(candidates: SearchResult[], queries: QueryBuilder): Array<{ node: Node; summary?: string }> {
  const ids = candidates.map((c) => c.node.id);
  const descMap = getSymbolDescriptions(queries, ids);

  return candidates.map((c) => {
    const raw = descMap.get(c.node.id)?.text;
    return compact({
      node: c.node,
      summary: raw ? stripReasoningTokens(raw).trim() || undefined : raw,
    });
  });
}

/**
 * Build full bodies for the top K candidates, ready for inclusion
 * in the prompt verbatim.
 */
function buildFullSliceWithBodies(
  enriched: Array<{ node: Node; summary?: string }>,
  projectRoot: string,
): Array<{ node: Node; summary?: string; body: string }> {
  return enriched.slice(0, MAX_FULL_BODIES).map((e) =>
    compact({
      node: e.node,
      summary: e.summary,
      body: readBodySafe(projectRoot, e.node, MAX_BODY_CHARS),
    }),
  );
}

function buildPrompt(
  question: string,
  full: Array<{ node: Node; summary?: string; body: string }>,
  list: Array<{ node: Node; summary?: string }>,
): string {
  const parts: string[] = [
    'You are a senior engineer helping a teammate understand an unfamiliar codebase.',
    'Answer the question below using only the symbols provided. Cite specific symbol',
    'names and file paths in your answer (e.g. "see `FileWatcher.start` in src/sync/watcher.ts").',
    'If the provided context is insufficient, say so plainly — do not invent details.',
    '',
    `Question: ${question}`,
    '',
    '## Most relevant symbols (full bodies)',
    '',
  ];
  for (const { node, summary, body } of full) {
    parts.push(`### ${node.name} (${node.kind}) — ${node.filePath}:${node.startLine}`);
    if (summary) parts.push(`*Summary*: ${summary}`);
    if (node.signature) parts.push(`*Signature*: \`${node.signature}\``);
    parts.push('```' + (node.language || ''), body, '```', '');
  }
  if (list.length > 0) {
    parts.push('## Other relevant symbols (names + summaries only)', '');
    for (const { node, summary } of list) {
      parts.push(
        `- **${node.name}** (${node.kind}) — ${node.filePath}:${node.startLine}` + (summary ? ` — ${summary}` : ''),
      );
    }
    parts.push('');
  }
  parts.push('## Answer');
  return parts.join('\n');
}

/**
 * Run a one-shot Q&A pass. Caller is responsible for supplying the
 * pre-retrieved candidates (so the same code path serves the MCP tool,
 * the CLI, and any direct-API caller without each having to know about
 * the embedding model).
 *
 * The chat model is whatever the supplied `LlmClient` was constructed
 * with (and the `useAskModel` flag in options routes to the
 * higher-stakes model when the client has one configured).
 */
interface AskWithCandidatesArgs {
  projectRoot: string;
  question: string;
  candidates: SearchResult[];
  queries: QueryBuilder;
  client: LlmClient;
  options?: AskOptions;
}

export async function askWithCandidates(args: AskWithCandidatesArgs): Promise<AskResult> {
  const { projectRoot, question, candidates, queries, client, options = {} } = args;
  const tRetrieve = Date.now();

  // F-K (2026-05-11): hard-pin candidates whose `name` is an entity
  // literally mentioned in the question. Drives the most-specific
  // symbol to retrieval[0] so the model anchors on it rather than a
  // verbose-docstring competitor. Operates on the existing pool only —
  // never promotes a row that didn't already pass the threshold.
  // Round-3 (same date) replaced the soft 1.5× boost with hard pinning
  // after a smoke test showed granite-1b drifting under the boost when
  // a verbose-docstring rival held a higher base score.
  const { reranked, entities } = rerankByQuestionEntities(candidates, question);
  if (entities.length > 0) {
    logDebug('ask: extracted entities', { entities });
  }

  // Enrich candidates with descriptions (cascade: summary > docstring),
  // stripping any leaked reasoning tokens from extended-thinking models.
  const enriched = enrichCandidates(reranked, queries);
  const full = buildFullSliceWithBodies(enriched, projectRoot);
  const listSlice = enriched.slice(MAX_FULL_BODIES);
  const retrieveMs = Date.now() - tRetrieve;

  const prompt = buildPrompt(question, full, listSlice);
  logDebug('ask: prompt size', { chars: prompt.length });

  // F-K (2026-05-11, round-3): when the question names identifier-shaped
  // entities, prepend a system-message anchor so the model knows which
  // specific symbol to ground its answer on. Belt-and-braces alongside
  // the hard-pin re-rank — together they fixed the EXTRACTION_LOGIC_VERSION
  // vs PAYLOAD_VERSION conflation in the smoke test.
  const messages: Array<{ role: 'system' | 'user'; content: string }> =
    entities.length > 0
      ? [
          { role: 'system', content: buildEntityAnchorSystemPrompt(entities) },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];

  const tChat = Date.now();
  const result = await client.chat(
    messages,
    compact({
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 800,
      useAskModel: options.useAskModel,
      signal: options.signal,
    }),
  );
  const chatMs = Date.now() - tChat;

  const cleanedAnswer = stripReasoningTokens(result.text).trim();
  // F-K safety net: if the question named identifiable entities and the
  // synthesized answer mentioned none of them, append a visible flag so
  // the operator knows the model may have drifted to a related-but-
  // different symbol. Cheap belt-and-braces alongside the re-rank.
  const warning = buildEntityMismatchWarning(entities, cleanedAnswer);

  return {
    answer: warning ? cleanedAnswer + warning : cleanedAnswer,
    citations: enriched,
    chatMs,
    retrieveMs,
  };
}
