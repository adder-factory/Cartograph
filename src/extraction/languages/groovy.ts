import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

const groovyExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: (node, source) => {
    const params = node.childForFieldName('parameters');
    if (!params) return undefined;
    const returnType = node.childForFieldName('type');
    return returnType
      ? `${getNodeText(returnType, source)} ${getNodeText(params, source)}`
      : getNodeText(params, source);
  },
  getVisibility: (node) => {
    for (const child of node.children) {
      if (child?.type !== 'modifiers') continue;
      const text = child.text;
      if (text.includes('public')) return 'public';
      if (text.includes('private')) return 'private';
      if (text.includes('protected')) return 'protected';
    }
    return 'public';
  },
  isStatic: (node) => {
    return node.children.some(
      (child: SyntaxNode | null) => child?.type === 'modifiers' && child.text.includes('static'),
    );
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const scopedId = node.namedChildren.find((child: SyntaxNode) => child.type === 'scoped_identifier');
    if (scopedId) return { moduleName: getNodeText(scopedId, source), signature: importText };
    const identifier = node.namedChildren.find((child: SyntaxNode) => child.type === 'identifier');
    if (identifier) return { moduleName: getNodeText(identifier, source), signature: importText };
    return null;
  },
};

export const GROOVY_DEF: LanguageDef = {
  name: 'groovy',
  displayName: 'Groovy',
  extensions: ['.groovy', '.gradle'],
  includeGlobs: ['**/*.groovy', '**/*.gradle'],
  grammar: { wasmFile: 'groovy.wasm', extractor: groovyExtractor },
};
