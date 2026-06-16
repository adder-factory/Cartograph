/**
 * viewerConfigEditAllowed — the gate behind the config editor's write +
 * re-index endpoints. The endpoint-level 403 can't be exercised over the
 * network (a server reachable at 127.0.0.1 is loopback, hence allowed),
 * so the non-loopback decision is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { isLockContentionResult, redactUrlCredentials } from '../src/features/viewer/server/config-routes.js';
import { viewerConfigEditAllowed } from '../src/features/viewer/server/security.js';

describe('viewerConfigEditAllowed', () => {
  it('allows loopback binds by default', () => {
    expect(viewerConfigEditAllowed('127.0.0.1', false)).toBe(true);
    expect(viewerConfigEditAllowed('localhost', false)).toBe(true);
    expect(viewerConfigEditAllowed('::1', false)).toBe(true);
    expect(viewerConfigEditAllowed('[::1]', false)).toBe(true);
  });

  it('disallows non-loopback binds unless explicitly opted in', () => {
    expect(viewerConfigEditAllowed('0.0.0.0', false)).toBe(false);
    expect(viewerConfigEditAllowed('192.168.1.5', false)).toBe(false);
    expect(viewerConfigEditAllowed('example.com', false)).toBe(false);
  });

  it('honors the --allow-config-edit opt-in on any bind', () => {
    expect(viewerConfigEditAllowed('0.0.0.0', true)).toBe(true);
    expect(viewerConfigEditAllowed('example.com', true)).toBe(true);
  });
});

describe('redactUrlCredentials', () => {
  it('masks the password in a postgres connection URL (the GET /api/config leak)', () => {
    expect(redactUrlCredentials('postgres://user:s3cret@db.example.com:5432/cartograph')).toBe(
      'postgres://user:***@db.example.com:5432/cartograph',
    );
  });

  it('masks a password query parameter', () => {
    expect(redactUrlCredentials('postgres://db.example.com/cartograph?sslmode=require&password=s3cret')).toBe(
      'postgres://db.example.com/cartograph?sslmode=require&password=***',
    );
  });

  it('leaves a credential-free URL unchanged', () => {
    expect(redactUrlCredentials('postgres://db.example.com:5432/cartograph')).toBe(
      'postgres://db.example.com:5432/cartograph',
    );
  });
});

describe('isLockContentionResult', () => {
  it('is true only for the lock-acquire sentinel — a genuine index failure reads as an error, not "busy"', () => {
    expect(isLockContentionResult([{ message: 'Could not acquire file lock - another process may be indexing' }])).toBe(
      true,
    );
    expect(isLockContentionResult([{ message: 'parse error in src/foo.ts: unexpected token' }])).toBe(false);
    expect(isLockContentionResult([])).toBe(false);
  });
});
