/**
 * Live MCP activity feed — Server-Sent Events.
 *
 * The MCP server writes every tool call to `mcp_tool_calls` (best-
 * effort, see src/trace/logger.ts); the viewer server shares that DB,
 * so a live feed is a poll loop over the indexed `ts` column. Each
 * connection gets a backlog snapshot, then new rows as `call` events.
 *
 * Cursor semantics: `toolCallsSince` is inclusive (`ts >= cursor`)
 * because `ts` is millisecond-resolution and two calls can land on
 * the same instant. The pump re-reads the cursor instant on every
 * tick and drops rows it already emitted via a (session, step) seen
 * set — same-ms arrivals are never lost or duplicated.
 */
import type * as http from 'node:http';
import { latestToolCalls, type ToolCallRow, toolCallsSince } from '../../../db/queries-trace.js';
import { errMsg, logDebug } from '../../../errors.js';
import {
  HTTP_OK,
  LIVE_BACKLOG_LIMIT,
  LIVE_CALLS_BATCH_LIMIT,
  LIVE_HEARTBEAT_MS,
  LIVE_POLL_INTERVAL_MS,
} from './constants.js';
import type { RequestContext } from './context.js';
import { clampInt, safeParseJson, writeSseEvent } from './http.js';
import { resolveScopedSessionId, viewerProjectRootParam } from './session-scope.js';

interface LiveCallPayload {
  readonly sessionId: string;
  readonly step: number;
  readonly ts: number;
  readonly tool: string;
  readonly args: unknown;
  readonly result: string;
  readonly durationMs: number;
  /** Cross-project call (the projectPath tool arg); null = the session's own project. */
  readonly project: string | null;
}

/** The effective project a recorded call targeted, when it overrode
    the session's own project via the projectPath tool arg. */
export function callProjectFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const projectPath = (args as { projectPath?: unknown }).projectPath;
  return typeof projectPath === 'string' && projectPath ? projectPath : null;
}

export function serializeLiveCall(row: ToolCallRow): LiveCallPayload {
  const args = safeParseJson(row.argsJson);
  return {
    sessionId: row.sessionId,
    step: row.step,
    ts: row.ts,
    tool: row.toolName,
    args,
    result: row.resultSummary,
    durationMs: row.durationMs,
    project: callProjectFromArgs(args),
  };
}

/** GET /api/live/calls — JSON polling fallback for the SSE stream. */
export function liveCallsPayload(ctx: RequestContext, sinceTsRaw: string | null, limitRaw: string | null): unknown {
  const limit = clampInt(limitRaw, LIVE_BACKLOG_LIMIT);
  const sinceTs = sinceTsRaw === null ? null : Number.parseInt(sinceTsRaw, 10);
  const scoped = resolveScopedSessionId(ctx);
  const projectRoot = viewerProjectRootParam(ctx);
  const rows =
    sinceTs !== null && Number.isFinite(sinceTs)
      ? toolCallsSince(ctx.queries, { sinceTs, limit, sessionId: scoped, projectRoot })
      : latestToolCalls(ctx.queries, { limit, sessionId: scoped, projectRoot });
  return { calls: rows.map(serializeLiveCall) };
}

function callKey(row: ToolCallRow): string {
  return `${row.sessionId}:${row.step}`;
}

/**
 * GET /api/live/stream — hold the response open and push tool calls
 * as they land in the DB. The route handler contract is fire-and-
 * forget (`handle` returns void), so never ending the response here
 * is exactly what keeps the stream alive.
 */
export function handleLiveStream(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): void {
  res.writeHead(HTTP_OK, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let backlog: ToolCallRow[];
  try {
    backlog = latestToolCalls(ctx.queries, {
      limit: LIVE_BACKLOG_LIMIT.default,
      sessionId: resolveScopedSessionId(ctx),
      projectRoot: viewerProjectRootParam(ctx),
    });
  } catch (err) {
    // Headers are already out as text/event-stream — end the stream
    // instead of letting the error escape to the JSON 500 path.
    logDebug('viewer: live stream backlog failed', { err: errMsg(err) });
    res.end();
    return;
  }
  writeSseEvent(res, 'backlog', { calls: backlog.map(serializeLiveCall) });

  let cursorTs = backlog.length > 0 ? backlog.at(-1)!.ts : 0;
  let seenAtCursor = new Set(backlog.filter((row) => row.ts === cursorTs).map(callKey));

  const stop = (): void => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  };

  const pollTimer = setInterval(() => {
    let rows: ToolCallRow[];
    try {
      // Scope is re-resolved per tick: a viewer launched for a labeled
      // session that hasn't started yet locks on once it appears.
      rows = toolCallsSince(ctx.queries, {
        sinceTs: cursorTs,
        limit: LIVE_CALLS_BATCH_LIMIT,
        sessionId: resolveScopedSessionId(ctx),
        projectRoot: viewerProjectRootParam(ctx),
      });
    } catch (err) {
      logDebug('viewer: live stream poll failed', { err: errMsg(err) });
      stop();
      res.end();
      return;
    }
    const fresh = rows.filter((row) => row.ts > cursorTs || !seenAtCursor.has(callKey(row)));
    if (fresh.length === 0) return;
    const lastTs = fresh.at(-1)!.ts;
    const seen = new Set(cursorTs === lastTs ? seenAtCursor : []);
    for (const row of fresh) {
      if (row.ts === lastTs) seen.add(callKey(row));
    }
    cursorTs = lastTs;
    seenAtCursor = seen;
    for (const row of fresh) writeSseEvent(res, 'call', serializeLiveCall(row));
  }, LIVE_POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(() => {
    res.write(':hb\n\n');
  }, LIVE_HEARTBEAT_MS);

  req.on('close', stop);
  res.on('close', stop);
}
