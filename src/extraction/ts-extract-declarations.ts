/**
 * Universal hand-extractor — declaration extraction.
 *
 * Carved out of `tree-sitter.ts` (god-module split, 2026-05-17). Holds
 * the `tsExtract{Function,Method,Class,Interface,Struct,Enum,
 * EnumMembers,Property,Field}` family that turns a declaration node
 * into a cartograph `Node`, plus the name-resolution / field / metadata
 * helpers they need.
 *
 * Same free-function convention as the rest of the extraction core:
 * each takes the `TreeSitterExtractor` as its first argument.
 *
 * ⚠ This file feeds `EXTRACTION_LOGIC_VERSION` — see the spec-file set
 * in `extraction-logic-version.ts`. A substantive edit here triggers a
 * one-shot full re-extraction on the next sync.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../types.js';
import { getNodeText, getChildByField, getPrecedingDocstring, subtreeContainsType } from './tree-sitter-helpers.js';
import type { LanguageExtractor } from './tree-sitter-types.js';
import { compact, isJsFamily } from '../utils.js';
import { extractDefUseEdges } from './def-use.js';
import { extractTypeRefsFromSubtree } from './tree-sitter-typerefs.js';
import { extractInheritance } from './tree-sitter-inheritance.js';
import { extractTypeAnnotations } from './tree-sitter-decls.js';
import { type TreeSitterExtractor, tsIsInsideClassLikeNode, resolveNodeBody } from './tree-sitter.js';
import { tsExtractDecoratorsFor, DECORATOR_NODE_TYPES } from './ts-extract-calls.js';
import { visitMisparsedBody, visitChildBody } from './ts-extract-bodies.js';

/** Dart inner-signature kinds whose identifier child is the method name. */
const DART_INNER_SIGNATURE_KINDS = new Set([
  'function_signature',
  'getter_signature',
  'setter_signature',
  'constructor_signature',
  'factory_constructor_signature',
]);
/** Identifier-shaped kinds extractName falls back to scanning for. */
const IDENTIFIER_FALLBACK_KINDS = new Set(['identifier', 'type_identifier', 'simple_identifier', 'constant']);

/**
 * Resolve the name out of a tree-sitter declarator chain. C/C++ wrap
 * declarators in `pointer_declarator` / `function_declarator` /
 * `declarator` nodes; this peels them off so callers see the bare
 * identifier text instead of `*foo` / `(foo)(int)` / etc.
 */
function resolveDeclaratorName(nameNode: SyntaxNode, source: string): string {
  let resolved = nameNode;
  while (resolved.type === 'pointer_declarator') {
    const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
    if (!inner) break;
    resolved = inner;
  }
  if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
    const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
    return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
  }
  return getNodeText(resolved, source);
}

/**
 * Dart method_signature path. The identifier sits inside an inner
 * signature node (function_signature / getter_signature / etc.).
 * Returns null when the inner signature isn't found so the caller
 * can fall through to the generic identifier scan.
 */
function extractDartMethodName(node: SyntaxNode, source: string): string | null {
  for (const child of node.namedChildren) {
    if (!child || !DART_INNER_SIGNATURE_KINDS.has(child.type)) continue;
    for (const inner of child.namedChildren) {
      if (inner?.type === 'identifier') return getNodeText(inner, source);
    }
  }
  return null;
}

/** Generic fallback: first identifier-shaped child of `node`. */
function findFirstIdentifierChild(node: SyntaxNode, source: string): string | null {
  for (const child of node.namedChildren) {
    if (child && IDENTIFIER_FALLBACK_KINDS.has(child.type)) return getNodeText(child, source);
  }
  return null;
}

/**
 * Extract the name from a node based on language. Strategy:
 *   1. Field-name lookup with declarator unwrapping (C/C++ pointer/
 *      function declarators).
 *   2. Dart `method_signature` inner-signature inspection.
 *   3. Anonymous shortcut for arrow/function expressions — without
 *      this, single-expression arrow functions like
 *      `const fn = () => someIdentifier` get named "someIdentifier"
 *      from the fallback scan.
 *   4. First identifier-shaped child as a generic fallback.
 */
export function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  // F#65 — language-specific name resolver. ObjC multi-keyword
  // selectors (`doThing:with:`) can't be reconstructed from a single
  // field lookup; the hook reads all identifier children + the
  // `method_parameter` shape to build the canonical selector.
  const hookName = extractor.resolveName?.(node, source);
  if (hookName) return hookName;

  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) return resolveDeclaratorName(nameNode, source);

  if (node.type === 'method_signature') {
    const dartName = extractDartMethodName(node, source);
    if (dartName) return dartName;
  }

  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  return findFirstIdentifierChild(node, source) ?? '<anonymous>';
}

