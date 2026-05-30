/**
 * Inheritance / supertype extraction helpers.
 *
 * One dispatch fan-out (`extractInheritance`) plus per-language
 * shape handlers covering: TS / JS extends_clause + class_heritage,
 * Java extends / implements with type_list, Python argument_list,
 * Go interface embedding (constraint_elem) + struct embedding
 * (field_declaration sans field_identifier), Rust trait_bounds and
 * impl-for-Trait clauses, C# colon-separated base_list, Kotlin
 * delegation_specifier, Swift inheritance_specifier, PHP base_clause,
 * Dart `interfaces`, plus the JS class_heritage bare-identifier
 * shape (`class Foo extends Bar`).
 *
 * Pascal inheritance lives in `tree-sitter-pascal.ts` since the
 * grammar uses `typeref` children rather than the cross-language
 * shapes here.
 *
 * Extracted from `TreeSitterExtractor` so the main class doesn't
 * carry 11 inheritance-only methods on top of its language-agnostic
 * orchestration. The functions use the extractor's @internal
 * `unresolvedReferences` field directly.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, subtreeContainsType } from './tree-sitter-helpers.js';
import type { TreeSitterExtractor } from './tree-sitter.js';

/**
 * Lookup table of inheritance-clause kinds whose handler doesn't
 * depend on the parent `node.type` (extends-like wrappers, generic
 * implements wrappers, plus per-grammar shapes that uniquely identify
 * via their own kind: Go field_declaration, Rust trait_bounds, etc).
 *
 * Container kinds (`class_heritage`, `field_declaration_list`),
 * Python `argument_list` (only meaningful inside class_definition),
 * and the JS bare-identifier case (only inside class_heritage) need
 * the parent context so they stay inline below.
 */
const INHERITANCE_HANDLERS: Record<string, (e: TreeSitterExtractor, c: SyntaxNode, cid: string) => void> = {
  extends_clause: extractGenericExtendsClause,
  superclass: extractGenericExtendsClause,
  base_clause: extractGenericExtendsClause, // PHP class extends
  extends_interfaces: extractGenericExtendsClause, // Java interface extends
  // F#45 (2026-05-26): TS `interface Dog extends Animal[, Mammal]` parses
  // as `interface_declaration > extends_type_clause > type_identifier[, …]`
  // — the supertypes are DIRECT children of extends_type_clause (no
  // `type_list` wrapper, unlike Java). The generic handler's fallback
  // `[child.namedChild(0)]` would only emit the FIRST supertype on
  // multi-extends interfaces; the dedicated handler walks every named
  // child to catch all of them. Pre-fix: vue-core had 292 interfaces
  // but 4 extends edges; the 131 `interface X extends Y` patterns in
  // the codebase were silently dropped.
  extends_type_clause: extractExtendsTypeClause,
  implements_clause: extractGenericImplementsClause,
  class_interface_clause: extractGenericImplementsClause,
  super_interfaces: extractGenericImplementsClause, // Java class implements
  interfaces: extractGenericImplementsClause, // Dart
  constraint_elem: extractGoConstraintEmbed,
  field_declaration: extractGoEmbeddedField,
  trait_bounds: extractRustTraitBounds,
  base_list: extractCSharpBaseList,
  delegation_specifier: extractKotlinDelegation,
  inheritance_specifier: extractSwiftInheritance,
  // F#65 — Objective-C `@interface MyClass : NSObject <ProtoA, ProtoB>`
  // parses as `class_interface > superclass > type_identifier` AND
  // `class_interface > parameterized_arguments > type_descriptor > type_identifier`
  // for each protocol. `superclass` is already handled above (generic
  // extends); the protocol list goes through this dedicated handler.
  parameterized_arguments: extractObjcProtocolList,
};

/** Emit `implements` refs for every protocol named in an ObjC
 *  `parameterized_arguments` list. Each named child is a
 *  `type_descriptor` wrapping a `type_identifier` (or sometimes an
 *  identifier directly). */
