import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import { resolveClassFieldFunctionBody, tryExtractFunctionDeclarationAsComponent } from './js-function-helpers.js';

export const javascriptExtractor: LanguageExtractor = {
  functionTypes: [
    'function_declaration',
    'arrow_function',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
  ],
  classTypes: ['class_declaration'],
  methodTypes: ['method_definition', 'field_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = throttle((e) => { ... })
    //   field_definition → call_expression → arguments → arrow_function → body
    return node.type === 'field_definition' ? resolveClassFieldFunctionBody(node, bodyField) : null;
  },
  paramsField: 'parameters',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },
  isExported: (node, _source) => {
    // Defensive guard for the declared `(node: SyntaxNode | undefined, ...)`
    // interface contract — never reached at runtime under current callers
    // but kept so future refactors that pass undefined don't silently crash.
    if (!node) return false;
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return false;
  },
  isAsync: (node) => {
    for (const child of node.children) {
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isConst: (node) => {
    if (node.type === 'lexical_declaration') {
      for (const child of node.children) {
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replaceAll(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },

  /**
   * React component classification for function declarations.
   *
   * `function_declaration` nodes whose name is PascalCase and whose body
   * contains JSX are emitted as `kind: 'component'` instead of
   * `kind: 'function'`. This prevents a duplicate pair where
   * `tsExtractFunction` would emit `function:sha256` and the react.ts
   * framework-resolver's `extractNodes` regex would add a separate
   * `component:path:name:line` node for the same symbol.
   *
   * Arrow-function components (`const Foo = () => <JSX/>`) cannot be
   * intercepted here because tree-sitter routes them through
   * `extractTsJsVariables → tsExtractFunction` directly, bypassing the
   * `visitNode` hook. That path requires a fix in
   * `ts-extract-declarations.ts` and suppression of the matching regex in
   * `src/resolution/frameworks/react.ts`.
   */
  visitNode: (node, ctx) => {
    return tryExtractFunctionDeclarationAsComponent(node, ctx, ctx.source);
  },
};

import type { LanguageDef } from './types.js';
export const JAVASCRIPT_DEF: LanguageDef = {
  name: 'javascript',
  displayName: 'JavaScript',
  extensions: ['.js', '.mjs', '.cjs', '.xsjs', '.xsjslib'],
  includeGlobs: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.xsjs', '**/*.xsjslib'],
  grammar: { wasmFile: 'javascript.wasm', extractor: javascriptExtractor },
};
