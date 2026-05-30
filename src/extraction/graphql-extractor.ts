import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Node, Edge, ExtractionResult, UnresolvedReference, NodeKind } from '../types.js';
import { getNodeText, type NodeIdFactory } from './tree-sitter-helpers.js';
import { getParser } from './grammars.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * GraphqlExtractor — extracts GraphQL Schema Definition Language (SDL) into
 * the graph. Same shape as `SqlExtractor` / `HclExtractor`: GraphQL is
 * declarative (types, interfaces, inputs, enums, unions, scalars, directives,
 * schema), with no functions/methods in the OO sense.
 *
 *   GraphQL construct                    | NodeKind     | Notes
 *   -------------------------------------|--------------|----------------------------------
 *   `type X implements I { … }`          | class        | implements → `implements` edges
 *   `interface X { … }`                  | interface    |
 *   `input X { … }`                      | class        | (no dedicated input kind)
 *   `enum X { … }`                       | enum         | with `enum_member` children
 *   `union X = A | B | C`                | type_alias   | members → `references` edges
 *   `scalar X`                           | type_alias   | no fields
 *   `directive @x(args) on LOCS`         | function     | args resemble parameters
 *   `field: Type`  (inside type/iface)   | field        | type → `type_of` edge
 *   `schema { query: Q }`                | (skipped)    | config, no useful symbol
 *
 * Extensions (federation-style cross-file merging, B #27) emit a separate
 * node with the same kind as the base type plus an `extends` edge:
 *
 *   `extend type X { … }`                | class        | extends → base type
 *   `extend interface X { … }`           | interface    | extends → base type
 *   `extend input X { … }`               | class        | extends → base type
 *   `extend enum X { … }`                | enum         | extends + new enum_members
 *   `extend union X = …`                 | type_alias   | extends + new references
 *   `extend scalar X`                    | (unsupported)| grammar parses as ERROR
 *
 * Per-line node-id derivation makes multiple extensions of the same type
 * distinct. Cross-file merging is reconstructible by walking the `extends`
 * edges; the existing ReferenceResolver name-matches across files.
 *
 * The tree-sitter-graphql grammar (joowani/tree-sitter-graphql v0.1.0+, MIT)
 * does NOT expose tagged AST fields (`childForFieldName` returns null
 * everywhere), so traversal is by named child type. Types within type
 * expressions are extracted by unwrapping `non_null_type` / `list_type` to
 * the base `named_type` and reading its `name` leaf.
 *
 * Out of scope for v1: query / mutation / subscription operation bodies
 * (selection sets), fragment definitions, variable definitions inside
 * operations. Schema-only files are by far the common case for code
 * intelligence; operation files (`.graphql` / `.gql` query bundles) parse
 * cleanly but their selection-set structure isn't emitted as edges.
 */

// ---------------------------------------------------------------------------
// Module-level state type — passed to free-function emit helpers so they can
// mutate the extractor's accumulators without living on the class.
// ---------------------------------------------------------------------------

interface GqlState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  idFactory: NodeIdFactory;
}

/** Argument bundle for {@link gqlCreateNode}. */
interface CreateNodeArgs {
  kind: NodeKind;
  name: string;
  node: SyntaxNode;
  parentNodeId: string;
  signature: string;
  docstring?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure AST helpers (no state needed)
// ---------------------------------------------------------------------------

function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child?.type === type) return child;
  }
  return null;
}

function collectNamedTypes(node: SyntaxNode, source: string): string[] {
  const out: string[] = [];
  const visit = (n: SyntaxNode) => {
    if (n.type === 'named_type') {
      const leaf = findChildByType(n, 'name');
      if (leaf) {
        const text = getNodeText(leaf, source).trim();
        if (text) out.push(text);
      }
    }
    for (const c of n.namedChildren) {
      if (c) visit(c);
    }
  };
  visit(node);
  return out;
}

/**
 * Unwrap `non_null_type` / `list_type` to find the base `named_type`'s name.
 * Returns null if the chain doesn't end at a named_type (shouldn't happen
 * in valid GraphQL).
 */
function unwrapTypeName(typeNode: SyntaxNode, source: string): string | null {
  let cur: SyntaxNode | null = typeNode;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.type === 'named_type') {
      const nameLeaf = findChildByType(cur, 'name');
      return nameLeaf ? getNodeText(nameLeaf, source).trim() || null : null;
    }
    if (cur.type === 'non_null_type' || cur.type === 'list_type' || cur.type === 'type') {
      cur = cur.namedChild(0);
      continue;
    }
    return null;
  }
  return null;
}

