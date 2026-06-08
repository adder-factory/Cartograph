import * as path from 'node:path';
import type { ExtractionResult, UnresolvedReference } from '../types.js';
import type { Edge, EdgeKind, Language, Node, NodeKind } from '../../types.js';
import { createIdFactory, generateNodeId, type NodeIdFactory } from '../tree-sitter-helpers.js';
import type { LanguageDef } from './types.js';
import { luaExtractor } from './lua.js';

type Bg3Language = 'bg3_anubis' | 'bg3_resource' | 'bg3_stats' | 'osiris';

interface SourcePosition {
  line: number;
  column: number;
}

interface PendingRef {
  name: string;
  kind: EdgeKind;
  line: number;
  column: number;
}

interface ReferenceArgs {
  fromNodeId: string;
  rawName: string;
  kind: EdgeKind;
  line: number;
  column: number;
}

interface Bg3Context {
  filePath: string;
  source: string;
  language: Bg3Language;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionResult['errors'];
  idFactory: NodeIdFactory;
  lineStarts: number[];
  fileNode: Node;
  seenRefs: Set<string>;
}

interface Bg3Field {
  name: string;
  value: string;
  type?: string;
  handle?: string;
  line: number;
  column: number;
}

interface XmlObjectContext {
  tagName: 'node' | 'stat_object';
  nodeId: string;
  fields: Map<string, Bg3Field>;
  pendingRefs: PendingRef[];
  containerId: string;
  startLine: number;
  startColumn: number;
}

interface ParsedXmlTag {
  tagName: string;
  attrsRaw: string;
  closing: boolean;
  selfClosing: boolean;
  index: number;
}

interface XmlParseState {
  objectStack: XmlObjectContext[];
  regionStack: string[];
}

interface QuotedValue {
  value: string;
  start: number;
  raw: string;
}

interface JsonVisitContext {
  ctx: Bg3Context;
  containerId: string;
  keyHint: string;
}

interface XmlAttributeKey {
  key: string;
  end: number;
}

interface XmlAttributeValue {
  value: string;
  end: number;
}

interface LocalizationCandidate {
  open: number;
  tagEnd: number;
  tag: ParsedXmlTag | null;
}

interface LocalizationBody {
  rawText: string;
  nextCursor: number;
}

interface LocalizationSource {
  safeSource: string;
  lowerSource: string;
}

interface LocalizationNodeArgs {
  handle: string;
  text: string;
  index: number;
}

const UUID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
const ZERO_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/i;
const GUIDSTRING_RE = /\b[A-Za-z_]\w*_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
const HANDLE_RE = /\b[Hh][0-9A-Fa-fGg]{12,}\b/g;

const NON_SYMBOL_NODE_IDS = new Set(['root', 'children', 'Tags', 'SubClasses', 'SubClass', 'Object']);
const GENERIC_XML_RESOURCE_TAGS = new Set([
  'effect',
  'component',
  'MultiEffectInfos',
  'EffectInfo',
  'trackgroup',
  'track',
]);
const NAME_FIELD_ORDER = ['NameFS', 'Name', 'Folder', 'RuleName', 'SelectorId', 'UUID'];
const DEFINING_FIELD_NAMES = new Set([
  'UUID',
  'Name',
  'NameFS',
  'Folder',
  'RuleName',
  'SelectorId',
  'DisplayName',
  'Description',
  'Text',
]);
const REFERENCE_FIELD_MARKERS = [
  'uuid',
  'guid',
  'template',
  'spell',
  'passive',
  'status',
  'boost',
  'functor',
  'selector',
  'list',
  'table',
  'using',
  'parent',
  'root',
  'resource',
  'effect',
  'icon',
  'tag',
  'equipment',
  'weapon',
  'race',
  'class',
  'actionresource',
  'requirement',
  'condition',
  'event',
  'cost',
  'propert',
  'data',
  'handle',
];
const REFERENCE_TYPE_MARKERS = ['guidobject', 'statreference', 'baseclass', 'translatedstring'];
const EXTENDS_FIELD_NAMES = new Set(['using', 'parent', 'parentguid']);
const QUOTE_CHARS = new Set(['"', "'"]);
const ASCII_UPPER_A = 'A'.codePointAt(0) ?? 0;
const ASCII_UPPER_Z = 'Z'.codePointAt(0) ?? 0;
const ASCII_LOWER_A = 'a'.codePointAt(0) ?? 0;
const ASCII_LOWER_Z = 'z'.codePointAt(0) ?? 0;
const ASCII_DIGIT_0 = '0'.codePointAt(0) ?? 0;
const ASCII_DIGIT_9 = '9'.codePointAt(0) ?? 0;
const CONTENT_CLOSE_PREFIX_LENGTH = '</content'.length;
const LOCALIZATION_SNIPPET_LENGTH = 120;
const VALUE_STOPWORDS = new Set([
  'Add',
  'Always',
  'AND',
  'Bool',
  'Boolean',
  'False',
  'IF',
  'Integer',
  'LSString',
  'NOT',
  'None',
  'NULL',
  'Object',
  'OR',
  'Remove',
  'SELF',
  'Source',
  'String',
  'Target',
  'THEN',
  'True',
  'Version',
  'and',
  'bool',
  'clear',
  'context',
  'false',
  'float',
  'guid',
  'int32',
  'int64',
  'lod',
  'not',
  'null',
  'off',
  'on',
  'or',
  'self',
  'source',
  'target',
  'true',
  'uint32',
  'uint64',
  'uint8',
  'value',
  'version',
]);

function createLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.codePointAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionAt(ctx: Bg3Context, index: number): SourcePosition {
  let lo = 0;
  let hi = ctx.lineStarts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = ctx.lineStarts[mid] ?? 0;
    if (start <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  const lineIdx = Math.max(0, hi);
  return { line: lineIdx + 1, column: index - (ctx.lineStarts[lineIdx] ?? 0) };
}

function createContext(filePath: string, source: string, language: Bg3Language): Bg3Context {
  const nodes: Node[] = [];
  const lines = source.split('\n');
  const fileNode: Node = {
    id: generateNodeId({ filePath, kind: 'file', name: filePath, ordinal: 0 }),
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language: language as Language,
    startLine: 1,
    endLine: lines.length,
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    updatedAt: Date.now(),
  };
  nodes.push(fileNode);
  return {
    filePath,
    source,
    language,
    nodes,
    edges: [],
    unresolvedReferences: [],
    errors: [],
    idFactory: createIdFactory(filePath),
    lineStarts: createLineStarts(source),
    fileNode,
    seenRefs: new Set(),
  };
}

function finish(ctx: Bg3Context, startTime: number): ExtractionResult {
  return {
    nodes: ctx.nodes,
    edges: ctx.edges,
    unresolvedReferences: ctx.unresolvedReferences,
    errors: ctx.errors,
    durationMs: Date.now() - startTime,
  };
}

function createNode(
  ctx: Bg3Context,
  args: {
    kind: NodeKind;
    name: string;
    startLine: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    signature?: string;
    qualifiedName?: string;
    containerId?: string;
  },
): Node {
  const id = ctx.idFactory.next(args.kind, args.name);
  const node: Node = {
    id,
    kind: args.kind,
    name: args.name,
    qualifiedName: args.qualifiedName ?? `${ctx.filePath}::${args.name}`,
    filePath: ctx.filePath,
    language: ctx.language as Language,
    startLine: args.startLine,
    endLine: args.endLine ?? args.startLine,
    startColumn: args.startColumn ?? 0,
    endColumn: args.endColumn ?? (args.startColumn ?? 0) + args.name.length,
    updatedAt: Date.now(),
  };
  if (args.signature !== undefined) node.signature = args.signature;
  ctx.nodes.push(node);
  ctx.edges.push({ source: args.containerId ?? ctx.fileNode.id, target: id, kind: 'contains' });
  return node;
}

function addReference(ctx: Bg3Context, ref: ReferenceArgs): void {
  const name = normalizeReferenceName(ref.rawName);
  if (!name) return;
  const key = `${ref.fromNodeId}\0${ref.kind}\0${name}`;
  if (ctx.seenRefs.has(key)) return;
  ctx.seenRefs.add(key);
  ctx.unresolvedReferences.push({
    fromNodeId: ref.fromNodeId,
    referenceName: name,
    referenceKind: ref.kind,
    line: ref.line,
    column: ref.column,
    filePath: ctx.filePath,
    language: ctx.language as Language,
  });
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\uFEFF';
}

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) || (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z);
}

function isDigitChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= ASCII_DIGIT_0 && code <= ASCII_DIGIT_9;
}

function isIdentifierStartChar(ch: string | undefined): boolean {
  return isAsciiLetter(ch) || ch === '_';
}

function isIdentifierBodyChar(ch: string | undefined, extra = ''): boolean {
  return isIdentifierStartChar(ch) || isDigitChar(ch) || (!!ch && extra.includes(ch));
}

function isQualifiedIdentifier(value: string, extra = ':.'): boolean {
  if (!isIdentifierStartChar(value[0])) return false;
  for (let i = 1; i < value.length; i++) {
    if (!isIdentifierBodyChar(value[i], extra)) return false;
  }
  return true;
}

function hasMatchingQuotePair(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  if (!first) return false;
  if (!QUOTE_CHARS.has(first)) return false;
  return first === value.at(-1);
}

function trimMatchingQuotes(value: string): string {
  if (!hasMatchingQuotePair(value)) return value;
  return value.slice(1, -1);
}

function normalizeReferenceName(rawName: string): string | null {
  const name = trimMatchingQuotes(decodeXmlEntities(rawName).trim());
  if (!name || name.length < 2) return null;
  if (ZERO_UUID_RE.test(name)) return null;
  if (VALUE_STOPWORDS.has(name)) return null;
  if (isBg3ResourceIdentifier(name)) return name;
  if (!isQualifiedIdentifier(name)) return null;
  return name;
}

function resetBg3ResourceRegexes(): void {
  GUIDSTRING_RE.lastIndex = 0;
  UUID_RE.lastIndex = 0;
  HANDLE_RE.lastIndex = 0;
}

function isBg3ResourceIdentifier(value: string): boolean {
  resetBg3ResourceRegexes();
  const matched = GUIDSTRING_RE.test(value) || UUID_RE.test(value) || HANDLE_RE.test(value);
  resetBg3ResourceRegexes();
  return matched;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function blankNonNewlines(value: string): string {
  let out = '';
  for (const ch of value) out += ch === '\n' ? '\n' : ' ';
  return out;
}

function stripXmlComments(source: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<!--', cursor);
    if (open < 0) {
      out += source.slice(cursor);
      break;
    }
    out += source.slice(cursor, open);
    const close = source.indexOf('-->', open + 4);
    const end = close < 0 ? source.length : close + 3;
    out += blankNonNewlines(source.slice(open, end));
    cursor = end;
  }
  return out;
}

function parseXmlTag(raw: string, index: number): ParsedXmlTag | null {
  let cursor = 0;
  while (isWhitespaceChar(raw[cursor])) cursor++;
  let closing = false;
  if (raw[cursor] === '/') {
    closing = true;
    cursor++;
    while (isWhitespaceChar(raw[cursor])) cursor++;
  }
  if (raw[cursor] === '?' || raw[cursor] === '!') return null;
  const nameStart = cursor;
  while (cursor < raw.length && !isWhitespaceChar(raw[cursor]) && raw[cursor] !== '/') cursor++;
  const tagName = raw.slice(nameStart, cursor);
  if (!tagName) return null;
  const attrsRaw = raw.slice(cursor);
  return {
    tagName,
    attrsRaw,
    closing,
    selfClosing: !closing && raw.trimEnd().endsWith('/'),
    index,
  };
}

function* parseXmlTags(source: string): Iterable<ParsedXmlTag> {
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) return;
    const close = source.indexOf('>', open + 1);
    if (close < 0) return;
    const tag = parseXmlTag(source.slice(open + 1, close), open);
    if (tag) yield tag;
    cursor = close + 1;
  }
}

function skipXmlAttributeGap(rawAttrs: string, cursor: number): number {
  while (isWhitespaceChar(rawAttrs[cursor]) || rawAttrs[cursor] === '/') cursor++;
  return cursor;
}

function readXmlAttributeKey(rawAttrs: string, cursor: number): XmlAttributeKey | null {
  const start = cursor;
  while (
    cursor < rawAttrs.length &&
    !isWhitespaceChar(rawAttrs[cursor]) &&
    rawAttrs[cursor] !== '=' &&
    rawAttrs[cursor] !== '/'
  ) {
    cursor++;
  }
  const key = rawAttrs.slice(start, cursor);
  return key ? { key, end: cursor } : null;
}

function readQuotedXmlAttribute(rawAttrs: string, cursor: number, quote: string): XmlAttributeValue {
  const valueStart = cursor + 1;
  const valueEnd = rawAttrs.indexOf(quote, valueStart);
  if (valueEnd < 0) {
    return { value: rawAttrs.slice(valueStart), end: rawAttrs.length };
  }
  return { value: rawAttrs.slice(valueStart, valueEnd), end: valueEnd + 1 };
}

function readBareXmlAttribute(rawAttrs: string, cursor: number): XmlAttributeValue {
  const valueStart = cursor;
  while (cursor < rawAttrs.length && !isWhitespaceChar(rawAttrs[cursor]) && rawAttrs[cursor] !== '/') cursor++;
  return { value: rawAttrs.slice(valueStart, cursor), end: cursor };
}

function readXmlAttributeValue(rawAttrs: string, cursor: number): XmlAttributeValue {
  cursor = skipWhitespace(rawAttrs, cursor);
  const quote = rawAttrs[cursor];
  if (quote && QUOTE_CHARS.has(quote)) return readQuotedXmlAttribute(rawAttrs, cursor, quote);
  return readBareXmlAttribute(rawAttrs, cursor);
}

function parseXmlAttributes(rawAttrs: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let cursor = 0;
  while (cursor < rawAttrs.length) {
    cursor = skipXmlAttributeGap(rawAttrs, cursor);
    const key = readXmlAttributeKey(rawAttrs, cursor);
    if (!key) break;
    cursor = skipWhitespace(rawAttrs, key.end);
    if (rawAttrs[cursor] !== '=') {
      attrs.set(key.key, '');
      continue;
    }
    const value = readXmlAttributeValue(rawAttrs, cursor + 1);
    attrs.set(key.key, decodeXmlEntities(value.value));
    cursor = value.end;
  }
  return attrs;
}

