/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the Cartograph MCP server.
 */

import { resolve as resolvePath } from 'node:path';
import type Cartograph from '../index.js';
import { cgRefreshConfigFromDisk, findNearestCartographRoot } from '../index.js';
import type { ToolDefinition, ToolResult } from './tool-types.js';
import type { ToolCtx, ToolModule } from './tools/types.js';
import { getToolModule, tools as registryTools } from './tools/registry.js';
import { RefIdCache } from './tools/_id-cache.js';
import { CallIdCache } from './tools/_call-id-cache.js';
import { checkSchemaCompat, formatSchemaMismatch } from './schema-guard.js';
import { normalizeToolArgs } from './tools/_arg-normalizer.js';
import { ProjectCache } from './tools/_project-cache.js';
import { errMsg } from '../errors.js';
import { errorResult } from './tools/_error-result.js';
import {
  computeStalenessBanner,
  computeWorktreeBanner,
  runFreshnessGate,
  type FreshnessGateOutcome,
} from './tool-freshness.js';
import { mcpServerProfileToolSet, resolveMcpServerProfile, type McpServerProfile } from './profiles.js';

// Re-export shared types so existing consumers (`import { ToolDefinition,
// ToolResult } from './tools'`) keep working unchanged.
export type { ToolDefinition, ToolResult } from './tool-types.js';

/**
 * The MCP `list_tools` array, derived from the per-tool registry
 * (`./tools/<name>.ts`). Adding a new tool no longer touches this
 * array — drop a file in `./tools/` and add it to
 * `./tools/registry.ts`.
 *
 * Typed as a mutable array (matching the original export shape)
 * even though the underlying registry produces a readonly value;
 * we slice() to materialize a fresh, mutable copy at module load.
 */
export const tools: ToolDefinition[] = registryTools.slice();

// `getExploreBudget` lifted to its own module so `tools/explore.ts`
// and `getTools()` below can both import it without forming a runtime
// cycle through the registry.
import { getExploreBudget } from './tools/explore-budget.js';
export { getExploreBudget } from './tools/explore-budget.js';

// Keep the handshake-published `tools/list` payload comfortably below
// the load-budget guard while preserving enough field help for agents.
const MCP_TOOL_DESCRIPTION_MAX_CHARS = 220;
const MCP_SCHEMA_DESCRIPTION_MAX_CHARS = 90;
const TRUNCATED_DESCRIPTION_SUFFIX = '...';

