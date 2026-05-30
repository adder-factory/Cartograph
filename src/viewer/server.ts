/**
 * cartograph viewer — local HTTP server
 *
 * Serves the Cytoscape.js viewer (src/viewer/static/index.html) plus a
 * small JSON API backed by a read-only QueryBuilder over the project's
 * `.cartograph/cartograph.db`. No authentication and no write paths —
 * intended to bind to localhost only and surface what's already in the
 * graph.
 *
 * Endpoints:
 *   GET /                      — viewer HTML
 *   GET /api/status            — project root + counts + indexed-at
 *   GET /api/graph?focus=…     — local subgraph around a focus symbol
 *   GET /api/symbol/:id        — full detail for one symbol
 *
 * Lifecycle is symmetric to MCPServer: `startViewerServer` returns a
 * handle with a `close()` for cleanup. Tests use port 0 to get a random
 * free port from the OS.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import Cartograph from '../index.js';
import { DatabaseConnection, getDatabasePath } from '../db/index.js';
import { QueryBuilder } from '../db/queries.js';
import { GraphTraverser } from '../graph/traversal.js';
import { getNodesByName, getNodesByLowerName } from '../db/queries-search.js';
import { getFindingsForNode, getFindingsStats, getFindingsRanked } from '../db/queries-findings.js';
import { BIOMARKER_NAMES } from '../biomarkers/types.js';
import { getFileByPath } from '../db/queries-files.js';
import { getNodeCoverage } from '../db/queries-coverage.js';
import { getNodeMetrics } from '../db/queries-metrics.js';
import { getHotspots } from '../db/queries-history.js';
import { getMetadata } from '../db/queries-metadata.js';
import { recentSessions, callsForSession } from '../db/queries-trace.js';
import type { Node, NodeKind } from '../types.js';
import { logDebug, errMsg } from '../errors.js';
import { getStats as qbGetStats, getNodesByKind } from '../db/queries.js';

export interface ViewerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface ViewerOptions {
  /** Port to bind to. Pass 0 to let the OS pick a free port. Default 8765. */
  port?: number;
  /** Bind host. Default '127.0.0.1' (localhost-only — there's no auth). */
  host?: string;
}

/** Resolved at module load — same dir whether running from src/ or dist/. */
const STATIC_DIR = path.resolve(import.meta.dirname, 'static');

/** Default viewer port. Picked to not collide with common dev servers. */
const DEFAULT_PORT = 8765;

/** URL scheme used to print the bind address back to the caller and to
 *  give `new URL()` a base for relative-path parsing. Module-scoped so
 *  per-request handlers don't carry literal URLs. */
const HTTP_SCHEME = 'http://';

/** Dummy base for resolving relative request URLs — `req.url` arrives
 *  path-only, but the URL constructor needs a base. The host doesn't
 *  matter; we only read `pathname` afterwards. */
const URL_PARSE_BASE = `${HTTP_SCHEME}localhost`;

// ──────────────────────────────────────────────────────────────────────
// HTTP status codes used by this server. Named so the call sites
// document themselves and a stray numeric writeHead literal stands
// out in review.
// ──────────────────────────────────────────────────────────────────────
/** 200 OK. */
const HTTP_OK = 200;
/** 400 Bad Request. */
const HTTP_BAD_REQUEST = 400;
/** 404 Not Found. */
const HTTP_NOT_FOUND = 404;
/** 405 Method Not Allowed. */
const HTTP_METHOD_NOT_ALLOWED = 405;
/** 500 Internal Server Error. */
const HTTP_INTERNAL_ERROR = 500;
/** 503 Service Unavailable. */
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * Triple `{min, max, default}` used by `clampInt`. Carrying the bound
 * as one typed value rules out the misorder-prone `clampInt(v, min,
 * max, fallback)` shape — at the call site the bound is named (e.g.
 * `GRAPH_DEPTH`), at the helper site there's only one parameter to
 * read.
 */