function lowerFieldMap(fields: Map<string, Bg3Field>): Map<string, Bg3Field> {
  const out = new Map<string, Bg3Field>();
  for (const field of fields.values()) out.set(field.name.toLowerCase(), field);
  return out;
}

function includesAnyMarker(value: string, markers: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

function isReferenceFieldName(name: string): boolean {
  return includesAnyMarker(name, REFERENCE_FIELD_MARKERS);
}

function isGeneratedStatName(value: string): boolean {
  const prefix = 'New_Stat_';
  if (!value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return suffix.length > 0 && [...suffix].every(isDigitChar);
}

function selectDefinitionName(
  fields: Map<string, Bg3Field>,
  nodeId: string,
): { name: string | null; uuid: string | null } {
  const byLower = lowerFieldMap(fields);
  const nameFs = byLower.get('namefs')?.value.trim();
  if (nameFs) return { name: nameFs, uuid: byLower.get('uuid')?.value.trim() || null };

  for (const fieldName of NAME_FIELD_ORDER) {
    const value = byLower.get(fieldName.toLowerCase())?.value.trim();
    if (!value) continue;
    if (fieldName === 'Name' && isGeneratedStatName(value)) continue;
    if (fieldName === 'UUID' && ZERO_UUID_RE.test(value)) continue;
    return { name: value, uuid: byLower.get('uuid')?.value.trim() || null };
  }

  if (nodeId && !NON_SYMBOL_NODE_IDS.has(nodeId) && fields.size > 0) {
    return { name: nodeId, uuid: byLower.get('uuid')?.value.trim() || null };
  }
  return { name: null, uuid: byLower.get('uuid')?.value.trim() || null };
}

function fieldFromTag(attrs: Map<string, string>, tagName: string, pos: SourcePosition): Bg3Field | null {
  const name = attrs.get(tagName === 'field' ? 'name' : 'id');
  if (!name) return null;
  const value = attrs.get('value') ?? attrs.get('handle') ?? '';
  const field: Bg3Field = {
    name,
    value,
    line: pos.line,
    column: pos.column,
  };
  const type = attrs.get('type');
  const handle = attrs.get('handle');
  if (type !== undefined) field.type = type;
  if (handle !== undefined) field.handle = handle;
  return field;
}

function shouldScanField(field: Bg3Field): boolean {
  if (!field.value && !field.handle) return false;
  if (field.handle) return true;
  if (isBg3ResourceIdentifier(field.value)) return true;
  if (field.type && includesAnyMarker(field.type, REFERENCE_TYPE_MARKERS)) return true;
  if (isReferenceFieldName(field.name)) return true;
  return (
    field.value.includes('(') || field.value.includes(')') || field.value.includes('|') || field.value.includes(';')
  );
}

function referenceKindForField(field: Bg3Field): EdgeKind {
  return EXTENDS_FIELD_NAMES.has(field.name.toLowerCase()) ? 'extends' : 'references';
}

function pendingRefsForField(field: Bg3Field): PendingRef[] {
  const refs: PendingRef[] = [];
  if (field.handle) {
    refs.push({ name: field.handle, kind: 'references', line: field.line, column: field.column });
  }
  if (!shouldScanField(field)) return refs;
  for (const token of extractReferenceTokens(field.value)) {
    if (DEFINING_FIELD_NAMES.has(field.name) && token === field.value) continue;
    refs.push({ name: token, kind: referenceKindForField(field), line: field.line, column: field.column });
  }
  return refs;
}

function extractReferenceTokens(value: string): string[] {
  const decoded = decodeXmlEntities(value);
  const out = new Set<string>();
  for (const match of decoded.matchAll(GUIDSTRING_RE)) {
    const token = normalizeReferenceName(match[0]);
    if (token) out.add(token);
  }
  for (const match of decoded.matchAll(UUID_RE)) {
    const token = normalizeReferenceName(match[0]);
    if (token) out.add(token);
  }
  for (const match of decoded.matchAll(HANDLE_RE)) {
    const token = normalizeReferenceName(match[0]);
    if (token) out.add(token);
  }
  for (const match of extractIdentifierTokens(decoded, ':.')) {
    const token = normalizeReferenceName(match.value);
    if (!token) continue;
    if (isShortLowercaseWord(token)) continue;
    out.add(token);
  }
  resetBg3ResourceRegexes();
  return [...out];
}

function extractIdentifierTokens(value: string, extra = ''): QuotedValue[] {
  const tokens: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (!isIdentifierStartChar(value[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor++;
    while (cursor < value.length && isIdentifierBodyChar(value[cursor], extra)) cursor++;
    const token = value.slice(start, cursor);
    tokens.push({ value: token, start, raw: token });
  }
  return tokens;
}

function isShortLowercaseWord(value: string): boolean {
  return (
    value.length < 8 &&
    [...value].every((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z;
    })
  );
}

function signatureForXmlObject(obj: XmlObjectContext): string {
  const type = obj.fields.get('type')?.value || obj.fields.get('Type')?.value;
  const uuid = lowerFieldMap(obj.fields).get('uuid')?.value;
  const parts = [obj.tagName === 'stat_object' ? 'stat_object' : `node ${obj.nodeId}`];
  if (type) parts.push(`type=${type}`);
  if (uuid && !ZERO_UUID_RE.test(uuid)) parts.push(`uuid=${uuid}`);
  return parts.join(' ');
}

function collectObjectRefs(obj: XmlObjectContext): PendingRef[] {
  const refs = [...obj.pendingRefs];
  for (const field of obj.fields.values()) refs.push(...pendingRefsForField(field));
  return refs;
}

function finalizeXmlObject(ctx: Bg3Context, obj: XmlObjectContext, parent: XmlObjectContext | undefined): void {
  const refs = collectObjectRefs(obj);
  const { name, uuid } = selectDefinitionName(obj.fields, obj.nodeId);
  const onlyObjectRef = obj.fields.size === 1 && lowerFieldMap(obj.fields).has('object');

  if (!name || onlyObjectRef || NON_SYMBOL_NODE_IDS.has(name)) {
    if (parent) parent.pendingRefs.push(...refs);
    else {
      for (const ref of refs) {
        addReference(ctx, {
          fromNodeId: ctx.fileNode.id,
          rawName: ref.name,
          kind: ref.kind,
          line: ref.line,
          column: ref.column,
        });
      }
    }
    return;
  }

  const qualifiedName = uuid && !ZERO_UUID_RE.test(uuid) ? uuid : `${ctx.filePath}::${name}`;
  const node = createNode(ctx, {
    kind: 'resource',
    name,
    qualifiedName,
    signature: signatureForXmlObject(obj),
    startLine: obj.startLine,
    startColumn: obj.startColumn,
    containerId: obj.containerId,
  });
  for (const ref of refs) {
    addReference(ctx, {
      fromNodeId: node.id,
      rawName: ref.name,
      kind: ref.kind,
      line: ref.line,
      column: ref.column,
    });
  }
}

function emitGenericXmlResource(ctx: Bg3Context, tag: ParsedXmlTag): void {
  const attrs = parseXmlAttributes(tag.attrsRaw);
  const pos = positionAt(ctx, tag.index);
  const rawName =
    attrs.get('Name') ??
    attrs.get('name') ??
    attrs.get('instancename') ??
    attrs.get('UUID') ??
    attrs.get('id') ??
    path.basename(ctx.filePath, path.extname(ctx.filePath));
  const name = normalizeReferenceName(rawName) ?? path.basename(ctx.filePath, path.extname(ctx.filePath));
  const uuid = attrs.get('UUID') ?? attrs.get('id');
  const qualifiedName = uuid && !ZERO_UUID_RE.test(uuid) ? uuid : `${ctx.filePath}::${name}`;
  const className = attrs.get('class');
  const node = createNode(ctx, {
    kind: 'resource',
    name,
    qualifiedName,
    signature: className ? `<${tag.tagName}> class=${className}` : `<${tag.tagName}>`,
    startLine: pos.line,
    startColumn: pos.column,
  });

  for (const [key, value] of attrs) {
    if (['Name', 'name', 'UUID', 'id', 'instancename', 'class'].includes(key)) continue;
    if (!isReferenceFieldName(key) && !isBg3ResourceIdentifier(value)) continue;
    for (const token of extractReferenceTokens(value)) {
      addReference(ctx, {
        fromNodeId: node.id,
        rawName: token,
        kind: 'references',
        line: pos.line,
        column: pos.column,
      });
    }
  }
}

function collapseWhitespace(value: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of value) {
    if (isWhitespaceChar(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    out += ch;
    pendingSpace = false;
  }
  return out.trim();
}

function stripMarkupText(value: string): string {
  let out = '';
  let inTag = false;
  for (const ch of value) {
    if (ch === '<') {
      inTag = true;
      out += ' ';
      continue;
    }
    if (ch === '>') {
      inTag = false;
      out += ' ';
      continue;
    }
    if (!inTag) out += ch;
  }
  return collapseWhitespace(out);
}

function nextLocalizationCandidate(
  safeSource: string,
  lowerSource: string,
  cursor: number,
): LocalizationCandidate | null {
  const open = lowerSource.indexOf('<content', cursor);
  if (open < 0) return null;
  const tagEnd = safeSource.indexOf('>', open + 1);
  if (tagEnd < 0) return null;
  return {
    open,
    tagEnd,
    tag: parseXmlTag(safeSource.slice(open + 1, tagEnd), open),
  };
}

function isLocalizationContentTag(tag: ParsedXmlTag | null): tag is ParsedXmlTag {
  if (!tag) return false;
  if (tag.closing) return false;
  return tag.tagName.toLowerCase() === 'content';
}

function localizationBody(source: LocalizationSource, tag: ParsedXmlTag, cursor: number): LocalizationBody {
  if (tag.selfClosing) return { rawText: '', nextCursor: cursor };
  const close = source.lowerSource.indexOf('</content', cursor);
  if (close < 0) return { rawText: '', nextCursor: cursor };
  const closeEnd = source.safeSource.indexOf('>', close + 1);
  return {
    rawText: source.safeSource.slice(cursor, close),
    nextCursor: closeEnd < 0 ? close + CONTENT_CLOSE_PREFIX_LENGTH : closeEnd + 1,
  };
}

function localizationSignature(text: string): string {
  if (!text) return 'localized content';
  return `localized content: ${text.slice(0, LOCALIZATION_SNIPPET_LENGTH)}`;
}

function createLocalizationNode(ctx: Bg3Context, args: LocalizationNodeArgs): void {
  const pos = positionAt(ctx, args.index);
  createNode(ctx, {
    kind: 'resource',
    name: args.handle,
    qualifiedName: args.handle,
    signature: localizationSignature(args.text),
    startLine: pos.line,
    startColumn: pos.column,
  });
}

function extractLocalizationContent(ctx: Bg3Context, safeSource: string): void {
  const source = { safeSource, lowerSource: safeSource.toLowerCase() };
  let cursor = 0;
  while (cursor < safeSource.length) {
    const candidate = nextLocalizationCandidate(source.safeSource, source.lowerSource, cursor);
    if (!candidate) return;
    cursor = candidate.tagEnd + 1;
    if (!isLocalizationContentTag(candidate.tag)) continue;
    const attrs = parseXmlAttributes(candidate.tag.attrsRaw);
    const handle = attrs.get('contentuid');
    if (!handle) continue;
    const body = localizationBody(source, candidate.tag, cursor);
    cursor = body.nextCursor;
    createLocalizationNode(ctx, {
      handle,
      text: decodeXmlEntities(stripMarkupText(body.rawText)),
      index: candidate.open,
    });
  }
}

function handleXmlRegionTag(ctx: Bg3Context, tag: ParsedXmlTag, regionStack: string[]): boolean {
  if (tag.tagName !== 'region') return false;
  if (tag.closing) {
    if (regionStack.length > 1) regionStack.pop();
    return true;
  }
  const attrs = parseXmlAttributes(tag.attrsRaw);
  const id = attrs.get('id');
  if (!id) return true;
  const pos = positionAt(ctx, tag.index);
  const region = createNode(ctx, {
    kind: 'namespace',
    name: id,
    qualifiedName: `${ctx.filePath}::${id}`,
    signature: '<region>',
    startLine: pos.line,
    startColumn: pos.column,
    containerId: regionStack.at(-1) ?? ctx.fileNode.id,
  });
  if (!tag.selfClosing) regionStack.push(region.id);
  return true;
}

function handleXmlObjectTag(ctx: Bg3Context, tag: ParsedXmlTag, state: XmlParseState): boolean {
  if (tag.tagName !== 'node' && tag.tagName !== 'stat_object') return false;
  if (tag.closing) {
    const obj = state.objectStack.pop();
    if (obj) finalizeXmlObject(ctx, obj, state.objectStack.at(-1));
    return true;
  }
  const attrs = parseXmlAttributes(tag.attrsRaw);
  const pos = positionAt(ctx, tag.index);
  const obj: XmlObjectContext = {
    tagName: tag.tagName,
    nodeId: attrs.get('id') ?? tag.tagName,
    fields: new Map(),
    pendingRefs: [],
    containerId: state.regionStack.at(-1) ?? ctx.fileNode.id,
    startLine: pos.line,
    startColumn: pos.column,
  };
  state.objectStack.push(obj);
  if (tag.selfClosing) {
    const closed = state.objectStack.pop();
    if (closed) finalizeXmlObject(ctx, closed, state.objectStack.at(-1));
  }
  return true;
}

function handleXmlFieldTag(ctx: Bg3Context, tag: ParsedXmlTag, stack: XmlObjectContext[]): boolean {
  if (tag.closing || (tag.tagName !== 'attribute' && tag.tagName !== 'field')) return false;
  const current = stack.at(-1);
  if (!current) return true;
  const field = fieldFromTag(parseXmlAttributes(tag.attrsRaw), tag.tagName, positionAt(ctx, tag.index));
  if (field) current.fields.set(field.name, field);
  return true;
}

function handleGenericXmlTag(ctx: Bg3Context, tag: ParsedXmlTag): void {
  if (tag.closing || !GENERIC_XML_RESOURCE_TAGS.has(tag.tagName)) return;
  emitGenericXmlResource(ctx, tag);
}

function extractXmlResource(ctx: Bg3Context): void {
  const safeSource = stripXmlComments(ctx.source);
  extractLocalizationContent(ctx, safeSource);

  const state: XmlParseState = { objectStack: [], regionStack: [ctx.fileNode.id] };
  for (const tag of parseXmlTags(safeSource)) {
    if (handleXmlRegionTag(ctx, tag, state.regionStack)) continue;
    if (handleXmlObjectTag(ctx, tag, state)) continue;
    if (handleXmlFieldTag(ctx, tag, state.objectStack)) continue;
    handleGenericXmlTag(ctx, tag);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function addJsonStringReferences(ctx: Bg3Context, value: string, containerId: string): void {
  const pos = positionAt(ctx, Math.max(0, ctx.source.indexOf(value)));
  for (const token of extractReferenceTokens(value)) {
    addReference(ctx, {
      fromNodeId: containerId,
      rawName: token,
      kind: 'references',
      line: pos.line,
      column: pos.column,
    });
  }
}

function createJsonResourceNode(visit: JsonVisitContext, object: Record<string, unknown>): Node | null {
  const name =
    stringValue(object['Name']) ??
    stringValue(object['NameFS']) ??
    stringValue(object['name']) ??
    stringValue(object['UUID']) ??
    stringValue(object['Guid']) ??
    stringValue(object['id']);
  if (!name) return null;
  const uuid = stringValue(object['UUID']) ?? stringValue(object['Guid']) ?? stringValue(object['id']);
  const { ctx } = visit;
  const pos = positionAt(ctx, Math.max(0, ctx.source.indexOf(name)));
  return createNode(ctx, {
    kind: 'resource',
    name,
    qualifiedName: uuid && !ZERO_UUID_RE.test(uuid) ? uuid : `${ctx.filePath}::${name}`,
    signature: visit.keyHint,
    startLine: pos.line,
    startColumn: pos.column,
    containerId: visit.containerId,
  });
}

function visitJsonArray(values: unknown[], visit: JsonVisitContext): void {
  for (const [idx, child] of values.entries()) {
    visitJsonValue(child, { ...visit, keyHint: `${visit.keyHint}[${idx}]` });
  }
}

function visitJsonObject(object: Record<string, unknown>, visit: JsonVisitContext): void {
  const node = createJsonResourceNode(visit, object);
  const nextVisit = { ...visit, containerId: node?.id ?? visit.containerId };
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === 'string' && !DEFINING_FIELD_NAMES.has(key)) {
      addJsonStringReferences(visit.ctx, child, nextVisit.containerId);
      continue;
    }
    visitJsonValue(child, { ...nextVisit, keyHint: key });
  }
}

function visitJsonValue(value: unknown, visit: JsonVisitContext): void {
  if (Array.isArray(value)) {
    visitJsonArray(value, visit);
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') addJsonStringReferences(visit.ctx, value, visit.containerId);
    return;
  }
  visitJsonObject(value as Record<string, unknown>, visit);
}

function extractJsonResource(ctx: Bg3Context): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.source);
  } catch {
    return false;
  }
  visitJsonValue(parsed, { ctx, containerId: ctx.fileNode.id, keyHint: 'lsj' });
  return true;
}

function looksLikeJsonResource(source: string): boolean {
  const trimmed = source.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function extractBg3Resource(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const ctx = createContext(filePath, source, 'bg3_resource');
  if (source.includes('\u0000')) {
    ctx.errors.push({
      message: 'Skipped binary BG3 resource payload; only text-converted resources are parsed',
      filePath,
      severity: 'warning',
      code: 'binary_bg3_resource',
    });
    return finish(ctx, startTime);
  }

  if (path.extname(filePath).toLowerCase() === '.lsj' || looksLikeJsonResource(source)) {
    if (extractJsonResource(ctx)) return finish(ctx, startTime);
  }

  extractXmlResource(ctx);
  return finish(ctx, startTime);
}

const STATS_NEW_SHAPES = new Set(['entry', 'spellset', 'equipment', 'treasuretable']);

function skipWhitespace(value: string, cursor: number): number {
  while (isWhitespaceChar(value[cursor])) cursor++;
  return cursor;
}

function readWord(value: string, cursor: number): { word: string; start: number; end: number } | null {
  cursor = skipWhitespace(value, cursor);
  const start = cursor;
  while (cursor < value.length && isIdentifierBodyChar(value[cursor])) cursor++;
  if (cursor === start) return null;
  return { word: value.slice(start, cursor), start, end: cursor };
}

function extractQuotedValues(line: string): QuotedValue[] {
  const values: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const quote = line[cursor];
    if (quote !== '"' && quote !== "'") {
      cursor++;
      continue;
    }
    const start = cursor + 1;
    cursor = start;
    while (cursor < line.length && line[cursor] !== quote) {
      if (line[cursor] === '\\' && cursor + 1 < line.length) cursor++;
      cursor++;
    }
    const end = cursor;
    values.push({ value: line.slice(start, end), start, raw: line.slice(start - 1, Math.min(line.length, end + 1)) });
    cursor = end + 1;
  }
  return values;
}

function commandWord(line: string): { command: string; end: number } | null {
  const word = readWord(line, 0);
  return word ? { command: word.word.toLowerCase(), end: word.end } : null;
}

function parseStatsNew(line: string): { shape: string; name: string; start: number } | null {
  const command = commandWord(line);
  if (command?.command !== 'new') return null;
  const shape = readWord(line, command.end);
  if (!shape || !STATS_NEW_SHAPES.has(shape.word.toLowerCase())) return null;
  const quoted = extractQuotedValues(line).find((value) => value.start > shape.end);
  return quoted ? { shape: shape.word, name: quoted.value, start: quoted.start } : null;
}

function parseStatsQuotedCommand(line: string, commandName: string): QuotedValue | null {
  const command = commandWord(line);
  if (command?.command !== commandName) return null;
  return extractQuotedValues(line).find((value) => value.start > command.end) ?? null;
}

function parseStatsData(line: string): { name: string; value: string; valueStart: number } | null {
  const command = commandWord(line);
  if (command?.command !== 'data') return null;
  const quoted = extractQuotedValues(line).filter((value) => value.start > command.end);
  const [name, value] = quoted;
  return name && value ? { name: name.value, value: value.value, valueStart: value.start } : null;
}

function parseStatsObjectCategory(line: string): QuotedValue | null {
  const command = commandWord(line);
  if (command?.command !== 'object') return null;
  const category = readWord(line, command.end);
  if (category?.word.toLowerCase() !== 'category') return null;
  return extractQuotedValues(line).find((value) => value.start > category.end) ?? null;
}

function stripLineComment(line: string, marker: string): string {
  const index = line.indexOf(marker);
  return index < 0 ? line : line.slice(0, index);
}

function startsWithWordIgnoreCase(line: string, word: string): boolean {
  const first = readWord(line, 0);
  return first?.word.toLowerCase() === word.toLowerCase();
}

function extractBg3Stats(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const ctx = createContext(filePath, source, 'bg3_stats');
  let current: Node | null = null;

  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const newStats = parseStatsNew(line);
    if (newStats) {
      current = createNode(ctx, {
        kind: 'resource',
        name: newStats.name,
        qualifiedName: `${ctx.filePath}::${newStats.name}`,
        signature: `new ${newStats.shape}`,
        startLine: lineNumber,
        startColumn: newStats.start,
      });
      return;
    }

    const typeValue = parseStatsQuotedCommand(line, 'type');
    if (typeValue && current) {
      current.signature = `${current.signature ?? 'entry'} type=${typeValue.value}`;
      return;
    }

    const usingValue = parseStatsQuotedCommand(line, 'using');
    if (usingValue && current) {
      addReference(ctx, {
        fromNodeId: current.id,
        rawName: usingValue.value,
        kind: 'extends',
        line: lineNumber,
        column: usingValue.start,
      });
      return;
    }

    const data = parseStatsData(line);
    if (data && current) {
      const field: Bg3Field = {
        name: data.name,
        value: data.value,
        line: lineNumber,
        column: data.valueStart,
      };
      for (const ref of pendingRefsForField(field)) {
        addReference(ctx, {
          fromNodeId: current.id,
          rawName: ref.name,
          kind: ref.kind,
          line: ref.line,
          column: ref.column,
        });
      }
      return;
    }

    const addedValue = parseStatsQuotedCommand(line, 'add') ?? parseStatsObjectCategory(line);
    if (addedValue && current) {
      addReference(ctx, {
        fromNodeId: current.id,
        rawName: addedValue.value,
        kind: 'references',
        line: lineNumber,
        column: addedValue.start,
      });
    }
  });

  return finish(ctx, startTime);
}

