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
 *   - Args are truncated + JSON-stringified (TRUNCATE_AT chars) so
 *     a 50KB context payload doesn't bloat the trace store.
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

/** The shape we accept from the MCP tool dispatch — only the bits we need. */
interface ToolResultEnvelope {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  isError?: boolean;
}

export class TraceLogger {
  private readonly queries: QueryBuilder;
  readonly sessionId: string;
  private step = 0;
  private appendsSincePrune = 0;

  constructor(queries: QueryBuilder, sessionId?: string) {
    this.queries = queries;
    this.sessionId = sessionId ?? generateSessionId();
    try {
      insertSession({ qb: queries, id: this.sessionId, startedTs: Date.now() });
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
        argsJson: stringifyTruncated(args),
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
  const oneLine = trimmed.split('\n', 1)[0] ?? '';
  if (oneLine.length <= TRUNCATE_AT) return oneLine;
  return oneLine.slice(0, TRUNCATE_AT) + '…[truncated]';
}
