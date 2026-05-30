/**
 * Pydantic schema recognizer (backlog B2 — the second registry entry).
 *
 * The Zod recognizer proved the registry shape for TS/JS. Pydantic is
 * the Python equivalent: a data model is a class inheriting
 * `BaseModel` / `BaseSettings`, whose typed class-body attributes are
 * the fields. To the base Python extractor those attributes are
 * invisible — it emits the `class` node and its methods but NOT the
 * annotated fields. This recognizer fills exactly that gap.
 *
 * Walks the parsed Python tree for `class X(BaseModel): ...` and, for
 * each, synthesizes a `struct` node + a `field` node per typed
 * attribute (signature = the annotation text) + `enum_member` nodes
 * for `Literal['a', 'b']` literal sets, with `contains` edges
 * (struct→field, field→enum_member).
 *
 * The `struct` is a SEPARATE facet from the `class` node the base
 * extractor emits for the same `class` statement — distinct `kind` ⇒
 * distinct `generateNodeId`, no collision (the same dual-facet pattern
 * the Zod recognizer uses for `constant` vs `struct`). The struct's
 * `qualifiedName` is `<file>::<Model>` (recognizer convention, shared
 * with Zod); the base `class` node uses a bare name — the two never
 * collide, they are deliberately distinct facets.
 *
 * SCOPE (v1). A class whose superclass list directly names `BaseModel`
 * / `BaseSettings`. Typed attributes (`name: str`, `age: int = 0`)
 * become fields; `Literal[...]` annotations expand to `enum_member`s;
 * `ClassVar[...]` attributes are skipped (not Pydantic fields). Out of
 * scope (no crash, just not modelled): a model that inherits BaseModel
 * transitively through a project-local base class; nested model
 * references resolved as edges (the base Python extractor already
 * emits `type_of` refs for `: OtherModel` annotations).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Language, Node } from '../../types.js';
import { mkNode, walkTree } from './helpers.js';
import {
  EMPTY_RESULT,
  type SchemaRecognizer,
  type SchemaRecognizerContext,
  type SchemaRecognizerResult,
} from './types.js';

const PYDANTIC_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['python']);

/** Pydantic base classes that mark a class as a data model. */
const PYDANTIC_BASES: ReadonlySet<string> = new Set(['BaseModel', 'BaseSettings']);

/**
 * Does `classDef`'s superclass list directly name a Pydantic base?
 * Handles both `class X(BaseModel)` and `class X(pydantic.BaseModel)`.
 */
function isPydanticModel(classDef: SyntaxNode): boolean {
  const supers = classDef.childForFieldName('superclasses');
  if (!supers) return false;
  for (const arg of supers.namedChildren) {
    if (!arg) continue;
    if (arg.type === 'identifier' && PYDANTIC_BASES.has(arg.text)) return true;
    if (arg.type === 'attribute') {
      const prop = arg.childForFieldName('attribute');
      if (prop && PYDANTIC_BASES.has(prop.text)) return true;
    }
  }
  return false;
}

/**
 * The `Literal['a', 'b', …]` string members of a field's annotation —
 * empty when the annotation contains no `Literal[...]`. In the Python
 * grammar a subscripted annotation is a `generic_type` (head identifier
 * + `type_parameter`); the literal members are the `string_content`
 * leaves under it.
 */
function literalMembers(typeNode: SyntaxNode): string[] {
  let generic: SyntaxNode | null = null;
  walkTree(typeNode, (n) => {
    if (generic || n.type !== 'generic_type') return;
    const head = n.namedChild(0);
    if (head && (head.text === 'Literal' || head.text.endsWith('.Literal'))) {
      generic = n;
    }
  });
  if (!generic) return [];
  const members: string[] = [];
  walkTree(generic, (n) => {
    if (n.type === 'string_content') members.push(n.text);
  });
  return members;
}

/** The `assignment` node of a class-body statement, or `null`. */
function fieldAssignment(stmt: SyntaxNode): SyntaxNode | null {
  const inner = stmt.type === 'expression_statement' ? stmt.namedChild(0) : stmt;
  return inner && inner.type === 'assignment' ? inner : null;
}

/** Synthesize the `struct` + `field` (+ `enum_member`) nodes for one
 *  `class X(BaseModel): ...` definition. */
function extractModel(classDef: SyntaxNode, ctx: SchemaRecognizerContext, now: number): SchemaRecognizerResult {
  const nameNode = classDef.childForFieldName('name');
  const body = classDef.childForFieldName('body');
  if (!nameNode || !body) return EMPTY_RESULT;

  const modelName = nameNode.text;
  const qualifiedName = `${ctx.filePath}::${modelName}`;
  const structId = ctx.idFactory.next('struct', modelName);
  const nodes: Node[] = [
    mkNode({
      id: structId,
      kind: 'struct',
      name: modelName,
      qualifiedName,
      ctx,
      start: classDef,
      end: classDef,
      signature: 'pydantic.BaseModel',
      now,
    }),
  ];
  const edges: Edge[] = [];

  for (const stmt of body.namedChildren) {
    if (!stmt) continue;
    const assignment = fieldAssignment(stmt);
    if (!assignment) continue;
    const left = assignment.childForFieldName('left');
    const typeNode = assignment.childForFieldName('type');
    // A Pydantic field is a typed attribute — an annotation is required.
    if (!left || left.type !== 'identifier' || !typeNode) continue;
    const signature = typeNode.text;
    // `ClassVar[...]` is a class variable, not a Pydantic field.
    if (signature.startsWith('ClassVar')) continue;

    const fieldName = left.text;
    const fieldLine = stmt.startPosition.row + 1;
    const fieldId = ctx.idFactory.next('field', fieldName);
    nodes.push(
      mkNode({
        id: fieldId,
        kind: 'field',
        name: fieldName,
        qualifiedName: `${qualifiedName}.${fieldName}`,
        ctx,
        start: stmt,
        end: stmt,
        signature,
        now,
      }),
    );
    edges.push({ source: structId, target: fieldId, kind: 'contains', confidence: 'EXTRACTED', line: fieldLine });

    for (const member of literalMembers(typeNode)) {
      const memberId = ctx.idFactory.next('enum_member', member);
      nodes.push(
        mkNode({
          id: memberId,
          kind: 'enum_member',
          name: member,
          qualifiedName: `${qualifiedName}.${fieldName}.${member}`,
          ctx,
          start: typeNode,
          end: typeNode,
          now,
        }),
      );
      edges.push({ source: fieldId, target: memberId, kind: 'contains', confidence: 'EXTRACTED', line: fieldLine });
    }
  }
  return { nodes, edges };
}

/** The Pydantic recognizer. */
export const pydanticRecognizer: SchemaRecognizer = {
  name: 'pydantic',
  languages: PYDANTIC_LANGUAGES,

  detect(ctx: SchemaRecognizerContext): boolean {
    for (const imp of ctx.imports) {
      if (imp === 'pydantic' || imp.startsWith('pydantic.')) return true;
    }
    return false;
  },

  extract(ctx: SchemaRecognizerContext): SchemaRecognizerResult {
    const now = Date.now();
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    walkTree(ctx.rootNode, (n) => {
      if (n.type !== 'class_definition' || !isPydanticModel(n)) return;
      const res = extractModel(n, ctx, now);
      nodes.push(...res.nodes);
      edges.push(...res.edges);
    });
    return nodes.length > 0 ? { nodes, edges } : EMPTY_RESULT;
  },
};
