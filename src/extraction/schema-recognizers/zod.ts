/**
 * Zod schema recognizer (backlog B2 — the first registry entry).
 *
 * Walks an already-parsed TS/JS tree-sitter tree for `const X =
 * z.object({ ... })` declarations and synthesizes the data model the
 * language extractor can't see: a `struct` node per schema, a `field`
 * node per property, `enum_member` nodes for `z.enum([...])` literal
 * sets, and `contains` edges (struct→field, field→enum_member).
 *
 * SCOPE. Recognises the canonical `const X = z.object({...})` form,
 * including a trailing chain (`.strict()` / `.refine(...)` / …) —
 * `findZodCall` descends the chain to the base `z.object` call. Each
 * property's leading `z.<type>` is captured as the field's signature;
 * `z.enum([...])` literal members are expanded.
 *
 * CONSUMER EDGES (v2 step 1). After the struct/field pass, a second
 * pass walks the same tree for *consumers* of the schemas declared in
 * this file and emits cross-symbol edges:
 *   - a `type_of` edge from a symbol annotated `z.infer<typeof X>` to
 *     the `struct` X — "this alias / variable IS the schema's shape";
 *   - a `references` edge from an `X.shape.<field>` member access to
 *     the `field` node — "this code reads the schema's `<field>`".
 * Same-file only: the consumer pass resolves against schemas declared
 * in THIS file (it holds their node ids directly). A cross-file
 * consumer — `z.infer<typeof X>` where X is imported — is left to the
 * resolver and is NOT yet modelled here.
 *
 * NESTED OBJECTS (v2 step 2). A property whose value chain resolves to
 * `z.object({...})` recurses: the `field` gains a nested `struct`
 * (`contains` edge field→struct) populated with the inner fields, to
 * `MAX_NEST_DEPTH`.
 *
 * INLINE SCHEMAS (v2 step 3). A `z.object({...})` NOT bound to a const
 * — defined as a call argument, `defineTool({ schema: z.object(...) })`
 * — is recognised too, named from the enclosing object key. A
 * `consumed` set of `z.object` argument node-ids keeps the inline pass
 * from re-modelling a schema the declarator/nested pass already owns.
 *
 * The `struct` node is a SEPARATE facet from the `constant` node the
 * base extractor emits for the same binding — distinct `kind` ⇒
 * distinct `generateNodeId`, no collision. The const is the value
 * binding; the struct is the schema shape.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Language, Node } from '../../types.js';
import { mkNode, unquote, walkTree } from './helpers.js';
import {
  EMPTY_RESULT,
  type SchemaRecognizer,
  type SchemaRecognizerContext,
  type SchemaRecognizerResult,
} from './types.js';

const ZOD_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['typescript', 'tsx', 'javascript', 'jsx']);

/** Recursively collect every `variable_declarator` under `root`. */
function collectDeclarators(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === 'variable_declarator') out.push(n);
    for (const c of n.namedChildren) {
      if (c) stack.push(c);
    }
  }
  return out;
}

/**
 * Descend an expression — through a method chain (`.optional()`,
 * `.strict()`, …) — to the `z.<method>(...)` call node, or `null`.
 * `z.string().min(1)` with `method='string'` finds the inner
 * `z.string()` call; `z.object({...}).strict()` with `method='object'`
 * finds the `z.object({...})` call.
 */
