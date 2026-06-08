import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import { addLanguageReference } from './reference-helpers.js';
import type { LanguageDef } from './types.js';

const CONSTANT_FORM_HEADS = new Set(['defvar', 'defparameter', 'defconstant']);
const CLASS_FORM_HEADS = new Set(['defclass', 'define-condition']);
const STRUCT_FORM_HEADS = new Set(['defstruct']);
const NAMESPACE_FORM_HEADS = new Set(['defpackage', 'in-package']);
const IMPORT_FORM_HEADS = new Set(['use-package', 'require', 'import', 'use', 'import-from']);
const NON_CALL_FORM_HEADS = new Set([
  ...CONSTANT_FORM_HEADS,
  ...CLASS_FORM_HEADS,
  ...STRUCT_FORM_HEADS,
  ...NAMESPACE_FORM_HEADS,
  ...IMPORT_FORM_HEADS,
  'block',
  'case',
  'catch',
  'ccase',
  'cond',
  'ctypecase',
  'declare',
  'declaim',
  'destructuring-bind',
  'do',
  'do*',
  'dolist',
  'dotimes',
  'ecase',
  'etypecase',
  'eval-when',
  'flet',
  'function',
  'go',
  'handler-bind',
  'handler-case',
  'if',
  'labels',
  'lambda',
  'let',
  'let*',
  'load-time-value',
  'locally',
  'loop',
  'macrolet',
  'multiple-value-bind',
  'progn',
  'prog1',
  'prog2',
  'quote',
  'restart-bind',
  'restart-case',
  'return-from',
  'setf',
  'setq',
  'symbol-macrolet',
  'tagbody',
  'the',
  'throw',
  'typecase',
  'unless',
  'unwind-protect',
  'when',
]);

function nodeText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source);
}

function formChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type !== 'comment' && child.type !== 'dis_expr');
}

function cleanSymbolName(text: string): string {
  let name = text.trim();
  if (
    name.length >= 2 &&
    ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith('|') && name.endsWith('|')))
  ) {
    name = name.slice(1, -1);
  }
  if (name.startsWith('#:')) return name.slice(2);
  if (name.startsWith(':')) return name.slice(1);
  return name;
}

function isSymbolNode(node: SyntaxNode | null): node is SyntaxNode {
  return (
    node?.type === 'sym_lit' ||
    node?.type === 'package_lit' ||
    node?.type === 'kwd_lit' ||
    node?.type === 'str_lit' ||
    node?.type === 'fancy_literal' ||
    node?.type === 'quoting_lit' ||
    node?.type === 'var_quoting_lit'
  );
}

function symbolName(node: SyntaxNode | null, source: string): string | null {
  if (!isSymbolNode(node)) return null;
  if (node.type === 'quoting_lit' || node.type === 'var_quoting_lit') {
    return symbolName(node.namedChildren[0] ?? null, source);
  }
  const name = cleanSymbolName(nodeText(node, source));
  return name.length > 0 ? name : null;
}

function formHead(
  node: SyntaxNode,
  source: string,
): { node: SyntaxNode; name: string; key: string; isKeyword: boolean } | null {
  if (node.type !== 'list_lit') return null;
  const headNode = formChildren(node)[0];
  const name = symbolName(headNode ?? null, source);
  if (!headNode || !name) return null;
  const isKeyword = nodeText(headNode, source).trim().startsWith(':');
  let key = name.toLowerCase();
  if (key.startsWith('cl:')) key = key.slice(3);
  return { node: headNode, name, key, isKeyword };
}

function firstNameAfterHead(node: SyntaxNode, source: string): { node: SyntaxNode; name: string } | null {
  const candidate = formChildren(node)[1];
  const name = symbolName(candidate ?? null, source);
  return candidate && name ? { node: candidate, name } : null;
}

function defunHeader(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type === 'defun_header') ?? null;
}

function defunName(node: SyntaxNode, source: string): string | null {
  return symbolName(getChildByField(defunHeader(node) ?? node, 'function_name'), source);
}

function defunSignature(node: SyntaxNode, source: string): string | undefined {
  const params = getChildByField(defunHeader(node) ?? node, 'lambda_list');
  return params ? nodeText(params, source) : undefined;
}

