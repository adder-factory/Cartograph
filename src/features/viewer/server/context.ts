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
  /** Loopback bind host. Default '127.0.0.1' (a concrete loopback — Bun's
   *  'localhost' alternates ::1/127.0.0.1 across binds). Non-loopback hosts
   *  are rejected because the page token is not remote-user authentication. */
  host?: string;
  /**
   * Scope this viewer instance to ONE recorded MCP session, by id or
   * label. Trace, live feed, and session endpoints show nothing else
   * (enforced server-side). Lets each agent run its own viewer.
   */
  session?: string;
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
  /** Raw --session selector (id or label); null = whole project. */
  sessionScope: string | null;
  conn: DatabaseConnection;
  queries: QueryBuilder;
  traverser: GraphTraverser;
  indexHtml: string;
  staticAssets: Record<string, StaticAsset>;
  security: ViewerSecurityContext;
  /** Whether the config editor's write/re-index endpoints are enabled. */
  allowConfigEdit: boolean;
  cg?: Cartograph;
}

export async function ensureCartograph(ctx: RequestContext): Promise<Cartograph> {
  if (ctx.cg) return ctx.cg;
  ctx.cg = await Cartograph.open(ctx.projectPath);
  return ctx.cg;
}
