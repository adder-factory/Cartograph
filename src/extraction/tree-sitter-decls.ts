/**
 * Top-level declaration extraction helpers.
 *
 * Extracted from `TreeSitterExtractor` so the main class doesn't
 * carry per-shape clusters of variable / import / type-alias /
 * type-annotation methods on top of its language-agnostic
 * orchestration. The helpers operate on the extractor instance
 * directly via its @internal fields and methods.
 *
 * Five clusters in this file:
 *   1. Variable declarations (TS/JS / Python+Ruby / Go /
 *      generic fallback) plus the `formatInitSignature` helper
 *      and the `extractVariable` dispatcher.
 *   2. Import statements (per-language hook + Python multi-import
 *      / Go grouped imports / PHP grouped use / TS/JS named-import
 *      reference emission for the `unused_export` biomarker).
 *   3. Type aliases (struct / enum / interface dispatch + the
 *      plain `type X = T1 | T2` shape).
 *   4. Type annotations (parameter, return, field — including the
 *      sibling-scan fallback for postfix-style languages where
 *      the return type isn't on a named field).
 *   5. The `collectNamedFieldRefs` helper used by the struct
 *      type-alias path.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { NodeKind } from '../types.js';
import { compact, isJsFamily } from '../utils.js';
import {
  getNodeText,
  getChildByField,
  getPrecedingDocstring,
  findChildByTypes,
  subtreeContainsType,
  TYPE_ANNOTATION_LANGUAGES,
} from './tree-sitter-helpers.js';
import { extractName, tsExtractFunction, tsExtractEnumMembers, tsVisitVariableInitializer } from './tree-sitter.js';
import { extractTypeRefsFromSubtree } from './tree-sitter-typerefs.js';
import { extractInheritance } from './tree-sitter-inheritance.js';
import type { TreeSitterExtractor } from './tree-sitter.js';

/** Truncation cap for the initializer-signature column on variable / constant nodes. */
const INIT_SIGNATURE_MAX = 100;

// ── Variables ──────────────────────────────────────────────────────

/**
 * Top-level / module-level variable declarations. Captures the
 * variable name and the first {@link INIT_SIGNATURE_MAX} characters
 * of the initializer in the `signature` column for searchability.
 */
export function extractVariable(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  if (!extractor.extractor) return;

  const isConst = extractor.extractor.isConst?.(node) ?? false;
  const kind: NodeKind = isConst ? 'constant' : 'variable';
  const docstring = getPrecedingDocstring(node, extractor.source);
  const isExported = extractor.extractor.isExported?.(node, extractor.source) ?? false;

  // Each language has a different declaration shape:
  //   TS/JS  - lexical_declaration → variable_declarator children
  //   Python/Ruby - assignment (left, right)
  //   Go - var_spec/const_spec list + short_var_declaration (:=)
  //   anything else - identifier / variable_declarator children
  const lang = extractor.language;
  const ctx: VariableExtractCtx = { kind, docstring, isExported };
  if (isJsFamily(lang)) {
    extractTsJsVariables(extractor, node, ctx);
  } else if (lang === 'python' || lang === 'ruby') {
    extractPythonRubyVariable({ extractor, node, kind, docstring });
  } else if (lang === 'go') {
    extractGoVariables(extractor, node, docstring);
  } else {
    extractFallbackVariables(extractor, node, ctx);
  }
}

/** Per-symbol context threaded through {@link extractTsJsVariables}
 *  and {@link extractFallbackVariables} — keeps each extractor's
 *  signature compact while still carrying the language-agnostic
 *  metadata (kind / docstring / isExported) computed once in
 *  {@link extractVariable}. */
interface VariableExtractCtx {
  kind: NodeKind;
  docstring: string | undefined;
  isExported: boolean;
}

/**
 * Format an initializer's first 100 chars as `= <value>...` so the
 * downstream signature column stays searchable. Returns `undefined`
 * when there's no initializer.
 */
function formatInitSignature(
  extractor: TreeSitterExtractor,
  valueNode: SyntaxNode | null | undefined,
): string | undefined {
  if (!valueNode) return undefined;
  const initValue = getNodeText(valueNode, extractor.source).slice(0, INIT_SIGNATURE_MAX);
  if (!initValue) return undefined;
  const overflow = initValue.length >= INIT_SIGNATURE_MAX ? '...' : '';
  return `= ${initValue}${overflow}`;
}

/**
 * TS/JS `lexical_declaration` / `variable_declaration` carry one or
 * more `variable_declarator` children. Skips destructured patterns
 * (`let { x, y } = $props()`) and re-routes arrow / function
 * expressions through `extractFunction` so they show up as functions
 * in the graph rather than variables.
 */
