/**
 * NestJS framework hook (B10, 2026-05-26).
 *
 * First consumer of B9 (`Node.decoratorArgs`). Walks indexed
 * method/class nodes whose decorators name NestJS framework
 * symbols, reads the decorator args directly off the graph, and
 * emits one `route` node per HTTP / GraphQL / microservice-or-gateway
 * handler + a `references` edge from each route to its handler method.
 *
 * Zero source re-parsing. Upstream's 700 LOC of regex against TS
 * (commit `948b2875`) is replaced by ~150 LOC of graph walks that
 * trust the tree-sitter extractor's output via B9.
 *
 * ## What's covered
 *
 *   - HTTP controllers: `@Controller('prefix')` on the class +
 *     `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All('subpath')`
 *     on methods → route `GET /prefix/subpath` (joined path).
 *     Empty-arg variants (`@Controller()` / `@Get()`) still yield routes.
 *   - GraphQL: `@Resolver('Type')` class + `@Query/@Mutation/@Subscription`
 *     methods → route `GraphQL Query <field>`. The field name is the
 *     METHOD name: Nest defaults the GraphQL field to the method name,
 *     and the `{ name: '…' }` OVERRIDE lives in an object-literal arg that
 *     B9 doesn't capture (object literals are out of B9 v1 scope), so the
 *     override is approximated by the method name. The `() => Type` thunk
 *     arg is likewise not a route component.
 *   - Microservices / gateways: `@MessagePattern('topic')` /
 *     `@EventPattern('evt')` / `@SubscribeMessage('msg')` on a `@Controller`
 *     (or gateway) class → route `MessagePattern topic` etc. The pattern
 *     string IS a captured string arg, so it's exact.
 *
 * ## Deferred to follow-ups
 *
 *   - `RouterModule.register([...])` cross-file prefix propagation.
 *     Needs a second-pass index-hook walking `*.module.{ts,js}` for
 *     module-tree shape — defer until a real corpus surfaces a need.
 *   - The GraphQL `{ name: '…' }` field-name override (object-literal arg)
 *     — blocked on B9 object-literal capture.
 *
 * ## Self-heal
 *
 * `NESTJS_ROUTES_ALGO_VERSION` is the SHA of this file's source.
 * `afterSync` checks the stored algo-version against the live one;
 * mismatch triggers a one-shot full re-mine, so existing projects
 * pick up logic improvements without a manual `cartograph admin
 * index`. Same pattern as `go-implements` / `value-ref-edges`.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { z } from 'zod';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { generateNodeId } from '../extraction/tree-sitter-helpers.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node } from '../types.js';
import { parseDecoratorArgsJson } from './_decorator-args.js';

/** Algo-version SHA. Mismatch on `afterSync` triggers re-mine. */
export const NESTJS_ROUTES_ALGO_VERSION = computeAlgoHash('src/index-hooks/nestjs-routes.ts', ['./nestjs-routes']);
const LAST_MINED_KEY = 'last_mined_nestjs_routes_algo_version';

/**
 * How a method-level route decorator turns into a route's path:
 *   - `http`  — path = the decorator's string arg (`@Get('x')` → `x`),
 *     joined with the `@Controller` prefix.
 *   - `graphql` — path = the METHOD name (the GraphQL field; the
 *     `{ name }` override is an object-literal B9 doesn't capture, and the
 *     method name is Nest's default field name anyway). No prefix.
 *   - `rpc` — path = the decorator's string arg (the message/event/socket
 *     pattern, e.g. `@MessagePattern('sum')` → `sum`). No prefix.
 */
type RouteStyle = 'http' | 'graphql' | 'rpc';

interface RouteDecorator {
  /** Label prefixing the rendered route name (`GET`, `GraphQL Query`, …). */
  label: string;
  style: RouteStyle;
}

/**
 * Method-level decorator name → route shape. The full Nest set is closed
 * per category (no community-defined route decorators), so each is
 * subscribed unconditionally.
 */
const ROUTE_DECORATORS: ReadonlyMap<string, RouteDecorator> = new Map([
  // HTTP controllers.
  ['Get', { label: 'GET', style: 'http' }],
  ['Post', { label: 'POST', style: 'http' }],
  ['Put', { label: 'PUT', style: 'http' }],
  ['Patch', { label: 'PATCH', style: 'http' }],
  ['Delete', { label: 'DELETE', style: 'http' }],
  ['Head', { label: 'HEAD', style: 'http' }],
  ['Options', { label: 'OPTIONS', style: 'http' }],
  ['All', { label: 'ALL', style: 'http' }],
  // GraphQL resolvers.
  ['Query', { label: 'GraphQL Query', style: 'graphql' }],
  ['Mutation', { label: 'GraphQL Mutation', style: 'graphql' }],
  ['Subscription', { label: 'GraphQL Subscription', style: 'graphql' }],
  // Microservices + WebSocket gateways.
  ['MessagePattern', { label: 'MessagePattern', style: 'rpc' }],
  ['EventPattern', { label: 'EventPattern', style: 'rpc' }],
  ['SubscribeMessage', { label: 'WebSocket', style: 'rpc' }],
]);

