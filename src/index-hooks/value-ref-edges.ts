/**
 * Value-ref edges hook — emits `references` edges for bare-identifier
 * usages in NON-CALL positions: callback-property-value and
 * call-argument-as-identifier patterns.
 *
 * Tree-sitter's structural extraction only emits `calls` /
 * `instantiates` for `foo()` / `new Foo()`. An identifier in non-call
 * position (a function passed as a value) produces no edge at all, so
 * the dead-code rule and the `unused_export` biomarker mistakenly
 * flag these as unused. Handoff #7 surfaced the bug class:
 *
 *   `{ lineMatches: lineHasBuildContextHint }`
 *   `z.string().refine(isSafeRegex, { error: '...' })`
 *   `applyMixin(MyClass)`
 *
 * Both patterns are common in TS/JS — `Array.prototype.map(fn)` /
 * `.refine(fn)` / `.transform(fn)` / `.parse(fn)` / `{ key: fn }`
 * couldn't be ignored by the dead-code judge any longer.
 *
 * The 2026-06-11 dead-code audit (~98% false positives on a JSX-heavy
 * app) added three more shapes the structural pass can't see:
 *
 *   `<form onSubmit={submit}>`            — JSX attribute callback
 *   `(pretty ? renderA : renderB)(value)` — invoked-ternary callee
 *   `new Map([['save', doSave]])`         — array-element refs
 *                                            (dispatch tables / step lists)
 *
 * Approach mirrors `re-export-edges` and `dynamic-import-edges`: a
 * regex pass over the stripped source, lookup the identifier against
 * symbols defined in the same file, and emit a `references` edge from
 * the file node to the target symbol. The graph already counts
 * `references` edges as use-evidence (see `findDeadCode` in
 * `src/graph/queries.ts` and the `unused_export` rule), so no
 * downstream consumer changes are required.
 *
 * Cross-file resolution is deliberately out of scope: importing the
 * identifier already produces an `imports` edge during extraction, so
 * cross-file callback usage is already covered. This hook fills the
 * same-file gap.
 *
 * **Known limitations** (shared with the rest of the edge-hook
 * framework — `re-export-edges`, `dynamic-import-edges`):
 *
 *   - String literals are NOT stripped by `stripJsComments`, so a
 *     comment-free mention of `refine(isSafeRegex)` inside a string
 *     literal will emit a false-positive edge. The consequence is
 *     conservative — a live function looks slightly MORE alive, never
 *     spuriously dead — so the dead-code rule's correctness is
 *     preserved either way.
 *
 *   - Array destructuring (`const [myFn, b] = xs`) matches the
 *     array-element pass, so a destructured binding that shadows a
 *     same-file function name emits a spurious edge. Same conservative
 *     direction as the string-literal caveat.
 *
 *   - Stale edges are NOT cleared when a usage is removed in-place:
 *     `refreshEdgesHook` only INSERTs (idempotent via the UNIQUE
 *     constraint), and cascade-delete only fires when the source /
 *     target node disappears. A symbol that lost its only callback
 *     usage but is otherwise unchanged keeps its `references` edge
 *     until the next full `cartograph admin index`. Accepted because
 *     the alternative (DELETE+INSERT per sync) doubles the hook's
 *     SQL cost for a corner-case correctness win.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { minerFileText } from './file-text-cache.js';
import type { SyncResult } from '../extraction/index.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { getDatabasePath } from '../db/index.js';
import {
  type FileTarget,
  refreshEdgesHook,
  PER_FILE_YIELD_INTERVAL,
  yieldToEventLoop,
} from './edge-resolution-helpers.js';
import { getSymbolNameIndexByFile } from '../db/queries-search.js';
import { buildValueRefEdgesInWorkers, shouldUseValueRefWorkers } from './value-ref-edges-pool.js';
import {
  CALL_ARG_RE,
  INVOKED_TERNARY_RE,
  JSX_ATTR_VALUE_RE,
  PAIR_VALUE_RE,
  SUPPORTED_VALUE_REF_LANGS,
  collectValueRefMatches,
} from './value-ref-edge-scan.js';
import type { ValueRefEdgeRecord } from './value-ref-edges-contract.js';

/** Algo-version SHA derived from this file's source. A change to the
 *  scanning regexes / keyword filter / resolution-gate behaviour
 *  invalidates the stored last-mined version, triggering a one-shot
 *  full re-mine on the next afterSync — so existing projects auto-
 *  activate the hook without a manual `cartograph admin index`. Mirrors
 *  STRING_IMPORTS_ALGO_VERSION / BUILD_CONTEXT_REFS_ALGO_VERSION. */
export const VALUE_REF_EDGES_ALGO_VERSION = computeAlgoHash('src/index-hooks/value-ref-edges.ts', [
  './value-ref-edges',
  // The regexes + match loop live in the scan module — a pattern change
  // there must re-mine existing projects exactly like a change here.
  './value-ref-edge-scan',
]);
const LAST_MINED_KEY = 'last_mined_value_ref_edges_algo_version';

type ValueRefEdge = ValueRefEdgeRecord;

