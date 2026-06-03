/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the Cartograph MCP server.
 */

import { resolve as resolvePath } from 'node:path';
import type Cartograph from '../index.js';
import { cgRefreshConfigFromDisk } from '../index.js';
import type { ToolDefinition, ToolResult } from './tool-types.js';
import type { ToolCtx, ToolModule } from './tools/types.js';
import { getToolModule, tools as registryTools } from './tools/registry.js';
import { RefIdCache } from './tools/_id-cache.js';
import { CallIdCache } from './tools/_call-id-cache.js';
import { checkSchemaCompat, formatSchemaMismatch } from './schema-guard.js';
import { collectUnknownArgWarnings } from './tools/_unknown-arg-warnings.js';
import { getZodSchema, formatZodError } from './tools/_define-tool.js';
import { ProjectCache } from './tools/_project-cache.js';
import { errMsg } from '../errors.js';
import { errorResult } from './tools/_error-result.js';
import { borrowedWorktreeBanner, detectBorrowedWorktreeIndex } from '../git-utils.js';
import type { PendingFile } from '../sync/index.js';

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
   * When true, disable every tool flagged `isWriteTool` (admin,
   * embed, summarize, summaries, coverage). Sandboxed-agent setups
   * use this to keep the agent read-only on the graph — write-class
   * ops would fail with a clean error instead of running.
   *
   * Per-action carve-out: a write-flagged family tool can declare
   * `ToolModule.readOnlyActions` listing its purely-readable actions.
   * Those actions still execute under `--no-write-tools` and the tool
   * stays visible in the `tools/list` response so the agent can
   * discover them; every other action on the same tool is blocked
   * with a message that names the reachable actions. (No current tool
   * declares this set — preserved for future families.)
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
 * Outcome of `runFreshnessGate` — either a hard block (returned to the
 * caller as the final ToolResult) or a banner + metadata pair to attach
 * to the downstream tool's result.
 */
interface FreshnessGateOutcome {
  blockResult: ToolResult | null;
  banner: string | null;
  freshnessMeta: import('./tool-types.js').FreshnessMetadata | null;
}

/**
 * Shared singleton for the "no gate applies" case. Frozen so a future
 * caller can't accidentally mutate the shared reference and corrupt
 * other concurrent execute() calls.
 */
const PASS_THROUGH: FreshnessGateOutcome = Object.freeze({
  blockResult: null,
  banner: null,
  freshnessMeta: null,
});

/**
 * True when the named tool is disabled by server config.
 *
 * Per-action carve-out: when `disableWriteTools` would otherwise block
 * a tool flagged `isWriteTool: true`, we let the call through if the
 * module declares `readOnlyActions` AND the caller's `args.action`
 * sits in that set. The listing path (`getTools()`) calls this without
 * `args` — when the module has any read-only carve-outs we expose the
 * tool so the sandboxed agent can discover its read-only surface.
 *
 * Calls that omit / mistype `action` fall through to the handler's
 * own dispatch error rather than getting masked behind a generic
 * "Tool disabled" — otherwise the agent has no way to learn which
 * actions (if any) are reachable via the readOnlyActions carve-out.
 */
function toolHandlerIsDisabled(options: ToolHandlerOptions, name: string, args?: Record<string, unknown>): boolean {
  if (options.disabledTools?.has(name)) return true;
  if (!options.disableWriteTools) return false;
  const mod = getToolModule(name);
  if (!mod?.isWriteTool) return false;
  const carveOuts = mod.readOnlyActions;
  if (!carveOuts || carveOuts.size === 0) return true;
  if (!args) return false;
  const action = args['action'];
  if (typeof action !== 'string') return false;
  return !carveOuts.has(action);
}

/**
 * Resolve `allowStale` for one call: explicit per-call value wins over
 * the server-wide default.
 */
