/**
 * Universal hand-extractor — function-body walking.
 *
 * Carved out of `tree-sitter.ts` (god-module split, 2026-05-17). Holds
 * the body-walker: the `captureBody*` family that scans a function body
 * for calls / type annotations / field accesses / constant reads, plus
 * the body-visit entry points (`tsVisitFunctionBody`, `visitChildBody`,
 * `visitMisparsedBody`, `tsVisitVariableInitializer`).
 *
 * Same free-function convention as the rest of the extraction core:
 * each takes the `TreeSitterExtractor` as its first argument.
 *
 * ⚠ This file feeds `EXTRACTION_LOGIC_VERSION` — see the spec-file set
 * in `extraction-logic-version.ts`. A substantive edit here triggers a
 * one-shot full re-extraction on the next sync.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, TYPE_ANNOTATION_LANGUAGES } from './tree-sitter-helpers.js';
import { isJsFamily } from '../utils.js';
import { extractTypeRefsFromSubtree } from './tree-sitter-typerefs.js';
import {
  type TreeSitterExtractor,
  INSTANTIATION_KINDS,
  RECEIVER_LEAF_KINDS,
  resolveNodeBody,
  isEagerNestedFnMode,
  getSourceLines,
  pushNestedFunctionManifestRow,
} from './tree-sitter.js';
import { sliceSymbolBody, symbolBodyHash } from './symbol-body-hash.js';
import { tsExtractCall, tsExtractInstantiation } from './ts-extract-calls.js';
import {
  tsExtractClass,
  tsExtractStruct,
  tsExtractEnum,
  tsExtractInterface,
  tsExtractFunction,
} from './ts-extract-declarations.js';

/**
 * Type annotations seen inside a function body. Locals aren't graph
 * nodes themselves, but the TYPE relationship matters — so the
 * `type_of` edge is attributed to the enclosing function (top of
 * `nodeStack`) so a change to the referenced type correctly impacts
 * this function.
 *
 * Covered shapes:
 *   - `let x: Foo = ...`               (variable_declarator + type_annotation)
 *   - Go `var local Foo = a`           (var_spec)
 *   - `value as Foo`                   (TS as_expression)
 *   - `value satisfies Foo`            (TS satisfies_expression)
 *   - `new Map<Key, Value>()`          (TS type_arguments on call/construct)
 *   - `(x: Foo, y?: Bar) => ...`       (TS arrow params; required/optional_parameter)
 *
 * Without these, an exported type whose only consumer is a test that
 * casts/parameterises with it gets falsely flagged as `unused_export`
 * because no graph edge links the test scope to the type.
 *
 * Defensive: requires both an enclosing scope AND a language that
 * carries type annotations — skips silently when either is absent.
 */
function captureBodyTypeAnnotations(ext: TreeSitterExtractor, node: SyntaxNode): void {
  const enclosingId = ext.nodeStack.at(-1);
  if (!enclosingId) return;

  if (node.type === 'variable_declarator') {
    if (!TYPE_ANNOTATION_LANGUAGES.has(ext.language)) return;
    captureNamedTypeAnnotation(ext, node, enclosingId);
    return;
  }
  if (node.type === 'var_spec' && ext.language === 'go') {
    extractTypeRefsFromSubtree({ extractor: ext, node, fromNodeId: enclosingId, kind: 'type_of' });
    return;
  }
  if (TYPE_ANNOTATION_LANGUAGES.has(ext.language)) {
    captureTsConsumerTypePosition(ext, node, enclosingId);
  }
}

/**
 * Walk a node's named children for a `type_annotation` and emit
 * `type_of` edges from `enclosingId`. Used by the variable_declarator
 * branch (TS/JS) and by the TS arrow-fn parameter branch.
 */
function captureNamedTypeAnnotation(ext: TreeSitterExtractor, node: SyntaxNode, enclosingId: string): void {
  const annotation = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_annotation');
  if (annotation)
    extractTypeRefsFromSubtree({ extractor: ext, node: annotation, fromNodeId: enclosingId, kind: 'type_of' });
}

/**
 * TS/JS-only consumer-side type-position handlers that fire while
 * walking a function body: as/satisfies expressions, call-site type
 * arguments (`new Foo<T>()`), arrow-fn parameter annotations.
 * Extracted from {@link captureBodyTypeAnnotations} so the dispatcher
 * stays a small kind-routing chain.
 */
function captureTsConsumerTypePosition(ext: TreeSitterExtractor, node: SyntaxNode, enclosingId: string): void {
  if (node.type === 'as_expression' || node.type === 'satisfies_expression') {
    const typeNode = getChildByField(node, 'type') ?? node.namedChild(node.namedChildCount - 1);
    if (typeNode)
      extractTypeRefsFromSubtree({ extractor: ext, node: typeNode, fromNodeId: enclosingId, kind: 'type_of' });
    return;
  }
  if (node.type === 'type_arguments') {
    // Call-site only (`new Foo<T>()`, `func<T>(...)`); type_arguments
    // nested under a type_annotation is already covered by the
    // variable_declarator branch's recursive walk, so firing here too
    // would emit duplicate edges. Same logic applies to as/satisfies.
    const parentKind = node.parent?.type;
    if (parentKind !== 'new_expression' && parentKind !== 'call_expression') return;
    extractTypeRefsFromSubtree({ extractor: ext, node, fromNodeId: enclosingId, kind: 'type_of' });
    return;
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    captureNamedTypeAnnotation(ext, node, enclosingId);
  }
}

/**
 * Inside a function body, classify and dispatch ONE node — call site,
 * `new`-expression, or bare-name call. Mutually exclusive: a node
 * matches at most one form in any supported grammar; early returns
 * make that explicit. Defensive against missing `extractor` is the
 * caller's responsibility (visitFunctionBody guards once at entry).
 */