/** Build a `name: type` field signature, falling back to bare `name` when the type node is absent. */
function buildFieldSignature(fieldName: string, typeNode: SyntaxNode | null, source: string): string {
  if (!typeNode) return fieldName;
  const typeText = getNodeText(typeNode, source).trim();
  if (!typeText) return fieldName;
  return `${fieldName}: ${typeText}`;
}

const GRAPHQL_BUILTIN_TYPES: ReadonlySet<string> = new Set(['Int', 'Float', 'String', 'Boolean', 'ID']);

// ---------------------------------------------------------------------------
// State-mutating free functions (emit helpers)
// ---------------------------------------------------------------------------

function gqlReadNamedChildText(st: GqlState, node: SyntaxNode, type: string): string {
  const child = findChildByType(node, type);
  return child ? getNodeText(child, st.source).trim() : '';
}

function gqlReadDescription(st: GqlState, node: SyntaxNode): string | undefined {
  const desc = findChildByType(node, 'description');
  if (!desc) return undefined;
  const raw = getNodeText(desc, st.source);
  return (
    raw
      .replace(/^"""([\s\S]*?)"""$/, '$1')
      .replace(/^"([\s\S]*?)"$/, '$1')
      .trim() || undefined
  );
}

function gqlCreateNode(st: GqlState, args: CreateNodeArgs): string | null {
  const { kind, name, node, parentNodeId, signature, docstring } = args;
  if (!name) return null;
  const id = st.idFactory.next(kind, name);
  const record: Node = {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath: st.filePath,
    language: 'graphql',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature,
    updatedAt: Date.now(),
  };
  if (docstring) record.docstring = docstring;
  st.nodes.push(record);
  st.edges.push({ source: parentNodeId, target: id, kind: 'contains' });
  return id;
}

/**
 * Push the `extends` reference linking an extension node to the
 * base type it augments. Resolution happens cross-file via the
 * existing ReferenceResolver pass — the extender file may not
 * import the definer, and tree-sitter-graphql doesn't have an
 * import construct anyway, so the resolver name-matches by global
 * name within the indexed graph.
 *
 * Known same-file edge case: if a base definition and its
 * extension live in the same file, `findBestMatch`'s line-
 * proximity score may pick the extension's own node (distance 0)
 * over the base definition (distance > 0), producing a self-
 * referential `extends` edge. Federation patterns put base and
 * extension in different files, which is the case this targets;
 * a future resolver-pass filter on `fromNodeId === targetNodeId`
 * would close the loop for the rare same-file case.
 */
interface GqlPushExtendsRefArgs {
  st: GqlState;
  extensionId: string;
  baseTypeName: string;
  node: SyntaxNode;
}