interface IntBound {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

// Per-endpoint integer-query bounds. Ranges chosen so a wild query
// string can't pull in an unbounded number of nodes/rows.
const GRAPH_DEPTH: IntBound = { min: 1, max: 4, default: 2 };
const HOTSPOTS_LIMIT: IntBound = { min: 1, max: 100, default: 12 };
const BIOMARKER_LIMIT: IntBound = { min: 1, max: 200, default: 50 };
const SESSIONS_LIMIT: IntBound = { min: 1, max: 50, default: 10 };

/** BFS expansion ceiling per direction in `/api/graph` — keeps the
 *  Cytoscape canvas legible (each direction can pull at most this
 *  many nodes; the merged sub+incoming map dedupes overlap). */
const GRAPH_BFS_LIMIT = 60;

// Defense-in-depth caps on /api/ask. Three nested layers: byte cap on
// the request body, char cap per field, retrieval/citation caps on
// the response.

/** Outer byte cap (64 KiB) — `readBody` rejects oversized POSTs
 *  before any parsing. */
const ASK_BODY_BYTE_LIMIT = 64 * 1024;
/** Inner char cap on the question field (8000). */
const ASK_QUESTION_CHAR_LIMIT = 8000;
/** Inner char cap on the optional symbol field (200). */
const ASK_SYMBOL_CHAR_LIMIT = 200;
/** Inner char cap on the optional selection field (8000). */
const ASK_SELECTION_CHAR_LIMIT = 8000;
/** Retrieval-k for hybrid search (12 candidates). */
const ASK_RETRIEVE_K = 12;
/** Citation cap on the assembled answer (8 sources). */
const ASK_CITATION_LIMIT = 8;

// Project Code Health scoring (matches the per-symbol calc).
/** Starting score (10). */
const HEALTH_BASELINE = 10;
/** Score floor (1). */
const HEALTH_FLOOR = 1;
/** Penalty per error finding (2). */
const HEALTH_PENALTY_ERROR = 2;
/** Penalty per warning finding (1). */
const HEALTH_PENALTY_WARNING = 1;
/** Penalty per info finding (0.5). */
const HEALTH_PENALTY_INFO = 0.5;
/** Round-to-one-decimal resolution (10 — divide+floor by this). */
const HEALTH_DECIMAL_RESOLUTION = 10;

/**
 * Start a viewer server bound to localhost. Opens a `DatabaseConnection`
 * via the standard `open()` path (read-write WAL — there is no
 * read-only mode in the adapter today). No write routes are exposed,
 * so the only way the DB gets mutated is if a separate `cartograph
 * sync` runs concurrently via the file watcher; that's safe under WAL.
 *
 * The connection is closed when `handle.close()` is called. Note: the
 * close() promise resolves when the HTTP server stops accepting new
 * connections, not when in-flight requests fully drain. Sync SQLite
 * calls don't yield the event loop so this is safe in practice, but
 * a request that's mid-`JSON.stringify` of a large graph result could
 * race the DB close.
 */
/** Type guard: true when `server.address()` returned an `AddressInfo` object. */
function isAddrObject(addr: ReturnType<import('http').Server['address']>): addr is import('net').AddressInfo {
  return typeof addr === 'object' && addr !== null;
}

/** Listen on the given host+port; resolves when bound, rejects on error. */
function listenServer(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/** Build the ViewerHandle close() that shuts down both server and DB cleanly. */
function makeViewerClose(server: http.Server, ctx: RequestContext, conn: DatabaseConnection): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        try {
          ctx.cg?.close();
        } catch {
          /* idempotent */
        }
        try {
          conn.close();
        } catch {
          /* idempotent */
        }
        resolve();
      });
    });
}