function captureBodyCallsAndRefs(ext: TreeSitterExtractor, node: SyntaxNode): void {
  const lang = ext.extractor!;
  const t = node.type;
  if (lang.callTypes.includes(t)) {
    tsExtractCall(ext, node);
    return;
  }
  if (INSTANTIATION_KINDS.has(t)) {
    // `new Foo()` (JS/TS), object_creation_expression (Java/C#), and
    // struct_expression (Rust `Foo { x: 1 }`) — all emit an
    // `instantiates` edge. Without this branch the body walker only
    // knows about call_expression and constructors produce no edges.
    tsExtractInstantiation(ext, node);
    return;
  }
  if (!lang.extractBareCall) return;
  const calleeName = lang.extractBareCall(node, ext.source);
  if (!calleeName || ext.nodeStack.length === 0) return;
  const callerId = ext.nodeStack.at(-1);
  if (!callerId) return;
  ext.unresolvedReferences.push({
    fromNodeId: callerId,
    referenceName: calleeName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Per-language shape of a field/attribute-access AST node. Different
 * tree-sitter grammars name these constructs differently:
 *
 *   - TS-family `member_expression` with field on `property` (with a
 *     `namedChild(1)` fallback for dialects where the field name is
 *     absent).
 *   - Rust `field_expression` with field on `field`. Tuple access
 *     like `x.0` has an `integer_literal` field child — dropped by
 *     `RECEIVER_LEAF_KINDS`, so no edge for tuple positions.
 *   - Python `attribute` with the field name on a child field NAMED
 *     `attribute` (the grammar's naming overloads the node kind and
 *     the field name).
 *   - Java `field_access` with the field on `field`. Java's
 *     `method_invocation` factors the receiver and method name apart
 *     (`object=this.bar`, `name=greet`), so `this.bar` in
 *     `this.bar.greet()` is a `field_access` with parent
 *     `method_invocation` — that IS a real field read (we touched the
 *     bar field to call on it), so the parent-skip set is empty for
 *     Java; the method name itself is never seen as a field_access.
 *
 * Listed here so the field-access visitor stays a small dispatch
 * over a table rather than ladder-of-isFoo branches; adding a fourth
 * or fifth language is one row in this map.
 */
interface FieldAccessShape {
  /** Tree-sitter node kind for `obj.field`. */
  readonly nodeType: string;
  /** Field-child name carrying the right-hand-side identifier (the
   *  property/attribute/field name being read). `null` when the
   *  grammar doesn't expose the property via a tree-sitter field name
   *  (then `fieldChildFallbackIndex` is required). */
  readonly fieldChildName: string | null;
  /** Fallback positional child index when the field-child lookup
   *  misses. Two scenarios use this: (a) TS-family dialects that
   *  omit the field name in the grammar — the lookup misses, the
   *  fallback fires; (b) languages like Kotlin whose grammar exposes
   *  NO tree-sitter field name on `obj.field`'s children — pair
   *  `fieldChildName: null` with this index to make it the primary
   *  child lookup. `null` means "no fallback, drop the node." */
  readonly fieldChildFallbackIndex: number | null;
  /** Parent AST kinds to suppress emission for — typically the
   *  call/instantiation positions, since those edges are already
   *  counted as `calls`/`instantiates`. Empty for grammars whose
   *  AST factors the method name out of the field-access shape
   *  (Java). */
  readonly parentTypesToSkip: ReadonlySet<string>;
  /** When set, the located fieldChild is an INTERMEDIATE node (e.g.
   *  Kotlin's `navigation_suffix` carries the `simple_identifier`
   *  leaf inside); descend into the first named child of this kind
   *  to find the actual property leaf. Undefined when the fieldChild
   *  IS the leaf — the common case. */
  readonly propertyDescendantKind?: string;
}

const TS_FAMILY_FIELD_ACCESS: FieldAccessShape = {
  nodeType: 'member_expression',
  fieldChildName: 'property',
  fieldChildFallbackIndex: 1,
  parentTypesToSkip: new Set(['call_expression', 'new_expression']),
};

const FIELD_ACCESS_SHAPE_BY_LANGUAGE: ReadonlyMap<string, FieldAccessShape> = new Map([
  ['typescript', TS_FAMILY_FIELD_ACCESS],
  ['tsx', TS_FAMILY_FIELD_ACCESS],
  ['javascript', TS_FAMILY_FIELD_ACCESS],
  ['jsx', TS_FAMILY_FIELD_ACCESS],
  [
    'rust',
    {
      nodeType: 'field_expression',
      fieldChildName: 'field',
      fieldChildFallbackIndex: null,
      parentTypesToSkip: new Set(['call_expression']),
    },
  ],
  [
    'python',
    {
      nodeType: 'attribute',
      fieldChildName: 'attribute',
      fieldChildFallbackIndex: null,
      // `obj.method()` parses as `call(function=attribute(obj, method))` in
      // tree-sitter-python, so suppressing parent=`call` is what dedupes
      // method-call receivers from the field_access stream.
      parentTypesToSkip: new Set(['call']),
    },
  ],
  [
    'java',
    {
      nodeType: 'field_access',
      fieldChildName: 'field',
      fieldChildFallbackIndex: null,
      // Java factors method calls into `method_invocation(object=this.bar, name=greet)`
      // — `this.bar` IS a real field read at the call site (we touched
      // the bar field to invoke greet on it), so no parent-skip is
      // needed; the method name itself is never wrapped in a
      // `field_access` node.
      parentTypesToSkip: new Set(),
    },
  ],
  // F#39 (2026-05-26): C/C++ `obj->field` and `obj.field`. Both
  // operators parse to the same `field_expression` node in
  // tree-sitter-c (the arrow vs dot is an internal anonymous token);
  // tree-sitter-cpp inherits the rule from C. Method-call shapes
  // (`obj.method(...)` / `obj->method(...)`) wrap the field_expression
  // in a `call_expression` — skip those so calls aren't double-counted
  // as field reads. C/C++ have no `this.method()`-style implicit
  // receiver shape, so no other parent skips are needed.
  [
    'c',
    {
      nodeType: 'field_expression',
      fieldChildName: 'field',
      fieldChildFallbackIndex: null,
      parentTypesToSkip: new Set(['call_expression']),
    },
  ],
  [
    'cpp',
    {
      nodeType: 'field_expression',
      fieldChildName: 'field',
      fieldChildFallbackIndex: null,
      parentTypesToSkip: new Set(['call_expression']),
    },
  ],
  // F#42 (2026-05-26): Go `obj.field` reads. tree-sitter-go uses
  // `selector_expression(operand, field=field_identifier)`. Method
  // calls `obj.M(...)` parse as `call_expression(function=selector_expression, ...)`
  // — skip those so they aren't double-counted as field reads. Cgo's
  // `C.foo(...)` pseudo-receiver is also a `selector_expression` but
  // sits under `call_expression`, so it's filtered by the parent skip;
  // bare reads of `C.SomeMacro` (rare) would land here as a field read,
  // which is semantically right — the read accesses the cgo bridge.
  [
    'go',
    {
      nodeType: 'selector_expression',
      fieldChildName: 'field',
      fieldChildFallbackIndex: null,
      parentTypesToSkip: new Set(['call_expression']),
    },
  ],
  // F#43 (2026-05-26): Kotlin `obj.field` reads. tree-sitter-kotlin
  // uses `navigation_expression(operand, navigation_suffix(., leaf))`
  // — the property leaf is NESTED inside `navigation_suffix`, not a
  // direct child of `navigation_expression`. The grammar doesn't
  // expose either child via a tree-sitter field name, so we use the
  // positional fallback (index 1 = `navigation_suffix`) and then
  // descend into its `simple_identifier` child via
  // `propertyDescendantKind`. Method calls `obj.m(...)` wrap the
  // navigation_expression in a `call_expression`, so the parent skip
  // dedupes them out. Same dispatch shape as F#39 (C/C++) + F#42 (Go);
  // the only difference is the nested-leaf path.
  [
    'kotlin',
    {
      nodeType: 'navigation_expression',
      fieldChildName: null,
      fieldChildFallbackIndex: 1,
      parentTypesToSkip: new Set(['call_expression']),
      propertyDescendantKind: 'simple_identifier',
    },
  ],
]);

/**
 * Emit a `field_access` ref for `obj.field` / `this.field` reads
 * encountered inside a function body — the runtime data-access
 * counterpart to the structural `references` edge.
 *
 * Used by ATFD/LAA-based feature_envy detection: a method that
 * reads many fields off another object/class is "envious" of that
 * class's data.
 *
 * Per-language shape lives in {@link FIELD_ACCESS_SHAPE_BY_LANGUAGE}.
 *
 * Skips:
 *   - call sites (`obj.method()`) — already counted as `calls`. The
 *     exact "what counts as a call site" is per-language (TS uses
 *     `call_expression` wrapping the member, Java factors the method
 *     name out, etc.) and lives in the per-language shape's
 *     `parentTypesToSkip`.
 *   - languages without a registered shape (other extractors can
 *     emit `field_access` refs themselves later).
 *   - chains where the property leaf isn't an identifier-shaped
 *     token (defensive — bad source input shouldn't blow up).
 *
 * Chained `a.b.c` access naturally emits two refs (one on the
 * outer naming `c`, one on the inner naming `b`) — that matches
 * LAA's "every distinct attribute access counts" semantics.
 */
function captureBodyFieldAccess(ext: TreeSitterExtractor, node: SyntaxNode): void {
  // F#55 (2026-05-26): the shape-map IS the per-language gate. Field-access
  // is a grammar-level feature, not a type-system one — a prior
  // TYPE_ANNOTATION_LANGUAGES gate here gave JavaScript / JSX a free pass to
  // the early-return even though both have registered shapes, so JS-family
  // sources (express, Svelte 5 JS+JSDoc runtime, dogfood .js files) emitted
  // zero field_access edges. The shape-map lookup below is O(1) and the
  // `node.type !== shape.nodeType` line returns early on the vast majority
  // of nodes, so dropping the early gate has no measurable cost.
  const shape = FIELD_ACCESS_SHAPE_BY_LANGUAGE.get(ext.language);
  if (!shape) return;
  if (node.type !== shape.nodeType) return;
  const parentKind = node.parent?.type;
  if (parentKind && shape.parentTypesToSkip.has(parentKind)) return;

  let prop: SyntaxNode | null = null;
  if (shape.fieldChildName !== null) {
    prop = getChildByField(node, shape.fieldChildName) ?? null;
  }
  if (!prop && shape.fieldChildFallbackIndex !== null) {
    prop = node.namedChild(shape.fieldChildFallbackIndex);
  }
  if (!prop) return;
  // F#43 (Kotlin): the located fieldChild is an intermediate node
  // (e.g. `navigation_suffix`); descend to the named child of the
  // requested kind to reach the property leaf. Other grammars leave
  // `propertyDescendantKind` undefined and use `prop` directly.
  if (shape.propertyDescendantKind) {
    const descendantKind = shape.propertyDescendantKind;
    prop = prop.namedChildren.find((c) => c?.type === descendantKind) ?? null;
  }
  if (!prop || !RECEIVER_LEAF_KINDS.has(prop.type)) return;
  const name = getNodeText(prop, ext.source);
  if (!name) return;

  const enclosingId = ext.nodeStack.at(-1);
  if (!enclosingId) return;

  ext.unresolvedReferences.push({
    fromNodeId: enclosingId,
    referenceName: name,
    referenceKind: 'field_access',
    line: prop.startPosition.row + 1,
    column: prop.startPosition.column,
  });
}

/**
 * SCREAMING_SNAKE_CASE identifier matcher used by
 * {@link captureBodyConstantReads} to filter for module-scope
 * constant naming conventions. Requires at least one underscore OR
 * a digit somewhere after the leading letter so single-word
 * all-caps locals like `URL` or `OK` don't trip the rule. (Multi-
 * letter all-caps without underscores are rare for constants but
 * extremely common for type/class names — `URL`, `HTML`, `OK`.)
 *
 * Examples that match: `EXTRACTION_LOGIC_VERSION`, `MAX_RETRIES`,
 *   `PI2`, `HTTP_OK`, `V1`.
 * Examples that don't: `foo`, `Foo`, `URL`, `HTML`, `OK`, `Url`.
 */
// Alt 1: at least one underscore — covers EXTRACTION_LOGIC_VERSION etc.
// Alt 2: all-caps prefix of ≥2 letters then digits — covers VERSION6, HTTP200.
// The ≥2-letter guard on alt 2 rejects 2-char tokens like `A1` / `B2` that the
// reviewer flagged (round 3) without changing real-world constant matching.
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{2,}\d+[A-Z0-9_]*$/;

/**
 * Parent-position kinds where a bare identifier is being WRITTEN /
 * DECLARED / DESTRUCTURED, not READ. Skipping these prevents the
 * constant-read rule from emitting a self-references edge from the
 * declaration site or attributing assignment LHS as a read.
 */
const CONSTANT_READ_SKIP_PARENT_KINDS: ReadonlySet<string> = new Set([
  // JS / TS — declarations + destructures + imports/exports.
  'variable_declarator', // const FOO = ... — FOO is the name child
  'import_specifier', // import { FOO } — already an `imports` edge
  'export_specifier', // export { FOO } — already an `exports` edge
  'shorthand_property_identifier_pattern', // destructuring binding
  'object_pattern', // destructuring
  'array_pattern', // destructuring
  'rest_pattern', // ...FOO destructure
  'assignment_pattern', // default-value destructure
  'required_parameter', // TS arrow / function param name
  'optional_parameter', // TS arrow / function param name
  'formal_parameters', // bare param in JS
  'catch_clause', // catch (FOO)
  'labeled_statement', // FOO: while(...) {}
  // Rust — parent kinds where EVERY direct identifier child is a binding
  // or an import (never a read). For Rust declaration items that have
  // BOTH a name and a value child (`const_item`, `static_item`, etc.)
  // see `isRustDeclNamePosition` — those need a positional check so the
  // RHS value isn't accidentally skipped along with the LHS name.
  'identifier_pattern', // let X = … — LHS pattern wrapper
  'parameter', // fn f(X: T) — param pattern position
  'use_declaration', // use foo::BAR — already an `imports` edge
  'use_list', // use foo::{BAR, …}
  'scoped_use_list', // use foo::bar::{BAZ, …}
  'use_as_clause', // use foo::BAR as B
]);

/** Rust declaration kinds → the tree-sitter field name that holds the
 *  binding identifier (the symbol being declared, not a read).
 *  Identifiers at other field positions on the same parent (value /
 *  type / body) are real reads that should still emit references. The
 *  positional check matters because declaration parents can also contain
 *  readable identifiers in value, type, or body fields.
 */
const RUST_DECL_BINDING_FIELD: Record<string, string> = {
  const_item: 'name',
  static_item: 'name',
  function_item: 'name',
  mod_item: 'name',
  field_declaration: 'name',
  enum_variant: 'name',
  let_declaration: 'pattern',
};

/**
 * True when `node` sits at the binding-field position of a Rust
 * declaration parent — the binding site, not a read.
 */
function isRustDeclBindingPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const field = RUST_DECL_BINDING_FIELD[parent.type];
  if (!field) return false;
  const bindingChild = getChildByField(parent, field);
  return bindingChild?.startIndex === node.startIndex;
}

/**
 * True when `node` is the trailing segment of a `scoped_identifier`
 * (possibly nested: `a::b::SCREAMING_FN`) that sits at the `function`
 * field of a `call_expression` / `new_expression`. The callee role
 * is already captured as a `calls` edge by `tsExtractCall`, so
 * emitting a `references` edge here would double-count the same use.
 *
 * The direct-parent callee check inside {@link captureBodyConstantReads}
 * doesn't cover this because `parent.type` for a scoped trailing name
 * is `scoped_identifier`, not `call_expression` — walk up through any
 * chain of scoped_identifier ancestors before checking for the call
 * parent.
 */
function isScopedCalleeDescendant(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node.parent;
  while (cur?.type === 'scoped_identifier') {
    const parent: SyntaxNode | null = cur.parent;
    if (!parent) return false;
    if (parent.type === 'call_expression' || parent.type === 'new_expression') {
      const fn = getChildByField(parent, 'function') ?? parent.namedChild(0);
      return fn?.startIndex === cur.startIndex;
    }
    cur = parent;
  }
  return false;
}

/**
 * Member-expression child positions: if the bare identifier is the
 * `property` of a `member_expression` (e.g. `obj.FOO`), the access
 * is already covered by `captureBodyFieldAccess`. If it's the
 * `object` position (e.g. `FOO.member`), THAT'S still a real read
 * of FOO and should fire.
 */
function isMemberExpressionPropertyChild(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type !== 'member_expression') return false;
  const prop = getChildByField(parent, 'property') ?? parent.namedChild(1);
  return prop?.startIndex === node.startIndex;
}

/**
 * Object-literal key position: in `{ FOO: 1 }` the `FOO` identifier
 * is the `key` of a `pair`. That's a property NAME, not a read of
 * the symbol `FOO`. (Shorthand `{ FOO }` IS a read — covered by the
 * `shorthand_property_identifier` node type, which is distinct from
 * `identifier` so it doesn't reach this helper anyway.)
 */
function isObjectKeyPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type !== 'pair') return false;
  const key = getChildByField(parent, 'key') ?? parent.namedChild(0);
  return key?.startIndex === node.startIndex;
}

