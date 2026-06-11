/**
 * Cartograph MCP Server
 *
 * Model Context Protocol server that exposes Cartograph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'cartograph/mcp';
 *
 * // New (object) signature — preferred:
 * const server = new MCPServer({ projectPath: '/path/to/project' });
 * await server.start();
 *
 * // Legacy bare-string form is still accepted for backward compat:
 * const legacy = new MCPServer('/path/to/project');
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Cartograph, { findNearestCartographRoot } from '../index.js';
import { StdioTransport, type JsonRpcRequest, type JsonRpcNotification, ErrorCodes } from './transport.js';
import { ToolHandler } from './tools.js';
import { getToolModule } from './tools/registry.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { errMsg, logDebug } from '../errors.js';
import { TraceLogger } from '../trace/logger.js';
import { runStartupSync } from './startup-sync.js';
import { checkSchemaCompat, formatSchemaMismatch } from './schema-guard.js';
import { resolveMcpServerProfile, type McpServerProfile } from './profiles.js';

/**
 * Convert a file:// URI to a filesystem path.
 * Handles URL encoding and Windows drive letter paths.
 */
function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    // On Windows, file:///C:/path produces pathname /C:/path — strip leading /
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return path.resolve(filePath);
  } catch {
    // Fallback for non-standard URIs — still resolve through path.resolve
    // so a malformed `file:///../etc/passwd` is normalized rather than
    // returned raw to downstream filesystem code.
    return path.resolve(uri.replace(/^file:\/\/\/?/, ''));
  }
}

/**
 * MCP Server Info
 */
const SERVER_INFO = {
  name: 'cartograph',
  version: '0.1.0',
};

/**
 * MCP Protocol Version
 */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * MCP Server for Cartograph
 *
 * Implements the Model Context Protocol to expose Cartograph
 * functionality as tools that can be called by AI assistants.
 */
// `| undefined` is intentional on every field — under
// `exactOptionalPropertyTypes: true`, `prop?: T` rejects callers
// that pass `prop: undefined` literally. Adding `| undefined` lets
// `new MCPServer({ projectPath: maybeUndef })` type-check without
// forcing every caller to conditional-spread.
interface MCPServerOptions {
  /** Default project path. Falls back to the client's rootUri at initialize time. */
  projectPath?: string | undefined;
  /** Named advertised-tool profile. Defaults to `core`. */
  profile?: McpServerProfile | undefined;
  /**
   * Disable every write-class tool/branch (sync, embed, summarize).
   * Sandboxed-agent setups use this to keep the agent read-only on the
   * graph. `profile: 'read-only'` implies the same execution gate.
   */
  disableWriteTools?: boolean | undefined;
  /** Disable specific tools by name. Composes with `disableWriteTools`. */
  disabledTools?: ReadonlySet<string> | undefined;
  /**
   * Default value of `allowStale` for tool calls that don't pass one.
   * The caller's explicit arg always wins.
   */
  allowStaleDefault?: boolean | undefined;
  /**
   * Default `lowTokens: true` for supported high-volume tool calls
   * that don't pass one. The caller's explicit arg always wins.
   */
  lowTokensDefault?: boolean | undefined;
  /**
   * Skip the catch-up `sync()` that normally runs once after the
   * default project opens. The watcher catches LIVE filesystem
   * events, but doesn't backfill drift accumulated while the server
   * was down — startup sync closes that gap. Set true only when
   * sync cost at boot is unacceptable (very large repos with
   * frequent restarts) and you'd rather see stale results than wait.
   */
  disableStartupSync?: boolean | undefined;
  /** Internal/test hook: use a non-stdio transport. */
  transport?: StdioTransport | undefined;
}

// ---------------------------------------------------------------------------
// Module-scope helpers for MCPServer
// ---------------------------------------------------------------------------

/** Mutable runtime state for one MCPServer instance. */
interface McpServerState {
  cg: Cartograph | null;
  projectPath: string | null;
  traceLogger: TraceLogger | null;
  /** Non-null when boot failed to find a default project. */
  noDefaultProjectPreamble: string | null;
}

/** Stand up the trace logger once we have a working project + DB. */
function mcpEnsureTraceLogger(st: McpServerState, disableTrace: boolean): void {
  if (disableTrace || st.traceLogger || !st.cg) return;
  try {
    st.traceLogger = new TraceLogger(st.cg.queries);
  } catch (err) {
    logDebug('MCPServer: TraceLogger setup failed', { err: errMsg(err) });
  }
}

