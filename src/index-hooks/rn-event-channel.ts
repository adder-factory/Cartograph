/**
 * RN event-channel hook (B12 sub-channel 5, 2026-05-29).
 *
 * Synthesizes the native→JS event fan-out edge: a native module dispatching an
 * event by literal name (ObjC `sendEventWithName:@"X"`, Swift
 * `sendEvent(withName:"X")`, JVM `.emit("X",…)`) → every JS subscriber that
 * registered a handler for that same name (`.on`/`.once`/`.addListener("X",
 * handler)`). So `trace`/`callers` follow a native event dispatch through to
 * the JS handler that runs in response — a flow grep can't see (the two sides
 * share only a string literal, in different files and languages).
 *
 * The event name is a STRING ARG on both sides — node-invisible — so this hook
 * re-reads source (the `value-ref-edges` / `sql-refs` idiom: `getAllFiles` +
 * `readFileSafe`) and attributes each call site to its enclosing graph node
 * (`getNodesByFile` + `enclosingNode`). It's a node→node synthesizer, so it
 * lives as an index-hook (cf. `fabric-native-impl`, ch.4), not a resolver.
 * Ported from upstream `4d1a2b3c`'s `rnEventEdges` (a `callback-synthesizer.ts`
 * that doesn't exist here). Self-heals via `RN_EVENT_CHANNEL_ALGO_VERSION`.
 *
 * `EVENT_FANOUT_CAP` skips an entire event whose dispatcher OR handler set is
 * too large (a generic name like `change`/`error` can't be matched precisely
 * without receiver-type info). Only NAMED handlers are matched — inline arrows
 * aren't (no named target). `supportedEvents()` declarations are ignored; only
 * actual dispatch call sites drive the dispatcher side.
 */
import * as path from 'node:path';
import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node } from '../types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { insertEdges } from '../db/queries-edges.js';
import { getAllFiles } from '../db/queries-files.js';
import { getNodesByName } from '../db/queries-search.js';
import { makeLineIndex, readFileSafe, stripCommentsForRegex } from '../utils.js';
import { logDebug, errMsg } from '../errors.js';
import {
  type JsSubscription,
  isNativeDispatchLanguage,
  parseJsSubscriptions,
  parseNativeDispatches,
} from '../resolution/rn-event-bridge.js';

// Hash BOTH this hook AND the sibling parser module (the dispatch/subscribe
// regexes live there) so a logic change in EITHER self-heals existing projects.
export const RN_EVENT_CHANNEL_ALGO_VERSION = computeAlgoHash('src/index-hooks/rn-event-channel.ts', [
  './rn-event-channel',
  '../resolution/rn-event-bridge',
]);
const LAST_MINED_KEY = 'last_mined_rn_event_channel_algo_version';
const SYNTHESIZED_BY = 'rn-event-channel';

/** Skip an event whose dispatcher OR handler set exceeds this — too generic to
 *  match precisely without receiver-type info. */
const EVENT_FANOUT_CAP = 6;
/** FileRecord.language values for the JS subscriber side. */
const JS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'jsx']);
/** Node kinds that can enclose a dispatch / handler call site. */
const FN_KINDS = new Set(['method', 'function', 'component']);
/** Fallback enclosers for object-literal method-shorthand APIs. */
const VAR_KINDS = new Set(['constant', 'variable']);

/** Tightest (latest-starting) node of one of `kinds` whose line span contains
 *  `line`, or null. Pure over the file's nodes. */
function enclosingNode(nodes: Node[], line: number, kinds: ReadonlySet<string>): string | null {
  let best: Node | null = null;
  for (const n of nodes) {
    if (!kinds.has(n.kind)) continue;
    if (n.startLine <= line && (n.endLine ?? n.startLine) >= line && (!best || n.startLine >= best.startLine)) {
      best = n;
    }
  }
  return best ? best.id : null;
}

interface ResolveHandlerArgs {
  ctx: IndexHookContext;
  nodes: Node[];
  sub: JsSubscription;
  line: number;
}

/** Resolve a JS subscription's handler to a node id: a named function/method,
 *  else the enclosing function (the subscribe-wrapper), else the enclosing
 *  const/variable. Null when none applies. The tier-1 named lookup is
 *  project-wide (no file scope) — handlers are commonly imported cross-file, so
 *  this is intentional, but two same-named handlers in different files resolve
 *  to an arbitrary one (an accepted approximation, like the in-language matcher). */
function resolveJsHandler({ ctx, nodes, sub, line }: ResolveHandlerArgs): string | null {
  const bare = sub.handlerArg.includes('.')
    ? sub.handlerArg.slice(sub.handlerArg.lastIndexOf('.') + 1)
    : sub.handlerArg;
  const named = getNodesByName(ctx.queries, bare).find((n) => n.kind === 'function' || n.kind === 'method');
  if (named) return named.id;
  return enclosingNode(nodes, line, FN_KINDS) ?? enclosingNode(nodes, line, VAR_KINDS);
}

