import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as edgeQueries from '../src/db/queries-edges.js';
import * as metadataQueries from '../src/db/queries-metadata.js';

const state = {
  rows: [] as Array<{
    methodId: string;
    methodName: string;
    methodFilePath: string;
    methodStartLine: number;
    methodDecorators: string | null;
    methodDecoratorArgs: string | null;
    classDecorators: string | null;
    classDecoratorArgs: string | null;
  }>,
  insertedNodes: [] as unknown[][],
  insertedEdges: [] as unknown[][],
  metadata: new Map<string, string>(),
};

vi.spyOn(edgeQueries, 'insertEdges').mockImplementation(((_queries: unknown, edges: unknown[]) => {
  state.insertedEdges.push(edges);
}) as never);

vi.spyOn(metadataQueries, 'getMetadata').mockImplementation(
  ((_queries: unknown, key: string) => state.metadata.get(key) ?? null) as never,
);
vi.spyOn(metadataQueries, 'setMetadata').mockImplementation(((_queries: unknown, key: string, value: string) => {
  state.metadata.set(key, value);
}) as never);

const { HOOK, NESTJS_ROUTES_ALGO_VERSION } = await import('../src/index-hooks/nestjs-routes.js');

function decorators(names: string[]): string {
  return JSON.stringify(names);
}

function decoratorArgs(entries: Array<{ name: string; argStrings?: string[]; argIdents?: string[] }>): string {
  return JSON.stringify(entries.map((entry) => ({ argStrings: [], argIdents: [], ...entry })));
}

function ctx() {
  return {
    queries: {
      db: {
        prepare: () => ({
          all: () => state.rows,
        }),
      },
      insertNodes: (nodes: unknown[]) => {
        state.insertedNodes.push(nodes);
      },
    },
  } as never;
}

beforeEach(() => {
  state.rows = [];
  state.insertedNodes = [];
  state.insertedEdges = [];
  state.metadata = new Map();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('nestjs-routes index hook', () => {
  it('emits HTTP, GraphQL, and RPC routes from graph decorators', () => {
    state.rows = [
      {
        methodId: 'method:list',
        methodName: 'list',
        methodFilePath: 'src/users.controller.ts',
        methodStartLine: 10,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['/:id/'] }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller', argStrings: ['/users/'] }]),
      },
      {
        methodId: 'method:root',
        methodName: 'root',
        methodFilePath: 'src/root.controller.ts',
        methodStartLine: 20,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get' }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
      {
        methodId: 'method:query',
        methodName: 'author',
        methodFilePath: 'src/book.resolver.ts',
        methodStartLine: 30,
        methodDecorators: decorators(['Query']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Query', argStrings: ['ignored'] }]),
        classDecorators: decorators(['Resolver']),
        classDecoratorArgs: decoratorArgs([{ name: 'Resolver', argStrings: ['Book'] }]),
      },
      {
        methodId: 'method:rpc',
        methodName: 'sum',
        methodFilePath: 'src/messages.controller.ts',
        methodStartLine: 40,
        methodDecorators: decorators(['MessagePattern', 'EventPattern']),
        methodDecoratorArgs: decoratorArgs([
          { name: 'MessagePattern', argStrings: ['sum'] },
          { name: 'EventPattern', argStrings: ['created'] },
        ]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
      {
        methodId: 'method:skip-graphql',
        methodName: 'wrong',
        methodFilePath: 'src/wrong.controller.ts',
        methodStartLine: 50,
        methodDecorators: decorators(['Query']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Query' }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
      {
        methodId: 'method:skip-http',
        methodName: 'wrong',
        methodFilePath: 'src/wrong.resolver.ts',
        methodStartLine: 60,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['x'] }]),
        classDecorators: decorators(['Resolver']),
        classDecoratorArgs: decoratorArgs([{ name: 'Resolver' }]),
      },
    ];

    HOOK.afterIndexAll!(ctx());

    const nodes = state.insertedNodes.flat() as Array<{ name: string; qualifiedName: string; startLine: number }>;
    expect(nodes.map((node) => node.name)).toEqual([
      'GET /users/:id',
      'GET /',
      'GraphQL Query author',
      'MessagePattern sum',
      'EventPattern created',
    ]);
    expect(nodes.map((node) => node.qualifiedName)).toContain('src/book.resolver.ts::GraphQL Query::author');
    expect(nodes.map((node) => node.startLine)).toEqual([10, 20, 30, 40, 40]);
    expect(state.insertedEdges.flat()).toHaveLength(5);
    expect(state.metadata.get('last_mined_nestjs_routes_algo_version')).toBe(NESTJS_ROUTES_ALGO_VERSION);
  });

  it('uses stable distinct route ids for duplicate display names in one file', () => {
    state.rows = [
      {
        methodId: 'method:a',
        methodName: 'a',
        methodFilePath: 'src/dup.controller.ts',
        methodStartLine: 10,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['same'] }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
      {
        methodId: 'method:b',
        methodName: 'b',
        methodFilePath: 'src/dup.controller.ts',
        methodStartLine: 11,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['same'] }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
    ];

    HOOK.afterIndexAll!(ctx());

    const nodes = state.insertedNodes.flat() as Array<{ id: string; name: string }>;
    expect(nodes.map((node) => node.name)).toEqual(['GET /same', 'GET /same']);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
  });

  it('rejects partially corrupt decorator lists instead of silently filtering them', () => {
    state.rows = [
      {
        methodId: 'method:corrupt',
        methodName: 'corrupt',
        methodFilePath: 'src/corrupt.controller.ts',
        methodStartLine: 10,
        methodDecorators: JSON.stringify(['Get', 404]),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['corrupt'] }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
    ];

    HOOK.afterIndexAll!(ctx());

    expect(state.insertedNodes.flat()).toEqual([]);
    expect(state.insertedEdges.flat()).toEqual([]);
  });

  it('refreshes on algo mismatch, TS/JS changes, and removals during sync', () => {
    state.rows = [
      {
        methodId: 'method:list',
        methodName: 'list',
        methodFilePath: 'src/users.controller.ts',
        methodStartLine: 10,
        methodDecorators: decorators(['Get']),
        methodDecoratorArgs: decoratorArgs([{ name: 'Get', argStrings: ['users'] }]),
        classDecorators: decorators(['Controller']),
        classDecoratorArgs: decoratorArgs([{ name: 'Controller' }]),
      },
    ];

    HOOK.afterSync!(ctx(), { changedFilePaths: [], filesRemoved: 0 } as never);
    expect(state.metadata.get('last_mined_nestjs_routes_algo_version')).toBe(NESTJS_ROUTES_ALGO_VERSION);

    state.metadata.set('last_mined_nestjs_routes_algo_version', NESTJS_ROUTES_ALGO_VERSION);
    state.insertedNodes = [];
    HOOK.afterSync!(ctx(), { changedFilePaths: ['README.md'], filesRemoved: 0 } as never);
    expect(state.insertedNodes).toEqual([]);

    HOOK.afterSync!(ctx(), { changedFilePaths: ['src/app.ts'], filesRemoved: 0 } as never);
    expect(state.metadata.get('last_mined_nestjs_routes_algo_version')).toBe(NESTJS_ROUTES_ALGO_VERSION);

    HOOK.afterSync!(ctx(), { changedFilePaths: [], filesRemoved: 1 } as never);
    expect(state.metadata.get('last_mined_nestjs_routes_algo_version')).toBe(NESTJS_ROUTES_ALGO_VERSION);
  });
});