/** Class-level decorators that mark a route-bearing class: `@Controller`
 *  (HTTP + microservice/gateway methods) and `@Resolver` (GraphQL). */
const ROUTE_CLASS_DECORATORS: readonly string[] = ['Controller', 'Resolver'];

/** TS/JS languages on which NestJS code lives. Skip everything else. */
const NESTJS_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

const decoratorsJsonSchema = z.array(z.string());

function refresh(ctx: IndexHookContext): void {
  try {
    const matches = collectRouteMatches(ctx);
    if (matches.length === 0) return;

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    const now = Date.now();
    // Per-(file, display-name) occurrence counter so two handlers that
    // render to the same route name in one file (e.g. duplicate-named
    // resolver fields — invalid Nest, but we must not silently drop one)
    // get distinct, stable node ids. `matches` is in deterministic SQL
    // order (file, start_line, id), so the ordinal is structurally stable.
    const ordinalByKey = new Map<string, number>();
    for (const rm of matches) {
      const displayName = routeDisplayName(rm);
      const key = `${rm.methodFilePath}\0${displayName}`;
      const ordinal = ordinalByKey.get(key) ?? 0;
      ordinalByKey.set(key, ordinal + 1);
      const route = buildRouteNode({ rm, displayName, ordinal, now });
      newNodes.push(route);
      newEdges.push({
        source: route.id,
        target: rm.methodId,
        kind: 'references',
        metadata: { synthesizedBy: 'nestjs-routes' },
      });
    }
    if (newNodes.length > 0) ctx.queries.insertNodes(newNodes);
    if (newEdges.length > 0) insertEdges(ctx.queries, newEdges);
  } catch (err) {
    logDebug(`nestjs-routes refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, NESTJS_ROUTES_ALGO_VERSION);
  } catch (err) {
    logDebug(`nestjs-routes stamp failed: ${errMsg(err)}`);
  }
}

interface RouteMatch {
  methodId: string;
  methodFilePath: string;
  /** Route label prefix — `GET` / `GraphQL Query` / `MessagePattern` / … */
  label: string;
  /** The route's path component, already resolved per {@link RouteStyle}:
   *  a joined HTTP path, a GraphQL field (the method name), or an RPC
   *  pattern. May be empty (e.g. `@MessagePattern()` with no arg). */
  routePath: string;
  /** 1-indexed line of the method (for the route node's startLine). */
  methodStartLine: number;
}

/** Resolve a route's path component per {@link RouteStyle}. */
function resolveRoutePath(args: {
  style: RouteStyle;
  controllerPrefix: string;
  decoratorArg: string;
  methodName: string;
}): string {
  switch (args.style) {
    case 'http':
      return joinHttpPath(args.controllerPrefix, args.decoratorArg);
    case 'graphql':
      // The GraphQL field name is the METHOD name (Nest's default; the
      // `{ name }` override is an object-literal arg B9 doesn't capture).
      return args.methodName;
    case 'rpc':
      // The message / event / socket pattern is the captured string arg.
      return args.decoratorArg;
  }
}

/**
 * Walk the graph: every method whose `decorators` contain a route
 * decorator (HTTP / GraphQL / RPC) AND whose containing class is
 * decorated with `@Controller` or `@Resolver`. Read paths from
 * `Node.decoratorArgs` via name-keyed lookup (per B9's
 * NAME-KEYED-NOT-POSITIONAL contract — see `DecoratorArgsEntry` JSDoc).
 *
 * One SQL groups method + class via the `contains` edge so we don't
 * issue a per-method query for the class lookup. SQLite's JSON1
 * `EXISTS (SELECT 1 FROM json_each(...))` is the "any element matches"
 * pattern used elsewhere in this codebase.
 */
function collectRouteMatches(ctx: IndexHookContext): RouteMatch[] {
  const routeKeysJson = JSON.stringify([...ROUTE_DECORATORS.keys()]);
  const classKeysJson = JSON.stringify([...ROUTE_CLASS_DECORATORS]);
  const langsJson = JSON.stringify([...NESTJS_LANGUAGES]);
  const rows = ctx.queries.db
    .prepare(
      `SELECT m.id AS methodId, m.name AS methodName, m.file_path AS methodFilePath,
              m.start_line AS methodStartLine,
              m.decorators AS methodDecorators, m.decorator_args AS methodDecoratorArgs,
              c.decorators AS classDecorators, c.decorator_args AS classDecoratorArgs
       FROM nodes m
       JOIN edges e ON e.target = m.id AND e.kind = 'contains'
       JOIN nodes c ON c.id = e.source
       WHERE m.kind = 'method'
         AND m.language IN (SELECT value FROM json_each(@langsJson))
         AND c.kind = 'class'
         AND m.decorators IS NOT NULL
         AND c.decorators IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(m.decorators)
           WHERE json_each.value IN (SELECT value FROM json_each(@routeKeysJson))
         )
         AND EXISTS (
           SELECT 1 FROM json_each(c.decorators)
           WHERE json_each.value IN (SELECT value FROM json_each(@classKeysJson))
         )
       ORDER BY m.file_path, m.start_line, m.id`,
    )
    .all({ routeKeysJson, classKeysJson, langsJson }) as Array<{
    methodId: string;
    methodName: string;
    methodFilePath: string;
    methodStartLine: number;
    methodDecorators: string | null;
    methodDecoratorArgs: string | null;
    classDecorators: string | null;
    classDecoratorArgs: string | null;
  }>;

  const out: RouteMatch[] = [];
  for (const row of rows) {
    const methodArgs = parseDecoratorArgsJson(row.methodDecoratorArgs);
    const classArgs = parseDecoratorArgsJson(row.classDecoratorArgs);
    // Controller prefix (HTTP only): first argString of `@Controller(...)`.
    // Empty for `@Controller()`, `@Resolver`, or an object-literal arg
    // (`@Controller({ path })`, deferred to a future B9 extension).
    const controllerPrefix = classArgs.find((a) => a.name === 'Controller')?.argStrings[0] ?? '';

    // Gate decorator style by class type so a stray/mis-imported decorator
    // can't cross-label: GraphQL operations only count on an `@Resolver`
    // class; HTTP + microservice/gateway handlers only on a `@Controller`.
    // (A hybrid class carrying both decorators permits both.)
    const classDecs = parseDecoratorsJson(row.classDecorators);
    const allowHttpRpc = classDecs.includes('Controller');
    const allowGraphql = classDecs.includes('Resolver');

    // Emit a route per route-decorator the method carries (Nest allows
    // multiple, e.g. several HTTP methods on one handler).
    for (const decName of parseDecoratorsJson(row.methodDecorators)) {
      const spec = ROUTE_DECORATORS.get(decName);
      if (!spec) continue;
      if (spec.style === 'graphql' ? !allowGraphql : !allowHttpRpc) continue;
      const decoratorArg = methodArgs.find((a) => a.name === decName)?.argStrings[0] ?? '';
      out.push({
        methodId: row.methodId,
        methodFilePath: row.methodFilePath,
        label: spec.label,
        routePath: resolveRoutePath({
          style: spec.style,
          controllerPrefix,
          decoratorArg,
          methodName: row.methodName,
        }),
        methodStartLine: row.methodStartLine,
      });
    }
  }
  return out;
}

/** The route's display name: `<label> <routePath>` (`GET /users/:id`,
 *  `GraphQL Query author`, `MessagePattern sum`); trimmed so a label-only
 *  route (empty path) reads cleanly. */
function routeDisplayName(rm: RouteMatch): string {
  return `${rm.label} ${rm.routePath}`.trim();
}

/** Build a `route` node from a resolved {@link RouteMatch}. `ordinal`
 *  disambiguates same-display-name handlers within one file (allocated by
 *  the caller); re-emitting the same id on a later indexAll is idempotent. */
function buildRouteNode(args: { rm: RouteMatch; displayName: string; ordinal: number; now: number }): Node {
  const { rm, displayName, ordinal, now } = args;
  const id = generateNodeId({
    filePath: rm.methodFilePath,
    kind: 'route',
    name: displayName,
    ordinal,
  });
  return {
    id,
    kind: 'route',
    name: displayName,
    qualifiedName: `${rm.methodFilePath}::${rm.label}::${rm.routePath}`,
    filePath: rm.methodFilePath,
    language: 'typescript',
    startLine: rm.methodStartLine,
    endLine: rm.methodStartLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };
}

/** Join controller prefix + method subpath into a NestJS route path.
 *  Mirrors Nest's runtime joining: leading slash normalised, empty
 *  parts collapsed, double slashes elided. */
function joinHttpPath(prefix: string, subpath: string): string {
  const norm = (s: string): string => s.replace(/^\/+/, '').replace(/\/+$/, '');
  const left = norm(prefix);
  const right = norm(subpath);
  if (!left && !right) return '/';
  if (!left) return `/${right}`;
  if (!right) return `/${left}`;
  return `/${left}/${right}`;
}

/** Parse the JSON-encoded `Node.decorators` column. Returns [] for
 *  NULL / invalid JSON / non-array shapes / invalid entries — defensive. */
function parseDecoratorsJson(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = decoratorsJsonSchema.safeParse(parsed);
  return result.success ? result.data : [];
}

export const HOOK: IndexHook = {
  name: 'nestjs-routes',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== NESTJS_ROUTES_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any TS/JS file changed → re-run. Routes are
    // file-local (controller class + method live in the same file)
    // so we could optimise to per-file emit, but the cross-file
    // case (RouterModule prefix from another module file) means a
    // project-wide pass is simpler. Keep it simple v1.
    const changed = result.changedFilePaths ?? [];
    const anyTsJsChange =
      changed.some((p) => p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.jsx')) ||
      result.filesRemoved > 0;
    if (anyTsJsChange) refresh(ctx);
  },
};
