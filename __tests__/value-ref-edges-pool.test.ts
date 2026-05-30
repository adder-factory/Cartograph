/**
 * B31 (2026-05-24) — resilience-path tests for the B28 v2 value-ref-edges
 * worker pool (`src/index-hooks/value-ref-edges-pool.ts`).
 *
 * Substitutes a controllable fixture worker
 * (`__tests__/fixtures/value-ref-resilience-worker.ts`) into the pool's
 * `runOneWorker` so the four resilience paths can be exercised in
 * isolation — without the cost of indexing a real codebase or the
 * indirection of going through `buildValueRefEdgesInWorkers`.
 *
 * Each test must complete in well under the per-worker timeout so a
 * hang surfaces as a Jest/bun timeout (test-runner-level), not as the
 * 60s+ pool-internal timeout swallowing the failure.
 *
 * Same structural pattern (settled flag + timeout + exit handler) is
 * used by B29's `runOneIteration` in `src/centrality/pagerank-parallel.ts`
 * — kept tested indirectly via these tests + the live PageRank bench
 * since both pools mirror G9's `runOneRuleInWorker` shape exactly.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runOneWorker } from '../src/index-hooks/value-ref-edges-pool.js';

const FIXTURE_WORKER = fileURLToPath(new URL('./fixtures/value-ref-resilience-worker.ts', import.meta.url));

/** Build a `RunOneWorkerArgs` shape — the fixture worker ignores the
 *  db/file fields entirely, so any placeholder values are fine. The
 *  `workerData.behavior` (set via the URL query) drives the fixture's
 *  switch.
 *
 *  Bun's `node:worker_threads.Worker` accepts arbitrary `workerData`,
 *  so we pass the behavior through that. The pool's `runOneWorker`
 *  populates `workerData.dbPath / projectRoot / fileRecords` but does
 *  NOT forward a `behavior` field — so we hack it via a custom
 *  worker-path query and a tiny override below. */
function makeArgs(behavior: string, timeoutMs: number) {
  return {
    // We piggy-back the behavior on `dbPath` so the fixture worker can
    // read it from its workerData WITHOUT modifying the pool's args
    // shape. The fixture ignores dbPath entirely.
    workerPath: FIXTURE_WORKER,
    dbPath: behavior, // see comment above — repurposed channel
    projectRoot: '/tmp',
    fileRecords: [{ path: 'a.ts', language: 'typescript' }],
    timeoutMs,
    sliceLabel: '#0/1',
  };
}

describe('B28 v2 / B31 — value-ref-edges-pool resilience paths', () => {
  it('resolves with ok:true reply when worker posts a normal message', async () => {
    const reply = await runOneWorker(makeArgs('success', 5_000));
    expect(reply.ok).toBe(true);
  });

  it('resolves with ok:false + timeout error when worker hangs (does NOT hang Promise.all)', async () => {
    const start = Date.now();
    const reply = await runOneWorker(makeArgs('hang', 300));
    const elapsed = Date.now() - start;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toMatch(/timeout after 300ms/);
    // The B28 v1 hang would have waited HOOK_TIMEOUT_MS (300s) here.
    // Bound the assertion at 5s to catch any regression where the
    // timeout fails to fire.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it("resolves with ok:false + 'exited before posting' when worker silently exits (B28 v1 hang trigger)", async () => {
    const start = Date.now();
    const reply = await runOneWorker(makeArgs('silent-exit', 5_000));
    const elapsed = Date.now() - start;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toMatch(/exited with code 0.*before posting/);
    // Must resolve via the 'exit' handler, NOT the timeout — i.e.
    // significantly faster than 5_000ms. This is the load-bearing
    // assertion that distinguishes "exit handler works" from "timeout
    // fired".
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("resolves with ok:false + 'error' message when worker throws (per-worker 'error' event path)", async () => {
    const reply = await runOneWorker(makeArgs('throw', 5_000));
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toMatch(/error after.*deliberate throw/);
  }, 10_000);
});
