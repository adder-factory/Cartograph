import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function abapName(node: SyntaxNode, source: string): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode ? getNodeText(nameNode, source).trim() : undefined;
}

function abapBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
  const standard = node.childForFieldName(bodyField);
  if (standard) return standard;
  return node.namedChildren.find((child) => child.type === 'method_body') ?? null;
}

const abapExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_implementation'],
  methodTypes: ['method_implementation'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  fieldTypes: [],
  resolveName: abapName,
  resolveBody: abapBody,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
};

export const ABAP_DEF: LanguageDef = {
  name: 'abap',
  displayName: 'ABAP',
  extensions: ['.abap'],
  includeGlobs: ['**/*.abap'],
  grammar: { wasmFile: 'abap.wasm', extractor: abapExtractor },
};