/**
 * Resolve a function/arrow/function-expression name. For anonymous arrow
 * functions / function expressions assigned to a variable, climb to the
 * parent `variable_declarator` and use its name (so `export const useAuth
 * = () => {…}` is named `useAuth` instead of `<anonymous>`).
 */
function resolveFunctionName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  let name = extractName(node, source, extractor);
  if (name !== '<anonymous>') return name;
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') return name;
  const parent = node.parent;
  if (parent?.type !== 'variable_declarator') return name;
  const varName = getChildByField(parent, 'name');
  if (varName) name = getNodeText(varName, source);
  return name;
}

/**
 * Find variable_declarator children of a class-field-shaped node:
 *   - Java: variable_declarator(s) are direct children of field_declaration.
 *   - C#:   field_declaration wraps a variable_declaration whose children
 *           are the variable_declarator(s).
 */
function findFieldDeclarators(node: SyntaxNode): SyntaxNode[] {
  const direct = node.namedChildren.filter((c) => c.type === 'variable_declarator');
  if (direct.length > 0) return direct;
  const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
  return varDecl ? varDecl.namedChildren.filter((c) => c.type === 'variable_declarator') : [];
}

/** Per-field context bundle threaded through extractField helpers. */
interface FieldExtractCtx {
  docstring: string | undefined;
  visibility: Node['visibility'];
  isStatic: boolean;
}

/** PHP property_declaration modifier kinds — skipped when scanning for the type. */
const PHP_PROP_MODIFIER_KINDS: ReadonlySet<string> = new Set([
  'visibility_modifier',
  'static_modifier',
  'readonly_modifier',
  'property_element',
  'var_modifier',
]);

/** Java/C# field_declaration child kinds NOT considered the field type. */
const FIELD_TYPE_SKIP_KINDS: ReadonlySet<string> = new Set([
  'modifiers',
  'modifier',
  'variable_declarator',
  'variable_declaration',
  'marker_annotation',
  'annotation',
]);

/**
 * For a class-like body child of a struct, emit a `type_of` edge from
 * the struct to the field's annotated type — but only when the field
 * actually carries a `field_identifier` somewhere in its subtree.
 * Anonymous embeddings (no `field_identifier` anywhere — Go-style
 * `type Foo struct { Bar }`) are intentionally skipped; they're
 * handled by `extractInheritance` which emits `extends`.
 *
 * Defensive: silently no-ops when `child` isn't a recognised
 * field-declaration shape so callers can sweep over arbitrary body
 * children without pre-filtering.
 */
function emitTypeOfEdgeForNamedStructField(ext: TreeSitterExtractor, child: SyntaxNode, structNodeId: string): void {
  if (child.type !== 'field_declaration' && child.type !== 'field_definition') return;
  if (!subtreeContainsType(child, 'field_identifier')) return;
  extractTypeRefsFromSubtree({ extractor: ext, node: child, fromNodeId: structNodeId, kind: 'type_of' });
}

/**
 * PHP `property_declaration` shape: `private string $name = ...`
 * parses to property_element children carrying variable_name → name.
 * Returns true when at least one property_element is found and
 * processed (caller short-circuits the declarator paths).
 *
 * Defensive: skips property_elements without a recognisable name
 * sub-tree rather than throwing.
 */
function tryExtractPhpProperties(ext: TreeSitterExtractor, node: SyntaxNode, ctx: FieldExtractCtx): boolean {
  const propElements = node.namedChildren.filter((c) => c.type === 'property_element');
  if (propElements.length === 0) return false;
  const typeNode = node.namedChildren.find((c) => !PHP_PROP_MODIFIER_KINDS.has(c.type));
  const typeText = typeNode ? getNodeText(typeNode, ext.source) : undefined;
  for (const elem of propElements) {
    const varName = elem.namedChildren.find((c) => c.type === 'variable_name');
    const nameNode = varName?.namedChildren.find((c) => c.type === 'name');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, ext.source);
    const dollarName = `$${name}`;
    const typedSig = `${typeText} ${dollarName}`;
    const signature = typeText ? typedSig : dollarName;
    ext.createNode({
      kind: 'field',
      name,
      node: elem,
      extra: compact({
        docstring: ctx.docstring,
        signature,
        visibility: ctx.visibility,
        isStatic: ctx.isStatic,
      }),
    });
  }
  return true;
}

/**
 * Emit one `field` node per Java/C# `variable_declarator`. The TYPE
 * is on the outer `field_declaration` (Java) or inside a
 * `variable_declaration` wrapper (C#); first non-modifier /
 * non-declarator / non-annotation named child wins. Decorators on
 * the outer declaration are attributed to every declarator.
 */