export async function startViewerServer(projectPath: string, opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const dbPath = getDatabasePath(projectPath);
  const dbExists = await fsp
    .access(dbPath)
    .then(() => true)
    .catch(() => false);
  if (!dbExists) {
    throw new Error(`No cartograph DB at ${dbPath} — run \`cartograph init\` and \`cartograph index\` first.`);
  }
  const conn = DatabaseConnection.open(dbPath);
  const queries = new QueryBuilder(conn.getDb());
  const traverser = new GraphTraverser(queries);

  const indexHtml = loadIndexHtml();
  // Single mutable context shared across requests so the lazily-
  // opened Cartograph (used by /api/ask) is reused, not re-opened
  // per request, and close() can tear it down on shutdown.
  const ctx: RequestContext = { projectPath, conn, queries, traverser, indexHtml };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      logDebug('viewer: request handler crashed', { err: errMsg(err) });
      sendJson(res, HTTP_INTERNAL_ERROR, { error: 'internal error' });
    });
  });

  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? DEFAULT_PORT;
  await listenServer(server, host, requestedPort);

  const addr = server.address();
  const port = isAddrObject(addr) ? addr.port : requestedPort;
  const url = `${HTTP_SCHEME}${host}:${port}/`;

  return { url, port, close: makeViewerClose(server, ctx, conn) };
}

/**
 * Best-effort browser-open. Skipped silently if the platform's opener
 * isn't available — the URL is always logged so the user can paste it
 * manually.
 */
export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    logDebug('viewer: openInBrowser failed', { err: errMsg(err) });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

interface RequestContext {
  projectPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  traverser: GraphTraverser;
  indexHtml: string;
  /**
   * Lazy Cartograph handle — only the /api/ask path needs the full
   * service surface (LLM client + hybrid retrieval). Most viewer
   * requests stop at the QueryBuilder, so we avoid the heavier
   * lifecycle on those paths.
   */
  cg?: Cartograph;
}

async function ensureCartograph(ctx: RequestContext): Promise<Cartograph> {
  if (ctx.cg) return ctx.cg;
  ctx.cg = await Cartograph.open(ctx.projectPath);
  return ctx.cg;
}

/** A GET route entry. `match` returns the regex match (or `true`/`null`)
 *  for path-based routing; `handle` runs when matched and writes the
 *  response. The dispatcher walks GET_ROUTES in order, stopping at
 *  the first `match` that returns truthy. */
interface GetRoute {
  match: (path: string) => RegExpExecArray | true | null;
  handle: (m: RegExpExecArray | true, url: URL, res: http.ServerResponse, ctx: RequestContext) => void;
}

const matchExact = (p: string) => (path: string) => (path === p ? true : null);

const GET_ROUTES: ReadonlyArray<GetRoute> = [
  { match: matchExact('/'), handle: (_m, _u, res, ctx) => sendIndexHtml(res, ctx) },
  { match: matchExact('/index.html'), handle: (_m, _u, res, ctx) => sendIndexHtml(res, ctx) },
  { match: matchExact('/api/status'), handle: (_m, _u, res, ctx) => sendJson(res, HTTP_OK, statusPayload(ctx)) },
  {
    match: matchExact('/api/graph'),
    handle: (_m, url, res, ctx) => {
      const focus = url.searchParams.get('focus');
      const depth = clampInt(url.searchParams.get('depth'), GRAPH_DEPTH);
      sendJson(res, HTTP_OK, graphPayload(ctx, focus, depth));
    },
  },
  { match: matchExact('/api/findings'), handle: (_m, _u, res, ctx) => sendJson(res, HTTP_OK, findingsPayload(ctx)) },
  {
    match: matchExact('/api/hotspots'),
    handle: (_m, url, res, ctx) => {
      const limit = clampInt(url.searchParams.get('limit'), HOTSPOTS_LIMIT);
      sendJson(res, HTTP_OK, hotspotsPayload(ctx, limit));
    },
  },
  // /api/findings/<biomarker> — symbols flagged with this biomarker.
  // Used by the chat intent "show me god_class" to filter the graph.
  {
    match: (p) => /^\/api\/findings\/([\w-]+)$/.exec(p),
    handle: (m, url, res, ctx) => {
      const name = (m as RegExpExecArray)[1]!;
      if (!(BIOMARKER_NAMES as readonly string[]).includes(name)) {
        sendJson(res, HTTP_NOT_FOUND, { error: `unknown biomarker: ${name}`, available: BIOMARKER_NAMES });
        return;
      }
      const limit = clampInt(url.searchParams.get('limit'), BIOMARKER_LIMIT);
      sendJson(res, HTTP_OK, biomarkerFindingsPayload(ctx, name, limit));
    },
  },
  {
    match: matchExact('/api/sessions'),
    handle: (_m, url, res, ctx) => {
      const limit = clampInt(url.searchParams.get('limit'), SESSIONS_LIMIT);
      sendJson(res, HTTP_OK, sessionsPayload(ctx, limit));
    },
  },
  {
    match: (p) => /^\/api\/sessions\/([\w-]+)$/.exec(p),
    handle: (m, _u, res, ctx) => {
      sendJson(res, HTTP_OK, sessionDetailPayload(ctx, (m as RegExpExecArray)[1]!));
    },
  },
  {
    match: (p) => /^\/api\/source\/(.+)$/.exec(p),
    handle: (m, _u, res, ctx) =>
      respondWithIdLookup({ rawId: (m as RegExpExecArray)[1]!, res, ctx, lookup: sourcePayload }),
  },
  {
    match: (p) => /^\/api\/symbol\/(.+)$/.exec(p),
    handle: (m, _u, res, ctx) =>
      respondWithIdLookup({ rawId: (m as RegExpExecArray)[1]!, res, ctx, lookup: symbolPayload }),
  },
];

