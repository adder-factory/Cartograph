/**
 * Companion worker for G20 probe-worker-db-init.mts. Times the
 * import-and-open cost of bun:sqlite + sqlite-vec inside a worker
 * thread.
 *
 * Layout matches the real value-ref-edges-worker.ts and
 * per-file-worker.ts: dynamic import block, then createDatabase, then
 * close + exit. The single difference is no actual work between open
 * and close — we want to isolate init cost from work cost.
 */

import { parentPort, workerData } from 'node:worker_threads';

async function main(): Promise<void> {
  if (!parentPort) throw new Error('probe-worker-db-init-worker must run inside a Worker');
  const init = workerData as { dbPath: string; workerId: number };
  const total = Date.now();

  const startImports = Date.now();
  const { createDatabase } = await import('../src/db/sqlite-adapter.js');
  const importsMs = Date.now() - startImports;

  const startOpen = Date.now();
  const { db, vecLoaded } = createDatabase(init.dbPath);
  const dbOpenMs = Date.now() - startOpen;
  db.close();

  parentPort.postMessage({
    workerId: init.workerId,
    importsMs,
    dbOpenMs,
    vecLoaded,
    totalMs: Date.now() - total,
  });
  process.exit(0);
}

void main();
