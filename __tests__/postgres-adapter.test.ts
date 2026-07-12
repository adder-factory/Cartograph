import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePostgresWorkerJson, type WorkerRequest } from '../src/db/postgres-codec.js';
import { PostgresAdapter } from '../src/db/postgres-adapter.js';
import { readPostgresSchemaSizeBytes } from '../src/db/index.js';
import { rewritePostgresAfterPlaceholders } from '../src/db/postgres-worker-sql.js';

interface Harness {
  readonly adapter: PostgresAdapter;
  readonly captured: unknown[];
  readonly terminated: () => number;
  readonly bridgeDirExists: () => boolean;
  readonly cleanup: () => void;
}

type WorkerWaitMode = 'normal' | 'timeout' | 'invalid-state';
const INT32_BYTES = 4;
const QUERY_TIMEOUT_MS = 100;
const WORKER_REQUEST = 1;
const WORKER_RESPONSE = 2;
const INVALID_WORKER_STATE = 99;
const TERMINATE_EXIT_CODE = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PostgresAdapter worker bridge', () => {
  it('encodes request values and decodes worker responses', () => {
    const harness = makeHarness([
      {
        ok: true,
        rows: [
          {
            payload: { __cartographBinary: Buffer.from([4, 5]).toString('base64') },
            id: { __cartographBigInt: '12' },
            nested: [{ __cartographBigInt: '13' }],
          },
        ],
        changes: 1,
        lastInsertRowid: { __cartographBigInt: '44' },
      },
    ]);

    try {
      const input = Uint8Array.from([1, 2, 3]);
      const result = harness.adapter.call({
        op: 'query',
        sql: 'SELECT $1',
        mode: 'all',
        params: [input, 9n, { nested: [input, 10n], plain: 'value' }],
      });

      expect(harness.captured[0]).toMatchObject({
        op: 'query',
        params: [
          { __cartographBinary: Buffer.from([1, 2, 3]).toString('base64') },
          { __cartographBigInt: '9' },
          {
            nested: [{ __cartographBinary: Buffer.from([1, 2, 3]).toString('base64') }, { __cartographBigInt: '10' }],
            plain: 'value',
          },
        ],
      });
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(44n);
      expect(result.rows?.[0]).toEqual({
        payload: Buffer.from([4, 5]),
        id: 12n,
        nested: [13n],
      });
    } finally {
      harness.cleanup();
    }
  });

  it('maps prepared statement run, batch, get, all, and iterate calls', () => {
    const harness = makeHarness([
      { ok: true, changes: 2, lastInsertRowid: 5 },
      { ok: true, changes: 3, lastInsertRowid: 8 },
      { ok: true, rows: [{ id: 1 }] },
      { ok: true, rows: [] },
      { ok: true, rows: [{ id: 1 }, { id: 2 }] },
    ]);

    try {
      const stmt = harness.adapter.prepare('SELECT * FROM nodes WHERE id = $1');
      expect(stmt.run('n:1')).toEqual({ changes: 2, lastInsertRowid: 5 });
      expect(stmt.runBatch([])).toEqual({ changes: 0, lastInsertRowid: 0 });
      expect(stmt.runBatch([['n:1'], ['n:2']])).toEqual({ changes: 3, lastInsertRowid: 8 });
      expect(stmt.get('n:1')).toEqual({ id: 1 });
      expect(stmt.get('missing')).toBeNull();
      expect([...stmt.iterate('all')]).toEqual([{ id: 1 }, { id: 2 }]);
      expect(harness.captured).toEqual([
        expect.objectContaining({ op: 'query', mode: 'run', params: ['n:1'] }),
        expect.objectContaining({ op: 'batch', mode: 'run', paramSets: [['n:1'], ['n:2']] }),
        expect.objectContaining({ op: 'query', mode: 'get', params: ['n:1'] }),
        expect.objectContaining({ op: 'query', mode: 'get', params: ['missing'] }),
        expect.objectContaining({ op: 'query', mode: 'all', params: ['all'] }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('runs exec, pragma, transactions, rollback, and close over the bridge', () => {
    const harness = makeHarness([{ ok: true }, { ok: true, value: 'pragma-value' }]);

    try {
      harness.adapter.exec('PRAGMA foreign_keys = ON');
      expect(harness.captured).toEqual([]);
      harness.adapter.exec('VACUUM');
      expect(harness.adapter.pragma('table_info(nodes)')).toBe('pragma-value');

      const result = harness.adapter.transaction((label: unknown) => {
        const inner = harness.adapter.transaction(() => 'inner');
        expect(inner()).toBe('inner');
        return `outer:${label}`;
      })('ok');
      expect(result).toBe('outer:ok');

      expect(() =>
        harness.adapter.transaction(() => {
          throw new Error('boom');
        })(),
      ).toThrow('boom');

      const operations = harness.captured
        .map((request) => (request as { sql?: string; pragma?: string }).sql ?? (request as { pragma?: string }).pragma)
        .filter(Boolean);
      expect(operations).toEqual(
        expect.arrayContaining([
          'VACUUM',
          'table_info(nodes)',
          'BEGIN',
          'SAVEPOINT cartograph_sp_1',
          'RELEASE SAVEPOINT cartograph_sp_1',
          'COMMIT',
          'ROLLBACK',
        ]),
      );

      harness.adapter.close();
      expect(harness.terminated()).toBe(1);
      expect(harness.adapter.open).toBe(false);
      harness.adapter.close();
      expect(harness.terminated()).toBe(1);
      expect(() => harness.adapter.call({ op: 'exec', sql: 'SELECT 1' })).toThrow('PostgreSQL connection is closed');
    } finally {
      harness.cleanup();
    }
  });

  it('reports timeout, invalid state, and worker error responses', () => {
    const timeout = makeHarness([], 'timeout');
    try {
      expect(() => timeout.adapter.call({ op: 'exec', sql: 'SELECT pg_sleep(1)' })).toThrow('timed out');
      expect(timeout.adapter.open).toBe(false);
      expect(timeout.terminated()).toBe(1);
      expect(timeout.bridgeDirExists()).toBe(false);
    } finally {
      timeout.cleanup();
    }

    const invalid = makeHarness([], 'invalid-state');
    try {
      expect(() => invalid.adapter.call({ op: 'exec', sql: 'SELECT 1' })).toThrow('invalid state');
    } finally {
      invalid.cleanup();
    }

    const failed = makeHarness([{ ok: false, error: 'permission denied' }]);
    try {
      expect(() => failed.adapter.call({ op: 'exec', sql: 'DROP TABLE nodes' })).toThrow('permission denied');
    } finally {
      failed.cleanup();
    }
  });

  it('restarts the bridge once after a closed PostgreSQL worker connection outside a transaction', () => {
    const harness = makeHarness([
      { ok: false, error: 'PostgreSQL connection is closed' },
      { ok: true, rows: [{ ok: 1 }] },
    ]);
    let restarts = 0;
    (harness.adapter as unknown as { restartBridgeForRetry: () => void }).restartBridgeForRetry = () => {
      restarts++;
    };

    try {
      const response = harness.adapter.call({ op: 'query', sql: 'SELECT 1', mode: 'all', params: [] });

      expect(restarts).toBe(1);
      expect(response.rows).toEqual([{ ok: 1 }]);
      expect(harness.captured).toHaveLength(2);
    } finally {
      harness.cleanup();
    }
  });

  it('restarts the bridge once after an administrator-terminated PostgreSQL connection', () => {
    // PostgreSQL's server-restart / pg_terminate_backend wording — word order is
    // reversed vs "connection terminated", so this guards the dedicated regex arm.
    const harness = makeHarness([
      { ok: false, error: 'terminating connection due to administrator command' },
      { ok: true, rows: [{ ok: 1 }] },
    ]);
    let restarts = 0;
    (harness.adapter as unknown as { restartBridgeForRetry: () => void }).restartBridgeForRetry = () => {
      restarts++;
    };

    try {
      const response = harness.adapter.call({ op: 'query', sql: 'SELECT 1', mode: 'all', params: [] });

      expect(restarts).toBe(1);
      expect(response.rows).toEqual([{ ok: 1 }]);
    } finally {
      harness.cleanup();
    }
  });

  it('reopens a torn-down bridge on the next call after a fault outside a transaction', () => {
    const harness = makeHarness([{ ok: true, rows: [{ ok: 1 }] }]);
    const internals = harness.adapter as unknown as {
      state: { open: boolean };
      restartBridgeForRetry: () => void;
    };
    // Simulate a prior fault (query timeout / dropped connection) that closed the bridge.
    internals.state.open = false;
    let restarts = 0;
    internals.restartBridgeForRetry = () => {
      restarts++;
      internals.state.open = true; // a real reconnect installs a fresh, open bridge
    };

    try {
      const response = harness.adapter.call({ op: 'query', sql: 'SELECT 1', mode: 'all', params: [] });

      expect(restarts).toBe(1);
      expect(response.rows).toEqual([{ ok: 1 }]);
    } finally {
      harness.cleanup();
    }
  });

  it('stays closed and never reopens after an explicit close', () => {
    const harness = makeHarness([{ ok: true }]);
    const internals = harness.adapter as unknown as { restartBridgeForRetry: () => void };
    let restarts = 0;
    internals.restartBridgeForRetry = () => {
      restarts++;
    };

    try {
      harness.adapter.close();
      expect(() => harness.adapter.call({ op: 'exec', sql: 'SELECT 1' })).toThrow('PostgreSQL connection is closed');
      expect(restarts).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('does not reopen a torn-down bridge while a transaction is unwinding', () => {
    const harness = makeHarness([]);
    const internals = harness.adapter as unknown as {
      state: { open: boolean; txDepth: number };
      restartBridgeForRetry: () => void;
    };
    internals.state.open = false;
    internals.state.txDepth = 1;
    let restarts = 0;
    internals.restartBridgeForRetry = () => {
      restarts++;
    };

    try {
      expect(() => harness.adapter.call({ op: 'exec', sql: 'SELECT 1' })).toThrow('PostgreSQL connection is closed');
      expect(restarts).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  // A transaction-control statement replayed on a fresh connection is a silent
  // no-op that would report a rolled-back transaction as committed — so it must
  // fail, never reconnect. Cover every finalizer AND the query/exec shapes
  // (prepare('COMMIT').run() arrives as op 'query', not 'exec').
  const TX_CONTROL_REQUESTS: ReadonlyArray<{ label: string; request: WorkerRequest }> = [
    { label: 'COMMIT (exec)', request: { op: 'exec', sql: 'COMMIT' } },
    { label: 'ROLLBACK (exec)', request: { op: 'exec', sql: 'ROLLBACK' } },
    { label: 'RELEASE SAVEPOINT (exec)', request: { op: 'exec', sql: 'RELEASE SAVEPOINT cartograph_sp_0' } },
    { label: 'COMMIT (query shape)', request: { op: 'query', sql: 'COMMIT', mode: 'run', params: [] } },
  ];

  for (const { label, request } of TX_CONTROL_REQUESTS) {
    it(`never reopens a torn-down bridge to replay ${label}`, () => {
      const harness = makeHarness([]);
      const internals = harness.adapter as unknown as {
        state: { open: boolean };
        restartBridgeForRetry: () => void;
      };
      internals.state.open = false;
      let restarts = 0;
      internals.restartBridgeForRetry = () => {
        restarts++;
      };

      try {
        expect(() => harness.adapter.call(request)).toThrow('PostgreSQL connection is closed');
        expect(restarts).toBe(0);
      } finally {
        harness.cleanup();
      }
    });

    it(`does not reconnect-and-retry ${label} on a closed-connection worker error`, () => {
      const harness = makeHarness([{ ok: false, error: 'PostgreSQL connection is closed' }]);
      let restarts = 0;
      (harness.adapter as unknown as { restartBridgeForRetry: () => void }).restartBridgeForRetry = () => {
        restarts++;
      };

      try {
        expect(() => harness.adapter.call(request)).toThrow('PostgreSQL connection is closed');
        expect(restarts).toBe(0);
      } finally {
        harness.cleanup();
      }
    });
  }

  it('does not reopen to COMMIT a transaction whose body swallowed a mid-transaction fault', () => {
    // End-to-end through transaction(): a fault flips the bridge closed inside the
    // callback, the callback swallows it, and the finalizing COMMIT must throw
    // (report failure) instead of reopening a fresh connection and no-op-committing.
    const harness = makeHarness([{ ok: true }]); // BEGIN succeeds
    const internals = harness.adapter as unknown as {
      state: { open: boolean };
      restartBridgeForRetry: () => void;
    };
    let restarts = 0;
    internals.restartBridgeForRetry = () => {
      restarts++;
    };

    try {
      expect(() =>
        harness.adapter.transaction(() => {
          internals.state.open = false; // mid-transaction fault tears the bridge down
        })(),
      ).toThrow('PostgreSQL connection is closed');
      expect(restarts).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('reports PostgreSQL schema size instead of whole database size', () => {
    const capturedSql: string[] = [];
    const fakeDb = {
      prepare(sql: string) {
        capturedSql.push(sql);
        return { get: () => ({ n: '4096' }) };
      },
    };

    expect(readPostgresSchemaSizeBytes(fakeDb as never)).toBe(4096);
    expect(capturedSql[0]).toContain('pg_total_relation_size(c.oid)');
    expect(capturedSql[0]).toContain('current_schema()');
    expect(capturedSql[0]).not.toContain('pg_database_size');
  });
});

describe('Postgres worker SQL rewrite', () => {
  it('preserves the matched json_each placeholder when it is not $1', () => {
    const rewritten = rewritePostgresAfterPlaceholders(
      'SELECT * FROM nodes WHERE kind = $1 AND id IN (SELECT value FROM json_each($2)) AND language = $3',
      new Set([2]),
    );

    expect(rewritten).toContain('id IN (SELECT jsonb_array_elements_text($2::jsonb))');
    expect(rewritten).not.toContain('jsonb_array_elements_text($1::jsonb)');
  });

  it('preserves json_each object placeholders and key expressions in integer lookups', () => {
    const rewrittenColumnKey = rewritePostgresAfterPlaceholders(
      [
        'SELECT COALESCE(',
        '  (SELECT CAST(value AS INTEGER) FROM json_each($3) WHERE key = nodes.kind),',
        '  $1',
        ') FROM nodes WHERE language = $2',
      ].join(' '),
      new Set([3]),
    );
    const rewrittenPlaceholderKey = rewritePostgresAfterPlaceholders(
      'SELECT CAST(value AS INTEGER) FROM json_each($5) WHERE key = $4',
      new Set([5]),
    );

    expect(rewrittenColumnKey).toContain('jsonb_each_text($3::jsonb)');
    expect(rewrittenColumnKey).toContain('WHERE key = nodes.kind');
    expect(rewrittenColumnKey).not.toContain('jsonb_each_text($1::jsonb)');
    expect(rewrittenColumnKey).not.toContain('WHERE key = $2');
    expect(rewrittenPlaceholderKey).toContain('jsonb_each_text($5::jsonb)');
    expect(rewrittenPlaceholderKey).toContain('WHERE key = $4');
  });
});

function makeHarness(responses: unknown[], waitMode: WorkerWaitMode = 'normal'): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-postgres-adapter-test-'));
  const requestPath = path.join(dir, 'request.json');
  const responsePath = path.join(dir, 'response.json');
  const control = new Int32Array(new SharedArrayBuffer(INT32_BYTES));
  let terminated = 0;
  const captured: unknown[] = [];
  const adapter = Object.create(PostgresAdapter.prototype) as PostgresAdapter;
  const internals = adapter as unknown as {
    state: {
      worker: { terminate: () => Promise<number> };
      control: Int32Array;
      dir: string;
      requestPath: string;
      responsePath: string;
      queryTimeoutMs: number;
      open: boolean;
      txDepth: number;
      userClosed: boolean;
    };
  };
  internals.state = {
    worker: {
      terminate: () => {
        terminated++;
        return Promise.resolve(TERMINATE_EXIT_CODE);
      },
    },
    control,
    dir,
    requestPath,
    responsePath,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    open: true,
    txDepth: 0,
    userClosed: false,
  };

  vi.spyOn(Atomics, 'wait').mockImplementation((array, index, expected) => {
    if (expected !== WORKER_REQUEST) return 'not-equal';
    if (waitMode === 'timeout') return 'timed-out';
    if (waitMode === 'invalid-state') {
      Atomics.store(array, index, INVALID_WORKER_STATE);
      return 'ok';
    }
    captured.push(parsePostgresWorkerJson(fs.readFileSync(requestPath, 'utf-8'), 'request'));
    fs.writeFileSync(responsePath, JSON.stringify(responses.shift() ?? { ok: true }), 'utf-8');
    Atomics.store(array, index, WORKER_RESPONSE);
    return 'ok';
  });

  return {
    adapter,
    captured,
    terminated: () => terminated,
    bridgeDirExists: () => fs.existsSync(dir),
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