function extractTsJsVariables(extractor: TreeSitterExtractor, node: SyntaxNode, ctx: VariableExtractCtx): void {
  for (const child of node.namedChildren) {
    if (child?.type !== 'variable_declarator') continue;
    const nameNode = getChildByField(child, 'name');
    if (!nameNode) continue;
    if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') continue;

    const valueNode = getChildByField(child, 'value');
    if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
      tsExtractFunction(extractor, valueNode);
      continue;
    }

    const varNode = extractor.createNode({
      kind: ctx.kind,
      name: getNodeText(nameNode, extractor.source),
      node: child,
      extra: compact({
        docstring: ctx.docstring,
        signature: formatInitSignature(extractor, valueNode),
        isExported: ctx.isExported,
      }),
    });
    if (varNode) {
      extractVariableTypeAnnotation(extractor, child, varNode.id);
      // #61 Gap 1: walk the initializer subtree so calls / instantiations
      // inside arrow functions buried in array or object literals (e.g.
      // `const RULES = [{produce: (q) => findX(q)}]`) get attributed to
      // the enclosing constant. Without this pass the main dispatcher
      // short-circuits at lexical_declaration and those calls are
      // silently dropped — they don't even land in unresolved_refs.
      tsVisitVariableInitializer(extractor, varNode.id, valueNode);
      // F-J (2026-05-11 friction workout): emit `references` edges for
      // bare-identifier values inside object / array literal binding
      // tables — `const FIND_TOOL = { handle: handleFind, ... }`. These
      // identifiers are property bindings (function value used as a
      // dispatcher slot, sibling const referenced into a registry) and
      // genuine references that the body-walker pass missed because:
      //   (a) `captureBodyConstantReads` filters by SCREAMING_SNAKE_CASE,
      //       so camelCase function names like `handleFind` slipped past;
      //   (b) `captureBodyCallsAndRefs` only fires on call_expression /
      //       new_expression, not bare identifier reads in pair-value
      //       position.
      // The symptom was a 0-callers result on every MCP tool dispatcher
      // (handleFind, handleAdmin, …) and entry-point queries that
      // didn't surface them. Restricted to module-level const/let/var
      // initializers so we don't flood with refs from inline option
      // bags inside function bodies.
      extractBindingTableRefs(extractor, varNode.id, valueNode);
    }
  }
}

/** Function-like containers — descending into them would cross from a
 *  binding-table context back into a function body, where the body
 *  walker is the right tool for identifier-read attribution. */
const BINDING_TABLE_SKIP_KINDS: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function_declaration',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
  'class_body',
]);

/** Identifiers that resolve to JS globals — never useful as refs targets
 *  because they don't match a project symbol; emitting them just dirties
 *  `unresolved_refs` until the next reaper. */
const BINDING_TABLE_RESERVED_LITERALS: ReadonlySet<string> = new Set(['undefined', 'NaN', 'Infinity', 'globalThis']);

/**
 * Skip SCREAMING_SNAKE_CASE values: those are already covered by
 * `captureBodyConstantReads` (`ts-extract-bodies.ts`) in the body-walker pass that
 * `tsVisitVariableInitializer` triggered above. Skipping here avoids
 * duplicate `unresolved_refs` rows that would resolve to the same edge.
 * The regex must mirror `SCREAMING_SNAKE_RE` in `ts-extract-bodies.ts`.
 */
const BINDING_TABLE_SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{2,}[0-9]+[A-Z0-9_]*$/;

/**
 * Walk `valueNode` looking for bare-identifier values in pair-value
 * (`{ key: ident }`) or array-element (`[ident, ...]`) positions, and
 * emit one `references` unresolved-ref per hit, attributed to
 * `parentId` (the enclosing module-level constant being declared).
 *
 * Only descends into structural composites (object / array / pair).
 * Function-like nodes are not crossed — once execution moves into a
 * function body, identifier reads belong to that function, not the
 * outer binding table. Call-expression arguments are likewise not
 * walked here; a call-arg identifier is already an edge through
 * `captureBodyCallsAndRefs`.
 */
function extractBindingTableRefs(extractor: TreeSitterExtractor, parentId: string, valueNode: SyntaxNode | null): void {
  if (!valueNode) return;
  // Restrict to literal initializers — `const X = someFunc` doesn't
  // benefit from this pass (the function call itself is already an edge).
  if (valueNode.type !== 'object' && valueNode.type !== 'array') return;

  const emit = (name: string, lineNode: SyntaxNode): void => {
    if (BINDING_TABLE_RESERVED_LITERALS.has(name) || BINDING_TABLE_SCREAMING_SNAKE_RE.test(name)) return;
    extractor.unresolvedReferences.push({
      fromNodeId: parentId,
      referenceName: name,
      referenceKind: 'references',
      line: lineNode.startPosition.row + 1,
      column: lineNode.startPosition.column,
    });
  };

  const visit = (node: SyntaxNode): void => {
    if (BINDING_TABLE_SKIP_KINDS.has(node.type)) return;

    if (node.type === 'identifier') {
      const parent = node.parent;
      if (parent) {
        let isBindingValue = false;
        if (parent.type === 'pair') {
          const key = getChildByField(parent, 'key') ?? parent.namedChild(0);
          if (key?.startIndex !== node.startIndex) isBindingValue = true;
        } else if (parent.type === 'array') {
          isBindingValue = true;
        }
        if (isBindingValue) emit(getNodeText(node, extractor.source), node);
      }
    } else if (node.type === 'shorthand_property_identifier' && node.parent?.type === 'object') {
      // `const X = { handler }` shorthand — the identifier IS both the
      // property name and the value being bound. Same rationale as the
      // explicit `pair` form but emitted from a different AST shape.
      emit(getNodeText(node, extractor.source), node);
    }

    for (const c of node.namedChildren) {
      if (c) visit(c);
    }
  };
  visit(valueNode);
}