function sendIndexHtml(res: http.ServerResponse, ctx: RequestContext): void {
  res.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ctx.indexHtml);
}

/** Decode the id param, look up via `lookup`, and respond. Pulled out
 *  so the symbol/source endpoints share one closure for the
 *  decode-or-400-then-lookup-or-404-then-200 chain. */
interface RespondWithIdLookupArgs {
  rawId: string;
  res: http.ServerResponse;
  ctx: RequestContext;
  lookup: (ctx: RequestContext, id: string) => unknown;
}

function respondWithIdLookup(args: RespondWithIdLookupArgs): void {
  const { rawId, res, ctx, lookup } = args;
  const id = decodeIdParam(rawId, res);
  if (id === null) return;
  const payload = lookup(ctx, id);
  if (!payload) {
    sendJson(res, HTTP_NOT_FOUND, { error: `unknown symbol: ${id}` });
    return;
  }
  sendJson(res, HTTP_OK, payload);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): Promise<void> {
  // POST /api/ask is the only write-shaped endpoint — every other
  // path is read-only GET.
  if (req.method === 'POST' && req.url === '/api/ask') {
    await handleAskRequest(req, res, ctx);
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method not allowed' });
    return;
  }
  const url = new URL(req.url ?? '/', URL_PARSE_BASE);
  for (const route of GET_ROUTES) {
    const m = route.match(url.pathname);
    if (m === null) continue;
    route.handle(m, url, res, ctx);
    return;
  }
  sendJson(res, HTTP_NOT_FOUND, { error: `not found: ${url.pathname}` });
}

/**
 * Percent-decode a URL path parameter into a symbol id. On malformed
 * input (e.g. `%GG`) this writes a 400 to `res` and returns null —
 * caller's job is just to early-return when null comes back. Keeps the
 * `try { decodeURIComponent } catch { 400 }` pattern in one place.
 */
function decodeIdParam(rawId: string, res: http.ServerResponse): string | null {
  try {
    return decodeURIComponent(rawId);
  } catch {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'malformed symbol id' });
    return null;
  }
}

function statusPayload(ctx: RequestContext): unknown {
  const stats = qbGetStats(ctx.queries);
  // Canonical metadata keys (FRICTION-17): the writers stamp
  // `index_timestamp` (epoch-ms string) + `index_head_sha`. The viewer
  // had been reading `'last_index_at'` / `'last_indexed_head'` — keys
  // nothing writes, so these always returned null.
  const indexedAt = getMetadata(ctx.queries, 'index_timestamp') ?? null;
  const head = getMetadata(ctx.queries, 'index_head_sha') ?? null;
  const languages = Object.keys(stats.filesByLanguage).sort((a, b) => a.localeCompare(b));
  return {
    projectRoot: ctx.projectPath,
    files: stats.fileCount,
    nodes: stats.nodeCount,
    edges: stats.edgeCount,
    indexedAt: indexedAt ? Number(indexedAt) : null,
    head,
    languages,
    nodesByKind: stats.nodesByKind,
  };
}

