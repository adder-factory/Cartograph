import type { Node as SyntaxNode } from 'web-tree-sitter';
import { emitScopedSyntaxNode, findDescendantByType, getFirstNodeLine, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

const FSHARP_CALL_SKIP: ReadonlySet<string> = new Set(['async', 'seq', 'ignore', 'nameof']);

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function namedText(node: SyntaxNode | null | undefined, source: string): string {
  if (!node) return '';
  if (node.type === 'identifier' || node.type === 'long_identifier' || node.type === 'long_identifier_or_op') {
    return getNodeText(node, source).trim();
  }
  const method = node.childForFieldName('method');
  if (method) return getNodeText(method, source).trim();
  const typeName = node.childForFieldName('type_name');
  if (typeName) return namedText(typeName, source);
  const identifier = findDescendantByType(node, 'identifier');
  return identifier ? getNodeText(identifier, source).trim() : getNodeText(node, source).trim();
}

function visitChildrenExcept(node: SyntaxNode, ctx: ExtractorContext, skip: SyntaxNode | undefined): void {
  for (const child of node.namedChildren) {
    if (child && child.id !== skip?.id) ctx.visitNode(child);
  }
}

function visitFsharpNamespace(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = node.childForFieldName('name') ?? firstChildOfType(node, 'long_identifier');
  const name = namedText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'namespace',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function visitFsharpModule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, 'identifier');
  const name = namedText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'module',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function visitFsharpFunctionOrValue(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const fnLeft = firstChildOfType(node, 'function_declaration_left');
  if (fnLeft) {
    const name = namedText(firstChildOfType(fnLeft, 'identifier'), ctx.source);
    return emitScopedSyntaxNode({
      ctx,
      kind: 'function',
      name,
      node,
      visitBody: () => {
        for (const child of node.namedChildren) {
          if (child && child.id !== fnLeft.id) ctx.visitNode(child);
        }
      },
    });
  }

  const valueLeft = firstChildOfType(node, 'value_declaration_left');
  const name = namedText(valueLeft, ctx.source);
  const signature = getFirstNodeLine(node, ctx.source);
  ctx.createNode({
    kind: 'variable',
    name,
    node,
    ...(signature ? { extra: { signature } } : {}),
  });
  for (const child of node.namedChildren) {
    if (child && child.id !== valueLeft?.id) ctx.visitNode(child);
  }
  return true;
}

function visitFsharpType(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'class' | 'struct' | 'interface' | 'enum',
): boolean {
  const name = namedText(firstChildOfType(node, 'type_name'), ctx.source);
  return emitScopedSyntaxNode({ ctx, kind, name, node, visitBody: () => visitAllChildren(node, ctx) });
}

function visitFsharpMethodOrProperty(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = namedText(node.childForFieldName('name'), ctx.source);
  return emitScopedSyntaxNode({ ctx, kind: 'method', name, node, visitBody: () => visitAllChildren(node, ctx) });
}

function visitAllChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    if (child) ctx.visitNode(child);
  }
}

function emitFsharpImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = namedText(firstChildOfType(node, 'long_identifier'), ctx.source);
  ctx.createNode({
    kind: 'import',
    name,
    node,
    extra: { signature: getNodeText(node, ctx.source).trim() },
  });
  return true;
}

function emitFsharpRecordField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const text = getNodeText(node, ctx.source).trim();
  const name = /^([A-Za-z_][A-Za-z0-9_']*)/.exec(text)?.[1] ?? '';
  ctx.createNode({ kind: 'field', name, node, extra: { signature: text } });
  return true;
}

function emitFsharpEnumMember(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const text = getNodeText(node, ctx.source).trim();
  const name = /^\|?\s*([A-Za-z_][A-Za-z0-9_']*)/.exec(text)?.[1] ?? '';
  ctx.createNode({ kind: 'enum_member', name, node, extra: { signature: text } });
  return true;
}

function leftmostApplicationHead(node: SyntaxNode): SyntaxNode | null {
  let head: SyntaxNode | null = node.namedChild(0);
  while (head?.type === 'application_expression') {
    head = head.namedChild(0);
  }
  return head;
}

function fsharpCallName(node: SyntaxNode, source: string): string {
  const head = leftmostApplicationHead(node);
  if (!head) return '';
  if (head.type === 'dot_expression') {
    return getNodeText(head.childForFieldName('field') ?? head, source).trim();
  }
  return getNodeText(head, source).trim();
}

function emitFsharpCall(node: SyntaxNode, ctx: ExtractorContext): void {
  if (node.parent?.type === 'application_expression') return;
  const referenceName = fsharpCallName(node, ctx.source);
  if (
    !referenceName ||
    FSHARP_CALL_SKIP.has(referenceName) ||
    !isFsharpIdentifierStart(referenceName.codePointAt(0) ?? -1)
  )
    return;
  const fromNodeId = ctx.nodeStack.at(-1);
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function isFsharpIdentifierStart(code: number): boolean {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function visitFsharpNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  switch (node.type) {
    case 'namespace':
      return visitFsharpNamespace(node, ctx);
    case 'module_defn':
      return visitFsharpModule(node, ctx);
    case 'import_decl':
      return emitFsharpImport(node, ctx);
    case 'function_or_value_defn':
      return visitFsharpFunctionOrValue(node, ctx);
    case 'record_type_defn':
      return visitFsharpType(node, ctx, 'struct');
    case 'anon_type_defn':
      return visitFsharpType(node, ctx, 'class');
    case 'interface_type_defn':
      return visitFsharpType(node, ctx, 'interface');
    case 'enum_type_defn':
      return visitFsharpType(node, ctx, 'enum');
    case 'method_or_prop_defn':
      return visitFsharpMethodOrProperty(node, ctx);
    case 'record_field':
      return emitFsharpRecordField(node, ctx);
    case 'enum_type_case':
      return emitFsharpEnumMember(node, ctx);
    case 'application_expression':
      emitFsharpCall(node, ctx);
      return true;
    default:
      return false;
  }
}

const fsharpExtractor: LanguageExtractor = {
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
  paramsField: 'parameters',
  visitNode: visitFsharpNode,
};

export const FSHARP_DEF: LanguageDef = {
  name: 'fsharp',
  displayName: 'F#',
  extensions: ['.fs', '.fsx'],
  includeGlobs: ['**/*.fs', '**/*.fsx'],
  grammar: { wasmFile: 'fsharp.wasm', extractor: fsharpExtractor },
};
