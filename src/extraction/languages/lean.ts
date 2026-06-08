import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function leanImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
  const nameNode = node.childForFieldName('name') ?? node.namedChildren.find((child) => child.type === 'identifier');
  if (!nameNode) return null;
  return { moduleName: getNodeText(nameNode, source), signature: getNodeText(node, source).trim() };
}

function leanBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
  const standard = node.childForFieldName(bodyField);
  if (standard) return standard;
  if (node.type === 'structure' || node.type === 'inductive') return node;
  return null;
}

const leanExtractor: LanguageExtractor = {
  functionTypes: ['def', 'theorem'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['structure'],
  enumTypes: ['inductive'],
  enumMemberTypes: ['ctor_alt'],
  typeAliasTypes: ['abbrev'],
  importTypes: ['import'],
  callTypes: [],
  variableTypes: [],
  fieldTypes: ['field'],
  extractImport: leanImport,
  resolveBody: leanBody,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'binders',
  returnField: 'type',
};

export const LEAN_DEF: LanguageDef = {
  name: 'lean',
  displayName: 'Lean',
  extensions: ['.lean'],
  includeGlobs: ['**/*.lean'],
  grammar: { wasmFile: 'lean.wasm', extractor: leanExtractor },
};
