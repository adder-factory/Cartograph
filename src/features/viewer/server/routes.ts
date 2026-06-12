import type * as http from 'node:http';
import { BIOMARKER_NAMES } from '../../../biomarkers/types.js';
import { sendIndexHtml, sendStaticAsset } from './assets.js';
import { handleAskRequest } from './ask.js';
import {
  BIOMARKER_LIMIT,
  COMPARE_LIMIT,
  GRAPH_DEPTH,
  HOTSPOTS_LIMIT,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_NOT_FOUND,
  HTTP_OK,
  IMPACT_DEPTH,
  IMPACT_LIMIT,
  SEARCH_LIMIT,
  SESSIONS_LIMIT,
  URL_PARSE_BASE,
} from './constants.js';
import type { RequestContext } from './context.js';
import {
  graphPayload,
  impactPayload,
  parseEdgeKinds,
  parseGraphLimit,
  parseGraphMode,
  parseImpactMode,
  pathPayload,
} from './graph-payloads.js';
import { clampInt, clampString, sendJson } from './http.js';
import { handleLiveStream, liveCallsPayload } from './live.js';
import { sourcePayload, symbolPayload } from './node-payloads.js';
import {
  biomarkerFindingsPayload,
  comparePayload,
  findingsPayload,
  hotspotsPayload,
  searchPayload,
  sessionDetailPayload,
  sessionsPayload,
  statusPayload,
} from './project-payloads.js';
import { checkViewerRequest } from './security.js';

interface GetRoute {
  match: (path: string) => RegExpExecArray | true | null;
  handle: (
    m: RegExpExecArray | true,
    url: URL,
    res: http.ServerResponse,
    ctx: RequestContext,
    req: http.IncomingMessage,
  ) => void;
}

interface RespondWithIdLookupArgs {
  rawId: string;
  res: http.ServerResponse;
  ctx: RequestContext;
  lookup: (ctx: RequestContext, id: string) => unknown;
}

const matchExact = (p: string) => (path: string) => (path === p ? true : null);