interface PythonRubyVarArgs {
  extractor: TreeSitterExtractor;
  node: SyntaxNode;
  kind: NodeKind;
  docstring: string | undefined;
}

/** Python / Ruby `assignment`: identifier on the left, value on the right.
 *  Ruby also surfaces `(constant)` for uppercase LHS (`MODULES = [...]`) —
 *  accept it so Ruby constants reach `createNode` instead of being dropped
 *  here. The `kind` arg already carries `'constant'` for that case via
 *  the language's `isConst` hook. */
function extractPythonRubyVariable(args: PythonRubyVarArgs): void {
  const { extractor, node, kind, docstring } = args;
  const left = getChildByField(node, 'left') || node.namedChild(0);
  if (!left || (left.type !== 'identifier' && left.type !== 'constant')) return;
  const right = getChildByField(node, 'right') || node.namedChild(1);
  extractor.createNode({
    kind,
    name: getNodeText(left, extractor.source),
    node,
    extra: compact({
      docstring,
      signature: formatInitSignature(extractor, right),
    }),
  });
}

/**
 * Go declarations come in two shapes:
 *   1. `var_declaration` / `const_declaration` carry `var_spec` /
 *      `const_spec` children, each with one or more identifiers.
 *   2. `short_var_declaration` (`:=`) — `left` is an identifier or
 *      `expression_list`, `right` is the initializer.
 * Both shapes can appear in a single call, so handle them in series.
 */
function extractGoVariables(extractor: TreeSitterExtractor, node: SyntaxNode, docstring: string | undefined): void {
  const specs = collectGoVarOrConstSpecs(node);
  const declKind: NodeKind = node.type === 'const_declaration' ? 'constant' : 'variable';
  for (const spec of specs) {
    const nameNode = spec.namedChild(0);
    if (!nameNode || nameNode.type !== 'identifier') continue;
    const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
    const name = getNodeText(nameNode, extractor.source);
    extractor.createNode({
      kind: declKind,
      name,
      node: spec,
      extra: compact({
        docstring,
        signature: formatInitSignature(extractor, valueNode),
        isExported: /^[A-Z]/.test(name),
      }),
    });
  }
  if (node.type === 'short_var_declaration') {
    // `:=` only appears inside function bodies in Go, so these are
    // locals — never package-exported regardless of name casing.
    const left = getChildByField(node, 'left');
    if (!left) return;
    const right = getChildByField(node, 'right');
    const identifiers =
      left.type === 'expression_list' ? left.namedChildren.filter((c) => c.type === 'identifier') : [left];
    const signature = formatInitSignature(extractor, right);
    for (const id of identifiers) {
      extractor.createNode({
        kind: 'variable',
        name: getNodeText(id, extractor.source),
        node,
        extra: compact({ docstring, signature }),
      });
    }
  }
}

/**
 * Collect the `var_spec` / `const_spec` children of a Go declaration
 * node, looking one level through `var_spec_list` (the Go grammar
 * wraps `var (...)` block bodies in an intermediate node not used for
 * `const (...)` blocks). Bug-hunt FN1: ollama's `cmd/tui/tui.go` had
 * 8 `var (...)` block members silently dropped while neighbouring
 * `const (...)` and bare `var name = ...` lines extracted fine.
 */
function collectGoVarOrConstSpecs(node: SyntaxNode): SyntaxNode[] {
  const specs: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'var_spec' || child.type === 'const_spec') {
      specs.push(child);
    } else if (child.type === 'var_spec_list') {
      specs.push(...collectVarSpecsFromList(child));
    }
  }
  return specs;
}

/** Pull the `var_spec` children out of a `var_spec_list` wrapper (the
 *  intermediate node the Go grammar inserts for `var (...)` block
 *  bodies). Split out of {@link collectGoVarOrConstSpecs} to keep that
 *  function's branch flat. */
function collectVarSpecsFromList(list: SyntaxNode): SyntaxNode[] {
  return list.namedChildren.filter((inner) => inner.type === 'var_spec');
}