function extractObjcProtocolList(extractor: TreeSitterExtractor, node: SyntaxNode, classId: string): void {
  for (const arg of node.namedChildren) {
    const typeId = arg.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier');
    if (!typeId) continue;
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(typeId, extractor.source),
      kind: 'implements',
      posNode: typeId,
    });
  }
}

/** Per-language fan-out — recurses into class_heritage / field_declaration_list containers. */
export function extractInheritance(extractor: TreeSitterExtractor, node: SyntaxNode, classId: string): void {
  // F#65 — Objective-C `@interface MyClass : NSObject <ProtoA, ProtoB>`
  // parses through tree-sitter-objc as:
  //   class_interface
  //     identifier (MyClass)              <- class name (consumed by extractName)
  //     parameterized_arguments?          <- lightweight generics, OPTIONAL
  //     identifier? (NSObject)            <- superclass, OPTIONAL
  //     parameterized_arguments?          <- protocol list, OPTIONAL
  //     ... methods / properties / ivars  <- not inheritance
  //
  // There's no `superclass` field, so the generic dispatcher's
  // `superclass`-key path doesn't fire. Two grammar quirks must be
  // bounded explicitly:
  //
  // F#70 (2026-05-28) — bound `extends` emission to exactly one
  // identifier. ObjC has at most one superclass; the previous "treat
  // any identifier after the first as superclass" loop would emit
  // duplicate `extends` refs on any future grammar shape that surfaced
  // a stray identifier in this position. Use `identifiers[1]` so the
  // count is type-level capped.
  //
  // F#70 (2026-05-28, follow-on) — lightweight generics
  // (`@interface MyMap<K, V> : NSObject <NSCopying>`) use the SAME
  // `parameterized_arguments` node kind as the protocol list. When
  // both are present, the generics come FIRST (before the superclass
  // identifier) and the protocol list comes LAST. Picking the LAST
  // parameterized_arguments correctly emits only the protocols on
  // generic-typed classes — previously K + V were misclassified as
  // `implements` alongside the real protocols. Known residual: a
  // generic-only class without protocols (`@interface MyMap<K>` with
  // no super, no protocol list) still treats its lone
  // parameterized_arguments as protocols. That shape is rare in real
  // ObjC code and a clean fix would need column-position disambiguation
  // (generics attach without whitespace, protocols are space-separated);
  // deferred.
  if (node.type === 'class_interface') {
    const identifiers = node.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier');
    const superclass = identifiers[1];
    if (superclass) {
      pushInheritanceRef({
        extractor,
        classId,
        name: getNodeText(superclass, extractor.source),
        kind: 'extends',
        posNode: superclass,
      });
    }
    const paramArgs = node.namedChildren.filter((c: SyntaxNode) => c.type === 'parameterized_arguments');
    const protocols = paramArgs[paramArgs.length - 1];
    if (protocols) {
      extractObjcProtocolList(extractor, protocols, classId);
    }
    return;
  }

  for (const child of node.namedChildren) {
    if (!child) continue;
    const handler = INHERITANCE_HANDLERS[child.type];
    if (handler) {
      handler(extractor, child, classId);
      continue;
    }
    // Python class def: `class Flask(Scaffold, Mixin):` — argument_list
    // is the supertype carrier only when the parent is class_definition.
    if (child.type === 'argument_list' && node.type === 'class_definition') {
      extractPythonSuperclasses(extractor, child, classId);
      continue;
    }
    // JS class_heritage > identifier: `class Foo extends Bar` →
    // class_heritage > identifier("Bar"), no extends_clause wrapper.
    if ((child.type === 'identifier' || child.type === 'type_identifier') && node.type === 'class_heritage') {
      pushInheritanceRef({
        extractor,
        classId,
        name: getNodeText(child, extractor.source),
        kind: 'extends',
        posNode: child,
      });
      continue;
    }
    // Container nodes — recurse to reach the inheritance children.
    if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
      extractInheritance(extractor, child, classId);
    }
  }
}