function compactMcpDescription(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - TRUNCATED_DESCRIPTION_SUFFIX.length).trimEnd()}${TRUNCATED_DESCRIPTION_SUFFIX}`;
}

function compactMcpSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compactMcpSchemaDescriptions(item));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      key === 'description' && typeof item === 'string'
        ? compactMcpDescription(item, MCP_SCHEMA_DESCRIPTION_MAX_CHARS)
        : compactMcpSchemaDescriptions(item);
  }
  return out;
}

function compactMcpToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    description: compactMcpDescription(tool.description, MCP_TOOL_DESCRIPTION_MAX_CHARS),
    inputSchema: compactMcpSchemaDescriptions(tool.inputSchema) as ToolDefinition['inputSchema'],
  };
}

/**
 * Tool handler that executes tools against a Cartograph instance
 *
 * Supports explicit-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
// `| undefined` is intentional on every field — under
// `exactOptionalPropertyTypes: true`, `prop?: T` rejects callers
// that pass `prop: undefined` literally. Adding `| undefined` lets
// option spreads from MCPServerOptions type-check.
export interface ToolHandlerOptions {
  /**
   * Named advertised-tool profile. `full` is the complete registry and
   * preserves the default surface. Narrower profiles are allowlist
   * filters that compose with `disableWriteTools` and `disabledTools`.
   */
  profile?: McpServerProfile | undefined;
  /**
   * When true, disable every tool flagged `isWriteTool` (admin,
   * embed, summarize, summaries, coverage). Sandboxed-agent setups
   * use this to keep the agent read-only on the graph — write-class
   * ops would fail with a clean error instead of running.
   *
   * Read-only carve-outs: a write-flagged family tool can declare
   * `ToolModule.readOnlyActions` or `ToolModule.isReadOnlyCall` for
   * purely-readable branches. Those calls still execute under
   * `--no-write-tools` and the tool stays visible in `tools/list` so
   * agents can discover the safe branch; every write branch is blocked
   * with a message naming the reachable shape.
   */
  disableWriteTools?: boolean | undefined;
  /**
   * Per-tool disable list (lowercase names like `cartograph_admin`).
   * Composes with `disableWriteTools` — either rule disables the tool.
   */
  disabledTools?: ReadonlySet<string> | undefined;
  /**
   * Default value injected into every tool call's args when the caller
   * doesn't specify `allowStale`. Useful for fast-iteration sessions
   * where the agent always wants to query the cached view.
   */
  allowStaleDefault?: boolean | undefined;
  /**
   * Default value injected into supported high-volume tool calls when
   * the caller doesn't specify `lowTokens`. Explicit per-call
   * `lowTokens: false` still wins. Unsupported tools are unchanged.
   */
  lowTokensDefault?: boolean | undefined;
  /**
   * Mirrored from `MCPServerOptions.disableStartupSync` so the status
   * tool can surface the flag in its `🔧 Server config` section. The
   * tool dispatch path doesn't read this — the flag affects boot
   * behavior only — but operators need a way to confirm it was applied.
   */
  disableStartupSync?: boolean | undefined;
}

/**
 * Per-execute options (B13). Currently just `onProgress` — set by
 * the MCP server when the client request carried a `_meta.progressToken`,
 * forwarded through to long-running tool handlers via `ToolCtx.reportProgress`.
 * Distinct from `ToolHandlerOptions` (per-server config) because it
 * varies per call.
 */
interface ExecuteOpts {
  onProgress?: (current: number, total?: number, message?: string) => void;
}

/**
 * True when the named tool is disabled by server config.
 *
 * Read-only carve-out: when `disableWriteTools` would otherwise block
 * a tool flagged `isWriteTool: true`, we let the call through if the
 * module declares `readOnlyActions` and the caller's `args.action`
 * sits in that set, or if `isReadOnlyCall(args)` returns true. The
 * listing path (`getTools()`) calls this without `args` — when the
 * module has any read-only carve-out we expose the tool so the
 * sandboxed agent can discover its read-only surface.
 *
 * Calls that omit / mistype `action` fall through to the handler's
 * own dispatch error rather than getting masked behind a generic
 * "Tool disabled" — otherwise the agent has no way to learn which
 * actions (if any) are reachable via the readOnlyActions carve-out.
 */
type ToolDisabledReason = 'profile' | 'explicit' | 'write' | null;

function toolHasReadOnlyCarveOut(mod: ToolModule | undefined): boolean {
  if (!mod) return false;
  if (mod.readOnlyActions && mod.readOnlyActions.size > 0) return true;
  return typeof mod.isReadOnlyCall === 'function';
}

function toolHandlerWriteToolsDisabled(options: ToolHandlerOptions): boolean {
  return options.disableWriteTools === true || resolveMcpServerProfile(options.profile) === 'read-only';
}

function toolCallMatchesReadOnlyCarveOut(mod: ToolModule, args: Record<string, unknown>): boolean {
  const action = args['action'];
  if (typeof action === 'string' && mod.readOnlyActions?.has(action)) return true;
  return mod.isReadOnlyCall?.(args) === true;
}

function toolHandlerDisabledReason(
  options: ToolHandlerOptions,
  name: string,
  args?: Record<string, unknown>,
): ToolDisabledReason {
  if (options.disabledTools?.has(name)) return 'explicit';
  const mod = getToolModule(name);
  const profile = resolveMcpServerProfile(options.profile);
  const profileToolSet = mcpServerProfileToolSet(profile);
  if (mod && profileToolSet && !profileToolSet.has(name)) return 'profile';
  if (!toolHandlerWriteToolsDisabled(options)) return null;
  if (!mod?.isWriteTool) return null;
  if (!toolHasReadOnlyCarveOut(mod)) return 'write';
  if (!args) return null;
  return toolCallMatchesReadOnlyCarveOut(mod, args) ? null : 'write';
}

function toolHandlerIsDisabled(options: ToolHandlerOptions, name: string, args?: Record<string, unknown>): boolean {
  return toolHandlerDisabledReason(options, name, args) !== null;
}

/**
 * Resolve `allowStale` for one call: explicit per-call value wins over
 * the server-wide default.
 */
function toolHandlerResolveAllowStale(options: ToolHandlerOptions, args: Record<string, unknown>): boolean {
  if (args['allowStale'] !== undefined) return args['allowStale'] === true;
  return options.allowStaleDefault === true;
}

function toolSupportsLowTokens(mod: ToolModule | undefined): boolean {
  return mod?.definition.inputSchema.properties['lowTokens'] !== undefined;
}

/**
 * Resolve `lowTokens` for one call: explicit per-call value wins over
 * the server-wide default, and unsupported tools are left unchanged so
 * they never see a synthetic unknown argument.
 */
function toolHandlerResolveLowTokensArgs(
  options: ToolHandlerOptions,
  mod: ToolModule | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args['lowTokens'] !== undefined) return args;
  if (options.lowTokensDefault !== true) return args;
  if (!toolSupportsLowTokens(mod)) return args;
  return { ...args, lowTokens: true };
}

function toolHandlerVisibleTools(options: ToolHandlerOptions): ToolDefinition[] {
  return tools.filter((t) => !toolHandlerIsDisabled(options, t.name));
}

function toolHandlerWithDynamicDescriptions(cg: Cartograph, visibleTools: ToolDefinition[]): ToolDefinition[] {
  const stats = cg.stats.getStats();
  const budget = getExploreBudget(stats.fileCount);
  return visibleTools.map((tool) => {
    if (tool.name !== 'cartograph_explore') return tool;
    return {
      ...tool,
      description: `Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed). ${tool.description}`,
    };
  });
}

/**
 * Schema-compat guard (B4): refuse calls when the on-disk schema is
 * newer than this server's loaded code understands.
 */
function toolHandlerCheckSchemaGuard(cg: Cartograph | null, mod: ToolModule | undefined): ToolResult | null {
  if (!cg || mod?.bypassSchemaGuard) return null;
  const compat = checkSchemaCompat(cg);
  if (compat.ok) return null;
  return errorResult(formatSchemaMismatch(compat));
}

interface PreFlightInvocation {
  toolName: string;
  args: Record<string, unknown>;
  mod: ToolModule | undefined;
}

/**
 * Build the disabled-tool error. When a write-flagged family tool has a
 * read-only carve-out, list the still-reachable actions/shape so the
 * sandboxed agent discovers them instead of bouncing off a generic
 * "Tool disabled" wall.
 */
function formatDisabledMessage(options: ToolHandlerOptions, inv: PreFlightInvocation): string {
  const generic = `Tool \`${inv.toolName}\` is disabled by this MCP server's configuration.`;
  const reason = toolHandlerDisabledReason(options, inv.toolName, inv.args);
  if (reason === 'profile') {
    const profile = resolveMcpServerProfile(options.profile);
    return `Tool \`${inv.toolName}\` is not available in MCP server profile \`${profile}\`.`;
  }
  // When disabledTools blocks the whole tool, no action is reachable —
  // don't advertise carve-outs that the operator has separately overridden.
  if (reason === 'explicit') return generic;
  if (!toolHandlerWriteToolsDisabled(options)) return generic;
  const carveOuts = inv.mod?.readOnlyActions;
  const shape = inv.mod?.readOnlyCallDescription;
  const parts: string[] = [];
  if (carveOuts && carveOuts.size > 0) {
    parts.push(`actions: ${[...carveOuts].sort((a, b) => a.localeCompare(b)).join(', ')}`);
  }
  if (shape) parts.push(shape);
  if (parts.length === 0) return generic;
  const action = inv.args['action'];
  const actionLabel = typeof action === 'string' ? ` action \`${action}\`` : '';
  return (
    `Tool \`${inv.toolName}\`${actionLabel} is disabled by this MCP server's configuration ` +
    `(read-only write gate). Read-only shape still reachable: ${parts.join('; ')}.`
  );
}