function extractFieldsFromDeclarators(ext: TreeSitterExtractor, fieldCtx: FieldExtractCtx, node: SyntaxNode): void {
  const declarators = findFieldDeclarators(node);
  const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
  const typeSearchNode = varDecl ?? node;
  const typeNode = typeSearchNode.namedChildren.find((c) => !FIELD_TYPE_SKIP_KINDS.has(c.type));
  const typeText = typeNode ? getNodeText(typeNode, ext.source) : undefined;
  for (const decl of declarators) {
    const nameNode = getChildByField(decl, 'name') || decl.namedChildren.find((c) => c.type === 'identifier');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, ext.source);
    const typedSig = `${typeText} ${name}`;
    const signature = typeText ? typedSig : name;
    const fieldNode = ext.createNode({
      kind: 'field',
      name,
      node: decl,
      extra: compact({
        docstring: fieldCtx.docstring,
        signature,
        visibility: fieldCtx.visibility,
        isStatic: fieldCtx.isStatic,
      }),
    });
    // Java/Kotlin annotations / TS field decorators sit on the
    // outer field_declaration, not on the individual declarator.
    if (fieldNode) tsExtractDecoratorsFor(ext, node, fieldNode.id);
  }
}

/**
 * Last-resort field extractor: pick a single identifier child as the
 * name. Used when neither `variable_declarator` (Java/C#) nor
 * `property_element` (PHP) shapes are present, e.g. some Kotlin /
 * Dart field grammars carry the name directly on the declaration,
 * and the TS class data-field path (public_field_definition without
 * a function-typed value) routed here from tsExtractMethod's split.
 *
 * Calls extractTypeAnnotations on the newly-created node so a TS
 * `field: Foo` declaration emits the `type_of -> Foo` edge that the
 * method-path used to produce. extractTypeAnnotations is a no-op
 * for languages whose field grammars don't carry a `type_annotation`
 * child (Java fields use variable_declarator and go through the
 * declarators path, not this fallback), so the broadening is safe.
 */
function extractFieldFallbackByName(ext: TreeSitterExtractor, node: SyntaxNode, ctx: FieldExtractCtx): void {
  const nameNode =
    getChildByField(node, 'name') ||
    node.namedChildren.find((c) => c.type === 'identifier') ||
    node.namedChildren.find((c) => c.type === 'property_identifier');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ext.source);
  const fieldNode = ext.createNode({
    kind: 'field',
    name,
    node,
    extra: compact({
      docstring: ctx.docstring,
      visibility: ctx.visibility,
      isStatic: ctx.isStatic,
    }),
  });
  if (fieldNode) extractTypeAnnotations(ext, node, fieldNode.id);
}

/** Common metadata bag for function/method extraction. */
function collectFunctionMetadata(
  ext: TreeSitterExtractor,
  node: SyntaxNode,
  opts: { isExported?: boolean },
): Partial<Node> {
  if (!ext.extractor) return {};
  return compact({
    docstring: getPrecedingDocstring(node, ext.source),
    signature: ext.extractor.getSignature?.(node, ext.source),
    visibility: ext.extractor.getVisibility?.(node),
    isExported: opts.isExported ? ext.extractor.isExported?.(node, ext.source) : undefined,
    isAsync: ext.extractor.isAsync?.(node),
    isStatic: ext.extractor.isStatic?.(node),
  });
}

/**
 * Methods with a receiver type but no class-like parent on the stack
 * (e.g., Rust impl blocks) need a `contains` edge from the owning
 * struct/trait so the graph reflects ownership.
 */
function linkReceiverOwnership(ext: TreeSitterExtractor, receiverType: string, methodId: string): void {
  if (tsIsInsideClassLikeNode(ext)) return;
  const ownerNode = ext.nodes.find(
    (n) =>
      n.name === receiverType &&
      n.filePath === ext.filePath &&
      (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait'),
  );
  if (ownerNode) {
    ext.edges.push({ source: ownerNode.id, target: methodId, kind: 'contains' });
  }
}

/**
 * Visit the named children of a class body, emitting `type_of` edges
 * for C/C++-style field declarations (which don't reach a dedicated
 * field extractor) and recursing into each child via `visitNode`.
 */
function visitClassBodyChildren(ext: TreeSitterExtractor, body: SyntaxNode, classId: string): void {
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (
      (child.type === 'field_declaration' || child.type === 'field_definition') &&
      subtreeContainsType(child, 'field_identifier')
    ) {
      extractTypeRefsFromSubtree({ extractor: ext, node: child, fromNodeId: classId, kind: 'type_of' });
    }
    ext.visitNode(child);
  }
}