function graphPayload(ctx: RequestContext, focus: string | null, depth: number): unknown {
  // No focus → BFS the neighborhood of the most-central node so the
  // visible graph is a single connected component. The previous "top
  // 30 by centrality" approach picked hubs from different parts of
  // the codebase; many of them had no edge to any other selected
  // hub, so the canvas filled with isolated singletons. Anchoring on
  // the highest-centrality node and traversing outward guarantees
  // every visible node has at least one visible connection.
  //
  // Reuses the focus-branch payload below by recursing once. Keeps
  // the BFS limit / dedup / both-directions behavior in one place.
  if (!focus) {
    const kinds: NodeKind[] = ['function', 'method', 'class'];
    const all: Node[] = [];
    for (const k of kinds) all.push(...getNodesByKind(ctx.queries, k));
    if (all.length === 0) return { nodes: [], edges: [], focus: null };
    const root = all.sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))[0]!;
    return graphPayload(ctx, root.id, GRAPH_DEPTH.default);
  }

  const focusNode = resolveSymbolToNode(ctx.queries, focus);
  if (!focusNode) {
    return { nodes: [], edges: [], focus: null, error: `unknown symbol: ${focus}` };
  }
  const sub = ctx.traverser.traverseBFS(focusNode.id, {
    maxDepth: depth,
    direction: 'outgoing',
    limit: GRAPH_BFS_LIMIT,
  });
  const incoming = ctx.traverser.traverseBFS(focusNode.id, {
    maxDepth: depth,
    direction: 'incoming',
    limit: GRAPH_BFS_LIMIT,
  });
  const nodes = new Map<string, Node>();
  for (const [id, n] of sub.nodes) nodes.set(id, n);
  for (const [id, n] of incoming.nodes) nodes.set(id, n);
  const edgesById = new Map<string, { source: string; target: string; kind: string }>();
  for (const e of [...sub.edges, ...incoming.edges]) {
    edgesById.set(`${e.source}__${e.target}__${e.kind}`, { source: e.source, target: e.target, kind: e.kind });
  }
  return {
    focus: focusNode.id,
    nodes: [...nodes.values()].map(serializeNode),
    edges: [...edgesById.values()],
  };
}

function findingsPayload(ctx: RequestContext): unknown {
  const stats = qbGetStats(ctx.queries);
  const fStats = getFindingsStats(ctx.queries);
  // Project Code Health: same shape the per-symbol score uses, but
  // averaged across nodesWithFindings + the clean ones (LOC > 1).
  // Penalty weights are the HEALTH_PENALTY_* constants at the top of
  // this file; baseline is HEALTH_BASELINE; floor is HEALTH_FLOOR.
  const errs = fStats.bySeverity['error'] ?? 0;
  const warns = fStats.bySeverity['warning'] ?? 0;
  const infos = fStats.bySeverity['info'] ?? 0;
  const denom = Math.max(1, fStats.nodesWithFindings);
  const penalty = (errs * HEALTH_PENALTY_ERROR + warns * HEALTH_PENALTY_WARNING + infos * HEALTH_PENALTY_INFO) / denom;
  const codeHealth = Math.max(
    HEALTH_FLOOR,
    Math.round((HEALTH_BASELINE - penalty) * HEALTH_DECIMAL_RESOLUTION) / HEALTH_DECIMAL_RESOLUTION,
  );
  return {
    totalFindings: fStats.totalFindings,
    byBiomarker: fStats.byBiomarker,
    bySeverity: fStats.bySeverity,
    nodesWithFindings: fStats.nodesWithFindings,
    totalNodes: stats.nodeCount,
    totalFiles: stats.fileCount,
    codeHealth,
  };
}

