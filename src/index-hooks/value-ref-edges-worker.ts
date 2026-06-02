/**
 * Value-ref-edges worker — runs the per-file regex scan + per-unique-name
 * symbol lookup over a batch of files on its own bun:sqlite read
 * handle, returns the collected edges to the parent.
 *
 * B28 v2 (2026-05-24) — after B25 (~3000× faster lookup) + B27 (~6× fewer
 * lookups per file), value-ref-edges still ran ~2 min single-threaded
 * on microsoft/TypeScript because the per-file regex + name-set work is
 * genuinely CPU-bound and JS is single-threaded. Sharding files across
 * worker_threads gives true CPU parallelism.
 *
 * Architecture mirrors G9's biomarker-worker.ts: ephemeral one-shot,
 * own DB handle, exit on completion. The persist (edge insert) stays
 * on main since bun:sqlite serializes writes anyway and the
 * single-connection write is simpler.
 *
 * IPC contract:
 *   - Init: `workerData = { dbPath, projectRoot, fileRecords }`.
 *   - On success: `postMessage({ ok: true, edges, durationMs })`.
 *   - On failure: `postMessage({ ok: false, error })`.
 *   - Either way: `process.exit(0)` in `finally` so the host can `await`
 *     the `'exit'` event without leaking handles.
 *
 * B28 v1 (commit `0d0afde`, reverted in `c4c0019`) shipped this worker
 * with a fragile orchestrator: `runOneWorker` had no per-worker timeout,
 * no `settled` flag, and the `'exit'` handler only rejected on non-zero
 * codes — so a worker that exited code 0 without posting a message left
 * `Promise.all` hanging forever, and the whole hook died at the 300s
 * `HOOK_TIMEOUT_MS` with zero edges emitted (correctness regression).
 * v2's orchestrator (`value-ref-edges-pool.ts`) mirrors G9's
 * `runOneRuleInWorker` shape with one deliberate strictness divergence
 * on the `'exit'` handler — see that file's header for the detail.
 * The worker itself (this file) is unchanged in shape from v1.
 */

import { parentPort, threadId, workerData } from 'node:worker_threads';
import {
  CALL_ARG_RE,
  PAIR_VALUE_RE,
  SUPPORTED_VALUE_REF_LANGS,
  collectValueRefMatches,
  type ValueRefEdgeRecord,
} from './value-ref-edge-scan.js';

/** Diagnostic per-file tracing. Off by default — opt in via env var
 *  `CARTOGRAPH_VALUE_REF_VERBOSE=1` (typically only when chasing the
 *  120s per-worker timeout pattern on TS-scale corpora). When enabled,
 *  the worker emits a `[vre w:N]` line on every file enter + on every
 *  file done with per-phase elapsed milliseconds. Console.error is
 *  unbuffered (or close to it) on stderr, so even a SIGTERM-killed
 *  worker leaves the last "enter" line in the captured log — which
 *  is enough to identify which file blocked the worker. */
const VERBOSE = process.env['CARTOGRAPH_VALUE_REF_VERBOSE'] === '1';

interface ValueRefWorkerInit {
  readonly dbPath: string;
  readonly projectRoot: string;
  /** File records with path + language. Pre-filtered by the host to
   *  JS/TS family; the worker re-checks defensively (cheap). */
  readonly fileRecords: ReadonlyArray<{ path: string; language: string }>;
}

interface ValueRefWorkerReplyOk {
  readonly ok: true;
  readonly edges: ValueRefEdgeRecord[];
  readonly durationMs: number;
}

interface ValueRefWorkerReplyError {
  readonly ok: false;
  readonly error: string;
}

export type ValueRefWorkerReply = ValueRefWorkerReplyOk | ValueRefWorkerReplyError;

