/**
 * JSONC-preserving MCP config writer.
 *
 * CodeBuddy and Pi document JSONC-style MCP files with comments and trailing
 * commas. The plain JSON writer intentionally reserializes the whole file; this
 * writer instead patches only `mcpServers.cartograph` so comments, ordering, and
 * unrelated formatting survive. If a pre-existing file is too malformed to patch
 * safely, the writer returns `kept` rather than clobbering user config.
 */

import * as fs from 'node:fs';
import type { DetectionResult, Location, WriteResult } from './types.js';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  mcpCommandOptionsForLocation,
  type McpCommandOptions,
} from './shared.js';

export interface WriteMcpEntryJsoncArgs {
  resolvePath: (loc: Location) => string;
  entry?: (options?: McpCommandOptions) => Record<string, unknown>;
  command?: string | undefined;
}

interface ObjectRange {
  open: number;
  close: number;
}

interface PropertyRange {
  keyStart: number;
  keyEnd: number;
  colon: number;
  valueStart: number;
  valueEnd: number;
  trailingComma: number | null;
  previousComma: number | null;
}

interface ReadObjectPropertyArgs {
  text: string;
  keyStart: number;
  objectClose: number;
  previousComma: number | null;
}

function targetEntry(loc: Location, args: WriteMcpEntryJsoncArgs): Record<string, unknown> {
  const options = mcpCommandOptionsForLocation(loc, { command: args.command });
  return args.entry?.(options) ?? getMcpServerConfig(options);
}

export function detectMcpEntryJsonc(loc: Location, args: WriteMcpEntryJsoncArgs, installed: boolean): DetectionResult {
  const file = args.resolvePath(loc);
  const config = parseJsoncFile(file);
  return { installed, alreadyConfigured: !!config?.['mcpServers']?.cartograph, configPath: file };
}

export function writeMcpEntryJsonc(loc: Location, args: WriteMcpEntryJsoncArgs): WriteResult['files'][number] {
  const file = args.resolvePath(loc);
  const existed = fs.existsSync(file);
  const after = targetEntry(loc, args);

  if (!existed) {
    writeJsoncFile(file, `${formatRootWithMcpServers(after)}\n`);
    return { path: file, action: 'created' };
  }

  const text = fs.readFileSync(file, 'utf-8');
  if (!text.trim()) {
    writeJsoncFile(file, `${formatRootWithMcpServers(after)}\n`);
    return { path: file, action: 'updated' };
  }

  const parsed = parseJsoncText(text);
  if (!parsed) return { path: file, action: 'kept' };
  if (jsonDeepEqual(parsed['mcpServers']?.cartograph, after)) {
    return { path: file, action: 'unchanged' };
  }

  const next = upsertMcpServerEntry(text, after);
  if (!next) return { path: file, action: 'kept' };
  writeJsoncFile(file, next);
  return { path: file, action: 'updated' };
}

export function removeMcpEntryJsonc(loc: Location, args: WriteMcpEntryJsoncArgs): WriteResult['files'][number] {
  const file = args.resolvePath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const text = fs.readFileSync(file, 'utf-8');
  const parsed = parseJsoncText(text);
  if (!parsed) return { path: file, action: 'kept' };
  if (!parsed['mcpServers']?.cartograph) return { path: file, action: 'not-found' };

  const next = removeMcpServerEntry(text);
  if (!next) return { path: file, action: 'kept' };
  writeJsoncFile(file, next);
  return { path: file, action: 'removed' };
}

function writeJsoncFile(filePath: string, content: string): void {
  atomicWriteFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
}

function parseJsoncFile(filePath: string): Record<string, any> | null {
  if (!fs.existsSync(filePath)) return {};
  return parseJsoncText(fs.readFileSync(filePath, 'utf-8'));
}

function parseJsoncText(text: string): Record<string, any> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(removeTrailingCommas(stripJsoncComments(text)));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

function stripJsoncComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const span = readPreservedJsoncSpan(text, i);
    if (span) {
      out += span.text;
      i = span.end;
      continue;
    }
    out += text[i]!;
    i++;
  }
  return out;
}

