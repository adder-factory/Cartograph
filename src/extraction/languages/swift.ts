import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import { compact } from '../../utils.js';

const swiftExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: [], // property_declaration/constant_declaration handled in visitNode (need to skip computed properties)
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  visitNode: (node, ctx) => {
    // Handle Swift property_declaration (let/var stored properties).
    // Computed properties (those with a `computed_property` child) are skipped —
    // they have a getter/setter body and are method-like, not data members.
    if (node.type !== 'property_declaration' && node.type !== 'constant_declaration') return false;

    // Skip computed properties (var foo: T { ... })
    const hasComputedBody = node.namedChildren.some((c: SyntaxNode) => c.type === 'computed_property');
    if (hasComputedBody) return false;

    // Name is in the `pattern` field child (field="name") → simple_identifier (field="bound_identifier")
    // getNodeText on the pattern node returns the raw variable name.
    const patternNode = node.childForFieldName('name');
    if (!patternNode) return false;
    const name = getNodeText(patternNode, ctx.source);
    if (!name) return false;

    const isInClass =
      ctx.nodeStack.length > 0 &&
      (() => {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        const parentNode = ctx.nodes.find((n) => n.id === parentId);
        return (
          parentNode != null &&
          (parentNode.kind === 'class' ||
            parentNode.kind === 'struct' ||
            parentNode.kind === 'interface' ||
            parentNode.kind === 'trait' ||
            parentNode.kind === 'enum' ||
            parentNode.kind === 'module')
        );
      })();

    // Extract type annotation text if present (`: Type`)
    const typeAnnotation = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_annotation');
    const typeText = typeAnnotation ? getNodeText(typeAnnotation, ctx.source).replace(/^:\s*/, '') : undefined;

    // Extract visibility
    const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
    const modText = modifiers?.text ?? '';
    const visibility = modText.includes('public')
      ? ('public' as const)
      : modText.includes('private') || modText.includes('fileprivate')
        ? ('private' as const)
        : modText.includes('internal')
          ? ('internal' as const)
          : ('internal' as const); // Swift defaults to internal

    const isLet = node.namedChildren.some((c: SyntaxNode) => c.type === 'value_binding_pattern' && c.text === 'let');
    const keyword = node.type === 'constant_declaration' || isLet ? 'let' : 'var';
    const sig = typeText ? `${keyword} ${name}: ${typeText}` : `${keyword} ${name}`;

    if (isInClass) {
      ctx.createNode({ kind: 'field', name, node, extra: compact({ signature: sig, visibility }) });
    } else {
      // Top-level: keep as constant (let) or variable (var)
      ctx.createNode({
        kind: keyword === 'let' ? 'constant' : 'variable',
        name,
        node,
        extra: compact({ signature: sig }),
      });
    }
    return true;
  },

  getSignature: (node, source) => {
    // Swift function signature: func name(params) -> ReturnType
    const params = getChildByField(node, 'parameter');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Swift
    for (const child of node.children) {
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('internal')) return 'internal';
        if (text.includes('fileprivate')) return 'private';
      }
    }
    return 'internal'; // Swift defaults to internal
  },
  isStatic: (node) => {
    for (const child of node.children) {
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true;
        }
      }
    }
    return false;
  },
  classifyClassNode: (node) => {
    // Swift uses class_declaration for classes, structs, and enums
    for (const child of node.children) {
      if (child?.type === 'struct') return 'struct';
      if (child?.type === 'enum') return 'enum';
    }
    return 'class';
  },
  isAsync: (node) => {
    for (const child of node.children) {
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};

import type { LanguageDef } from './types.js';
export const SWIFT_DEF: LanguageDef = {
  name: 'swift',
  displayName: 'Swift',
  extensions: ['.swift'],
  includeGlobs: ['**/*.swift'],
  grammar: { wasmFile: 'swift.wasm', extractor: swiftExtractor },
};
