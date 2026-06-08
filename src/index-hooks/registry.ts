/**
 * Index-hook registry.
 *
 * Adding a new derived-signal pass:
 *
 *   1. Create `src/index-hooks/<name>.ts` exporting a
 *      `HOOK: IndexHook` constant with `afterIndexAll` and/or
 *      `afterSync` implementations.
 *   2. Add **one** import line and **one** array entry to this file.
 *
 * That's it. `Cartograph` doesn't need a new private method or
 * call site for each pass — the runner inside `runHooks*` walks
 * every registered hook automatically.
 *
 * On main today there are NO hooks registered (this file ships
 * the framework only). PRs adding derived-signal passes
 * (centrality, churn, issue-history, config-refs, sql-refs,
 * cochange) each register their hook here.
 */

import type { IndexHook, IndexHookContext, IndexHookOutcome } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import { logDebug, logWarn } from '../errors.js';

/**
 * Per-hook wall-clock budget. A hook awaiting a promise that never
 * resolves (timed-out fetch with no AbortController, mis-handled
 * worker IPC, etc.) used to hang the whole indexAll/sync forever.
 * After this budget the runner gives up on the hook, surfaces it as
 * a timeout in the outcome, and moves on so the rest of the pipeline
 * still completes. Five minutes is generous enough for legitimate
 * mining on a multi-million-LOC repo while bounding the worst case.
 */
export const HOOK_TIMEOUT_MS = 5 * 60 * 1000;

import { HOOK as BIOMARKERS_HOOK } from './biomarkers.js';
import { HOOK as CENTRALITY_HOOK } from './centrality.js';
import { HOOK as BETWEENNESS_HOOK } from './betweenness.js';
import { HOOK as CHURN_HOOK } from './churn.js';
import { HOOK as COCHANGE_HOOK } from './cochange.js';
import { HOOK as BUILD_CONTEXT_REFS_HOOK } from './build-context-refs.js';
import { HOOK as CONFIG_REFS_HOOK } from './config-refs.js';
import { HOOK as ISSUE_HISTORY_HOOK } from './issue-history.js';
import { HOOK as SQL_REFS_HOOK } from './sql-refs.js';
import { HOOK as DYNAMIC_DISPATCH_HOOK } from './dynamic-dispatch.js';
import { HOOK as DYNAMIC_IMPORT_EDGES_HOOK } from './dynamic-import-edges.js';
import { HOOK as RE_EXPORT_EDGES_HOOK } from './re-export-edges.js';
import { HOOK as STRING_IMPORTS_HOOK } from './string-imports.js';
import { HOOK as VALUE_REF_EDGES_HOOK } from './value-ref-edges.js';
import { HOOK as GO_IMPLEMENTS_HOOK } from './go-implements.js';
import { HOOK as NESTJS_ROUTES_HOOK } from './nestjs-routes.js';
import { HOOK as SPRING_VALUE_BINDING_HOOK } from './spring-value-binding.js';
import { HOOK as MYBATIS_BINDING_HOOK } from './mybatis-binding.js';
import { HOOK as DRUPAL_HOOKS_HOOK } from './drupal-hooks.js';
import { HOOK as DRUPAL_PLUGINS_HOOK } from './drupal-plugins.js';
import { HOOK as DRUPAL_SERVICE_TAGS_HOOK } from './drupal-service-tags.js';
import { HOOK as FABRIC_NATIVE_IMPL_HOOK } from './fabric-native-impl.js';
import { HOOK as RN_EVENT_CHANNEL_HOOK } from './rn-event-channel.js';
import { HOOK as TESTS_EDGES_HOOK } from './tests-edges.js';
import { HOOK as TEST_NAMES_HOOK } from './test-names.js';
import { HOOK as ROLE_RESTORE_HOOK } from './role-restore.js';
import { HOOK as COVERAGE_REAPPLY_HOOK } from './coverage-reapply.js';
import { HOOK as PROMOTE_NESTED_FN_HOOK } from './promote-nested-fn.js';

