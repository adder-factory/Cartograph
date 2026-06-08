/**
 * Flutter framework resolver.
 *
 * Extracts static route declarations from `MaterialApp(routes: {...})` and
 * `GoRoute(path: ..., builder: ...)` patterns. It emits route nodes plus
 * references to widget classes used by the route builder.
 */

import type { Language, Node } from '../../types.js';
import type { UnresolvedReference } from '../../extraction/types.js';
import { makeLineIndex, stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';

const FLUTTER_LANGUAGES = ['dart'] as const;

export const flutterResolver: FrameworkResolver = {
  name: 'flutter',
  languages: FLUTTER_LANGUAGES,
  anchors: ['MaterialApp', 'GoRoute', 'routes:', 'Navigator.pushNamed', 'flutter:'],

  detect(context: ResolutionContext): boolean {
    const pubspec = context.readFile('pubspec.yaml');
    if (pubspec && hasFlutterPubspecEntry(pubspec)) return true;
    return context.getAllFiles().some((file) => {
      if (!file.endsWith('.dart')) return false;
      const content = context.readFile(file);
      return Boolean(content?.includes('package:flutter/'));
    });
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },

  extract(filePath: string, content: string) {
    const safe = stripCommentsForRegex(content, 'dart');
    if (!hasFlutterRouteSignal(safe)) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedReference[] = [];
    collectMaterialRoutes({ filePath, content: safe, nodes, references });
    collectGoRoutes({ filePath, content: safe, nodes, references });
    return { nodes, references: dedupeReferences(references) };
  },
};

interface CollectArgs {
  filePath: string;
  content: string;
  nodes: Node[];
  references: UnresolvedReference[];
}

function hasFlutterRouteSignal(content: string): boolean {
  return content.includes('MaterialApp') || content.includes('GoRoute') || content.includes('Navigator.pushNamed');
}

function hasFlutterPubspecEntry(pubspec: string): boolean {
  return pubspec.split('\n').some((line) => line.trimStart().startsWith('flutter:'));
}

function collectMaterialRoutes(args: CollectArgs): void {
  for (const route of readMaterialRouteEntries(args.content)) {
    const routePath = normalizeFlutterRoutePath(route.path);
    const routeNode = makeRouteNode({
      filePath: args.filePath,
      content: args.content,
      offset: route.offset,
      routePath,
      signature: `Flutter route ${routePath}`,
    });
    args.nodes.push(routeNode);
    if (route.widget) args.references.push(makeReference(routeNode, route.widget));
  }
}

function collectGoRoutes(args: CollectArgs): void {
  for (const route of readGoRouteEntries(args.content)) {
    const routePath = normalizeFlutterRoutePath(route.path);
    const routeNode = makeRouteNode({
      filePath: args.filePath,
      content: args.content,
      offset: route.offset,
      routePath,
      signature: `Flutter GoRoute ${routePath}`,
    });
    args.nodes.push(routeNode);
    if (route.widget) args.references.push(makeReference(routeNode, route.widget));
  }
}

function readMaterialRouteEntries(content: string): Array<{ path: string; widget: string | null; offset: number }> {
  const routesIndex = content.indexOf('routes:');
  if (routesIndex === -1) return [];
  const open = content.indexOf('{', routesIndex);
  if (open === -1) return [];
  const close = findMatching(content, open);
  if (close === null) return [];

  const routes: Array<{ path: string; widget: string | null; offset: number }> = [];
  const body = content.slice(open + 1, close);
  for (const entry of splitTopLevel(body)) {
    const route = readMaterialRouteEntry(entry.text);
    if (route) routes.push({ ...route, offset: open + 1 + entry.offset });
  }
  return routes;
}

function readMaterialRouteEntry(entry: string): { path: string; widget: string | null } | null {
  const start = skipWhitespace(entry, 0);
  const path = readQuoted(entry, start);
  if (!path) return null;
  const colon = entry.indexOf(':', path.end);
  if (colon === -1) return null;
  return { path: path.value, widget: readWidgetAfterArrow(entry.slice(colon + 1)) };
}

function readGoRouteEntries(content: string): Array<{ path: string; widget: string | null; offset: number }> {
  const routes: Array<{ path: string; widget: string | null; offset: number }> = [];
  let index = 0;
  while ((index = content.indexOf('GoRoute', index)) !== -1) {
    const open = content.indexOf('(', index);
    if (open === -1) break;
    const close = findMatching(content, open);
    if (close === null) {
      index += 'GoRoute'.length;
      continue;
    }
    const call = content.slice(open + 1, close);
    const path = readNamedStringArg(call, 'path');
    if (path) routes.push({ path: path.value, widget: readBuilderWidget(call), offset: index });
    index = close + 1;
  }
  return routes;
}

function readNamedStringArg(content: string, name: string): { value: string; end: number } | null {
  const key = `${name}:`;
  const index = content.indexOf(key);
  if (index === -1) return null;
  return readQuoted(content, skipWhitespace(content, index + key.length));
}

function readBuilderWidget(content: string): string | null {
  const builder = content.indexOf('builder:');
  if (builder === -1) return null;
  return readWidgetAfterArrow(content.slice(builder + 'builder:'.length));
}

function readWidgetAfterArrow(content: string): string | null {
  const arrow = content.indexOf('=>');
  if (arrow === -1) return null;
  let i = skipWhitespace(content, arrow + 2);
  if (content.startsWith('const ', i)) i = skipWhitespace(content, i + 'const'.length);
  return readIdentifier(content, i);
}

function normalizeFlutterRoutePath(rawPath: string): string {
  if (!rawPath) return '/';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function makeRouteNode(args: {
  filePath: string;
  content: string;
  offset: number;
  routePath: string;
  signature: string;
}): Node {
  const lineOf = makeLineIndex(args.content);
  const line = lineOf(args.offset);
  const column = Math.max(0, args.offset - (args.content.lastIndexOf('\n', args.offset - 1) + 1));
  return {
    id: `flutter:route:${args.filePath}:${line}:${args.routePath}`,
    kind: 'route',
    name: args.routePath,
    qualifiedName: `${args.filePath}#${args.routePath}`,
    filePath: args.filePath,
    language: 'dart' satisfies Language,
    startLine: line,
    endLine: line,
    startColumn: column,
    endColumn: column + args.routePath.length,
    signature: args.signature,
    updatedAt: Date.now(),
  };
}

function makeReference(node: Node, name: string): UnresolvedReference {
  return {
    fromNodeId: node.id,
    referenceName: name,
    referenceKind: 'references',
    line: node.startLine,
    column: node.startColumn,
    filePath: node.filePath,
    language: node.language,
  };
}

function dedupeReferences(refs: UnresolvedReference[]): UnresolvedReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.fromNodeId}:${ref.referenceName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitTopLevel(body: string): Array<{ text: string; offset: number }> {
  const entries: Array<{ text: string; offset: number }> = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const skipped = skipString(body, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      entries.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
    i++;
  }
  entries.push({ text: body.slice(start), offset: start });
  return entries;
}

function findMatching(content: string, openIndex: number): number | null {
  const close = matchingClose(content[openIndex]);
  if (!close) return null;
  let depth = 0;
  let i = openIndex;
  while (i < content.length) {
    const skipped = skipString(content, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = content[i];
    if (ch === content[openIndex]) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

function matchingClose(open: string | undefined): string | null {
  if (open === '{') return '}';
  if (open === '[') return ']';
  if (open === '(') return ')';
  return null;
}

function readQuoted(content: string, start: number): { value: string; end: number } | null {
  const quote = content[start];
  if (quote !== '"' && quote !== "'") return null;
  let i = start + 1;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === quote) return { value: content.slice(start + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

function readIdentifier(content: string, start: number): string | null {
  const first = content[start];
  if (!first || !/[A-Za-z_$]/.test(first)) return null;
  let i = start + 1;
  while (i < content.length && /[\w$]/.test(content[i]!)) i++;
  return content.slice(start, i);
}

function skipWhitespace(content: string, start: number): number {
  let i = start;
  while (i < content.length && /\s/.test(content[i]!)) i++;
  return i;
}

function skipString(content: string, index: number): number {
  const quote = content[index];
  if (quote !== '"' && quote !== "'") return index;
  let i = index + 1;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === quote) return i + 1;
    i++;
  }
  return content.length;
}
