import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.js';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

const APEX_VISIBILITY = ['global', 'public', 'private', 'protected'] as const;

function modifierText(node: SyntaxNode): string {
  return node.namedChildren
    .filter((child) => child.type === 'modifiers')
    .map((child) => child.text)
    .join(' ');
}

function apexVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' | undefined {
  const text = modifierText(node);
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  if (/\b(?:public|global)\b/.test(text)) return 'public';
  return undefined;
}

function apexIsExported(node: SyntaxNode): boolean {
  const text = modifierText(node);
  return APEX_VISIBILITY.some((keyword) => new RegExp(String.raw`\b${keyword}\b`).test(text));
}

function apexIsStatic(node: SyntaxNode): boolean {
  return /\bstatic\b/.test(modifierText(node));
}

function apexSignature(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'trigger_declaration') return apexTriggerSignature(node, source);

  const params = getChildByField(node, 'parameters');
  if (!params) return undefined;
  const returnType = getChildByField(node, 'type');
  const paramsText = getNodeText(params, source);
  return returnType ? `${getNodeText(returnType, source)} ${paramsText}` : paramsText;
}

function apexTriggerSignature(node: SyntaxNode, source: string): string | undefined {
  const objectNode = getChildByField(node, 'object');
  const objectName = objectNode ? getNodeText(objectNode, source) : undefined;
  const events = node.namedChildren
    .filter((child) => child.type === 'trigger_event')
    .map((child) => getNodeText(child, source).replaceAll('_', ' '));
  if (!objectName && events.length === 0) return undefined;
  const eventText = events.length > 0 ? ` (${events.join(', ')})` : '';
  return objectName ? `on ${objectName}${eventText}` : `trigger${eventText}`;
}

function emitSalesforceObjectRefs(node: SyntaxNode, ctx: ExtractorContext): void {
  const fromNodeId = ctx.nodeStack.at(-1);
  if (!fromNodeId) return;
  const seen = new Set<string>();
  visitStorageIdentifiers(node, (storage) => {
    const name = getNodeText(storage, ctx.source);
    if (!name || seen.has(name)) return;
    seen.add(name);
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: name,
      referenceKind: 'references',
      line: storage.startPosition.row + 1,
      column: storage.startPosition.column,
    });
  });
}

function visitStorageIdentifiers(node: SyntaxNode, emit: (node: SyntaxNode) => void): void {
  if (node.type === 'storage_identifier') {
    emit(node);
    return;
  }
  for (const child of node.namedChildren) {
    if (child) visitStorageIdentifiers(child, emit);
  }
}

function visitApexNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type === 'query_expression' || node.type === 'sosl_query_body' || node.type === 'soql_query_body') {
    emitSalesforceObjectRefs(node, ctx);
  }
  return false;
}

const apexExtractor: LanguageExtractor = {
  functionTypes: ['trigger_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: apexSignature,
  getVisibility: apexVisibility,
  isExported: apexIsExported,
  isStatic: apexIsStatic,
  visitNode: visitApexNode,
};

export const APEX_DEF: LanguageDef = {
  name: 'apex',
  displayName: 'Apex',
  extensions: ['.cls', '.trigger'],
  includeGlobs: ['**/*.cls', '**/*.trigger'],
  grammar: { wasmFile: 'apex.wasm', extractor: apexExtractor },
};
