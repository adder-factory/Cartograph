/**
 * MCP trace persistence — sessions + tool calls.
 *
 * Writes are issued from the MCP server's tool dispatch hook; reads
 * are issued from the viewer's /api/sessions endpoints. All writes
 * are best-effort (the server logs and continues on failure rather
 * than failing the tool call), so the queries here don't throw on
 * benign failures — they let the caller's try/catch decide.
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20). The 11 prepared statements
 * in this file are declared at module scope via {@link defineQuery} —
 * Zod schemas drive both compile-time and runtime validation of params
 * + rows. Lazy-cached on `qb.queries.X` to mirror the existing
 * `qb.stmts.X` pattern.
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { qbTransaction } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

export interface SessionRow {
  id: string;
  startedTs: number;
  lastActivityTs: number;
  toolCount: number;
  /** Optional label set via cartograph_session({action: "create", label}). */
  label: string | null;
}

interface ToolCallRow {
  sessionId: string;
  step: number;
  ts: number;
  toolName: string;
  argsJson: string;
  resultSummary: string;
  durationMs: number;
}

interface InsertSessionArgs {
  qb: QueryBuilder;
  id: string;
  startedTs: number;
  label?: string;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────

const SessionDbRowSchema = z.object({
  id: z.string(),
  started_ts: z.number(),
  last_activity_ts: z.number(),
  tool_count: z.number(),
  label: z.string().nullable(),
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

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const insertSessionQuery = defineQuery({
  sql:
    `INSERT INTO mcp_sessions (id, started_ts, last_activity_ts, tool_count, label) ` +
    `VALUES (@id, @startedTs, @lastActivityTs, 0, @label) ` +
    `ON CONFLICT(id) DO NOTHING`,
  params: z.object({
    id: z.string(),
    startedTs: z.number(),
    lastActivityTs: z.number(),
    label: z.string().nullable(),
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
    `SELECT id, started_ts, last_activity_ts, tool_count, label ` +
    `FROM mcp_sessions ` +
    `WHERE label = @label ` +
    `ORDER BY started_ts DESC ` +
    `LIMIT 1`,
  params: z.object({ label: z.string() }),
  row: SessionDbRowSchema,
});

const getSessionByIdQuery = defineQuery({
  sql: `SELECT id, started_ts, last_activity_ts, tool_count, label ` + `FROM mcp_sessions WHERE id = @id`,
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
    `SELECT id, started_ts, last_activity_ts, tool_count, label ` +
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

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    insertSession?: TypedQuery<{ id: string; startedTs: number; lastActivityTs: number; label: string | null }, never>;
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
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/** Insert a new session row. Idempotent on PRIMARY KEY conflict. */
export function insertSession(args: InsertSessionArgs): void {
  const { qb, id, startedTs, label } = args;
  qb.queries.insertSession ??= insertSessionQuery(qb.db);
  qb.queries.insertSession.run({
    id,
    startedTs,
    lastActivityTs: startedTs,
    label: label ?? null,
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
function sessionRowFromDb(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    startedTs: r.started_ts,
    lastActivityTs: r.last_activity_ts,
    toolCount: r.tool_count,
    label: r.label,
  };
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
  return rows.map((r) => ({
    id: r.id,
    startedTs: r.started_ts,
    lastActivityTs: r.last_activity_ts,
    toolCount: r.tool_count,
    label: r.label,
  }));
}

/** All tool calls for a session, in step order. */
export function callsForSession(qb: QueryBuilder, sessionId: string): ToolCallRow[] {
  qb.queries.callsForSession ??= callsForSessionQuery(qb.db);
  const rows = qb.queries.callsForSession.all({ sessionId });
  return rows.map((r) => ({
    sessionId: r.session_id,
    step: r.step,
    ts: r.ts,
    toolName: r.tool_name,
    argsJson: r.args_json,
    resultSummary: r.result_summary,
    durationMs: r.duration_ms,
  }));
}
