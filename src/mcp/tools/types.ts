/**
 * MCP tool registry types.
 *
 * Each tool ships its own self-contained `ToolModule` (definition +
 * `handle` function) in `./<name>.ts`, so adding an MCP tool is a
 * single-file addition for metadata, dispatch, and handler body. All
 * 34 handlers are migrated; `ToolHandler.execute()` dispatches via
 * `mod.handle(ctx, args)` directly.
 *
 * The registry (`./registry`) imports each module and exposes
 * `tools[]` (for `list_tools`) plus a `getModule(name)` lookup used
 * by `ToolHandler.execute`.
 */

import type Cartograph from '../../index.js';
import type { ToolDefinition, ToolResult } from '../tool-types.js';
import type { ToolHandlerOptions } from '../tools.js';
import type { RefIdCache } from './_id-cache.js';
import type { CallIdCache } from './_call-id-cache.js';

/**
 * Per-call execution context passed to module-level tool handlers
 * (`ToolModule.handle`). Built once per `ToolHandler.execute()`
 * invocation. Carries the per-server state a handler needs so
 * handlers are standalone module functions instead of methods.
 *
 * Pure-function helpers (`textResult`, `validateStringOutcome`,
 * `truncateOutput`) are NOT on this context —
 * they're stateless imports from `./shared.js` so handlers don't pay
 * an indirection cost for trivial wrappers. Family-specific helpers
 * (`findSymbol`, `formatNodeList`, etc.) are imported from
 * `./symbol-resolver.js` / `./result-formatters.js` for the same
 * reason.
 */
export interface ToolCtx {
  /**
   * Resolve the project's `Cartograph` for this call. Honours the
   * `projectPath` arg (defaulting to the server's primary project).
   * Throws when no `.cartograph/` is reachable; handlers let the
   * error propagate to `execute()`'s catch block.
   */
  readonly getCartograph: (projectPath?: string) => Cartograph;
  /** Server-level options (profile, disabled tools, call defaults, etc.). */
  readonly options: ToolHandlerOptions;
  /**
   * The server's primary `Cartograph` instance (the one started from
   * the server's CWD). `null` when the server has no default project
   * (init-only mode). Used by `handleStatus` to label the output and
   * by `handleUninit` to drop the default-cg reference when the
   * primary project is uninitialised.
   */
  readonly defaultCg: Cartograph | null;
  /**
   * Read-only view of cached explicit-project `Cartograph` instances
   * keyed by the path the caller passed to `getCartograph` (which may
   * be either the resolved root or an alias path). Used by
   * `handleStatus` to list other-projects-open. Mutation goes
   * through {@link closeProjectsMatching}.
   */
  readonly projectCache: ReadonlyMap<string, Cartograph>;
  /**
   * Close every cached project (and the default CG, when applicable)
   * whose `getProjectRoot()` resolves to the same path as
   * `resolvedRoot`. Used by `handleUninit` before it deletes the
   * `.cartograph/` directory on disk so nothing holds the SQLite file
   * open.
   */
  readonly closeProjectsMatching: (resolvedRoot: string) => void;
  /**
   * Short-id cache for tabular row references (#15). Tools that
   * emit row lists `mint(node.id)` an `n_xxxxxxxx` UID per row;
   * symbol-resolving tools call `resolve(uid)` when the agent
   * passes `id=n_xxxxxxxx` instead of `symbol=<full name>`.
   * MCP-server-lifetime; agents that record IDs lose them across
   * server restarts (acceptable for a token-saving shortcut).
   */
  readonly refIds: RefIdCache;
  /**
   * Call-id cache for delta-mode (#16). Tools that support
   * `since=<call-id>` (search / grep / explore) `mint(toolName,
   * rowKeys)` a `c_xxxxxxxx` UID per result and stash the row-key
   * set against it. A subsequent call passing `since=<uid>`
   * resolves the prior set and returns only rows whose key is
   * NOT in that set. MCP-server-lifetime; eviction → graceful
   * fall-back to full results + warning footer.
   */
  readonly callIds: CallIdCache;
  /**
   * Optional progress callback (B13). Set by the MCP server when the
   * client provided a `progressToken` in the request's `_meta`.
   * Long-running tools (admin index/sync, summarize, embed) call
   * this with `(current, total?, message?)` to emit standard MCP
   * `notifications/progress` events. Undefined when the client
   * didn't request progress — handlers should null-check before
   * calling so the no-token path stays cost-free.
   */
  readonly reportProgress?: (current: number, total?: number, message?: string) => void;
  /**
   * Drop the stale in-memory copy of `projectPath`'s config + resolved
   * LLM cache so the next tool call picks up edits to its
   * `config.json`. Call this after writing `config.json` (e.g. from
   * `llm-apply`) — without it the cached `Cartograph` instance keeps
   * its startup-time config and the LLM provider cache that was
   * resolved against it, so `summarize` / `embed` / `ask` see the
   * old (often empty) LLM block.
   *
   * Two paths:
   * - An EXPLICIT project (held by `ProjectCache`) is evicted so the
   *   next `getOrOpen` constructs a fresh `Cartograph` that loads
   *   `config.json` from disk during init.
   * - The DEFAULT CG (held by the server outside the cache) is
   *   refreshed in place — `cgRefreshConfigFromDisk` overwrites
   *   `cg.config` with the latest disk contents and
   *   `LlmConfigManager.invalidate()` discards the cached
   *   `ResolvedLlm`. Note that sync / indexAll already call
   *   `cgRefreshConfigFromDisk` on the default CG, but neither path
   *   invalidates the resolved-LLM cache — that's why this method is
   *   needed even on the default-project flow.
   *
   * Safe no-op when the path has never been cached.
   */
  readonly evictCachedProject: (projectPath: string) => void;
}

