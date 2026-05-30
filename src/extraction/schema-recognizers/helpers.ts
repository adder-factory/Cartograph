/**
 * Shared helpers for the schema-DSL recognizers (Zod, Pydantic, …).
 *
 * These are the generic, DSL-agnostic primitives every recognizer
 * needs — a tree walk, a quote stripper, and the `Node` synthesizer
 * that stamps cartograph's required positional fields. Kept in one
 * place so a second recognizer doesn't clone them (a recognizer file
 * stays just its own DSL's pattern logic).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types.js';
import type { SchemaRecognizerContext } from './types.js';

/** Strip one layer of surrounding quotes from a string-literal text. */
export function unquote(text: string): string {
  return text.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

/**
 * Visit every node in the tree, each parent strictly before its
 * descendants (siblings in reverse source order — the stack is LIFO).
 * Recognizer passes depend only on parent-before-descendant, not on
 * sibling order.
 */
export function walkTree(root: SyntaxNode, visit: (n: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    visit(n);
    for (const c of n.namedChildren) {
      if (c) stack.push(c);
    }
  }
}

/** Inputs to {@link mkNode}. */
export interface MkNodeArgs {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  ctx: SchemaRecognizerContext;
  start: SyntaxNode;
  end: SyntaxNode;
  signature?: string;
  now: number;
}

/** Build a synthesized `Node` from a tree-sitter span. */
export function mkNode(a: MkNodeArgs): Node {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    qualifiedName: a.qualifiedName,
    filePath: a.ctx.filePath,
    language: a.ctx.language,
    startLine: a.start.startPosition.row + 1,
    endLine: a.end.endPosition.row + 1,
    startColumn: a.start.startPosition.column,
    endColumn: a.end.endPosition.column,
    ...(a.signature ? { signature: a.signature } : {}),
    updatedAt: a.now,
  };
}
