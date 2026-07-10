import { describe, it, expect } from 'vitest';
import {
  isLockContentionResult,
  redactDatabase,
  redactUrlCredentials,
} from '../src/features/viewer/server/config-routes.js';
import { normalizeViewerBindHost } from '../src/features/viewer/server/security.js';

describe('normalizeViewerBindHost', () => {
  it('normalizes valid IPv4, IPv6, and named loopback binds', () => {
    expect(normalizeViewerBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeViewerBindHost('127.42.8.9')).toBe('127.42.8.9');
    expect(normalizeViewerBindHost('LOCALHOST')).toBe('localhost');
    expect(normalizeViewerBindHost('::1')).toBe('::1');
    expect(normalizeViewerBindHost('[::1]')).toBe('::1');
  });

  it('rejects wildcard, LAN, public, malformed, and DNS-name binds', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '8.8.8.8', '127.999.1.1', 'example.com', '']) {
      expect(() => normalizeViewerBindHost(host)).toThrow('Viewer host must be a loopback address');
    }
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

describe('redactDatabase', () => {
  it('allowlists known fields and drops loose secret-bearing keys', () => {
    // The database config schema is `.loose()`, so extra keys reach here at
    // runtime even though the type doesn't model them — simulate that.
    const out = redactDatabase({
      provider: 'postgres',
      url: 'postgres://u:s3cret@h:5432/db',
      schema: 'app',
      pgvector: 'auto',
      password: 's3cret',
      apiKey: 'k-123',
    } as unknown as Parameters<typeof redactDatabase>[0]) as Record<string, unknown>;
    expect(out).toEqual({
      provider: 'postgres',
      url: 'postgres://u:***@h:5432/db',
      schema: 'app',
      pgvector: 'auto',
    });
    expect(out['password']).toBeUndefined();
    expect(out['apiKey']).toBeUndefined();
  });

  it('returns null when there is no database block', () => {
    expect(redactDatabase(undefined)).toBeNull();
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
