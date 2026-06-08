import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function hlslFunctionSignature(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  const params = declarator ? getChildByField(declarator, 'parameters') : null;
  if (!params) return undefined;
  const returnType = getChildByField(node, 'type');
  const paramsText = getNodeText(params, source);
  return returnType ? `${getNodeText(returnType, source)} ${paramsText}` : paramsText;
}

const hlslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: hlslFunctionSignature,
};

export const HLSL_DEF: LanguageDef = {
  name: 'hlsl',
  displayName: 'HLSL',
  extensions: ['.hlsl', '.hlsli', '.fx', '.fxh'],
  includeGlobs: ['**/*.hlsl', '**/*.hlsli', '**/*.fx', '**/*.fxh'],
  grammar: { wasmFile: 'hlsl.wasm', extractor: hlslExtractor },
};