function sessionsPayload(ctx: RequestContext, limit: number): unknown {
  const rows = recentSessions(ctx.queries, limit);
  return {
    sessions: rows.map((r) => ({
      id: r.id,
      startedTs: r.startedTs,
      lastActivityTs: r.lastActivityTs,
      toolCount: r.toolCount,
    })),
  };
}

function sessionDetailPayload(ctx: RequestContext, sessionId: string): unknown {
  const calls = callsForSession(ctx.queries, sessionId);
  return {
    sessionId,
    calls: calls.map((c) => ({
      step: c.step,
      ts: c.ts,
      tool: c.toolName,
      args: safeParseJson(c.argsJson),
      result: c.resultSummary,
      durationMs: c.durationMs,
    })),
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function biomarkerFindingsPayload(ctx: RequestContext, biomarker: string, limit: number): unknown {
  const rows = getFindingsRanked(ctx.queries, { biomarker, limit });
  return {
    biomarker,
    findings: rows.map((r) => ({
      id: r.nodeId,
      name: r.name,
      kind: r.kind,
      file: r.filePath,
      severity: r.severity,
      metric: r.metric,
      centrality: r.centrality,
    })),
  };
}

function hotspotsPayload(ctx: RequestContext, limit: number): unknown {
  const rows = getHotspots(ctx.queries, { limit, sortBy: 'risk' });
  return {
    hotspots: rows.map((r) => ({
      filePath: r.filePath,
      centrality: r.fileCentrality,
      commits: r.commitCount,
      loc: r.loc,
      lastTouchedTs: r.lastTouchedTs,
      risk: r.riskScore,
    })),
  };
}

/**
 * POST /api/ask — body: {question, symbol?}. Calls cg.llm.ask(),
 * which runs hybrid retrieval against the index and synthesises an
 * answer with the configured LLM. The optional `symbol` field is
 * folded into the question text so the model knows which node the
 * user is asking about.
 *
 * No streaming yet (the underlying client returns a complete answer
 * synchronously). Errors return shaped JSON that the viewer renders
 * inline — the most common case being "no LLM configured", which
 * we surface with a hint to run `cartograph llm setup`.
 */
/**
 * Compose the LLM prompt by prefixing a symbol context line and
 * appending the source selection block when each is present.
 */
function buildAskPrompt(question: string, symbol: string, selection: string): string {
  const symbolPrefixed = `About \`${symbol}\` (in this codebase): ${question}`;
  let fullQuestion = symbol ? symbolPrefixed : question;
  if (selection) {
    fullQuestion += `\n\nThe user has selected this snippet from the source:\n\`\`\`\n${selection}\n\`\`\``;
  }
  return fullQuestion;
}

/**
 * Map an LLM error to the appropriate HTTP response, flagging the
 * common "no provider configured" case as 503 with an install hint.
 */
function sendAskErrorResponse(res: http.ServerResponse, err: unknown): void {
  const m = errMsg(err);
  const noLlm = /No chat provider configured|not reachable/i.test(m);
  sendJson(res, noLlm ? HTTP_SERVICE_UNAVAILABLE : HTTP_INTERNAL_ERROR, {
    error: m,
    hint: noLlm ? 'Run `cartograph llm setup` and restart the viewer.' : undefined,
  });
}

async function handleAskRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readBody(req, ASK_BODY_BYTE_LIMIT);
  let parsed: { question?: unknown; symbol?: unknown; selection?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'invalid JSON body' });
    return;
  }
  // Defense-in-depth: byte cap (`readBody`) is layer 1; per-field
  // char caps below are layer 2 — even within the byte cap a single
  // field can't balloon the LLM prompt. `selection` truncates
  // silently (matches its prior behavior); `question` / `symbol`
  // also truncate so the contract is consistent across fields.
  const question = clampString(parsed.question, ASK_QUESTION_CHAR_LIMIT);
  const symbol = clampString(parsed.symbol, ASK_SYMBOL_CHAR_LIMIT);
  const selection = clampString(parsed.selection, ASK_SELECTION_CHAR_LIMIT, { trim: false });
  if (!question) {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'question is required' });
    return;
  }
  const fullQuestion = buildAskPrompt(question, symbol, selection);

  let cg: Cartograph;
  try {
    cg = await ensureCartograph(ctx);
  } catch (err) {
    sendJson(res, HTTP_INTERNAL_ERROR, { error: `failed to open project: ${errMsg(err)}` });
    return;
  }

  try {
    const result = await cg.llm.ask(fullQuestion, { retrieveK: ASK_RETRIEVE_K });
    sendJson(res, HTTP_OK, {
      answer: result.answer,
      citations: (result.citations ?? []).slice(0, ASK_CITATION_LIMIT).map((c) => ({
        name: c.node.name,
        kind: c.node.kind,
        file: c.node.filePath,
        line: c.node.startLine,
      })),
    });
  } catch (err) {
    sendAskErrorResponse(res, err);
  }
}