/**
 * Extract a function.
 * Exported so tree-sitter-decls.ts (extractTsJsVariables) can call it directly
 * on the extractor instance without keeping it as a class method.
 */
/** Tree-sitter node types that mark a JSX-returning body — used to
 *  classify a PascalCase JS/TS function as a `component` rather than a
 *  plain `function` (covers arrow components reaching this path; the
 *  `function_declaration` form is classified by the language extractor's
 *  own `visitNode` hook). */
const JSX_RETURN_NODE_TYPES = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'] as const;

export function tsExtractFunction(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;

  // If the language provides getReceiverType and this function has a receiver
  // (e.g., Rust function_item inside an impl block), extract as method instead
  if (ext.extractor.getReceiverType?.(node, ext.source)) {
    tsExtractMethod(ext, node);
    return;
  }

  const name = resolveFunctionName(node, ext.source, ext.extractor);
  if (name === '<anonymous>') {
    // Don't create a node for an anonymous function (callbacks
    // passed inline to `it(...)`, `setTimeout(...)`, `.then(...)`,
    // event handlers, etc.) — there's nothing meaningful to name.
    // BUT still walk the body so calls/refs/instantiations inside
    // the callback get attributed to the enclosing scope. Without
    // this, every call inside an `it('...', () => { ... })` test is
    // invisible to the resolver, which is the dominant cause of
    // false-positive `unused_export` findings on test-only utilities.
    visitMisparsedBody(ext, node);
    return;
  }

  // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
  // Skip the node but still visit the body for calls and structural nodes
  if (ext.extractor.isMisparsedFunction?.(name, node)) {
    visitMisparsedBody(ext, node);
    return;
  }

  // A PascalCase JS/TS function whose body returns JSX is a React
  // component, not a plain function. The `function_declaration` form is
  // already classified by the language extractor's `visitNode` hook;
  // this catches the arrow-assigned form (`const Foo = () => <JSX/>`),
  // which dispatches straight here — so the two forms agree and no
  // separate regex pass double-emits a second `component` node.
  const funcBody = resolveNodeBody(ext, node);
  const funcKind: NodeKind =
    funcBody &&
    isJsFamily(ext.language) &&
    /^[A-Z]/.test(name) &&
    JSX_RETURN_NODE_TYPES.some((t) => subtreeContainsType(funcBody, t))
      ? 'component'
      : 'function';

  const funcNode = ext.createNode({
    kind: funcKind,
    name,
    node,
    extra: collectFunctionMetadata(ext, node, { isExported: true }),
  });
  if (!funcNode) return;

  // Extract type annotations (parameter types and return type)
  extractTypeAnnotations(ext, node, funcNode.id);

  // Extract decorators applied to the function
  tsExtractDecoratorsFor(ext, node, funcNode.id);

  visitChildBody(ext, funcNode.id, funcBody);
  if (funcBody && isJsFamily(ext.language)) {
    for (const e of extractDefUseEdges(funcBody, funcNode.id)) ext.edges.push(e);
  }
}

/**
 * TS class-member kind split: `public_field_definition` is shoehorned
 * into methodTypes alongside `method_definition` because its grammar
 * covers both data fields (`total: number = 0`) and arrow-function
 * class fields (`onClick = () => {}`). Only the latter is semantically
 * a method. Returns true when the node was diverted to field-extraction
 * (kind=field), false otherwise. The `resolveBody` helper returns
 * non-null only for the arrow-function shape, so a null body unambiguously
 * means data field.
 */
function tryDivertPublicFieldToField(ext: TreeSitterExtractor, node: SyntaxNode): boolean {
  if (node.type !== 'public_field_definition') return false;
  if (resolveNodeBody(ext, node) !== null) return false;
  tsExtractField(ext, node);
  return true;
}

/**
 * When not inside a class-like node, routes a method_definition to either
 * tsExtractFunction (if the node looks like a top-level function) or skips it
 * (if it's inside an object literal).
 */
function tsRouteNonClassMethod(ext: TreeSitterExtractor, node: SyntaxNode): void {
  const isInsideObjectLiteral = node.parent?.type === 'object' || node.parent?.type === 'object_expression';
  if (isInsideObjectLiteral) return; // skip
  tsExtractFunction(ext, node);
}

/**
 * Emit the method node with its receiver linkage, annotations, and body children.
 */
interface TsEmitMethodNodeArgs {
  ext: TreeSitterExtractor;
  node: SyntaxNode;
  name: string;
  receiverType: string | undefined;
}

