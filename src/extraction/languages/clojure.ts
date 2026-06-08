import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import { addLanguageReference } from './reference-helpers.js';
import type { LanguageDef } from './types.js';

const DEF_CONSTANT_HEADS = new Set(['def', 'defonce']);
const DEF_FUNCTION_HEADS = new Set(['defmacro']);
const NON_CALL_LIST_HEADS = new Set(['fn', 'let', 'loop', 'quote', 'comment']);

interface ClojureDefForm {
  name: string;
  nameNode: SyntaxNode;
  valueNodes: SyntaxNode[];
}

function nodeText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source);
}

function listHead(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'list') return null;
  const head = node.namedChild(0);
  return head ? nodeText(head, source) : null;
}

function isSymbolLike(node: SyntaxNode): boolean {
  return node.type === 'symbol' || node.type === 'qualified_symbol' || node.type === 'interop';
}

function isKeyword(node: SyntaxNode): boolean {
  return node.type === 'keyword';
}

function namespaceTextFromChildren(children: readonly SyntaxNode[], source: string): string | null {
  const first = children.find((child) => isSymbolLike(child));
  if (!first) return null;
  let name = nodeText(first, source);
  if (name.endsWith('.')) {
    const suffix = children.find((child) => child.startIndex >= first.endIndex && child.type === 'symbol');
    if (suffix) name += nodeText(suffix, source);
  }
  return name || null;
}

function clojureSignature(node: SyntaxNode, source: string): string | undefined {
  const params = node.namedChildren.filter((child) => child.type === 'params').map((child) => nodeText(child, source));
  return params.length > 0 ? params.join(' ') : undefined;
}

function clojureVisibility(node: SyntaxNode): 'public' | 'private' {
  const text = node.text;
  return text.startsWith('(defn-') || text.includes('^:private') ? 'private' : 'public';
}

function readDefForm(node: SyntaxNode, source: string): ClojureDefForm | null {
  const children = node.namedChildren;
  const nameNode = children.find((child, index) => index > 0 && child.type === 'symbol');
  if (!nameNode) return null;
  const name = nodeText(nameNode, source);
  const valueNodes = children.filter((child) => child.startIndex > nameNode.endIndex);
  return name ? { name, nameNode, valueNodes } : null;
}

function emitDefForm(node: SyntaxNode, ctx: ExtractorContext, kind: 'constant' | 'function'): boolean {
  const def = readDefForm(node, ctx.source);
  if (!def) return false;
  const signature =
    kind === 'function'
      ? def.valueNodes.find((child) => child.type === 'vector')
      : node.namedChildren.find((child) => child.startIndex === def.nameNode.startIndex);
  let signatureText: string | undefined;
  if (signature) signatureText = nodeText(signature, ctx.source);
  const created = ctx.createNode({
    kind,
    name: def.name,
    node,
    extra: signatureText ? { signature: signatureText } : {},
  });
  if (!created) return true;

  ctx.pushScope(created.id);
  for (const child of def.valueNodes) ctx.visitNode(child);
  ctx.popScope();
  return true;
}

function emitNsImports(node: SyntaxNode, ctx: ExtractorContext): boolean {
  for (const child of node.namedChildren) {
    if (child.type !== 'list' || listHead(child, ctx.source) !== ':require') continue;
    emitRequireList(child, ctx);
  }
  return true;
}

function emitRequireList(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    if (child.type === 'vector') {
      emitRequireVector(child, ctx);
    } else if (isSymbolLike(child)) {
      emitImport({ node: child, name: nodeText(child, ctx.source), ctx });
    }
  }
}

function emitRequireVector(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = namespaceTextFromChildren(
    node.namedChildren.filter((child) => !isKeyword(child)),
    ctx.source,
  );
  if (!name) return;
  emitImport({ node, name, ctx });
}

function emitImport(args: { node: SyntaxNode; name: string; ctx: ExtractorContext }): void {
  const { node, name, ctx } = args;
  ctx.createNode({ kind: 'import', name, node, extra: { signature: nodeText(node, ctx.source).trim() } });
  addLanguageReference({ node, name, kind: 'imports', ctx });
}

function visitClojureList(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = listHead(node, ctx.source);
  if (!head) return false;
  if (head === 'ns') return emitNsImports(node, ctx);
  if (DEF_CONSTANT_HEADS.has(head)) return emitDefForm(node, ctx, 'constant');
  if (DEF_FUNCTION_HEADS.has(head)) return emitDefForm(node, ctx, 'function');
  if (!NON_CALL_LIST_HEADS.has(head) && !head.startsWith(':')) {
    addLanguageReference({ node, name: head, kind: 'calls', ctx });
  }
  return false;
}

function extractClojureBareCall(node: SyntaxNode, source: string): string | undefined {
  const head = listHead(node, source);
  if (!head || NON_CALL_LIST_HEADS.has(head) || head.startsWith(':')) return undefined;
  return head;
}

const clojureExtractor: LanguageExtractor = {
  functionTypes: ['defn'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'function_name',
  bodyField: 'function_body',
  paramsField: 'params',
  resolveName: (node, source) => {
    const nameNode = node.namedChildren.find((child) => child.type === 'function_name');
    return nameNode ? nodeText(nameNode, source) : undefined;
  },
  getSignature: clojureSignature,
  getVisibility: clojureVisibility,
  isExported: (node) => clojureVisibility(node) === 'public',
  resolveBody: (node) => node.namedChildren.find((child) => child.type === 'function_body') ?? null,
  extractBareCall: extractClojureBareCall,
  visitNode(node, ctx) {
    if (node.type === 'list') return visitClojureList(node, ctx);
    return false;
  },
};

export const CLOJURE_DEF: LanguageDef = {
  name: 'clojure',
  displayName: 'Clojure / ClojureScript',
  extensions: ['.clj', '.cljs', '.cljc', '.edn', '.bb'],
  includeGlobs: ['**/*.clj', '**/*.cljs', '**/*.cljc', '**/*.edn', '**/*.bb'],
  grammar: { wasmFile: 'clojure.wasm', extractor: clojureExtractor },
};
