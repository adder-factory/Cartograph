/**
 * MCP trace logger.
 *
 * Wraps the MCP server's tool dispatch so every call lands in the
 * mcp_tool_calls table. The viewer reads this back to drive the
 * Agent-trace tab.
 *
 * Design choices:
 *   - Best-effort writes: if persistence fails (DB locked,
 *     connection died), the call is logged at debug and the tool's
 *     result is returned unchanged. Trace rows must NEVER swallow a
 *     real tool result.
 *   - Args are redacted, truncated, and JSON-stringified
 *     (TRUNCATE_AT chars) so secrets and 50KB context payloads don't
 *     bloat the trace store.
 *   - Result summaries are derived from the result envelope's first
 *     content block — short text excerpts, NOT the full payload.
 *   - Periodic prune: every PRUNE_EVERY calls, evict the oldest
 *     rows beyond CALL_HISTORY_KEEP. Keeps the table bounded
 *     without a separate background job.
 */
import { randomBytes } from 'node:crypto';
import type { QueryBuilder } from '../db/queries.js';
import { insertSession, appendToolCall, pruneToolCalls } from '../db/queries-trace.js';
import { logDebug, errMsg } from '../errors.js';

/** Total rows we keep across all sessions. Older calls evicted oldest-first. */
export const CALL_HISTORY_KEEP = 10_000;

/** Run the prune sweep every N appends. Cheaper than per-call. */
const PRUNE_EVERY = 200;

/** Max chars of args / result_summary stored. Anything longer truncates with an ellipsis. */
const TRUNCATE_AT = 2000;

/** Milliseconds in a second — used to derive the unix-seconds time prefix on session ids. */
const MS_PER_SECOND = 1000;

/** Random byte count (3) for the session-id suffix (yields 6 hex chars). */
const SESSION_ID_RANDOM_BYTES = 3;

/** Marker persisted anywhere a trace value was secret-bearing. */
const REDACTED = '[redacted]';

/** Guard pathological objects; trace logging must stay best-effort and bounded. */
const REDACT_MAX_DEPTH = 20;

const SENSITIVE_KEY_FRAGMENTS = [
  'apikey',
  'password',
  'passwd',
  'secret',
  'credential',
  'authorization',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
] as const;
const TOKEN_KEY = 'token';
const AUTHORIZATION_KEY = 'authorization';
const BEARER_PREFIX = 'bearer';
const INLINE_ASSIGNMENT_SEPARATORS = new Set([':', '=']);
const INLINE_VALUE_TERMINATORS = new Set([' ', '\t', '\r', '\n', ',', ';', '&']);
const URL_TRAILING_PUNCTUATION = new Set([')', ',', '.', ';', ':', '!', '?']);
const URL_TERMINATORS = new Set([' ', '\t', '\r', '\n', '<', '>', '"', "'", '`']);

/** The shape we accept from the MCP tool dispatch — only the bits we need. */
interface ToolResultEnvelope {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  isError?: boolean;
}

export interface TraceSessionIdentity {
  /** MCP client identity from the initialize handshake. */
  clientName?: string | undefined;
  clientVersion?: string | undefined;
  /** The server's resolved default project root. */
  projectRoot?: string | undefined;
}

export class TraceLogger {
  private readonly queries: QueryBuilder;
  readonly sessionId: string;
  private step = 0;
  private appendsSincePrune = 0;

  constructor(queries: QueryBuilder, sessionId?: string, identity: TraceSessionIdentity = {}) {
    this.queries = queries;
    this.sessionId = sessionId ?? generateSessionId();
    try {
      insertSession({
        qb: queries,
        id: this.sessionId,
        startedTs: Date.now(),
        clientName: identity.clientName,
        clientVersion: identity.clientVersion,
        projectRoot: identity.projectRoot,
      });
    } catch (err) {
      logDebug('TraceLogger: insertSession failed (continuing)', { err: errMsg(err) });
    }
  }

  /**
   * Record one tool call. Failure to persist is logged at debug and
   * does not throw — the caller's tool result must not be lost.
   */
  log(record: { toolName: string; args: unknown; result: ToolResultEnvelope; durationMs: number }): void {
    const { toolName, args, result, durationMs } = record;
    this.step++;
    try {
      appendToolCall(this.queries, {
        sessionId: this.sessionId,
        step: this.step,
        ts: Date.now(),
        toolName,
        argsJson: stringifyTruncated(redactTraceValue(args)),
        resultSummary: summarizeResult(result),
        durationMs: Math.max(0, Math.round(durationMs)),
      });
      this.pruneIfDue();
    } catch (err) {
      logDebug('TraceLogger: appendToolCall failed', { err: errMsg(err), toolName });
    }
  }

