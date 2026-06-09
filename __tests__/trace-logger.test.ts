/**
 * TraceLogger + queries-trace round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { TraceLogger, generateSessionId, CALL_HISTORY_KEEP } from '../src/trace/logger.js';
import { recentSessions, callsForSession, pruneToolCalls } from '../src/db/queries-trace.js';

describe('TraceLogger', () => {
  let dir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-trace-test-'));
    db = DatabaseConnection.initialize(path.join(dir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a session row at construction', () => {
    const t = new TraceLogger(qb);
    const sessions = recentSessions(qb, 10);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(t.sessionId);
    expect(sessions[0]?.toolCount).toBe(0);
  });

  it('appends tool calls in step order with monotonic step numbers', () => {
    const t = new TraceLogger(qb);
    t.log({
      toolName: 'cartograph_find',
      args: { by: 'name', query: 'foo' },
      result: { content: [{ type: 'text', text: '1 result' }] },
      durationMs: 12,
    });
    t.log({
      toolName: 'cartograph_graph',
      args: { symbol: 'foo' },
      result: { content: [{ type: 'text', text: '5 callers' }] },
      durationMs: 8,
    });
    const calls = callsForSession(qb, t.sessionId);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.step)).toEqual([1, 2]);
    expect(calls.map((c) => c.toolName)).toEqual(['cartograph_find', 'cartograph_graph']);
    expect(calls[0]?.resultSummary).toBe('1 result');
    expect(calls[0]?.durationMs).toBe(12);
  });

  it('updates tool_count on the session as calls are appended', () => {
    const t = new TraceLogger(qb);
    t.log({ toolName: 'a', args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    t.log({ toolName: 'b', args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    t.log({ toolName: 'c', args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    expect(recentSessions(qb, 10)[0]?.toolCount).toBe(3);
  });

  it('marks tool errors with a clear summary marker', () => {
    const t = new TraceLogger(qb);
    t.log({
      toolName: 'boom',
      args: {},
      result: { isError: true, content: [{ type: 'text', text: 'kaboom' }] },
      durationMs: 4,
    });
    const calls = callsForSession(qb, t.sessionId);
    expect(calls[0]?.resultSummary).toMatch(/tool error/);
  });

  it('takes only the first line of multi-line tool output as summary', () => {
    const t = new TraceLogger(qb);
    t.log({
      toolName: 'multi',
      args: {},
      result: { content: [{ type: 'text', text: 'first line\nsecond line\nthird' }] },
      durationMs: 1,
    });
    const calls = callsForSession(qb, t.sessionId);
    expect(calls[0]?.resultSummary).toBe('first line');
  });

  it('truncates oversized args JSON', () => {
    const t = new TraceLogger(qb);
    const huge = { payload: 'x'.repeat(5000) };
    t.log({ toolName: 'big', args: huge, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    const calls = callsForSession(qb, t.sessionId);
    expect(calls[0]?.argsJson.length).toBeLessThan(2050);
    expect(calls[0]?.argsJson).toMatch(/truncated/);
  });

  it('redacts secret-bearing args and endpoint credentials before persistence', () => {
    const t = new TraceLogger(qb);
    t.log({
      toolName: 'cartograph_admin',
      args: {
        action: 'llm-apply',
        apiKey: 'sk-live-argument',
        endpoint: 'https://trace-user:trace-pass@example.test/v1?api_key=sk-query&safe=1',
        nested: {
          headers: { Authorization: 'Bearer trace-header-token' },
          accessToken: 'trace-access-token',
        },
      },
      result: {
        content: [
          {
            type: 'text',
            text:
              'Wrote endpoint https://viewer-user:viewer-pass@example.test/v1?token=result-token and apiKey=sk-result\n' +
              'second line not stored',
          },
        ],
      },
      durationMs: 1,
    });

    const call = callsForSession(qb, t.sessionId)[0]!;
    const args = JSON.parse(call.argsJson) as {
      apiKey: string;
      endpoint: string;
      nested: { headers: { Authorization: string }; accessToken: string };
    };

    expect(args.apiKey).toBe('[redacted]');
    expect(args.nested.accessToken).toBe('[redacted]');
    expect(args.nested.headers.Authorization).toBe('[redacted]');
    expect(args.endpoint).toContain('https://redacted:redacted@example.test/v1');
    expect(args.endpoint).toContain('safe=1');

    const persisted = `${call.argsJson}\n${call.resultSummary}`;
    expect(persisted).not.toContain('sk-live-argument');
    expect(persisted).not.toContain('trace-pass');
    expect(persisted).not.toContain('sk-query');
    expect(persisted).not.toContain('trace-header-token');
    expect(persisted).not.toContain('trace-access-token');
    expect(persisted).not.toContain('viewer-pass');
    expect(persisted).not.toContain('result-token');
    expect(persisted).not.toContain('sk-result');
    expect(call.resultSummary).toContain('https://redacted:redacted@example.test/v1');
    expect(call.resultSummary).toContain('apiKey=[redacted]');
  });

  it('pruneToolCalls keeps only the newest N rows', () => {
    const t = new TraceLogger(qb);
    for (let i = 0; i < 20; i++) {
      t.log({ toolName: `tool${i}`, args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    }
    pruneToolCalls(qb, 5);
    const calls = callsForSession(qb, t.sessionId);
    expect(calls).toHaveLength(5);
    // The five surviving steps should be the highest five.
    expect(calls.map((c) => c.step).sort((a, b) => a - b)).toEqual([16, 17, 18, 19, 20]);
  });

  it('two TraceLoggers produce distinct session ids and independent step counters', () => {
    const a = new TraceLogger(qb);
    const b = new TraceLogger(qb);
    expect(a.sessionId).not.toBe(b.sessionId);
    a.log({ toolName: 'x', args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    b.log({ toolName: 'y', args: {}, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 });
    expect(callsForSession(qb, a.sessionId)[0]?.step).toBe(1);
    expect(callsForSession(qb, b.sessionId)[0]?.step).toBe(1);
  });

  it('CALL_HISTORY_KEEP is a sane positive integer', () => {
    expect(Number.isInteger(CALL_HISTORY_KEEP)).toBe(true);
    expect(CALL_HISTORY_KEEP).toBeGreaterThan(100);
  });

  it('generateSessionId produces unique-looking ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(100);
  });
});