function tsEmitMethodNode(args: TsEmitMethodNodeArgs): void {
  const { ext, node, name, receiverType } = args;
  // For languages where methods are independent top-level declarations
  // (today only Go sets methodsAreTopLevel: true — other receiver-typed
  // languages like Rust / Swift / Kotlin / Scala use receiver-type or
  // class-context detection instead), evaluate isExported per-method.
  // For classic OO languages the enclosing class carries the export, not
  // the individual method.
  const methodsTopLevel = ext.extractor?.methodsAreTopLevel === true;
  const extraProps: Partial<Node> = collectFunctionMetadata(ext, node, { isExported: methodsTopLevel });
  if (receiverType) {
    extraProps.qualifiedName = `${receiverType}::${name}`;
  }
  const methodNode = ext.createNode({ kind: 'method', name, node, extra: extraProps });
  if (!methodNode) return;

  if (receiverType) {
    linkReceiverOwnership(ext, receiverType, methodNode.id);
  }
  extractTypeAnnotations(ext, node, methodNode.id);
  tsExtractDecoratorsFor(ext, node, methodNode.id);
  // F#64b v3 / v3.1 (2026-05-27) — for Java/Kotlin methods, emit a
  // parameter node for any formal_parameter (Java) or parameter
  // (Kotlin) that carries an annotation (@Param, @PathVariable,
  // @RequestBody, etc.). Gated on "has at least one annotation" so
  // plain `int x` params don't bloat the graph. Lets the
  // mybatis-binding flow bind `#{name}` SQL placeholders to the
  // matching JVM parameter via the standard resolver's
  // qualifiedName-match path.
  tsEmitAnnotatedParameters(ext, methodNode, node);
  const methodBody = resolveNodeBody(ext, node);
  visitChildBody(ext, methodNode.id, methodBody);
  if (methodBody && isJsFamily(ext.language)) {
    for (const e of extractDefUseEdges(methodBody, methodNode.id)) ext.edges.push(e);
  }
}

/**
 * F#64b v3 / v3.1 — Walk a method's parameter list and emit one
 * `kind:'parameter'` node per parameter that carries at least one
 * annotation. The "has annotation" gate keeps the graph footprint
 * small (a typical JVM project has thousands of methods × ~3 params
 * each, but very few of them carry framework-binding annotations
 * like `@Param`/`@PathVariable`/`@RequestBody`).
 *
 * v3 (2026-05-27) shipped Java. v3.1 (same day) added Kotlin.
 * Other languages: no-op early-return.
 *
 * AST shapes diverge per language:
 *
 *   - **Java** (`method_declaration > formal_parameters >
 *     formal_parameter > [modifiers (with annotation), type,
 *     identifier]`) — annotation lives INSIDE the formal_parameter.
 *     Walk via `formal_parameter`-typed children and call
 *     `tsExtractDecoratorsFor` on each.
 *
 *   - **Kotlin** (`function_declaration > function_value_parameters >
 *     [parameter_modifiers (with annotation), parameter (with
 *     simple_identifier)]`) — annotation lives in a SIBLING
 *     `parameter_modifiers` node directly preceding the `parameter`.
 *     Walk via a state machine that remembers the last
 *     `parameter_modifiers` seen and pairs it with the next
 *     `parameter`. Pass the `parameter_modifiers` node itself as
 *     `declNode` to `tsExtractDecoratorsFor` — the function iterates
 *     its named children (the `annotation` nodes) and attributes
 *     them to the param's `decoratedId`.
 *
 * `qualifiedName` follows the JVM `<Class>::<method>::<param>` chain
 * so the standard resolver's qualifiedName-match path binds
 * `<XmlStatement>::<#{name}>` refs from MyBatis XML to the matching
 * parameter node automatically.
 */
function tsEmitAnnotatedParameters(ext: TreeSitterExtractor, methodNode: Node, methodSyntaxNode: SyntaxNode): void {
  if (ext.language === 'java') {
    emitJavaAnnotatedParameters(ext, methodNode, methodSyntaxNode);
    return;
  }
  if (ext.language === 'kotlin') {
    emitKotlinAnnotatedParameters(ext, methodNode, methodSyntaxNode);
    return;
  }
}

