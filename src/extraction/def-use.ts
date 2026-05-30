import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge } from '../types.js';

/** Node types that open a new function scope — def_use collection stops descent into these. */
const INNER_SCOPE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
]);

/** Declaration node types that bind local variables in TS/JS. */
const VAR_DECL_TYPES: ReadonlySet<string> = new Set(['lexical_declaration', 'variable_declaration']);

interface LocalDef {
  name: string;
  defLine: number;
  defStartIndex: number;
}

/**
 * Collect locally declared variable names (simple identifier bindings only —
 * skip destructured patterns) from a `lexical_declaration` /
 * `variable_declaration` node that appears directly in the enclosing function's
 * statement list (not nested in an inner function scope).
 *
 * Returns an empty array when the node carries no simple-identifier declarators.
 */
function collectLocals(declNode: SyntaxNode): LocalDef[] {
  const defs: LocalDef[] = [];
  for (const child of declNode.namedChildren) {
    if (!child?.type || child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode?.type || nameNode.type !== 'identifier') continue;
    defs.push({
      name: nameNode.text,
      defLine: nameNode.startPosition.row + 1,
      defStartIndex: nameNode.startIndex,
    });
  }
  return defs;
}

/**
 * Scan `body` for all `identifier` nodes whose text matches `name` and
 * whose position is strictly after `afterIndex`, without descending into
 * inner function scopes. Returns the 1-based line numbers of matches.
 */
function findUseLines(body: SyntaxNode, name: string, afterIndex: number): number[] {
  const lines: number[] = [];

  const walk = (node: SyntaxNode): void => {
    if (INNER_SCOPE_TYPES.has(node.type)) return;

    if (node.type === 'identifier' && node.startIndex > afterIndex && node.text === name) {
      lines.push(node.startPosition.row + 1);
      return;
    }

    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };

  walk(body);
  return lines;
}

/**
 * Walk `body` for locally declared variables (one scope level deep —
 * stops descent into inner function scopes) and scan for uses of each.
 * Returns one `def_use` Edge per variable with at least one use.
 * The edge is a self-loop on `enclosingFnId` (source = target).
 * Metadata: `{ name, defLine, useLines }`.
 */
export function extractDefUseEdges(body: SyntaxNode, enclosingFnId: string): Edge[] {
  const edges: Edge[] = [];

  const walkForDecls = (node: SyntaxNode): void => {
    if (INNER_SCOPE_TYPES.has(node.type)) return;

    if (VAR_DECL_TYPES.has(node.type)) {
      for (const def of collectLocals(node)) {
        const useLines = findUseLines(body, def.name, def.defStartIndex);
        if (useLines.length > 0) {
          edges.push({
            source: enclosingFnId,
            target: enclosingFnId,
            kind: 'def_use',
            metadata: { name: def.name, defLine: def.defLine, useLines },
          });
        }
      }
      return;
    }

    for (const child of node.namedChildren) {
      if (child) walkForDecls(child);
    }
  };

  walkForDecls(body);
  return edges;
}