/**
 * Assignment LHS: in `FOO = 1` the `FOO` identifier on the left of
 * `assignment_expression` is being written, not read. Skip.
 * (Compound assignment like `FOO += 1` is rare for module-scope
 * constants in TS where `const` makes the write a syntax error; we
 * still skip for safety.)
 */
function isAssignmentLeftPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type !== 'assignment_expression') return false;
  const left = getChildByField(parent, 'left') ?? parent.namedChild(0);
  return left?.startIndex === node.startIndex;
}

/** Bundled inputs for {@link isNonReadConstantPosition} — bundled into
 *  one arg per the `*Args` convention so the predicate stays under the
 *  long-parameter-list threshold. `isGo` is passed (not re-derived) so
 *  the predicate matches the caller's already-computed value exactly. */
interface ConstantReadPositionArgs {
  node: SyntaxNode;
  parent: SyntaxNode;
  isGo: boolean;
}

/**
 * True when a SCREAMING_SNAKE / PascalCase identifier sits at a
 * position that is NOT a real read — a declaration / binding /
 * destructure (see {@link CONSTANT_READ_SKIP_PARENT_KINDS}), a Rust or
 * Go declaration binding field, a call / construct callee (already an
 * edge via `tsExtractCall` / `tsExtractInstantiation`, including the
 * scoped `mod::FN()` shape), a member-expression property, an
 * object-literal key, or an assignment LHS. Lifts the skip-condition
 * chain out of {@link captureBodyConstantReads} so the emitter stays
 * under the complexity threshold; behaviour is identical (same checks,
 * same short-circuit order).
 */
