import type { Edge, Language, Node, NodeKind } from '../types.js';
import { generateNodeId } from './tree-sitter-helpers.js';
import { buildExtractionResult } from './extraction-result-helpers.js';
import type { ExtractionResult, UnresolvedReference } from './types.js';

type SalesforceMarkupLanguage = Extract<Language, 'aura' | 'visualforce'>;

interface MarkupConfig {
  language: SalesforceMarkupLanguage;
  componentKind: NodeKind;
  componentName: string;
  routeName?: string;
}

interface RefEmitArgs {
  fromNodeId: string;
  referenceName: string;
  referenceKind: UnresolvedReference['referenceKind'];
  offset: number;
}

const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ATTR_RE = /\b([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
const AURA_ATTRIBUTE_RE = /<aura:attribute\b[^>]*>/gi;
const ACTION_EXPR_RE = /\{!\s*(?:c|controller)\.(\w+)\s*\}/g;
const VISUALFORCE_ACTION_ATTR_RE = /\baction\s*=\s*(["'])\s*\{!\s*(\w+)\s*\}\s*\1/gi;
const CUSTOM_COMPONENT_TAG_RE = /<\s*c:([A-Za-z][\w-]*)\b/g;

function stripMarkupComments(source: string): string {
  return source.replaceAll(XML_COMMENT_RE, (match) => [...match].map((ch) => (ch === '\n' ? '\n' : ' ')).join(''));
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let i = 0; i < offset; i++) {
    if (source.codePointAt(i) === 10) {
      line++;
      column = 0;
    } else {
      column++;
    }
  }
  return { line, column };
}

function basenameWithoutExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? fileName : fileName.slice(0, dot);
}

function salesforceComponentName(raw: string): string {
  return raw
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function isSalesforceIdentifier(name: string): boolean {
  const first = name.charAt(0);
  return (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z');
}

function createFileNode(filePath: string, source: string, language: Language): Node {
  const lines = source.split('\n');
  return {
    id: `file:${filePath}`,
    kind: 'file',
    name: filePath.split(/[\\/]/).pop() ?? filePath,
    qualifiedName: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: lines.length,
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    isExported: false,
    updatedAt: Date.now(),
  };
}

function createMarkupNode(args: {
  filePath: string;
  language: Language;
  kind: NodeKind;
  name: string;
  source: string;
  startOffset: number;
  endOffset: number;
  ordinal: number;
  signature?: string;
  isExported?: boolean;
}): Node {
  const start = lineColumnAt(args.source, args.startOffset);
  const end = lineColumnAt(args.source, args.endOffset);
  return {
    id: generateNodeId({ filePath: args.filePath, kind: args.kind, name: args.name, ordinal: args.ordinal }),
    kind: args.kind,
    name: args.name,
    qualifiedName: `${args.filePath}::${args.name}`,
    filePath: args.filePath,
    language: args.language,
    startLine: start.line,
    endLine: end.line,
    startColumn: start.column,
    endColumn: end.column,
    isExported: args.isExported ?? false,
    ...(args.signature ? { signature: args.signature } : {}),
    updatedAt: Date.now(),
  };
}

function parseAttrs(tagText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tagText))) {
    attrs.set(match[1]!, match[3]!);
  }
  return attrs;
}

function pushReference(source: string, refs: UnresolvedReference[], args: RefEmitArgs): void {
  if (!args.referenceName) return;
  const pos = lineColumnAt(source, args.offset);
  refs.push({
    fromNodeId: args.fromNodeId,
    referenceName: args.referenceName,
    referenceKind: args.referenceKind,
    line: pos.line,
    column: pos.column,
  });
}

function addComponentTagRefs(source: string, componentId: string, refs: UnresolvedReference[]): void {
  CUSTOM_COMPONENT_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_COMPONENT_TAG_RE.exec(source))) {
    pushReference(source, refs, {
      fromNodeId: componentId,
      referenceName: salesforceComponentName(match[1]!),
      referenceKind: 'references',
      offset: match.index,
    });
  }
}

function addAuraActionRefs(source: string, componentId: string, refs: UnresolvedReference[]): void {
  ACTION_EXPR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_EXPR_RE.exec(source))) {
    const name = match[1]!;
    if (!isSalesforceIdentifier(name)) continue;
    pushReference(source, refs, {
      fromNodeId: componentId,
      referenceName: name,
      referenceKind: 'calls',
      offset: match.index,
    });
  }
}

