/**
 * Change-kind classifier — given a symbol's before/after bodies,
 * categorise the change into one of a closed label set using a chat
 * call.
 *
 * Distinct from {@link summarizeChange} (which produces prose): this
 * module returns a STRUCTURED label suitable for grouping / filtering
 * / metrics (e.g. "show me all behavioral changes in this PR" or
 * "this file gets lots of refactor commits").
 *
 * Migrated 2026-05-14 from `LocalRoleClassifier` (transformers.js NLI)
 * to the configured chat backend (an openai-compat HTTP backend
 * post-2026-05-24c). The before/after snippets are trimmed before
 * being fed to the model so the prompt stays under a few hundred
 * tokens.
 */

import type { LlmClient, ResponseJsonSchema } from './client.js';
import { LlmEndpointError } from './client.js';

export type ChangeKind =
  | 'addition'
  | 'removal'
  | 'modification'
  | 'refactor'
  | 'signature_change'
  | 'behavioral_change'
  | 'doc_only'
  | 'unknown';

export interface ChangeKindResult {
  kind: ChangeKind;
  /** Confidence 0–1. Heuristic dispatches set this near 1; the chat
   *  path returns 1.0 on a known label and 0 otherwise. */
  score: number;
  /** Diagnostics — populated even when no model runs. */
  reason: string;
}

interface ClassifyChangeKindArgs {
  client: LlmClient;
  name: string;
  kind: string;
  beforeBody: string;
  afterBody: string;
  signal?: AbortSignal;
}

/** Labels exposed to the chat model. The chat is asked to reply with
 *  a JSON object carrying exactly one of these tokens. */
const CHAT_LABELS: readonly ChangeKind[] = ['refactor', 'signature_change', 'behavioral_change', 'doc_only'];

/**
 * JSON-schema for the chat reply — a single `{kind: <label>}` object.
 * `kind` is an `enum` over {@link CHAT_LABELS}, so on the
 * grammar-constrained backends (openai-compat / anthropic-api) the
 * model CANNOT emit a non-label and the reply is a valid label by
 * construction. Passed as `ChatOptions.responseSchema`.
 */
const CHANGE_KIND_SCHEMA: ResponseJsonSchema = {
  type: 'object',
  properties: { kind: { enum: [...CHAT_LABELS] } },
  required: ['kind'],
};

const CHAT_SYSTEM_PROMPT =
  'Classify a code change into ONE of these labels: ' +
  CHAT_LABELS.join(', ') +
  '. Reply with a JSON object: {"kind":"<label>"}. No prose, no markdown.';

/** Body chars to feed to the chat prompt — keeps prompt construction
 *  cheap and keeps us well under the model's context ceiling. */
const MAX_BODY_CHARS_PER_SIDE = 600;

function trim(s: string): string {
  return s.length > MAX_BODY_CHARS_PER_SIDE ? s.slice(0, MAX_BODY_CHARS_PER_SIDE) : s;
}

/**
 * Quick rule-based dispatch for the cases the model doesn't need to
 * see:
 *   - both bodies empty → `unknown`
 *   - empty before → `addition`
 *   - empty after  → `removal`
 *   - before === after → `unknown` (no diff)
 *
 * Returns null when the rules don't trigger and a chat pass is
 * required.
 */
function ruleBasedDispatch(beforeBody: string, afterBody: string): ChangeKindResult | null {
  const before = beforeBody.trim();
  const after = afterBody.trim();
  if (!before && !after) return { kind: 'unknown', score: 0, reason: 'both bodies empty' };
  if (!before) return { kind: 'addition', score: 0.95, reason: 'symbol added (no before-body)' };
  if (!after) return { kind: 'removal', score: 0.95, reason: 'symbol removed (no after-body)' };
  if (before === after) return { kind: 'unknown', score: 0, reason: 'before equals after — no diff' };
  return null;
}

interface BuildPromptArgs {
  name: string;
  kind: string;
  beforeBody: string;
  afterBody: string;
}

function buildPrompt(args: BuildPromptArgs): string {
  const { name, kind, beforeBody, afterBody } = args;
  return [`${kind} ${name} was changed.`, 'Before:', trim(beforeBody), 'After:', trim(afterBody)].join('\n');
}

/**
 * Classify a code change into a structured `ChangeKind` label.
 *
 * Throws {@link LlmEndpointError} when the provided chat client is
 * not reachable. On chat failure (transient model error) returns
 * `{kind: 'modification', score: 0.0, reason: 'chat failed: <msg>'}`
 * so callers always get a typed value back without paying the abort
 * propagation cost.
 */
export async function classifyChangeKind(args: ClassifyChangeKindArgs): Promise<ChangeKindResult> {
  const { client, name, kind, beforeBody, afterBody, signal } = args;

  const ruleResult = ruleBasedDispatch(beforeBody, afterBody);
  if (ruleResult) return ruleResult;

  if (!(await client.isReachable())) {
    throw new LlmEndpointError(
      'classifyChangeKind requires a reachable chat backend (configure llm.summarizeLlm / askLlm / localLlm)',
    );
  }

  const prompt = buildPrompt({ name, kind, beforeBody, afterBody });

  try {
    const result = await client.chat(
      [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, maxTokens: 24, responseSchema: CHANGE_KIND_SCHEMA, ...(signal ? { signal } : {}) },
    );
    let rawKind: unknown;
    try {
      rawKind = (JSON.parse(result.text) as { kind?: unknown }).kind;
    } catch {
      rawKind = undefined;
    }
    const label = CHAT_LABELS.find((l) => l === rawKind);
    if (!label) {
      return {
        kind: 'modification',
        score: 0,
        reason: `chat label not in taxonomy ("${result.text.trim().slice(0, 60)}")`,
      };
    }
    return {
      kind: label,
      score: 1.0,
      reason: `chat ("${label}")`,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'classify aborted') throw err;
    return {
      kind: 'modification',
      score: 0,
      reason: `chat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
