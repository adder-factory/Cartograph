/**
 * MCP trace persistence — sessions + tool calls.
 *
 * Writes are issued from the MCP server's tool dispatch hook; reads
 * are issued from the viewer's /api/sessions endpoints. All writes
 * are best-effort (the server logs and continues on failure rather
 * than failing the tool call), so the queries here don't throw on
 * benign failures — they let the caller's try/catch decide.
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20). The prepared statements
 * in this file are declared at module scope via {@link defineQuery} —
 * Zod schemas drive both compile-time and runtime validation of params
 * + rows. Lazy-cached on `qb.queries.X` to mirror the existing
 * `qb.stmts.X` pattern.
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { qbTransaction } from './queries.js';
import { mapRowFields } from './row-mapping.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

export interface SessionRow {
  id: string;
  startedTs: number;
  lastActivityTs: number;
  toolCount: number;
  /** Optional label set via cartograph_session({action: "create", label}). */
  label: string | null;
  /** MCP client identity from the initialize handshake (073+). */
  clientName: string | null;
  clientVersion: string | null;
  /** The server's resolved default project root at session start (073+). */
  projectRoot: string | null;
}

export interface ToolCallRow {
  sessionId: string;
  step: number;
  ts: number;
  toolName: string;
  argsJson: string;
  resultSummary: string;
  durationMs: number;
}

export interface TraceToolUsage {
  toolName: string;
  callCount: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
}

export interface TraceUsageSummary {
  sessionCount: number;
  toolCallCount: number;
  errorLikeCount: number;
  tools: TraceToolUsage[];
}