function emitDefun(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = defunName(node, ctx.source);
  if (!name) return false;
  const signature = defunSignature(node, ctx.source);
  const created = ctx.createNode({
    kind: 'function',
    name,
    node,
    extra: signature ? { signature } : {},
  });
  if (!created) return true;

  ctx.pushScope(created.id);
  for (const child of node.childrenForFieldName('value')) ctx.visitNode(child);
  ctx.popScope();
  return true;
}

interface EmitNamedListFormArgs {
  node: SyntaxNode;
  ctx: ExtractorContext;
  kind: 'class' | 'constant' | 'struct';
  visitRest: boolean;
}

function emitNamedListForm(args: EmitNamedListFormArgs): boolean {
  const { node, ctx, kind, visitRest } = args;
  const named = firstNameAfterHead(node, ctx.source);
  if (!named) return false;
  const created = ctx.createNode({
    kind,
    name: named.name,
    node,
    extra: { signature: nodeText(named.node, ctx.source) },
  });
  if (!created || !visitRest) return true;

  ctx.pushScope(created.id);
  for (const child of formChildren(node).filter((child) => child.startIndex > named.node.endIndex))
    ctx.visitNode(child);
  ctx.popScope();
  return true;
}

function emitNamespace(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const named = firstNameAfterHead(node, ctx.source);
  if (!named) return false;
  const created =
    ctx.nodes.find((existing) => existing.kind === 'namespace' && existing.name === named.name) ??
    ctx.createNode({
      kind: 'namespace',
      name: named.name,
      node,
      extra: { signature: nodeText(node, ctx.source).trim() },
    });
  if (!created) return true;

  ctx.pushScope(created.id);
  for (const child of formChildren(node).slice(2)) ctx.visitNode(child);
  ctx.popScope();
  return true;
}

function emitImport(args: { node: SyntaxNode; name: string; ctx: ExtractorContext }): void {
  const { node, name, ctx } = args;
  ctx.createNode({ kind: 'import', name, node, extra: { signature: nodeText(node, ctx.source).trim() } });
  addLanguageReference({ node, name, kind: 'imports', ctx });
}

function emitImportForm(node: SyntaxNode, ctx: ExtractorContext, headKey: string): boolean {
  const args = formChildren(node).slice(1);
  const dependencies = headKey === 'import-from' ? args.slice(0, 1) : args;
  for (const dep of dependencies) {
    const name = symbolName(dep, ctx.source);
    if (name) emitImport({ node: dep, name, ctx });
  }
  return true;
}

function visitCommonLispList(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = formHead(node, ctx.source);
  if (!head) return false;
  if (NAMESPACE_FORM_HEADS.has(head.key)) return emitNamespace(node, ctx);
  if (CONSTANT_FORM_HEADS.has(head.key)) return emitNamedListForm({ node, ctx, kind: 'constant', visitRest: true });
  if (CLASS_FORM_HEADS.has(head.key)) return emitNamedListForm({ node, ctx, kind: 'class', visitRest: false });
  if (STRUCT_FORM_HEADS.has(head.key)) return emitNamedListForm({ node, ctx, kind: 'struct', visitRest: false });
  if (IMPORT_FORM_HEADS.has(head.key)) return emitImportForm(node, ctx, head.key);
  if (!NON_CALL_FORM_HEADS.has(head.key) && !head.isKeyword) {
    addLanguageReference({ node, name: head.name, kind: 'calls', ctx });
  }
  return false;
}

const commonLispExtractor: LanguageExtractor = {
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
  nameField: 'function_name',
  bodyField: 'value',
  paramsField: 'lambda_list',
  visitNode(node, ctx) {
    if (node.type === 'defun') return emitDefun(node, ctx);
    if (node.type === 'list_lit') return visitCommonLispList(node, ctx);
    return false;
  },
};

export const COMMON_LISP_DEF: LanguageDef = {
  name: 'common_lisp',
  displayName: 'Common Lisp',
  extensions: ['.lisp', '.lsp', '.l', '.cl', '.asd', '.ros'],
  includeGlobs: ['**/*.lisp', '**/*.lsp', '**/*.l', '**/*.cl', '**/*.asd', '**/*.ros'],
  grammar: { wasmFile: 'common_lisp.wasm', extractor: commonLispExtractor },
};