/**
 * Pre-flight checks before tool dispatch: disabled status, code graph
 * resolution, schema guard, and freshness gate.
 */
async function toolHandlerPreFlightCheck(
  self: ToolHandler,
  inv: PreFlightInvocation,
): Promise<{ cg: Cartograph | null; gate: FreshnessGateOutcome } | ToolResult> {
  if (toolHandlerIsDisabled(self.options, inv.toolName, inv.args)) {
    return errorResult(formatDisabledMessage(self.options, inv));
  }
  if (!inv.mod) return errorResult(`Unknown tool: ${inv.toolName}`);

  let cg: Cartograph | null;
  try {
    cg = self.getCartograph(inv.args['projectPath'] as string | undefined);
  } catch {
    cg = null;
  }

  const guardError = toolHandlerCheckSchemaGuard(cg, inv.mod);
  if (guardError) return guardError;

  const allowStale = toolHandlerResolveAllowStale(self.options, inv.args);
  const gate = await runFreshnessGate({ cg, mod: inv.mod, allowStale, args: inv.args });
  if (gate.blockResult) return gate.blockResult;

  // F#58 — surface a borrowed-worktree warning when the resolved
  // index belongs to a different git worktree than the caller (nested
  // worktrees under `.claude/worktrees/<name>/` are the dominant
  // trigger). The check is cached per (startPath, indexRoot) and
  // short-circuits cheaply to null on every non-mismatched case, so
  // the cost on the happy path is one Map.get().
  const worktreeBanner = computeWorktreeBanner(self, cg, inv.args);
  if (worktreeBanner) {
    const combined = gate.banner ? `${worktreeBanner}\n${gate.banner}` : worktreeBanner;
    return { cg, gate: { ...gate, banner: combined } };
  }

  return { cg, gate };
}

