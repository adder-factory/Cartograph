/**
 * Commit-intent classifier — maps a git commit message to one of a
 * closed label set.
 *
 * Two surfaces:
 *   - {@link classifyCommitMessage} — sync, heuristic-only. Default
 *     for callers that want a model-free path (the existing cochange
 *     hook, tests).
 *   - {@link classifyCommitMessageWithFallback} — async. Runs the
 *     heuristic first; when it returns `'unknown'` (~30% of commits
 *     in messy histories: "wip", "stuff", "more"), falls back to the
 *     supplied chat client (openai-compat) with a single-token classification
 *     prompt. Restores signal on commits the rules can't reach, at
 *     the cost of one chat round-trip per ambiguous commit.
 *
 * Heuristic priority order (both surfaces):
 *   1. Conventional Commits prefix (feat:, fix:, refactor:, …) — score 0.95
 *   2. Keyword cues in the subject line — score 0.5–0.6
 *   3. Body / footer cues (Closes #N, BREAKING CHANGE:) — score 0.5–0.6
 *   4. Fallback — 'unknown', score 0.0 (or the chat-returned label when
 *      the async surface is used with a configured client)
 *
 * Designed to feed `cartograph_history` and `cartograph_hotspots` with
 * intent breakdowns so callers can distinguish "this file gets lots of
 * bug-fixes" from "this file gets lots of features".
 */

import type { LlmClient, ResponseJsonSchema } from './client.js';

export type CommitIntent = 'feat' | 'fix' | 'refactor' | 'perf' | 'test' | 'docs' | 'chore' | 'unknown';

export interface CommitClassification {
  intent: CommitIntent;
  /** Confidence 0–1. */
  score: number;
  /** Human-readable explanation of which rule fired. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Rule 1 — Conventional Commits prefix patterns
// Matches: "feat: …", "feat(scope): …", "feat!: …" etc.
// The character class [\(:\s!] catches the four common separators.
// ---------------------------------------------------------------------------

interface PrefixRule {
  pattern: RegExp;
  intent: CommitIntent;
}

const PREFIX_RULES: PrefixRule[] = [
  { pattern: /^(feat|feature)[\(:]/i, intent: 'feat' },
  { pattern: /^(fix|bugfix|hotfix)[\(:]/i, intent: 'fix' },
  { pattern: /^refactor[\(:]/i, intent: 'refactor' },
  { pattern: /^perf[\(:]/i, intent: 'perf' },
  { pattern: /^test[\(:]/i, intent: 'test' },
  { pattern: /^docs?[\(:]/i, intent: 'docs' },
  { pattern: /^(chore|build|ci)[\(:]/i, intent: 'chore' },
];

const PREFIX_SCORE = 0.95;

// ---------------------------------------------------------------------------
// Rule 2 — Keyword cues in the subject line (medium confidence)
// Each entry is [pattern, intent, score]. Evaluated in order; first
// match wins, so ordering encodes priority within this tier.
// ---------------------------------------------------------------------------

interface KeywordRule {
  pattern: RegExp;
  intent: CommitIntent;
  score: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  // docs — must come before fix so "fix typo" routes to docs
  { pattern: /\btypo\b/i, intent: 'docs', score: 0.6 },
  { pattern: /\b(update docs?|fix(ed)? docs?|add(ed)? docs?|readme|comment(s)?)\b/i, intent: 'docs', score: 0.6 },
  // fix — keyword + signal word pairing
  {
    pattern:
      /\b(fix(ed|es)?|resolve[ds]?|correct(ed|s)?|handle[ds]?)\b.*\b(bug|issue|error|crash|exception|fail|broken|regression)\b/i,
    intent: 'fix',
    score: 0.6,
  },
  // test — add/spec before generic add
  { pattern: /\b(add(ed)? tests?|test(s)? for|spec(s)? for|test coverage)\b/i, intent: 'test', score: 0.6 },
  // feat — broad add/implement/introduce/support
  { pattern: /\b(add(ed|s)?|implement(ed|s)?|introduce[ds]?|support(ed|s)?)\b/i, intent: 'feat', score: 0.6 },
  // refactor
  {
    pattern: /\b(refactor(ed|s)?|rename[ds]?|extract(ed|s)?|simplif(y|ied|ies)|clean(ed)? ?up)\b/i,
    intent: 'refactor',
    score: 0.6,
  },
  // perf
  {
    pattern: /\b(improve performance|speed up|optimiz(e[ds]?|ation)|faster|cach(e[ds]?|ing))\b/i,
    intent: 'perf',
    score: 0.6,
  },
  // chore — bump/upgrade/deps
  { pattern: /\b(bump|upgrade[ds]?|deps?|dependencies|dependency)\b/i, intent: 'chore', score: 0.55 },
  // chore — merge commits
  { pattern: /^merge\b/i, intent: 'chore', score: 0.5 },
];

// ---------------------------------------------------------------------------
// Rule 3 — Body / footer cues (low confidence, subject ambiguous only)
// ---------------------------------------------------------------------------

interface FooterRule {
  pattern: RegExp;
  intent: CommitIntent;
  score: number;
}

const FOOTER_RULES: FooterRule[] = [
  { pattern: /^(closes|fixes|resolves)\s+#\d+/im, intent: 'fix', score: 0.5 },
  { pattern: /^BREAKING CHANGE:/m, intent: 'feat', score: 0.6 },
];

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Classify a git commit message into one of the {@link CommitIntent}
 * labels using heuristic rules only — no model call required.
 *
 * Only the subject line (first line) is used for rule 1 and 2. The
 * full message body is checked for rule 3 when the subject yields
 * no clear signal.
 */
export function classifyCommitMessage(message: string): CommitClassification {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: 'unknown', score: 0.0, reason: 'no rule matched' };
  }

  const subject = trimmed.split('\n')[0]?.trim() ?? '';

  // Rule 1 — Conventional Commits prefix
  for (const rule of PREFIX_RULES) {
    if (rule.pattern.test(subject)) {
      const prefixMatch = /^[a-z]+/i.exec(subject)?.[0] ?? subject;
      return {
        intent: rule.intent,
        score: PREFIX_SCORE,
        reason: `conventional-commits prefix "${prefixMatch}"`,
      };
    }
  }

  // Rule 2 — Keyword cues in subject
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(subject)) {
      const keyword = rule.pattern.exec(subject)?.[0] ?? subject.slice(0, 30);
      return {
        intent: rule.intent,
        score: rule.score,
        reason: `keyword cue "${keyword.trim()}" in subject`,
      };
    }
  }

  // Rule 3 — Body / footer cues (only when subject is ambiguous)
  for (const rule of FOOTER_RULES) {
    const footerMatch = rule.pattern.exec(trimmed);
    if (footerMatch) {
      return {
        intent: rule.intent,
        score: rule.score,
        reason: `footer cue "${footerMatch[0].trim()}"`,
      };
    }
  }

  // Fallback
  return { intent: 'unknown', score: 0.0, reason: 'no rule matched' };
}