const ANUBIS_STATE_DEF_RE = /\bgame\.states\.([A-Za-z_]\w*)\s*=\s*State\s*\{/;
const ANUBIS_CONFIG_DEF_RE = /\bgame\.configs\.([A-Za-z_]\w*)\s*=\s*Config\s*\{/;
const ANUBIS_NODE_DEF_RE = /\bnodes(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\s*=\s*(Action|Selector|Proxy)\s*\{/;
const ANUBIS_EVENT_DEF_RE = /\bevents\.([A-Za-z_]\w*)\s*=\s*function\b/;
const ANUBIS_CALLBACK_DEF_RE = /\b(CanEnter|Valid|OnFinished|OnLeave|OnEnter|OnUpdate|OnFailed)\s*=\s*function\b/;
const ANUBIS_DOTTED_REF_RE =
  /\b(?:game\.(?:states|roots|configs)\.[A-Za-z_]\w*|MovementSpeed\.[A-Za-z_]\w*|error\.[A-Za-z_][\w.]*)\b/g;
const ANUBIS_CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const ANUBIS_CALL_SKIP = new Set([
  'and',
  'end',
  'false',
  'function',
  'if',
  'local',
  'nil',
  'not',
  'or',
  'return',
  'then',
  'true',
]);
const ANUBIS_DSL_CONSTRUCTORS = new Set(['Action', 'Config', 'Proxy', 'Selector', 'State']);

interface AnubisState {
  ctx: Bg3Context;
  root: Node;
  currentBehavior: Node | null;
}

interface AnubisRootArgs {
  name: string;
  kind: 'config' | 'state';
  line: string;
  lineNumber: number;
}

interface AnubisBehaviorArgs {
  name: string;
  shape: string;
  line: string;
  lineNumber: number;
}

interface AnubisHandlerArgs {
  name: string;
  signature: string;
  line: string;
  lineNumber: number;
}

function createAnubisState(filePath: string, source: string): AnubisState {
  const ctx = createContext(filePath, source, 'bg3_anubis');
  return { ctx, root: ctx.fileNode, currentBehavior: null };
}

function createAnubisRoot(state: AnubisState, args: AnubisRootArgs): void {
  state.root = createNode(state.ctx, {
    kind: args.kind === 'state' ? 'module' : 'resource',
    name: args.name,
    qualifiedName: `game.${args.kind === 'state' ? 'states' : 'configs'}.${args.name}`,
    signature: args.kind === 'state' ? 'Anubis State' : 'Anubis Config',
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(args.name),
  });
  state.currentBehavior = null;
}

function createAnubisBehavior(state: AnubisState, args: AnubisBehaviorArgs): void {
  state.currentBehavior = createNode(state.ctx, {
    kind: 'method',
    name: args.name,
    qualifiedName: `${state.root.name}::${args.name}`,
    signature: `Anubis ${args.shape}`,
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(args.name),
    containerId: state.root.id,
  });
}

function createAnubisHandler(state: AnubisState, args: AnubisHandlerArgs): void {
  const isEvent = args.name.startsWith('event:');
  const rawName = args.name.startsWith('event:') ? args.name.slice(6) : args.name.slice(9);
  createNode(state.ctx, {
    kind: 'method',
    name: args.name,
    qualifiedName: `${state.root.name}::${args.name}:${args.lineNumber}`,
    signature: args.signature,
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(rawName),
    containerId: isEvent ? state.root.id : (state.currentBehavior?.id ?? state.root.id),
  });
  if (isEvent) state.currentBehavior = null;
}

function handleAnubisDefinition(state: AnubisState, line: string, lineNumber: number): boolean {
  const stateMatch = ANUBIS_STATE_DEF_RE.exec(line);
  if (stateMatch) {
    createAnubisRoot(state, { name: stateMatch[1] ?? '', kind: 'state', line, lineNumber });
    return true;
  }
  const configMatch = ANUBIS_CONFIG_DEF_RE.exec(line);
  if (configMatch) {
    createAnubisRoot(state, { name: configMatch[1] ?? '', kind: 'config', line, lineNumber });
    return true;
  }
  const nodeMatch = ANUBIS_NODE_DEF_RE.exec(line);
  if (nodeMatch) {
    createAnubisBehavior(state, { name: nodeMatch[1] ?? 'nodes', shape: nodeMatch[2] ?? 'Node', line, lineNumber });
    return true;
  }
  return false;
}

function handleAnubisHandler(state: AnubisState, line: string, lineNumber: number): void {
  const eventMatch = ANUBIS_EVENT_DEF_RE.exec(line);
  if (eventMatch) {
    createAnubisHandler(state, {
      name: `event:${eventMatch[1] ?? ''}`,
      signature: 'Anubis event handler',
      line,
      lineNumber,
    });
    return;
  }
  const callbackMatch = ANUBIS_CALLBACK_DEF_RE.exec(line);
  if (callbackMatch) {
    createAnubisHandler(state, {
      name: `callback:${callbackMatch[1] ?? ''}`,
      signature: 'Anubis node callback',
      line,
      lineNumber,
    });
  }
}

function addAnubisCodeRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of line.matchAll(ANUBIS_DOTTED_REF_RE)) {
    addReference(state.ctx, {
      fromNodeId,
      rawName: match[0],
      kind: 'references',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
  for (const match of line.matchAll(GUIDSTRING_RE)) {
    addReference(state.ctx, {
      fromNodeId,
      rawName: match[0],
      kind: 'references',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
}

function shouldKeepAnubisString(value: string): boolean {
  if (isBg3ResourceIdentifier(value)) return true;
  return isQualifiedIdentifier(value, '_.:-');
}

function extractLuaLongBracketValues(line: string): QuotedValue[] {
  const values: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('[[', cursor);
    if (open < 0) return values;
    const close = line.indexOf(']]', open + 2);
    if (close < 0) return values;
    values.push({ value: line.slice(open + 2, close), start: open + 2, raw: line.slice(open, close + 2) });
    cursor = close + 2;
  }
  return values;
}

function extractLuaStringValues(line: string): QuotedValue[] {
  return [...extractQuotedValues(line), ...extractLuaLongBracketValues(line)].sort((a, b) => a.start - b.start);
}

function addAnubisStringRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of extractLuaStringValues(line)) {
    const value = match.value;
    if (!shouldKeepAnubisString(value)) continue;
    for (const token of extractReferenceTokens(value)) {
      addReference(state.ctx, {
        fromNodeId,
        rawName: token,
        kind: 'references',
        line: lineNumber,
        column: match.start,
      });
    }
  }
}

function addAnubisCallRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of line.matchAll(ANUBIS_CALL_RE)) {
    const name = match[1] ?? '';
    if (!name || ANUBIS_CALL_SKIP.has(name) || ANUBIS_DSL_CONSTRUCTORS.has(name)) continue;
    addReference(state.ctx, {
      fromNodeId,
      rawName: name,
      kind: 'calls',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
}

function extractAnubisLine(state: AnubisState, rawLine: string, lineNumber: number): void {
  const line = stripLineComment(rawLine, '--').trim();
  if (!line) return;
  handleAnubisDefinition(state, line, lineNumber);
  handleAnubisHandler(state, line, lineNumber);
  addAnubisCodeRefs(state, line, lineNumber);
  addAnubisStringRefs(state, line, lineNumber);
  addAnubisCallRefs(state, line, lineNumber);
}

function extractAnubis(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const state = createAnubisState(filePath, source);
  const lines = source.split('\n');
  for (const [idx, rawLine] of lines.entries()) {
    extractAnubisLine(state, rawLine, idx + 1);
  }
  return finish(state.ctx, startTime);
}

const OSIRIS_API_DECLARATIONS = new Set(['syscall', 'sysquery', 'call', 'query', 'event']);
const OSIRIS_CONTROL_PREDICATES = new Set(['IF', 'AND', 'NOT']);

type OsirisPendingBlockKind = 'proc' | 'query' | 'rule';

interface OsirisPendingBlock {
  kind: OsirisPendingBlockKind;
  line: number;
}

interface OsirisPredicateReference {
  name: string;
  targetNode: Node;
  lineNumber: number;
  column: number;
}

interface OsirisDbReference {
  name: string;
  line: number;
  column: number;
}

interface OsirisApiDeclaration {
  kind: string;
  name: string;
  rest: string;
}

interface OsirisState {
  ctx: Bg3Context;
  goalName: string;
  goal: Node;
  dbNodes: Map<string, Node>;
  section: Node | null;
  currentRule: Node | null;
  pendingBlock: OsirisPendingBlock | null;
}

function createOsirisState(filePath: string, source: string): OsirisState {
  const ctx = createContext(filePath, source, 'osiris');
  const goalName = path.basename(filePath, path.extname(filePath));
  const goal = createNode(ctx, {
    kind: 'module',
    name: goalName,
    qualifiedName: goalName,
    signature: 'Osiris goal',
    startLine: 1,
    startColumn: 0,
  });
  return {
    ctx,
    goalName,
    goal,
    dbNodes: new Map(),
    section: null,
    currentRule: null,
    pendingBlock: null,
  };
}

function ensureOsirisDbNode(state: OsirisState, ref: OsirisDbReference): Node {
  const existing = state.dbNodes.get(ref.name);
  if (existing) return existing;
  const node = createNode(state.ctx, {
    kind: 'table',
    name: ref.name,
    qualifiedName: ref.name,
    signature: 'Osiris DB',
    startLine: ref.line,
    startColumn: ref.column,
    containerId: state.section?.id ?? state.goal.id,
  });
  state.dbNodes.set(ref.name, node);
  return node;
}

function ensureOsirisBlock(state: OsirisState, firstPredicate: string, line: number): Node {
  if (state.currentRule) return state.currentRule;
  const pending = state.pendingBlock ?? { kind: 'rule', line };
  const label = osirisBlockLabel(pending.kind);
  const signaturePrefix = osirisBlockSignaturePrefix(pending.kind);
  state.currentRule = createNode(state.ctx, {
    kind: 'method',
    name: `${label}:${firstPredicate}`,
    qualifiedName: `${state.goalName}::${label}:${line}`,
    signature: `${signaturePrefix} ${firstPredicate}`,
    startLine: pending.line,
    startColumn: 0,
    containerId: state.section?.id ?? state.goal.id,
  });
  state.pendingBlock = null;
  return state.currentRule;
}

function osirisBlockLabel(kind: OsirisPendingBlockKind): string {
  if (kind === 'query') return 'query';
  return kind === 'proc' ? 'proc' : 'rule';
}

function osirisBlockSignaturePrefix(kind: OsirisPendingBlockKind): string {
  if (kind === 'query') return 'QRY';
  return kind === 'proc' ? 'PROC' : 'IF';
}

function osirisSectionName(line: string): string | null {
  let normalized = line.trim();
  if (normalized.endsWith(':')) normalized = normalized.slice(0, -1).trim();
  const upper = normalized.toUpperCase();
  if (upper === 'INIT' || upper === 'INITSECTION') return 'INIT';
  if (upper === 'KB' || upper === 'KBSECTION') return 'KB';
  if (upper === 'EXIT' || upper === 'EXITSECTION') return 'EXIT';
  return null;
}

function handleOsirisSection(state: OsirisState, line: string, lineNumber: number): boolean {
  if (startsWithWordIgnoreCase(line, 'ENDEXITSECTION')) {
    state.currentRule = null;
    state.pendingBlock = null;
    return true;
  }
  const name = osirisSectionName(line);
  if (!name) return false;
  state.currentRule = null;
  state.pendingBlock = null;
  state.section = createNode(state.ctx, {
    kind: 'namespace',
    name,
    qualifiedName: `${state.goalName}::${name}`,
    signature: 'Osiris section',
    startLine: lineNumber,
    startColumn: 0,
    containerId: state.goal.id,
  });
  return true;
}

function handleOsirisRuleControl(state: OsirisState, line: string, lineNumber: number): boolean {
  if (startsWithWordIgnoreCase(line, 'IF')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'rule', line: lineNumber };
    return true;
  }
  if (startsWithWordIgnoreCase(line, 'PROC')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'proc', line: lineNumber };
    return true;
  }
  if (startsWithWordIgnoreCase(line, 'QRY')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'query', line: lineNumber };
    return true;
  }
  return startsWithWordIgnoreCase(line, 'THEN');
}

function addOsirisPredicateReference(state: OsirisState, ref: OsirisPredicateReference): void {
  if (ref.name.startsWith('DB_')) {
    ensureOsirisDbNode(state, { name: ref.name, line: ref.lineNumber, column: ref.column });
    addReference(state.ctx, {
      fromNodeId: ref.targetNode.id,
      rawName: ref.name,
      kind: 'references',
      line: ref.lineNumber,
      column: ref.column,
    });
    return;
  }
  addReference(state.ctx, {
    fromNodeId: ref.targetNode.id,
    rawName: ref.name,
    kind: 'calls',
    line: ref.lineNumber,
    column: ref.column,
  });
}

function extractOsirisPredicates(state: OsirisState, line: string, lineNumber: number): void {
  const fromNode = state.currentRule ?? state.goal;
  for (const predicate of extractFunctionLikeNames(line)) {
    const name = predicate.value;
    if (OSIRIS_CONTROL_PREDICATES.has(name)) continue;
    const pendingBlock = state.pendingBlock;
    const targetNode = pendingBlock ? ensureOsirisBlock(state, name, lineNumber) : fromNode;
    if (pendingBlock && pendingBlock.kind !== 'rule') continue;
    addOsirisPredicateReference(state, { name, targetNode, lineNumber, column: predicate.start });
  }
}

function extractOsirisStringRefs(state: OsirisState, line: string, lineNumber: number): void {
  for (const match of extractQuotedValues(line)) {
    const targetNode = state.currentRule ?? state.goal;
    for (const token of extractReferenceTokens(match.value)) {
      addReference(state.ctx, {
        fromNodeId: targetNode.id,
        rawName: token,
        kind: 'references',
        line: lineNumber,
        column: match.start,
      });
    }
  }
}

function extractFunctionLikeNames(line: string): QuotedValue[] {
  const names: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    if (!isIdentifierStartChar(line[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor++;
    while (cursor < line.length && isIdentifierBodyChar(line[cursor])) cursor++;
    const name = line.slice(start, cursor);
    const next = skipWhitespace(line, cursor);
    if (line[next] === '(') names.push({ value: name, start, raw: name });
  }
  return names;
}

function commandBracePayload(line: string, commandName: string): string | null {
  const command = commandWord(line);
  if (command?.command !== commandName) return null;
  const open = line.indexOf('{', command.end);
  if (open < 0) return null;
  const close = line.lastIndexOf('}');
  if (close <= open) return null;
  return line.slice(open + 1, close);
}

function extractOsirisAlias(state: OsirisState, line: string, lineNumber: number): boolean {
  const payload = commandBracePayload(line, 'alias_type');
  if (!payload) return false;
  const name = payload.split(',')[0]?.trim() ?? '';
  if (!name) return false;
  createNode(state.ctx, {
    kind: 'type_alias',
    name,
    qualifiedName: name,
    signature: line,
    startLine: lineNumber,
    startColumn: line.indexOf(name),
    containerId: state.goal.id,
  });
  return true;
}

function extractOsirisEnum(state: OsirisState, line: string, lineNumber: number): boolean {
  const payload = commandBracePayload(line, 'enum_type');
  if (!payload) return false;
  const parts = payload.split(',').map((part) => part.trim());
  const name = parts[0] ?? '';
  if (!name) return false;
  const enumNode = createNode(state.ctx, {
    kind: 'enum',
    name,
    qualifiedName: name,
    signature: line,
    startLine: lineNumber,
    startColumn: line.indexOf(name),
    containerId: state.goal.id,
  });
  for (const member of parts.slice(3)) {
    const memberName = memberNameFromEnumPart(member);
    if (!memberName) continue;
    createNode(state.ctx, {
      kind: 'enum_member',
      name: memberName,
      qualifiedName: `${name}.${memberName}`,
      signature: member,
      startLine: lineNumber,
      startColumn: line.indexOf(memberName),
      containerId: enumNode.id,
    });
  }
  return true;
}

function memberNameFromEnumPart(member: string): string | null {
  const eq = member.indexOf('=');
  const name = (eq < 0 ? member : member.slice(0, eq)).trim();
  return isQualifiedIdentifier(name, '_') ? name : null;
}

function osirisApiCommand(line: string): { command: string; end: number } | null {
  const command = commandWord(line);
  if (!command) return null;
  if (!OSIRIS_API_DECLARATIONS.has(command.command)) return null;
  return command;
}

function osirisApiName(line: string, start: number): { word: string; end: number } | null {
  const name = readWord(line, start);
  if (!name) return null;
  if (!isQualifiedIdentifier(name.word, '_')) return null;
  return name;
}

function parseOsirisApiDeclaration(line: string): OsirisApiDeclaration | null {
  const command = osirisApiCommand(line);
  if (!command) return null;
  const name = osirisApiName(line, command.end);
  if (!name) return null;
  return {
    kind: command.command,
    name: name.word,
    rest: line.slice(name.end).trim(),
  };
}

function osirisApiSignature(declaration: OsirisApiDeclaration): string {
  if (!declaration.rest) return `${declaration.kind} ${declaration.name}`;
  return `${declaration.kind} ${declaration.name} ${declaration.rest}`;
}

function extractOsirisApiDeclaration(state: OsirisState, line: string, lineNumber: number): boolean {
  const declaration = parseOsirisApiDeclaration(line);
  if (!declaration) return false;
  createNode(state.ctx, {
    kind: 'function',
    name: declaration.name,
    qualifiedName: declaration.name,
    signature: osirisApiSignature(declaration),
    startLine: lineNumber,
    startColumn: line.indexOf(declaration.name),
    containerId: state.goal.id,
  });
  return true;
}

function extractOsirisDeclaration(state: OsirisState, line: string, lineNumber: number): boolean {
  if (extractOsirisAlias(state, line, lineNumber)) return true;
  if (extractOsirisEnum(state, line, lineNumber)) return true;
  return extractOsirisApiDeclaration(state, line, lineNumber);
}

function extractOsirisLine(state: OsirisState, rawLine: string, lineNumber: number): void {
  const line = stripLineComment(rawLine, '//').trim();
  if (!line) return;
  if (handleOsirisSection(state, line, lineNumber)) return;
  if (handleOsirisRuleControl(state, line, lineNumber)) return;
  if (extractOsirisDeclaration(state, line, lineNumber)) return;
  extractOsirisPredicates(state, line, lineNumber);
  extractOsirisStringRefs(state, line, lineNumber);
}

function extractOsiris(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const state = createOsirisState(filePath, source);
  const lines = source.split('\n');
  for (const [idx, rawLine] of lines.entries()) {
    extractOsirisLine(state, rawLine, idx + 1);
  }
  return finish(state.ctx, startTime);
}

export const BG3_ANUBIS_DEF: LanguageDef = {
  name: 'bg3_anubis',
  displayName: 'BG3 Anubis',
  extensions: ['.ann', '.anc'],
  includeGlobs: ['**/Scripts/anubis/node/*.ann', '**/Scripts/anubis/config/*.anc', '**/*.ann', '**/*.anc'],
  customExtractor: extractAnubis,
};

export const BG3_RESOURCE_DEF: LanguageDef = {
  name: 'bg3_resource',
  displayName: 'BG3 Resource Data',
  extensions: ['.lsx', '.lsf', '.lsfx', '.lsefx', '.tbl', '.stats', '.mei', '.lsj'],
  includeGlobs: [
    '**/*.lsx',
    '**/*.lsf',
    '**/*.lsfx',
    '**/*.lsefx',
    '**/*.tbl',
    '**/*.stats',
    '**/*.mei',
    '**/*.lsj',
    '**/Localization/**/*.xml',
  ],
  customExtractor: extractBg3Resource,
};

export const BG3_STATS_DEF: LanguageDef = {
  name: 'bg3_stats',
  displayName: 'BG3 Stats DSL',
  extensions: [],
  includeGlobs: ['**/Stats/Generated/**/*.txt', '**/Stats/Generated/*.txt'],
  customExtractor: extractBg3Stats,
};

export const KHN_DEF: LanguageDef = {
  name: 'khn',
  displayName: 'BG3 KHN / Thoth Lua',
  extensions: ['.khn'],
  includeGlobs: ['**/*.khn'],
  grammar: { wasmFile: 'lua.wasm', extractor: luaExtractor },
};

export const OSIRIS_DEF: LanguageDef = {
  name: 'osiris',
  displayName: 'Osiris Story',
  extensions: ['.div'],
  includeGlobs: ['**/*.div', '**/Story/RawFiles/Goals/*.txt'],
  customExtractor: extractOsiris,
};