/** Close any previously-failed Cartograph instance + null the field. */
function mcpClosePreviousCgQuietly(st: McpServerState): void {
  if (!st.cg) return;
  try {
    st.cg.close();
  } catch {
    /* ignore */
  }
  st.cg = null;
}

/** Start file watching on the active Cartograph instance. */
function mcpStartWatching(st: McpServerState): void {
  if (!st.cg) return;
  const compat = checkSchemaCompat(st.cg);
  if (!compat.ok) {
    process.stderr.write(`[Cartograph MCP] ${formatSchemaMismatch(compat)} File watcher NOT started.\n`);
    return;
  }
  // F#60 — `CARTOGRAPH_WATCH_DEBOUNCE_MS` env override. Bursty
  // workspaces (formatter-on-save chains, multi-file refactors) can
  // raise the quiet window past the 2000ms default without rebuilding
  // the agent's command line. Clamp range [100ms, 60s]; out-of-range
  // or non-numeric values fall back to the FileWatcher default and
  // the active value is logged so the operator can confirm it took.
  const debounceMs = parseDebounceEnv(process.env['CARTOGRAPH_WATCH_DEBOUNCE_MS']);
  const startOpts: Parameters<typeof st.cg.watcher.start>[0] = {
    onSyncComplete: (result) => {
      if (result.filesChanged > 0) {
        process.stderr.write(`[Cartograph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`);
      }
    },
    onSyncError: (err) => {
      process.stderr.write(`[Cartograph MCP] Auto-sync error: ${err.message}\n`);
    },
  };
  if (debounceMs !== undefined) startOpts.debounceMs = debounceMs;
  const started = st.cg.watcher.start(startOpts);
  if (started) {
    const debounceLabel = debounceMs === undefined ? '' : ` (debounceMs=${debounceMs})`;
    process.stderr.write(`[Cartograph MCP] File watcher active — graph will auto-sync on changes${debounceLabel}\n`);
  }
}

/**
 * Parse the `CARTOGRAPH_WATCH_DEBOUNCE_MS` env value.
 *
 * Returns the parsed millisecond count when the value is an integer in
 * [100, 60_000]; otherwise undefined so the FileWatcher default (2000ms)
 * applies. Rejects floats / Infinity / NaN / out-of-range / non-numeric
 * input rather than silently clamping a likely typo — surface intent
 * mismatch instead of hiding it.
 *
 * Scientific notation that resolves to an integer (e.g. `1e3` → 1000)
 * is accepted on the same grounds: `Number('1e3') === 1000` and
 * `Number.isInteger(1000) === true`.
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60_000) return undefined;
  return n;
}

/**
 * Opt-in tool-call audit. This intentionally logs only timestamp, pid, and
 * tool name — no args/results — so operators can debug "what did the MCP
 * client call?" without leaking code or secrets to stderr logs.
 */
export function shouldAuditMcpToolCalls(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CARTOGRAPH_MCP_AUDIT_LOG'];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function formatMcpToolAuditLine(toolName: string, now = new Date(), pid = process.pid): string {
  return `[Cartograph MCP audit] ${now.toISOString()} pid=${pid} tool=${toolName}\n`;
}

function mcpAuditToolCall(toolName: string): void {
  if (!shouldAuditMcpToolCalls()) return;
  process.stderr.write(formatMcpToolAuditLine(toolName));
}

/**
 * Emit a stderr warning when the MCP server boots without a default project.
 * Sets `st.noDefaultProjectPreamble` with the agent-facing hint.
 */
/** Build the agent-facing hint based on found candidate projects. */
function buildNoDefaultProjectHint(candidates: string[], launchPath: string): string {
  if (candidates.length === 0) {
    return (
      `No \`.cartograph/\` index exists at or under \`${launchPath}\`. Auto-sync (file watcher) is NOT running. ` +
      `Ask the user: "Did you start me from a project directory? Cartograph is per-project — the index needs to live in the project's own folder. ` +
      `Should I run \`cartograph index\` here, or do you want to restart Claude Code from inside an already-indexed project?"`
    );
  } else if (candidates.length === 1) {
    const only = candidates[0]!;
    return (
      `MCP server booted at \`${launchPath}\` which has no \`.cartograph/\`. Auto-sync (file watcher) is NOT running ` +
      `for any project. Found ONE indexed sub-project: \`${only}\`. ` +
      `Ask the user: "It looks like you launched me from \`${launchPath}\` but the cartograph project lives in \`${only}\`. ` +
      `Want me to use that as the default? You'd need to restart with \`cartograph serve --mcp --project-path "${only}"\` in your MCP config."`
    );
  } else {
    const list = candidates.map((c) => `\`${c}\``).join(', ');
    return (
      `MCP server booted at \`${launchPath}\` which has no \`.cartograph/\`. Auto-sync (file watcher) is NOT running ` +
      `for any project. Multiple indexed sub-projects found: ${list}. ` +
      `Ask the user: "Which project should I focus on? You can restart Claude Code with \`cartograph serve --mcp --project-path "<chosen>"\` in your MCP config to make queries fast and the index auto-sync."`
    );
  }
}

