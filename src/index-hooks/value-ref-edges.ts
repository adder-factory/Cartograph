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
 *   - Stale edges are NOT cleared when a usage is removed in-place:
 *     `refreshEdgesHook` only INSERTs (idempotent via the UNIQUE
 *     constraint), and cascade-delete only fires when the source /
 *     target node disappears. A symbol that lost its only callback
 *     usage but is otherwise unchanged keeps its `references` edge
 *     until the next full `cartograph admin index`. Accepted because
 *     the alternative (DELETE+INSERT per sync) doubles the hook's
 *     SQL cost for a corner-case correctness win.
 */

import * as path from 'path';
import type { IndexHook, IndexHookContext } from './types.js';
import { readFileSafe } from '../utils.js';
import type { SyncResult } from '../extraction/index.js';
import { stripJsComments } from '../resolution/import-resolver.js';
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

/** Algo-version SHA derived from this file's source. A change to the
 *  scanning regexes / keyword filter / resolution-gate behaviour
 *  invalidates the stored last-mined version, triggering a one-shot
 *  full re-mine on the next afterSync — so existing projects auto-
 *  activate the hook without a manual `cartograph admin index`. Mirrors
 *  STRING_IMPORTS_ALGO_VERSION / BUILD_CONTEXT_REFS_ALGO_VERSION. */
export const VALUE_REF_EDGES_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./value-ref-edges']);
const LAST_MINED_KEY = 'last_mined_value_ref_edges_algo_version';

const SUPPORTED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/**
 * JS / TS reserved keywords that LOOK like function calls / object
 * keys but are not user-defined symbols. Filtering these here keeps
 * us from probing the symbol table for every `if (x)` / `return (x)`
 * site (the cheap reject path before the DB lookup).
 *
 * Not exhaustive — only the high-frequency forms that would otherwise
 * dominate the false-positive set. A keyword we miss just means an
 * extra DB lookup that returns null; the edge isn't emitted either
 * way, so the consequence is wasted work, not wrong data.
 */
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

/** Bound on `\s` runs inside the regex lookbehinds + lookaheads.
 *  V8's variable-length lookbehind walks BACKWARDS across the entire
 *  possible `\s*` span at every candidate position. On pathological
 *  inputs — a `\n`-heavy 3.5MB file (`tests/cases/fourslash/reallyLargeFile.ts`
 *  in microsoft/TypeScript) or a 4.2MB file with 16KB lines and no
 *  anchor chars — the unbounded `\s*` form goes ~O(n × max_run_length),
 *  hanging a worker past the 120s per-worker timeout and silently
 *  dropping the survivor edges across the next sync (closed
 *  separately via the algo-version-stamp gate in `refresh()`).
 *  Empirically (2026-05-24c bench/probe-worker-db-init investigation),
 *  bounding the `\s` runs to {0,200} fixes the pathology while
 *  preserving multi-line capability — 200 chars of whitespace covers
 *  any realistic indented `{ key:\n  value }` multi-line form. On
 *  `src/compiler/checker.ts` (3.15MB, ~22K matches) the bounded form
 *  runs in 240ms vs ~865ms unbounded; on the 3.5MB hang victim it
 *  runs in 1.5s instead of hanging forever. */
const MAX_WS_RUN = 200;
const WS = `\\s{0,${MAX_WS_RUN}}`;

/**
 * Capture a bare identifier that appears as a CALL ARGUMENT. The
 * lookbehind anchors on `(` (first arg) or `,` (subsequent args) and
 * the lookahead anchors on `,` or `)`. The identifier therefore can't
 * be part of a member expression / method call / arithmetic — just a
 * value-position identifier passed to a function.
 *
 *   foo(bar)        → captures `bar`
 *   foo(a, bar, c)  → captures `a`, `bar`, `c`
 *   foo(a.b)        → does NOT capture `a` (next char is `.`)
 *   foo(a())        → does NOT capture `a` (next char is `(`)
 *   foo(a + b)      → does NOT capture (next char is space-then-`+`)
 */
const CALL_ARG_RE = new RegExp(`(?<=[(,]${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,)])`, 'g');

/**
 * Capture a bare identifier that appears as an OBJECT-LITERAL PROPERTY
 * VALUE (the value side of `key: value`). Excludes shorthand
 * `{ foo }` — that's covered by the existing `captureBodyConstantReads`
 * + identifier-as-arg patterns when consumed at the call site.
 *
 *   { foo: bar }    → captures `bar`
 *   { foo: bar, }   → captures `bar`
 *   { foo: 'str' }  → does NOT capture (value is a literal)
 *   { foo: bar() }  → does NOT capture (next char is `(`)
 *   { foo: a.b }    → does NOT capture (next char is `.`)
 *   { foo }         → does NOT capture (no colon)
 */
