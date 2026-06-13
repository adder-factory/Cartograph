import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText, subtreeContainsType } from '../tree-sitter-helpers.js';
import type { ExtractorContext } from '../tree-sitter-types.js';

const JSX_RETURN_TYPES = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'] as const;

function bodyContainsJsx(node: SyntaxNode): boolean {
  return JSX_RETURN_TYPES.some((t) => subtreeContainsType(node, t));
}

export function tryExtractFunctionDeclarationAsComponent(
  node: SyntaxNode,
  ctx: ExtractorContext,
  source: string,
): boolean {
  if (node.type !== 'function_declaration') return false;

  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  const name = getNodeText(nameNode, source);
  if (!/^[A-Z]/.test(name)) return false;

  const body = getChildByField(node, 'body');
  if (!body || !bodyContainsJsx(body)) return false;

  // Mirror the metadata the plain-function path attaches (isExported,
  // docstring, signature, …). Without this, `export default function
  // Foo()` components land with is_exported=0 / docstring=NULL /
  // signature=NULL, corrupting dead-code/unused_export and the node
  // lookup surfaces (issue #9).
  const compNode = ctx.createNode({
    kind: 'component',
    name,
    node,
    extra: ctx.collectFunctionMetadata(node, { isExported: true }),
  });
  if (!compNode) return false;

  ctx.pushScope(compNode.id);
  ctx.visitFunctionBody(body, compNode.id);
  ctx.popScope();
  return true;
}

function isFunctionLikeExpression(node: SyntaxNode): boolean {
  return node.type === 'arrow_function' || node.type === 'function_expression';
}

function resolveWrappedFunctionBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
  const args = getChildByField(node, 'arguments');
  if (!args) return null;
  const fn = args.namedChildren.find((arg: SyntaxNode) => isFunctionLikeExpression(arg));
  return fn ? getChildByField(fn, bodyField) : null;
}

export function resolveClassFieldFunctionBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (isFunctionLikeExpression(child)) return getChildByField(child, bodyField);
    if (child.type === 'call_expression') {
      const wrappedBody = resolveWrappedFunctionBody(child, bodyField);
      if (wrappedBody) return wrappedBody;
    }
  }
  return null;
}