/** Generic fallback for languages without a dedicated branch. */
function extractFallbackVariables(extractor: TreeSitterExtractor, node: SyntaxNode, ctx: VariableExtractCtx): void {
  for (const child of node.namedChildren) {
    if (!child || (child.type !== 'identifier' && child.type !== 'variable_declarator')) continue;
    const name =
      child.type === 'identifier'
        ? getNodeText(child, extractor.source)
        : extractName(child, extractor.source, extractor.extractor!);
    if (!name || name === '<anonymous>') continue;
    extractor.createNode({
      kind: ctx.kind,
      name,
      node: child,
      extra: compact({ docstring: ctx.docstring, isExported: ctx.isExported }),
    });
  }
}

// ── Type aliases ──────────────────────────────────────────────────

/**
 * Extract a type alias (e.g. `export type X = ...` in TypeScript).
 * For Go etc., `resolveTypeAliasKind` detects when the type_spec
 * wraps a struct / interface / enum and dispatches to the matching
 * structural extractor. Returns `true` when children should be
 * skipped (struct / interface / enum paths handled their own body
 * walk).
 */
export function extractTypeAlias(extractor: TreeSitterExtractor, node: SyntaxNode): boolean {
  if (!extractor.extractor) return false;
  const name = extractName(node, extractor.source, extractor.extractor);
  if (name === '<anonymous>') return false;
  const docstring = getPrecedingDocstring(node, extractor.source);
  const isExported = extractor.extractor.isExported?.(node, extractor.source);

  const ctx: TypeAliasExtractCtx = { name, docstring, isExported };
  const resolvedKind = extractor.extractor.resolveTypeAliasKind?.(node, extractor.source);
  if (resolvedKind === 'struct') return extractStructTypeAlias(extractor, node, ctx);
  if (resolvedKind === 'enum') return extractEnumTypeAlias(extractor, node, ctx);
  if (resolvedKind === 'interface') return extractInterfaceTypeAlias(extractor, node, ctx);
  return extractPlainTypeAlias(extractor, node, ctx);
}

/** Per-symbol context threaded through the four type-alias extractors
 *  so each signature stays compact. The four resolvers share an
 *  identical metadata shape (resolved name + docstring + isExported)
 *  computed once in {@link extractTypeAlias}. */
interface TypeAliasExtractCtx {
  name: string;
  docstring: string | undefined;
  isExported: boolean | undefined;
}

/**
 * Go `type Foo struct { ... }` (and C `typedef struct { ... } Foo`):
 * create the struct node, emit struct embedding via
 * `extractInheritance`, walk the subtree for named field
 * declarations (skipping anonymous embeddings — covered by
 * extractInheritance), then visit body children.
 */
function extractStructTypeAlias(extractor: TreeSitterExtractor, node: SyntaxNode, ctx: TypeAliasExtractCtx): boolean {
  const ext = extractor.extractor!;
  const structNode = extractor.createNode({
    kind: 'struct',
    name: ctx.name,
    node,
    extra: compact({ docstring: ctx.docstring, isExported: ctx.isExported }),
  });
  if (!structNode) return true;
  extractor.nodeStack.push(structNode.id);
  try {
    const typeChild = getChildByField(node, 'type') || findChildByTypes(node, ext.structTypes);
    if (typeChild)
      processStructTypeAliasBody({ extractor, typeChild, structNodeId: structNode.id, bodyField: ext.bodyField });
  } finally {
    extractor.nodeStack.pop();
  }
  return true;
}

interface StructTypeAliasBodyArgs {
  extractor: TreeSitterExtractor;
  typeChild: SyntaxNode;
  structNodeId: string;
  bodyField: string;
}

/** Inheritance + named-field refs + body-children walk for a Go-style
 *  `type Foo struct { ... }` (and C `typedef struct { ... } Foo`).
 *  Pulled out so {@link extractStructTypeAlias} stays at depth 2. */
function processStructTypeAliasBody(args: StructTypeAliasBodyArgs): void {
  const { extractor, typeChild, structNodeId, bodyField } = args;
  extractInheritance(extractor, typeChild, structNodeId);
  collectNamedFieldRefs(extractor, typeChild, structNodeId);
  const body = getChildByField(typeChild, bodyField) || typeChild;
  for (const child of body.namedChildren) {
    if (child) extractor.visitNode(child);
  }
}

/**
 * Walk a struct subtree for named field declarations (those with a
 * `field_identifier` descendant) and emit `type_of` refs from the
 * struct to each annotated type.
 */
function collectNamedFieldRefs(extractor: TreeSitterExtractor, node: SyntaxNode, structId: string): void {
  if (node.type === 'field_declaration' || node.type === 'field_definition') {
    if (subtreeContainsType(node, 'field_identifier')) {
      extractTypeRefsFromSubtree({ extractor, node, fromNodeId: structId, kind: 'type_of' });
    }
    return;
  }
  for (const child of node.namedChildren) {
    if (child) collectNamedFieldRefs(extractor, child, structId);
  }
}

/**
 * C `typedef enum { ... } Foo` (and similar): create the enum node,
 * walk the inner enum body emitting members via
 * `extractEnumMembers` (or recursing into other children).
 */
