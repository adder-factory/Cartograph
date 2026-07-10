import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import { resolveAssetPath } from '../../../assets.js';
import { HTTP_NOT_FOUND, HTTP_NOT_MODIFIED, HTTP_OK, STATIC_ASSET_CACHE_CONTROL } from './constants.js';
import type { RequestContext, StaticAsset } from './context.js';
import { sendJson } from './http.js';

const STATIC_DIR = resolveAssetPath('features', 'viewer', 'static');
const VIEWER_TOKEN_META = '<meta name="cartograph-viewer-token" content="" />';
const VIEWER_PROJECT_ID_META = '<meta name="cartograph-viewer-project-id" content="" />';

interface SendStaticAssetArgs {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly ctx: RequestContext;
  readonly filename: string;
}

interface StaticAssetHeaderOptions {
  readonly includeBodyLength: boolean;
}

export function sendIndexHtml(res: http.ServerResponse, ctx: RequestContext): void {
  res.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' });
  res.end(indexHtmlWithSecurityContext(ctx.indexHtml, ctx.security.apiToken, viewerProjectId(ctx.projectPath)));
}

export function sendStaticAsset(args: SendStaticAssetArgs): void {
  const { req, res, ctx, filename } = args;
  const asset = ctx.staticAssets[filename];
  if (!asset) {
    sendJson(res, HTTP_NOT_FOUND, { error: `not found: /${filename}` });
    return;
  }
  const headers = staticAssetHeaders(asset, { includeBodyLength: false });
  if (requestHasMatchingEtag(req, asset.etag)) {
    res.writeHead(HTTP_NOT_MODIFIED, headers);
    res.end();
    return;
  }
  res.writeHead(HTTP_OK, staticAssetHeaders(asset, { includeBodyLength: true }));
  res.end(asset.body);
}

function staticAssetHeaders(asset: StaticAsset, opts: StaticAssetHeaderOptions): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    'cache-control': STATIC_ASSET_CACHE_CONTROL,
    'content-type': `${asset.contentType}; charset=utf-8`,
    etag: asset.etag,
  };
  if (opts.includeBodyLength) headers['content-length'] = asset.byteLength;
  return headers;
}

function requestHasMatchingEtag(req: http.IncomingMessage, etag: string): boolean {
  const raw = req.headers['if-none-match'];
  if (raw === undefined) return false;
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === '*');
}

export function loadIndexHtml(): string {
  const file = path.join(STATIC_DIR, 'index.html');
  return fs.readFileSync(file, 'utf-8');
}

export function loadStaticAssets(): Record<string, StaticAsset> {
  const assets: Record<string, StaticAsset> = {};
  for (const filename of fs.readdirSync(STATIC_DIR)) {
    if (!isViewerStaticAsset(filename)) continue;
    assets[filename] = loadStaticAsset(filename, contentTypeForStaticAsset(filename));
  }
  return assets;
}

function loadStaticAsset(filename: string, contentType: string): StaticAsset {
  const body = fs.readFileSync(path.join(STATIC_DIR, filename), 'utf-8');
  return {
    body,
    contentType,
    etag: hashAssetEtag(body),
    byteLength: Buffer.byteLength(body),
  };
}

function isViewerStaticAsset(filename: string): boolean {
  return filename === 'viewer.css' || filename === 'lucide.min.js' || /^viewer(?:[\w.-]+)?\.app$/.test(filename);
}

function contentTypeForStaticAsset(filename: string): string {
  return filename.endsWith('.css') ? 'text/css' : 'text/javascript';
}

function hashAssetEtag(body: string): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return `"sha256-${digest}"`;
}

function indexHtmlWithSecurityContext(html: string, token: string, projectId: string): string {
  const tokenMeta = `<meta name="cartograph-viewer-token" content="${escapeHtmlAttr(token)}" />`;
  const projectMeta = `<meta name="cartograph-viewer-project-id" content="${escapeHtmlAttr(projectId)}" />`;
  const withToken = html.includes(VIEWER_TOKEN_META)
    ? html.replace(VIEWER_TOKEN_META, tokenMeta)
    : html.replace('</head>', `${tokenMeta}\n</head>`);
  return withToken.includes(VIEWER_PROJECT_ID_META)
    ? withToken.replace(VIEWER_PROJECT_ID_META, projectMeta)
    : withToken.replace('</head>', `${projectMeta}\n</head>`);
}

function viewerProjectId(projectPath: string): string {
  return createHash('sha256').update(path.resolve(projectPath)).digest('base64url').slice(0, 22);
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