function isNonReadConstantPosition(args: ConstantReadPositionArgs): boolean {
  const { node, parent, isGo } = args;
  if (CONSTANT_READ_SKIP_PARENT_KINDS.has(parent.type)) return true;
  if (isRustDeclBindingPosition(node)) return true;
  if (isGo && isGoDeclBindingPosition(node)) return true;
  // Call / construct callee position — already an edge via tsExtractCall / tsExtractInstantiation.
  if (parent.type === 'call_expression' || parent.type === 'new_expression') {
    const fn = getChildByField(parent, 'function') ?? parent.namedChild(0);
    if (fn?.startIndex === node.startIndex) return true;
  }
  // Scoped callee: `mod::SCREAMING_FN()` parses the call's `function`
  // field as a scoped_identifier — our identifier's parent is the
  // scoped_identifier, not the call_expression. Walk up the path chain.
  if (isScopedCalleeDescendant(node)) return true;
  if (isMemberExpressionPropertyChild(node)) return true;
  if (isObjectKeyPosition(node)) return true;
  if (isAssignmentLeftPosition(node)) return true;
  return false;
}

/**
 * Emit a `references` unresolved-ref for bare SCREAMING_SNAKE_CASE
 * identifier reads inside a function body. Closes friction F-B
 * (caught 2026-05-11 stress test): module-scope constants used
 * INSIDE the same file as their declaration produced no caller
 * edges, because the body walker only emitted edges for call /
 * instantiation / type-annotation / field-access positions. Bare
 * identifier reads of named constants were a structural blind spot
 * — `tsExtractCall` fires only for `call_expression` nodes, and the
 * generic visitor never asked "is this an identifier I should
 * resolve?". The resolver (`name-matcher`) already handles same-
 * file matches; the gap was purely upstream emission.
 *
 * Scope:
 *   - JS family + Rust + Go (F#44, 2026-05-26). All three grammars
 *     use `identifier` for bare reads. JS/Rust gate on
 *     `SCREAMING_SNAKE_RE` (the constant-naming convention in those
 *     ecosystems); Go diverges to `GO_PASCAL_NAME_RE` because Go's
 *     exported-symbol convention is PascalCase, not SCREAMING_SNAKE
 *     (which is rare in idiomatic Go). Other languages can opt in
 *     later if a similar gap surfaces; broadening eagerly risks
 *     flooding the resolver with low-precision noise on grammars we
 *     haven't evaluated.
 *   - JS/Rust name MUST match SCREAMING_SNAKE_CASE (with at least
 *     one `_` or trailing digit pattern). Conservative: single-word
 *     all-caps (`URL`, `HTML`, `OK`) don't fire — they're commonly
 *     type names and would produce false-positive caller edges to
 *     types. Go name MUST match `^[A-Z]\w*$` (any
 *     PascalCase-start identifier — Go's exported-symbol convention).
 *   - Skip writes / declarations / destructures (see
 *     {@link CONSTANT_READ_SKIP_PARENT_KINDS}), member-expression
 *     property positions, object-literal keys, assignment LHS, the
 *     callee position of `call_expression` / `new_expression`
 *     (already covered by `tsExtractCall` / `tsExtractInstantiation`),
 *     and Go-specific declaration positions (see
 *     {@link isGoDeclBindingPosition} for the var_spec /
 *     short_var_declaration / range_clause shapes).
 */