function readPreservedJsoncSpan(text: string, start: number): { text: string; end: number } | null {
  if (text[start] === '"') {
    const end = stringEnd(text, start);
    return { text: text.slice(start, end), end };
  }
  if (text[start] === '/' && text[start + 1] === '/') return maskLineComment(text, start);
  if (text[start] === '/' && text[start + 1] === '*') return maskBlockComment(text, start);
  return null;
}

function maskLineComment(text: string, start: number): { text: string; end: number } {
  let i = start + 2;
  let masked = '  ';
  while (i < text.length && text[i] !== '\n') {
    masked += ' ';
    i++;
  }
  return { text: masked, end: i };
}

function maskBlockComment(text: string, start: number): { text: string; end: number } {
  let i = start + 2;
  let masked = '  ';
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '/') return { text: `${masked}  `, end: i + 2 };
    masked += text[i] === '\n' ? '\n' : ' ';
    i++;
  }
  return { text: masked, end: i };
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function upsertMcpServerEntry(text: string, entry: Record<string, unknown>): string | null {
  const root = findRootObject(text);
  if (!root) return null;

  const mcpServers = findObjectProperty(text, root, 'mcpServers');
  if (!mcpServers) {
    return insertPropertyIntoObject(text, root, formatProperty('mcpServers', { cartograph: entry }, '  '));
  }

  const serversObject = valueObjectRange(text, mcpServers);
  if (!serversObject) return null;

  const cartograph = findObjectProperty(text, serversObject, 'cartograph');
  if (!cartograph) {
    return insertPropertyIntoObject(text, serversObject, formatProperty('cartograph', entry, '    '));
  }

  const replacement = formatJsonValue(entry, '    ');
  return text.slice(0, cartograph.valueStart) + replacement + text.slice(cartograph.valueEnd);
}

function removeMcpServerEntry(text: string): string | null {
  const root = findRootObject(text);
  if (!root) return null;
  const mcpServers = findObjectProperty(text, root, 'mcpServers');
  if (!mcpServers) return text;
  const serversObject = valueObjectRange(text, mcpServers);
  if (!serversObject) return null;
  const cartograph = findObjectProperty(text, serversObject, 'cartograph');
  if (!cartograph) return text;
  return removeProperty(text, cartograph);
}

function formatRootWithMcpServers(entry: Record<string, unknown>): string {
  return `{\n${formatProperty('mcpServers', { cartograph: entry }, '  ')}\n}`;
}

function formatProperty(key: string, value: unknown, indent: string): string {
  return `${indent}${JSON.stringify(key)}: ${formatJsonValue(value, indent)}`;
}

function formatJsonValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : indent + line))
    .join('\n');
}

function insertPropertyIntoObject(text: string, object: ObjectRange, property: string): string | null {
  const previous = previousSignificantIndex(text, object.close - 1);
  if (previous === null || previous < object.open) return null;
  if (text[previous] === '{') {
    return text.slice(0, object.close) + `\n${property}` + text.slice(object.close);
  }
  if (text[previous] === ',') {
    return text.slice(0, object.close) + `\n${property}` + text.slice(object.close);
  }
  return (
    text.slice(0, previous + 1) +
    ',' +
    text.slice(previous + 1, object.close) +
    `\n${property}` +
    text.slice(object.close)
  );
}

function removeProperty(text: string, property: PropertyRange): string {
  if (property.trailingComma !== null) {
    return text.slice(0, property.keyStart) + text.slice(property.trailingComma + 1);
  }
  if (property.previousComma !== null) {
    return text.slice(0, property.previousComma) + text.slice(property.valueEnd);
  }
  return text.slice(0, property.keyStart) + text.slice(property.valueEnd);
}

function findRootObject(text: string): ObjectRange | null {
  const start = skipTrivia(text, 0);
  if (text[start] !== '{') return null;
  const close = findMatching(text, start);
  if (close === null) return null;
  if (skipTrivia(text, close + 1) !== text.length) return null;
  return { open: start, close };
}