interface PushInheritanceRefArgs {
  extractor: TreeSitterExtractor;
  classId: string;
  name: string;
  kind: 'extends' | 'implements';
  /** Source-position node — only its `startPosition` is used (line/column on the ref). */
  posNode: SyntaxNode;
}

/** Append an inheritance unresolved-reference (extends or implements). */
function pushInheritanceRef(args: PushInheritanceRefArgs): void {
  const { extractor, classId, name, kind, posNode } = args;
  extractor.unresolvedReferences.push({
    fromNodeId: classId,
    referenceName: name,
    referenceKind: kind,
    line: posNode.startPosition.row + 1,
    column: posNode.startPosition.column,
  });
}

function extractGenericExtendsClause(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  // Java wraps multiple targets in type_list: superclass → type_identifier,
  // extends_interfaces → type_list → type_identifier.
  const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
  const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
  for (const target of targets) {
    if (target)
      pushInheritanceRef({
        extractor,
        classId,
        name: getNodeText(target, extractor.source),
        kind: 'extends',
        posNode: target,
      });
  }
}

/**
 * F#45 (2026-05-26): TS `extends_type_clause` carries supertype
 * `type_identifier` nodes (or `generic_type` wrappers) DIRECTLY as
 * named children — no `type_list` between. Walking every named child
 * catches the multi-extends case `interface Cat extends Animal, Mammal`
 * which the generic handler's `[namedChild(0)]` fallback would
 * truncate to one. Generic shapes (`extends Map<K, V>`) emit the bare
 * head-identifier — the resolver matches by name. Implementing types
 * with leading `extends` keyword anonymous tokens are filtered by the
 * `namedChildren`-only walk.
 */
function extractExtendsTypeClause(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  for (const target of child.namedChildren) {
    if (!target) continue;
    // For `extends Foo<Bar>`, the named child is `generic_type` whose
    // first `type_identifier` carries the head. The generic handler's
    // Rust path already does this dance; mirror it here.
    let nameNode: SyntaxNode = target;
    if (target.type === 'generic_type') {
      const head = target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (head) nameNode = head;
    }
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(nameNode, extractor.source),
      kind: 'extends',
      posNode: nameNode,
    });
  }
}

function extractGenericImplementsClause(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
  const targets = typeList ? typeList.namedChildren : child.namedChildren;
  for (const iface of targets) {
    if (iface)
      pushInheritanceRef({
        extractor,
        classId,
        name: getNodeText(iface, extractor.source),
        kind: 'implements',
        posNode: iface,
      });
  }
}

/**
 * Canonical Python superclass names that mean "interface contract"
 * rather than "inherited implementation" — F#26 slice 3 (2026-05-26).
 *
 * - `Protocol` (typing.Protocol) — PEP 544 structural typing; a class
 *   inheriting from Protocol declares a callable/attribute contract.
 * - `ABC` (abc.ABC) — abstract base class; concrete subclasses
 *   implement the abstract methods.
 * - `ABCMeta` — the metaclass equivalent; less common but seen on
 *   classes that use `class Foo(metaclass=ABCMeta)`.
 *
 * Name-matched against the supertype's terminal identifier text, so
 * both bare `Protocol` and qualified `typing.Protocol` /
 * `abc.ABC` route through `attribute` nodes whose own text ends in
 * one of these tokens. Conservative on purpose — only the three
 * canonical interface markers; user-defined ABC subclasses still
 * emit `extends` since cartograph can't structurally tell them
 * apart from regular class inheritance at extraction time.
 *
 * `Generic[T]` is excluded because Generic is a parameterization
 * helper, not an interface contract — the class IS the
 * implementation, not a consumer of one.
 */
const PYTHON_IMPLEMENTS_BASES: ReadonlySet<string> = new Set(['Protocol', 'ABC', 'ABCMeta']);

