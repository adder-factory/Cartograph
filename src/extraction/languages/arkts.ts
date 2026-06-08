import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

const arktsExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_definition'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  fieldTypes: ['public_field_definition'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    const returnType = getChildByField(node, 'return_type');
    let signature = getNodeText(params, source);
    if (returnType) signature += `: ${getNodeText(returnType, source).replace(/^:\s*/, '')}`;
    return signature;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (!sourceField) return null;
    const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replaceAll(/['"]/g, '');
    return moduleName ? { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() } : null;
  },
};

export const ARKTS_DEF: LanguageDef = {
  name: 'arkts',
  displayName: 'ArkTS',
  extensions: ['.ets'],
  includeGlobs: ['**/*.ets'],
  grammar: { wasmFile: 'arkts.wasm', extractor: arktsExtractor },
};