interface DispatchSite {
  event: string;
  nodeId: string;
}
interface HandlerSite {
  event: string;
  nodeId: string;
  registeredAt: string;
}
interface FileScan {
  dispatches: DispatchSite[];
  handlers: HandlerSite[];
}
interface EventIndex {
  /** event → set of native dispatcher node ids. */
  dispatchers: Map<string, Set<string>>;
  /** event → (handler node id → `file:line` of the subscribe site). */
  handlers: Map<string, Map<string, string>>;
}

/** Scan one file (native dispatch sites OR JS subscriptions), attributing each
 *  call site to its enclosing node. Comment-stripped so commented-out code
 *  doesn't false-match (line numbers preserved). */
function scanFile(ctx: IndexHookContext, file: { path: string; language: string }): FileScan {
  const dispatches: DispatchSite[] = [];
  const handlers: HandlerSite[] = [];
  const raw = readFileSafe(path.join(ctx.projectRoot, file.path));
  if (!raw) return { dispatches, handlers };
  const content = stripCommentsForRegex(raw, file.language);
  const nodes = ctx.queries.getNodesByFile(file.path);
  // O(n)-prebuilt offset→line index (F#72 — avoids the per-match
  // `slice().split()` Schlemiel-quadratic). Lines map to the original source
  // because stripCommentsForRegex is newline-preserving.
  const lineOf = makeLineIndex(content);

  if (isNativeDispatchLanguage(file.language)) {
    for (const d of parseNativeDispatches(content, file.language)) {
      const nodeId = enclosingNode(nodes, lineOf(d.index), FN_KINDS);
      if (nodeId) dispatches.push({ event: d.event, nodeId });
    }
  } else {
    for (const sub of parseJsSubscriptions(content)) {
      const line = lineOf(sub.index);
      const nodeId = resolveJsHandler({ ctx, nodes, sub, line });
      if (nodeId) handlers.push({ event: sub.event, nodeId, registeredAt: `${file.path}:${line}` });
    }
  }
  return { dispatches, handlers };
}

/** Build the per-event dispatcher / handler index across all RN-relevant files. */
function collectEvents(ctx: IndexHookContext): EventIndex {
  const dispatchers = new Map<string, Set<string>>();
  const handlers = new Map<string, Map<string, string>>();
  for (const file of getAllFiles(ctx.queries)) {
    if (!isNativeDispatchLanguage(file.language) && !JS_LANGUAGES.has(file.language)) continue;
    const scan = scanFile(ctx, file);
    for (const d of scan.dispatches) {
      const set = dispatchers.get(d.event) ?? new Set<string>();
      set.add(d.nodeId);
      dispatchers.set(d.event, set);
    }
    for (const h of scan.handlers) {
      const map = handlers.get(h.event) ?? new Map<string, string>();
      map.set(h.nodeId, h.registeredAt);
      handlers.set(h.event, map);
    }
  }
  return { dispatchers, handlers };
}

/** Edges for one event: every (dispatcher, handler) pair, deduped, no self-loops. */
function pairEdges(event: string, dispatchers: Set<string>, handlers: Map<string, string>): Edge[] {
  const edges: Edge[] = [];
  for (const source of dispatchers) {
    for (const [target, registeredAt] of handlers) {
      if (source === target) continue;
      edges.push({
        source,
        target,
        kind: 'calls',
        confidence: 'INFERRED',
        metadata: { synthesizedBy: SYNTHESIZED_BY, event, registeredAt },
      });
    }
  }
  return edges;
}

/** Join dispatchers ↔ handlers per shared event name, under the fan-out cap. */
function joinEvents(index: EventIndex): Edge[] {
  const edges: Edge[] = [];
  for (const [event, dispatchers] of index.dispatchers) {
    const handlers = index.handlers.get(event);
    if (!handlers) continue;
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    edges.push(...pairEdges(event, dispatchers, handlers));
  }
  return edges;
}

function refresh(ctx: IndexHookContext): void {
  try {
    // Clean slate: drop prior synthesized event edges so an algo/logic change
    // (or a renamed dispatcher/handler) can't leave stale edges. FK CASCADE
    // already clears edges whose endpoint node was removed.
    ctx.queries.db
      .prepare(`DELETE FROM edges WHERE kind = 'calls' AND json_extract(metadata, '$.synthesizedBy') = ?`)
      .run(SYNTHESIZED_BY);
    const edges = joinEvents(collectEvents(ctx));
    if (edges.length > 0) insertEdges(ctx.queries, edges);
  } catch (err) {
    logDebug(`rn-event-channel refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, RN_EVENT_CHANNEL_ALGO_VERSION);
  } catch (err) {
    logDebug(`rn-event-channel stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'rn-event-channel',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    // Self-heal: a stored-algo mismatch forces a re-mine before the changed-file
    // guard, so a no-op sync also heals after a logic change.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== RN_EVENT_CHANNEL_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Cross-file relationship (native dispatcher + JS subscriber in different
    // files/languages) → any touched native or JS file re-runs the pass.
    const changed = result.changedFilePaths ?? [];
    const relevant =
      changed.some((p) => /\.(m|mm|swift|java|kt|jsx?|tsx?|mjs|cjs|mts|cts)$/.test(p)) || result.filesRemoved > 0;
    if (relevant) refresh(ctx);
  },
};
