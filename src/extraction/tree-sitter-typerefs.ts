/**
 * Type-reference extraction helpers.
 *
 * Walks an arbitrary subtree (return-type annotations, parameter
 * lists, field types, etc.) and emits unresolved `type_of` /
 * `returns` / `references` edges for every type identifier it
 * finds. Per-language quirks (Pascal's `typeref`, Python's `type`
 * wrapper, C#'s `qualified_name` / `generic_name`, PHP's
 * `named_type`, TypeScript's inline `import('…').Foo`) are handled
 * by short-circuit branches inside the dispatcher; the generic
 * recursion handles everything else.
 *
 * Extracted from `TreeSitterExtractor` so the main class doesn't
 * carry 6 type-ref-only methods on top of its language-agnostic
 * orchestration. The functions use the extractor's @internal
 * fields (`source`, `language`, `unresolvedReferences`) directly.
 *
 * Built-in / primitive type names are filtered up-front so a
 * field annotated `cache: dict[str, Foo]` emits a single
 * `type_of → Foo` instead of one for every wrapper.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from './tree-sitter-helpers.js';
import type { TreeSitterExtractor } from './tree-sitter.js';

/** Built-in / primitive type names that shouldn't create references. */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'void',
  'null',
  'undefined',
  'never',
  'any',
  'unknown',
  'object',
  'symbol',
  'bigint',
  'true',
  'false',
  // Rust
  'str',
  'bool',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
  'f32',
  'f64',
  'char',
  // Java / C#
  'int',
  'long',
  'short',
  'byte',
  'float',
  'double',
  'char',
  // Go
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'rune',
  'error',
  // Python — built-in collection / scalar types so `cache: dict[str, Foo]`
  // emits a single `type_of -> Foo` instead of one for every wrapper.
  'int',
  'float',
  'complex',
  'bool',
  'bytes',
  'bytearray',
  'list',
  'tuple',
  'dict',
  'set',
  'frozenset',
  'range',
  'None',
  'type',
  'Any',
  'Optional',
  'Union',
  'Callable',
  // PHP type hints not covered by the above shared primitives.
  'mixed',
  'callable',
  'iterable',
  'static',
  'self',
  'parent',
  'resource',
  'never',
  // Pascal scalar types so `var i: Integer` doesn't generate noise.
  'Integer',
  'Boolean',
  'String',
  'Char',
  'Real',
  'Single',
  'Double',
  'Word',
  'Byte',
  'LongInt',
  'Cardinal',
  'Pointer',
]);

type TypeRefKind = 'type_of' | 'returns' | 'references';

/** TS/JS family — shares the `member_expression` import-type shape. */
const TS_JS_LANGS: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * Shared context threaded through type-ref extraction helpers.
 * Bundles the four values every helper needs so they can take a
 * single `ctx` parameter instead of four positional args.
 */
interface TypeRefCtx {
  extractor: TreeSitterExtractor;
  node: SyntaxNode;
  fromNodeId: string;
  kind: TypeRefKind;
}

/** Languages whose typeref dispatch fires on `(generic_name | qualified_name | named_type)`. */
function isCsharpQualifiedTypeNode(language: string, nodeType: string): boolean {
  return language === 'csharp' && (nodeType === 'generic_name' || nodeType === 'qualified_name');
}

function isPhpNamedTypeNode(language: string, nodeType: string): boolean {
  return language === 'php' && nodeType === 'named_type';
}

/**
 * Check if a language-specific handler can process this node.
 * Returns true if fully handled (no further recursion needed), false otherwise.
 */
function tryLanguageSpecificHandler(ctx: TypeRefCtx): boolean {
  const { extractor, node } = ctx;
  // Pascal typeref
  if (node.type === 'typeref' && extractor.language === 'pascal') {
    return handlePascalTyperef(ctx);
  }

  // TS/JS import type refs
  if (node.type === 'member_expression' && TS_JS_LANGS.has(extractor.language)) {
    return handleTSImportTypeRef(ctx);
  }

  // Python type wrapper
  if (node.type === 'type' && extractor.language === 'python') {
    handlePythonTypeWrapper(ctx);
    return true;
  }

  // C# / PHP qualified types
  if (isCsharpQualifiedTypeNode(extractor.language, node.type) || isPhpNamedTypeNode(extractor.language, node.type)) {
    handleCSharpPhpNamedType(ctx);
    return true;
  }

  return false;
}

/**
 * Walk a subtree emitting type-of / returns / references edges
 * for each type identifier encountered. Per-language wrappers
 * short-circuit common shapes; the generic tail recurses into
 * named children (handles `union_type`, `intersection_type`,
 * `generic_type`, etc.).
 */
interface ExtractTypeRefsArgs {
  extractor: TreeSitterExtractor;
  node: SyntaxNode;
  fromNodeId: string;
  kind?: TypeRefKind;
}

export function extractTypeRefsFromSubtree(args: ExtractTypeRefsArgs): void {
  const { extractor, node, fromNodeId, kind = 'type_of' } = args;
  const ctx: TypeRefCtx = { extractor, node, fromNodeId, kind };
  extractTypeRefsFromCtx(ctx);
}