interface InsertSessionArgs {
  qb: QueryBuilder;
  id: string;
  startedTs: number;
  label?: string;
  clientName?: string | undefined;
  clientVersion?: string | undefined;
  projectRoot?: string | undefined;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────

const SessionDbRowSchema = z.object({
  id: z.string(),
  started_ts: z.number(),
  last_activity_ts: z.number(),
  tool_count: z.number(),
  label: z.string().nullable(),
  client_name: z.string().nullable(),
  client_version: z.string().nullable(),
  project_root: z.string().nullable(),
});

type SessionDbRow = z.infer<typeof SessionDbRowSchema>;

const ToolCallDbRowSchema = z.object({
  session_id: z.string(),
  step: z.number(),
  ts: z.number(),
  tool_name: z.string(),
  args_json: z.string(),
  result_summary: z.string(),
  duration_ms: z.number(),
});

type ToolCallDbRow = z.infer<typeof ToolCallDbRowSchema>;

const UsageCountsDbRowSchema = z.object({
  session_count: z.number(),
  tool_call_count: z.number(),
});

type UsageCountsDbRow = z.infer<typeof UsageCountsDbRowSchema>;

const UsageCallDbRowSchema = z.object({
  tool_name: z.string(),
  duration_ms: z.number(),
  result_summary: z.string(),
});

type UsageCallDbRow = z.infer<typeof UsageCallDbRowSchema>;

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const insertSessionQuery = defineQuery({
  sql:
    `INSERT INTO mcp_sessions (id, started_ts, last_activity_ts, tool_count, label, client_name, client_version, project_root) ` +
    `VALUES (@id, @startedTs, @lastActivityTs, 0, @label, @clientName, @clientVersion, @projectRoot) ` +
    `ON CONFLICT(id) DO NOTHING`,
  params: z.object({
    id: z.string(),
    startedTs: z.number(),
    lastActivityTs: z.number(),
    label: z.string().nullable(),
    clientName: z.string().nullable(),
    clientVersion: z.string().nullable(),
    projectRoot: z.string().nullable(),
  }),
  row: z.never(),
});

const deleteToolCallsBySessionQuery = defineQuery({
  sql: `DELETE FROM mcp_tool_calls WHERE session_id = @id`,
  params: z.object({ id: z.string() }),
  row: z.never(),
});

const deleteSessionByIdQuery = defineQuery({
  sql: `DELETE FROM mcp_sessions WHERE id = @id`,
  params: z.object({ id: z.string() }),
  row: z.never(),
});

const findSessionByLabelQuery = defineQuery({
  sql:
    `SELECT id, started_ts, last_activity_ts, tool_count, label, client_name, client_version, project_root ` +
    `FROM mcp_sessions ` +
    `WHERE label = @label ` +
    `ORDER BY started_ts DESC ` +
    `LIMIT 1`,
  params: z.object({ label: z.string() }),
  row: SessionDbRowSchema,
});

const getSessionByIdQuery = defineQuery({
  sql:
    `SELECT id, started_ts, last_activity_ts, tool_count, label, client_name, client_version, project_root ` +
    `FROM mcp_sessions WHERE id = @id`,
  params: z.object({ id: z.string() }),
  row: SessionDbRowSchema,
});

const insertToolCallQuery = defineQuery({
  sql:
    `INSERT INTO mcp_tool_calls ` +
    `(session_id, step, ts, tool_name, args_json, result_summary, duration_ms) ` +
    `VALUES (@sessionId, @step, @ts, @toolName, @argsJson, @resultSummary, @durationMs)`,
  params: z.object({
    sessionId: z.string(),
    step: z.number(),
    ts: z.number(),
    toolName: z.string(),
    argsJson: z.string(),
    resultSummary: z.string(),
    durationMs: z.number(),
  }),
  row: z.never(),
});

const bumpSessionActivityQuery = defineQuery({
  sql: `UPDATE mcp_sessions ` + `SET last_activity_ts = @ts, tool_count = tool_count + 1 ` + `WHERE id = @id`,
  params: z.object({ ts: z.number(), id: z.string() }),
  row: z.never(),
});

const pruneToolCallsQuery = defineQuery({
  sql:
    `DELETE FROM mcp_tool_calls ` +
    `WHERE rowid IN ( ` +
    `  SELECT rowid FROM mcp_tool_calls ` +
    `   ORDER BY ts ASC ` +
    `   LIMIT MAX(0, (SELECT COUNT(*) FROM mcp_tool_calls) - @keep) ` +
    `)`,
  params: z.object({ keep: z.number() }),
  row: z.never(),
});

const gcEmptySessionsQuery = defineQuery({
  sql:
    `DELETE FROM mcp_sessions ` +
    `WHERE id NOT IN (SELECT DISTINCT session_id FROM mcp_tool_calls) ` +
    `  AND tool_count > 0`,
  params: z.object({}),
  row: z.never(),
});

const recentSessionsQuery = defineQuery({
  sql:
    `SELECT id, started_ts, last_activity_ts, tool_count, label, client_name, client_version, project_root ` +
    `FROM mcp_sessions ` +
    `ORDER BY started_ts DESC ` +
    `LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: SessionDbRowSchema,
});

const callsForSessionQuery = defineQuery({
  sql:
    `SELECT session_id, step, ts, tool_name, args_json, result_summary, duration_ms ` +
    `FROM mcp_tool_calls ` +
    `WHERE session_id = @sessionId ` +
    `ORDER BY step ASC`,
  params: z.object({ sessionId: z.string() }),
  row: ToolCallDbRowSchema,
});

const latestToolCallsQuery = defineQuery({
  sql:
    `SELECT session_id, step, ts, tool_name, args_json, result_summary, duration_ms ` +
    `FROM mcp_tool_calls ` +
    `ORDER BY ts DESC, session_id DESC, step DESC ` +
    `LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: ToolCallDbRowSchema,
});

const toolCallsSinceQuery = defineQuery({
  sql:
    `SELECT session_id, step, ts, tool_name, args_json, result_summary, duration_ms ` +
    `FROM mcp_tool_calls ` +
    `WHERE ts >= @sinceTs ` +
    `ORDER BY ts ASC, session_id ASC, step ASC ` +
    `LIMIT @limit`,
  params: z.object({ sinceTs: z.number(), limit: z.number() }),
  row: ToolCallDbRowSchema,
});

const usageCountsQuery = defineQuery({
  sql:
    `SELECT ` +
    `  (SELECT COUNT(*) FROM mcp_sessions) AS session_count, ` +
    `  (SELECT COUNT(*) FROM mcp_tool_calls) AS tool_call_count`,
  params: z.object({}),
  row: UsageCountsDbRowSchema,
});

const usageToolCallsQuery = defineQuery({
  sql:
    `SELECT tool_name, duration_ms, result_summary ` +
    `FROM mcp_tool_calls ` +
    `ORDER BY tool_name ASC, duration_ms ASC`,
  params: z.object({}),
  row: UsageCallDbRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    insertSession?: TypedQuery<
      {
        id: string;
        startedTs: number;
        lastActivityTs: number;
        label: string | null;
        clientName: string | null;
        clientVersion: string | null;
        projectRoot: string | null;
      },
      never
    >;
    deleteToolCallsBySession?: TypedQuery<{ id: string }, never>;
    deleteSessionById?: TypedQuery<{ id: string }, never>;
    findSessionByLabel?: TypedQuery<{ label: string }, SessionDbRow>;
    getSessionById?: TypedQuery<{ id: string }, SessionDbRow>;
    insertToolCall?: TypedQuery<
      {
        sessionId: string;
        step: number;
        ts: number;
        toolName: string;
        argsJson: string;
        resultSummary: string;
        durationMs: number;
      },
      never
    >;
    bumpSessionActivity?: TypedQuery<{ ts: number; id: string }, never>;
    pruneToolCalls?: TypedQuery<{ keep: number }, never>;
    gcEmptySessions?: TypedQuery<Record<string, never>, never>;
    recentSessions?: TypedQuery<{ limit: number }, SessionDbRow>;
    callsForSession?: TypedQuery<{ sessionId: string }, ToolCallDbRow>;
    latestToolCalls?: TypedQuery<{ limit: number }, ToolCallDbRow>;
    toolCallsSince?: TypedQuery<{ sinceTs: number; limit: number }, ToolCallDbRow>;
    traceUsageCounts?: TypedQuery<Record<string, never>, UsageCountsDbRow>;
    traceUsageToolCalls?: TypedQuery<Record<string, never>, UsageCallDbRow>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/** Insert a new session row. Idempotent on PRIMARY KEY conflict. */
export function insertSession(args: InsertSessionArgs): void {
  const { qb, id, startedTs, label, clientName, clientVersion, projectRoot } = args;
  qb.queries.insertSession ??= insertSessionQuery(qb.db);
  qb.queries.insertSession.run({
    id,
    startedTs,
    lastActivityTs: startedTs,
    label: label ?? null,
    clientName: clientName ?? null,
    clientVersion: clientVersion ?? null,
    projectRoot: projectRoot ?? null,
  });
}

/** Delete a session and its recorded tool calls. Returns true when a
 *  session row was actually removed (false = no such id). The
 *  `mcp_tool_calls` FK is `ON DELETE CASCADE`, but the children are
 *  deleted explicitly inside one transaction so the result does not
 *  depend on `PRAGMA foreign_keys` being enabled on the connection. */
export function deleteSession(qb: QueryBuilder, id: string): boolean {
  return qbTransaction(qb, () => {
    qb.queries.deleteToolCallsBySession ??= deleteToolCallsBySessionQuery(qb.db);
    qb.queries.deleteToolCallsBySession.run({ id });
    qb.queries.deleteSessionById ??= deleteSessionByIdQuery(qb.db);
    const res = qb.queries.deleteSessionById.run({ id });
    return res.changes > 0;
  });
}

/** Map a raw mcp_sessions DB row to the public SessionRow shape. */
const SESSION_ROW_FIELDS = [
  ['id', 'id'],
  ['started_ts', 'startedTs'],
  ['last_activity_ts', 'lastActivityTs'],
  ['tool_count', 'toolCount'],
  ['label', 'label'],
  ['client_name', 'clientName'],
  ['client_version', 'clientVersion'],
  ['project_root', 'projectRoot'],
] as const;

function sessionRowFromDb(r: SessionDbRow): SessionRow {
  return mapRowFields<SessionDbRow, SessionRow>(r, SESSION_ROW_FIELDS);
}

/** Look up a session by user-supplied label (most recent wins). */
export function findSessionByLabel(qb: QueryBuilder, label: string): SessionRow | null {
  qb.queries.findSessionByLabel ??= findSessionByLabelQuery(qb.db);
  const r = qb.queries.findSessionByLabel.get({ label });
  return r ? sessionRowFromDb(r) : null;
}

/** Look up a session by id. */
export function getSessionById(qb: QueryBuilder, id: string): SessionRow | null {
  qb.queries.getSessionById ??= getSessionByIdQuery(qb.db);
  const r = qb.queries.getSessionById.get({ id });
  return r ? sessionRowFromDb(r) : null;
}

/**
 * Append one tool call. Bumps the session's last_activity_ts +
 * tool_count atomically so /api/sessions can show "10 calls in the
 * last 30s" without a per-row aggregation.
 */
export function appendToolCall(qb: QueryBuilder, row: ToolCallRow): void {
  qbTransaction(qb, () => {
    qb.queries.insertToolCall ??= insertToolCallQuery(qb.db);
    qb.queries.insertToolCall.run({
      sessionId: row.sessionId,
      step: row.step,
      ts: row.ts,
      toolName: row.toolName,
      argsJson: row.argsJson,
      resultSummary: row.resultSummary,
      durationMs: row.durationMs,
    });
    qb.queries.bumpSessionActivity ??= bumpSessionActivityQuery(qb.db);
    qb.queries.bumpSessionActivity.run({ ts: row.ts, id: row.sessionId });
  });
}

/**
 * Cap the global call count by deleting the oldest rows beyond
 * `keep`. Sessions with no surviving calls are then garbage-
 * collected (FK CASCADE doesn't help — the session row outlives
 * its calls). Run periodically by the trace logger; sub-millisecond
 * on the indexed `ts` column.
 */
export function pruneToolCalls(qb: QueryBuilder, keep: number): void {
  if (keep < 1) return;
  qbTransaction(qb, () => {
    qb.queries.pruneToolCalls ??= pruneToolCallsQuery(qb.db);
    qb.queries.pruneToolCalls.run({ keep });
    qb.queries.gcEmptySessions ??= gcEmptySessionsQuery(qb.db);
    qb.queries.gcEmptySessions.run({});
  });
}

/** Most-recent N sessions, newest first. */
export function recentSessions(qb: QueryBuilder, limit: number): SessionRow[] {
  qb.queries.recentSessions ??= recentSessionsQuery(qb.db);
  const rows = qb.queries.recentSessions.all({ limit });
  return rows.map(sessionRowFromDb);
}

/** All tool calls for a session, in step order. */
export function callsForSession(qb: QueryBuilder, sessionId: string): ToolCallRow[] {
  qb.queries.callsForSession ??= callsForSessionQuery(qb.db);
  const rows = qb.queries.callsForSession.all({ sessionId });
  return rows.map(toolCallRowFromDb);
}

/** Most-recent N tool calls across all sessions, oldest first. */
export function latestToolCalls(qb: QueryBuilder, limit: number): ToolCallRow[] {
  qb.queries.latestToolCalls ??= latestToolCallsQuery(qb.db);
  const rows = qb.queries.latestToolCalls.all({ limit });
  return rows.map(toolCallRowFromDb).reverse();
}

/**
 * Tool calls at or after `sinceTs`, oldest first. Inclusive on
 * purpose: `ts` has millisecond resolution, so two calls can share a
 * timestamp — the live-stream pump re-reads the cursor instant and
 * dedupes by (session, step) instead of dropping same-ms rows.
 */
export function toolCallsSince(qb: QueryBuilder, sinceTs: number, limit: number): ToolCallRow[] {
  qb.queries.toolCallsSince ??= toolCallsSinceQuery(qb.db);
  const rows = qb.queries.toolCallsSince.all({ sinceTs, limit });
  return rows.map(toolCallRowFromDb);
}

function toolCallRowFromDb(r: ToolCallDbRow): ToolCallRow {
  return {
    sessionId: r.session_id,
    step: r.step,
    ts: r.ts,
    toolName: r.tool_name,
    argsJson: r.args_json,
    resultSummary: r.result_summary,
    durationMs: r.duration_ms,
  };
}

export function getTraceUsage(qb: QueryBuilder): TraceUsageSummary {
  qb.queries.traceUsageCounts ??= usageCountsQuery(qb.db);
  qb.queries.traceUsageToolCalls ??= usageToolCallsQuery(qb.db);
  const counts = qb.queries.traceUsageCounts.get({}) ?? { session_count: 0, tool_call_count: 0 };
  const calls = qb.queries.traceUsageToolCalls.all({});
  return {
    sessionCount: counts.session_count,
    toolCallCount: counts.tool_call_count,
    errorLikeCount: calls.filter((row) => isErrorLikeSummary(row.result_summary)).length,
    tools: summarizeToolUsage(calls),
  };
}

function summarizeToolUsage(rows: UsageCallDbRow[]): TraceToolUsage[] {
  const byTool = new Map<string, number[]>();
  for (const row of rows) {
    const durations = byTool.get(row.tool_name) ?? [];
    durations.push(row.duration_ms);
    byTool.set(row.tool_name, durations);
  }
  return [...byTool.entries()]
    .map(([toolName, durations]) => {
      durations.sort((a, b) => a - b);
      return {
        toolName,
        callCount: durations.length,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        maxDurationMs: durations.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.callCount - a.callCount || a.toolName.localeCompare(b.toolName));
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[idx] ?? 0);
}

function isErrorLikeSummary(summary: string): boolean {
  return /\b(error|failed|failure|exception)\b/i.test(summary);
}