export interface ToolModule {
  readonly definition: ToolDefinition;
  readonly handle: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * When true, the freshness pre-flight gate in `execute()` is
   * skipped for this tool — the call dispatches even if the index is
   * heavily stale. A predicate form supports branch-specific bypass for
   * family tools whose one mode does not read indexed data. Use
   * sparingly: only for tools where gate-blocking would create a
   * deadlock (e.g. `cartograph_admin({action: 'sync'})` is the
   * operation that fixes staleness; `cartograph_status` integrates
   * freshness inline) or a branch is project-operational rather than
   * graph-querying.
   */
  readonly bypassFreshnessGate?: boolean | ((args: Record<string, unknown>) => boolean);
  /**
   * When true, any stale index is treated as unsafe for this read tool.
   * The dispatcher refuses the call unless the user explicitly passes
   * `allowStale: true`. Use for answers whose false-negative/false-
   * positive risk is high when the graph lags disk: dead-code,
   * affected-test discovery, tests-for, and impact graph traversal.
   */
  readonly requiresFreshIndex?: boolean | ((args: Record<string, unknown>) => boolean);
  /**
   * When true, this tool mutates indexed state (runs the LLM, writes
   * embeddings, re-syncs files). Server operators can disable all
   * write tools at once via `MCPServerOptions.disableWriteTools` —
   * useful for sandboxed agents that should only read the graph.
   */
  readonly isWriteTool?: boolean;
  /**
   * Per-action carve-out for family tools: actions in this set are
   * treated as read-only and pass through `disableWriteTools` even
   * though the module itself is `isWriteTool: true`. The dispatcher
   * compares against the call's `args.action` discriminator. When a
   * tool declares this set the listing path keeps the tool visible
   * under `--no-write-tools` so the agent can discover its read-only
   * surface; the per-call gate then blocks any action not in the set.
   * Example shape (no current tools declare this set today — the
   * mechanism is preserved for future families): a write-flagged
   * family tool could list its purely-readable actions here so they
   * pass through `--no-write-tools` while the destructive ones stay
   * blocked.
   */
  readonly readOnlyActions?: ReadonlySet<string>;
  /**
   * General read-only carve-out for mixed read/write tools whose safe
   * branch is not expressible as `args.action` alone (for example a
   * `mode` discriminator, or the absence of a write-triggering field).
   *
   * When `isWriteTool` is true and `--no-write-tools` is active, calls
   * for which this predicate returns true are allowed. The listing path
   * calls the disabled check without args; declaring this predicate keeps
   * the tool visible so callers can discover its read-only shapes.
   */
  readonly isReadOnlyCall?: (args: Record<string, unknown>) => boolean;
  /** Human-facing summary of the safe argument shape for disabled-call errors. */
  readonly readOnlyCallDescription?: string;
  /**
   * When true, the schema-compat guard (B4) is skipped for this tool.
   * Use ONLY for diagnostic / docs surfaces an operator needs to call
   * AFTER hitting the guard's "stale code, restart" block — without
   * this escape, the operator loses every read-out path (status,
   * playbook) for confirming the mismatch. Don't set this on any tool
   * that touches DB writes — the whole point of the guard is to stop
   * stale-code writes before they corrupt rows.
   */
  readonly bypassSchemaGuard?: boolean;
}