async function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] },
): Promise<void> {
  // Pessimistic default — only mark the run complete when we know the
  // worker pool didn't drop any shards. `refreshEdgesHook` SWALLOWS any
  // error thrown by `buildEdges` (see `edge-resolution-helpers.ts:120`),
  // so a catastrophic upstream failure (DB open, worker spawn, etc.)
  // also leaves this `true` and the stamp gets skipped — exactly what
  // we want. Captured in a closure so we can read it after
  // `refreshEdgesHook` returns; the shared helper's contract doesn't
  // propagate the flag.
  let isPartial = true;
  const buildEdges = async (hookCtx: IndexHookContext, files: FileTarget[]): Promise<ValueRefEdge[]> => {
    const result = await buildValueRefEdges(hookCtx, files);
    isPartial = result.isPartial;
    return result.edges;
  };
  await refreshEdgesHook({ ctx, options, hookName: 'value-ref-edges', buildEdges });
  // 2026-05-24 partial-data fix — when any worker failed, the survivor
  // edges in the DB are a strict subset of the full project's value-
  // refs. Stamping LAST_MINED_KEY here would convince the next sync's
  // self-heal that mining is complete, leaving the dropped edges
  // silently missing until a manual `admin index --force`. Skip the
  // stamp on partial; the next sync's algo-version mismatch path will
  // force a full re-mine. (Algo-version itself is unchanged — we only
  // suppress the stamp, not the value.)
  if (isPartial) {
    logDebug('value-ref-edges: partial result; skipping algo-version stamp so next sync re-mines');
    return;
  }
  // Stamp the algo version after a CLEAN run so the next sync knows
  // the stored edges are up to date. Errors are swallowed — a write
  // failure shouldn't abort the whole indexAll.
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, VALUE_REF_EDGES_ALGO_VERSION);
  } catch (err) {
    logDebug(`value-ref-edges stamp failed: ${errMsg(err)}`);
  }
}

interface BuildResult {
  readonly edges: ValueRefEdge[];
  readonly isPartial: boolean;
}

async function buildValueRefEdges(ctx: IndexHookContext, files: FileTarget[]): Promise<BuildResult> {
  // B28 v2 (2026-05-24) — fan out to worker_threads on large file
  // batches. The per-file regex + per-unique-name lookup is genuinely
  // CPU-bound (post-B25 + B27) and JS is single-threaded; sharding
  // across `os.cpus()-1` workers gives true parallelism. Each worker
  // opens its own bun:sqlite read handle (WAL allows concurrent
  // readers). Below `VALUE_REF_WORKER_FILE_THRESHOLD` the in-main
  // path beats the worker-spawn overhead. See
  // `./value-ref-edges-pool.ts` for the G9-shape resilience details.
  if (ctx.db.getBackend() === 'bun-sqlite' && shouldUseValueRefWorkers(files.length)) {
    const dbPath = getDatabasePath(ctx.projectRoot);
    const poolResult = await buildValueRefEdgesInWorkers({
      dbPath,
      projectRoot: ctx.projectRoot,
      files: files.map((f) => ({ path: f.path, language: f.language })),
    });
    return poolResult;
  }

  const edges: ValueRefEdge[] = [];
  let processed = 0;
  for (const file of files) {
    if (!SUPPORTED_VALUE_REF_LANGS.has(file.language)) continue;
    const { cleaned } = minerFileText(ctx.projectRoot, file.path);
    if (!cleaned) continue;
    collectEdgesFromFile({ ctx, filePath: file.path, cleaned, edges });
    // B24 (2026-05-24) — cooperative yield every PER_FILE_YIELD_INTERVAL
    // files so peer Group B hooks dispatched via `Promise.all` actually
    // interleave. Without yields this sync loop starves the others.
    if (++processed % PER_FILE_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return { edges, isPartial: false };
}

/** Run the regex passes against one file's stripped source and
 *  push (source, target) `references` edges into `edges`. */
function collectEdgesFromFile(args: {
  ctx: IndexHookContext;
  filePath: string;
  cleaned: string;
  edges: ValueRefEdge[];
}): void {
  const { ctx, filePath, cleaned, edges } = args;
  const fileNodeId = `file:${filePath}`;
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  // B37 (2026-05-25) — fetch the file's name → id index ONCE before
  // scanning. Per-name lookups inside the loop are then in-memory
  // Map.get() instead of `lookupSymbolByNameInFile`'s per-call DB
  // round-trip. Empty map (no nodes declared in this file) means
  // every per-name lookup will miss → no edges emitted; the regex
  // passes still run but exit cheaply.
  const nameIndex = getSymbolNameIndexByFile(ctx.queries, filePath);
  const baseArgs = { cleaned, fileNodeId, seenNames, seen, edges, nameIndex };
  collectValueRefMatches({ ...baseArgs, re: CALL_ARG_RE });
  collectValueRefMatches({ ...baseArgs, re: PAIR_VALUE_RE });
  collectValueRefMatches({ ...baseArgs, re: JSX_ATTR_VALUE_RE });
  collectValueRefMatches({ ...baseArgs, re: INVOKED_TERNARY_RE });
}

export const HOOK: IndexHook = {
  name: 'value-ref-edges',
  async afterIndexAll(ctx) {
    await refresh(ctx, { scope: 'all' });
  },
  async afterSync(ctx, result: SyncResult) {
    // Self-heal: when the stored algo version differs from the current
    // one, force a full re-mine so an existing project gets the new
    // edges on the next sync — no manual `cartograph admin index` after
    // installing the hook or after a regex-logic fix. This check must
    // precede the changed-files guard so a no-op sync (zero changed
    // files) still heals. Mirrors src/index-hooks/string-imports.ts.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== VALUE_REF_EDGES_ALGO_VERSION) {
      await refresh(ctx, { scope: 'all' });
      return;
    }
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      await refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