/**
 * Hook execution plan — grouped parallel phases.
 *
 *                          ┌──────────────────────────┐
 *                          │   Group A — independent  │
 *                          │  (no graph dependencies) │
 *                          ├──────────────────────────┤
 *                          │ ROLE_RESTORE             │
 *                          │ CHURN                    │
 *                          │ COCHANGE                 │
 *                          │ ISSUE_HISTORY            │
 *                          └─────────────┬────────────┘
 *                                        │
 *                                        ▼
 *                          ┌──────────────────────────┐
 *                          │ Group B — edge emitters  │
 *                          │  (must precede biomarker │
 *                          │   reachability rules)    │
 *                          ├──────────────────────────┤
 *                          │ BUILD_CONTEXT_REFS       │
 *                          │ CONFIG_REFS              │
 *                          │ DYNAMIC_IMPORT_EDGES     │
 *                          │ RE_EXPORT_EDGES          │
 *                          │ SQL_REFS                 │
 *                          │ STRING_IMPORTS           │
 *                          │ VALUE_REF_EDGES          │
 *                          │ TESTS_EDGES              │
 *                          │ TEST_NAMES               │
 *                          │ COVERAGE_REAPPLY         │
 *                          └─────────────┬────────────┘
 *                                        │
 *                                        ▼
 *                          ┌──────────────────────────┐
 *                          │ Group C — graph readers  │
 *                          │  (need fresh edges +     │
 *                          │   coverage)              │
 *                          ├──────────────────────────┤
 *                          │ BIOMARKERS               │
 *                          │ CENTRALITY               │
 *                          └──────────────────────────┘
 *
 * Sequencing: groups run serially (A → B → C); hooks within a
 * group run via `Promise.all`. Cross-group ordering is load-
 * bearing — biomarkers' `unused_export` rule reads `references`
 * edges that the Group B emitters insert; `low_coverage` reads
 * the `node_coverage` rows that COVERAGE_REAPPLY restores.
 *
 * Wall-clock impact today: most hooks are sync (SQL `.all()` or
 * `execFileSync('git', ...)`), so the `Promise.all` wrappers only
 * give a real win for hooks whose internals are async I/O bound.
 * Phase 2A of G9 converted the three git miners (churn / cochange
 * / issue-history) to async `execFile`, so Group A genuinely
 * overlaps now. Group B (edge-emitter SQL writes serialized by
 * the bun:sqlite write lock) and Group C (sync reads on a single
 * connection) gain ~nothing from `Promise.all` until they're
 * moved to worker_threads with per-worker DB connections — that
 * carries its own cold-start cost that needs bench-driven sizing,
 * deferred to a follow-up slice.
 */