  /** Tick the per-append counter; when it reaches {@link PRUNE_EVERY},
   *  reset and prune the call-history table to {@link CALL_HISTORY_KEEP}
   *  rows. Errors are swallowed at debug level — the prune is
   *  housekeeping, not user-visible. */
  private pruneIfDue(): void {
    this.appendsSincePrune++;
    if (this.appendsSincePrune < PRUNE_EVERY) return;
    this.appendsSincePrune = 0;
    try {
      pruneToolCalls(this.queries, CALL_HISTORY_KEEP);
    } catch (err) {
      logDebug('TraceLogger: prune failed', { err: errMsg(err) });
    }
  }
}

/**
 * Short hex session id. Format: `<unix-seconds>-<6 random hex>`.
 * Sortable by time prefix, distinct enough to avoid collisions.
 */
export function generateSessionId(): string {
  const t = Math.floor(Date.now() / MS_PER_SECOND).toString(16);
  const r = randomBytes(SESSION_ID_RANDOM_BYTES).toString('hex');
  return `${t}-${r}`;
}

/**
 * Redact trace args/results before they enter the DB. This is the
 * only durable trace store; the viewer reads it back directly, so
 * persistence-time redaction also protects display.
 */
export function redactTraceValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactTraceText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= REDACT_MAX_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.map((item) => redactTraceValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveTraceKey(key) ? REDACTED : redactTraceValue(child, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

/** Redact URLs and key/value snippets in human-readable result previews. */
export function redactTraceText(text: string): string {
  return redactInlineSensitiveAssignments(redactUrls(text));
}

/** JSON.stringify with truncation. Strings beyond TRUNCATE_AT collapse with '…[truncated]'. */
function stringifyTruncated(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? 'null';
  } catch {
    s = String(v);
  }
  if (s.length <= TRUNCATE_AT) return s;
  return s.slice(0, TRUNCATE_AT) + '…[truncated]';
}

/**
 * Build a one-line summary of a tool result. Pulls the first-line
 * preview of the first text content block; falls back to a kind
 * label when no text is present (binary results, tool errors).
 */
function summarizeResult(r: ToolResultEnvelope): string {
  if (r.isError) return '⚠ tool error';
  const first = r.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!first?.text) return '(no text content)';
  const trimmed = first.text.trim();
  const oneLine = redactTraceText(trimmed.split('\n', 1)[0] ?? '');
  if (oneLine.length <= TRUNCATE_AT) return oneLine;
  return oneLine.slice(0, TRUNCATE_AT) + '…[truncated]';
}

function isSensitiveTraceKey(key: string): boolean {
  const normalized = normalizedTraceKey(key);
  return (
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
    normalized === TOKEN_KEY ||
    (normalized.endsWith(TOKEN_KEY) && !normalized.endsWith(`${TOKEN_KEY}s`))
  );
}

function normalizedTraceKey(key: string): string {
  let out = '';
  for (const ch of key.toLowerCase()) {
    if (isAsciiLowercaseLetter(ch) || isAsciiDigit(ch)) out += ch;
  }
  return out;
}

function redactUrls(text: string): string {
  let out = '';
  let cursor = 0;
  const lower = text.toLowerCase();
  while (cursor < text.length) {
    const start = nextUrlStart(lower, cursor);
    if (start < 0) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, start);
    let end = start;
    while (end < text.length && !URL_TERMINATORS.has(text[end]!)) end++;
    out += sanitizeUrl(text.slice(start, end));
    cursor = end;
  }
  return out;
}

function nextUrlStart(lowerText: string, from: number): number {
  const http = lowerText.indexOf('http://', from);
  const https = lowerText.indexOf('https://', from);
  if (http < 0) return https;
  if (https < 0) return http;
  return Math.min(http, https);
}

