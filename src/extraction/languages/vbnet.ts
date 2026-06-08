import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function vbnetImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
  const namespace = node.namedChildren.find((child) => child.type === 'namespace_name');
  if (!namespace) return null;
  return { moduleName: getNodeText(namespace, source), signature: getNodeText(node, source).trim() };
}

function vbnetVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' | 'internal' | undefined {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers')?.text.toLowerCase() ?? '';
  if (/\bprivate\b/.test(modifiers)) return 'private';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  if (/\bfriend\b/.test(modifiers)) return 'internal';
  if (/\bpublic\b/.test(modifiers)) return 'public';
  return undefined;
}

function vbnetIsStatic(node: SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers')?.text.toLowerCase() ?? '';
  return /\bshared\b/.test(modifiers);
}

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

const vbnetExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_block'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_block'],
  structTypes: ['structure_block'],
  enumTypes: ['enum_block'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: [],
  importTypes: ['imports_statement'],
  callTypes: ['invocation'],
  variableTypes: ['dim_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  extractImport: vbnetImport,
  getVisibility: vbnetVisibility,
  isStatic: vbnetIsStatic,
  getSignature: (node, source) => {
    const params = firstChildOfType(node, 'parameter_list');
    const typeNode = firstChildOfType(node, 'type');
    const parts = [
      params ? getNodeText(params, source) : undefined,
      typeNode ? `As ${getNodeText(typeNode, source)}` : undefined,
    ].filter(Boolean);
    return parts.length ? parts.join(' ') : undefined;
  },
};

export const VBNET_DEF: LanguageDef = {
  name: 'vbnet',
  displayName: 'VB.NET',
  extensions: ['.vb'],
  includeGlobs: ['**/*.vb'],
  grammar: { wasmFile: 'vbnet.wasm', extractor: vbnetExtractor },
};
