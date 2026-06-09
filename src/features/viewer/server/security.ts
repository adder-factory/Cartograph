import { randomBytes, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from './constants.js';
import type { RequestContext, ViewerSecurityContext } from './context.js';

const API_TOKEN_BYTES = 32;
const API_TOKEN_HEADER = 'x-cartograph-viewer-token';
const HTTP_PROTOCOL = 'http:';

interface SecurityCheckFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
}

type SecurityCheckResult = { readonly ok: true } | SecurityCheckFailure;

export function createViewerApiToken(): string {
  return randomBytes(API_TOKEN_BYTES).toString('base64url');
}

export function createViewerSecurityContext(host: string, port: number, apiToken: string): ViewerSecurityContext {
  const allowedHostnames = allowedHostnamesFor(host);
  return {
    apiToken,
    allowedHostnames,
    allowedOrigins: allowedHostnames.map(
      (hostname) => `${HTTP_PROTOCOL}//${formatHostnameForOrigin(hostname)}:${port}`,
    ),
    port,
  };
}

export function formatHostForViewerUrl(host: string): string {
  const normalized = normalizeHostname(host);
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

export function checkViewerRequest(req: http.IncomingMessage, url: URL, ctx: RequestContext): SecurityCheckResult {
  if (!requestHostAllowed(req, ctx.security)) {
    return { ok: false, status: HTTP_FORBIDDEN, error: 'forbidden host' };
  }
  if (!requestOriginAllowed(req, ctx.security)) {
    return { ok: false, status: HTTP_FORBIDDEN, error: 'forbidden origin' };
  }
  if (url.pathname.startsWith('/api/') && !requestTokenAllowed(req, ctx.security.apiToken)) {
    return { ok: false, status: HTTP_UNAUTHORIZED, error: 'unauthorized' };
  }
  return { ok: true };
}

function requestHostAllowed(req: http.IncomingMessage, security: ViewerSecurityContext): boolean {
  const raw = req.headers.host;
  if (!raw || Array.isArray(raw)) return false;
  const parsed = parseHostHeader(raw);
  if (!parsed) return false;
  return parsed.port === String(security.port) && security.allowedHostnames.includes(parsed.hostname);
}

function requestOriginAllowed(req: http.IncomingMessage, security: ViewerSecurityContext): boolean {
  const raw = req.headers.origin;
  if (raw === undefined) return true;
  if (!raw || Array.isArray(raw)) return false;
  try {
    const origin = new URL(raw);
    return origin.protocol === HTTP_PROTOCOL && security.allowedOrigins.includes(origin.origin);
  } catch {
    return false;
  }
}

function requestTokenAllowed(req: http.IncomingMessage, expected: string): boolean {
  const provided = requestApiToken(req);
  if (!provided) return false;
  return safeTokenEquals(provided, expected);
}

function requestApiToken(req: http.IncomingMessage): string | null {
  const headerToken = singleHeader(req.headers[API_TOKEN_HEADER]);
  if (headerToken) return headerToken.trim();
  const authorization = singleHeader(req.headers.authorization);
  if (!authorization) return null;
  const trimmed = authorization.trim();
  const bearerPrefix = 'bearer ';
  return trimmed.toLowerCase().startsWith(bearerPrefix) ? trimmed.slice(bearerPrefix.length).trim() : null;
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (value === undefined || Array.isArray(value)) return null;
  return value;
}

function safeTokenEquals(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function parseHostHeader(raw: string): { hostname: string; port: string } | null {
  try {
    const parsed = new URL(`${HTTP_PROTOCOL}//${raw}`);
    return { hostname: normalizeHostname(parsed.hostname), port: parsed.port };
  } catch {
    return null;
  }
}

function allowedHostnamesFor(host: string): string[] {
  const normalized = normalizeHostname(host);
  const allowed = new Set<string>([normalized]);
  if (isLoopbackOrLocalHost(normalized)) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
    allowed.add('::1');
  }
  return [...allowed];
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

function formatHostnameForOrigin(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function isLoopbackOrLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
