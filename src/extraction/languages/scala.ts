import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { NodeKind } from '../../types.js';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import { isCurrentScopeClassLike } from './class-scope.js';

function getValVarName(node: SyntaxNode, source: string): string | null {
  const patternNode = node.childForFieldName('pattern');
  if (!patternNode) return null;
  if (patternNode.type === 'identifier') return getNodeText(patternNode, source);
  const identChild = patternNode.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return identChild ? getNodeText(identChild, source) : null;
}

function extractVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'modifiers' || child.type === 'access_modifier') {
      const text = child.text;
      if (text.includes('private')) return 'private';
      if (text.includes('protected')) return 'protected';
    }
  }
  return 'public';
}

function visitScalaEnumCases(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'enum_case_definitions') return false;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'simple_enum_case' || child.type === 'full_enum_case') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) ctx.createNode({ kind: 'enum_member', name: getNodeText(nameNode, ctx.source), node: child });
    }
  }
  return true;
}

function visitScalaValVarDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'val_definition' && node.type !== 'var_definition') return false;

  const name = getValVarName(node, ctx.source);
  if (!name) return false;

  const isVal = node.type === 'val_definition';
  const typeNode = node.childForFieldName('type');
  const keyword = isVal ? 'val' : 'var';
  const sig = typeNode ? `${keyword} ${name}: ${getNodeText(typeNode, ctx.source)}` : undefined;
  const kind = scalaValVarKind(ctx, isVal);

  ctx.createNode({ kind, name, node, extra: compact({ signature: sig, visibility: extractVisibility(node) }) });
  return true;
}

function scalaValVarKind(ctx: ExtractorContext, isVal: boolean): NodeKind {
  if (isCurrentScopeClassLike(ctx)) return 'field';
  return isVal ? 'constant' : 'variable';
}

function visitScalaExtensionDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'extension_definition') return false;
  const body = node.childForFieldName('body');
  if (!body) return true;
  for (const child of body.namedChildren) {
    if (child) ctx.visitNode(child);
  }
  return true;
}

const scalaExtractor: LanguageExtractor = {
  // top-level function_definition is handled via methodTypes (same pattern as Kotlin)
  functionTypes: [],
  classTypes: ['class_definition', 'object_definition', 'trait_definition'],
  methodTypes: ['function_definition', 'function_declaration'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: [], // handled in visitNode — enum_case_definitions wraps the cases
  typeAliasTypes: ['type_definition'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: [], // val/var handled in visitNode (use `pattern` field, not `name`)
  fieldTypes: [],
  extraClassNodeTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  interfaceKind: 'trait',

  classifyClassNode: (node: SyntaxNode) => {
    if (node.type === 'trait_definition') return 'trait';
    return 'class';
  },

  getSignature: (node: SyntaxNode, source: string) => {
    const params = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    if (!params && !returnType) return undefined;
    let sig = params ? getNodeText(params, source) : '';
    if (returnType) sig += ': ' + getNodeText(returnType, source);
    return sig || undefined;
  },

  getVisibility: (node: SyntaxNode) => extractVisibility(node),

  isAsync: () => false,

  isStatic: (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (child?.type === 'modifiers' && child.text.includes('static')) return true;
    }
    return false;
  },

  visitNode: (node: SyntaxNode, ctx) => {
    // val/var: name is in `pattern` field (identifier), not `name`
    if (visitScalaValVarDefinition(node, ctx)) return true;

    // enum_case_definitions wraps simple_enum_case / full_enum_case children
    if (visitScalaEnumCases(node, ctx)) return true;

    // extension_definition: visit body children directly, no container node
    if (visitScalaExtensionDefinition(node, ctx)) return true;

    return false;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    const importText = getNodeText(node, source).trim();
    const pathNode = node.childForFieldName('path');
    if (pathNode) return { moduleName: getNodeText(pathNode, source), signature: importText };
    for (const child of node.namedChildren) {
      if (child?.type === 'identifier' || child?.type === 'stable_identifier') {
        return { moduleName: getNodeText(child, source), signature: importText };
      }
    }
    return null;
  },
};

import type { LanguageDef } from './types.js';
import { compact } from '../../utils.js';
export const SCALA_DEF: LanguageDef = {
  name: 'scala',
  displayName: 'Scala',
  extensions: ['.scala', '.sc'],
  includeGlobs: ['**/*.scala', '**/*.sc'],
  grammar: { wasmFile: 'scala.wasm', extractor: scalaExtractor },
};
