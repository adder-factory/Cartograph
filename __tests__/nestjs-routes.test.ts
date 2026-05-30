/**
 * B10 (2026-05-26) — NestJS framework hook end-to-end test.
 *
 * Indexes a minimal NestJS controller, then verifies that the
 * `nestjs-routes` index-hook emitted one `route` node per HTTP
 * handler with the correct joined path AND a `references` edge from
 * each route to its handler method.
 *
 * Proves the B9 architectural contract: the resolver reads decorator
 * args off the graph (zero source re-parsing) and the joined
 * controller-prefix + method-path appears on every route node.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

describe('NestJS routes index-hook (B10)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nestjs-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('emits route nodes for a @Controller + @Get/@Post combo with joined paths', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'users.controller.ts'),
      `
@Controller('users')
class UsersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne() { return null; }

  @Post()
  create() { return null; }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // Three method nodes — pre-existing tree-sitter extraction surface.
    const methods = getNodesByKind(cg.queries, 'method');
    expect(methods.find((m) => m.name === 'findAll')).toBeDefined();
    expect(methods.find((m) => m.name === 'findOne')).toBeDefined();
    expect(methods.find((m) => m.name === 'create')).toBeDefined();

    // Three route nodes — emitted by the B10 nestjs-routes hook.
    const routes = getNodesByKind(cg.queries, 'route');
    expect(routes.length).toBe(3);

    // Verify paths are joined correctly. Path normalisation strips
    // duplicate `/`s and leading/trailing slashes; `@Controller('users')`
    // + `@Get()` → `/users`, `+ @Get(':id')` → `/users/:id`.
    const findAllRoute = routes.find((r) => r.name === 'GET /users');
    expect(findAllRoute, 'GET /users route should exist').toBeDefined();
    const findOneRoute = routes.find((r) => r.name === 'GET /users/:id');
    expect(findOneRoute, 'GET /users/:id route should exist').toBeDefined();
    const createRoute = routes.find((r) => r.name === 'POST /users');
    expect(createRoute, 'POST /users route should exist').toBeDefined();

    // Each route has a `references` edge to its handler method.
    const findAllEdges = getOutgoingEdges(cg.queries, findAllRoute!.id).filter((e) => e.kind === 'references');
    expect(findAllEdges.length).toBe(1);
    expect(findAllEdges[0]!.target).toBe(methods.find((m) => m.name === 'findAll')!.id);
  });

  it('handles empty @Controller() and empty @Get()', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'app.controller.ts'),
      `
@Controller()
class AppController {
  @Get()
  root() { return 'ok'; }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    expect(routes.length).toBe(1);
    // Both prefix and subpath empty → joined path = '/'.
    expect(routes[0]!.name).toBe('GET /');
  });

  it('skips classes without @Controller decorator (no false-positive routes)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'not-a-controller.ts'),
      `
class NotAController {
  // @Get is on the method but the class isn't a @Controller — no route.
  @Get('/orphan')
  m() { return null; }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    expect(routes.length).toBe(0);
  });

  it('skips methods on a @Controller class that lack an HTTP-method decorator', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'mixed.controller.ts'),
      `
@Controller('mixed')
class MixedController {
  @Get()
  publicRoute() { return null; }

  // Private helper — no HTTP decorator, no route emitted.
  helper() { return 1; }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    expect(routes.length).toBe(1);
    expect(routes[0]!.name).toBe('GET /mixed');
  });

  it('handles all eight HTTP method decorators', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'all-methods.controller.ts'),
      `
@Controller('items')
class AllMethodsController {
  @Get() a() { return null; }
  @Post() b() { return null; }
  @Put() c() { return null; }
  @Patch() d() { return null; }
  @Delete() e() { return null; }
  @Head() f() { return null; }
  @Options() g() { return null; }
  @All() h() { return null; }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    const methods = routes.map((r) => r.name.split(' ')[0]!).sort();
    expect(methods).toEqual(['ALL', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  });

  it('emits GraphQL routes for @Resolver + @Query/@Mutation/@Subscription (field = method name)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'authors.resolver.ts'),
      `
@Resolver('Author')
class AuthorsResolver {
  @Query(() => [Author], { name: 'authors' })
  findAll() { return []; }

  @Mutation(() => Author)
  createAuthor() { return null; }

  @Subscription(() => Comment)
  commentAdded() { return null; }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    const names = routes.map((r) => r.name).sort();
    // The GraphQL field is the METHOD name — the `{ name: 'authors' }`
    // override is an object-literal arg B9 doesn't capture, and the
    // method name is Nest's default field anyway.
    expect(names).toEqual([
      'GraphQL Mutation createAuthor',
      'GraphQL Query findAll',
      'GraphQL Subscription commentAdded',
    ]);

    // Each route references its resolver method.
    const methods = getNodesByKind(cg.queries, 'method');
    const findAllRoute = routes.find((r) => r.name === 'GraphQL Query findAll')!;
    const edges = getOutgoingEdges(cg.queries, findAllRoute.id).filter((e) => e.kind === 'references');
    expect(edges.length).toBe(1);
    expect(edges[0]!.target).toBe(methods.find((m) => m.name === 'findAll')!.id);
  });

  it('emits microservice/gateway routes for @MessagePattern/@EventPattern/@SubscribeMessage (pattern = arg)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'events.controller.ts'),
      `
@Controller()
class EventsController {
  @MessagePattern('sum')
  accumulate() { return 0; }

  @EventPattern('user_created')
  handleUserCreated() {}

  @SubscribeMessage('events')
  handleEvent() {}
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    const names = routes.map((r) => r.name).sort();
    // The pattern string IS a captured string arg (unlike GraphQL), so exact.
    expect(names).toEqual(['EventPattern user_created', 'MessagePattern sum', 'WebSocket events']);
  });

  it('gates decorator style by class type (no cross-style mislabeling)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // A @Resolver with a stray @Get, and a @Controller with a stray @Query —
    // each mismatched decorator must NOT synthesize a route of the other style.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'mismatch.ts'),
      `
@Resolver('Author')
class AuthorsResolver {
  @Query(() => [Author]) findAll() { return []; }
  @Get('/strayHttp') strayHttp() { return null; }
}

@Controller('users')
class UsersController {
  @Get() list() { return []; }
  @Query() strayGraphql() { return null; }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    const names = routes.map((r) => r.name).sort();
    // Resolver → only the GraphQL route (the @Get is gated out);
    // Controller → only the HTTP route (the @Query is gated out).
    expect(names).toEqual(['GET /users', 'GraphQL Query findAll']);
  });

  it('permits BOTH styles on a hybrid @Controller + @Resolver class', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // A class carrying both decorators (hybrid HTTP + GraphQL) — both
    // allow-flags are true, so both route styles are emitted.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'hybrid.ts'),
      `
@Controller('api')
@Resolver('Thing')
class HybridController {
  @Get(':id') getOne() { return null; }
  @Query(() => Thing) thing() { return null; }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const routes = getNodesByKind(cg.queries, 'route');
    const names = routes.map((r) => r.name).sort();
    expect(names).toEqual(['GET /api/:id', 'GraphQL Query thing']);
  });
});