const PAIR_VALUE_RE = new RegExp(
  `(?<=[{,]${WS}[a-zA-Z_$][a-zA-Z_$0-9]{0,${MAX_WS_RUN}}${WS}:${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,}])`,
  'g',
);

interface ValueRefEdge {
  source: string;
  target: string;
  kind: 'references';
}

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
  if (shouldUseValueRefWorkers(files.length)) {
    const dbPath = getDatabasePath(ctx.projectRoot);
    const poolResult = await buildValueRefEdgesInWorkers({
      dbPath,
      projectRoot: ctx.projectRoot,
      files: files.map((f) => ({ path: f.path, language: f.language })),
    });
    return { edges: poolResult.edges as ValueRefEdge[], isPartial: poolResult.isPartial };
  }

  const edges: ValueRefEdge[] = [];
  let processed = 0;
  for (const file of files) {
    if (!SUPPORTED_LANGS.has(file.language)) continue;
    const content = readFileSafe(path.join(ctx.projectRoot, file.path));
    if (!content) continue;
    const cleaned = stripJsComments(content);
    collectEdgesFromFile({ ctx, filePath: file.path, cleaned, edges });
    // B24 (2026-05-24) — cooperative yield every PER_FILE_YIELD_INTERVAL
    // files so peer Group B hooks dispatched via `Promise.all` actually
    // interleave. Without yields this sync loop starves the others.
    if (++processed % PER_FILE_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return { edges, isPartial: false };
}

/** Per-file scan context passed to {@link collectMatches} so the
 *  helper can share dedupe state across the two regex passes. Bundles
 *  the params instead of taking 7 positional args (long_parameter_list
 *  error threshold is ≥7; the *Args interface is the codebase pattern
 *  for "this helper needs a wide call signature"). */
interface CollectMatchesArgs {
  cleaned: string;
  re: RegExp;
  fileNodeId: string;
  /** B27 (2026-05-24) — names already attempted in this file.
   *  Shared across both regex passes so the same identifier
   *  matching from CALL_ARG_RE then PAIR_VALUE_RE skips the second
   *  lookup. */
  seenNames: Set<string>;
  /** Tracks (fileNodeId → targetId) pairs already emitted — kept
   *  for defensive idempotency in the rare case where two
   *  different name-strings resolve to the same target id (e.g.
   *  re-export aliases pointing at the same symbol). */
  seen: Set<string>;
  edges: ValueRefEdge[];
  /** B37 (2026-05-25) — per-file `name → id` map fetched ONCE before
   *  the regex passes. Replaces the per-name `lookupSymbolByNameInFile`
   *  DB call with an in-memory Map.get(). 30× fewer DB calls on TS-
   *  scale corpora (~63s → ~few seconds for the hook wall). */
  nameIndex: ReadonlyMap<string, string>;
}

/** Run both regex passes against one file's stripped source and
 *  push (source, target) `references` edges into `edges`, deduping
 *  per file so an identifier passed N times produces ONE edge.
 *
 *  B27 (2026-05-24) — `seenNames` per-file dedup keeps the same
 *  identifier matching N times in a file (typical: `log` / `parse`
 *  / `process` repeated ~50× per file) from being looked up N times.
 *  Post-B37 the lookup is an in-memory Map.get(), but skipping the
 *  set membership check is still cheaper than re-looking-up.
 *
 *  B37 (2026-05-25) — the lookup is now an in-memory Map.get()
 *  against a per-file `nameIndex` pre-fetched ONCE before the regex
 *  passes; previously every unique name triggered a per-call DB
 *  round-trip. The original `seen` Set stays as a defensive
 *  target-id-level dedup for the cross-name-collision edge case. */
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
  collectMatches({ ...baseArgs, re: CALL_ARG_RE });
  collectMatches({ ...baseArgs, re: PAIR_VALUE_RE });
}

function collectMatches(args: CollectMatchesArgs): void {
  const { cleaned, re, fileNodeId, seenNames, seen, edges, nameIndex } = args;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1];
    if (!name || JS_RESERVED_HEAD.has(name)) continue;
    // B27 (2026-05-24) — name-level dedup BEFORE the lookup. Same
    // identifier matching N times in a file used to trigger N
    // lookups; now triggers 1. Still relevant post-B37 (the lookup
    // is in-memory but the dedup-set check is still cheaper).
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    // Symbol-resolution gate: only emit an edge when the captured
    // name resolves to a symbol declared in the same file. This
    // prunes the regex's natural false-positive set (parameter
    // names, local variables) down to "names that match a real
    // declaration in scope" — exactly what the dead-code rule needs.
    const targetId = nameIndex.get(name);
    if (!targetId) continue;
    const key = `${fileNodeId}->${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: fileNodeId, target: targetId, kind: 'references' });
  }
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
