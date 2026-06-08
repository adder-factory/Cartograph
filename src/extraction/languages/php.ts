import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

const PHP_FILE_INCLUDE_TYPES = new Set([
  'include_expression',
  'include_once_expression',
  'require_expression',
  'require_once_expression',
]);

const phpExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration', 'trait_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_case'],
  typeAliasTypes: [],
  importTypes: ['namespace_use_declaration', ...PHP_FILE_INCLUDE_TYPES],
  callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
  variableTypes: ['const_declaration'],
  fieldTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    const returnType = getChildByField(node, 'return_type');
    const paramsText = getNodeText(params, source);
    return returnType ? `${paramsText}: ${getNodeText(returnType, source)}` : paramsText;
  },
  classifyClassNode: (node) => {
    return node.type === 'trait_declaration' ? 'trait' : 'class';
  },
  getVisibility: (node) => {
    for (const child of node.children) {
      if (child?.type === 'visibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return 'public'; // PHP defaults to public
  },
  isStatic: (node) => {
    for (const child of node.children) {
      if (child?.type === 'static_modifier') return true;
    }
    return false;
  },
  visitNode: (node, ctx) => {
    // Handle class constants: const_declaration inside classes
    // These are skipped by the main visitor because variableTypes check excludes class-like contexts
    if (node.type === 'const_declaration') {
      const constElements = node.namedChildren.filter((c: SyntaxNode) => c.type === 'const_element');
      for (const elem of constElements) {
        const nameNode = elem.namedChildren.find((c: SyntaxNode) => c.type === 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, ctx.source);
        ctx.createNode({ kind: 'constant', name, node: elem, extra: {} });
      }
      return true; // handled
    }

    // Handle trait usage: use TraitName, OtherTrait; inside classes
    // Creates unresolved references that will be resolved to 'implements' edges
    if (node.type === 'use_declaration') {
      const names = node.namedChildren.filter((c: SyntaxNode) => c.type === 'name' || c.type === 'qualified_name');
      const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack.at(-1) : undefined;
      if (parentId) {
        for (const nameNode of names) {
          const traitName = getNodeText(nameNode, ctx.source);
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: traitName,
            referenceKind: 'implements',
            filePath: ctx.filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return true; // handled
    }

    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    const fileIncludeTarget = extractPhpFileIncludeTarget(node, source);
    if (fileIncludeTarget) {
      return { moduleName: fileIncludeTarget, signature: importText };
    }

    // Check for grouped imports: use X\{A, B} - return null for core fallback
    const namespacePrefix = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_group');
    if (namespacePrefix && useGroup) {
      return null; // Grouped imports create multiple nodes - let core handle
    }

    // Single import - find namespace_use_clause
    const useClause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (useClause) {
      const qualifiedName = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
      if (qualifiedName) {
        return { moduleName: getNodeText(qualifiedName, source), signature: importText };
      }
      const name = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
      if (name) {
        return { moduleName: getNodeText(name, source), signature: importText };
      }
    }
    return null;
  },
};

function extractPhpFileIncludeTarget(node: SyntaxNode, source: string): string | null {
  if (!PHP_FILE_INCLUDE_TYPES.has(node.type)) return null;
  const target = unwrapPhpParenthesizedExpression(node.namedChild(0));
  if (!target) return null;
  return readPhpStaticStringLiteral(target, source);
}

function unwrapPhpParenthesizedExpression(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current?.type === 'parenthesized_expression' && current.namedChildCount === 1) {
    current = current.namedChild(0);
  }
  return current;
}

function readPhpStaticStringLiteral(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'string' && node.type !== 'encapsed_string') return null;

  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'string_content' && child.type !== 'escape_sequence') return null;
    parts.push(getNodeText(child, source));
  }
  const literal = parts.join('');
  return literal.length > 0 ? literal : null;
}

import type { LanguageDef } from './types.js';
export const PHP_DEF: LanguageDef = {
  name: 'php',
  displayName: 'PHP',
  // F#62 — Drupal modules ship hook implementations in
  // `.module`/`.install`/`.theme`/`.inc` files which are PHP source
  // with non-standard extensions. Registering them here means the
  // tree-sitter PHP grammar parses them and the Drupal framework
  // resolver's hook-detection runs on the resulting function nodes.
  extensions: ['.php', '.module', '.install', '.theme', '.inc'],
  includeGlobs: ['**/*.php', '**/*.module', '**/*.install', '**/*.theme', '**/*.inc'],
  grammar: { wasmFile: 'php.wasm', extractor: phpExtractor },
};