function findZodCall(value: SyntaxNode | null, method: string): SyntaxNode | null {
  let n: SyntaxNode | null = value;
  // Bounded: each step strictly descends the AST.
  while (n) {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj && obj.type === 'identifier' && obj.text === 'z' && prop && prop.text === method) {
          return n;
        }
        n = obj; // a chain — `z.object({...}).strict()` — descend the receiver
        continue;
      }
      n = fn;
      continue;
    }
    if (n.type === 'member_expression') {
      n = n.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/** The first argument node of a call, or `null`. */
function firstArg(call: SyntaxNode | null): SyntaxNode | null {
  const args = call?.childForFieldName('arguments');
  return args?.namedChild(0) ?? null;
}

/**
 * The leading Zod method of a field's value chain — `z.string()...` →
 * `'string'`, `z.enum([...])` → `'enum'`. `null` when the value is not
 * a `z.<...>()` chain.
 */
function zodLeafType(value: SyntaxNode | null): string | null {
  let n: SyntaxNode | null = value;
  while (n) {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj && obj.type === 'identifier' && obj.text === 'z') {
          return prop ? prop.text : null;
        }
        n = obj;
        continue;
      }
      n = fn;
      continue;
    }
    if (n.type === 'member_expression') {
      n = n.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Bundled arguments for {@link extractEnumMembers} — collapses what was
 * a 5-positional-parameter call (a `long_parameter_list` finding) into
 * a single object.
 */
interface ExtractEnumMembersArgs {
  /** The field's value node — the `z.enum([...])` call chain. */
  readonly fieldValue: SyntaxNode;
  /** Node id the emitted `enum_member` nodes hang off via a `contains` edge. */
  readonly fieldId: string;
  /** Dotted owner path of the field — `file.ts::Schema.status`. */
  readonly fieldQualifiedName: string;
  readonly ctx: SchemaRecognizerContext;
  readonly now: number;
}

/** Expand a `z.enum([...])` field into `enum_member` nodes + edges. */
function extractEnumMembers(args: ExtractEnumMembersArgs): SchemaRecognizerResult {
  const { fieldValue, fieldId, fieldQualifiedName, ctx, now } = args;
  const arr = firstArg(findZodCall(fieldValue, 'enum'));
  if (!arr || arr.type !== 'array') return EMPTY_RESULT;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const el of arr.namedChildren) {
    if (!el || el.type !== 'string') continue;
    const member = unquote(el.text);
    const id = ctx.idFactory.next('enum_member', member);
    nodes.push(
      mkNode({
        id,
        kind: 'enum_member',
        name: member,
        qualifiedName: `${fieldQualifiedName}.${member}`,
        ctx,
        start: el,
        end: el,
        now,
      }),
    );
    edges.push({
      source: fieldId,
      target: id,
      kind: 'contains',
      confidence: 'EXTRACTED',
      line: el.startPosition.row + 1,
    });
  }
  return { nodes, edges };
}

/**
 * A schema this recognizer synthesized — the lookup the consumer pass
 * resolves `z.infer<typeof X>` / `X.shape.<field>` references against.
 */
interface RecognizedSchema {
  /** Schema binding name — the `X` in `const X = z.object(...)`. */
  readonly name: string;
  /** Node id of the synthesized `struct`. */
  readonly structId: string;
  /** Field name → synthesized `field` node id. */
  readonly fields: ReadonlyMap<string, string>;
}

/** `extractSchema`'s result — nodes/edges plus the schema descriptor. */
interface ExtractSchemaResult extends SchemaRecognizerResult {
  /** The schema descriptor, or `null` when the declarator isn't one. */
  readonly schema: RecognizedSchema | null;
}

const EMPTY_SCHEMA_RESULT: ExtractSchemaResult = { nodes: [], edges: [], schema: null };

/** Maximum nested-object depth — guards a pathological deeply-nested
 *  `z.object` chain from unbounded recursion. */
const MAX_NEST_DEPTH = 8;

/** Nodes + edges + the field-name → field-id map for one object body. */
interface ObjectFieldsResult {
  readonly nodes: Node[];
  readonly edges: Edge[];
  readonly fields: Map<string, string>;
}

/**
 * Bundled arguments for {@link emitObjectFields} — collapses what was a
 * 7-positional-parameter call (a `long_parameter_list` finding) into a
 * single object. `ctx` / `now` / `consumed` are invariant across the
 * nested-object recursion; `objArg` / `containerId` / `qualifiedPrefix`
 * / `depth` change per level.
 */
interface EmitObjectFieldsArgs {
  /** The `{...}` object-literal node passed to `z.object(...)`. */
  readonly objArg: SyntaxNode;
  /** Node id the emitted `field` nodes hang off via a `contains` edge. */
  readonly containerId: string;
  /** Dotted owner path — `file.ts::Schema` at the top level,
   *  `file.ts::Schema.address` one level down. */
  readonly qualifiedPrefix: string;
  readonly ctx: SchemaRecognizerContext;
  readonly now: number;
  /** Nested-object recursion depth; guarded by {@link MAX_NEST_DEPTH}. */
  readonly depth: number;
  /** `z.object` argument node ids already emitted — shared so the
   *  inline-schema pass skips them. */
  readonly consumed: Set<number>;
}

/**
 * Emit a `field` node per property of a `z.object` argument, each with
 * a `contains` edge from `containerId`. A property whose value chain
 * resolves to a nested `z.object({...})` recurses (v2 step 2): the
 * field gains a nested `struct` (a `contains` edge field→struct)
 * populated with the inner object's fields. `qualifiedPrefix` is the
 * dotted owner path — `file.ts::Schema` at the top level,
 * `file.ts::Schema.address` one level down.
 */
