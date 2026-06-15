/**
 * `postgres-codec` — the JSON boundary between the PostgreSQL worker
 * subprocess and the main thread. `parsePostgresWorkerJson` guards the
 * raw decode; `parseWorkerResponse` validates the decoded envelope shape
 * so a crashed/OOM/hung worker can't smuggle a malformed `ok`/`error`
 * past the adapter via an unchecked cast.
 */

import { describe, expect, it } from 'vitest';
import { parsePostgresWorkerJson, parseWorkerResponse } from '../src/db/postgres-codec.js';

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
});
