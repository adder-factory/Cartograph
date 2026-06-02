import type { ExtractorContext } from '../tree-sitter-types.js';

const CLASS_LIKE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'module']);

export function isClassLikeKind(kind: string): boolean {
  return CLASS_LIKE_KINDS.has(kind);
}

export function isCurrentScopeClassLike(ctx: ExtractorContext): boolean {
  if (ctx.nodeStack.length === 0) return false;
  const parentId = ctx.nodeStack.at(-1);
  const parentNode = ctx.nodes.find((n) => n.id === parentId);
  return parentNode != null && isClassLikeKind(parentNode.kind);
}