/** Write stderr warnings for the missing default project scenario. */
function writeNoDefaultProjectWarnings(candidates: string[], launchPath: string): void {
  process.stderr.write(
    `[Cartograph MCP] No \`.cartograph/\` at or above ${launchPath} — server has no default project.\n`,
  );
  if (candidates.length === 0) {
    process.stderr.write(
      `[Cartograph MCP] No cartograph projects found in immediate subdirectories either. ` +
        `Run \`cartograph index\` in your project, then restart this server inside that project ` +
        `(or pass \`--project-path /path/to/project\`).\n`,
    );
  } else if (candidates.length === 1) {
    const only = candidates[0]!;
    process.stderr.write(
      `[Cartograph MCP] Did you mean to use \`${only}\` as the default project? ` +
        `Restart with: cartograph serve --mcp --project-path "${only}"\n`,
    );
  } else {
    process.stderr.write(
      `[Cartograph MCP] Found ${candidates.length} candidate cartograph projects in immediate subdirectories:\n`,
    );
    for (const c of candidates) process.stderr.write(`  - ${c}\n`);
    process.stderr.write(`[Cartograph MCP] Restart with: cartograph serve --mcp --project-path "<one of the above>"\n`);
  }
  process.stderr.write(
    `[Cartograph MCP] Without a default project, agent queries must pass \`projectPath\` per call ` +
      `and auto-sync via the file watcher only kicks in after the first explicit-project query (capped at ${16} active projects).\n`,
  );
}

function mcpWarnNoDefaultProject(st: McpServerState, launchPath: string): void {
  let candidates: string[] = [];
  try {
    const entries = fs.readdirSync(launchPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const childCg = path.join(launchPath, e.name, '.cartograph');
      if (fs.existsSync(childCg)) candidates.push(path.join(launchPath, e.name));
    }
  } catch {
    candidates = [];
  }

  writeNoDefaultProjectWarnings(candidates, launchPath);
  const agentHint = buildNoDefaultProjectHint(candidates, launchPath);

  st.noDefaultProjectPreamble =
    `\n\n## ⚠ Cartograph setup warning\n\n${agentHint}\n\n` +
    `Until that's resolved: every cartograph_* call must pass \`projectPath: "/full/abs/path"\` explicitly, ` +
    `and your edits won't auto-sync into the index between turns. The first query to any project starts ` +
    `its watcher (capped at 16 active projects), so subsequent queries to that same project will reflect ` +
    `your edits — but only after the first call to it.`;
}

/** Build the optional `onProgress` callback for the tool dispatch. */
function mcpMakeProgressForwarder(
  transport: StdioTransport,
  progressToken: string | number | undefined,
): ((current: number, total?: number, message?: string) => void) | undefined {
  if (progressToken === undefined) return undefined;
  return (current: number, total?: number, message?: string): void => {
    transport.notify('notifications/progress', {
      progressToken,
      progress: current,
      ...(total === undefined ? {} : { total }),
      ...(message === undefined ? {} : { message }),
    });
  };
}

/**
 * Dispatch table for JSON-RPC request methods.
 * Each entry handles one method when the incoming message is a request
 * (has an `id`). Notification-only methods (e.g. `initialized`) are
 * absent — they are silently dropped by the default branch below.
 */
const REQUEST_HANDLERS: Record<
  string,
  (server: MCPServer, transport: StdioTransport, req: JsonRpcRequest) => Promise<void>
> = {
  initialize: mcpHandleInitialize,
  'resources/list': mcpHandleResourcesList,
  'resources/templates/list': mcpHandleResourceTemplatesList,
  'prompts/list': mcpHandlePromptsList,
  'tools/list': mcpHandleToolsList,
  'tools/call': mcpHandleToolsCall,
  ping: (_, transport, req) => {
    transport.sendResult(req.id, {});
    return Promise.resolve();
  },
};

