import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/extraction/tree-sitter-helpers.js', () => ({
  getNodeText: vi.fn((node: { text?: string }) => node.text ?? ''),
  getChildByField: vi.fn((node: { fields?: Record<string, unknown> }, field: string) => node.fields?.[field] ?? null),
  getPrecedingDocstring: vi.fn((node: { doc?: string }) => node.doc),
}));

const { RESCRIPT_DEF } = await import('../src/extraction/languages/rescript.js');

type FakeNode = {
  type: string;
  text?: string;
  doc?: string;
  namedChildren: FakeNode[];
  children: FakeNode[];
  fields: Record<string, FakeNode | null>;
  parent?: FakeNode | null;
  previousNamedSibling?: FakeNode | null;
  startPosition: { row: number; column: number };
};

function node(type: string, text = type, opts: Partial<FakeNode> = {}): FakeNode {
  return {
    type,
    text,
    namedChildren: [],
    children: [],
    fields: {},
    parent: null,
    previousNamedSibling: null,
    startPosition: { row: 0, column: 0 },
    ...opts,
  };
}

function withParent<T extends FakeNode>(parent: T): T {
  for (const child of parent.namedChildren) child.parent = parent;
  for (const child of Object.values(parent.fields)) {
    if (child) child.parent = parent;
  }
  return parent;
}

function ctx() {
  const state = {
    created: [] as Array<{ kind: string; name: string; extra?: unknown }>,
    scopes: [] as string[],
    popped: 0,
    typeRefs: [] as Array<{ node: string; id: string; kind: string }>,
    visitedBodies: [] as Array<{ body: string; id: string }>,
    visitedNodes: [] as string[],
    unresolved: [] as unknown[],
    nodeStack: ['caller:1'],
  };
  return {
    state,
    ctx: {
      source: '',
      nodeStack: state.nodeStack,
      createNode: ({ kind, name, extra }: { kind: string; name: string; extra?: unknown }) => {
        state.created.push({ kind, name, extra });
        return { id: `${kind}:${name}` };
      },
      extractTypeRefs: (n: FakeNode, id: string, kind: string) =>
        state.typeRefs.push({ node: n.text ?? n.type, id, kind }),
      pushScope: (id: string) => state.scopes.push(id),
      popScope: () => {
        state.popped++;
      },
      visitFunctionBody: (body: FakeNode, id: string) => state.visitedBodies.push({ body: body.text ?? body.type, id }),
      visitNode: (n: FakeNode) => state.visitedNodes.push(n.type),
      addUnresolvedReference: (ref: unknown) => state.unresolved.push(ref),
    } as never,
  };
}

const extractor = RESCRIPT_DEF.grammar.extractor;