function emitJavaAnnotatedParameters(ext: TreeSitterExtractor, methodNode: Node, methodSyntaxNode: SyntaxNode): void {
  const paramsNode = methodSyntaxNode.namedChildren.find((c) => c?.type === 'formal_parameters');
  if (!paramsNode) return;
  for (const fp of paramsNode.namedChildren) {
    if (fp?.type !== 'formal_parameter') continue;
    // Cheap pre-gate: skip when no annotation is present anywhere in
    // the formal_parameter's modifiers. Avoids creating throwaway
    // parameter nodes for the bulk of un-annotated Java params.
    const modifiers = fp.namedChildren.find((c) => c?.type === 'modifiers');
    if (!modifiers) continue;
    const hasAnnotation = modifiers.namedChildren.some((m) => m && DECORATOR_NODE_TYPES.has(m.type));
    if (!hasAnnotation) continue;
    // Java formal_parameter shape: `modifiers? type identifier`. The
    // param name is the identifier child.
    const ident = fp.namedChildren.find((c) => c?.type === 'identifier');
    if (!ident) continue;
    const paramName = ext.source.substring(ident.startIndex, ident.endIndex);
    if (!paramName) continue;
    const paramNode = ext.createNode({
      kind: 'parameter',
      name: paramName,
      node: fp,
      extra: { qualifiedName: `${methodNode.qualifiedName}::${paramName}` },
    });
    if (!paramNode) continue;
    ext.edges.push({ source: methodNode.id, target: paramNode.id, kind: 'contains' });
    // Reuse the universal decorator walker on the formal_parameter
    // node — `modifiers` is a recognised DECORATOR_WRAPPER_TYPE so
    // every annotation child gets its name + args captured.
    tsExtractDecoratorsFor(ext, fp, paramNode.id);
  }
}

function emitKotlinAnnotatedParameters(ext: TreeSitterExtractor, methodNode: Node, methodSyntaxNode: SyntaxNode): void {
  const paramsNode = methodSyntaxNode.namedChildren.find((c) => c?.type === 'function_value_parameters');
  if (!paramsNode) return;
  // Kotlin pairs annotations with parameters as adjacent siblings:
  // [parameter_modifiers, parameter, parameter_modifiers, parameter, ...]
  // or interleaved with unannotated params:
  // [parameter, parameter_modifiers, parameter, parameter, ...].
  // Track the last parameter_modifiers seen and pair it with the
  // very next parameter; reset whenever a parameter is consumed
  // (whether or not it was annotated).
  let pendingModifiers: SyntaxNode | null = null;
  for (const child of paramsNode.namedChildren) {
    if (!child) continue;
    if (child.type === 'parameter_modifiers') {
      pendingModifiers = child;
      continue;
    }
    if (child.type !== 'parameter') {
      // Some other node-kind interleaved — defensive reset to avoid
      // accidentally pairing modifiers with a non-adjacent parameter.
      pendingModifiers = null;
      continue;
    }
    if (!pendingModifiers) continue; // un-annotated param — skip
    const hasAnnotation = pendingModifiers.namedChildren.some((m) => m && DECORATOR_NODE_TYPES.has(m.type));
    if (!hasAnnotation) {
      pendingModifiers = null;
      continue;
    }
    // Kotlin parameter shape: `simple_identifier ':' user_type`.
    const ident = child.namedChildren.find((c) => c?.type === 'simple_identifier');
    if (!ident) {
      pendingModifiers = null;
      continue;
    }
    const paramName = ext.source.substring(ident.startIndex, ident.endIndex);
    if (!paramName) {
      pendingModifiers = null;
      continue;
    }
    const paramNode = ext.createNode({
      kind: 'parameter',
      name: paramName,
      node: child,
      extra: { qualifiedName: `${methodNode.qualifiedName}::${paramName}` },
    });
    if (paramNode) {
      ext.edges.push({ source: methodNode.id, target: paramNode.id, kind: 'contains' });
      // Pass the parameter_modifiers node itself — its named children
      // are annotation nodes, which `tsExtractDecoratorsFor`'s outer
      // loop will recognise via `recordDecoratorIfPresent`.
      tsExtractDecoratorsFor(ext, pendingModifiers, paramNode.id);
    }
    pendingModifiers = null;
  }
}

/**
 * Extract a method node.
 */
export function tsExtractMethod(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;
  if (tryDivertPublicFieldToField(ext, node)) return;

  // For languages with receiver types (Go, Rust), include receiver in qualified name
  const receiverType = ext.extractor.getReceiverType?.(node, ext.source);

  // For most languages, only extract as method if inside a class-like node
  const needsClassContext = !tsIsInsideClassLikeNode(ext) && !ext.extractor.methodsAreTopLevel && !receiverType;
  if (needsClassContext) {
    tsRouteNonClassMethod(ext, node);
    return;
  }

  const name = extractName(node, ext.source, ext.extractor);

  // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
  if (ext.extractor.isMisparsedFunction?.(name, node)) {
    visitMisparsedBody(ext, node);
    return;
  }

  tsEmitMethodNode({ ext, node, name, receiverType });
}

/**
 * Extract a class node.
 */