// ---------------------------------------------------------------------------
// NLI fallback — picks up commits the heuristic can't reach
// ---------------------------------------------------------------------------

/** Chat-fallback label set — the model picks one of these exact tokens. */
const CHAT_INTENT_LABELS: readonly CommitIntent[] = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore'];

/**
 * JSON-schema for the chat reply — a single `{intent: <label>}` object.
 * The enum includes `'unknown'` so the grammar-constrained backends
 * (openai-compat / anthropic-api) still let the model decline when unsure; an
 * `'unknown'` reply (like any non-real-label) falls through to the
 * heuristic result. Passed as `ChatOptions.responseSchema`.
 */
const COMMIT_INTENT_SCHEMA: ResponseJsonSchema = {
  type: 'object',
  properties: { intent: { enum: [...CHAT_INTENT_LABELS, 'unknown'] } },
  required: ['intent'],
};

const CHAT_FALLBACK_SYSTEM_PROMPT =
  'You classify a single git commit message into ONE of these labels: ' +
  CHAT_INTENT_LABELS.join(', ') +
  '. Reply with a JSON object: {"intent":"<label>"}. Use "unknown" if you cannot tell.';

/**
 * Async classifier that runs heuristics first and falls back to the
 * supplied chat client (openai-compat) only when the heuristic returns
 * `'unknown'`. Most commits resolve via the prefix or keyword rules
 * and never touch the model.
 *
 * Pass a configured `LlmClient` to enable the fallback. When omitted,
 * behaves identically to {@link classifyCommitMessage}.
 *
 * Failures in the chat path (model not reachable, abort, timeout)
 * silently degrade to the heuristic result — better to keep mining
 * than block a sync on a transient model failure.
 */
export async function classifyCommitMessageWithFallback(
  message: string,
  client?: LlmClient | null,
): Promise<CommitClassification> {
  const heuristic = classifyCommitMessage(message);
  if (heuristic.intent !== 'unknown' || !client) return heuristic;

  const subject = message.trim().split('\n')[0]?.trim() ?? '';
  if (!subject) return heuristic;

  try {
    const result = await client.chat(
      [
        { role: 'system', content: CHAT_FALLBACK_SYSTEM_PROMPT },
        { role: 'user', content: subject },
      ],
      { temperature: 0, maxTokens: 20, responseSchema: COMMIT_INTENT_SCHEMA },
    );
    let rawIntent: unknown;
    try {
      rawIntent = (JSON.parse(result.text) as { intent?: unknown }).intent;
    } catch {
      rawIntent = undefined;
    }
    const intent = CHAT_INTENT_LABELS.find((l) => l === rawIntent);
    if (!intent) return heuristic;
    return {
      intent,
      score: 1.0,
      reason: `chat fallback (label "${intent}")`,
    };
  } catch {
    return heuristic;
  }
}