/** Handle incoming JSON-RPC messages. */
async function mcpHandleMessage(
  server: MCPServer,
  transport: StdioTransport,
  message: JsonRpcRequest | JsonRpcNotification,
): Promise<void> {
  const isRequest = 'id' in message;
  const handler = REQUEST_HANDLERS[message.method];
  if (handler) {
    if (isRequest) await handler(server, transport, message);
    return;
  }
  // Unknown method: return MethodNotFound for requests; silently drop notifications.
  if (isRequest) {
    transport.sendError(message.id, {
      code: ErrorCodes.MethodNotFound,
      message: `Method not found: ${message.method}`,
    });
  }
}

/**
 * Resolve the project path from an initialize request's params,
 * falling back through rootUri → workspaceFolders[0] → cwd.
 */
function resolveInitProjectPath(
  serverProjectPath: string | undefined,
  params: { rootUri?: string; workspaceFolders?: Array<{ uri: string; name: string }> } | undefined,
): string {
  if (serverProjectPath) return serverProjectPath;
  if (params?.rootUri) return fileUriToPath(params.rootUri);
  if (params?.workspaceFolders?.[0]?.uri) return fileUriToPath(params.workspaceFolders[0].uri);
  return process.cwd();
}

/** Build the instructions string for an initialize response. */
function buildInitInstructions(preamble: string | null | undefined): string {
  return preamble ? `${SERVER_INSTRUCTIONS}${preamble}` : SERVER_INSTRUCTIONS;
}

/** Handle initialize request. */
async function mcpHandleInitialize(
  server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  const params = request.params as
    | {
        rootUri?: string;
        workspaceFolders?: Array<{ uri: string; name: string }>;
      }
    | undefined;

  const projectPath = resolveInitProjectPath(server.st.projectPath ?? undefined, params);
  await server.tryInitializeDefault(projectPath);

  transport.sendResult(request.id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: SERVER_INFO,
    instructions: buildInitInstructions(server.st.noDefaultProjectPreamble),
  });
}

async function mcpHandleResourcesList(
  _server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  transport.sendResult(request.id, { resources: [] });
}

async function mcpHandleResourceTemplatesList(
  _server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  transport.sendResult(request.id, { resourceTemplates: [] });
}

async function mcpHandlePromptsList(
  _server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  transport.sendResult(request.id, { prompts: [] });
}

/** Handle tools/list request. */
async function mcpHandleToolsList(
  server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  await server.retryInitIfNeeded();
  transport.sendResult(request.id, { tools: server.toolHandler.getTools() });
}

/** Handle tools/call request. */
async function mcpHandleToolsCall(
  server: MCPServer,
  transport: StdioTransport,
  request: JsonRpcRequest,
): Promise<void> {
  const params = request.params as {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: { progressToken?: string | number };
  };

  if (!params?.name) {
    transport.sendError(request.id, { code: ErrorCodes.InvalidParams, message: 'Missing tool name' });
    return;
  }

  const toolName = params.name;
  const toolArgs = params.arguments || {};

  const tool = getToolModule(toolName)?.definition;
  if (!tool) {
    transport.sendError(request.id, { code: ErrorCodes.InvalidParams, message: `Unknown tool: ${toolName}` });
    return;
  }

  mcpAuditToolCall(toolName);
  await server.retryInitIfNeeded();
  mcpEnsureTraceLogger(server.st, server.disableTrace);

  const onProgress = mcpMakeProgressForwarder(transport, params._meta?.progressToken);
  const t0 = Date.now();
  const result = await server.toolHandler.execute(toolName, toolArgs, onProgress ? { onProgress } : undefined);
  const durationMs = Date.now() - t0;

  try {
    if (server.st.traceLogger) server.st.traceLogger.log({ toolName, args: toolArgs, result, durationMs });
  } finally {
    transport.sendResult(request.id, result);
  }
}

// ---------------------------------------------------------------------------
// Class — lifecycle orchestrator
// ---------------------------------------------------------------------------

export class MCPServer {
  /** @internal — exposed for module-scope helpers only. */
  readonly st: McpServerState;
  private readonly transport: StdioTransport;
  private readonly activeTransports = new Set<StdioTransport>();
  /** @internal */
  readonly toolHandler: ToolHandler;
  /** @internal */
  readonly disableTrace: boolean;
  private readonly disableStartupSync: boolean;