function extractEnumTypeAlias(extractor: TreeSitterExtractor, node: SyntaxNode, ctx: TypeAliasExtractCtx): boolean {
  const ext = extractor.extractor!;
  const enumNode = extractor.createNode({
    kind: 'enum',
    name: ctx.name,
    node,
    extra: compact({ docstring: ctx.docstring, isExported: ctx.isExported }),
  });
  if (!enumNode) return true;
  extractor.nodeStack.push(enumNode.id);
  try {
    processEnumTypeAliasInner({ extractor, node, enumNodeId: enumNode.id, ext });
  } finally {
    extractor.nodeStack.pop();
  }
  return true;
}

interface EnumTypeAliasInnerArgs {
  extractor: TreeSitterExtractor;
  node: SyntaxNode;
  enumNodeId: string;
  ext: NonNullable<TreeSitterExtractor['extractor']>;
}

/** Inner-enum lookup, inheritance, then per-member dispatch for the
 *  enum-type-alias path. Pulled out of the try-block so the outer
 *  body sits at depth 2 instead of 5 (try / if-inner / if-body / for / if-member). */
function processEnumTypeAliasInner(args: EnumTypeAliasInnerArgs): void {
  const { extractor, node, enumNodeId, ext } = args;
  const innerEnum = findChildByTypes(node, ext.enumTypes);
  if (!innerEnum) return;
  extractInheritance(extractor, innerEnum, enumNodeId);
  const body = ext.resolveBody?.(innerEnum, ext.bodyField) ?? getChildByField(innerEnum, ext.bodyField);
  if (!body) return;
  const memberTypes = ext.enumMemberTypes;
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (memberTypes?.includes(child.type)) tsExtractEnumMembers(extractor, child);
    else extractor.visitNode(child);
  }
}

/**
 * Go `type Foo interface { ... }`: create the interface node and
 * emit inheritance edges for embedded interfaces (`type_elem`
 * children of `interface_type`), then walk the interface body for
 * `method_elem` children and emit a method node per declared method.
 *
 * Pre-2026-05-23 the function intentionally skipped the body walk
 * under the (incorrect) assumption that interface methods are
 * separate top-level AST nodes — they aren't in Go, where every
 * method declaration is a `method_elem` nested inside `interface_type`.
 * Without the body walk, ollama's `ml.Backend` interface (8 methods)
 * surfaced as a single signature-less node with zero `contains` edges
 * (FN4 from the polyglot bug-hunt).
 */
function extractInterfaceTypeAlias(
  extractor: TreeSitterExtractor,
  node: SyntaxNode,
  ctx: TypeAliasExtractCtx,
): boolean {
  const ext = extractor.extractor!;
  const kind: NodeKind = ext.interfaceKind ?? 'interface';
  const interfaceNode = extractor.createNode({
    kind,
    name: ctx.name,
    node,
    extra: compact({ docstring: ctx.docstring, isExported: ctx.isExported }),
  });
  if (!interfaceNode) return true;
  const typeChild = getChildByField(node, 'type');
  if (typeChild) {
    extractInheritance(extractor, typeChild, interfaceNode.id);
    if (typeChild.type === 'interface_type') {
      // Push the interface onto nodeStack so createNode auto-emits the
      // contains edge from interface → method (and method nodes don't
      // get a spurious contains edge from the FILE — which is what
      // sits at the top of nodeStack before this block). Mirrors the
      // struct path above.
      extractor.nodeStack.push(interfaceNode.id);
      try {
        extractGoInterfaceMethods(extractor, typeChild, ctx.name);
      } finally {
        extractor.nodeStack.pop();
      }
    }
  }
  return true;
}

/**
 * Walk a Go `interface_type` body for `method_elem` children and emit
 * a `method` node per declared method. The `contains` edge from the
 * interface to each method is emitted automatically by `createNode`
 * via the nodeStack push in the caller. `type_elem` children (embedded
 * interfaces) are skipped — handled by `extractInheritance`.
 */
function extractGoInterfaceMethods(
  extractor: TreeSitterExtractor,
  interfaceBody: SyntaxNode,
  interfaceName: string,
): void {
  for (const child of interfaceBody.namedChildren) {
    if (!child || child.type !== 'method_elem') continue;
    const nameNode = child.namedChildren.find((c) => c?.type === 'field_identifier');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, extractor.source);
    const paramsIdx = child.namedChildren.findIndex((c) => c?.type === 'parameter_list');
    const params = paramsIdx >= 0 ? child.namedChildren[paramsIdx] : null;
    const paramText = params ? getNodeText(params, extractor.source) : '()';
    // Return type can be a parameter_list (multi-return: `(int, error)`)
    // OR a bare type expression (`error`, `string`). Take the first
    // sibling after the parameter_list. (No filter needed — the
    // field_identifier always precedes the parameter_list in Go's grammar.)
    const after = paramsIdx >= 0 ? child.namedChildren.slice(paramsIdx + 1) : [];
    const returnNode = after[0];
    const returnText = returnNode ? ' ' + getNodeText(returnNode, extractor.source) : '';
    const signature = `${paramText}${returnText}`;
    extractor.createNode({
      kind: 'method',
      name,
      node: child,
      extra: compact({
        signature,
        qualifiedName: `${interfaceName}::${name}`,
        isExported: /^[A-Z]/.test(name),
      }),
    });
  }
}