function extractPythonSuperclasses(extractor: TreeSitterExtractor, argList: SyntaxNode, classId: string): void {
  for (const arg of argList.namedChildren) {
    if (arg.type !== 'identifier' && arg.type !== 'attribute') continue;
    const name = getNodeText(arg, extractor.source);
    // For an `attribute` like `typing.Protocol`, match the terminal
    // identifier — the part after the last dot — so a qualified
    // import still discriminates correctly.
    const terminal = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    const kind: 'extends' | 'implements' = PYTHON_IMPLEMENTS_BASES.has(terminal) ? 'implements' : 'extends';
    pushInheritanceRef({
      extractor,
      classId,
      name,
      kind,
      posNode: arg,
    });
  }
}

/** Go interface embedding: `type Querier interface { LabelQuerier; ... }`. */
function extractGoConstraintEmbed(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (typeId)
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(typeId, extractor.source),
      kind: 'extends',
      posNode: typeId,
    });
}

/**
 * Go struct embedding: field_declaration without a field_identifier.
 * e.g. `type DB struct { *Head; Queryable }` — no field name means
 * embedded type.
 *
 * subtreeContainsType is recursive so C/C++ pointer-declared fields
 * (`Box* items;` — field_identifier nested under pointer_declarator)
 * are correctly identified as named fields rather than misclassified
 * as embeddings (which would produce spurious `extends` edges).
 */
function extractGoEmbeddedField(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  if (subtreeContainsType(child, 'field_identifier')) return;
  // Bare `*Options` / `Options` — the `*` is collapsed by the grammar
  // so a direct `type_identifier` child covers both pointer and value
  // embedded same-package types.
  const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (typeId) {
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(typeId, extractor.source),
      kind: 'extends',
      posNode: typeId,
    });
    return;
  }
  // Qualified `model.Base` / `*tokenizer.Tokenizer` — wrapped in a
  // `qualified_type` whose `type_identifier` child names the embedded
  // target. The package qualifier is stripped because the resolver
  // matches by bare name (it walks files / preferred-dirs to find the
  // right same-named target). Without this branch, every qualified
  // cross-package embed was silently dropped — the dominant FN3 case
  // from the ollama bug-hunt (model.Base / tokenizer.Tokenizer).
  const qualified = child.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_type');
  if (qualified) {
    const innerTypeId = qualified.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    if (innerTypeId) {
      pushInheritanceRef({
        extractor,
        classId,
        name: getNodeText(innerTypeId, extractor.source),
        kind: 'extends',
        posNode: innerTypeId,
      });
    }
  }
}

/**
 * Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`.
 * Bound children may be type_identifier, generic_type, or
 * higher_ranked_trait_bound.
 */
function extractRustTraitBounds(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  for (const bound of child.namedChildren) {
    const resolved = resolveRustBoundType(bound);
    if (!resolved) continue;
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(resolved, extractor.source),
      kind: 'extends',
      posNode: resolved,
    });
  }
}

/** Resolve a single Rust trait-bound child to the `type_identifier`
 *  AST node naming the trait. Three shapes per the grammar: a bare
 *  `type_identifier`, a `generic_type` wrapping one, or a
 *  `higher_ranked_trait_bound` wrapping a generic_type or a bare
 *  type_identifier. Returns null when the shape doesn't match — the
 *  caller skips bounds it can't name. Pulled out so
 *  {@link extractRustTraitBounds} doesn't carry an else-if cascade
 *  with branch-local destructuring under the for-loop. */
function resolveRustBoundType(bound: SyntaxNode): SyntaxNode | null {
  if (bound.type === 'type_identifier') return bound;
  if (bound.type === 'generic_type') {
    return bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? null;
  }
  if (bound.type === 'higher_ranked_trait_bound') {
    const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
    const typeId =
      generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ??
      bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    return typeId ?? null;
  }
  return null;
}

/**
 * C# colon-separated base_list combines base class and interfaces.
 * Emit all as 'extends' since the syntax doesn't distinguish them.
 */
function extractCSharpBaseList(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  for (const baseType of child.namedChildren) {
    if (!baseType) continue;
    const name =
      baseType.type === 'generic_name'
        ? getNodeText(
            baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType,
            extractor.source,
          )
        : getNodeText(baseType, extractor.source);
    pushInheritanceRef({ extractor, classId, name, kind: 'extends', posNode: baseType });
  }
}