export function tsExtractClass(ext: TreeSitterExtractor, node: SyntaxNode, kind: NodeKind = 'class'): void {
  if (!ext.extractor) return;

  const name = extractName(node, ext.source, ext.extractor);
  const docstring = getPrecedingDocstring(node, ext.source);
  const visibility = ext.extractor.getVisibility?.(node);
  const isExported = ext.extractor.isExported?.(node, ext.source);

  const classNode = ext.createNode({ kind, name, node, extra: compact({ docstring, visibility, isExported }) });
  if (!classNode) return;

  extractInheritance(ext, node, classNode.id);
  tsExtractDecoratorsFor(ext, node, classNode.id);

  ext.nodeStack.push(classNode.id);
  const body = resolveNodeBody(ext, node) ?? node;

  // For Python: class-body annotations like `class Baz: field: Foo`
  if (ext.language === 'python') {
    tsExtractPythonClassBodyAnnotations(ext, body, classNode.id);
  }

  visitClassBodyChildren(ext, body, classNode.id);
  ext.nodeStack.pop();
}

/**
 * Walk a Python class body for annotated class attributes and emit `type_of` edges.
 */
function tsExtractPythonClassBodyAnnotations(ext: TreeSitterExtractor, body: SyntaxNode, classId: string): void {
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'assignment') {
      const typeChild = getChildByField(n, 'type');
      if (typeChild)
        extractTypeRefsFromSubtree({ extractor: ext, node: typeChild, fromNodeId: classId, kind: 'type_of' });
    }
    // Don't descend into nested function/class definitions
    if (n.type === 'function_definition' || n.type === 'class_definition') return;
    for (const child of n.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(body);
}

/**
 * Extract an interface/protocol/trait node.
 */
export function tsExtractInterface(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;

  const name = extractName(node, ext.source, ext.extractor);
  const docstring = getPrecedingDocstring(node, ext.source);
  const isExported = ext.extractor.isExported?.(node, ext.source);
  const kind: NodeKind = ext.extractor.interfaceKind ?? 'interface';

  const interfaceNode = ext.createNode({ kind, name, node, extra: compact({ docstring, isExported }) });
  if (!interfaceNode) return;

  extractInheritance(ext, node, interfaceNode.id);

  ext.nodeStack.push(interfaceNode.id);
  let body =
    ext.extractor.resolveBody?.(node, ext.extractor.bodyField) ?? getChildByField(node, ext.extractor.bodyField);
  if (!body) body = node;
  for (const child of body.namedChildren) {
    if (child) ext.visitNode(child);
  }
  ext.nodeStack.pop();
}

/**
 * Extract a struct node.
 */
export function tsExtractStruct(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;

  // Skip forward declarations and type references (no body = not a definition)
  const body = getChildByField(node, ext.extractor.bodyField);
  if (!body) return;

  const name = extractName(node, ext.source, ext.extractor);
  const docstring = getPrecedingDocstring(node, ext.source);
  const visibility = ext.extractor.getVisibility?.(node);
  const isExported = ext.extractor.isExported?.(node, ext.source);

  const structNode = ext.createNode({
    kind: 'struct',
    name,
    node,
    extra: compact({ docstring, visibility, isExported }),
  });
  if (!structNode) return;

  extractInheritance(ext, node, structNode.id);

  ext.nodeStack.push(structNode.id);
  for (const child of body.namedChildren) {
    if (!child) continue;
    emitTypeOfEdgeForNamedStructField(ext, child, structNode.id);
    ext.visitNode(child);
  }
  ext.nodeStack.pop();
}

/**
 * Extract an enum node.
 */
export function tsExtractEnum(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;

  // Skip forward declarations (no body = not a definition)
  const body =
    ext.extractor.resolveBody?.(node, ext.extractor.bodyField) ?? getChildByField(node, ext.extractor.bodyField);
  if (!body) return;

  const name = extractName(node, ext.source, ext.extractor);
  const docstring = getPrecedingDocstring(node, ext.source);
  const visibility = ext.extractor.getVisibility?.(node);
  const isExported = ext.extractor.isExported?.(node, ext.source);

  const enumNode = ext.createNode({ kind: 'enum', name, node, extra: compact({ docstring, visibility, isExported }) });
  if (!enumNode) return;

  extractInheritance(ext, node, enumNode.id);

  ext.nodeStack.push(enumNode.id);
  const memberTypes = ext.extractor.enumMemberTypes;
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (memberTypes?.includes(child.type)) {
      tsExtractEnumMembers(ext, child);
    } else {
      ext.visitNode(child);
    }
  }
  ext.nodeStack.pop();
}

/**
 * Extract enum member names from an enum member node.
 * Exported so tree-sitter-decls.ts (processEnumTypeAliasInner) can call it directly.
 */