/**
 * Coerce an unknown JSON-parsed field to a length-capped string.
 * Returns '' when the field isn't a string (mirrors the prior
 * `typeof parsed.x === 'string' ? ... : ''` shape). `trim` defaults
 * true — matches how `question`/`symbol` were handled before.
 */
function clampString(v: unknown, max: number, opts: { trim?: boolean } = {}): string {
  if (typeof v !== 'string') return '';
  const trimmed = opts.trim === false ? v : v.trim();
  if (trimmed.length > max) return trimmed.slice(0, max);
  return trimmed;
}

/** Read a request body up to maxBytes. Rejects oversized bodies. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Source payload — the raw lines of the file between the symbol's
 * startLine and endLine (1-indexed inclusive). Borrowed from
 * Sourcetrail's third pane: showing the actual code alongside the
 * graph is the difference between "I see what's connected" and
 * "I see how it works".
 *
 * Path safety: we resolve the file path against the project root
 * and reject anything that escapes (defends against tampered DBs
 * with `../../etc/passwd`-style filePath values).
 */
function sourcePayload(ctx: RequestContext, idOrName: string): unknown | null {
  const node = resolveSymbolToNode(ctx.queries, idOrName);
  if (!node) return null;
  const abs = path.resolve(ctx.projectPath, node.filePath);
  const root = path.resolve(ctx.projectPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return {
      source: '',
      startLine: node.startLine,
      endLine: node.endLine,
      language: node.language,
      error: 'path escapes project root',
    };
  }
  let lines: string[];
  try {
    lines = fs.readFileSync(abs, 'utf-8').split('\n');
  } catch (err) {
    logDebug('viewer: source read failed', { path: node.filePath, err: errMsg(err) });
    return {
      source: '',
      startLine: node.startLine,
      endLine: node.endLine,
      language: node.language,
      error: 'unreadable',
    };
  }
  const start = Math.max(1, node.startLine);
  const end = Math.min(lines.length, node.endLine);
  const slice = lines.slice(start - 1, end).join('\n');
  return {
    source: slice,
    startLine: start,
    endLine: end,
    language: node.language,
    file: node.filePath,
  };
}

function symbolPayload(ctx: RequestContext, idOrName: string): unknown | null {
  const node = resolveSymbolToNode(ctx.queries, idOrName);
  if (!node) return null;
  const callers = ctx.traverser.getCallers(node.id, 1);
  const callees = ctx.traverser.getCallees(node.id, 1);
  const findings = getFindingsForNode(ctx.queries, node.id);
  const file = getFileByPath(ctx.queries, node.filePath);
  return {
    ...serializeNode(node),
    docstring: node.docstring ?? null,
    signature: node.signature ?? null,
    callers: dedupNodes(callers.map((c) => serializeNode(c.node))),
    callees: dedupNodes(callees.map((c) => serializeNode(c.node))),
    findings: findings.map((f) => ({ biomarker: f.biomarker, severity: f.severity, metric: f.metric })),
    metrics: buildMetricsBlock({ ctx, node, findings, file }),
    coverage: buildCoverageBlock(ctx, node.id),
  };
}

