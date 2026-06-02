/**
 * Biomarker rule worker — runs ONE cross-file rule against its own
 * read-only `bun:sqlite` connection and posts the resulting findings
 * back to the parent.
 *
 * Spawned from {@link './worker-pool.ts'} (G9 Phase 2C). Each worker
 * is ephemeral — it opens its own DB connection on init, runs a
 * single rule, posts its findings, and exits. Per-worker cold start
 * is ~50–200 ms (TS module load + bun:sqlite handle + sqlite-vec
 * load); on the cartograph repo a single biomarker rule pass costs
 * 50–500 ms, so even with the per-worker spawn cost the 6 rules
 * running concurrently beat the serial loop comfortably.
 *
 * Why an EPHEMERAL one-shot instead of a persistent pool: the host
 * process (the index-hook child) is forked per sync today, so any
 * "warm" worker state would die with the host anyway. A persistent
 * pool only pays off when the host outlives many syncs, which would
 * be a separate architectural change.
 *
 * IPC contract:
 *   - Init via `workerData = { dbPath, projectRoot, ruleKind }`.
 *   - On success: `postMessage({ ok: true, ruleKind, findings })`.
 *   - On failure: `postMessage({ ok: false, ruleKind, error })`.
 *   - The worker then `process.exit(0)` so the host can `await` the
 *     `'exit'` event without leaking handles.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { CrossFileBiomarkerName, Finding } from './types.js';

interface BiomarkerWorkerInit {
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly ruleKind: CrossFileBiomarkerName;
}

interface BiomarkerWorkerReplyOk {
  readonly ok: true;
  readonly ruleKind: CrossFileBiomarkerName;
  readonly findings: Finding[];
  readonly durationMs: number;
}

interface BiomarkerWorkerReplyError {
  readonly ok: false;
  readonly ruleKind: CrossFileBiomarkerName;
  readonly error: string;
}

export type BiomarkerWorkerReply = BiomarkerWorkerReplyOk | BiomarkerWorkerReplyError;

async function main(): Promise<void> {
  if (!parentPort) throw new Error('biomarker-worker must run inside a Worker');
  const init = workerData as BiomarkerWorkerInit;
  const start = Date.now();
  try {
    // Defer heavy imports until inside main so workerData failures
    // surface as the cleaner "must run inside a Worker" error above.
    const [{ createDatabase }, { QueryBuilder }, { CROSS_FILE_RULES }] = await Promise.all([
      import('../db/sqlite-adapter.js'),
      import('../db/queries.js'),
      import('./index.js'),
    ]);
    const rule = CROSS_FILE_RULES.find((r) => r.kind === init.ruleKind);
    if (!rule) {
      parentPort.postMessage({
        ok: false,
        ruleKind: init.ruleKind,
        error: `Unknown cross-file rule kind: ${init.ruleKind}`,
      } satisfies BiomarkerWorkerReply);
      process.exit(0);
    }

    // Own DB connection — bun:sqlite + sqlite-vec are loaded once per
    // process so the per-worker open is independent of every other
    // worker's open. SQLite in WAL mode (cartograph's default) allows
    // any number of concurrent readers alongside the host's connection.
    const { db } = createDatabase(init.dbPath);
    const queries = new QueryBuilder(db);
    try {
      const findings = rule.produce(queries, init.projectRoot);
      parentPort.postMessage({
        ok: true,
        ruleKind: init.ruleKind,
        findings,
        durationMs: Date.now() - start,
      } satisfies BiomarkerWorkerReply);
    } finally {
      db.close();
    }
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      ruleKind: init.ruleKind,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    } satisfies BiomarkerWorkerReply);
  } finally {
    process.exit(0);
  }
}

await main();
