import Cartograph from '../../../index.js';
import type { DatabaseConnection } from '../../../db/index.js';
import type { QueryBuilder } from '../../../db/queries.js';
import type { GraphTraverser } from '../../../graph/traversal.js';

export interface ViewerHandle {
  url: string;
  port: number;
  apiToken: string;
  close: () => Promise<void>;
}

export interface ViewerOptions {
  /** Port to bind to. Pass 0 to let the OS pick a free port. */
  port?: number;
  /** Bind host. Default 'localhost' with token-protected APIs. */
  host?: string;
}

export interface StaticAsset {
  readonly body: string;
  readonly contentType: string;
  readonly etag: string;
  readonly byteLength: number;
}

export interface ViewerSecurityContext {
  readonly apiToken: string;
  readonly allowedHostnames: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly port: number;
}

export interface RequestContext {
  projectPath: string;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  traverser: GraphTraverser;
  indexHtml: string;
  staticAssets: Record<string, StaticAsset>;
  security: ViewerSecurityContext;
  cg?: Cartograph;
}

export async function ensureCartograph(ctx: RequestContext): Promise<Cartograph> {
  if (ctx.cg) return ctx.cg;
  ctx.cg = await Cartograph.open(ctx.projectPath);
  return ctx.cg;
}
