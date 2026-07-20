import * as path from 'node:path';
import type { ExtractionResult, UnresolvedReference } from '../../types.js';
import type { Edge, EdgeKind, Node, NodeKind } from '../../../types.js';
import { createIdFactory, generateNodeId, type NodeIdFactory } from '../../tree-sitter-helpers.js';

export type Bg3Language = 'bg3_anubis' | 'bg3_resource' | 'bg3_stats' | 'osiris';

export interface SourcePosition {
  line: number;
  column: number;
}

export interface PendingRef {
  name: string;
  kind: EdgeKind;
  line: number;
  column: number;
}

export interface ReferenceArgs {
  fromNodeId: string;
  rawName: string;
  kind: EdgeKind;
  line: number;
  column: number;
}

export interface Bg3Context {
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

export interface Bg3Field {
  name: string;
  value: string;
  type?: string;
  handle?: string;
  line: number;
  column: number;
}

export interface QuotedValue {
  value: string;
  start: number;
  raw: string;
}

export const UUID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
export const ZERO_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/i;
export const GUIDSTRING_RE =
  /\b[A-Za-z_]\w*_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
export const HANDLE_RE = /\b[Hh][0-9A-Fa-fGg]{12,}\b/g;

export const NON_SYMBOL_NODE_IDS = new Set(['root', 'children', 'Tags', 'SubClasses', 'SubClass', 'Object']);
export const GENERIC_XML_RESOURCE_TAGS = new Set([
  'Settings',
  'effect',
  'component',
  'MultiEffectInfos',
  'EffectInfo',
  'trackgroup',
  'track',
]);
export const NAME_FIELD_ORDER = ['NameFS', 'Name', 'Folder', 'RuleName', 'SelectorId', 'UUID'];
export const DEFINING_FIELD_NAMES = new Set([
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
export const REFERENCE_FIELD_MARKERS = [
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
export const REFERENCE_TYPE_MARKERS = ['guidobject', 'statreference', 'baseclass', 'translatedstring'];
export const EXTENDS_FIELD_NAMES = new Set(['using', 'parent', 'parentguid']);
export const QUOTE_CHARS = new Set(['"', "'"]);
export const ASCII_UPPER_A = 'A'.codePointAt(0) ?? 0;
export const ASCII_UPPER_Z = 'Z'.codePointAt(0) ?? 0;
export const ASCII_LOWER_A = 'a'.codePointAt(0) ?? 0;
export const ASCII_LOWER_Z = 'z'.codePointAt(0) ?? 0;
export const ASCII_DIGIT_0 = '0'.codePointAt(0) ?? 0;
export const ASCII_DIGIT_9 = '9'.codePointAt(0) ?? 0;
export const CONTENT_CLOSE_PREFIX_LENGTH = '</content'.length;
export const LOCALIZATION_SNIPPET_LENGTH = 120;
export const VALUE_STOPWORDS = new Set([
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

export function createLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.codePointAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function positionAt(ctx: Bg3Context, index: number): SourcePosition {
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

export function createContext(filePath: string, source: string, language: Bg3Language): Bg3Context {
  const nodes: Node[] = [];
  const lines = source.split('\n');
  const fileNode: Node = {
    id: generateNodeId({ filePath, kind: 'file', name: filePath, ordinal: 0 }),
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language,
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

export function finish(ctx: Bg3Context, startTime: number): ExtractionResult {
  return {
    nodes: ctx.nodes,
    edges: ctx.edges,
    unresolvedReferences: ctx.unresolvedReferences,
    errors: ctx.errors,
    durationMs: Date.now() - startTime,
  };
}

export function createNode(
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
    language: ctx.language,
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

export function addReference(ctx: Bg3Context, ref: ReferenceArgs): void {
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
    language: ctx.language,
  });
}

export function isWhitespaceChar(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\uFEFF';
}

export function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) || (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z);
}

export function isDigitChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= ASCII_DIGIT_0 && code <= ASCII_DIGIT_9;
}

export function isIdentifierStartChar(ch: string | undefined): boolean {
  return isAsciiLetter(ch) || ch === '_';
}

export function isIdentifierBodyChar(ch: string | undefined, extra = ''): boolean {
  return isIdentifierStartChar(ch) || isDigitChar(ch) || (!!ch && extra.includes(ch));
}

export function isQualifiedIdentifier(value: string, extra = ':.'): boolean {
  if (!isIdentifierStartChar(value[0])) return false;
  for (let i = 1; i < value.length; i++) {
    if (!isIdentifierBodyChar(value[i], extra)) return false;
  }
  return true;
}

export function hasMatchingQuotePair(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  if (!first) return false;
  if (!QUOTE_CHARS.has(first)) return false;
  return first === value.at(-1);
}

export function trimMatchingQuotes(value: string): string {
  if (!hasMatchingQuotePair(value)) return value;
  return value.slice(1, -1);
}

export function normalizeReferenceName(rawName: string): string | null {
  const name = trimMatchingQuotes(decodeXmlEntities(rawName).trim());
  if (!name || name.length < 2) return null;
  if (ZERO_UUID_RE.test(name)) return null;
  if (VALUE_STOPWORDS.has(name)) return null;
  if (isBg3ResourceIdentifier(name)) return name;
  if (!isQualifiedIdentifier(name)) return null;
  return name;
}

export function resetBg3ResourceRegexes(): void {
  GUIDSTRING_RE.lastIndex = 0;
  UUID_RE.lastIndex = 0;
  HANDLE_RE.lastIndex = 0;
}

export function isBg3ResourceIdentifier(value: string): boolean {
  resetBg3ResourceRegexes();
  const matched = GUIDSTRING_RE.test(value) || UUID_RE.test(value) || HANDLE_RE.test(value);
  resetBg3ResourceRegexes();
  return matched;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function includesAnyMarker(value: string, markers: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

export function isReferenceFieldName(name: string): boolean {
  return includesAnyMarker(name, REFERENCE_FIELD_MARKERS);
}

export function shouldScanField(field: Bg3Field): boolean {
  if (!field.value && !field.handle) return false;
  if (field.handle) return true;
  if (isBg3ResourceIdentifier(field.value)) return true;
  if (field.type && includesAnyMarker(field.type, REFERENCE_TYPE_MARKERS)) return true;
  if (isReferenceFieldName(field.name)) return true;
  return (
    field.value.includes('(') || field.value.includes(')') || field.value.includes('|') || field.value.includes(';')
  );
}

export function referenceKindForField(field: Bg3Field): EdgeKind {
  return EXTENDS_FIELD_NAMES.has(field.name.toLowerCase()) ? 'extends' : 'references';
}

export function pendingRefsForField(field: Bg3Field): PendingRef[] {
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

export function extractReferenceTokens(value: string): string[] {
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

export function extractIdentifierTokens(value: string, extra = ''): QuotedValue[] {
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

export function isShortLowercaseWord(value: string): boolean {
  return (
    value.length < 8 &&
    [...value].every((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z;
    })
  );
}

export function skipWhitespace(value: string, cursor: number): number {
  while (isWhitespaceChar(value[cursor])) cursor++;
  return cursor;
}

export function readWord(value: string, cursor: number): { word: string; start: number; end: number } | null {
  cursor = skipWhitespace(value, cursor);
  const start = cursor;
  while (cursor < value.length && isIdentifierBodyChar(value[cursor])) cursor++;
  if (cursor === start) return null;
  return { word: value.slice(start, cursor), start, end: cursor };
}

export function extractQuotedValues(line: string): QuotedValue[] {
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

export function commandWord(line: string): { command: string; end: number } | null {
  const word = readWord(line, 0);
  return word ? { command: word.word.toLowerCase(), end: word.end } : null;
}

export function stripLineComment(line: string, marker: string): string {
  const index = line.indexOf(marker);
  return index < 0 ? line : line.slice(0, index);
}

export function startsWithWordIgnoreCase(line: string, word: string): boolean {
  const first = readWord(line, 0);
  return first?.word.toLowerCase() === word.toLowerCase();
}
