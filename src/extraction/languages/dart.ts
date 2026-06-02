import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import { compact } from '../../utils.js';

function isClassLikeKind(kind: string): boolean {
  return (
    kind === 'class' ||
    kind === 'struct' ||
    kind === 'interface' ||
    kind === 'trait' ||
    kind === 'enum' ||
    kind === 'module'
  );
}

function isCurrentScopeClassLike(ctx: ExtractorContext): boolean {
  if (ctx.nodeStack.length === 0) return false;
  const parentId = ctx.nodeStack.at(-1);
  const parentNode = ctx.nodes.find((n) => n.id === parentId);
  return parentNode != null && isClassLikeKind(parentNode.kind);
}

function isStaticDeclaration(node: SyntaxNode): boolean {
  return node.children.some((child: SyntaxNode) => child?.type === 'static');
}

function firstNamedChildOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((c: SyntaxNode) => c.type === type);
}

function dartUriFromConfigurableUri(configurableUri: SyntaxNode, source: string): string | null {
  const uri = firstNamedChildOfType(configurableUri, 'uri');
  const stringLiteral = uri ? firstNamedChildOfType(uri, 'string_literal') : undefined;
  return stringLiteral ? getNodeText(stringLiteral, source).replaceAll(/['"]/g, '') : null;
}

function dartImportModuleName(node: SyntaxNode, source: string): string | null {
  const libraryImport = firstNamedChildOfType(node, 'library_import');
  if (libraryImport) {
    const importSpec = firstNamedChildOfType(libraryImport, 'import_specification');
    const configurableUri = importSpec ? firstNamedChildOfType(importSpec, 'configurable_uri') : undefined;
    if (configurableUri) return dartUriFromConfigurableUri(configurableUri, source);
  }

  const libraryExport = firstNamedChildOfType(node, 'library_export');
  const configurableUri = libraryExport ? firstNamedChildOfType(libraryExport, 'configurable_uri') : undefined;
  return configurableUri ? dartUriFromConfigurableUri(configurableUri, source) : null;
}

function hasArgumentPart(node: SyntaxNode): boolean {
  return node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part');
}

function dartAccessorMethodName(node: SyntaxNode): string | null {
  const accessor = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector',
  );
  const methodId = accessor?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  if (!methodId) return null;
  const accessorPrev = node.previousNamedSibling;
  return accessorPrev?.type === 'identifier' ? accessorPrev.text + '.' + methodId.text : methodId.text;
}

function dartSelectorCallName(prev: SyntaxNode): string | undefined {
  if (prev.type === 'identifier') return prev.text;
  if (prev.type === 'selector') return dartAccessorMethodName(prev) ?? undefined;
  if (prev.type === 'unconditional_assignable_selector' || prev.type === 'conditional_assignable_selector') {
    return prev.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')?.text;
  }
  return undefined;
}

const dartExtractor: LanguageExtractor = {
  functionTypes: ['function_signature'],
  classTypes: ['class_definition'],
  methodTypes: ['method_signature'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_or_export'],
  callTypes: [], // Dart calls use identifier+selector, handled via extractBareCall
  variableTypes: [],
  extraClassNodeTypes: ['mixin_declaration', 'extension_declaration'],
  resolveBody: (node, bodyField) => {
    // Dart: function_body is a next sibling of function_signature/method_signature
    if (node.type === 'function_signature' || node.type === 'method_signature') {
      const next = node.nextNamedSibling;
      if (next?.type === 'function_body') return next;
      return null;
    }
    // For class/mixin/extension: try standard field, then class_body/extension_body
    const standard = node.childForFieldName(bodyField);
    if (standard) return standard;
    return node.namedChildren.find((c: SyntaxNode) => c.type === 'class_body' || c.type === 'extension_body') || null;
  },
  visitNode: (node, ctx) => {
    // Handle Dart instance field declarations (`declaration` nodes inside class/mixin/extension bodies).
    // Dart's grammar uses `declaration` for class-member variable declarations:
    //   Type name = init;  →  declaration > type_identifier + initialized_identifier_list
    // The name(s) live inside initialized_identifier_list > initialized_identifier > identifier.
    // Top-level Dart variables do NOT use the `declaration` wrapper and are handled elsewhere.
    if (node.type !== 'declaration') return false;

    // Only extract as fields when inside a class-like parent
    if (!isCurrentScopeClassLike(ctx)) return false;

    const idList = firstNamedChildOfType(node, 'initialized_identifier_list');
    if (!idList) return false;

    const idNodes = idList.namedChildren.filter((c: SyntaxNode) => c.type === 'initialized_identifier');
    if (idNodes.length === 0) return false;

    // Detect static: `static` is an anonymous (non-named) child of declaration
    const isStatic = isStaticDeclaration(node);

    // Type text (first type_identifier child of declaration, skipping modifiers)
    const typeNode = firstNamedChildOfType(node, 'type_identifier');
    const typeText = typeNode ? getNodeText(typeNode, ctx.source) : undefined;

    for (const idNode of idNodes) {
      const identNode = idNode.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (!identNode) continue;
      const name = getNodeText(identNode, ctx.source);
      const visibility = name.startsWith('_') ? ('private' as const) : ('public' as const);
      const sig = typeText ? `${typeText} ${name}` : name;
      ctx.createNode({ kind: 'field', name, node: idNode, extra: compact({ signature: sig, visibility, isStatic }) });
    }
    return true;
  },

  nameField: 'name',
  bodyField: 'body', // class_definition uses 'body' field
  paramsField: 'formal_parameter_list',
  returnField: 'type',
  getSignature: (node, source) => {
    // For function_signature: extract params + return type
    // For method_signature: delegate to inner function_signature
    let sig = node;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature',
      );
      if (inner) sig = inner;
    }
    const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list');
    const retType = sig.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'void_type');
    if (!params && !retType) return undefined;
    let result = '';
    if (retType) result += getNodeText(retType, source) + ' ';
    if (params) result += getNodeText(params, source);
    return result.trim() || undefined;
  },
  getVisibility: (node) => {
    // Dart convention: _ prefix means private, otherwise public
    let nameNode: SyntaxNode | null = null;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature',
      );
      if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null;
    } else {
      nameNode = node.childForFieldName('name');
    }
    if (nameNode?.text.startsWith('_')) return 'private';
    return 'public';
  },
  isAsync: (node) => {
    // In Dart, 'async' is on the function_body (next sibling), not the signature
    const nextSibling = node.nextNamedSibling;
    if (nextSibling?.type === 'function_body') {
      for (const child of nextSibling.children) {
        if (child?.type === 'async') return true;
      }
    }
    return false;
  },
  isStatic: (node) => {
    // For method_signature, check for 'static' child
    if (node.type === 'method_signature') {
      for (const child of node.children) {
        if (child?.type === 'static') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // Dart imports: import 'dart:async'; import 'package:foo/bar.dart' as bar;
    // Also handle exports: export 'src/foo.dart';
    const moduleName = dartImportModuleName(node, source);
    return moduleName ? { moduleName, signature: importText } : null;
  },
  extractBareCall: (node, _source) => {
    // Dart calls are: identifier + selector(argument_part), not a dedicated call node.
    // Match on selector nodes that contain argument_part.
    if (node.type === 'selector') {
      if (!hasArgumentPart(node)) return undefined;
      const prev = node.previousNamedSibling;
      return prev ? dartSelectorCallName(prev) : undefined;
    }

    // new MyWidget() — explicit constructor call
    if (node.type === 'new_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) return typeId.text;
      return undefined;
    }

    // const EdgeInsets.all(8.0) — const constructor call
    if (node.type === 'const_object_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (typeId && nameId) return typeId.text + '.' + nameId.text;
      if (typeId) return typeId.text;
      return undefined;
    }

    return undefined;
  },
};

import type { LanguageDef } from './types.js';
export const DART_DEF: LanguageDef = {
  name: 'dart',
  displayName: 'Dart',
  extensions: ['.dart'],
  includeGlobs: ['**/*.dart'],
  grammar: { wasmFile: 'dart.wasm', extractor: dartExtractor },
};