function emitObjectFields(args: EmitObjectFieldsArgs): ObjectFieldsResult {
  const { objArg, containerId, qualifiedPrefix, ctx, now, depth, consumed } = args;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const fields = new Map<string, string>();

  for (const pair of objArg.namedChildren) {
    if (!pair || pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const fieldValue = pair.childForFieldName('value');
    if (!keyNode || !fieldValue) continue;

    const fieldName = unquote(keyNode.text);
    const leaf = zodLeafType(fieldValue);
    const fieldLine = pair.startPosition.row + 1;
    const fieldQualifiedName = `${qualifiedPrefix}.${fieldName}`;
    const fieldId = ctx.idFactory.next('field', fieldName);
    nodes.push(
      mkNode({
        id: fieldId,
        kind: 'field',
        name: fieldName,
        qualifiedName: fieldQualifiedName,
        ctx,
        start: pair,
        end: pair,
        ...(leaf ? { signature: `z.${leaf}` } : {}),
        now,
      }),
    );
    edges.push({ source: containerId, target: fieldId, kind: 'contains', confidence: 'EXTRACTED', line: fieldLine });
    fields.set(fieldName, fieldId);

    if (leaf === 'enum') {
      const enumRes = extractEnumMembers({ fieldValue, fieldId, fieldQualifiedName, ctx, now });
      nodes.push(...enumRes.nodes);
      edges.push(...enumRes.edges);
      continue;
    }
    if (leaf === 'object' && depth < MAX_NEST_DEPTH) {
      const innerObj = firstArg(findZodCall(fieldValue, 'object'));
      if (innerObj && innerObj.type === 'object') {
        consumed.add(innerObj.id);
        const nestedId = ctx.idFactory.next('struct', fieldName);
        nodes.push(
          mkNode({
            id: nestedId,
            kind: 'struct',
            name: fieldName,
            qualifiedName: fieldQualifiedName,
            ctx,
            start: pair,
            end: pair,
            signature: 'z.object',
            now,
          }),
        );
        edges.push({ source: fieldId, target: nestedId, kind: 'contains', confidence: 'EXTRACTED', line: fieldLine });
        const inner = emitObjectFields({
          objArg: innerObj,
          containerId: nestedId,
          qualifiedPrefix: fieldQualifiedName,
          ctx,
          now,
          depth: depth + 1,
          consumed,
        });
        nodes.push(...inner.nodes);
        edges.push(...inner.edges);
      }
    }
  }
  return { nodes, edges, fields };
}

/**
 * Bundled arguments for {@link extractSchema} — collapses what was a
 * 4-positional-parameter call (a `long_parameter_list` finding) into a
 * single object.
 */
interface ExtractSchemaArgs {
  /** The `const X = z.object({...})` declarator node. */
  readonly decl: SyntaxNode;
  readonly ctx: SchemaRecognizerContext;
  readonly now: number;
  /** `z.object` argument node ids already emitted — shared so the
   *  inline-schema pass skips them. */
  readonly consumed: Set<number>;
}

/** Synthesize the `struct` + `field` (+ `enum_member`, + nested
 *  `struct`) nodes for one `const X = z.object({...})` declarator.
 *  Every `z.object` argument it consumes (the top one + every nested
 *  one) is recorded in `consumed` so the inline-schema pass skips it. */
function extractSchema(args: ExtractSchemaArgs): ExtractSchemaResult {
  const { decl, ctx, now, consumed } = args;
  const nameNode = decl.childForFieldName('name');
  const valueNode = decl.childForFieldName('value');
  if (!nameNode || nameNode.type !== 'identifier' || !valueNode) return EMPTY_SCHEMA_RESULT;

  const objArg = firstArg(findZodCall(valueNode, 'object'));
  if (!objArg || objArg.type !== 'object') return EMPTY_SCHEMA_RESULT;
  consumed.add(objArg.id);

  const schemaName = nameNode.text;
  const qualifiedName = `${ctx.filePath}::${schemaName}`;
  const structId = ctx.idFactory.next('struct', schemaName);
  const nodes: Node[] = [
    mkNode({
      id: structId,
      kind: 'struct',
      name: schemaName,
      qualifiedName,
      ctx,
      start: decl,
      end: valueNode,
      signature: 'z.object',
      now,
    }),
  ];
  const body = emitObjectFields({
    objArg,
    containerId: structId,
    qualifiedPrefix: qualifiedName,
    ctx,
    now,
    depth: 0,
    consumed,
  });
  nodes.push(...body.nodes);
  return { nodes, edges: body.edges, schema: { name: schemaName, structId, fields: body.fields } };
}

// ---------------------------------------------------------------------------
// Inline-schema pass (v2 step 3) — a `z.object({...})` not bound to a const.
// ---------------------------------------------------------------------------

/** Is `call` a direct `z.object(...)` call (not a chain method)? */
function isZodObjectCall(call: SyntaxNode): boolean {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  return !!obj && obj.type === 'identifier' && obj.text === 'z' && !!prop && prop.text === 'object';
}

/**
 * Name an inline `z.object({...})` from its surroundings: the key of
 * the enclosing `pair` (`defineTool({ schema: z.object({...}) })` →
 * `schema`). Returns `null` when the call belongs to a `const`
 * declarator's value chain (the declarator pass owns it) or sits in a
 * bare position with no nameable context.
 */
function inlineSchemaName(call: SyntaxNode): string | null {
  let n: SyntaxNode | null = call.parent;
  while (n) {
    if (n.type === 'pair') {
      const key = n.childForFieldName('key');
      return key ? unquote(key.text) : null;
    }
    // Reached the declarator without passing a pair → the declarator
    // pass already owns this schema; not an inline one.
    if (n.type === 'variable_declarator') return null;
    // Chain / argument wrappers — keep climbing.
    if (
      n.type === 'arguments' ||
      n.type === 'call_expression' ||
      n.type === 'member_expression' ||
      n.type === 'object' ||
      n.type === 'parenthesized_expression'
    ) {
      n = n.parent;
      continue;
    }
    // A statement / block / program — bare expression, no name.
    return null;
  }
  return null;
}

/**
 * Walk the tree for `z.object({...})` calls NOT already consumed by
 * the declarator pass — schemas defined inline as a call argument —
 * and synthesize the same `struct` / `field` structure for each.
 */
function extractInlineSchemas(
  ctx: SchemaRecognizerContext,
  now: number,
  consumed: Set<number>,
): SchemaRecognizerResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  walkTree(ctx.rootNode, (n) => {
    if (n.type !== 'call_expression' || !isZodObjectCall(n)) return;
    const objArg = firstArg(n);
    if (!objArg || objArg.type !== 'object' || consumed.has(objArg.id)) return;
    const name = inlineSchemaName(n);
    if (!name) return;
    consumed.add(objArg.id);
    const qualifiedName = `${ctx.filePath}::${name}`;
    const structId = ctx.idFactory.next('struct', name);
    nodes.push(
      mkNode({
        id: structId,
        kind: 'struct',
        name,
        qualifiedName,
        ctx,
        start: n,
        end: n,
        signature: 'z.object',
        now,
      }),
    );
    const body = emitObjectFields({
      objArg,
      containerId: structId,
      qualifiedPrefix: qualifiedName,
      ctx,
      now,
      depth: 0,
      consumed,
    });
    nodes.push(...body.nodes);
    edges.push(...body.edges);
  });
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Consumer pass (v2 step 1) — `type_of` / `references` edges.
// ---------------------------------------------------------------------------

/**
 * The id of the smallest already-extracted symbol whose line range
 * encloses `site` — the consumer-edge source. `import` / `file` nodes
 * are skipped (an `import` line-encloses nothing useful; the `file`
 * node is the catch-all fallback when no tighter symbol matches).
 */
function enclosingNodeId(site: SyntaxNode, ctx: SchemaRecognizerContext): string {
  const line = site.startPosition.row + 1;
  let best: Node | null = null;
  for (const n of ctx.extractedNodes) {
    if (n.filePath !== ctx.filePath || n.kind === 'file' || n.kind === 'import') continue;
    if (n.startLine > line || n.endLine < line) continue;
    if (!best || n.endLine - n.startLine < best.endLine - best.startLine) best = n;
  }
  return best ? best.id : `file:${ctx.filePath}`;
}

/** The bare type name inside `<typeof X>`, or `null`. */
function typeofArgName(genericType: SyntaxNode): string | null {
  let typeArgs: SyntaxNode | null = null;
  for (const c of genericType.namedChildren) {
    if (c && c.type === 'type_arguments') {
      typeArgs = c;
      break;
    }
  }
  if (!typeArgs) return null;
  let found: string | null = null;
  walkTree(typeArgs, (n) => {
    if (found) return;
    if (n.type === 'type_query') {
      for (const c of n.namedChildren) {
        if (c && c.type === 'identifier') {
          found = c.text;
          return;
        }
      }
    }
  });
  return found;
}

/**
 * For an `X.shape.<field>` member expression, the (schemaName, field)
 * pair — or `null` when it isn't that shape.
 */
function shapeFieldRef(member: SyntaxNode): { schema: string; field: string } | null {
  const property = member.childForFieldName('property');
  const object = member.childForFieldName('object');
  if (!property || !object || object.type !== 'member_expression') return null;
  const innerObj = object.childForFieldName('object');
  const innerProp = object.childForFieldName('property');
  if (!innerObj || innerObj.type !== 'identifier' || !innerProp || innerProp.text !== 'shape') {
    return null;
  }
  return { schema: innerObj.text, field: property.text };
}

/**
 * For an `X.pick({...})` / `X.omit({...})` call, the schema name plus
 * the field-name keys of the object argument — or `null`.
 */
function pickOmitRefs(call: SyntaxNode): { schema: string; fields: string[] } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return null;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!obj || obj.type !== 'identifier' || !prop) return null;
  if (prop.text !== 'pick' && prop.text !== 'omit') return null;
  const arg = firstArg(call);
  if (!arg || arg.type !== 'object') return null;
  const fields: string[] = [];
  for (const pair of arg.namedChildren) {
    if (!pair || pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    if (key) fields.push(unquote(key.text));
  }
  return { schema: obj.text, fields };
}