export class ToolHandler {
  private readonly st = {
    cache: new ProjectCache(),
    refIds: new RefIdCache(),
    callIds: new CallIdCache(),
  };
  /**
   * F#58 — per-(startPath, indexRoot) cache of the borrowed-worktree
   * banner. `null` value = checked + no mismatch; `undefined` (missing
   * key) = not yet checked. Limits the worktree detection to one pair
   * of `git rev-parse` spawns per (startPath, indexRoot), regardless of
   * how many tool calls flow through. Two-key form ensures a mid-
   * session `cartograph admin init` (which changes `indexRoot`) gets a
   * cache miss and recomputes — the next tool call's banner reflects
   * the fix. @internal — module-scope helper writes it. */
  readonly worktreeBannerCache: Map<string, string | null> = new Map();
  /** @internal — exposed for module-scope helpers like `toolHandlerPreFlightCheck`. */
  readonly options: ToolHandlerOptions;

  constructor(
    private cg: Cartograph | null,
    options: ToolHandlerOptions = {},
  ) {
    this.options = options;
  }

  /**
   * Update the default Cartograph instance (e.g. after lazy initialization)
   */
  setDefaultCartograph(cg: Cartograph): void {
    this.cg = cg;
  }

  /**
   * Whether a default Cartograph instance is available
   */
  hasDefaultCartograph(): boolean {
    return this.cg !== null;
  }

