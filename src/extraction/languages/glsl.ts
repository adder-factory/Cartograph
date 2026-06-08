import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function glslFunctionSignature(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  const params = declarator ? getChildByField(declarator, 'parameters') : null;
  if (!params) return undefined;
  const returnType = getChildByField(node, 'type');
  const paramsText = getNodeText(params, source);
  return returnType ? `${getNodeText(returnType, source)} ${paramsText}` : paramsText;
}

const glslExtractor: LanguageExtractor = {
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
  getSignature: glslFunctionSignature,
};

export const GLSL_DEF: LanguageDef = {
  name: 'glsl',
  displayName: 'GLSL',
  extensions: ['.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese'],
  includeGlobs: ['**/*.glsl', '**/*.vert', '**/*.frag', '**/*.comp', '**/*.geom', '**/*.tesc', '**/*.tese'],
  grammar: { wasmFile: 'glsl.wasm', extractor: glslExtractor },
};
