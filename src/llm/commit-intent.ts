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
  { pattern: /^(feat|feature)[(:]/i, intent: 'feat' },
  { pattern: /^(fix|bugfix|hotfix)[(:]/i, intent: 'fix' },
  { pattern: /^refactor[(:]/i, intent: 'refactor' },
  { pattern: /^perf[(:]/i, intent: 'perf' },
  { pattern: /^test[(:]/i, intent: 'test' },
  { pattern: /^docs?[(:]/i, intent: 'docs' },
  { pattern: /^(chore|build|ci)[(:]/i, intent: 'chore' },
];

const PREFIX_SCORE = 0.95;

// ---------------------------------------------------------------------------
// Rule 2 — Keyword cues in the subject line (medium confidence)
// Each entry is [pattern, intent, score]. Evaluated in order; first
// match wins, so ordering encodes priority within this tier.
// ---------------------------------------------------------------------------

interface KeywordRule {
  match: (subject: string) => string | null;
  intent: CommitIntent;
  score: number;
}

const DOCS_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bupdate docs?\b/i,
  /\bfix(?:ed)? docs?\b/i,
  /\badd(?:ed)? docs?\b/i,
  /\breadme\b/i,
  /\bcomments?\b/i,
];
const FIX_VERB_PATTERNS: readonly RegExp[] = [
  /\bfix(?:ed|es)?\b/i,
  /\bresolve[ds]?\b/i,
  /\bcorrect(?:ed|s)?\b/i,
  /\bhandle[ds]?\b/i,
];
const FIX_SIGNAL_RE = /\b(?:bug|issue|error|crash|exception|fail|broken|regression)\b/i;
const TEST_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\badd(?:ed)? tests?\b/i,
  /\btests? for\b/i,
  /\bspecs? for\b/i,
  /\btest coverage\b/i,
];
const FEAT_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\badd(?:ed|s)?\b/i,
  /\bimplement(?:ed|s)?\b/i,
  /\bintroduce[ds]?\b/i,
  /\bsupport(?:ed|s)?\b/i,
];
const REFACTOR_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\brefactor(?:ed|s)?\b/i,
  /\brename[ds]?\b/i,
  /\bextract(?:ed|s)?\b/i,
  /\bsimplif(?:y|ied|ies)\b/i,
  /\bclean(?:ed)? ?up\b/i,
];
const PERF_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bimprove performance\b/i,
  /\bspeed up\b/i,
  /\boptimiz(?:e[ds]?|ation)\b/i,
  /\bfaster\b/i,
  /\bcach(?:e[ds]?|ing)\b/i,
];
const CHORE_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bbump\b/i,
  /\bupgrade[ds]?\b/i,
  /\bdeps?\b/i,
  /\bdependencies\b/i,
  /\bdependency\b/i,
];

function firstKeywordCue(subject: string, patterns: readonly RegExp[]): string | null {
  let best: RegExpExecArray | null = null;
  let bestPatternIndex = Number.POSITIVE_INFINITY;
  for (const [patternIndex, pattern] of patterns.entries()) {
    const match = pattern.exec(subject);
    if (!match) continue;
    if (!best || match.index < best.index || (match.index === best.index && patternIndex < bestPatternIndex)) {
      best = match;
      bestPatternIndex = patternIndex;
    }
  }
  return best?.[0] ?? null;
}

function orderedFixCue(subject: string): string | null {
  const candidates: RegExpExecArray[] = [];
  for (const pattern of FIX_VERB_PATTERNS) {
    const match = pattern.exec(subject);
    if (match) candidates.push(match);
  }

  candidates.sort((a, b) => a.index - b.index);
  for (const verb of candidates) {
    const afterVerb = subject.slice(verb.index + verb[0].length);
    const signal = FIX_SIGNAL_RE.exec(afterVerb);
    if (signal) {
      return subject.slice(verb.index, verb.index + verb[0].length + signal.index + signal[0].length);
    }
  }
  return null;
}

const KEYWORD_RULES: KeywordRule[] = [
  // docs — must come before fix so "fix typo" routes to docs
  { match: (subject) => firstKeywordCue(subject, [/\btypo\b/i]), intent: 'docs', score: 0.6 },
  { match: (subject) => firstKeywordCue(subject, DOCS_KEYWORD_PATTERNS), intent: 'docs', score: 0.6 },
  // fix — keyword + signal word pairing
  { match: orderedFixCue, intent: 'fix', score: 0.6 },
  // test — add/spec before generic add
  { match: (subject) => firstKeywordCue(subject, TEST_KEYWORD_PATTERNS), intent: 'test', score: 0.6 },
  // feat — broad add/implement/introduce/support
  { match: (subject) => firstKeywordCue(subject, FEAT_KEYWORD_PATTERNS), intent: 'feat', score: 0.6 },
  // refactor
  { match: (subject) => firstKeywordCue(subject, REFACTOR_KEYWORD_PATTERNS), intent: 'refactor', score: 0.6 },
  // perf
  { match: (subject) => firstKeywordCue(subject, PERF_KEYWORD_PATTERNS), intent: 'perf', score: 0.6 },
  // chore — bump/upgrade/deps
  { match: (subject) => firstKeywordCue(subject, CHORE_KEYWORD_PATTERNS), intent: 'chore', score: 0.55 },
  // chore — merge commits
  { match: (subject) => firstKeywordCue(subject, [/^merge\b/i]), intent: 'chore', score: 0.5 },
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
    return { intent: 'unknown', score: 0, reason: 'no rule matched' };
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
    const keyword = rule.match(subject);
    if (keyword) {
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
  return { intent: 'unknown', score: 0, reason: 'no rule matched' };
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
      score: 1,
      reason: `chat fallback (label "${intent}")`,
    };
  } catch {
    return heuristic;
  }
}
