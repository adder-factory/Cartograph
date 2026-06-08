import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

function solidityFunctionSignature(node: SyntaxNode, source: string): string | undefined {
  const params = node.namedChildren.filter((child: SyntaxNode) => child.type === 'parameter');
  const paramsText = `(${params.map((param) => getNodeText(param, source)).join(', ')})`;
  const returnType = node.namedChildren.find((child: SyntaxNode) => child.type === 'return_type_definition');
  return returnType ? `${paramsText} ${getNodeText(returnType, source)}` : paramsText;
}

const solidityExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['contract_declaration'],
  methodTypes: ['function_definition', 'modifier_definition'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_value'],
  typeAliasTypes: [],
  importTypes: ['import_directive', 'pragma_directive'],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declaration_statement'],
  fieldTypes: ['state_variable_declaration', 'struct_member'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: '__direct_parameters__',
  returnField: 'return_type',
  getSignature: solidityFunctionSignature,
  getVisibility: (node) => {
    for (const child of node.namedChildren) {
      if (child.type !== 'visibility') continue;
      const visibility = child.text;
      if (visibility === 'public' || visibility === 'private' || visibility === 'internal') return visibility;
      if (visibility === 'external') return 'public';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'pragma_directive') return { moduleName: importText, signature: importText };
    const pathNode = node.namedChildren.find((child: SyntaxNode) => child.type === 'string');
    if (pathNode)
      return { moduleName: getNodeText(pathNode, source).replaceAll(/^['"]|['"]$/g, ''), signature: importText };
    return null;
  },
};

export const SOLIDITY_DEF: LanguageDef = {
  name: 'solidity',
  displayName: 'Solidity',
  extensions: ['.sol'],
  includeGlobs: ['**/*.sol'],
  grammar: { wasmFile: 'solidity.wasm', extractor: solidityExtractor },
};