function toolHandlerResolveAllowStale(options: ToolHandlerOptions, args: Record<string, unknown>): boolean {
  if (args['allowStale'] !== undefined) return args['allowStale'] === true;
  return options.allowStaleDefault === true;
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
 * Build the disabled-tool error. When a write-flagged family tool has
 * `readOnlyActions` declared, list the still-reachable actions so the
 * sandboxed agent discovers them instead of bouncing off a generic
 * "Tool disabled" wall.
 */
function formatDisabledMessage(options: ToolHandlerOptions, inv: PreFlightInvocation): string {
  const generic = `Tool \`${inv.toolName}\` is disabled by this MCP server's configuration.`;
  // When disabledTools blocks the whole tool, no action is reachable —
  // don't advertise carve-outs that the operator has separately overridden.
  if (options.disabledTools?.has(inv.toolName)) return generic;
  if (!options.disableWriteTools) return generic;
  const carveOuts = inv.mod?.readOnlyActions;
  if (!carveOuts || carveOuts.size === 0) return generic;
  const action = inv.args['action'];
  const actionLabel = typeof action === 'string' ? `\`${action}\`` : '<missing>';
  const allowed = [...carveOuts].sort((a, b) => a.localeCompare(b)).join(', ');
  return (
    `Tool \`${inv.toolName}\` action ${actionLabel} is disabled by this MCP server's configuration ` +
    `(--no-write-tools). Read-only actions still reachable: ${allowed}.`
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
  const gate = await toolHandlerRunFreshnessGate({ cg, mod: inv.mod, allowStale, args: inv.args });
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

/**
 * F#60 — Compute the per-file staleness banner from the watcher's
 * pending list intersected with the file paths referenced in the tool
 * result's first text block. Returns null when there's nothing pending
 * AND nothing for the response to flag — the common case.
 *
 * Cost on the happy path (no pending files): one `getPendingFiles()`
 * call returning `[]` and an immediate return — no string scanning.
 *
 * Path-match semantics (this is the bug class upstream's port had):
 * `text.includes("foo.ts")` false-matches `foo.ts.snap`. We require
 * the char following the matched path to be a non-pathchar (or
 * end-of-string), giving a `\b`-style boundary without paying for a
 * regex per file.
 */
function computeStalenessBanner(cg: Cartograph | null, result: ToolResult): string | null {
  if (result.isError || !cg) return null;
  const pending = cg.watcher.getPendingFiles();
  if (pending.length === 0) return null;

  const first = result.content[0];
  if (first?.type !== 'text') return null;
  const text = first.text;

  const referenced: PendingFile[] = [];
  const elsewhere: PendingFile[] = [];
  for (const p of pending) {
    if (textMentionsPath(text, p.path)) referenced.push(p);
    else elsewhere.push(p);
  }
  if (referenced.length === 0 && elsewhere.length === 0) return null;

  const parts: string[] = [];
  if (referenced.length > 0) parts.push(formatStaleBanner(referenced));
  if (elsewhere.length > 0) parts.push(formatStaleFooter(elsewhere));
  return parts.join('\n\n');
}

/** Chars that count as part of a path token; a match isn't a real
 *  "mention" when the next char is one of these (it's a longer path). */
const PATH_CHAR_RE = /[A-Za-z0-9._/\\-]/;

/** A path "is mentioned" when its exact string appears in `text` AND
 *  the char immediately after the match isn't another path char. This
 *  closes the substring-false-match class — `foo.ts` would otherwise
 *  match `foo.ts.snap`, `src/a` would match `src/abc`, etc. */
function textMentionsPath(text: string, p: string): boolean {
  let idx = text.indexOf(p);
  while (idx >= 0) {
    const end = idx + p.length;
    if (end >= text.length) return true;
    // Non-path char immediately after ⇒ word boundary ⇒ a real mention.
    // Backslash is a path char for parity with Windows-native path text in
    // tool responses; pending-file paths are POSIX-normalized at watcher
    // capture time, so `indexOf` only matches when the response uses the
    // same form — the boundary check then rejects a trailing `\foo` that
    // extends the match (e.g. `foo.ts` inside `foo.ts.snap`; F#60 info).
    if (!PATH_CHAR_RE.test(text[end]!)) return true;
    idx = text.indexOf(p, end);
  }
  return false;
}

function formatStaleBanner(referenced: PendingFile[]): string {
  const now = Date.now();
  const lines = referenced.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their cartograph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/** Cap to keep the footer compact. F#60 design: agent gets a project-wide
 *  freshness picture without bloating the banner. */
const STALE_FOOTER_CAP = 5;

function formatStaleFooter(elsewhere: PendingFile[]): string {
  const now = Date.now();
  const shown = elsewhere.slice(0, STALE_FOOTER_CAP);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = elsewhere.length > STALE_FOOTER_CAP ? `\n  - …and ${elsewhere.length - STALE_FOOTER_CAP} more` : '';
  return (
    `(Note: ${elsewhere.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Compute the borrowed-worktree banner (or null) for a tool call,
 * using the handler's per-(startPath, indexRoot) cache. `startPath`
 * is the request's effective working directory — the explicit
 * `projectPath` arg if any, else `process.cwd()`. The two-key cache
 * means a `cartograph admin init` mid-session that creates a local
 * `.cartograph/` (changing `indexRoot`) misses the cache cleanly and
 * recomputes — the next tool call's banner reflects the fix.
 */
function computeWorktreeBanner(self: ToolHandler, cg: Cartograph | null, args: Record<string, unknown>): string | null {
  if (!cg) return null;
  const startPath = (args['projectPath'] as string | undefined) ?? process.cwd();
  const indexRoot = cg.projectRoot;
  if (!indexRoot) return null;
  // NUL-separated key — neither path component can contain NUL on any
  // POSIX or Windows filesystem, so the (startPath, indexRoot) pair
  // round-trips unambiguously even when paths contain literal spaces.
  // Space-delimited keys had a theoretical collision the reviewer
  // flagged (`/Users/John Doe` + `/proj` ambiguous with `/Users/John`
  // + `Doe /proj`).
  const cacheKey = `${startPath}\0${indexRoot}`;
  const cached = self.worktreeBannerCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const mismatch = detectBorrowedWorktreeIndex(startPath, indexRoot);
  const banner = mismatch ? borrowedWorktreeBanner(mismatch) : null;
  self.worktreeBannerCache.set(cacheKey, banner);
  return banner;
}

/**
 * Race a `cg.sync({ summarize: false })` against a wall-clock timeout
 * so a worst-case sync doesn't block a tool call for too long.
 */
async function toolHandlerAttemptAutoSync(
  cg: Cartograph,
  f: import('../freshness.js').FreshnessInfo,
): Promise<{ banner: string | null; freshnessMeta: import('./tool-types.js').FreshnessMetadata | null }> {
  try {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('auto-sync timeout')), AUTO_SYNC_TIMEOUT_MS);
    });
    try {
      await Promise.race([cg.sync({ summarize: false }), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const f2 = cg.stats.getFreshness();
    const syncedCount = freshnessSyncCandidateCount(f);
    return {
      banner: `> ✓ Auto-synced ${syncedCount ?? '?'} file(s) before query.`,
      freshnessMeta: f2 ? toFreshnessMetadata(f2, { autoSynced: true }) : null,
    };
  } catch {
    // Auto-sync timed out or threw. Fall back to the original stale
    // banner BUT extend it with explicit MCP-side remediation guidance
    // — the original banner says "run cartograph sync" (CLI), which is
    // not what an agent reading the banner from MCP should do.
    const cliHint = /run `cartograph sync`\.?$/;
    const baseBanner = f.banner ? f.banner.replace(cliHint, '').trimEnd() : freshnessRiskBannerForMcp(f);
    const augmented = baseBanner
      ? baseBanner +
        ` Auto-sync exceeded ${AUTO_SYNC_TIMEOUT_MS}ms — call \`cartograph_admin({action: 'sync'})\` to refresh manually.`
      : null;
    return { banner: augmented, freshnessMeta: toFreshnessMetadata(f) };
  }
}

/**
 * Pre-flight freshness handling. Tools with `bypassFreshnessGate` skip
 * the gate entirely so it doesn't deadlock the only way out of a
 * heavily-stale state.
 */
interface FreshnessGateInput {
  readonly cg: Cartograph | null;
  readonly mod: ToolModule | undefined;
  readonly allowStale: boolean;
  readonly args: Record<string, unknown>;
}

async function toolHandlerRunFreshnessGate(input: FreshnessGateInput): Promise<FreshnessGateOutcome> {
  const { cg, mod, allowStale, args } = input;
  if (!cg || mod?.bypassFreshnessGate) return PASS_THROUGH;
  const f = cg.stats.getFreshness();
  if (!f) return PASS_THROUGH;

  if (!allowStale && hasFreshnessRisk(f) && toolRequiresFreshIndex(mod, args)) {
    if (shouldAutoSync(f)) {
      const synced = await toolHandlerAttemptAutoSync(cg, f);
      if (!metadataHasFreshnessRisk(synced.freshnessMeta)) {
        return { blockResult: null, ...synced };
      }
    }
    return {
      blockResult: {
        ...errorResult(
          `This tool requires a fresh index because stale graph data can produce misleading results — ${describeDrift(f)}. ` +
            `Call \`cartograph_admin({action: 'sync'})\` first, or pass \`allowStale: true\` if you intentionally want the cached view.`,
        ),
        metadata: { freshness: toFreshnessMetadata(f, { blocked: true }) },
      },
      banner: null,
      freshnessMeta: null,
    };
  }

  if (!allowStale && hasFreshnessRisk(f) && shouldBlockOnHeavyDrift(f)) {
    return {
      blockResult: {
        ...errorResult(
          `Index too stale to safely query — ${describeDrift(f)}. ` +
            `Refusing to serve potentially-wrong results. Call ` +
            `\`cartograph_admin({action: 'sync'})\` first (or run \`cartograph admin sync\` ` +
            `from the shell), or pass \`allowStale: true\` to query the cached view anyway.`,
        ),
        metadata: { freshness: toFreshnessMetadata(f, { blocked: true }) },
      },
      banner: null,
      freshnessMeta: null,
    };
  }

  if (!allowStale && hasFreshnessRisk(f) && shouldAutoSync(f)) {
    const synced = await toolHandlerAttemptAutoSync(cg, f);
    return { blockResult: null, ...synced };
  }

  // Auto-sync skipped (filesChanged outside the auto-sync band, or
  // unknown). The stale banner from freshness.ts ends with "run
  // `cartograph sync`" (CLI). Rewrite to MCP-side guidance so an agent
  // reading the banner from the MCP transport gets the right call.
  return { blockResult: null, banner: freshnessRiskBannerForMcp(f), freshnessMeta: toFreshnessMetadata(f) };
}

function toolRequiresFreshIndex(mod: ToolModule | undefined, args: Record<string, unknown>): boolean {
  const flag = mod?.requiresFreshIndex;
  if (typeof flag === 'function') return flag(args);
  return flag === true;
}

/** Rewrite the freshness.ts CLI hint suffix to point at the MCP tool
 *  the agent should actually call. Idempotent — leaves banners that
 *  don't end with the CLI hint untouched. */
function rewriteStaleBannerForMcp(banner: string | null): string | null {
  if (!banner) return banner;
  const cliHint = /run `cartograph sync`\.?$/;
  if (!cliHint.test(banner)) return banner;
  return banner.replace(cliHint, "call `cartograph_admin({action: 'sync'})`.");
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
    const filtered = tools.filter((t) => !toolHandlerIsDisabled(this.options, t.name));
    if (!this.cg) return filtered;
    try {
      const stats = this.cg.stats.getStats();
      const budget = getExploreBudget(stats.fileCount);
      return filtered.map((tool) => {
        if (tool.name === 'cartograph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return filtered;
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
            '(b) run `cartograph init` in the current directory, or ' +
            '(c) pass `projectPath` pointing to a directory that already has .cartograph/.',
        );
      }
      return this.cg;
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

    // Every tool is `defineTool`-backed: `safeParse` does structural
    // validation, and a separate scan reports unknown (typo'd) args
    // that Zod would otherwise strip silently. See `validateToolArgs`.
    const validation = validateToolArgs(mod!, args);
    if (!validation.ok) {
      return errorResult(`Invalid arguments for \`${toolName}\`: ${validation.error}`);
    }

    let result: ToolResult;
    try {
      result = await mod!.handle(this.makeCtx(opts), args);
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
    }
    if (gate.freshnessMeta && !result.isError) {
      result = { ...result, metadata: { ...result.metadata, freshness: gate.freshnessMeta } };
    }
    return result;
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

/** Outcome of {@link validateToolArgs} — the shape `execute` consumes. */
type ToolArgValidation = { ok: true; warnings?: string[] } | { ok: false; error: string };

/**
 * Validate a tool call's raw args against the tool's schema.
 *
 * Structural validation (type / range / enum / required) is Zod's job:
 * every tool is `defineTool`-backed, so `getZodSchema` returns a schema
 * and `safeParse` rejects out-of-range numbers (the locked P3 decision)
 * with a `formatZodError` message. A module with no Zod schema (none
 * exist post-campaign — `defineTool` is the only tool factory) skips
 * structural validation but still gets the unknown-arg scan below.
 *
 * Unknown-argument warnings run regardless: Zod silently STRIPS keys it
 * doesn't declare, so without {@link collectUnknownArgWarnings} an agent
 * that passed a misspelled arg name would get no nudge. The warnings
 * are advisory — they never fail the call.
 */
function validateToolArgs(mod: ToolModule, args: Record<string, unknown>): ToolArgValidation {
  const zodSchema = getZodSchema(mod);
  if (zodSchema) {
    const parsed = zodSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: formatZodError(parsed.error, args ?? {}) };
    }
  }
  const warnings = collectUnknownArgWarnings(args, mod.definition.inputSchema);
  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
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

/** Auto-sync threshold: bumped from 5 → 50 to absorb a session's worth
 *  of edits when the file watcher missed them (e.g. watcher debounce
 *  edge case, an early-session window before the watcher subscribed,
 *  or a non-watcher-managed write like a rebase). Still bounded by
 *  AUTO_SYNC_TIMEOUT_MS so a worst-case sync can't turn a tool call
 *  into a multi-second hang. */
const AUTO_SYNC_MAX_FILES = 50;
/** Wall-clock budget for the inline auto-sync. Beyond this we abort the
 *  attempt and fall through to the banner so a slow sync doesn't turn a
 *  tool call into a multi-second hang on large monorepos. Bumped from
 *  3s to 10s 2026-05-10: a structural-only sync on a 580-file repo
 *  with 15 changed files runs in ~1s, but the bundled post-hooks
 *  (centrality, biomarkers, hnsw rebuild) can push the wall clock past
 *  3s mid-session. The 10s ceiling matches `cg.sync({summarize: false})`'s
 *  observed worst case on this codebase while keeping the failure mode
 *  bounded for monorepo callers. */
const AUTO_SYNC_TIMEOUT_MS = 10_000;
/** Block-on-heavy thresholds: too many files OR too many commits behind. */
const BLOCK_MAX_FILES = 100;
const BLOCK_MAX_COMMITS = 20;

function contentDriftCount(f: import('../freshness.js').FreshnessInfo): number {
  return f.contentDriftedFiles ?? 0;
}

function hasFreshnessRisk(f: import('../freshness.js').FreshnessInfo): boolean {
  return f.isStale || contentDriftCount(f) > 0;
}

function metadataHasFreshnessRisk(meta: import('./tool-types.js').FreshnessMetadata | null): boolean {
  return meta?.recommendedAction === 'sync' || meta?.recommendedAction === 'sync_required';
}

function freshnessSyncCandidateCount(f: import('../freshness.js').FreshnessInfo): number | null {
  if (f.filesChanged != null && f.filesChanged > 0) return f.filesChanged;
  const drifted = contentDriftCount(f);
  return drifted > 0 ? drifted : null;
}

function shouldAutoSync(f: import('../freshness.js').FreshnessInfo): boolean {
  const candidates = freshnessSyncCandidateCount(f);
  if (candidates == null) return false;
  return candidates <= AUTO_SYNC_MAX_FILES;
}

function shouldBlockOnHeavyDrift(f: import('../freshness.js').FreshnessInfo): boolean {
  if (f.filesChanged != null && f.filesChanged > BLOCK_MAX_FILES) return true;
  if (contentDriftCount(f) > BLOCK_MAX_FILES) return true;
  if (f.commitsAhead != null && f.commitsAhead > BLOCK_MAX_COMMITS) return true;
  return false;
}

function describeDrift(f: import('../freshness.js').FreshnessInfo): string {
  const bits: string[] = [];
  if (f.commitsAhead != null) bits.push(`${f.commitsAhead} commits ahead`);
  if (f.filesChanged != null && f.filesChanged > 0) bits.push(`${f.filesChanged} files changed`);
  const drifted = contentDriftCount(f);
  if (drifted > 0) bits.push(`${drifted} content-drifted file${drifted === 1 ? '' : 's'}`);
  return bits.length > 0 ? bits.join(', ') : 'large drift';
}

function freshnessRiskBannerForMcp(f: import('../freshness.js').FreshnessInfo): string | null {
  const rewritten = rewriteStaleBannerForMcp(f.banner);
  if (rewritten) return rewritten;
  const drifted = contentDriftCount(f);
  if (drifted <= 0) return null;
  return (
    `> ⚠ Index content drift — ${drifted} file${drifted === 1 ? '' : 's'} content-drifted on disk vs indexed ` +
    "`content_hash`; call `cartograph_changed_since` to inspect paths, then `cartograph_admin({action: 'sync'})`."
  );
}

function toFreshnessMetadata(
  f: import('../freshness.js').FreshnessInfo,
  extra?: { autoSynced?: boolean; blocked?: boolean },
): import('./tool-types.js').FreshnessMetadata {
  const metadata: import('./tool-types.js').FreshnessMetadata = {
    isStale: f.isStale,
    severity: f.severity,
    indexedSha: f.indexedSha,
    currentSha: f.currentSha,
    filesChanged: f.filesChanged,
    contentDriftedFiles: f.contentDriftedFiles,
    commitsAhead: f.commitsAhead,
    breakdown: f.breakdown,
    recommendedAction: freshnessRecommendedAction(f, extra),
  };
  if (extra) Object.assign(metadata, extra);
  return metadata;
}

function freshnessRecommendedAction(
  f: import('../freshness.js').FreshnessInfo,
  extra?: { autoSynced?: boolean; blocked?: boolean },
): import('./tool-types.js').FreshnessMetadata['recommendedAction'] {
  if (extra?.blocked || shouldBlockOnHeavyDrift(f)) return 'sync_required';
  if (hasFreshnessRisk(f)) return 'sync';
  if (extra?.autoSynced) return 'none';
  return 'none';
}