  constructor(optionsOrPath: MCPServerOptions | string = {}) {
    const options: MCPServerOptions =
      typeof optionsOrPath === 'string' ? { projectPath: optionsOrPath } : optionsOrPath;

    this.st = {
      cg: null,
      projectPath: options.projectPath ?? null,
      traceLogger: null,
      noDefaultProjectPreamble: null,
    };
    this.transport = options.transport ?? new StdioTransport();
    this.disableTrace = options.disableWriteTools === true || resolveMcpServerProfile(options.profile) === 'read-only';
    this.disableStartupSync = options.disableStartupSync === true;
    this.toolHandler = new ToolHandler(null, {
      profile: options.profile,
      disableWriteTools: options.disableWriteTools,
      disabledTools: options.disabledTools,
      allowStaleDefault: options.allowStaleDefault,
      lowTokensDefault: options.lowTokensDefault,
      disableStartupSync: options.disableStartupSync,
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    this.attachTransport(this.transport);
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
    process.stdin.on('end', () => this.stop());
    process.stdin.on('close', () => this.stop());
  }

  /** Attach an additional JSON-RPC transport to this server instance.
   *  Used by the shared daemon to serve multiple socket clients through
   *  one Cartograph connection, watcher, trace logger, and tool cache. */
  attachTransport(transport: StdioTransport): void {
    this.activeTransports.add(transport);
    transport.start((msg) => mcpHandleMessage(this, transport, msg));
  }

  detachTransport(transport: StdioTransport): void {
    if (!this.activeTransports.delete(transport)) return;
    transport.stop();
  }

  /**
   * Try to initialize Cartograph for the default project.
   * @internal exposed for mcpHandleInitialize
   */
  async tryInitializeDefault(projectPath: string): Promise<void> {
    const resolvedRoot = findNearestCartographRoot(projectPath);

    if (!resolvedRoot) {
      mcpWarnNoDefaultProject(this.st, projectPath);
      this.st.projectPath = projectPath;
      return;
    }
    this.st.noDefaultProjectPreamble = null;
    this.st.projectPath = resolvedRoot;

    try {
      // The MCP server IS the long-lived process whose schema-vs-binary
      // alignment matters; opening with autoMigrate=true is correct
      // here — the server is the writer that will fan out tool calls
      // against this DB. The schema-guard (B4) catches the opposite
      // direction (DB ahead of binary) at every tool dispatch.
      this.st.cg = await Cartograph.open(resolvedRoot, { autoMigrate: true });
      this.toolHandler.setDefaultCartograph(this.st.cg);
      await this.runStartupSync();
      mcpStartWatching(this.st);
    } catch (err) {
      process.stderr.write(`[Cartograph MCP] Failed to open project at ${resolvedRoot}: ${errMsg(err)}\n`);
    }
  }

  /** Wraps runStartupSync with this server's CG + flag. */
  private async runStartupSync(): Promise<void> {
    if (!this.st.cg) return;
    await runStartupSync(this.st.cg, {
      disabled: this.disableStartupSync,
      log: (msg) => process.stderr.write(msg),
    });
  }

  /**
   * Retry initialization of the default project if it previously failed.
   * @internal exposed for mcpHandleToolsList / mcpHandleToolsCall
   */
  async retryInitIfNeeded(): Promise<void> {
    if (this.toolHandler.hasDefaultCartograph()) return;
    if (!this.st.projectPath) return;

    const resolvedRoot = findNearestCartographRoot(this.st.projectPath);
    if (!resolvedRoot) return;

    try {
      mcpClosePreviousCgQuietly(this.st);
      // Match tryInitializeDefault's autoMigrate policy — the MCP
      // server is the long-lived writer, so on the retry path we
      // also opt in to auto-migration. Without this flag, a stale-
      // schema DB at retry time would throw "Refusing to silently
      // migrate", get swallowed by the catch below, and leave the
      // server permanently without a default project.
      this.st.cg = Cartograph.openSync(resolvedRoot, { autoMigrate: true });
      this.st.projectPath = resolvedRoot;
      this.toolHandler.setDefaultCartograph(this.st.cg);
      await this.runStartupSync();
      mcpStartWatching(this.st);
    } catch {
      // Still failing — will retry on next tool call
    }
  }

  /**
   * Stop the server
   */
  stop(exitProcess = true): void {
    this.toolHandler.closeAll();
    if (this.st.cg) {
      this.st.cg.close();
      this.st.cg = null;
    }
    for (const transport of this.activeTransports) {
      transport.stop();
    }
    this.activeTransports.clear();
    // No in-process LLM cache drainers to run any more — the
    // ggml-Metal cleanup choreography went away with the in-process
    // pathway deletion (2026-05-24c). HTTP clients hold no native
    // resources; fetch handles its own cleanup at the request layer.
    if (exitProcess) process.exit(0);
  }
}

// Export for use in CLI
export { StdioTransport, SocketTransport } from './transport.js';
export { tools, ToolHandler } from './tools.js';
