import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

const CSHARP_TYPE_NODE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'predefined_type',
  'generic_name',
  'qualified_name',
  'nullable_type',
  'array_type',
  'tuple_type',
]);

function findDirectParameterList(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child: SyntaxNode) => child.type === 'parameter_list') ?? null;
}

function findCSharpReturnType(node: SyntaxNode, params: SyntaxNode): SyntaxNode | null {
  const nameNode = getChildByField(node, 'name');
  const paramsIdx = node.namedChildren.findIndex((child: SyntaxNode) => child.startIndex === params.startIndex);
  if (paramsIdx < 0) return null;
  for (let i = paramsIdx - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.startIndex === nameNode?.startIndex) continue;
    if (CSHARP_TYPE_NODE_TYPES.has(child.type)) return child;
  }
  return null;
}

function getCSharpSignature(node: SyntaxNode, source: string): string | undefined {
  const params = getChildByField(node, 'parameters') ?? findDirectParameterList(node);
  if (!params) return undefined;
  const paramsText = getNodeText(params, source);
  if (node.type !== 'method_declaration') return paramsText;
  const returnType = findCSharpReturnType(node, params);
  return returnType ? `${getNodeText(returnType, source)} ${paramsText}` : paramsText;
}

const csharpExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  importTypes: ['using_directive'],
  callTypes: ['invocation_expression'],
  variableTypes: ['local_declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter_list',
  getSignature: getCSharpSignature,
  getVisibility: (node) => {
    for (const child of node.children) {
      if (child?.type === 'modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
        if (text === 'internal') return 'internal';
      }
    }
    return 'private'; // C# defaults to private
  },
  isStatic: (node) => {
    for (const child of node.children) {
      if (child?.type === 'modifier' && child.text === 'static') {
        return true;
      }
    }
    return false;
  },
  isAsync: (node) => {
    for (const child of node.children) {
      if (child?.type === 'modifier' && child.text === 'async') {
        return true;
      }
    }
    return false;
  },
  extractClassLikeHeader: (node, ownerNode, ctx) => {
    if (node.type !== 'class_declaration' && node.type !== 'struct_declaration') return;
    const params = findDirectParameterList(node);
    if (!params) return;
    const signature = getNodeText(params, ctx.source);
    const constructorNode = ctx.createNode({
      kind: 'method',
      name: ownerNode.name,
      node: params,
      extra: ownerNode.visibility ? { signature, visibility: ownerNode.visibility } : { signature },
    });
    if (constructorNode) ctx.extractTypeRefs(params, constructorNode.id, 'type_of');
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C# using directives: using System, using System.Collections.Generic, using static X, using Alias = X
    const qualifiedName = node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
    if (qualifiedName) {
      return { moduleName: getNodeText(qualifiedName, source), signature: importText };
    }
    // Simple namespace like "using System;" - get the first identifier
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: getNodeText(identifier, source), signature: importText };
    }
    return null;
  },
};

import type { LanguageDef } from './types.js';
export const CSHARP_DEF: LanguageDef = {
  name: 'csharp',
  displayName: 'C#',
  extensions: ['.cs'],
  includeGlobs: ['**/*.cs'],
  grammar: { wasmFile: 'c_sharp.wasm', extractor: csharpExtractor },
};
