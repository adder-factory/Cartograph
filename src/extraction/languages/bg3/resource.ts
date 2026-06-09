import * as path from 'node:path';
import type { ExtractionResult } from '../../types.js';
import type { Node } from '../../../types.js';
import {
  CONTENT_CLOSE_PREFIX_LENGTH,
  DEFINING_FIELD_NAMES,
  GENERIC_XML_RESOURCE_TAGS,
  LOCALIZATION_SNIPPET_LENGTH,
  NAME_FIELD_ORDER,
  NON_SYMBOL_NODE_IDS,
  QUOTE_CHARS,
  ZERO_UUID_RE,
  addReference,
  createContext,
  createNode,
  decodeXmlEntities,
  extractReferenceTokens,
  finish,
  isBg3ResourceIdentifier,
  isDigitChar,
  isReferenceFieldName,
  isWhitespaceChar,
  normalizeReferenceName,
  pendingRefsForField,
  positionAt,
  skipWhitespace,
  type Bg3Context,
  type Bg3Field,
  type PendingRef,
  type SourcePosition,
} from './shared.js';

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

export function extractBg3Resource(filePath: string, source: string): ExtractionResult {
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