/**
 * Coverage payload for one symbol. Returns null when no
 * `node_coverage` row exists (lcov hasn't been loaded, or this
 * symbol's lines weren't represented in any loaded source). When a
 * row exists, surfaces the ratio + raw line counts so the viewer
 * can render either a percent badge or a "12/47 lines" detail.
 */
function buildCoverageBlock(ctx: RequestContext, nodeId: string): Record<string, unknown> | null {
  const row = getNodeCoverage(ctx.queries, nodeId);
  if (!row) return null;
  const ratio = row.totalLines > 0 ? row.coveredLines / row.totalLines : null;
  return {
    source: row.source,
    coveredLines: row.coveredLines,
    totalLines: row.totalLines,
    coveredBranches: row.coveredBranches,
    totalBranches: row.totalBranches,
    ratio,
  };
}

/**
 * Best-effort metrics block. LoC is computed from the node's line
 * range. Cyclomatic + maxNesting come from `node_metrics` when a
 * post-29 analyseProject pass has touched the symbol; on older
 * indexes they fall back to the per-finding metric (only present
 * when the rule fired) and ultimately to null. File churn fields
 * come straight from `files`.
 */
interface BuildMetricsBlockArgs {
  ctx: RequestContext;
  node: Node;
  findings: ReadonlyArray<{ biomarker: string; metric: number }>;
  file: ReturnType<typeof getFileByPath>;
}

function buildMetricsBlock(args: BuildMetricsBlockArgs): Record<string, unknown> {
  const { ctx, node, findings, file } = args;
  const findingMetric = (kind: string): number | null => {
    const m = findings.find((f) => f.biomarker === kind);
    return m ? m.metric : null;
  };
  const persisted = getNodeMetrics(ctx.queries, node.id);
  const loc = persisted?.loc ?? Math.max(0, node.endLine - node.startLine + 1);
  return {
    loc,
    cyclomatic: persisted?.cyclomatic ?? findingMetric('complex_method'),
    maxNesting: persisted?.maxNesting ?? findingMetric('nested_complexity'),
    paramCount: persisted?.paramCount ?? null,
    fileFirstSeenTs: file?.firstSeenTs ?? null,
    fileLastTouchedTs: file?.lastTouchedTs ?? null,
    fileCommits: file?.commitCount ?? null,
  };
}

/** Drop duplicate nodes (same id) — getCallers/getCallees produce one
    row per edge, so a caller that targets the symbol via multiple call
    sites would appear multiple times. The UI wants one row per node. */
function dedupNodes(nodes: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) {
    if (seen.has(n['id'])) continue;
    seen.add(n['id']);
    out.push(n);
  }
  return out;
}

function resolveSymbolToNode(queries: QueryBuilder, idOrName: string): Node | null {
  // Try as exact id first, then exact-case name, then case-insensitive
  // name (uses the idx_nodes_lower_name expression index from migration
  // 003). Multiple matches sort by centrality DESC so common typos
  // route to the most-impactful symbol of that name.
  const direct = queries.getNodeById(idOrName);
  if (direct) return direct;
  const byName = getNodesByName(queries, idOrName);
  if (byName.length > 0) return [...byName].sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))[0]!;
  const byLower = getNodesByLowerName(queries, idOrName.toLowerCase());
  if (byLower.length === 0) return null;
  return [...byLower].sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))[0]!;
}

function serializeNode(n: Node): Record<string, unknown> {
  return {
    id: n.id,
    label: n.name,
    kind: n.kind,
    file: n.filePath,
    line: n.startLine,
    centrality: n.centrality ?? 0,
    language: n.language,
  };
}

function loadIndexHtml(): string {
  const file = path.join(STATIC_DIR, 'index.html');
  return fs.readFileSync(file, 'utf-8');
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Parse an int from a query-string value and clamp to a named bound.
 * Returns `bound.default` when the value is missing or non-numeric.
 * Single bound argument (vs. three loose ints) so a misordered
 * `clampInt(v, max, min, fallback)` is impossible at the call site.
 */
function clampInt(v: string | null, bound: IntBound): number {
  if (!v) return bound.default;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return bound.default;
  return Math.max(bound.min, Math.min(bound.max, n));
}