function gqlPushExtendsRef(args: GqlPushExtendsRefArgs): void {
  const { st, extensionId, baseTypeName, node } = args;
  st.unresolvedReferences.push({
    fromNodeId: extensionId,
    referenceName: baseTypeName,
    referenceKind: 'extends',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Walk a fields_definition / input_fields_definition block and emit a
 * `field` node for each child field_definition / input_value_definition,
 * plus a `type_of` reference from the field to its declared type.
 */
interface GqlEmitFieldsOfArgs {
  st: GqlState;
  parent: SyntaxNode;
  blockType: string;
  ownerId: string;
}

function gqlEmitFieldsOf(args: GqlEmitFieldsOfArgs): void {
  const { st, parent, blockType, ownerId } = args;
  const block = findChildByType(parent, blockType);
  if (!block) return;
  for (const fd of block.namedChildren) {
    if (!fd) continue;
    if (fd.type !== 'field_definition' && fd.type !== 'input_value_definition') continue;
    gqlEmitOneField(st, fd, ownerId);
  }
}

/** Emit one GraphQL field/input-value: signature, node, and type_of unresolved-ref. */
function gqlEmitOneField(st: GqlState, fd: SyntaxNode, ownerId: string): void {
  const fieldName = gqlReadNamedChildText(st, fd, 'name');
  if (!fieldName) return;

  const typeNode = findChildByType(fd, 'type');
  const signature = buildFieldSignature(fieldName, typeNode, st.source);

  const fieldId = gqlCreateNode(st, { kind: 'field', name: fieldName, node: fd, parentNodeId: ownerId, signature });
  if (!fieldId) return;
  if (!typeNode) return;

  const baseName = unwrapTypeName(typeNode, st.source);
  if (!baseName) return;
  if (GRAPHQL_BUILTIN_TYPES.has(baseName)) return;
  st.unresolvedReferences.push({
    fromNodeId: fieldId,
    referenceName: baseName,
    referenceKind: 'type_of',
    line: typeNode.startPosition.row + 1,
    column: typeNode.startPosition.column,
  });
}

function gqlEmitObject(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const description = gqlReadDescription(st, node);
  const id = gqlCreateNode(st, {
    kind: 'class',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `type ${name}`,
    docstring: description,
  });
  if (!id) return;

  const impls = findChildByType(node, 'implements_interfaces');
  if (impls) {
    for (const ifaceName of collectNamedTypes(impls, st.source)) {
      st.unresolvedReferences.push({
        fromNodeId: id,
        referenceName: ifaceName,
        referenceKind: 'implements',
        line: impls.startPosition.row + 1,
        column: impls.startPosition.column,
      });
    }
  }

  gqlEmitFieldsOf({ st, parent: node, blockType: 'fields_definition', ownerId: id });
}

interface EmitTypeWithFieldsArgs {
  st: GqlState;
  node: SyntaxNode;
  fileNodeId: string;
  kind: 'class' | 'interface';
  /** Signature prefix — `type` / `interface` / `input` / their `extend …` siblings. */
  signaturePrefix: string;
  blockType: 'fields_definition' | 'input_fields_definition';
  /** `true` for `extend …` forms: skips the description (extensions don't carry one) and emits an `extends`-style ref. */
  isExtension: boolean;
}

/**
 * Shared emitter for the four GraphQL declarations that follow the
 * "read name + create node + emit fields" template:
 * `interface T`, `input T`, `extend interface T`, `extend input T`.
 * The discriminating bits (kind tag, signature prefix, fields block
 * type, whether to push an `extends` ref) are passed in via `args`.
 * Returns the created node id, or `null` when the declaration was
 * unnameable / unindexable.
 */
function gqlEmitTypeWithFields(args: EmitTypeWithFieldsArgs): string | null {
  const { st, node, fileNodeId, kind, signaturePrefix, blockType, isExtension } = args;
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return null;
  const description = isExtension ? undefined : gqlReadDescription(st, node);
  const id = gqlCreateNode(st, {
    kind,
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `${signaturePrefix} ${name}`,
    ...(description !== undefined ? { docstring: description } : {}),
  });
  if (!id) return null;
  if (isExtension) gqlPushExtendsRef({ st, extensionId: id, baseTypeName: name, node });
  gqlEmitFieldsOf({ st, parent: node, blockType, ownerId: id });
  return id;
}

function gqlEmitInterface(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  gqlEmitTypeWithFields({
    st,
    node,
    fileNodeId,
    kind: 'interface',
    signaturePrefix: 'interface',
    blockType: 'fields_definition',
    isExtension: false,
  });
}

function gqlEmitInputObject(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  gqlEmitTypeWithFields({
    st,
    node,
    fileNodeId,
    kind: 'class',
    signaturePrefix: 'input',
    blockType: 'input_fields_definition',
    isExtension: false,
  });
}

function gqlEmitEnum(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const description = gqlReadDescription(st, node);
  const enumId = gqlCreateNode(st, {
    kind: 'enum',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `enum ${name}`,
    docstring: description,
  });
  if (!enumId) return;

  const valuesBlock = findChildByType(node, 'enum_values_definition');
  if (!valuesBlock) return;
  for (const ev of valuesBlock.namedChildren) {
    if (ev?.type !== 'enum_value_definition') continue;
    const evNameNode = findChildByType(ev, 'enum_value');
    const evName = evNameNode ? getNodeText(evNameNode, st.source).trim() : '';
    if (!evName) continue;
    gqlCreateNode(st, {
      kind: 'enum_member',
      name: evName,
      node: ev,
      parentNodeId: enumId,
      signature: `${name}.${evName}`,
    });
  }
}

function gqlEmitUnion(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const id = gqlCreateNode(st, {
    kind: 'type_alias',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `union ${name}`,
  });
  if (!id) return;

  // union_member_types is left-recursive in this grammar: each level wraps
  // one more member. Flatten by walking the whole subtree for `named_type`.
  const members = findChildByType(node, 'union_member_types');
  if (!members) return;
  for (const memberName of collectNamedTypes(members, st.source)) {
    st.unresolvedReferences.push({
      fromNodeId: id,
      referenceName: memberName,
      referenceKind: 'references',
      line: members.startPosition.row + 1,
      column: members.startPosition.column,
    });
  }
}

function gqlEmitScalar(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  gqlCreateNode(st, { kind: 'type_alias', name, node, parentNodeId: fileNodeId, signature: `scalar ${name}` });
}

function gqlEmitDirective(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const args = findChildByType(node, 'arguments_definition');
  const argsText = args ? getNodeText(args, st.source) : '';
  gqlCreateNode(st, {
    kind: 'function',
    name: `@${name}`,
    node,
    parentNodeId: fileNodeId,
    signature: `directive @${name}${argsText}`,
  });
}

function gqlEmitObjectExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const id = gqlCreateNode(st, {
    kind: 'class',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `extend type ${name}`,
  });
  if (!id) return;
  gqlPushExtendsRef({ st, extensionId: id, baseTypeName: name, node });

  const impls = findChildByType(node, 'implements_interfaces');
  if (impls) {
    for (const ifaceName of collectNamedTypes(impls, st.source)) {
      st.unresolvedReferences.push({
        fromNodeId: id,
        referenceName: ifaceName,
        referenceKind: 'implements',
        line: impls.startPosition.row + 1,
        column: impls.startPosition.column,
      });
    }
  }

  gqlEmitFieldsOf({ st, parent: node, blockType: 'fields_definition', ownerId: id });
}

function gqlEmitInterfaceExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  gqlEmitTypeWithFields({
    st,
    node,
    fileNodeId,
    kind: 'interface',
    signaturePrefix: 'extend interface',
    blockType: 'fields_definition',
    isExtension: true,
  });
}

function gqlEmitInputObjectExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  gqlEmitTypeWithFields({
    st,
    node,
    fileNodeId,
    kind: 'class',
    signaturePrefix: 'extend input',
    blockType: 'input_fields_definition',
    isExtension: true,
  });
}

function gqlEmitEnumExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const id = gqlCreateNode(st, {
    kind: 'enum',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `extend enum ${name}`,
  });
  if (!id) return;
  gqlPushExtendsRef({ st, extensionId: id, baseTypeName: name, node });

  const valuesBlock = findChildByType(node, 'enum_values_definition');
  if (!valuesBlock) return;
  for (const ev of valuesBlock.namedChildren) {
    if (ev?.type !== 'enum_value_definition') continue;
    const evNameNode = findChildByType(ev, 'enum_value');
    const evName = evNameNode ? getNodeText(evNameNode, st.source).trim() : '';
    if (!evName) continue;
    gqlCreateNode(st, {
      kind: 'enum_member',
      name: evName,
      node: ev,
      parentNodeId: id,
      signature: `${name}.${evName}`,
    });
  }
}

function gqlEmitUnionExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const id = gqlCreateNode(st, {
    kind: 'type_alias',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `extend union ${name}`,
  });
  if (!id) return;
  gqlPushExtendsRef({ st, extensionId: id, baseTypeName: name, node });

  const members = findChildByType(node, 'union_member_types');
  if (!members) return;
  for (const memberName of collectNamedTypes(members, st.source)) {
    st.unresolvedReferences.push({
      fromNodeId: id,
      referenceName: memberName,
      referenceKind: 'references',
      line: members.startPosition.row + 1,
      column: members.startPosition.column,
    });
  }
}

/**
 * Defensive scaffolding for `extend scalar X` — tree-sitter-graphql
 * 0.1.0 doesn't recognise this construct (parses as ERROR), so this
 * branch is unreachable today. Kept so a grammar bump that adds
 * `scalar_type_extension` lights the path up automatically.
 */
function gqlEmitScalarExtension(st: GqlState, node: SyntaxNode, fileNodeId: string): void {
  const name = gqlReadNamedChildText(st, node, 'name');
  if (!name) return;
  const id = gqlCreateNode(st, {
    kind: 'type_alias',
    name,
    node,
    parentNodeId: fileNodeId,
    signature: `extend scalar ${name}`,
  });
  if (!id) return;
  gqlPushExtendsRef({ st, extensionId: id, baseTypeName: name, node });
}

// ---------------------------------------------------------------------------
// Dispatch tables (module-scope, no class members consumed)
// ---------------------------------------------------------------------------

/** Map of `type_definition` AST child kinds to the corresponding emit function. */
const TYPE_DEFINITION_EMITTERS: Record<string, (st: GqlState, specific: SyntaxNode, fileNodeId: string) => void> = {
  object_type_definition: gqlEmitObject,
  interface_type_definition: gqlEmitInterface,
  input_object_type_definition: gqlEmitInputObject,
  enum_type_definition: gqlEmitEnum,
  union_type_definition: gqlEmitUnion,
  scalar_type_definition: gqlEmitScalar,
};