const HOOK_GROUPS: ReadonlyArray<{ readonly group: 'A' | 'B' | 'C'; readonly hooks: readonly IndexHook[] }> = [
  {
    group: 'A',
    // role-restore has no graph dependencies (UPDATE over a side
    // table). The three git miners are I/O-bound async shells out
    // to `git log` / `git diff` — they overlap each other.
    hooks: [ROLE_RESTORE_HOOK, CHURN_HOOK, COCHANGE_HOOK, ISSUE_HISTORY_HOOK],
  },
  {
    group: 'B',
    // Edge-emitting hooks run BEFORE biomarkers so the biomarker
    // hook sees the freshest graph. `unused_export` consults
    // `references` edges emitted by RE_EXPORT / VALUE_REF /
    // STRING_IMPORTS / SQL_REFS / CONFIG_REFS / BUILD_CONTEXT_REFS.
    // value-ref-edges is load-bearing here — without it, a
    // function passed only as `{key: fn}` or `refine(fn)` is
    // silently dead.
    // coverage-reapply must run BEFORE biomarkers: re-extraction
    // cascade-deletes node_coverage rows, so this re-derives them
    // from the persisted lcov report before the biomarker pass
    // evaluates the `low_coverage` rule (which would otherwise
    // read a decayed set).
    hooks: [
      BUILD_CONTEXT_REFS_HOOK,
      CONFIG_REFS_HOOK,
      DYNAMIC_DISPATCH_HOOK,
      DYNAMIC_IMPORT_EDGES_HOOK,
      RE_EXPORT_EDGES_HOOK,
      SQL_REFS_HOOK,
      STRING_IMPORTS_HOOK,
      VALUE_REF_EDGES_HOOK,
      // go-implements derives Go interface satisfaction by structural
      // method-set match. Project-wide pass; runs in Group B so
      // biomarker reachability rules see the implements edges.
      GO_IMPLEMENTS_HOOK,
      // nestjs-routes (B10) reads B9 decorator-args off TS/JS method
      // nodes and emits one `route` node per HTTP handler. Runs in
      // Group B so the routes are in the graph before biomarkers
      // and centrality pick them up.
      NESTJS_ROUTES_HOOK,
      // spring-value-binding (B11/F#64c) reads B9 decorator-args off
      // JVM field/property nodes whose @Value decorator names a
      // `${key}` placeholder, emits a `references` edge to the
      // matching `constant` mined by the .properties extractor.
      // Generalises the B10 graph-walk pattern beyond routing.
      SPRING_VALUE_BINDING_HOOK,
      // mybatis-binding (B11/F#64b) walks `method` nodes whose
      // language='xml' (MyBatis statements) and emits a `references`
      // edge from the matching Java/Kotlin Mapper-interface method
      // — bridging the cross-language MyBatis Java↔XML link.
      MYBATIS_BINDING_HOOK,
      // drupal-hooks (F#69, 2026-05-28) walks PHP function nodes in
      // .module/.install/.theme/.inc files, detects hook implementations
      // via docstring or name pattern, and emits `references` edges to
      // a canonical implementation. Replaces the regex-on-source path
      // that previously lived in `drupalResolver.extract()`.
      DRUPAL_HOOKS_HOOK,
      // drupal-plugins (Drupal v3, 2026-05-29) walks PHP class nodes whose
      // docstring carries a `@PluginType(id = "…")` annotation and emits a
      // `resource` node per plugin id + a `references` edge to the class.
      // Group B so plugins are in the graph before Group C readers.
      DRUPAL_PLUGINS_HOOK,
      // drupal-service-tags (Drupal v4, 2026-05-29) re-parses *.services.yml
      // and synthesizes one `resource` hub node per service tag, linking
      // every `tags:` provider + `!tagged_iterator` consumer across modules.
      // Reads the service `resource` nodes the resolver emitted in extract().
      DRUPAL_SERVICE_TAGS_HOOK,
      // fabric-native-impl (B12 ch.4, 2026-05-29) links each synthesized
      // `fabric-component:` node to its native impl CLASS by RN's name+suffix
      // convention (Foo → FooView / FooViewManager / …). Group B so the bridge
      // edges exist before Group C centrality/biomarkers count them.
      FABRIC_NATIVE_IMPL_HOOK,
      // rn-event-channel (B12 ch.5, 2026-05-29) re-reads source for native
      // event-dispatch sites (sendEventWithName / sendEvent(withName:) /
      // .emit("X",)) + JS .addListener("X", h) subscribers, and links
      // dispatcher→handler nodes that share an event name. Group B so the
      // 'calls' edges exist before Group C centrality/biomarkers count them.
      RN_EVENT_CHANNEL_HOOK,
      TESTS_EDGES_HOOK,
      TEST_NAMES_HOOK,
      COVERAGE_REAPPLY_HOOK,
      // F#12 slice 3 — promote-nested-fn must run BEFORE biomarkers
      // (Group C) so newly promoted Node rows count toward god_class /
      // unused_export / etc. on this pass. It only fires when at least
      // one manifest row's hit_count crossed `nestedPromotionThreshold`
      // — no work otherwise, so projects without manifest mode see
      // zero cost here.
      PROMOTE_NESTED_FN_HOOK,
    ],
  },
  {
    group: 'C',
    // Biomarkers + centrality both depend on a fresh, fully-
    // emitted edge set. Neither depends on the other, so the
    // `Promise.all` wrapper here is the right shape for the day
    // they parallelize for real. Today both are sync SQL on the
    // shared bun:sqlite connection — see the registry-level
    // JSDoc above for the Phase 2B/2C deferral rationale.
    // CENTRALITY is already fingerprint-skip-gated; BIOMARKERS'
    // 6 cross-file rules WILL fan out via a per-rule worker pool
    // (deferred — needs bench-driven justification on larger
    // corpora).
    // BETWEENNESS_HOOK (G23) is opt-in via `config.enableBetweenness`
    // (default false) — when enabled, runs alongside CENTRALITY here
    // in Group C. Same input subgraph (PR_EDGE_KINDS), independent
    // output column (`nodes.betweenness`), separate fingerprint key
    // (`last_betweenness_fingerprint`). Surfaces "structural bridge"
    // nodes that PageRank misses.
    hooks: [BIOMARKERS_HOOK, CENTRALITY_HOOK, BETWEENNESS_HOOK],
  },
];

/**
 * Flat union of every registered hook, in declaration order.
 * Kept as a named export for tests and diagnostic tools that walk
 * the hook list without caring about grouping.
 */
const REGISTERED_HOOKS: readonly IndexHook[] = HOOK_GROUPS.flatMap((g) => [...g.hooks]);

/**
 * Race a hook invocation against a wall-clock budget. The timeout
 * branch only unwinds *async* hangs — fully synchronous code blocks
 * the event loop and will still run to completion. That's
 * acceptable: hooks that do heavy work typically shell out via
 * `execFileSync` with their own per-call timeout, so a sync hang is
 * bounded upstream.
 */