/**
 * Second pass: walk the tree for consumers of the schemas declared in
 * THIS file and emit `type_of` / `references` edges. Edges are
 * de-duplicated on `source|target|kind` (a field read N times in one
 * function yields one edge).
 */
function extractConsumers(ctx: SchemaRecognizerContext, schemas: ReadonlyMap<string, RecognizedSchema>): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (e: { source: string; target: string; kind: 'type_of' | 'references'; line: number }): void => {
    const key = `${e.source}|${e.target}|${e.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: e.source, target: e.target, kind: e.kind, confidence: 'EXTRACTED', line: e.line });
  };

  walkTree(ctx.rootNode, (n) => {
    // (a) `z.infer<typeof X>` annotation → `type_of` edge to struct X.
    if (n.type === 'generic_type') {
      const nameNode = n.namedChild(0);
      if (nameNode && nameNode.text === 'z.infer') {
        const targetName = typeofArgName(n);
        const schema = targetName ? schemas.get(targetName) : undefined;
        if (schema)
          add({
            source: enclosingNodeId(n, ctx),
            target: schema.structId,
            kind: 'type_of',
            line: n.startPosition.row + 1,
          });
      }
      return;
    }
    // (b) `X.shape.<field>` member access → `references` edge to field.
    if (n.type === 'member_expression') {
      const ref = shapeFieldRef(n);
      const fieldId = ref ? schemas.get(ref.schema)?.fields.get(ref.field) : undefined;
      if (fieldId)
        add({ source: enclosingNodeId(n, ctx), target: fieldId, kind: 'references', line: n.startPosition.row + 1 });
      return;
    }
    // (c) `X.pick({...})` / `X.omit({...})` → `references` edge per field.
    if (n.type === 'call_expression') {
      const refs = pickOmitRefs(n);
      const schema = refs ? schemas.get(refs.schema) : undefined;
      if (schema && refs) {
        const source = enclosingNodeId(n, ctx);
        for (const f of refs.fields) {
          const fieldId = schema.fields.get(f);
          if (fieldId) add({ source, target: fieldId, kind: 'references', line: n.startPosition.row + 1 });
        }
      }
    }
  });
  return edges;
}

/** The Zod recognizer. */
export const zodRecognizer: SchemaRecognizer = {
  name: 'zod',
  languages: ZOD_LANGUAGES,

  detect(ctx: SchemaRecognizerContext): boolean {
    return ctx.imports.has('zod');
  },

  extract(ctx: SchemaRecognizerContext): SchemaRecognizerResult {
    const now = Date.now();
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const schemas = new Map<string, RecognizedSchema>();
    // `z.object` argument node-ids already claimed — keeps the inline
    // pass from re-modelling a top-level / nested declarator schema.
    const consumed = new Set<number>();
    for (const decl of collectDeclarators(ctx.rootNode)) {
      const res = extractSchema({ decl, ctx, now, consumed });
      nodes.push(...res.nodes);
      edges.push(...res.edges);
      if (res.schema) schemas.set(res.schema.name, res.schema);
    }
    // Inline-schema pass — `z.object({...})` defined as a call argument.
    const inlineRes = extractInlineSchemas(ctx, now, consumed);
    nodes.push(...inlineRes.nodes);
    edges.push(...inlineRes.edges);
    // Consumer-edge pass — `type_of` / `references` into named schemas.
    if (schemas.size > 0) edges.push(...extractConsumers(ctx, schemas));
    return nodes.length > 0 ? { nodes, edges } : EMPTY_RESULT;
  },
};