interface WorkerFileDeps {
  readonly projectRoot: string;
  readonly queries: {
    readonly getSymbolNameIndexByFile: (filePath: string) => ReadonlyMap<string, string>;
  };
  readonly readFileSafe: (filePath: string) => string | null;
  readonly stripJsComments: (content: string) => string;
  readonly joinPath: (...segments: string[]) => string;
  readonly edges: ValueRefEdgeRecord[];
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error('value-ref-edges-worker must run inside a Worker');
  const init = workerData as ValueRefWorkerInit;
  const start = Date.now();
  try {
    // Defer heavy imports until inside main so workerData failures
    // surface as the cleaner "must run inside a Worker" error above.
    // Same shape as biomarker-worker.ts's Promise.all import block.
    const [
      { createDatabase },
      { QueryBuilder },
      { getSymbolNameIndexByFile },
      { readFileSafe },
      { stripJsComments },
      path,
    ] = await Promise.all([
      import('../db/sqlite-adapter.js'),
      import('../db/queries.js'),
      import('../db/queries-search.js'),
      import('../utils.js'),
      import('../resolution/import-resolver.js'),
      import('node:path'),
    ]);

    const { db } = createDatabase(init.dbPath);
    const queries = new QueryBuilder(db);
    const edges: ValueRefEdgeRecord[] = [];

    try {
      const fileDeps: WorkerFileDeps = {
        projectRoot: init.projectRoot,
        queries: {
          getSymbolNameIndexByFile: (filePath) => getSymbolNameIndexByFile(queries, filePath),
        },
        readFileSafe,
        stripJsComments,
        joinPath: path.join,
        edges,
      };
      for (const file of init.fileRecords) {
        collectEdgesFromWorkerFile(file, fileDeps);
      }
      parentPort.postMessage({
        ok: true,
        edges,
        durationMs: Date.now() - start,
      } satisfies ValueRefWorkerReply);
    } finally {
      db.close();
    }
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    } satisfies ValueRefWorkerReply);
  } finally {
    process.exit(0);
  }
}

function collectEdgesFromWorkerFile(file: ValueRefWorkerInit['fileRecords'][number], deps: WorkerFileDeps): void {
  if (!SUPPORTED_VALUE_REF_LANGS.has(file.language)) return;
  const fileT0 = VERBOSE ? Date.now() : 0;
  if (VERBOSE) {
    // Enter line written BEFORE any work — if the worker hangs in any
    // later phase the final enter line names the file.
    console.error(`[vre w:${threadId}] enter ${file.path}`);
  }
  const content = deps.readFileSafe(deps.joinPath(deps.projectRoot, file.path));
  if (!content) return;
  const tAfterRead = VERBOSE ? Date.now() : 0;
  const cleaned = deps.stripJsComments(content);
  const tAfterStrip = VERBOSE ? Date.now() : 0;
  const fileNodeId = `file:${file.path}`;
  const seenNames = new Set<string>();
  const seen = new Set<string>();
  const nameIndex = deps.queries.getSymbolNameIndexByFile(file.path);
  const baseArgs = { cleaned, fileNodeId, seenNames, seen, edges: deps.edges, nameIndex };
  collectValueRefMatches({ ...baseArgs, re: CALL_ARG_RE });
  const tAfterRe1 = VERBOSE ? Date.now() : 0;
  collectValueRefMatches({ ...baseArgs, re: PAIR_VALUE_RE });
  logVerboseFileTiming({ filePath: file.path, content, cleaned, fileT0, tAfterRead, tAfterStrip, tAfterRe1 });
}

interface VerboseFileTimingArgs {
  readonly filePath: string;
  readonly content: string;
  readonly cleaned: string;
  readonly fileT0: number;
  readonly tAfterRead: number;
  readonly tAfterStrip: number;
  readonly tAfterRe1: number;
}

function logVerboseFileTiming(args: VerboseFileTimingArgs): void {
  if (!VERBOSE) return;
  const { filePath, content, cleaned, fileT0, tAfterRead, tAfterStrip, tAfterRe1 } = args;
  const tEnd = Date.now();
  console.error(
    `[vre w:${threadId}] done  ${filePath} ` +
      `bytes=${content.length} cleaned=${cleaned.length} ` +
      `total=${tEnd - fileT0}ms read=${tAfterRead - fileT0}ms ` +
      `strip=${tAfterStrip - tAfterRead}ms re1=${tAfterRe1 - tAfterStrip}ms ` +
      `re2=${tEnd - tAfterRe1}ms`,
  );
}

await main();
