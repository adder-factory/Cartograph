import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, subtreeContainsType } from '../tree-sitter-helpers.js';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

/** JSX node types that indicate a function body renders JSX. */
const JSX_RETURN_TYPES_TS = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'] as const;

/**
 * React component heuristic: PascalCase name + body that returns JSX.
 *
 * Handles only `function_declaration` here. Arrow-function components
 * (`const Foo = () => <JSX/>`) require a change in the shared
 * `tsExtractFunction` path (see ts-extract-declarations.ts) because
 * tree-sitter dispatches those directly from `extractTsJsVariables`
 * without going through the `visitNode` hook.
 */
function tryExtractTsFunctionDeclarationAsComponent(node: SyntaxNode, ctx: ExtractorContext, source: string): boolean {
  if (node.type !== 'function_declaration') return false;

  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  const name = getNodeText(nameNode, source);
  if (!/^[A-Z]/.test(name)) return false;

  const body = getChildByField(node, 'body');
  if (!body || !JSX_RETURN_TYPES_TS.some((t) => subtreeContainsType(body, t))) return false;

  const compNode = ctx.createNode({ kind: 'component', name, node });
  if (!compNode) return false;

  ctx.pushScope(compNode.id);
  ctx.visitFunctionBody(body, compNode.id);
  ctx.popScope();
  return true;
}

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
    if (node.type === 'public_field_definition') {
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        // Check inside call_expression arguments (HOF wrappers like throttle, debounce)
        if (child.type === 'call_expression') {
          const args = getChildByField(child, 'arguments');
          if (args) {
            for (const arg of args.namedChildren) {
              if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
                return getChildByField(arg, bodyField);
              }
            }
          }
        }
      }
    }
    return null;
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
    // Walk the parent chain to find an export_statement ancestor.
    // This correctly handles deeply nested nodes like arrow functions
    // inside variable declarations: `export const X = () => { ... }`
    // where the arrow_function is 3 levels deep under export_statement.
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
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
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
    return tryExtractTsFunctionDeclarationAsComponent(node, ctx, ctx.source);
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