/**
 * Dispatch table for type_system_extension: maps the tree-sitter
 * `*_type_extension` node-type to the matching emit function.
 */
const TYPE_EXTENSION_HANDLERS: Record<string, (st: GqlState, n: SyntaxNode, f: string) => void> = {
  object_type_extension: gqlEmitObjectExtension,
  interface_type_extension: gqlEmitInterfaceExtension,
  input_object_type_extension: gqlEmitInputObjectExtension,
  enum_type_extension: gqlEmitEnumExtension,
  union_type_extension: gqlEmitUnionExtension,
  scalar_type_extension: gqlEmitScalarExtension,
};

// ---------------------------------------------------------------------------
// Class — thin orchestrator (fields + extract flow only)
// ---------------------------------------------------------------------------

export class GraphqlExtractor extends StandaloneExtractor {
  extract(): ExtractionResult {
    const startTime = Date.now();
    const parser = getParser('graphql');
    if (!parser) {
      this.errors.push({ message: 'GraphQL grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }

    let tree: Tree | null;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `GraphQL parse error: ${errMsg(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'GraphQL parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode('graphql').id;
      const document = tree.rootNode.namedChildren.find((c: SyntaxNode | null) => c?.type === 'document');
      if (!document) return this.result(startTime);

      for (const def of document.namedChildren) {
        if (def?.type !== 'definition') continue;
        this.tryVisitDefinition(def, fileNodeId);
      }
      return this.result(startTime);
    } finally {
      // Free WASM heap memory — web-tree-sitter trees hold native heap
      // memory invisible to V8's GC.
      tree.delete();
    }
  }

  /** Per-definition try/catch wrapper. Delegated to {@link StandaloneExtractor.tryVisit}. */
  private tryVisitDefinition(def: SyntaxNode, fileNodeId: string): void {
    this.tryVisit(def, () => this.visitDefinition(def, fileNodeId), 'GraphQL definition extraction error: ');
  }

  /**
   * `definition` wraps either `type_system_definition` (which itself wraps
   * the specific definition kind), `type_system_extension` (federation-style
   * `extend type X { … }`), or `executable_definition` (operations /
   * fragments — out of scope; we extract schema, not queries).
   * Extensions emit a separate node carrying the new fields, with an
   * `extends` edge to the base type so cross-file merging is reconstructible.
   */
  private visitDefinition(def: SyntaxNode, fileNodeId: string): void {
    const st = this.state();
    const tsDef = def.namedChild(0);
    if (tsDef?.type === 'type_system_extension') {
      this.visitTypeSystemExtension(tsDef, fileNodeId);
      return;
    }
    if (tsDef?.type !== 'type_system_definition') return;
    const inner = tsDef.namedChild(0);
    if (!inner) return;

    if (inner.type === 'directive_definition') {
      gqlEmitDirective(st, inner, fileNodeId);
      return;
    }
    // Schema config is just `query: Query` etc. — no useful symbol.
    if (inner.type === 'schema_definition') return;
    if (inner.type !== 'type_definition') return;

    const specific = inner.namedChild(0);
    if (!specific) return;
    const emitter = TYPE_DEFINITION_EMITTERS[specific.type];
    if (emitter) emitter(st, specific, fileNodeId);
  }

  /**
   * Federation-style `extend type X { … }` (B #27). Emits a separate
   * node for the extension with the same kind as the base; cross-file
   * merging is reconstructible via the `extends` edge resolver pass.
   */
  private visitTypeSystemExtension(tsExt: SyntaxNode, fileNodeId: string): void {
    const typeExt = tsExt.namedChild(0);
    if (typeExt?.type !== 'type_extension') return;
    const specific = typeExt.namedChild(0);
    if (!specific) return;

    const handler = TYPE_EXTENSION_HANDLERS[specific.type];
    if (handler) handler(this.state(), specific, fileNodeId);
  }

  /**
   * Expose mutable state to module-scope free functions. The
   * extractor class structurally satisfies {@link GqlState} (all
   * field names + shapes line up), so a single `this`-as-state
   * cast avoids the per-field `this.x` reads that the
   * `field_access` extractor used to read as cross-class accesses
   * — those tripped a false-positive `feature_envy` finding on
   * inherited fields the detector counted as foreign because the
   * SQL doesn't walk `extends` edges.
   */
  private state(): GqlState {
    return this as unknown as GqlState;
  }
}
