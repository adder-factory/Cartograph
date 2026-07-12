/**
 * PostgreSQL MCP-daemon reconnect regression (issue #66) — exercised against a
 * real pgvector container (auto-started by `npm run test:postgres`; skipped when
 * no CARTOGRAPH_TEST_POSTGRES_URL is set).
 *
 * Regression: after #58, PostgresAdapter.call() only re-established the worker
 * bridge when a dropped connection surfaced as a worker-response error. A query
 * timeout, a dead worker, or callOnce's own `if (!state.open)` guard instead
 * tear the bridge down with a PLAIN Error, leaving `state.open === false`
 * permanently — so every later call failed immediately with "PostgreSQL
 * connection is closed" and the long-lived MCP server became unusable while
 * fresh CLI processes kept working.
 *
 * These tests drive the REAL adapter (real worker thread, real PostgreSQL) so
 * the reconnect is verified end-to-end, not just the control-flow decision the
 * unit tests in postgres-adapter.test.ts cover.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { PostgresAdapter } from '../src/db/postgres-adapter.js';

const POSTGRES_URL = process.env['CARTOGRAPH_TEST_POSTGRES_URL'];
const describePostgres = POSTGRES_URL ? describe : describe.skip;
const SCHEMA = 'cg_reconnect_test';

/** Adapter internals we poke to model a fault teardown without a live DB restart. */
interface AdapterInternals {
  state: { open: boolean; worker: { terminate: () => Promise<number> } };
}

function makeAdapter(): PostgresAdapter {
  return new PostgresAdapter({
    provider: 'postgres',
    url: POSTGRES_URL!,
    schema: SCHEMA,
    pgvector: 'off',
    maxConnections: 1,
    queryTimeoutMs: 5000,
  });
}

function seed(adapter: PostgresAdapter): void {
  adapter.exec('DROP TABLE IF EXISTS reconnect_probe');
  adapter.exec('CREATE TABLE reconnect_probe (id int primary key, v text)');
  adapter.prepare('INSERT INTO reconnect_probe (id, v) VALUES (?, ?)').run(1, 'hello');
}

function readProbe(adapter: PostgresAdapter): string | undefined {
  return adapter.prepare('SELECT v FROM reconnect_probe WHERE id = ?').get<{ v: string }>(1)?.v;
}

/**
 * Model the exact #66 fault: a query timeout / dead worker tears the bridge
 * down (state.open === false) via a plain Error, WITHOUT flagging an intentional
 * close(). Mirrors closeBridge(): fire-and-forget worker termination + open=false.
 */
function faultTeardown(adapter: PostgresAdapter): void {
  const internals = adapter as unknown as AdapterInternals;
  internals.state.open = false;
  void internals.state.worker.terminate().catch(() => undefined);
}

afterAll(async () => {
  if (!POSTGRES_URL) return;
  const sql = new Bun.SQL(POSTGRES_URL);
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).simple();
  } finally {
    await sql.close();
  }
});

describePostgres('PostgresAdapter reconnect against real PostgreSQL (issue #66)', () => {
  it('re-establishes the bridge on the next call after a non-response fault', () => {
    const adapter = makeAdapter();
    try {
      seed(adapter);
      expect(readProbe(adapter)).toBe('hello');

      faultTeardown(adapter);
      expect(adapter.open).toBe(false);

      // The next call must spin up a fresh worker, reconnect to real PostgreSQL,
      // and return data — pre-#66-fix this threw "PostgreSQL connection is closed".
      expect(readProbe(adapter)).toBe('hello');
      expect(adapter.open).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it('recovers after the backend connection is terminated server-side', async () => {
    const adapter = makeAdapter();
    try {
      seed(adapter);
      expect(readProbe(adapter)).toBe('hello');

      const killer = new Bun.SQL(POSTGRES_URL!);
      try {
        const killSql =
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'cartograph' AND pid <> pg_backend_pid()";
        await killer.unsafe(killSql).simple();
      } finally {
        await killer.close();
      }

      let recovered: string | undefined;
      for (let attempt = 0; attempt < 3 && recovered !== 'hello'; attempt++) {
        try {
          recovered = readProbe(adapter);
        } catch {
          // transient closed-connection error on the first post-kill call; retry
        }
      }
      expect(recovered).toBe('hello');
    } finally {
      adapter.close();
    }
  });

  it('stays closed after an intentional close() and never auto-reopens', () => {
    const adapter = makeAdapter();
    seed(adapter);
    adapter.close();
    expect(() => adapter.prepare('SELECT 1').get()).toThrow('PostgreSQL connection is closed');
  });
});
