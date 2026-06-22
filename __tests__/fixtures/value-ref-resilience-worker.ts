/**
 * Test-only worker entry for the B28 v2 / B31 resilience tests in
 * `__tests__/value-ref-edges-pool.test.ts`. Reads `workerData.behavior`
 * and simulates one of the four failure modes the pool's `runOneWorker`
 * is supposed to resolve cleanly. Matches the IPC contract of the real
 * `src/index-hooks/value-ref-edges-worker.ts` (one-shot postMessage,
 * then exit) so the orchestrator's listeners fire the same events.
 *
 *  - `'success'`     — post `{ok: true, edges: []}` then exit(0).
 *  - `'invalid-reply'` — post a malformed success reply, then exit(0).
 *  - `'silent-exit'` — exit(0) WITHOUT posting any message. This is
 *                      the B28 v1 hang trigger: pre-B28-v2 the pool
 *                      had no exit handler, so the iteration's
 *                      `Promise.all` would hang forever. Post-B28 v2
 *                      the pool's `'exit'` handler resolves with an
 *                      error reply.
 *  - `'hang'`        — never post, never exit. Tests the per-worker
 *                      `setTimeout` budget — pool should resolve
 *                      with a "timeout after Nms" error.
 *  - `'throw'`       — throw an unhandled error. The 'error' event
 *                      fires on the parent; pool resolves with the
 *                      error message.
 *
 * Why a dedicated fixture instead of mocking `node:worker_threads`:
 * the bun runtime's Worker class is built on libuv threads not user-
 * space — there's no clean injection seam. Spawning a real Worker
 * with controlled behavior exercises the entire IPC + event-loop
 * path, which is what we want to verify.
 */

import { parentPort, workerData } from 'node:worker_threads';

/** The pool's `runOneWorker` sends `workerData = {dbPath, projectRoot,
 *  fileRecords}` — there's no field for a test "behavior" tag. Rather
 *  than expand the production args type just for tests, we repurpose
 *  the `dbPath` channel: the test passes the behavior string as
 *  `dbPath` and the fixture interprets it here. The fixture never
 *  opens a DB so the field is otherwise unused. */
type Behavior = 'success' | 'invalid-reply' | 'silent-exit' | 'hang' | 'throw';

interface TestWorkerInit {
  readonly dbPath: Behavior;
}

const init = workerData as TestWorkerInit;
const behavior = init.dbPath;

switch (behavior) {
  case 'success': {
    parentPort?.postMessage({ ok: true, edges: [], durationMs: 0 });
    process.exit(0);
    break;
  }
  case 'invalid-reply': {
    parentPort?.postMessage({ ok: true, durationMs: 0 });
    process.exit(0);
    break;
  }
  case 'silent-exit': {
    // The B28 v1 hang trigger: exit cleanly without ever posting a
    // message. Pre-fix, `Promise.all` waited the full HOOK_TIMEOUT_MS
    // (300s) for a message that would never come.
    process.exit(0);
    break;
  }
  case 'hang': {
    // Block forever (well, until the per-worker timeout terminates
    // us). A setInterval keeps the event loop alive — bun's worker
    // shouldn't exit just because the main task returned.
    setInterval(() => undefined, 1_000_000);
    break;
  }
  case 'throw': {
    throw new Error('test worker: deliberate throw');
  }
}