export function tsExtractEnumMembers(ext: TreeSitterExtractor, node: SyntaxNode): void {
  // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
  const nameNode = getChildByField(node, 'name');
  if (nameNode) {
    ext.createNode({ kind: 'enum_member', name: getNodeText(nameNode, ext.source), node });
    return;
  }

  // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
  let found = false;
  for (const child of node.namedChildren) {
    if (
      child &&
      (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')
    ) {
      ext.createNode({ kind: 'enum_member', name: getNodeText(child, ext.source), node: child });
      found = true;
    }
  }

  // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
  if (!found && node.namedChildCount === 0) {
    ext.createNode({ kind: 'enum_member', name: getNodeText(node, ext.source), node });
  }
}

/**
 * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
 */
export function tsExtractProperty(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;

  const docstring = getPrecedingDocstring(node, ext.source);
  const visibility = ext.extractor.getVisibility?.(node);
  const isStatic = ext.extractor.isStatic?.(node) ?? false;

  // F#65 — language-specific property name resolver. ObjC `@property`
  // wraps its name inside a struct_declarator chain that the generic
  // field/identifier walk doesn't follow; the hook reads it correctly.
  const hookName = ext.extractor.extractPropertyName?.(node, ext.source);
  const nameNode = hookName
    ? null
    : (getChildByField(node, 'name') ?? node.namedChildren.find((c) => c.type === 'identifier'));
  const name = hookName ?? (nameNode ? getNodeText(nameNode, ext.source) : null);
  if (!name) return;

  const typeNode = node.namedChildren.find(
    (c) =>
      c.type !== 'modifier' &&
      c.type !== 'modifiers' &&
      c.type !== 'identifier' &&
      c.type !== 'accessor_list' &&
      c.type !== 'accessors' &&
      c.type !== 'equals_value_clause',
  );
  const typeText = typeNode ? getNodeText(typeNode, ext.source) : undefined;
  const typedName = `${typeText} ${name}`;
  const signature = typeText ? typedName : name;

  const propNode = ext.createNode({
    kind: 'property',
    name,
    node,
    extra: compact({ docstring, signature, visibility, isStatic }),
  });
  if (propNode) tsExtractDecoratorsFor(ext, node, propNode.id);
}

/**
 * Go `field_declaration` shape: one or more `field_identifier` children
 * (multi-name fields like `X, Y int`), followed by the type. Anonymous
 * embeddings (no field_identifier — e.g. `*sync.Mutex`) are handled by
 * extractInheritance's extends-edge path, NOT here.
 *
 * Each named field gets its own node with the same type signature.
 * Returns true when at least one field_identifier was found and emitted.
 */
function tryExtractGoFields(ext: TreeSitterExtractor, node: SyntaxNode, ctx: FieldExtractCtx): boolean {
  const nameNodes = node.namedChildren.filter((c) => c?.type === 'field_identifier');
  if (nameNodes.length === 0) return false;
  const typeNode = node.namedChildren.find(
    (c) =>
      c?.type !== 'field_identifier' && c?.type !== 'raw_string_literal' && c?.type !== 'interpreted_string_literal',
  );
  const typeText = typeNode ? getNodeText(typeNode, ext.source) : undefined;
  for (const nameNode of nameNodes) {
    if (!nameNode) continue;
    const name = getNodeText(nameNode, ext.source);
    const signature = typeText ? `${name} ${typeText}` : name;
    ext.createNode({
      kind: 'field',
      name,
      node: nameNode,
      extra: compact({
        docstring: ctx.docstring,
        signature,
        visibility: ctx.visibility,
        isStatic: ctx.isStatic,
        isExported: /^[A-Z]/.test(name),
      }),
    });
  }
  return true;
}

/**
 * Extract a class field declaration.
 * Four grammar shapes: Java/C# declarators, PHP property_elements,
 * Go field_identifier (one or more per field_declaration), fallback identifier.
 */
export function tsExtractField(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!ext.extractor) return;
  const ctx: FieldExtractCtx = {
    docstring: getPrecedingDocstring(node, ext.source),
    visibility: ext.extractor.getVisibility?.(node),
    isStatic: ext.extractor.isStatic?.(node) ?? false,
  };
  const hasDeclarators = findFieldDeclarators(node).length > 0;
  if (!hasDeclarators && tryExtractPhpProperties(ext, node, ctx)) return;
  if (!hasDeclarators && tryExtractGoFields(ext, node, ctx)) return;
  if (hasDeclarators) {
    extractFieldsFromDeclarators(ext, ctx, node);
  } else {
    extractFieldFallbackByName(ext, node, ctx);
  }
}
