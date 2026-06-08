import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

interface NixReferenceArgs {
  node: SyntaxNode;
  name: string;
  kind: 'calls' | 'imports' | 'references';
  ctx: ExtractorContext;
}

function attrpathName(node: SyntaxNode, source: string): string | null {
  const parts = node.namedChildren
    .filter((child) => child.type === 'identifier' || child.type === 'string_expression')
    .map((child) => stringLikeText(child, source))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('.') : null;
}

function stringLikeText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).replaceAll(/^["']|["']$/g, '');
}

function functionSignature(node: SyntaxNode, source: string): string | undefined {
  const body = getChildByField(node, 'body');
  if (!body) return undefined;
  return source.substring(node.startIndex, body.startIndex).trim().replace(/:\s*$/, '');
}

function bindingInfo(
  node: SyntaxNode,
  source: string,
): { name: string; expression: SyntaxNode; signature: string } | null {
  const attrpath = getChildByField(node, 'attrpath');
  const expression = getChildByField(node, 'expression');
  if (!attrpath || !expression) return null;
  const name = attrpathName(attrpath, source);
  return name ? { name, expression, signature: getNodeText(attrpath, source) } : null;
}

function emitBinding(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const info = bindingInfo(node, ctx.source);
  if (!info) return false;

  const isFunction = info.expression.type === 'function_expression';
  const signature = isFunction ? functionSignature(info.expression, ctx.source) : info.signature;
  const created = ctx.createNode({
    kind: isFunction ? 'function' : 'constant',
    name: info.name,
    node,
    extra: signature ? { signature } : {},
  });
  if (!created) return true;

  ctx.pushScope(created.id);
  ctx.visitNode(info.expression);
  ctx.popScope();
  return true;
}

function emitInheritedAttrs(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const attrs = getChildByField(node, 'attrs');
  if (!attrs) return false;

  for (const attr of attrs.namedChildren) {
    if (attr.type !== 'identifier' && attr.type !== 'string_expression') continue;
    const name = stringLikeText(attr, ctx.source);
    ctx.createNode({ kind: 'constant', name, node: attr, extra: { signature: `inherit ${name}` } });
  }

  const expression = getChildByField(node, 'expression');
  if (expression) emitExpressionReference(expression, ctx);
  return true;
}

function emitApplyCall(node: SyntaxNode, ctx: ExtractorContext): void {
  const target = callTargetName(getChildByField(node, 'function'), ctx.source);
  if (!target) return;
  emitReference({ node, name: target, kind: 'calls', ctx });
  if (target === 'import') emitImport(node, ctx);
}

function emitImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const argument = getChildByField(node, 'argument');
  const importPath = argument ? importPathText(argument, ctx.source) : null;
  if (!importPath) return;
  ctx.createNode({
    kind: 'import',
    name: importPath,
    node,
    extra: { signature: getNodeText(node, ctx.source).trim() },
  });
  emitReference({ node, name: importPath, kind: 'imports', ctx });
}

function importPathText(node: SyntaxNode, source: string): string | null {
  if (node.type === 'path_expression' || node.type === 'hpath_expression' || node.type === 'spath_expression') {
    return getNodeText(node, source);
  }
  if (node.type === 'string_expression') return stringLikeText(node, source);
  return null;
}

function emitExpressionReference(node: SyntaxNode, ctx: ExtractorContext): void {
  const target = callTargetName(node, ctx.source);
  if (target) emitReference({ node, name: target, kind: 'references', ctx });
}

function emitReference(args: NixReferenceArgs): void {
  const { node, name, kind, ctx } = args;
  const fromNodeId = ctx.nodeStack.at(-1);
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function callTargetName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  if (node.type === 'variable_expression') {
    const name = getChildByField(node, 'name') ?? node.namedChildren.find((child) => child.type === 'identifier');
    return name ? getNodeText(name, source) : null;
  }
  if (node.type === 'select_expression') return selectTargetName(node, source);
  if (node.type === 'parenthesized_expression') return callTargetName(getChildByField(node, 'expression'), source);
  if (node.type === 'apply_expression') return callTargetName(getChildByField(node, 'function'), source);
  return null;
}

function selectTargetName(node: SyntaxNode, source: string): string | null {
  const base = callTargetName(getChildByField(node, 'expression'), source);
  const attrpath = getChildByField(node, 'attrpath');
  const attr = attrpath ? attrpathName(attrpath, source) : null;
  if (!attr) return base;
  return base ? `${base}.${attr}` : attr;
}

const nixExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'formals',
  visitNode(node, ctx) {
    if (node.type === 'binding') return emitBinding(node, ctx);
    if (node.type === 'inherit' || node.type === 'inherit_from') return emitInheritedAttrs(node, ctx);
    if (node.type === 'apply_expression') emitApplyCall(node, ctx);
    return false;
  },
};

export const NIX_DEF: LanguageDef = {
  name: 'nix',
  displayName: 'Nix',
  extensions: ['.nix'],
  includeGlobs: ['**/*.nix'],
  grammar: { wasmFile: 'nix.wasm', extractor: nixExtractor },
};
