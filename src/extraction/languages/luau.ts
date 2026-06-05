import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { LanguageDef } from './types.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { luaExtractor } from './lua.js';

/**
 * Luau extraction.
 *
 * Luau keeps Lua's function / call grammar shapes and adds gradual
 * type syntax. Reuse the Lua extractor for require handling, local
 * function assignments, and colon-method promotion, then add Luau
 * type aliases and richer function signatures.
 */
export const luauExtractor: LanguageExtractor = {
  ...luaExtractor,
  typeAliasTypes: ['type_definition'],

  isExported: (node, source) => source.startsWith('export ', node.startIndex),

  getSignature: (node, source) => {
    const base = luaExtractor.getSignature?.(node, source);
    if (!base) return undefined;

    const paramsNode = getChildByField(node, 'parameters');
    if (!paramsNode) return base;

    const named = node.namedChildren;
    const paramsIdx = named.findIndex((child) => child.startIndex === paramsNode.startIndex);
    if (paramsIdx < 0) return base;

    const afterParams = named[paramsIdx + 1];
    if (!afterParams || afterParams.type === 'block') return base;

    const returnType = getNodeText(afterParams, source).trim();
    if (!returnType) return base;
    return `${base}: ${returnType.replace(/^:\s*/, '')}`;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'method_index_expression') {
        emitLuauColonMethod(node, ctx);
        return true;
      }
    }
    return luaExtractor.visitNode?.(node, ctx) ?? false;
  },
};

function emitLuauColonMethod(node: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? getNodeText(nameNode, ctx.source).trim() : '';
  if (!name) return;

  const signature = luauExtractor.getSignature?.(node, ctx.source) ?? `function ${name}()`;
  const methodNode = ctx.createNode({
    kind: 'method',
    name,
    node,
    extra: { signature },
  });
  if (!methodNode) return;

  const body = node.childForFieldName('body');
  if (!body) return;

  ctx.pushScope(methodNode.id);
  try {
    ctx.visitFunctionBody(body, methodNode.id);
  } finally {
    ctx.popScope();
  }
}

export const LUAU_DEF: LanguageDef = {
  name: 'luau',
  displayName: 'Luau',
  extensions: ['.luau'],
  includeGlobs: ['**/*.luau'],
  grammar: { wasmFile: 'luau.wasm', extractor: luauExtractor },
};
