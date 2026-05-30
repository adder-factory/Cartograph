/**
 * Change-intent generator — given a symbol's body before and after a
 * change, produce a one-line description of what the change does
 * (vs. what the diff shows, which is the *how*).
 *
 * Designed to plug into PR-review tooling (`cartograph_review({mode: 'context'})`
 * / ultrareview), but exposed standalone so any caller can use it.
 *
 * Non-cached at the API layer to keep the surface tiny. PR-review
 * callers typically want one-shot summaries against a given commit
 * range and don't benefit from a long-lived cache; if persistent
 * caching is wanted later, add a content-hash-keyed table similar to
 * symbol_summaries.
 */

import { type LlmClient, LlmEndpointError } from './client.js';
import { compact } from '../utils.js';

const MAX_BODY_CHARS = 1500;

/** Default temperature for change-intent prompts — stays close to evidence. */
const DEFAULT_TEMPERATURE = 0.2;

/** `maxTokens` budget for the change-intent chat call. One short line plus slack. */
const MAX_TOKENS = 80;

/**
 * Hard cap on the rendered intent string (chars). Matches the
 * "max 200 chars" instruction in the prompt; anything longer gets
 * truncated with an ellipsis.
 */
const MAX_INTENT_CHARS = 200;

/**
 * Truncate-at length that leaves one char of headroom for the
 * ellipsis appended on overflow.
 */
const INTENT_TRUNCATE_AT = MAX_INTENT_CHARS - 1;

export interface ChangeIntentOptions {
  signal?: AbortSignal;
  /** Override prompt temperature; default 0.2 — stays close to evidence. */
  temperature?: number;
}

export interface ChangeIntentResult {
  intent: string;
  durationMs: number;
}

function trim(body: string): string {
  if (body.length > MAX_BODY_CHARS) {
    return body.slice(0, MAX_BODY_CHARS) + '\n// ... (truncated)';
  }
  return body;
}

interface BuildPromptArgs {
  name: string;
  kind: string;
  beforeBody: string;
  afterBody: string;
}

function buildAddedPrompt(name: string, kind: string, afterBody: string): string {
  return [
    'You are reviewing a code change. The following symbol was ADDED.',
    `Symbol: ${name} (${kind})`,
    '',
    '## After',
    '```',
    trim(afterBody),
    '```',
    '',
    'Write ONE LINE (max 200 chars) describing what this newly added',
    'symbol does and why it likely matters in this PR. Start with a',
    'verb. No fluff. Just the line.',
  ].join('\n');
}

function buildRemovedPrompt(name: string, kind: string, beforeBody: string): string {
  return [
    'You are reviewing a code change. The following symbol was REMOVED.',
    `Symbol: ${name} (${kind})`,
    '',
    '## Before',
    '```',
    trim(beforeBody),
    '```',
    '',
    'Write ONE LINE (max 200 chars) describing what was removed and the',
    'likely impact. Start with a verb (e.g. "Removes ..."). No fluff.',
  ].join('\n');
}

function buildModifiedPrompt({ name, kind, beforeBody, afterBody }: BuildPromptArgs): string {
  return [
    'You are reviewing a code change. Compare the BEFORE and AFTER versions',
    `of ${name} (${kind}) and describe what changed at the *intent* level.`,
    '',
    '## Before',
    '```',
    trim(beforeBody),
    '```',
    '',
    '## After',
    '```',
    trim(afterBody),
    '```',
    '',
    'Write ONE LINE (max 200 chars) describing the behavioural change.',
    'Focus on intent, not mechanics — what does the code now do that it',
    'did not, or vice versa? Start with a verb. No "This change..." or',
    'markdown. Just the line.',
  ].join('\n');
}

function buildPrompt({ name, kind, beforeBody, afterBody }: BuildPromptArgs): string {
  if (!beforeBody) return buildAddedPrompt(name, kind, afterBody);
  if (!afterBody) return buildRemovedPrompt(name, kind, beforeBody);
  return buildModifiedPrompt({ name, kind, beforeBody, afterBody });
}

/**
 * One-shot change-intent generation. Throws on endpoint failure
 * because callers (review tooling) want to surface the error rather
 * than silently produce no intent.
 */
interface SummarizeChangeArgs {
  client: LlmClient;
  name: string;
  kind: string;
  beforeBody: string;
  afterBody: string;
  options?: ChangeIntentOptions;
}

export async function summarizeChange(args: SummarizeChangeArgs): Promise<ChangeIntentResult> {
  const { client, name, kind, beforeBody, afterBody, options = {} } = args;
  if (!beforeBody && !afterBody) {
    throw new LlmEndpointError('summarizeChange requires either beforeBody or afterBody');
  }
  const t0 = Date.now();
  const result = await client.chat(
    [{ role: 'user', content: buildPrompt({ name, kind, beforeBody, afterBody }) }],
    compact({
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: MAX_TOKENS,
      signal: options.signal,
    }),
  );
  let intent = (result.text.split('\n')[0] || '').trim();
  if (intent.length > MAX_INTENT_CHARS) intent = intent.slice(0, INTENT_TRUNCATE_AT) + '…';
  return { intent, durationMs: Date.now() - t0 };
}