/** Inner implementation that operates on a pre-built context. */
function extractTypeRefsFromCtx(ctx: TypeRefCtx): void {
  const { extractor, node, fromNodeId, kind } = ctx;
  // type_identifier is a leaf — emit and stop.
  if (node.type === 'type_identifier') {
    pushTypeRef({ extractor, fromNodeId, name: getNodeText(node, extractor.source), kind, posNode: node });
    return;
  }

  // Try language-specific handlers first
  if (tryLanguageSpecificHandler(ctx)) {
    return;
  }

  // Generic recursion into named children
  for (const child of node.namedChildren) {
    if (child) extractTypeRefsFromCtx({ extractor, node: child, fromNodeId, kind });
  }
}

interface PushTypeRefArgs {
  extractor: TreeSitterExtractor;
  fromNodeId: string;
  name: string;
  kind: TypeRefKind;
  /** Source-position node — only its `startPosition` is used (line/column on the ref). */
  posNode: SyntaxNode;
}

/** Append a type-reference unless the name is empty or a known built-in. */
function pushTypeRef(args: PushTypeRefArgs): void {
  const { extractor, fromNodeId, name, kind, posNode } = args;
  if (!name || BUILTIN_TYPES.has(name)) return;
  extractor.unresolvedReferences.push({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: posNode.startPosition.row + 1,
    column: posNode.startPosition.column,
  });
}

/**
 * Pascal uses `typeref` as the leaf token for type names (no
 * `type_identifier` in its grammar). Currently `typeref` is
 * always a leaf, but if a future grammar revision adds children
 * (e.g. for qualified unit-prefixed types like `MyUnit.MyType`),
 * the caller falls through to generic recursion so nested
 * identifiers aren't silently dropped.
 *
 * Returns true if fully handled, false if the caller should keep
 * recursing.
 */
function handlePascalTyperef(ctx: TypeRefCtx): boolean {
  const { extractor, node, fromNodeId, kind } = ctx;
  pushTypeRef({ extractor, fromNodeId, name: getNodeText(node, extractor.source).trim(), kind, posNode: node });
  return node.namedChildCount === 0;
}

/**
 * TypeScript inline import-type: `import('…').FreshnessInfo`.
 * Parses as `member_expression(call_expression('import',…),
 * property_identifier('FreshnessInfo'))`. The rightmost
 * property_identifier IS the type name. Without this, the walker
 * would descend into the call_expression, find no
 * type_identifier, and drop the edge entirely.
 */
function handleTSImportTypeRef(ctx: TypeRefCtx): boolean {
  const { extractor, node, fromNodeId, kind } = ctx;
  const obj = getChildByField(node, 'object') ?? node.namedChild(0);
  const prop = getChildByField(node, 'property') ?? node.namedChild(1);
  const looksLikeImportType =
    obj?.type === 'call_expression' && obj.namedChildren.some((c: SyntaxNode) => c.type === 'import');
  if (!looksLikeImportType || prop?.type !== 'property_identifier') return false;
  pushTypeRef({ extractor, fromNodeId, name: getNodeText(prop, extractor.source), kind, posNode: prop });
  return true;
}

/**
 * Python's tree-sitter grammar wraps a plain `identifier` in a
 * `type` node rather than using the `type_identifier` token most
 * languages share. Treat direct identifier children as type
 * names; recurse into other children (e.g. `list[Foo]`,
 * `dict[str, Bar]`) so nested identifiers also produce edges.
 */
function handlePythonTypeWrapper(ctx: TypeRefCtx): void {
  const { extractor, node, fromNodeId, kind } = ctx;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier') {
      pushTypeRef({ extractor, fromNodeId, name: getNodeText(child, extractor.source), kind, posNode: child });
    } else {
      extractTypeRefsFromCtx({ extractor, node: child, fromNodeId, kind });
    }
  }
}

/**
 * C# uses `generic_name` and `qualified_name` wrappers around
 * plain `identifier` tokens; PHP uses `named_type`. For
 * `qualified_name` (`System.Foo`) the LAST identifier is the
 * type name; for `generic_name` / `named_type` (`Box<T>`) the
 * FIRST identifier is the type. Recurse into non-identifier
 * children so `Box<Bar>` produces edges to both `Box` and `Bar`.
 */
function handleCSharpPhpNamedType(ctx: TypeRefCtx): void {
  const { extractor, node, fromNodeId, kind } = ctx;
  const isQualified = node.type === 'qualified_name';
  const idChildren: SyntaxNode[] = [];
  const otherChildren: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'name') {
      idChildren.push(child);
    } else {
      otherChildren.push(child);
    }
  }
  const lastIdChild = idChildren[idChildren.length - 1] ?? null;
  const firstIdChild = idChildren[0] ?? null;
  const emitNode = isQualified ? lastIdChild : firstIdChild;
  if (emitNode) {
    pushTypeRef({ extractor, fromNodeId, name: getNodeText(emitNode, extractor.source), kind, posNode: emitNode });
  }
  for (const c of otherChildren) {
    extractTypeRefsFromCtx({ extractor, node: c, fromNodeId, kind });
  }
}