describe('ReScript language extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts imports, signatures, and async markers', () => {
    const moduleExpr = node('module_expression', 'React');
    expect(
      extractor.extractImport?.(node('open_statement', 'open React', { namedChildren: [moduleExpr] }) as never, ''),
    ).toEqual({
      moduleName: 'React',
      signature: 'open React',
    });
    const moduleId = node('module_identifier', 'Belt');
    expect(
      extractor.extractImport?.(node('include_statement', 'include Belt', { namedChildren: [moduleId] }) as never, ''),
    ).toEqual({
      moduleName: 'Belt',
      signature: 'include Belt',
    });
    expect(extractor.extractImport?.(node('open_statement', 'open') as never, '')).toBeNull();

    const params = node('parameters', '(x)');
    const ret = node('return_type', 'int');
    const body = node('function', 'fn', { fields: { parameters: params, return_type: ret } });
    const binding = node('let_binding', 'let f', { fields: { body } });
    expect(extractor.getSignature?.(binding as never, '')).toBe('(x) => int');

    const awaitBody = node('await_expression', 'await p');
    const asyncFn = node('function', 'async', { fields: { body: awaitBody } });
    expect(extractor.isAsync?.(node('let_binding', 'let async', { fields: { body: asyncFn } }) as never)).toBe(true);
    expect(extractor.isAsync?.(node('let_binding', 'let plain') as never)).toBe(false);

    const ext = node('external_declaration', 'external fetch', {
      namedChildren: [node('type_annotation', ': string => unit')],
    });
    expect(extractor.getSignature?.(ext as never, '')).toBe(': string => unit');
  });

  it('visits let functions, variables, modules, types, externals, exceptions, and pipes', () => {
    const h = ctx();
    const dec = node('decorator', '@react.component');
    const pattern = node('pattern', 'render');
    const params = node('parameters', '(props)');
    const ret = node('return_type', 'React.element');
    const fnBody = node('body', 'body');
    const fn = node('function', 'fn', { fields: { parameters: params, return_type: ret, body: fnBody } });
    const letBinding = node('let_binding', 'let render', {
      fields: { pattern, body: fn },
      previousNamedSibling: dec,
    });
    const letDecl = withParent(node('let_declaration', 'let render', { namedChildren: [letBinding], doc: 'doc' }));

    expect(extractor.visitNode?.(letDecl as never, h.ctx)).toBe(true);
    expect(h.state.created[0]).toMatchObject({ kind: 'function', name: 'render' });
    expect(h.state.typeRefs).toEqual([
      { node: '(props)', id: 'function:render', kind: 'type_of' },
      { node: 'React.element', id: 'function:render', kind: 'returns' },
    ]);
    expect(h.state.scopes).toContain('function:render');
    expect(h.state.visitedBodies).toEqual([{ body: 'body', id: 'function:render' }]);
    expect(h.state.popped).toBe(1);

    const variableBody = node('body', 'compute()', { namedChildren: [node('call_expression', 'compute()')] });
    extractor.visitNode?.(
      node('let_binding', 'let value', {
        fields: { pattern: node('pattern', 'value'), body: variableBody },
        namedChildren: [node('type_annotation', ': int')],
      }) as never,
      h.ctx,
    );
    expect(h.state.created.at(-1)).toMatchObject({ kind: 'variable', name: 'value' });
    expect(h.state.visitedNodes).toContain('call_expression');

    const moduleBody = node('module_expression', 'OtherModule');
    extractor.visitNode?.(
      withParent(
        node('module_declaration', 'module M', {
          namedChildren: [node('module_binding', 'M', { fields: { name: node('name', 'M'), definition: moduleBody } })],
        }),
      ) as never,
      h.ctx,
    );
    expect(h.state.created.some((created) => created.kind === 'namespace' && created.name === 'M')).toBe(true);
    expect(h.state.unresolved).toContainEqual(
      expect.objectContaining({ fromNodeId: 'namespace:M', referenceName: 'OtherModule', referenceKind: 'references' }),
    );

    const variants = node('variant_type', 'variants', {
      namedChildren: [node('variant_declaration', 'A', { namedChildren: [node('variant_identifier', 'A')] })],
    });
    extractor.visitNode?.(
      node('type_binding', 'type t', { fields: { name: node('name', 't') }, namedChildren: [variants] }) as never,
      h.ctx,
    );
    expect(h.state.created.some((created) => created.kind === 'enum' && created.name === 't')).toBe(true);
    expect(h.state.created.some((created) => created.kind === 'enum_member' && created.name === 'A')).toBe(true);

    const record = node('record_type', 'record', {
      namedChildren: [node('record_type_field', 'name', { namedChildren: [node('property_identifier', 'name')] })],
    });
    extractor.visitNode?.(
      node('type_binding', 'type user', { fields: { name: node('name', 'user') }, namedChildren: [record] }) as never,
      h.ctx,
    );
    expect(h.state.created.some((created) => created.kind === 'struct' && created.name === 'user')).toBe(true);
    expect(h.state.created.some((created) => created.kind === 'field' && created.name === 'name')).toBe(true);

    extractor.visitNode?.(
      node('external_declaration', 'external fetch', {
        namedChildren: [node('value_identifier', 'fetch'), node('type_annotation', ': string => promise<string>')],
      }) as never,
      h.ctx,
    );
    extractor.visitNode?.(
      node('exception_declaration', 'exception Boom', { namedChildren: [node('variant_identifier', 'Boom')] }) as never,
      h.ctx,
    );
    extractor.visitNode?.(
      node('pipe_expression', '|>', {
        namedChildren: [
          node('identifier', 'value'),
          node('call_expression', 'map(value)', { fields: { function: node('function', 'map') } }),
        ],
      }) as never,
      h.ctx,
    );

    expect(h.state.created.some((created) => created.kind === 'function' && created.name === 'fetch')).toBe(true);
    expect(h.state.created.some((created) => created.kind === 'type_alias' && created.name === 'Boom')).toBe(true);
    expect(h.state.unresolved).toContainEqual(
      expect.objectContaining({ fromNodeId: 'caller:1', referenceName: 'map', referenceKind: 'calls' }),
    );
    expect(extractor.visitNode?.(node('unknown') as never, h.ctx)).toBe(false);
  });
});