  /** Snapshot explicit-project cache state for diagnostics and invariant tests. */
  getProjectCacheSnapshot(): { cachedRoots: readonly string[]; watchedRoots: readonly string[] } {
    return this.st.cache.snapshot();
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   */
  getTools(): ToolDefinition[] {
    const visibleTools = toolHandlerVisibleTools(this.options);
    if (!this.cg) return visibleTools.map(compactMcpToolDefinition);
    try {
      return toolHandlerWithDynamicDescriptions(this.cg, visibleTools).map(compactMcpToolDefinition);
    } catch {
      return visibleTools.map(compactMcpToolDefinition);
    }
  }

  /**
   * Resolve the Cartograph for a tool call. No `projectPath` → default
   * CG. With one → delegate to the project cache (LRU + watcher).
   * @internal — also called by `toolHandlerPreFlightCheck`.
   */
  getCartograph(projectPath?: string): Cartograph {
    if (!projectPath) {
      if (!this.cg) {
        throw new Error(
          'No default cartograph project for this MCP server.\n' +
            'Either: (a) restart the MCP server from a directory containing .cartograph/, ' +
            '(b) run `cartograph index` in the current directory, or ' +
            '(c) pass `projectPath` pointing to a directory that already has .cartograph/.',
        );
      }
      return this.cg;
    }
    // A projectPath that resolves to the default project's own root must reuse
    // the default CG, not open a SECOND instance through the cache: two in-process
    // Cartographs on one `.cartograph/` each carry their own watcher + FileLock,
    // and the per-CG mutexes can't serialize them (they only collide on the
    // cross-process FileLock). Resolve the same way the cache does
    // (findNearestCartographRoot) so every alias/subdir of the default root dedups
    // here; anything else falls through to the cache's own LRU + watcher.
    if (this.cg) {
      try {
        const defaultRoot = resolvePath(this.cg.projectRoot);
        // Fast path: projectPath IS the default root (what agents usually pass) —
        // a cheap string compare, no filesystem walk.
        if (resolvePath(projectPath) === defaultRoot) return this.cg;
        // Subdir/alias of the default project: resolve the way the cache does
        // (nearest .cartograph wins, so a nested project resolves to itself and
        // correctly does NOT dedup here). Only this branch touches the filesystem.
        const root = findNearestCartographRoot(projectPath);
        if (root && resolvePath(root) === defaultRoot) return this.cg;
      } catch {
        /* fall through to the cache, which surfaces resolution errors itself */
      }
    }
    return this.st.cache.getOrOpen(projectPath);
  }

  /** Close every cached project + the default CG. */
  closeAll(): void {
    this.st.cache.closeAll();
    if (this.cg) {
      try {
        this.cg.watcher.stop?.();
      } catch {
        /* idempotent */
      }
      try {
        this.cg.close();
      } catch {
        /* idempotent */
      }
    }
  }

  /**
   * Build a per-call `ToolCtx` for module-function tool handlers.
   */
  private makeCtx(opts?: ExecuteOpts): ToolCtx {
    return {
      getCartograph: (projectPath?: string) => this.getCartograph(projectPath),
      options: this.options,
      defaultCg: this.cg,
      projectCache: this.st.cache.readonlyView,
      closeProjectsMatching: (resolvedRoot: string) => this.closeProjectsMatching(resolvedRoot),
      evictCachedProject: (projectPath: string) => {
        // Bust the cached Cartograph after config.json is written to disk.
        // Without eviction, the next tool call reads llm config from the
        // stale in-memory instance and misses the newly applied preset.
        //
        // Two paths: an EXPLICIT project (held by ProjectCache) is evicted
        // so the next getOrOpen reads config.json + resolves LLM fresh. The
        // DEFAULT CG (this.cg) is held outside the cache and can't be evicted
        // mid-process; instead we refresh its in-memory config from disk and
        // invalidate the resolved-LLM cache so the next LLM call re-resolves
        // providers against the new config.
        let resolved: string;
        try {
          resolved = resolvePath(projectPath);
        } catch {
          return;
        }
        if (this.cg) {
          try {
            if (resolvePath(this.cg.projectRoot) === resolved) {
              cgRefreshConfigFromDisk(this.cg);
              this.cg.llm.config.invalidate();
              return;
            }
          } catch {
            /* fall through and evict */
          }
        }
        this.st.cache.evictProject(resolved);
      },
      refIds: this.st.refIds,
      callIds: this.st.callIds,
      ...(opts?.onProgress ? { reportProgress: opts.onProgress } : {}),
    };
  }

  /**
   * Close every cached project whose root resolves to `resolvedRoot`,
   * plus the default CG if it matches.
   */
  private closeProjectsMatching(resolvedRoot: string): void {
    this.st.cache.closeProjectsMatching(resolvedRoot);
    // Drop the default cg slot when it points at resolvedRoot.
    if (!this.cg) return;
    let matches: boolean;
    try {
      matches = resolvePath(this.cg.projectRoot) === resolvedRoot;
    } catch {
      return;
    }
    if (!matches) return;
    try {
      this.cg.close();
    } catch {
      /* idempotent */
    }
    this.cg = null;
  }

  /**
   * Execute a tool by name.
   *
   * The freshness banner is computed once and prepended to the
   * dispatched result via a per-call local — never stored on `this`.
   */
  async execute(toolName: string, args: Record<string, unknown>, opts?: ExecuteOpts): Promise<ToolResult> {
    const mod = getToolModule(toolName);
    const preflight = await toolHandlerPreFlightCheck(this, { toolName, args, mod });

    // preFlightCheck returns either an error ToolResult or the gate + cg pair
    if ('isError' in preflight) {
      return preflight;
    }
    const { cg, gate } = preflight as { cg: Cartograph | null; gate: FreshnessGateOutcome };

    // Pin the in-use cached project for the duration of this call so a concurrent
    // burst of newly-opened projects can't LRU-evict and close the handle while
    // the handler (and the post-handler staleness banner) is still using it —
    // tool calls dispatch concurrently (readline doesn't await its handlers). The
    // default CG is never cached/evicted, so it doesn't need a borrow.
    const borrowedRoot = cg && cg !== this.cg ? this.st.cache.borrow(cg) : null;
    try {
      const effectiveArgs = toolHandlerResolveLowTokensArgs(this.options, mod, args);

      // Every tool is `defineTool`-backed: `normalizeToolArgs` does
      // structural validation and reports unknown (typo'd) args that Zod
      // would otherwise strip silently.
      const validation = normalizeToolArgs(mod!, effectiveArgs);
      if (!validation.ok) {
        return errorResult(`Invalid arguments for \`${toolName}\`: ${validation.error}`);
      }

      let result: ToolResult;
      try {
        result = await mod!.handle(this.makeCtx(opts), effectiveArgs);
      } catch (err) {
        return errorResult(`Tool execution failed: ${errMsg(err)}`);
      }

      // F#60 — per-file staleness banner. Computed AFTER the handler
      // returns because it intersects "files pending in the watcher"
      // with "files referenced in this response" — the response shape
      // isn't known until the handler runs. Prepended before the
      // freshness banner so an agent reading top-to-bottom sees
      // file-specific warnings first, then the index-level state.
      const stalenessBanner = computeStalenessBanner(cg, result);
      if (stalenessBanner) result = prependBanner(result, stalenessBanner);
      if (gate.banner) result = prependBanner(result, gate.banner);
      if (validation.warnings?.length) {
        const warnBanner = validation.warnings.map((w) => `⚠ ${w}`).join('\n');
        // Unknown-arg warnings surface regardless of whether the handler
        // returned an error — an agent that passed a bad arg must always
        // learn it was ignored, even when the handler itself failed.
        // prependBanner skips isError results, so we inline a direct prepend
        // that handles both success and error ToolResults.
        result = prependTextToResult(result, warnBanner);
        result = { ...result, metadata: { ...result.metadata, warnings: validation.warnings } };
      }
      if (gate.freshnessMeta && !result.isError) {
        result = { ...result, metadata: { ...result.metadata, freshness: gate.freshnessMeta } };
      }
      return result;
    } finally {
      this.st.cache.release(borrowedRoot);
    }
  }

  /**
   * Test-only entrypoint that dispatches a tool by name without
   * the freshness gate, banner, or auto-sync wrapping.
   *
   * @internal
   */
  async runHandler(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const mod = getToolModule(toolName);
    if (!mod) return errorResult(`Unknown tool: ${toolName}`);
    return mod.handle(this.makeCtx(), args);
  }
}

/**
 * Serialize the review context as JSON, progressively trimming low-value
 * fields (docstrings → signatures → callers/callees → files) to fit `cap`.
 */
function prependBanner(result: ToolResult, banner: string): ToolResult {
  if (result.isError || !result.content || result.content.length === 0) {
    return result;
  }
  const first = result.content[0];
  if (first?.type !== 'text') return result;
  return {
    ...result,
    content: [{ type: 'text', text: `${banner}\n\n${first.text}` }, ...result.content.slice(1)],
  };
}

/**
 * Prepend `banner` text to a ToolResult regardless of whether it is a
 * success or an error result. Unlike `prependBanner`, this does NOT skip
 * isError results — it is used for unknown-arg warnings which must surface
 * even when the handler itself returned an error.
 *
 * Handles the empty-content edge: if the result has no text content, a new
 * text block is inserted as the first element.
 */
function prependTextToResult(result: ToolResult, banner: string): ToolResult {
  const prefix = `${banner}\n\n`;
  if (!result.content || result.content.length === 0) {
    return { ...result, content: [{ type: 'text', text: prefix }] };
  }
  const first = result.content[0];
  if (first?.type !== 'text') {
    // First block is not text (e.g. image) — insert a new text block before it.
    return { ...result, content: [{ type: 'text', text: prefix }, ...result.content] };
  }
  return {
    ...result,
    content: [{ type: 'text', text: `${prefix}${first.text}` }, ...result.content.slice(1)],
  };
}