function valueObjectRange(text: string, property: PropertyRange): ObjectRange | null {
  const open = skipTrivia(text, property.valueStart);
  if (text[open] !== '{') return null;
  const close = findMatching(text, open);
  if (close === null || close > property.valueEnd) return null;
  return { open, close };
}

function findObjectProperty(text: string, object: ObjectRange, key: string): PropertyRange | null {
  let i = object.open + 1;
  let previousComma: number | null = null;

  while (i < object.close) {
    i = skipTrivia(text, i);
    if (i >= object.close) return null;
    if (text[i] === ',') {
      previousComma = i;
      i++;
      continue;
    }

    const property = readObjectProperty({ text, keyStart: i, objectClose: object.close, previousComma });
    if (!property) return null;
    if (property.parsedKey === key) return property.range;

    i = property.range.trailingComma === null ? property.afterValue : property.range.trailingComma + 1;
  }

  return null;
}

function readObjectProperty(args: ReadObjectPropertyArgs): {
  parsedKey: string;
  range: PropertyRange;
  afterValue: number;
} | null {
  const parsed = readObjectKey(args.text, args.keyStart);
  if (!parsed) return null;
  const colon = skipTrivia(args.text, parsed.keyEnd);
  if (args.text[colon] !== ':') return null;
  const valueStart = skipTrivia(args.text, colon + 1);
  const valueEnd = skipJsonValue(args.text, valueStart, args.objectClose);
  if (valueEnd === null) return null;
  const afterValue = skipTrivia(args.text, valueEnd);
  const trailingComma = args.text[afterValue] === ',' ? afterValue : null;
  return {
    parsedKey: parsed.key,
    range: {
      keyStart: args.keyStart,
      keyEnd: parsed.keyEnd,
      colon,
      valueStart,
      valueEnd,
      trailingComma,
      previousComma: args.previousComma,
    },
    afterValue,
  };
}

function readObjectKey(text: string, keyStart: number): { key: string; keyEnd: number } | null {
  if (text[keyStart] !== '"') return null;
  const keyEnd = stringEnd(text, keyStart);
  try {
    return { key: JSON.parse(text.slice(keyStart, keyEnd)) as string, keyEnd };
  } catch {
    return null;
  }
}

function previousSignificantIndex(text: string, start: number): number | null {
  const withoutComments = stripJsoncComments(text);
  let i = start;
  while (i >= 0 && /\s/.test(withoutComments[i]!)) i--;
  return i >= 0 ? i : null;
}

function skipJsonValue(text: string, start: number, limit: number): number | null {
  if (start >= limit) return null;
  const ch = text[start]!;
  if (ch === '"') return stringEnd(text, start);
  if (ch === '{') {
    const end = findMatching(text, start);
    return end === null ? null : end + 1;
  }
  if (ch === '[') {
    const end = findMatching(text, start);
    return end === null ? null : end + 1;
  }

  let i = start;
  while (i < limit && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
  return i > start ? i : null;
}

function skipTrivia(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    const next = skipComment(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    return i;
  }
  return i;
}

function findMatching(text: string, openIndex: number): number | null {
  const openChar = text[openIndex];
  const closeChar = matchingClose(openChar);
  if (!closeChar) return null;

  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const next = skipStringOrComment(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const ch = text[i]!;
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

function matchingClose(openChar: string | undefined): string | null {
  if (openChar === '{') return '}';
  if (openChar === '[') return ']';
  return null;
}

function skipStringOrComment(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  return skipComment(text, start);
}

function skipComment(text: string, start: number): number {
  if (text[start] === '/' && text[start + 1] === '/') return skipLineComment(text, start + 2);
  if (text[start] === '/' && text[start + 1] === '*') return skipBlockComment(text, start + 2);
  return start;
}

function skipLineComment(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function skipBlockComment(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '/') return i + 2;
    i++;
  }
  return text.length;
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return text.length;
}
