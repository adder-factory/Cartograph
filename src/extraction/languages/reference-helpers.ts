import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types.js';

export interface AddLanguageReferenceArgs {
  node: SyntaxNode;
  name: string;
  kind: 'calls' | 'imports' | 'references';
  ctx: ExtractorContext;
}

export function addLanguageReference(args: AddLanguageReferenceArgs): void {
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