/**
 * Plain `type X = SomeType | OtherType`: create the type_alias
 * node and emit `type_of` refs for every type identifier mentioned
 * in the value (TS family only). Returns false so the caller still
 * descends into the alias's children.
 */
function extractPlainTypeAlias(extractor: TreeSitterExtractor, node: SyntaxNode, ctx: TypeAliasExtractCtx): boolean {
  const typeAliasNode = extractor.createNode({
    kind: 'type_alias',
    name: ctx.name,
    node,
    extra: compact({ docstring: ctx.docstring, isExported: ctx.isExported }),
  });
  if (typeAliasNode && TYPE_ANNOTATION_LANGUAGES.has(extractor.language)) {
    const value = getChildByField(node, 'value');
    if (value) extractTypeRefsFromSubtree({ extractor, node: value, fromNodeId: typeAliasNode.id });
  }
  return false;
}

// ── Imports ───────────────────────────────────────────────────────

/**
 * Extract an import statement. Routes to the language-specific
 * hook when the extractor declares one; falls back to per-shape
 * multi-import paths (Python `import os, sys`, Go grouped imports,
 * PHP grouped `use`); finally a generic single-node fallback.
 */
export function extractImport(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  if (!extractor.extractor) return;
  if (extractor.extractor.extractImport && tryExtractImportViaHook(extractor, node)) return;

  const importText = (): string => getNodeText(node, extractor.source).trim();

  if (extractor.language === 'python' && node.type === 'import_statement') {
    extractPythonMultiImports(extractor, node, importText());
    return;
  }
  if (extractor.language === 'go') {
    extractGoImports(extractor, node);
    return;
  }
  if (extractor.language === 'php' && tryExtractPhpGroupedImports(extractor, node, importText())) return;

  if (extractor.extractor.extractImport) return; // Hook declined — don't fallback.

  const text = importText();
  extractor.createNode({ kind: 'import', name: text, node, extra: { signature: text } });
}

/**
 * Run the language-specific `extractImport` hook. Creates the import
 * node, emits the parent→module unresolved `imports` ref (unless the
 * hook said it handled refs itself), and for TS/JS emits per-named-
 * import `references` so the `unused_export` biomarker counts
 * cross-file consumption correctly.
 */
