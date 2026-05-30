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

/** Diagnostic per-file tracing. Off by default — opt in via env var
 *  `CARTOGRAPH_VALUE_REF_VERBOSE=1` (typically only when chasing the
 *  120s per-worker timeout pattern on TS-scale corpora). When enabled,
 *  the worker emits a `[vre w:N]` line on every file enter + on every
 *  file done with per-phase elapsed milliseconds. Console.error is
 *  unbuffered (or close to it) on stderr, so even a SIGTERM-killed
 *  worker leaves the last "enter" line in the captured log — which
 *  is enough to identify which file blocked the worker. */
const VERBOSE = process.env['CARTOGRAPH_VALUE_REF_VERBOSE'] === '1';

export interface ValueRefEdgeRecord {
  source: string;
  target: string;
  kind: 'references';
}

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
      for (const file of init.fileRecords) {
        if (!SUPPORTED_LANGS.has(file.language)) continue;
        const fileT0 = VERBOSE ? Date.now() : 0;
        if (VERBOSE) {
          // Enter line written BEFORE any work — if the worker hangs
          // in any subsequent phase the last enter line names the file
          // even after SIGTERM. Phases: read, strip, regex1, regex2.
          console.error(`[vre w:${threadId}] enter ${file.path}`);
        }
        const content = readFileSafe(path.join(init.projectRoot, file.path));
        if (!content) continue;
        const tAfterRead = VERBOSE ? Date.now() : 0;
        const cleaned = stripJsComments(content);
        const tAfterStrip = VERBOSE ? Date.now() : 0;
        const fileNodeId = `file:${file.path}`;
        const seenNames = new Set<string>();
        // `seen` mirrors the main-thread `collectEdgesFromFile` shape:
        // target-id-level dedup catches the rare cross-name-collision
        // case where two different name-strings (e.g. a re-export alias)
        // resolve to the same target id. `insertEdges` is idempotent via
        // UNIQUE constraint either way, but keeping the dedup here
        // means the two paths emit byte-identical edge sets.
        const seen = new Set<string>();
        // B37 (2026-05-25) — pre-fetch the file's name → id index in
        // one DB call so the per-match lookups inside the regex
        // passes are in-memory Map.get(). Replaces ~30 per-name
        // `getNodesByNameAndFile` calls per file. 30× fewer DB calls
        // on TS-scale corpora; ~63s → ~few-second hook wall.
        const nameIndex = getSymbolNameIndexByFile(queries, file.path);
        const baseArgs = {
          cleaned,
          fileNodeId,
          seenNames,
          seen,
          edges,
          nameIndex,
        };
        collectMatches({ ...baseArgs, re: CALL_ARG_RE });
        const tAfterRe1 = VERBOSE ? Date.now() : 0;
        collectMatches({ ...baseArgs, re: PAIR_VALUE_RE });
        if (VERBOSE) {
          const tEnd = Date.now();
          console.error(
            `[vre w:${threadId}] done  ${file.path} ` +
              `bytes=${content.length} cleaned=${cleaned.length} ` +
              `total=${tEnd - fileT0}ms read=${tAfterRead - fileT0}ms ` +
              `strip=${tAfterStrip - tAfterRead}ms re1=${tAfterRe1 - tAfterStrip}ms ` +
              `re2=${tEnd - tAfterRe1}ms`,
          );
        }
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

/** Args bundle for {@link collectMatches}. Mirrors the main-thread
 *  path's `CollectMatchesArgs` shape — `*Args` bundle is the codebase
 *  pattern for helpers that would otherwise trip `long_parameter_list`
 *  (≥7 params is the error tier). */
interface WorkerCollectMatchesArgs {
  cleaned: string;
  re: RegExp;
  fileNodeId: string;
  seenNames: Set<string>;
  /** Target-id-level dedup keyed by `${fileNodeId}->${targetId}`. Catches
   *  the rare case where two different name-strings resolve to the same
   *  target id (e.g. re-export aliases). Mirrors the main path. */
  seen: Set<string>;
  edges: ValueRefEdgeRecord[];
  /** B37 (2026-05-25) — per-file `name → id` map fetched once before
   *  the regex passes. Replaces the per-name `getNodesByNameAndFile`
   *  DB call with an in-memory Map.get(). Mirrors the main path. */
  nameIndex: ReadonlyMap<string, string>;
}

/** Mirrors `collectMatches` in `value-ref-edges.ts` — kept in lockstep
 *  with the main-thread fallback path. The B27 name-dedup is preserved
 *  here so per-worker DB calls stay at "per unique identifier per file"
 *  not "per regex match". */
function collectMatches(args: WorkerCollectMatchesArgs): void {
  const { cleaned, re, fileNodeId, seenNames, seen, edges, nameIndex } = args;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1];
    if (!name || JS_RESERVED_HEAD.has(name)) continue;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const targetId = nameIndex.get(name);
    if (!targetId) continue;
    const key = `${fileNodeId}->${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: fileNodeId, target: targetId, kind: 'references' });
  }
}

// Mirrors the main-thread constants so the worker stays self-contained.
// Keep in lockstep with `value-ref-edges.ts` — a divergence here ships
// silent extraction drift between the in-main and worker paths. See
// the bounded-lookbehind rationale in value-ref-edges.ts (MAX_WS_RUN
// comment) for why these regexes cap whitespace runs at {0,200}.
const SUPPORTED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);
const MAX_WS_RUN = 200;
const WS = String.raw`\s{0,${MAX_WS_RUN}}`;
const CALL_ARG_RE = new RegExp(`(?<=[(,]${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,)])`, 'g');
const PAIR_VALUE_RE = new RegExp(
  `(?<=[{,]${WS}[a-zA-Z_$][a-zA-Z_$0-9]{0,${MAX_WS_RUN}}${WS}:${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,}])`,
  'g',
);
const JS_RESERVED_HEAD: ReadonlySet<string> = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'typeof',
  'await',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'instanceof',
  'yield',
  'throw',
  'function',
  'class',
  'extends',
  'implements',
  'static',
  'async',
  'super',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'import',
  'export',
  'from',
  'as',
  'default',
  'const',
  'let',
  'var',
  'do',
  'else',
  'finally',
  'try',
  'with',
  'break',
  'continue',
  'case',
]);

void main();
