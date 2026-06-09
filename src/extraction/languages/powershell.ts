import type { Node as SyntaxNode } from 'web-tree-sitter';
import { emitScopedSyntaxNode, findDescendantByType, getFirstNodeLine, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

const POWERSHELL_COMMAND_SKIP: ReadonlySet<string> = new Set([
  'begin',
  'break',
  'catch',
  'continue',
  'dynamicparam',
  'else',
  'elseif',
  'end',
  'exit',
  'finally',
  'for',
  'foreach',
  'if',
  'param',
  'process',
  'return',
  'switch',
  'throw',
  'trap',
  'try',
  'using',
  'while',
]);

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function nameText(node: SyntaxNode | null | undefined, source: string): string {
  if (!node) return '';
  return getNodeText(node, source).replace(/^\$/, '').trim();
}

function currentScopeKind(ctx: ExtractorContext): string | undefined {
  const id = ctx.nodeStack.at(-1);
  return ctx.nodes.find((node) => node.id === id)?.kind;
}

function visitChildrenExcept(node: SyntaxNode, ctx: ExtractorContext, skip: SyntaxNode | undefined): void {
  for (const child of node.namedChildren) {
    if (child && child.id !== skip?.id) ctx.visitNode(child);
  }
}

function visitPowerShellClass(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, 'simple_name');
  const name = nameText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'class',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function visitPowerShellFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, 'function_name');
  const name = nameText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'function',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function visitPowerShellMethod(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, 'simple_name');
  const name = nameText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'method',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function visitPowerShellEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, 'simple_name');
  const name = nameText(nameNode, ctx.source);
  return emitScopedSyntaxNode({
    ctx,
    kind: 'enum',
    name,
    node,
    visitBody: () => visitChildrenExcept(node, ctx, nameNode),
  });
}

function emitPowerShellField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const variable = firstChildOfType(node, 'variable');
  const name = nameText(variable, ctx.source);
  ctx.createNode({ kind: 'field', name, node, extra: { signature: getNodeText(node, ctx.source).trim() } });
  return true;
}

function emitPowerShellEnumMember(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = nameText(firstChildOfType(node, 'simple_name'), ctx.source);
  ctx.createNode({ kind: 'enum_member', name, node, extra: { signature: getNodeText(node, ctx.source).trim() } });
  return true;
}

function emitPowerShellVariable(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (currentScopeKind(ctx) !== 'file') return false;
  const left = firstChildOfType(node, 'left_assignment_expression');
  const variable = left ? findDescendantByType(left, 'variable') : undefined;
  const name = nameText(variable, ctx.source);
  const signature = getFirstNodeLine(node, ctx.source);
  ctx.createNode({
    kind: 'variable',
    name,
    node,
    ...(signature ? { extra: { signature } } : {}),
  });
  return true;
}

function commandName(node: SyntaxNode, source: string): string {
  const name = node.childForFieldName('command_name') ?? firstChildOfType(node, 'command_name');
  return nameText(name, source);
}

function readUsingImport(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).trim();
  const lower = text.toLowerCase();
  for (const kind of ['module', 'namespace', 'assembly']) {
    const prefix = `using ${kind} `;
    if (lower.startsWith(prefix)) return trimPowerShellQuotePair(text.slice(prefix.length).trim());
  }
  return '';
}

function trimPowerShellQuotePair(value: string): string {
  if (isWrappedInQuote(value, "'")) return value.slice(1, -1);
  if (isWrappedInQuote(value, '"')) return value.slice(1, -1);
  return value;
}

function isWrappedInQuote(value: string, quote: string): boolean {
  return value.length >= 2 && value.startsWith(quote) && value.endsWith(quote);
}

function emitPowerShellCommand(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = commandName(node, ctx.source);
  if (!name) return false;
  if (name.toLowerCase() === 'using') {
    const importName = readUsingImport(node, ctx.source);
    ctx.createNode({
      kind: 'import',
      name: importName,
      node,
      extra: { signature: getNodeText(node, ctx.source).trim() },
    });
    return true;
  }
  if (POWERSHELL_COMMAND_SKIP.has(name.toLowerCase())) return true;
  const fromNodeId = ctx.nodeStack.at(-1);
  if (!fromNodeId) return true;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
  return true;
}

function emitPowerShellInvocation(node: SyntaxNode, ctx: ExtractorContext): void {
  const member = findDescendantByType(node, 'member_name');
  const name = nameText(member, ctx.source);
  const fromNodeId = ctx.nodeStack.at(-1);
  if (!name || !fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function visitPowerShellNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  switch (node.type) {
    case 'class_statement':
      return visitPowerShellClass(node, ctx);
    case 'function_statement':
      return visitPowerShellFunction(node, ctx);
    case 'class_method_definition':
      return visitPowerShellMethod(node, ctx);
    case 'class_property_definition':
      return emitPowerShellField(node, ctx);
    case 'enum_statement':
      return visitPowerShellEnum(node, ctx);
    case 'enum_member':
      return emitPowerShellEnumMember(node, ctx);
    case 'assignment_expression':
      return emitPowerShellVariable(node, ctx);
    case 'command':
      return emitPowerShellCommand(node, ctx);
    case 'invokation_expression':
      emitPowerShellInvocation(node, ctx);
      return false;
    default:
      return false;
  }
}

const powershellExtractor: LanguageExtractor = {
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
  visitNode: visitPowerShellNode,
};

export const POWERSHELL_DEF: LanguageDef = {
  name: 'powershell',
  displayName: 'PowerShell',
  extensions: ['.ps1', '.psm1', '.psd1'],
  includeGlobs: ['**/*.ps1', '**/*.psm1', '**/*.psd1'],
  grammar: { wasmFile: 'powershell.wasm', extractor: powershellExtractor },
};