function addVisualforceActionRefs(source: string, componentId: string, refs: UnresolvedReference[]): void {
  VISUALFORCE_ACTION_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VISUALFORCE_ACTION_ATTR_RE.exec(source))) {
    const name = match[2]!;
    if (!isSalesforceIdentifier(name)) continue;
    pushReference(source, refs, {
      fromNodeId: componentId,
      referenceName: name,
      referenceKind: 'calls',
      offset: match.index + match[0].indexOf(name),
    });
  }
}

function addControllerRefs(source: string, componentId: string, refs: UnresolvedReference[]): void {
  const attrs = parseAttrs(source);
  const controller = attrs.get('controller');
  if (controller) {
    pushReference(source, refs, {
      fromNodeId: componentId,
      referenceName: controller,
      referenceKind: 'references',
      offset: source.indexOf(controller),
    });
  }
  const extensions = attrs.get('extensions');
  if (!extensions) return;
  for (const extension of extensions
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    pushReference(source, refs, {
      fromNodeId: componentId,
      referenceName: extension,
      referenceKind: 'references',
      offset: source.indexOf(extension),
    });
  }
}

function addAuraAttributeNodes(args: {
  filePath: string;
  source: string;
  language: Language;
  componentId: string;
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
}): void {
  AURA_ATTRIBUTE_RE.lastIndex = 0;
  let ordinal = 0;
  let match: RegExpExecArray | null;
  while ((match = AURA_ATTRIBUTE_RE.exec(args.source))) {
    const tag = match[0];
    const attrs = parseAttrs(tag);
    const name = attrs.get('name');
    if (!name) continue;
    const typeName = attrs.get('type');
    const field = createMarkupNode({
      filePath: args.filePath,
      language: args.language,
      kind: 'field',
      name,
      source: args.source,
      startOffset: match.index,
      endOffset: match.index + tag.length,
      ordinal: ++ordinal,
      ...(typeName ? { signature: typeName } : {}),
    });
    args.nodes.push(field);
    args.edges.push({ source: args.componentId, target: field.id, kind: 'contains' });
    if (typeName) {
      const refName = typeName.replace(/\[\]$/, '').split(/[.<]/)[0]?.trim();
      if (refName) {
        pushReference(args.source, args.refs, {
          fromNodeId: field.id,
          referenceName: refName,
          referenceKind: 'type_of',
          offset: match.index + tag.indexOf(typeName),
        });
      }
    }
  }
}

export function extractSalesforceMarkup(filePath: string, source: string, config: MarkupConfig): ExtractionResult {
  const startTime = Date.now();
  const stripped = stripMarkupComments(source);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const refs: UnresolvedReference[] = [];

  const fileNode = createFileNode(filePath, source, config.language);
  nodes.push(fileNode);
  const firstLineEndOffset = source.includes('\n') ? source.indexOf('\n') + 1 : source.length;
  const component = createMarkupNode({
    filePath,
    language: config.language,
    kind: config.componentKind,
    name: config.componentName,
    source,
    startOffset: 0,
    endOffset: Math.min(source.length, Math.max(1, firstLineEndOffset)),
    ordinal: 0,
    isExported: true,
  });
  nodes.push(component);
  edges.push({ source: fileNode.id, target: component.id, kind: 'contains' });

  if (config.routeName) {
    const route = createMarkupNode({
      filePath,
      language: config.language,
      kind: 'route',
      name: config.routeName,
      source,
      startOffset: 0,
      endOffset: Math.min(source.length, Math.max(1, firstLineEndOffset)),
      ordinal: 1,
      isExported: true,
    });
    nodes.push(route);
    edges.push({ source: component.id, target: route.id, kind: 'contains' });
  }

  addControllerRefs(stripped, component.id, refs);
  addComponentTagRefs(stripped, component.id, refs);
  if (config.language === 'aura') {
    addAuraActionRefs(stripped, component.id, refs);
    addAuraAttributeNodes({
      filePath,
      source: stripped,
      language: config.language,
      componentId: component.id,
      nodes,
      edges,
      refs,
    });
  } else {
    addVisualforceActionRefs(stripped, component.id, refs);
  }

  return buildExtractionResult({ nodes, edges, unresolvedReferences: refs, errors: [] }, startTime);
}

export function auraComponentName(filePath: string): string {
  return basenameWithoutExtension(filePath);
}

export function visualforceComponentName(filePath: string): string {
  return basenameWithoutExtension(filePath);
}
