import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';
import { resolveClassFieldFunctionBody, tryExtractFunctionDeclarationAsComponent } from './js-function-helpers.js';

const EXPORT_SCOPE_BOUNDARY_TYPES = new Set([
  'arrow_function',
  'function_expression',
  'function_declaration',
  'method_definition',
  'class_declaration',
  'class_body',
]);

export const typescriptExtractor: LanguageExtractor = {
  functionTypes: [
    'function_declaration',
    'arrow_function',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
  ],
  classTypes: ['class_declaration', 'abstract_class_declaration'],
  methodTypes: ['method_definition', 'public_field_definition'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // public_field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   public_field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = withBatchedUpdates((e) => { ... })
    //   public_field_definition → call_expression → arguments → arrow_function → body
    return node.type === 'public_field_definition' ? resolveClassFieldFunctionBody(node, bodyField) : null;
  },
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
    }
    return sig;
  },
  getVisibility: (node) => {
    for (const child of node.children) {
      if (child?.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return undefined;
  },
  isExported: (node, _source) => {
    // Defensive guard for the declared `(node: SyntaxNode | undefined, ...)`
    // interface contract — never reached at runtime under current callers
    // but kept so future refactors that pass undefined don't silently crash.
    if (!node) return false;
    // Walk the parent chain to find an export_statement ancestor, but
    // stop at enclosing function/class boundaries. This still handles
    // `export const X = () => { ... }`, while keeping local handlers
    // inside exported React components from inheriting the component's
    // exportedness.
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      if (EXPORT_SCOPE_BOUNDARY_TYPES.has(current.type)) return false;
      current = current.parent;
    }
    return false;
  },
  isDefaultExport: (node, _source) => {
    if (!node) return false;
    // Same parent walk as isExported, but match the `export default …`
    // form: the enclosing export_statement carries a `default` keyword
    // child. (`export default function Foo()` keeps the node named `Foo`
    // — there is no `default`-named node — so this flag is the only
    // signal that it is the module's default export.)
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return current.children.some((c) => c?.type === 'default');
      if (EXPORT_SCOPE_BOUNDARY_TYPES.has(current.type)) return false;
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
  isStatic: (node) => {
    for (const child of node.children) {
      if (child?.type === 'static') return true;
    }
    return false;
  },
  isConst: (node) => {
    // For lexical_declaration, check if it's 'const' or 'let'
    // For variable_declaration, it's always 'var'
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

export const TYPESCRIPT_DEF: LanguageDef = {
  name: 'typescript',
  displayName: 'TypeScript',
  // `.mts` (ES-module) + `.cts` (CommonJS) are TypeScript variants
  // mirroring JS's `.mjs` / `.cjs`. The tree-sitter `typescript` grammar
  // handles all three identically — they differ only in Node's
  // module-resolution semantics. Without these extensions, bench
  // scripts and any other `.mts` ESM-flavored TS files are silently
  // dropped from extraction (caught 2026-05-21 on `bench/*.mts`).
  extensions: ['.ts', '.mts', '.cts'],
  includeGlobs: ['**/*.ts', '**/*.mts', '**/*.cts'],
  grammar: { wasmFile: 'typescript.wasm', extractor: typescriptExtractor },
};