/**
 * Kotlin: `class Foo : Bar, Baz` → delegation_specifier > user_type
 * > type_identifier. Also handles `class Foo : Bar()` →
 * delegation_specifier > constructor_invocation > user_type.
 */
function extractKotlinDelegation(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
  const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
  const target = userType ?? constructorInvocation;
  if (!target) return;
  const typeId = resolveKotlinDelegationTypeId(target);
  pushInheritanceRef({
    extractor,
    classId,
    name: getNodeText(typeId, extractor.source),
    kind: 'extends',
    posNode: typeId,
  });
}

/**
 * Drill down to the most specific `type_identifier` carried by a
 * Kotlin delegation `user_type` or `constructor_invocation` target.
 * Three layers, falling through on each miss: type_identifier child
 * of user_type → type_identifier inside a wrapping user_type → the
 * outer user_type itself → the input target node. The last fallback
 * is a defensive guarantee — pushInheritanceRef requires a real node.
 */
function resolveKotlinDelegationTypeId(target: SyntaxNode): SyntaxNode {
  if (target.type === 'user_type') {
    const direct = target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    return direct ?? target;
  }
  // constructor_invocation: `class Foo : Bar()` — drill through the
  // wrapping user_type to find the type_identifier underneath.
  const wrappingUserType = target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
  const nested = wrappingUserType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  return nested ?? wrappingUserType ?? target;
}

/**
 * Swift: inheritance_specifier > user_type > type_identifier — covers
 * class inheritance, protocol conformance, and protocol inheritance.
 */
function extractSwiftInheritance(extractor: TreeSitterExtractor, child: SyntaxNode, classId: string): void {
  const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
  const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (typeId)
    pushInheritanceRef({
      extractor,
      classId,
      name: getNodeText(typeId, extractor.source),
      kind: 'extends',
      posNode: typeId,
    });
}

/**
 * Rust `impl Trait for Type` — creates an `implements` edge from
 * `Type` to `Trait`. For plain `impl Type { ... }` (no trait), no
 * inheritance edge is needed.
 */
export function extractRustImplItem(extractor: TreeSitterExtractor, node: SyntaxNode): void {
  const hasFor = node.children.some((c: SyntaxNode) => c.type === 'for' && !c.isNamed);
  if (!hasFor) return;

  // In `impl Trait for Type`, the type_identifiers are:
  //   first = Trait name, last = implementing Type name.
  // Also handles generic types like `impl<T> Trait for MyStruct<T>`.
  const typeIdents = node.namedChildren.filter(
    (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier',
  );
  if (typeIdents.length < 2) return;

  const traitNode = typeIdents[0]!;
  const typeNode = typeIdents[typeIdents.length - 1]!;

  // Trait name (handles scoped paths like std::fmt::Display).
  const traitName =
    traitNode.type === 'scoped_type_identifier'
      ? extractor.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, extractor.source);

  // Implementing type name (extract inner type_identifier for generics).
  let typeName: string;
  if (typeNode.type === 'generic_type') {
    const inner = typeNode.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    typeName = inner ? getNodeText(inner, extractor.source) : getNodeText(typeNode, extractor.source);
  } else {
    typeName = getNodeText(typeNode, extractor.source);
  }

  const typeNodeId = findStructLikeNodeIdByName(extractor, typeName);
  if (typeNodeId) {
    extractor.unresolvedReferences.push({
      fromNodeId: typeNodeId,
      referenceName: traitName,
      referenceKind: 'implements',
      line: traitNode.startPosition.row + 1,
      column: traitNode.startPosition.column,
    });
  }
}

/**
 * Find a previously-extracted struct / enum / class node by name.
 * Used by `extractRustImplItem` to resolve `impl Trait for Type` —
 * the implementing `Type` was emitted earlier and lives in the
 * extractor's `nodes` array.
 */
function findStructLikeNodeIdByName(extractor: TreeSitterExtractor, name: string): string | undefined {
  for (const node of extractor.nodes) {
    if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
      return node.id;
    }
  }
  return undefined;
}
