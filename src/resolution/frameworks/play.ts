/**
 * Play Framework resolver.
 *
 * Play routes live in `conf/routes` and `conf/*.routes`, usually with
 * Scala or Java controllers as handlers:
 *
 *   GET  /users/:id  controllers.Users.show(id: Long)
 */

import type { UnresolvedReference } from '../../extraction/types.js';
import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { isPlayRoutesFile } from '../../extraction/grammars.js';

const HANDLER_REF = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const PLAY_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const METHOD_KINDS = new Set<Node['kind']>(['method', 'function']);

export const playResolver: FrameworkResolver = {
  name: 'play',
  languages: ['scala', 'java', 'yaml'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('conf/routes')) return true;
    const buildSbt = context.readFile('build.sbt');
    if (buildSbt && /\b(playframework|PlayScala|PlayJava|sbt-plugin)\b|["']play["']/i.test(buildSbt)) return true;
    const packageJson = context.readFile('package.json');
    if (packageJson?.includes('playframework')) return true;
    return false;
  },

  claimsReference(name: string): boolean {
    return HANDLER_REF.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const match = HANDLER_REF.exec(ref.referenceName);
    if (!match) return null;
    const [, className, methodName] = match;
    const classNode = context.getNodesByName(className!).find((node) => node.kind === 'class');
    if (!classNode) return null;

    const methodNode = context
      .getNodesInFile(classNode.filePath)
      .find((node) => METHOD_KINDS.has(node.kind) && node.name === methodName);
    if (!methodNode) return null;

    return { original: ref, targetNodeId: methodNode.id, confidence: 0.9, resolvedBy: 'framework' };
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedReference[] } {
    if (!isPlayRoutesFile(filePath)) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedReference[] = [];
    const now = Date.now();
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('->')) continue;

      const route = parsePlayRouteLine(line);
      if (!route) continue;

      const { method, routePath, handler } = route;
      const handlerRef = playHandlerReference(handler);
      if (!handlerRef) continue;

      const lineNumber = i + 1;
      const routeNode: Node = {
        id: `route:${filePath}:${lineNumber}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::${method}:${routePath}`,
        filePath,
        startLine: lineNumber,
        endLine: lineNumber,
        startColumn: raw.search(/\S/),
        endColumn: raw.length,
        language: 'yaml',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerRef,
        referenceKind: 'references',
        line: lineNumber,
        column: raw.indexOf(handler),
      });
    }

    return { nodes, references };
  },
};

function parsePlayRouteLine(line: string): { method: string; routePath: string; handler: string } | null {
  const methodToken = readToken(line, 0);
  if (!methodToken || !PLAY_HTTP_METHODS.has(methodToken.value)) return null;
  const routeToken = readToken(line, methodToken.end);
  if (!routeToken) return null;
  const handler = line.slice(routeToken.end).trim();
  return handler ? { method: methodToken.value, routePath: routeToken.value, handler } : null;
}

function readToken(line: string, start: number): { value: string; end: number } | null {
  let pos = start;
  while (pos < line.length && isPlayRouteWhitespace(line[pos]!)) pos++;
  const tokenStart = pos;
  while (pos < line.length && !isPlayRouteWhitespace(line[pos]!)) pos++;
  return pos > tokenStart ? { value: line.slice(tokenStart, pos), end: pos } : null;
}

function isPlayRouteWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function playHandlerReference(handler: string): string | null {
  const beforeArgs = handler.split('(')[0]?.trim();
  if (!beforeArgs) return null;
  const parts = beforeArgs.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}
