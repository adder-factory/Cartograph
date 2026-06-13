/**
 * DB write-contention robustness (issues #15/#16).
 *
 * A long `admin summarize`/`embed`/`classify` pass used to abort fatally on
 * a single transient "database is locked" when the MCP auto-sync watcher
 * committed concurrently: the persist transaction was a DEFERRED
 * read-then-write, so a commit between its read-snapshot and write-upgrade
 * raised SQLITE_BUSY_SNAPSHOT — which `busy_timeout` does NOT cover — and
 * there was no busy-retry and no per-item isolation.
 *
 * The fix: write transactions now use BEGIN IMMEDIATE (the adapter's
 * `transaction()` calls `db.transaction(fn).immediate`), the per-item
 * persists retry on transient busy (`withSqliteBusyRetry`), and a residual
 * failure is isolated per item rather than aborting the pass.
 *
 * These tests pin the two mechanisms the fix relies on:
 *  1. the SQLITE_BUSY detector + retry helper behave correctly, and
 *  2. a DEFERRED read-then-write really does fail under a concurrent commit,
 *     while BEGIN IMMEDIATE takes the write lock up front so it can't.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSqliteBusyError, withSqliteBusyRetry } from '../src/utils-concurrency.js';

describe('isSqliteBusyError', () => {
  it('detects busy/locked codes and message forms, rejects other errors', () => {
    expect(isSqliteBusyError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isSqliteBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('database table is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('attempt to write a readonly database'))).toBe(false);
    expect(isSqliteBusyError(new Error('no such table: t'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });
});

describe('withSqliteBusyRetry', () => {
  it('returns the value on first success (no retry)', () => {
    let calls = 0;
    const r = withSqliteBusyRetry(() => {
      calls++;
      return 42;
    });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries a transient busy then succeeds', () => {
    let calls = 0;
    const r = withSqliteBusyRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error('database is locked');
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up and rethrows after maxRetries on persistent busy', () => {
    let calls = 0;
    expect(() =>
      withSqliteBusyRetry(
        () => {
          calls++;
          throw new Error('SQLITE_BUSY: database is locked');
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).toThrow(/SQLITE_BUSY/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it('rethrows a non-busy error immediately without retrying', () => {
    let calls = 0;
    expect(() =>
      withSqliteBusyRetry(
        () => {
          calls++;
          throw new Error('boom');
        },
        { baseDelayMs: 1 },
      ),
    ).toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('deferred read-then-write vs BEGIN IMMEDIATE (the #15/#16 mechanism)', () => {
  const files: string[] = [];
  function tmpDb(): string {
    const p = path.join(os.tmpdir(), `cg-contention-${process.pid}-${files.length}.db`);
    files.push(p);
    return p;
  }
  afterEach(() => {
    for (const f of files) {
      for (const ext of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(f + ext);
        } catch {
          // already gone
        }
      }
    }
    files.length = 0;
  });

  it('a DEFERRED read-then-write fails when a second connection commits in between', () => {
    const file = tmpDb();
    const a = new Database(file);
    a.exec('PRAGMA journal_mode=WAL');
    a.exec('PRAGMA busy_timeout=200');
    a.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v)');
    a.exec('INSERT INTO t VALUES (1, 0)');
    const b = new Database(file);
    b.exec('PRAGMA busy_timeout=200');

    a.exec('BEGIN'); // DEFERRED — no write lock yet
    a.query('SELECT v FROM t WHERE id = 1').get(); // pins a read snapshot
    b.query('INSERT INTO t VALUES (2, 1)').run(); // concurrent commit advances the WAL

    let caught: unknown;
    try {
      a.query('UPDATE t SET v = 9 WHERE id = 1').run(); // read→write upgrade on a stale snapshot
    } catch (err) {
      caught = err;
    }
    try {
      a.exec('ROLLBACK');
    } catch {
      // transaction may already be aborted
    }
    a.close();
    b.close();

    expect(caught).toBeDefined();
    expect(isSqliteBusyError(caught)).toBe(true); // busy_timeout can't rescue this
  });

  it('BEGIN IMMEDIATE takes the write lock up front, so no snapshot can be invalidated', () => {
    const file = tmpDb();
    const a = new Database(file);
    a.exec('PRAGMA journal_mode=WAL');
    a.exec('PRAGMA busy_timeout=200');
    a.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v)');
    a.exec('INSERT INTO t VALUES (1, 0)');
    const b = new Database(file);
    b.exec('PRAGMA busy_timeout=50'); // short so the contention probe returns fast

    // What the adapter now does for every write transaction:
    // `db.transaction(fn).immediate` — BEGIN IMMEDIATE acquires the write
    // lock at the start, so the read-then-write below can't be invalidated.
    const txn = a.transaction(() => {
      a.query('SELECT v FROM t WHERE id = 1').get(); // read INSIDE the immediate txn
      // A already holds the write lock, so B cannot commit here:
      let bBlocked = false;
      try {
        b.query('INSERT INTO t VALUES (2, 1)').run();
      } catch (err) {
        bBlocked = isSqliteBusyError(err);
      }
      expect(bBlocked).toBe(true); // confirms A took the write lock up front
      a.query('UPDATE t SET v = 9 WHERE id = 1').run(); // succeeds — no BUSY_SNAPSHOT
    });

    expect(() => (txn as unknown as { immediate: () => void }).immediate()).not.toThrow();
    expect(a.query('SELECT v FROM t WHERE id = 1').get()).toEqual({ v: 9 });
    a.close();
    b.close();
  });
});