function captureBodyConstantReads(ext: TreeSitterExtractor, node: SyntaxNode): void {
  // F#44 (2026-05-26): Go also participates, but with a PascalCase
  // gate (the Go-exported convention) instead of SCREAMING_SNAKE_RE.
  // The two paths share the skip set; the only divergence is the
  // name-match regex.
  const isGo = ext.language === 'go';
  if (!isJsFamily(ext.language) && ext.language !== 'rust' && !isGo) return;
  if (node.type !== 'identifier') return;
  const name = getNodeText(node, ext.source);
  if (isGo) {
    if (!GO_PASCAL_NAME_RE.test(name)) return;
  } else if (!SCREAMING_SNAKE_RE.test(name)) {
    return;
  }
  const parent = node.parent;
  if (!parent) return;
  if (isNonReadConstantPosition({ node, parent, isGo })) return;

  const enclosingId = ext.nodeStack.at(-1);
  if (!enclosingId) return;
  ext.unresolvedReferences.push({
    fromNodeId: enclosingId,
    referenceName: name,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * F#44 (2026-05-26): Go exported-symbol matcher. Go's convention is
 * PascalCase (first char uppercase ⇒ package-exported); SCREAMING_SNAKE
 * is rare in idiomatic Go. The shape pattern `^[A-Z]\w*$`
 * keeps lowercase locals out and matches both pure-letters
 * (`DebugMode`, `Form`) and digit-bearing names (`HTTP2`, `V1`).
 *
 * Conservative single-letter handling: 1-char PascalCase reads
 * (`T`, `K`) ARE matched — those are rare in read positions for Go
 * (generic type params live in DEFINITION positions, filtered out).
 */
const GO_PASCAL_NAME_RE = /^[A-Z]\w*$/;

/** Go declaration kinds → the tree-sitter field name holding the
 *  binding identifier (the symbol being declared, not a read).
 *  Mirrors the Rust positional-skip pattern: identifiers at OTHER
 *  field positions on the same parent (value / type / body) are
 *  real reads that should still emit references. */
const GO_DECL_BINDING_FIELD: Record<string, string> = {
  var_spec: 'name', // var Foo int = 1
  const_spec: 'name', // const Foo = "x"
  parameter_declaration: 'name', // func f(Foo Bar) — Foo is the param name
  field_declaration: 'name', // struct field name (in struct decl bodies)
  function_declaration: 'name', // func Foo() { ... } — name is binding
  method_declaration: 'name',
  type_spec: 'name', // type Foo struct/interface
  type_alias: 'name', // type Foo = Bar (Go 1.9+ alias)
};

/**
 * True when `node` sits at the binding-field position of a Go
 * declaration parent — the binding site, not a read. For the multi-LHS
 * shapes (`x, y := f()` and `for k, v := range m`) the identifiers
 * live one level deeper inside an `expression_list` carried on the
 * declaration's `left` field — checked positionally so the RHS
 * `expression_list` (the value side) doesn't also get skipped.
 */
function isGoDeclBindingPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Direct binding-field case (var_spec, const_spec, parameter_declaration, etc.).
  const field = GO_DECL_BINDING_FIELD[parent.type];
  if (field) {
    const bindingChild = getChildByField(parent, field);
    if (bindingChild?.startIndex === node.startIndex) return true;
  }
  // Multi-LHS: `x, y := f()` AND `for k, v := range m`. The LHS
  // identifiers sit inside `expression_list` on the parent's `left`
  // field. The RHS expression_list (whose own identifiers ARE reads)
  // sits on the `right` field — the positional check distinguishes.
  if (parent.type === 'expression_list') {
    const grand = parent.parent;
    if (grand && (grand.type === 'short_var_declaration' || grand.type === 'range_clause')) {
      const leftList = getChildByField(grand, 'left');
      if (leftList?.startIndex === parent.startIndex) return true;
    }
  }
  return false;
}

/** JSX/TSX element node types whose opening identifier is a use of a
 *  component symbol. `jsx_fragment` (`<>...</>`) deliberately omitted —
 *  it has no name. */
const JSX_USE_ELEMENT_TYPES: ReadonlySet<string> = new Set(['jsx_opening_element', 'jsx_self_closing_element']);

/**
 * Emit a `references` unresolved-ref for the component identifier of a
 * JSX opening (or self-closing) element. Closes Bug #3 of the G16
 * polyglot arc (caught 2026-05-22 against the nextssh client repo):
 * the body walker previously didn't visit jsx_opening_element node
 * types, so `<RailGroup>` / `<RailRow />` produced no use edge to the
 * component declarations. The dead-code orphan finder
 * (`findOrphanedSymbols`) treated React components used only via JSX
 * as orphans and falsely flagged them with 100% FP rate.
 *
 * Three shapes covered:
 *   - `<RailGroup>` / `<RailGroup />`            — name is `identifier`
 *   - `<foo.Bar />`                              — name is `member_expression`;
 *     emit ref to the OUTER identifier (`foo`) which is the imported
 *     binding the dead-code rule needs to see used. The inner
 *     identifier (`Bar`) is a property access, not a top-level symbol.
 *   - `<svg:rect />`                             — name is
 *     `jsx_namespace_name`; the prefix half (`svg`) is the imported
 *     binding when used in React/Solid. Same shape as member_expression.
 *
 * Lowercase JSX identifiers (`<div>`, `<span>`, `<a>`) are HTML/SVG
 * primitives, not user-defined symbols — skipped via the
 * starts-with-capital check (PascalCase being the React convention).
 *
 * The orphan finder reads {@link ORPHAN_LIVENESS_EDGE_KINDS} which
 * includes `references` — same edge kind the constant-reads rule
 * emits — so no rule-side change is needed for the dead-code path to
 * pick this up. Cross-file `unused_export` biomarker reads the same
 * edge set and benefits identically.
 *
 * Gated to the JS-family languages (`isJsFamily`) because the visitor
 * is shared across every grammar — defensive in case a non-JS grammar
 * ever reuses one of these node type names.
 */
function captureBodyJsxReferences(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (!isJsFamily(ext.language)) return;
  if (!JSX_USE_ELEMENT_TYPES.has(node.type)) return;
  const enclosingId = ext.nodeStack.at(-1);
  if (!enclosingId) return;
  const nameNode = getChildByField(node, 'name') ?? node.namedChild(0);
  if (!nameNode) return;
  const refName = pickJsxReferenceIdentifier(ext, nameNode);
  if (!refName) return;
  ext.unresolvedReferences.push({
    fromNodeId: enclosingId,
    referenceName: refName.name,
    referenceKind: 'references',
    line: refName.line,
    column: refName.column,
  });
}

/**
 * Pull the user-defined symbol name out of a JSX element's `name`
 * node. Returns `null` for lowercase HTML/SVG primitives and for
 * shapes we don't recognise.
 */
function pickJsxReferenceIdentifier(
  ext: TreeSitterExtractor,
  nameNode: SyntaxNode,
): { name: string; line: number; column: number } | null {
  if (nameNode.type === 'identifier') {
    const text = getNodeText(nameNode, ext.source);
    if (!text || !/^[A-Z]/.test(text)) return null;
    return { name: text, line: nameNode.startPosition.row + 1, column: nameNode.startPosition.column };
  }
  if (nameNode.type === 'member_expression' || nameNode.type === 'jsx_namespace_name') {
    // <foo.Bar /> or <svg:rect /> — the OUTER binding (`foo`/`svg`)
    // is the imported symbol; the inner half is a property access on
    // it. The dead-code rule needs to see the outer binding used.
    const objectNode = getChildByField(nameNode, 'object') ?? nameNode.namedChild(0);
    if (objectNode?.type !== 'identifier') return null;
    const text = getNodeText(objectNode, ext.source);
    if (!text || !/^[A-Z]/.test(text)) return null;
    return { name: text, line: objectNode.startPosition.row + 1, column: objectNode.startPosition.column };
  }
  return null;
}

/**
 * If `node` declares a structural symbol (class / struct / enum /
 * interface / trait) inside a function body, extract it and return
 * `true` — caller short-circuits the recursion because each
 * `extract*` method visits its own children.
 *
 * Returns `false` for non-structural nodes so the caller continues
 * descending. Defensive: caller is responsible for `extractor`-set
 * invariant (visitFunctionBody guards once at entry).
 */
function tryExtractBodyStructuralChild(ext: TreeSitterExtractor, node: SyntaxNode): boolean {
  const lang = ext.extractor!;
  const t = node.type;
  if (lang.classTypes.includes(t)) {
    extractClassByDispatch(ext, node, lang.classifyClassNode?.(node) ?? 'class');
    return true;
  }
  if (lang.structTypes.includes(t)) {
    tsExtractStruct(ext, node);
    return true;
  }
  if (lang.enumTypes.includes(t)) {
    tsExtractEnum(ext, node);
    return true;
  }
  if (lang.interfaceTypes.includes(t)) {
    tsExtractInterface(ext, node);
    return true;
  }
  return false;
}

/**
 * F#12 slice 1: tree-sitter node types that bind an inner function to
 * a name inside a function body. The body walker checks for these to
 * promote nested declarations into first-class `function` nodes.
 *
 * Three shapes covered, all JS/TS-family:
 *   - `function foo() { ... }` → `function_declaration`
 *   - generator: `function* foo() { ... }` → `generator_function_declaration`
 *   - `const foo = () => ...` / `function() {}` → `variable_declarator`
 *     whose `value` child is `arrow_function` / `function_expression` /
 *     `generator_function`.
 *
 * Bare `arrow_function` / `function_expression` (callback passed inline
 * to `setTimeout`, `.then(...)`, JSX prop, etc.) are intentionally NOT
 * extracted — they have no stable name and `tsExtractFunction` would
 * resolve them to `<anonymous>` (which `tsExtractFunction` already
 * routes through `visitMisparsedBody` to keep their inner calls
 * attributed to the enclosing scope).
 */
const NESTED_FN_BARE_DECL_TYPES = new Set<string>(['function_declaration', 'generator_function_declaration']);
const NESTED_FN_VALUE_TYPES = new Set<string>(['arrow_function', 'function_expression', 'generator_function']);

/**
 * F#12 slice 1: when the file is in eager mode, recognize a nested
 * function declaration inside a function body and route it through
 * `tsExtractFunction` so it becomes a first-class `function` node with
 * a `contains` edge from its enclosing scope (the top of `nodeStack`,
 * pushed by `visitChildBody`). Returns `true` when the caller should
 * SKIP descent — `tsExtractFunction` walks the nested body itself via
 * `visitChildBody`, so a second descent here would double-attribute
 * the inner calls / field accesses.
 *
 * Restricted to JS-family because the value-type recognizers
 * (`arrow_function` / `function_expression`) are JS-grammar shapes.
 * Other languages' nested-function patterns (Rust closures, Go
 * anonymous funcs, Python nested `def`) need their own recognizers —
 * see the F#12 plan's "open questions" #7.
 */
function tryExtractNestedFunctionDecl(ext: TreeSitterExtractor, node: SyntaxNode): boolean {
  if (!isEagerNestedFnMode(ext)) return false;
  if (!isJsFamily(ext.language)) return false;

  if (NESTED_FN_BARE_DECL_TYPES.has(node.type)) {
    tsExtractFunction(ext, node);
    return true;
  }

  if (node.type === 'variable_declarator') {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return false;
    // Skip destructured patterns — `const { foo } = bar` doesn't bind a
    // function-name we can resolve. The current grammar wouldn't put a
    // fn-shaped value here anyway, but the guard keeps the contract
    // explicit and matches `extractTsJsVariables`'s top-level handling.
    if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') return false;
    const valueNode = getChildByField(node, 'value');
    if (!valueNode || !NESTED_FN_VALUE_TYPES.has(valueNode.type)) return false;
    tsExtractFunction(ext, valueNode);
    return true;
  }

  return false;
}

/**
 * F#12 slice 2: in manifest-mode (mega-) files, record a manifest row
 * for each nested-function declaration encountered inside a function
 * body. Mirrors the shape recognition in
 * {@link tryExtractNestedFunctionDecl} (slice 1's eager path) so the
 * two modes agree on what counts as a nested function — only the
 * mode-flag inverts.
 *
 * Returns `void` rather than skip-children: the caller continues to
 * descend INTO the nested function's body so nested-nested fns get
 * their own manifest rows AND so the existing call / field-access
 * walker keeps attributing inner calls to the closest real-node
 * ancestor (the slice-1 mega-file behaviour pre-this-patch). The
 * manifest row is therefore additive — no other visitor semantics
 * change.
 *
 * `parentNodeId` is `nodeStack.at(-1)` — the closest REAL-node
 * ancestor on the visitor stack. `visitChildBody` pushes the function
 * id before walking the body, so for top-level fns inside the file
 * the stack top is the file node's id; for nested-in-nested the top
 * is still the closest real-node ancestor (manifest rows never push
 * to the stack — they're not real nodes).
 */
function tryCollectNestedFnManifest(ext: TreeSitterExtractor, node: SyntaxNode): void {
  if (isEagerNestedFnMode(ext)) return;
  if (!isJsFamily(ext.language)) return;
  if (!ext.extractor) return;
  const parentNodeId = ext.nodeStack.at(-1);
  if (!parentNodeId) return;

  let fnNode: SyntaxNode | null = null;
  let name: string | null = null;

  if (NESTED_FN_BARE_DECL_TYPES.has(node.type)) {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    name = getNodeText(nameNode, ext.source);
    fnNode = node;
  } else if (node.type === 'variable_declarator') {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') return;
    const valueNode = getChildByField(node, 'value');
    if (!valueNode || !NESTED_FN_VALUE_TYPES.has(valueNode.type)) return;
    name = getNodeText(nameNode, ext.source);
    fnNode = valueNode;
  }

  if (!fnNode || !name) return;

  const startLine = fnNode.startPosition.row + 1;
  const endLine = fnNode.endPosition.row + 1;
  const body = sliceSymbolBody(getSourceLines(ext), startLine, endLine);
  const signature = ext.extractor.getSignature?.(fnNode, ext.source) ?? null;

  pushNestedFunctionManifestRow(ext, {
    parentNodeId,
    filePath: ext.filePath,
    name,
    startLine,
    startCol: fnNode.startPosition.column,
    endLine,
    endCol: fnNode.endPosition.column,
    signature,
    bodyHash: symbolBodyHash(signature, body),
  });
}

/** Route a `classTypes` node to the matching extractor based on the
 *  language's classifier. Pulled out of {@link tryExtractBodyStructuralChild}
 *  so the else-if cascade (which parses as nested if_statement) doesn't
 *  contribute 5 levels of nested_complexity to the dispatcher. */
function extractClassByDispatch(
  ext: TreeSitterExtractor,
  node: SyntaxNode,
  classification: string,
): void {
  switch (classification) {
    case 'struct':
      tsExtractStruct(ext, node);
      return;
    case 'enum':
      tsExtractEnum(ext, node);
      return;
    case 'interface':
      tsExtractInterface(ext, node);
      return;
    case 'trait':
      tsExtractClass(ext, node, 'trait');
      return;
    default:
      tsExtractClass(ext, node);
      return;
  }
}

/**
 * Misparse fallback: visit the body as a context-less subtree so
 * calls/structural nodes still get recorded, then return.
 */
export function visitMisparsedBody(ext: TreeSitterExtractor, node: SyntaxNode): void {
  const body = resolveNodeBody(ext, node);
  if (body) tsVisitFunctionBody(ext, body, '');
}

/** Push the parent id, visit the body subtree, and pop. */
export function visitChildBody(ext: TreeSitterExtractor, parentId: string, body: SyntaxNode | null): void {
  ext.nodeStack.push(parentId);
  if (body) tsVisitFunctionBody(ext, body, parentId);
  ext.nodeStack.pop();
}

/**
 * Walk a top-level variable's initializer expression as if it were a
 * function body, attributing every call/instantiation/field-access/
 * type-annotation inside to the enclosing variable. Handles the
 * `CROSS_FILE_RULES = [{produce: (q) => findX(q)}]` pattern:
 * tree-sitter parses the arrow-bodies fine, but the main dispatcher
 * short-circuits the recursion at `lexical_declaration` so the calls
 * inside arrow values of array/object literals were silently dropped
 * (#61 Gap 1).
 *
 * Re-uses `tsVisitFunctionBody` rather than a bespoke walker so the
 * same call/instantiation/type-annotation/field-access semantics that
 * apply inside real function bodies also apply here.
 */
export function tsVisitVariableInitializer(
  ext: TreeSitterExtractor,
  parentId: string,
  valueNode: SyntaxNode | null,
): void {
  if (!valueNode) return;
  visitChildBody(ext, parentId, valueNode);
}

/**
 * Visit function body and extract calls, structural nodes, and nested
 * function declarations.
 *
 * In addition to call expressions, this also detects:
 *   1. Local class/struct/enum/interface definitions inside function
 *      bodies (valid in C++, Java, etc.).
 *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
 *      tree-sitter to interpret the namespace block as a function_definition,
 *      hiding real class/struct/enum nodes inside the "function body".
 *   3. F#12 slice 1: when the per-file eager mode flag is on
 *      (JS/TS-family files whose largest function body fits under
 *      `largeFunctionThreshold`), nested function declarations and
 *      `const foo = () => {}` arrow-bound shapes are promoted to
 *      first-class `function` nodes with `contains` from the enclosing
 *      scope. See {@link tryExtractNestedFunctionDecl}.
 *   4. F#12 slice 2: when the eager mode flag is OFF (manifest-mode
 *      mega-files — any function body crosses `largeFunctionThreshold`),
 *      the same nested-function shapes are recorded as manifest rows
 *      via {@link tryCollectNestedFnManifest} instead of promoting to
 *      graph nodes. The visitor still descends into the body so calls /
 *      field-accesses inside the nested fn attribute to the closest
 *      real-node ancestor (which is the slice-1 mega-file behaviour);
 *      manifest rows are additive. See
 *      `docs/F12-NESTED-FUNCTION-PROMOTION-PLAN.md` for the design.
 */
export function tsVisitFunctionBody(ext: TreeSitterExtractor, body: SyntaxNode, _functionId: string): void {
  if (!ext.extractor) return;

  const visitForCallsAndStructure = (node: SyntaxNode): void => {
    captureBodyTypeAnnotations(ext, node);
    captureBodyCallsAndRefs(ext, node);
    captureBodyFieldAccess(ext, node);
    captureBodyConstantReads(ext, node);
    captureBodyJsxReferences(ext, node);
    if (tryExtractBodyStructuralChild(ext, node)) return;
    if (tryExtractNestedFunctionDecl(ext, node)) return;
    // F#12 slice 2: in manifest-mode (mega-) files the eager hook
    // above short-circuits on the mode flag; this collects a manifest
    // row instead, then falls through so the body walker continues
    // descending (catches nested-nested fns and preserves the
    // attribute-inner-calls-to-outer-fn behaviour).
    tryCollectNestedFnManifest(ext, node);
    // B15 (2026-05-23) — bulk `namedChildren` instead of O(n²) indexed reads. See B14.
    for (const child of node.namedChildren) {
      if (child) visitForCallsAndStructure(child);
    }
  };

  visitForCallsAndStructure(body);
}
