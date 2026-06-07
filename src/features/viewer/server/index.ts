/**
 * cartograph viewer — local HTTP server.
 *
 * Public entrypoint for the static viewer and JSON API. Route handling
 * and payload contracts live under `src/features/viewer/server/`.
 */
import * as http from 'node:http';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseConnection, getDatabasePath } from '../../../db/index.js';
import { QueryBuilder } from '../../../db/queries.js';
import { loadConfig } from '../../../config.js';
import { GraphTraverser } from '../../../graph/traversal.js';
import { logDebug, errMsg } from '../../../errors.js';
import { loadIndexHtml, loadStaticAssets } from './assets.js';
import { DEFAULT_PORT, HTTP_INTERNAL_ERROR, HTTP_SCHEME } from './constants.js';
import type { RequestContext, ViewerHandle, ViewerOptions } from './context.js';
import { sendJson } from './http.js';
import { handleRequest } from './routes.js';

export type { ViewerHandle } from './context.js';

function isAddrObject(addr: ReturnType<import('node:http').Server['address']>): addr is import('node:net').AddressInfo {
  return typeof addr === 'object' && addr !== null;
}

function listenServer(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

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
  const config = loadConfig(projectPath);
  const usesPostgres = config.database?.provider === 'postgres';
  const dbExists =
    usesPostgres ||
    (await fsp
      .access(dbPath)
      .then(() => true)
      .catch(() => false));
  if (!dbExists) {
    throw new Error(`No cartograph DB at ${dbPath} — run \`cartograph init\` and \`cartograph index\` first.`);
  }
  const conn = DatabaseConnection.open(dbPath, { database: config.database });
  const queries = new QueryBuilder(conn.getDb());
  const traverser = new GraphTraverser(queries);
  const ctx: RequestContext = {
    projectPath,
    conn,
    queries,
    traverser,
    indexHtml: loadIndexHtml(),
    staticAssets: loadStaticAssets(),
  };

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

export function openInBrowser(url: string): void {
  let cmd = 'xdg-open';
  if (process.platform === 'darwin') cmd = 'open';
  else if (process.platform === 'win32') cmd = 'cmd';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    logDebug('viewer: openInBrowser failed', { err: errMsg(err) });
  }
}