function tryExtractImportViaHook(extractor: TreeSitterExtractor, node: SyntaxNode): boolean {
  const info = extractor.extractor!.extractImport!(node, extractor.source);
  if (!info) return false;
  extractor.createNode({ kind: 'import', name: info.moduleName, node, extra: { signature: info.signature } });

  if (!info.handledRefs && info.moduleName && extractor.nodeStack.length > 0) {
    const parentId = extractor.nodeStack.at(-1);
    if (parentId) {
      extractor.unresolvedReferences.push({
        fromNodeId: parentId,
        referenceName: info.moduleName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  const lang = extractor.language;
  if (isJsFamily(lang)) {
    emitNamedImportRefsFromFile(extractor, node);
  }
  return true;
}

/** Python `import os, sys` and `import os as o` — one import node per module name. */
function extractPythonMultiImports(extractor: TreeSitterExtractor, node: SyntaxNode, importText: string): void {
  for (const child of node.namedChildren) {
    emitPythonImportFromChild({ extractor, node, child, importText });
  }
}

interface PythonImportChildArgs {
  extractor: TreeSitterExtractor;
  node: SyntaxNode;
  child: SyntaxNode | null;
  importText: string;
}

/** Emit one `import` node for a single Python multi-import child:
 *  either a bare `dotted_name` or an `aliased_import` wrapping one. */
function emitPythonImportFromChild(args: PythonImportChildArgs): void {
  const { extractor, node, child, importText } = args;
  if (!child) return;
  if (child.type === 'dotted_name') {
    extractor.createNode({
      kind: 'import',
      name: getNodeText(child, extractor.source),
      node,
      extra: { signature: importText },
    });
    return;
  }
  if (child.type !== 'aliased_import') return;
  const dottedName = child.namedChildren.find((c) => c.type === 'dotted_name');
  if (!dottedName) return;
  extractor.createNode({
    kind: 'import',
    name: getNodeText(dottedName, extractor.source),
    node,
    extra: { signature: importText },
  });
}

/** Go single (`import "x"`) and grouped (`import ( "x"; "y" )`) — one import node per spec. */
function extractGoImports(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const parentId = extractor.nodeStack.length > 0 ? extractor.nodeStack.at(-1) : null;
  const extractFromSpec = (spec: SyntaxNode): void => {
    const stringLiteral = spec.namedChildren.find((c) => c.type === 'interpreted_string_literal');
    if (!stringLiteral) return;
    const importPath = getNodeText(stringLiteral, extractor.source).replaceAll(/['"]/g, '');
    if (!importPath) return;
    // cgo pseudo-import: `import "C"` binds the cgo bridge for the file.
    // The bare `"C"` spec is opaque on its own — enrich the signature so
    // an agent reading the imports table recognises it without re-grepping.
    const rawSignature = getNodeText(spec, extractor.source).trim();
    const signature = importPath === 'C' ? `${rawSignature} // cgo pseudo-import` : rawSignature;
    extractor.createNode({
      kind: 'import',
      name: importPath,
      node: spec,
      extra: {
        signature,
      },
    });
    if (parentId) {
      extractor.unresolvedReferences.push({
        fromNodeId: parentId,
        referenceName: importPath,
        referenceKind: 'imports',
        line: spec.startPosition.row + 1,
        column: spec.startPosition.column,
      });
    }
  };
  const importSpecList = node.namedChildren.find((c) => c.type === 'import_spec_list');
  if (importSpecList) {
    for (const spec of importSpecList.namedChildren.filter((c) => c.type === 'import_spec')) {
      extractFromSpec(spec);
    }
  } else {
    const importSpec = node.namedChildren.find((c) => c.type === 'import_spec');
    if (importSpec) extractFromSpec(importSpec);
  }
}

/**
 * PHP grouped `use X\{A, B}` — one import node per clause member.
 * Returns true when the grouped shape matched (and nodes were
 * created).
 */
function tryExtractPhpGroupedImports(extractor: TreeSitterExtractor, node: SyntaxNode, importText: string): boolean {
  const namespacePrefix = node.namedChildren.find((c) => c.type === 'namespace_name');
  const useGroup = node.namedChildren.find((c) => c.type === 'namespace_use_group');
  if (!namespacePrefix || !useGroup) return false;
  const prefix = getNodeText(namespacePrefix, extractor.source);
  const useClauses = useGroup.namedChildren.filter(
    (c: SyntaxNode) => c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause',
  );
  for (const clause of useClauses) {
    const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    const name = nsName
      ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
      : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
    if (name) {
      const fullPath = `${prefix}\\${getNodeText(name, extractor.source)}`;
      extractor.createNode({ kind: 'import', name: fullPath, node, extra: { signature: importText } });
    }
  }
  return true;
}

/**
 * Emit `references` unresolved-refs FROM THE FILE NODE (not from the
 * import statement) for each named import in a TS/JS
 * `import { a, b as c } from './m'` declaration. The import-clause
 * hook already creates the file→module `imports` edge; this adds the
 * symbol-level evidence the `unused_export` biomarker needs to count
 * cross-file consumption.
 *
 * Handles two shape variants (type-only imports already work because
 * the import_clause structure is the same):
 *   1. Pure type-only: `import type { Foo }` — the `type` keyword
 *      is a literal child of import_statement; named_imports is under
 *      import_clause (same structure as regular imports).
 *   2. Mixed type specifiers: `import { bar, type Baz }` — the `type`
 *      keyword is a child of the import_specifier; named_imports nesting
 *      is unchanged.
 *
 * Naming note (#14): the prior name `emitNamedImportRefs` was
 * misleading — readers expected the source of the emitted edge to
 * be the import statement node itself. It's not; the source is the
 * importing FILE node, looked up from `extractor.nodeStack[-1]` (which
 * is the file node when this fires from a top-level import). The
 * `FromFile` suffix makes that contract explicit so callers don't
 * accidentally try to reattribute by tweaking the import node id.
 *
 * Default and namespace imports are excluded — they bind the entire
 * module, not a specific exported symbol.
 *
 * The reference name is the LOCAL binding (the alias when present,
 * the exported name otherwise). Why the local name rather than the
 * exported name:
 *   1. `dedupeReferences` keys by (fromNodeId, kind, name). Pushing
 *      the exported name when N files re-export the same symbol
 *      (e.g. 31 migration files each `export const MIGRATION`)
 *      folds all N refs into one — only the first import survives
 *      to the resolver, the other N−1 lose their target binding.
 *      Per-spec local names are unique, so the dedup keeps each.
 *   2. `resolveViaImport.pickMatchingImport` keys on `localName` in
 *      its primary lookup, then walks the import's source path to
 *      pin the exact target file. Aliased imports resolve cleanly
 *      where name-only matching would mark them AMBIGUOUS.
 *   3. For non-aliased imports the local and exported names are
 *      identical, so behavior is unchanged.
 *
 * The resolver's `hasAnyPossibleMatch` pre-filter would normally
 * reject local aliases (no exported symbol of that name exists), so
 * `resolveOne` consults `matchesLocalImportAlias` as a second-chance
 * check — without that, this push would dead-end before
 * `resolveViaImport` runs.
 */
function emitNamedImportRefsFromFile(extractor: TreeSitterExtractor, importNode: SyntaxNode): void {
  if (extractor.nodeStack.length === 0) return;
  const parentId = extractor.nodeStack.at(-1);
  if (!parentId) return;
  const importClause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!importClause) return;
  const namedImports = importClause.namedChildren.find((c) => c.type === 'named_imports');
  if (!namedImports) return;

  for (const spec of namedImports.namedChildren) {
    if (spec.type !== 'import_specifier') continue;
    // Tree-sitter exposes the alias via the `alias` field when
    // present; otherwise fall back to the `name` field (exported
    // name) which doubles as the local binding for non-aliased
    // imports.
    const aliasNode = getChildByField(spec, 'alias');
    const nameNode = aliasNode ?? getChildByField(spec, 'name') ?? spec.namedChild(0);
    if (!nameNode) continue;
    const localName = getNodeText(nameNode, extractor.source);
    if (!localName) continue;
    extractor.unresolvedReferences.push({
      fromNodeId: parentId,
      referenceName: localName,
      referenceKind: 'references',
      line: spec.startPosition.row + 1,
      column: spec.startPosition.column,
    });
  }
}

// ── Type annotations ─────────────────────────────────────────────

/**
 * Resolve a parameter / return-type child by trying first the
 * tree-sitter grammar field name, then the named-child whose AST
 * type matches. Different languages declare these as fields
 * (TS, Go, Python) vs. as plain named children (Kotlin, Dart,
 * Scala, PHP, C/C++ in some cases).
 */
function resolveSignatureChild(node: SyntaxNode, nameOrType: string): SyntaxNode | null {
  return getChildByField(node, nameOrType) ?? node.namedChildren.find((c: SyntaxNode) => c.type === nameOrType) ?? null;
}

/** AST node types that can appear as a function's return-type sibling in postfix-style languages. */
const RETURN_TYPE_NODE_TYPES: ReadonlySet<string> = new Set([
  'type_identifier',
  'user_type',
  'predefined_type',
  'generic_name',
  'qualified_name',
  'nullable_type',
  'function_type',
  'tuple_type',
  'array_type',
]);

/**
 * Some languages (Kotlin, Dart, Scala, Swift) attach the return type
 * as a direct named child after — or before — `parameters` rather
 * than via a dedicated field. Try the postfix sibling scan first
 * (most common shape); fall back to a backwards prefix scan that
 * picks the LAST type-shaped child before params.
 *
 * tree-sitter-web returns fresh wrapper objects from every navigation
 * so reference equality always fails — match by `startIndex`.
 */
function findReturnTypeBySiblingScan(node: SyntaxNode, params: SyntaxNode): SyntaxNode | null {
  const paramsIdx = node.namedChildren.findIndex((c: SyntaxNode) => c.startIndex === params.startIndex);
  if (paramsIdx < 0) return null;
  for (let i = paramsIdx + 1; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && RETURN_TYPE_NODE_TYPES.has(child.type)) return child;
  }
  for (let i = paramsIdx - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (child && RETURN_TYPE_NODE_TYPES.has(child.type)) return child;
  }
  return null;
}

/**
 * Extract type references from a function / method / field node:
 *   - `returns` for the function's return-type annotation
 *   - `type_of` for parameter annotations and the node's own
 *     type annotation (class fields, etc.)
 *
 * Some languages (Kotlin, Dart, Scala, Swift) attach the return
 * type as a direct named child after `parameters` rather than via
 * a dedicated field — the postfix / prefix sibling scan handles
 * that case when the field-name lookup misses.
 */
export function extractTypeAnnotations(extractor: TreeSitterExtractor, node: SyntaxNode, nodeId: string): void {
  if (!extractor.extractor) return;
  if (!TYPE_ANNOTATION_LANGUAGES.has(extractor.language)) return;

  const params = resolveSignatureChild(node, extractor.extractor.paramsField || 'parameters');
  if (params) extractTypeRefsFromSubtree({ extractor, node: params, fromNodeId: nodeId, kind: 'type_of' });

  let returnType = resolveSignatureChild(node, extractor.extractor.returnField || 'return_type');
  if (!returnType && params) returnType = findReturnTypeBySiblingScan(node, params);
  if (returnType) extractTypeRefsFromSubtree({ extractor, node: returnType, fromNodeId: nodeId, kind: 'returns' });

  const typeAnnotation = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_annotation');
  if (typeAnnotation)
    extractTypeRefsFromSubtree({ extractor, node: typeAnnotation, fromNodeId: nodeId, kind: 'type_of' });
}

/**
 * Extract type references from a variable's type annotation
 * (`let local: Foo = ...`). Top-level only — locals inside
 * function bodies are handled inline by the body walker.
 */
function extractVariableTypeAnnotation(extractor: TreeSitterExtractor, node: SyntaxNode, nodeId: string): void {
  if (!TYPE_ANNOTATION_LANGUAGES.has(extractor.language)) return;
  const typeAnnotation = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_annotation');
  if (typeAnnotation)
    extractTypeRefsFromSubtree({ extractor, node: typeAnnotation, fromNodeId: nodeId, kind: 'type_of' });
}