function sanitizeUrl(raw: string): string {
  const { candidate, suffix } = splitTrailingUrlPunctuation(raw);
  try {
    const url = new URL(candidate);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of url.searchParams.keys()) {
      if (isSensitiveTraceKey(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString() + suffix;
  } catch {
    return raw;
  }
}

function splitTrailingUrlPunctuation(raw: string): { candidate: string; suffix: string } {
  let end = raw.length;
  while (end > 0 && URL_TRAILING_PUNCTUATION.has(raw[end - 1]!)) end--;
  return { candidate: raw.slice(0, end), suffix: raw.slice(end) };
}

function redactInlineSensitiveAssignments(text: string): string {
  return redactSensitiveKeyValues(redactAuthorizationBearerValues(text));
}

function redactAuthorizationBearerValues(text: string): string {
  let out = '';
  let cursor = 0;
  const lower = text.toLowerCase();
  while (cursor < text.length) {
    const keyStart = lower.indexOf(AUTHORIZATION_KEY, cursor);
    if (keyStart < 0) {
      out += text.slice(cursor);
      break;
    }
    const parsed = parseAssignmentAt(text, keyStart);
    if (!parsed || normalizedTraceKey(parsed.key) !== AUTHORIZATION_KEY) {
      out += text.slice(cursor, keyStart + AUTHORIZATION_KEY.length);
      cursor = keyStart + AUTHORIZATION_KEY.length;
      continue;
    }
    const bearer = parseBearerValue(text, parsed.valueStart);
    if (!bearer) {
      out += text.slice(cursor, parsed.valueStart);
      cursor = parsed.valueStart;
      continue;
    }
    out += text.slice(cursor, bearer.tokenStart) + REDACTED;
    cursor = bearer.tokenEnd;
  }
  return out;
}

function redactSensitiveKeyValues(text: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const sep = nextAssignmentSeparator(text, cursor);
    if (sep < 0) {
      out += text.slice(cursor);
      break;
    }
    const parsed = parseAssignmentAt(text, sep);
    if (!parsed || !isSensitiveTraceKey(parsed.key)) {
      out += text.slice(cursor, sep + 1);
      cursor = sep + 1;
      continue;
    }
    out += text.slice(cursor, parsed.valueStart) + REDACTED;
    cursor = parsed.valueEnd;
  }
  return out;
}

function nextAssignmentSeparator(text: string, from: number): number {
  const colon = text.indexOf(':', from);
  const equals = text.indexOf('=', from);
  if (colon < 0) return equals;
  if (equals < 0) return colon;
  return Math.min(colon, equals);
}

function parseAssignmentAt(
  text: string,
  indexInAssignment: number,
): { key: string; valueStart: number; valueEnd: number } | null {
  const sep = INLINE_ASSIGNMENT_SEPARATORS.has(text[indexInAssignment]!)
    ? indexInAssignment
    : nextAssignmentSeparator(text, indexInAssignment);
  if (sep < 0) return null;
  let keyEnd = sep;
  while (keyEnd > 0 && isInlineWhitespace(text[keyEnd - 1]!)) keyEnd--;
  let keyStart = keyEnd;
  while (keyStart > 0 && isTraceKeyChar(text[keyStart - 1]!)) keyStart--;
  if (keyStart === keyEnd) return null;
  let valueStart = sep + 1;
  while (valueStart < text.length && isInlineWhitespace(text[valueStart]!)) valueStart++;
  let valueEnd = valueStart;
  while (valueEnd < text.length && !INLINE_VALUE_TERMINATORS.has(text[valueEnd]!)) valueEnd++;
  return { key: text.slice(keyStart, keyEnd), valueStart, valueEnd };
}

function parseBearerValue(text: string, valueStart: number): { tokenStart: number; tokenEnd: number } | null {
  if (text.slice(valueStart, valueStart + BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return null;
  let tokenStart = valueStart + BEARER_PREFIX.length;
  if (!isInlineWhitespace(text[tokenStart] ?? '')) return null;
  while (tokenStart < text.length && isInlineWhitespace(text[tokenStart]!)) tokenStart++;
  let tokenEnd = tokenStart;
  while (tokenEnd < text.length && !INLINE_VALUE_TERMINATORS.has(text[tokenEnd]!)) tokenEnd++;
  return tokenStart < tokenEnd ? { tokenStart, tokenEnd } : null;
}

function isTraceKeyChar(ch: string): boolean {
  return (
    isAsciiUppercaseLetter(ch) ||
    isAsciiLowercaseLetter(ch) ||
    isAsciiDigit(ch) ||
    ch === '_' ||
    ch === '-' ||
    ch === '.'
  );
}

function isAsciiUppercaseLetter(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function isAsciiLowercaseLetter(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isInlineWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}