const GET_ROUTES: ReadonlyArray<GetRoute> = [
  { match: matchExact('/'), handle: (_m, _u, res, ctx) => sendIndexHtml(res, ctx) },
  { match: matchExact('/index.html'), handle: (_m, _u, res, ctx) => sendIndexHtml(res, ctx) },
  {
    match: (p) => /^\/(viewer(?:[\w.-]+)?\.app|viewer\.css|lucide\.min\.js)$/.exec(p),
    handle: (m, _u, res, ctx, req) => sendStaticAsset({ req, res, ctx, filename: (m as RegExpExecArray)[1]! }),
  },
  { match: matchExact('/api/status'), handle: (_m, _u, res, ctx) => sendJson(res, HTTP_OK, statusPayload(ctx)) },
  {
    match: matchExact('/api/graph'),
    handle: (_m, url, res, ctx) => {
      const focus = url.searchParams.get('focus');
      const depth = clampInt(url.searchParams.get('depth'), GRAPH_DEPTH);
      const mode = parseGraphMode(url.searchParams.get('mode'));
      const limit = parseGraphLimit(url.searchParams.get('limit'), mode);
      sendJson(res, HTTP_OK, graphPayload({ ctx, focus, depth, opts: { mode, limit } }));
    },
  },
  {
    match: matchExact('/api/search'),
    handle: (_m, url, res, ctx) => {
      const q = clampString(url.searchParams.get('q'), 120);
      const limit = clampInt(url.searchParams.get('limit'), SEARCH_LIMIT);
      sendJson(res, HTTP_OK, searchPayload(ctx, q, limit));
    },
  },
  {
    match: matchExact('/api/path'),
    handle: (_m, url, res, ctx) => {
      const from = clampString(url.searchParams.get('from'), 200);
      const to = clampString(url.searchParams.get('to'), 200);
      if (!from || !to) {
        sendJson(res, HTTP_BAD_REQUEST, { error: '`from` and `to` are required' });
        return;
      }
      sendJson(
        res,
        HTTP_OK,
        pathPayload({ ctx, fromRaw: from, toRaw: to, edgeKinds: parseEdgeKinds(url.searchParams) }),
      );
    },
  },
  {
    match: matchExact('/api/impact'),
    handle: (_m, url, res, ctx) => {
      const focus = clampString(url.searchParams.get('focus'), 200);
      if (!focus) {
        sendJson(res, HTTP_BAD_REQUEST, { error: '`focus` is required' });
        return;
      }
      const depth = clampInt(url.searchParams.get('depth'), IMPACT_DEPTH);
      const limit = clampInt(url.searchParams.get('limit'), IMPACT_LIMIT);
      const mode = parseImpactMode(url.searchParams.get('mode'));
      sendJson(
        res,
        HTTP_OK,
        impactPayload({ ctx, focusRaw: focus, mode, depth, limit, edgeKinds: parseEdgeKinds(url.searchParams) }),
      );
    },
  },
  {
    match: matchExact('/api/compare'),
    handle: (_m, url, res, ctx) => {
      const limit = clampInt(url.searchParams.get('limit'), COMPARE_LIMIT);
      sendJson(res, HTTP_OK, comparePayload(ctx, limit));
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
    match: matchExact('/api/live/stream'),
    handle: (_m, _u, res, ctx, req) => handleLiveStream(req, res, ctx),
  },
  {
    match: matchExact('/api/live/calls'),
    handle: (_m, url, res, ctx) => {
      sendJson(res, HTTP_OK, liveCallsPayload(ctx, url.searchParams.get('sinceTs'), url.searchParams.get('limit')));
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
      const payload = sessionDetailPayload(ctx, (m as RegExpExecArray)[1]!);
      if (payload === null) {
        sendJson(res, HTTP_NOT_FOUND, { error: "session is outside this viewer's --session scope" });
        return;
      }
      sendJson(res, HTTP_OK, payload);
    },
  },
  {
    match: (p) => /^\/api\/source\/(.+)$/.exec(p),
    handle: (m, _u, res, ctx) => respondWithSourceLookup({ rawId: (m as RegExpExecArray)[1]!, res, ctx }),
  },
  {
    match: (p) => /^\/api\/symbol\/(.+)$/.exec(p),
    handle: (m, _u, res, ctx) =>
      respondWithIdLookup({ rawId: (m as RegExpExecArray)[1]!, res, ctx, lookup: symbolPayload }),
  },
];

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', URL_PARSE_BASE);
  const requestCheck = checkViewerRequest(req, url, ctx);
  if (!requestCheck.ok) {
    sendJson(res, requestCheck.status, { error: requestCheck.error });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ask') {
    await handleAskRequest(req, res, ctx);
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method not allowed' });
    return;
  }
  for (const route of GET_ROUTES) {
    const m = route.match(url.pathname);
    if (m === null) continue;
    route.handle(m, url, res, ctx, req);
    return;
  }
  sendJson(res, HTTP_NOT_FOUND, { error: `not found: ${url.pathname}` });
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

function respondWithSourceLookup(args: Pick<RespondWithIdLookupArgs, 'rawId' | 'res' | 'ctx'>): void {
  const { rawId, res, ctx } = args;
  const id = decodeIdParam(rawId, res);
  if (id === null) return;
  const payload = sourcePayload(ctx, id);
  if (!payload) {
    sendJson(res, HTTP_NOT_FOUND, { error: `unknown symbol: ${id}` });
    return;
  }
  const status = payload.error === 'path escapes project root' ? HTTP_FORBIDDEN : HTTP_OK;
  sendJson(res, status, payload);
}

function decodeIdParam(rawId: string, res: http.ServerResponse): string | null {
  try {
    return decodeURIComponent(rawId);
  } catch {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'malformed symbol id' });
    return null;
  }
}