async function runWithTimeout(fn: () => Promise<void> | void, timeoutMs: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = Promise.resolve().then(() => fn());
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms budget; skipping`)), timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Coerce an unknown thrown value into an Error. */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

/**
 * Invoke a single hook with timing + per-hook timeout + error
 * capture. Returns the outcome record or null when the hook has no
 * handler for this phase. Factored out of {@link runHookPhase} so
 * the grouped-parallel runner can dispatch via `Promise.all`.
 */
async function invokeOneHook(
  hook: IndexHook,
  phase: IndexHookOutcome['phase'],
  getInvoker: (hook: IndexHook) => (() => Promise<void> | void) | undefined,
): Promise<IndexHookOutcome | null> {
  const invoker = getInvoker(hook);
  if (invoker === undefined) return null;
  const start = Date.now();
  logDebug(`index-hook "${hook.name}" ${phase}: starting`);
  try {
    await runWithTimeout(invoker, HOOK_TIMEOUT_MS, `index-hook "${hook.name}" ${phase}`);
    const durationMs = Date.now() - start;
    logDebug(`index-hook "${hook.name}" ${phase}: done in ${durationMs}ms`);
    // B9 (2026-05-24) — surface non-trivial hooks at info level so
    // the long-running postHook isn't a silent wall. Threshold at
    // 1 sec keeps the noise off small projects where every hook is
    // a few ms, while still showing the centrality / biomarker /
    // git-mining phases that take seconds-to-minutes on real repos.
    if (durationMs >= POST_HOOK_LOG_THRESHOLD_MS) {
      // Diagnostic; stderr keeps CLI result streams and MCP JSON-RPC
      // stdout clean while still surfacing long-running hooks.
      writePostHookLog(`[postHook] ${hook.name} ${phase}: ${durationMs}ms`);
    }
    return { name: hook.name, phase, durationMs };
  } catch (err) {
    const e = toError(err);
    logWarn(`index-hook "${hook.name}" ${phase} failed: ${e.message}`);
    return { name: hook.name, phase, durationMs: Date.now() - start, error: e };
  }
}

/** Threshold (ms) above which a per-hook completion surfaces at info
 *  level. Tuned so trivial hooks (1-50ms on a small repo) stay quiet
 *  and only the genuinely-long ones (centrality, biomarkers, git
 *  miners on big histories) show up. */
const POST_HOOK_LOG_THRESHOLD_MS = 1_000;

function writePostHookLog(message: string): void {
  const line = message.endsWith('\n') ? message : `${message}\n`;
  process.stderr.write(line);
}

/**
 * Shared runner: walk each hook group serially, fanning each
 * group's member hooks out via `Promise.all`. Per-hook timeout +
 * try/catch wrap each invocation so one bad hook never fails the
 * whole pass, matching the original serial contract.
 *
 * Group ordering is load-bearing (see HOOK_GROUPS diagram). Within
 * a group, declared order is preserved in the returned outcomes —
 * `Promise.all` resolves in input order even when its tasks finish
 * out of order — so test snapshots and diagnostic logs stay
 * stable.
 *
 * `runAfterIndexAll` and `runAfterSync` are the only callers.
 * Keeping them as named entry points preserves every external call
 * site and every test that references them by name.
 */
async function runHookPhase(
  phase: IndexHookOutcome['phase'],
  getInvoker: (hook: IndexHook) => (() => Promise<void> | void) | undefined,
): Promise<IndexHookOutcome[]> {
  const out: IndexHookOutcome[] = [];
  for (const { group, hooks } of HOOK_GROUPS) {
    const groupStart = Date.now();
    // B9 (2026-05-24) — group start marker so the per-group progress
    // is visible. Per-hook completions log inside `invokeOneHook`
    // (gated at 1 sec); group end below shows the wall sum so the
    // user can see "Group C took 8 minutes" without summing
    // individual hooks.
    writePostHookLog(`[postHook] group ${group} ${phase}: starting (${hooks.length} hooks)`);
    const groupResults = await Promise.all(hooks.map((hook) => invokeOneHook(hook, phase, getInvoker)));
    for (const r of groupResults) {
      if (r !== null) out.push(r);
    }
    writePostHookLog(`[postHook] group ${group} ${phase}: done in ${Date.now() - groupStart}ms`);
  }
  return out;
}

/**
 * Run `afterIndexAll` for every registered hook. Errors are
 * caught + logged so one broken hook never fails the whole
 * index. Returns per-hook outcomes for diagnostics.
 */
export function runAfterIndexAll(ctx: IndexHookContext): Promise<IndexHookOutcome[]> {
  return runHookPhase('indexAll', (hook) => (hook.afterIndexAll ? () => hook.afterIndexAll!(ctx) : undefined));
}

/** Same shape, for `afterSync`. */
export function runAfterSync(ctx: IndexHookContext, result: SyncResult): Promise<IndexHookOutcome[]> {
  return runHookPhase('sync', (hook) => (hook.afterSync ? () => hook.afterSync!(ctx, result) : undefined));
}

/** Read access for tests + diagnostic tools. */
export function getRegisteredHooks(): readonly IndexHook[] {
  return REGISTERED_HOOKS;
}

// Re-export the types so consumers can import everything from one place.
export type { IndexHook, IndexHookContext, IndexHookOutcome } from './types.js';
