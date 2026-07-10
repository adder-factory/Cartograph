/**
 * `postgres-codec` — the JSON boundary between the PostgreSQL worker
 * subprocess and the main thread. `parsePostgresWorkerJson` guards the
 * raw decode; `parseWorkerResponse` validates the decoded envelope shape
 * so a crashed/OOM/hung worker can't smuggle a malformed `ok`/`error`
 * past the adapter via an unchecked cast.
 */

import { describe, expect, it } from 'vitest';
import {
  parsePostgresWorkerInit,
  parsePostgresWorkerJson,
  parseWorkerRequest,
  parseWorkerResponse,
} from '../src/db/postgres-codec.js';

const WORKER_CONTROL_BYTES = 4;
const WORKER_MAX_CONNECTIONS = 1;
const WORKER_CONNECTION_TIMEOUT_SECONDS = 30;
const WORKER_STATEMENT_TIMEOUT_MS = 120_000;

function withObjectPrototypeProperty<T>(key: string, value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: true,
    value,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous);
    else Reflect.deleteProperty(Object.prototype, key);
  }
}

function workerInitPayload() {
  return {
    control: new SharedArrayBuffer(WORKER_CONTROL_BYTES),
    requestPath: '/tmp/cartograph-pg/request.json',
    responsePath: '/tmp/cartograph-pg/response.json',
    sqlOptions: {
      url: 'postgres://cartograph:cartograph@localhost:5432/cartograph',
      adapter: 'postgres',
      max: WORKER_MAX_CONNECTIONS,
      connectionTimeout: WORKER_CONNECTION_TIMEOUT_SECONDS,
      connection: {
        application_name: 'cartograph',
        search_path: 'cartograph, public',
        statement_timeout: WORKER_STATEMENT_TIMEOUT_MS,
      },
      tls: false,
    },
    url: 'postgres://cartograph:cartograph@localhost:5432/cartograph',
    schema: 'cartograph',
  };
}

describe('parsePostgresWorkerJson', () => {
  it('parses valid JSON', () => {
    expect(parsePostgresWorkerJson('{"ok":true}', 'response')).toEqual({ ok: true });
  });

  it('throws a labelled error on malformed JSON', () => {
    expect(() => parsePostgresWorkerJson('not json', 'response')).toThrow(/Invalid PostgreSQL worker response JSON/);
  });
});

describe('parseWorkerResponse', () => {
  it('accepts a well-formed envelope', () => {
    const env = { ok: true, rows: [{ id: 1 }], changes: 0 };
    expect(parseWorkerResponse(env, 'response')).toEqual(env);
  });

  it('accepts a decoded bigint lastInsertRowid', () => {
    // `decodeValue` turns the `__cartographBigInt` marker into a real
    // bigint before validation, so the schema must allow number | bigint.
    const env = { ok: true, lastInsertRowid: 10n };
    expect(parseWorkerResponse(env, 'response')).toEqual(env);
  });

  it('throws when `ok` is the wrong type (worker corruption)', () => {
    expect(() => parseWorkerResponse({ ok: 'yes' }, 'response')).toThrow(/Invalid PostgreSQL worker response envelope/);
  });

  it('throws when the envelope is null (crashed worker)', () => {
    expect(() => parseWorkerResponse(null, 'response')).toThrow(/Invalid PostgreSQL worker response envelope/);
  });

  it('throws when `rows` is present but not an array', () => {
    expect(() => parseWorkerResponse({ ok: true, rows: 'oops' }, 'response')).toThrow(
      /Invalid PostgreSQL worker response envelope/,
    );
  });

  it('rejects inherited response discriminator fields', () => {
    withObjectPrototypeProperty('ok', true, () => {
      expect(() => parseWorkerResponse({}, 'response')).toThrow(/Invalid PostgreSQL worker response envelope/);
    });
  });

  it('uses own response discriminator fields over polluted prototype fields', () => {
    withObjectPrototypeProperty('ok', false, () => {
      expect(parseWorkerResponse({ ok: true }, 'response')).toEqual({ ok: true });
    });
  });
});

describe('parseWorkerRequest', () => {
  it('accepts a well-formed query request', () => {
    const request = { op: 'query', sql: 'SELECT ?', mode: 'all', params: [1], readOnly: true };
    expect(parseWorkerRequest(request, 'request')).toEqual(request);
  });

  it('accepts a batch request with parameter sets', () => {
    const request = { op: 'batch', sql: 'INSERT INTO nodes VALUES (?)', mode: 'run', paramSets: [[{ id: 'n1' }]] };
    expect(parseWorkerRequest(request, 'request')).toEqual(request);
  });

  it('throws when op is missing', () => {
    expect(() => parseWorkerRequest({ sql: 'SELECT 1' }, 'request')).toThrow(
      /Invalid PostgreSQL worker request envelope/,
    );
  });

  it('throws when params is not an array', () => {
    expect(() => parseWorkerRequest({ op: 'query', sql: 'SELECT 1', params: 'oops' }, 'request')).toThrow(
      /Invalid PostgreSQL worker request envelope/,
    );
  });

  it('throws when extra keys are present', () => {
    expect(() => parseWorkerRequest({ op: 'close', unexpected: true }, 'request')).toThrow(
      /Invalid PostgreSQL worker request envelope/,
    );
  });

  it('rejects inherited request discriminator fields', () => {
    withObjectPrototypeProperty('op', 'close', () => {
      expect(() => parseWorkerRequest({}, 'request')).toThrow(/Invalid PostgreSQL worker request envelope/);
    });
  });

  it('uses own request discriminator fields over polluted prototype fields', () => {
    withObjectPrototypeProperty('op', 'close', () => {
      expect(parseWorkerRequest({ op: 'query', sql: 'SELECT 1', mode: 'get' }, 'request')).toEqual({
        op: 'query',
        sql: 'SELECT 1',
        mode: 'get',
      });
    });
  });
});

describe('parsePostgresWorkerInit', () => {
  it('accepts the adapter-built workerData payload', () => {
    const init = workerInitPayload();

    expect(parsePostgresWorkerInit(init, 'init')).toEqual(init);
  });

  it('rejects malformed workerData before opening a database connection', () => {
    const init = {
      ...workerInitPayload(),
      control: new ArrayBuffer(WORKER_CONTROL_BYTES),
    };

    expect(() => parsePostgresWorkerInit(init, 'init')).toThrow(/Invalid PostgreSQL worker init envelope/);
  });

  it('rejects unexpected SQL option keys at the worker boundary', () => {
    const init = {
      ...workerInitPayload(),
      sqlOptions: {
        ...workerInitPayload().sqlOptions,
        unexpected: true,
      },
    };

    expect(() => parsePostgresWorkerInit(init, 'init')).toThrow(/Invalid PostgreSQL worker init envelope/);
  });
});
